#!/usr/bin/env node
'use strict';
// Streaming filter for the command wrapper (hooks/wrap.sh).
// Reads the command's output on stdin, writes the redacted text to fd 3 (the
// original stdout), and writes one ack line to stdout when it reads the end
// marker: "0" when all output so far was redacted, "1" when it was withheld.
// Usage: node filter.js <nonce> <bash|monitor>
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const { loadConfig, loadKnown, buildKnown, compile, redact, log } = require('./hush-lib');

const OUT = Number(process.env.HUSH_FILTER_FD || 3);
const nonce = process.argv[2] || '';
const mode = process.argv[3] || 'bash';
const MARK = `\0HUSH:${nonce}\0`;
// A line longer than this is cut and redacted in parts.
const CAP = Number(process.env.HUSH_FILTER_CAP || 65536);
// The tail of a cut line is kept for the next part, so a value up to this length is not split.
const KEEP = 4096;
// A partial line with no newline is written after this much idle time.
const IDLE_MS = Number(process.env.HUSH_FILTER_IDLE_MS || 250);
const PEM_OPEN = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?![\s\S]*-----END [A-Z ]*PRIVATE KEY-----)/;

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

const withhold = (e) => {
  if (failed) return;
  failed = true;
  pending = '';
  const msg = `[hush] output withheld: redaction failed (${(e && e.constructor && e.constructor.name) || 'Error'})\n`;
  try { writeAll(OUT, msg); } catch { /* nothing left to write to */ }
};

try {
  const cfg = loadConfig();
  const known = loadKnown(cfg).values;
  ctx = { cfg, known, compiled: compile(cfg), index: buildKnown(known, cfg) };
} catch (e) { withhold(e); }

function emit(text) {
  if (!text || failed) return;
  const r = redact(text, ctx.cfg, ctx.known, ctx.compiled, ctx.index);
  for (const [k, n] of Object.entries(r.counts)) { counts[k] = (counts[k] || 0) + n; total += n; }
  writeAll(OUT, r.text);
  lastChar = r.text[r.text.length - 1];
}

// Writes every complete line of pending, holding an open PEM block; cuts an overlong line.
function drain(all) {
  if (failed) { pending = ''; return; }
  if (all) { emit(pending); pending = ''; return; }
  let end = pending.lastIndexOf('\n') + 1;
  const pem = PEM_OPEN.exec(pending.slice(0, end));
  if (pem && pending.length < CAP) end = pem.index;
  else if (pending.length < CAP) end = holdArgv(pending, end);
  if (end > 0) { emit(pending.slice(0, end)); pending = pending.slice(end); }
  if (pending.length >= CAP) {
    const headEnd = pending.length - KEEP;
    let ws = headEnd - 1;
    while (ws > headEnd - 65536 && ws > 0 && !/\s/.test(pending[ws])) ws--;
    const cut = ws > 0 && /\s/.test(pending[ws]) ? ws + 1 : headEnd;
    emit(pending.slice(0, cut));
    pending = pending.slice(cut);
  }
}

function finish() {
  drain(true);
  if (!failed && mode === 'bash' && total) {
    writeAll(OUT, `${lastChar === '\n' ? '' : '\n'}[hush] redacted ${total} secret(s)\n`);
    try { log('Bash', counts); } catch { /* log is best effort */ }
  }
}

const ack = () => { try { writeAll(1, failed ? '1\n' : '0\n'); } catch { /* shell is gone */ } };

const dec = new StringDecoder('utf8');
process.stdin.on('data', (chunk) => {
  try {
    pending += dec.write(chunk);
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
  if (pending) idle = setTimeout(() => { try { drain(true); } catch (e) { withhold(e); } }, IDLE_MS);
});
process.stdin.on('end', () => {
  clearTimeout(idle);
  try {
    pending += dec.end();
    if (marked) drain(true); else finish();
  } catch (e) { withhold(e); }
  if (!marked) ack();
  process.exitCode = failed ? 1 : 0;
});
process.stdin.on('error', (e) => { withhold(e); ack(); process.exitCode = 1; });
