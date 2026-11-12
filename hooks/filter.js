#!/usr/bin/env node
'use strict';
// Streaming filter for the command wrapper (hooks/wrap.sh).
// Reads the command's output on stdin, writes the redacted text to fd 3 (the
// original stdout), and writes one ack line to stdout when it reads the end
// marker: "0" when all output so far was redacted, "1" when it was withheld.
// The stream may start with a header, `\0HUSHCMD:<nonce>\0<bash -c string>\0`,
// written by wrap.sh; when the command in it matches strictCommands, the
// output is also strictly masked (hooks/strict.js).
// Usage: node filter.js <nonce> <bash|monitor>
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const { loadConfig, loadKnown, buildKnown, prefixAt, compile, redact, log, failure } = require('./hush-lib');
const { Strict, isStrict, commandOf } = require('./strict');

const OUT = Number(process.env.HUSH_FILTER_FD || 3);
const nonce = process.argv[2] || '';
const mode = process.argv[3] || 'bash';
const MARK = `\0HUSH:${nonce}\0`;
const HEAD = `\0HUSHCMD:${nonce}\0`;
// A line longer than this is cut and redacted in parts.
const CAP = Number(process.env.HUSH_FILTER_CAP || 65536);
// The tail of a cut line is kept for the next part. The cut never falls
// inside a known value or a pattern match: it moves to the start of the match.
const KEEP = 4096;
// A match that runs from the start of a long line to its end holds the line
// until it reaches this size; then the line is cut anyway, outside every other
// match, and the rest of the long match, up to the next whitespace, is
// replaced by WITHHELD.
const HARD = CAP * 16;
const WITHHELD = '[hush withheld]';
// After this much idle time, a partial line with no newline is written up
// to its last whitespace (`\r` and `\n` included). Its last word is written
// too when it is shorter than SHORT characters and may not hold a secret (see
// secretStart); else it is held until HOLD_MS after the last write, and then
// written only when it may not hold a secret. A word that may hold one, an
// open PEM block, and a run of argv lines stay held until more output, the
// end of the command, or CAP.
const IDLE_MS = Number(process.env.HUSH_FILTER_IDLE_MS || 250);
const HOLD_MS = Number(process.env.HUSH_FILTER_HOLD_MS || 3000);
const SHORT = 6;
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,64}PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]{0,64}PRIVATE KEY-----/g;

// The index of the first PEM private key header with no end line after it, or -1.
function pemOpen(text) {
  let after = 0;
  for (const m of text.matchAll(PEM_END)) after = m.index + m[0].length;
  PEM_BEGIN.lastIndex = after;
  const m = PEM_BEGIN.exec(text);
  return m ? m.index : -1;
}

// A pretty-printed JSON string array puts each element on its own line, so a
// flag and its value (`"-a",` then the value) arrive on different lines. A
// trailing run of complete lines that are array elements followed by a comma
// may continue, so it is held until a line that is not such an element ends
// the run; then the run is redacted together with that line.
const ELEMENT = /^[ \t]*"(?:[^"\\\n]|\\.)*"[ \t]*,[ \t]*\r?$/;
function holdArgv(text, end) {
  let start = end;
  while (start > 0) {
    const prev = text.lastIndexOf('\n', start - 2) + 1;
    if (!ELEMENT.test(text.slice(prev, start - 1))) break;
    start = prev;
  }
  return start;
}

function writeAll(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(fd, buf, off); } catch (e) { if (e.code !== 'EAGAIN') throw e; }
  }
}

let failed = false;
let ctx = null;
let total = 0;
const counts = {};
let pending = '';
let lastChar = '\n';
let marked = false;
let idle = null;
let hold = null;
// The current line, when a part of it was written at idle: its raw text, the
// text written for it, and the counts taken for it. The rest of the line is
// redacted together with it, and only the new part is written.
let line = '';
let lineOut = '';
let lineCounts = {};
let headed = false;
let strict = null;
// After a forced cut: the rest of the long match is dropped up to the next whitespace.
let masking = false;

const withhold = (e) => {
  if (failed) return;
  failed = true;
  pending = '';
  const msg = `${failure('output withheld: redaction failed', e)}\n`;
  try { writeAll(OUT, msg); } catch { /* nothing left to write to */ }
};

try {
  const cfg = loadConfig();
  const known = loadKnown(cfg).values;
  ctx = { cfg, known, compiled: compile(cfg), index: buildKnown(known, cfg) };
} catch (e) { withhold(e); }

const red = (text) => redact(text, ctx.cfg, ctx.known, ctx.compiled, ctx.index);

// Redacts text after the part of the current line already written, writes
// what is new. final: the end of the output, nothing more joins this line.
function emit(text, final = false) {
  if (!text || failed) return;
  const full = line + text;
  const r = red(full);
  for (const [k, n] of Object.entries(r.counts)) {
    const d = n - (lineCounts[k] || 0);
    if (d > 0) { counts[k] = (counts[k] || 0) + d; total += d; }
  }
  const rawTail = full.slice(full.lastIndexOf('\n') + 1);
  const keep = !final && rawTail.length > 0 && rawTail.length <= KEEP;
  let out = r.text;
  if (strict) {
    // A partial line is masked on a copy of the state: it is masked again
    // with the rest of its line.
    const nl = out.lastIndexOf('\n') + 1;
    out = strict.text(out.slice(0, nl)) + (keep ? strict.clone().text(out.slice(nl)) : strict.text(out.slice(nl)));
  }
  let k = 0;
  if (lineOut) {
    if (out.startsWith(lineOut)) k = lineOut.length;
    else while (k < lineOut.length && out[k] === lineOut[k]) k++;
  }
  const add = out.slice(k);
  if (add) { writeAll(OUT, add); lastChar = add[add.length - 1]; }
  line = keep ? rawTail : '';
  lineOut = keep ? out.slice(out.lastIndexOf('\n') + 1) : '';
  lineCounts = keep ? red(line).counts : {};
}

// Writes every complete line of pending, holding an open PEM block; cuts an overlong line.
function drain(all) {
  if (failed) { pending = ''; return; }
  skipMasked();
  if (all) { emit(pending, true); pending = ''; line = ''; lineOut = ''; lineCounts = {}; return; }
  // Holds are found in the current line and pending together.
  const view = line + pending;
  let end = view.lastIndexOf('\n') + 1;
  const pem = pemOpen(view.slice(0, end));
  if (pem >= 0 && pending.length < CAP) end = pem;
  else if (pending.length < CAP) end = holdArgv(view, end);
  end = Math.max(0, end - line.length);
  if (end > 0) { emit(pending.slice(0, end)); pending = pending.slice(end); }
  if (pending.length >= CAP) {
    const headEnd = pending.length - KEEP;
    let ws = headEnd - 1;
    while (ws > headEnd - 65536 && ws > 0 && !/\s/.test(pending[ws])) ws--;
    let cut = safeCut(pending, ws > 0 && /\s/.test(pending[ws]) ? ws + 1 : headEnd);
    if (cut > 0) {
      emit(pending.slice(0, cut));
      pending = pending.slice(cut);
      return;
    }
    if (pending.length < HARD) return;
    // Forced cut: outside every match that does not start the text; the
    // rest of the match that does is withheld up to the next whitespace.
    cut = backOut(spans(pending).filter(([s]) => s > 0), headEnd);
    emit(pending.slice(0, cut));
    pending = pending.slice(cut);
    writeAll(OUT, WITHHELD);
    lastChar = ']';
    line = ''; lineOut = ''; lineCounts = {};
    counts.withheld = (counts.withheld || 0) + 1;
    total++;
    masking = true;
    skipMasked();
  }
}

// Drops the rest of a withheld match: pending up to its first whitespace.
function skipMasked() {
  if (!masking) return;
  const i = pending.search(/\s/);
  if (i < 0) { pending = ''; return; }
  pending = pending.slice(i);
  masking = false;
}

// IDLE_MS after the last write: writes what may go out of a partial line.
function onIdle() {
  if (failed) return;
  skipMasked();
  if (!pending) return;
  const view = line + pending;
  let end = view.length;
  const pem = pemOpen(view);
  if (pem >= 0) end = pem;
  else {
    const nl = view.lastIndexOf('\n') + 1;
    const arg = holdArgv(view, nl);
    if (arg < nl) end = arg;
    else {
      const ws = view.search(/\s\S*$/) + 1;
      if (ws < view.length && (view.length - ws >= SHORT || secretStart(view, ws))) end = ws;
    }
  }
  end = Math.max(0, end - line.length);
  if (end > 0) { emit(pending.slice(0, end)); pending = pending.slice(end); }
  if (pending && pem < 0) hold = setTimeout(() => { try { onHold(); } catch (e) { withhold(e); } }, Math.max(0, HOLD_MS - IDLE_MS));
}

// HOLD_MS after the last write: writes everything but an open PEM block and
// a last word that may hold a secret. Those wait for more output, the end of
// the command, or CAP: no timer releases them.
function onHold() {
  if (failed || !pending) return;
  const view = line + pending;
  const pem = pemOpen(view);
  let end = pem >= 0 ? pem : view.length;
  if (pem < 0) {
    const ws = view.search(/\s\S*$/) + 1;
    if (ws < view.length && secretStart(view, ws)) end = ws;
  }
  end = Math.max(0, end - line.length);
  if (end > 0) { emit(pending.slice(0, end)); pending = pending.slice(end); }
}

// Completions tried after a partial last word: when one makes a pattern
// match that covers the word, the word may be the start of a secret.
const COMPLETIONS = ['Aa0'.repeat(30), `${'Aa0'.repeat(4)}.eyJ${'Aa0'.repeat(4)}.${'Aa0'.repeat(4)}`, `${'Aa0'.repeat(4)}@h`,
  `${'Aa0'.repeat(4)}"`, `${'A0'.repeat(10)} `, `${'a0'.repeat(20)}@h`];

// True when the last word of view, from index ws, may hold a secret that is
// not complete yet: an end of it starts a known value; it and a completion
// make a pattern match that covers it (tried on its line, after the last
// `\n` or `\r`, at most 2,048 characters back); or it is a word of 20 to
// KEEP characters with high variety (a letter, a digit, and 10 or more
// distinct characters), the likely shape of a secret, where a prompt or
// progress text is short or repetitive.
function secretStart(view, ws) {
  const word = view.slice(ws);
  if (prefixAt(word, ctx.index)) return true;
  if (word.length >= 20 && word.length <= KEEP && /\d/.test(word) && /[A-Za-z]/.test(word) && new Set(word).size >= 10) return true;
  const from = Math.max(view.lastIndexOf('\n', ws - 1), view.lastIndexOf('\r', ws - 1), ws - 2048) + 1;
  const head = view.slice(from);
  const w = ws - from;
  for (const c of COMPLETIONS) {
    const t = head + c;
    for (const { re } of ctx.compiled) for (const m of t.matchAll(re)) if (m.index < head.length && m.index + m[0].length > w) return true;
  }
  return false;
}

// [start, end) of every known value, pattern match, and (strict mode) long
// word in text, and of an end of text that starts a known value.
function spans(text) {
  const out = [];
  const add = (re) => { for (const m of text.matchAll(re)) if (m[0]) out.push([m.index, m.index + m[0].length]); };
  if (ctx.index.re) add(ctx.index.re);
  for (const { re } of ctx.compiled) add(re);
  if (strict) add(/[^\s"'`,;()[\]{}<>]{20,}/g);
  const n = prefixAt(text, ctx.index);
  if (n) out.push([text.length - n, text.length]);
  return out;
}

// Moves cut back to the start of every span that holds it.
function backOut(all, cut) {
  let c = cut;
  for (let o = all.filter(([s, e]) => s < c && c < e); o.length && c > 0; o = all.filter(([s, e]) => s < c && c < e)) c = Math.min(...o.map(([s]) => s));
  return c;
}

// Moves a cut out of every match that spans it: back to the start of the
// match, or, when the match starts the text, forward to its end. Returns 0
// when no such cut exists yet (a match runs from the start to the end of the
// text and may go on), so the caller waits for more text.
function safeCut(text, cut) {
  const all = spans(text);
  const over = (c) => all.filter(([s, e]) => s < c && c < e);
  let c = backOut(all, cut);
  if (c > 0) return c;
  c = cut;
  for (let o = over(c); o.length; o = over(c)) c = Math.max(...o.map(([, e]) => e));
  return c < text.length ? c : 0;
}

function finish() {
  drain(true);
  if (failed || mode !== 'bash') return;
  const notes = [];
  if (total) notes.push(`[hush] redacted ${total} secret(s)`);
  if (strict && strict.count) notes.push(strict.notice());
  if (!notes.length) return;
  writeAll(OUT, `${lastChar === '\n' ? '' : '\n'}${notes.join('\n')}\n`);
  if (strict && strict.count) counts.strict = strict.count;
  try { log('Bash', counts); } catch { /* log is best effort */ }
}

const ack = () => { try { writeAll(1, failed ? '1\n' : '0\n'); } catch { /* shell is gone */ } };

const dec = new StringDecoder('utf8');
// Reads the header at the start of the stream. Returns false while it is incomplete.
function header() {
  if (pending.length < HEAD.length && HEAD.startsWith(pending)) return false;
  if (pending.startsWith(HEAD)) {
    const e = pending.indexOf('\0', HEAD.length);
    if (e < 0) return false;
    if (ctx && isStrict(commandOf(pending.slice(HEAD.length, e)), ctx.cfg)) strict = new Strict(ctx.cfg);
    pending = pending.slice(e + 1);
  }
  headed = true;
  return true;
}

process.stdin.on('data', (chunk) => {
  try {
    pending += dec.write(chunk);
    if (!headed && !header()) return;
    if (!marked) {
      const i = pending.indexOf(MARK);
      if (i >= 0) {
        const rest = pending.slice(i + MARK.length);
        pending = pending.slice(0, i);
        finish();
        marked = true;
        ack();
        pending = rest;
      }
    }
    drain(false);
  } catch (e) { withhold(e); }
  clearTimeout(idle);
  clearTimeout(hold);
  if (pending) idle = setTimeout(() => { try { onIdle(); } catch (e) { withhold(e); } }, IDLE_MS);
});
process.stdin.on('end', () => {
  clearTimeout(idle);
  clearTimeout(hold);
  try {
    pending += dec.end();
    if (!headed && !header()) pending = '';
    if (marked) drain(true); else finish();
  } catch (e) { withhold(e); }
  if (!marked) ack();
  process.exitCode = failed ? 1 : 0;
});
process.stdin.on('error', (e) => { withhold(e); ack(); process.exitCode = 1; });
