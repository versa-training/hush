#!/usr/bin/env node
'use strict';
// Replaces secret values in transcripts and task output files with the hush placeholder.
// Reports file names, counts, sha8 fingerprints, and the names of known values only.
// In JSON, values are replaced inside decoded strings, so escapes stay valid; a file
// in which a line that parsed before would no longer parse is left unchanged.
// A value split across two lines or two records is not found.
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { loadConfig, loadKnown, sha8 } = require('../hooks/hush-lib');

const fail = (msg) => { console.error(`scrub: ${msg}`); process.exit(1); };
const USAGE = 'usage: scrub.js --path <dir|file> [--path ...] (values on stdin, one per line | --known [--stdin]) [--dry-run | --apply] [--include-active]';
const opt = { paths: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--path' && i + 1 < argv.length) opt.paths.push(argv[++i]);
  else if (a === '--known') opt.known = true;
  else if (a === '--stdin') opt.stdin = true;
  else if (a === '--apply') opt.apply = true;
  else if (a === '--dry-run') opt.dry = true;
  else if (a === '--include-active') opt.active = true;
  else fail(`unknown argument\n${USAGE}`);
}
if (!opt.paths.length) fail(`--path is required\n${USAGE}`);
if (opt.apply && opt.dry) fail('choose --apply or --dry-run');

const cfg = loadConfig();
let values = [];
const names = new Map();
if (opt.known) for (const v of loadKnown(cfg).values) { values.push(v.value); names.set(v.value, v.name); }
if (!opt.known || opt.stdin) values.push(...fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean));
values = [...new Set(values)];
const tooShort = values.filter((v) => v.length < cfg.minLength).length;
values = values.filter((v) => v.length >= cfg.minLength);
if (!values.length) fail('no values of minLength or more');

// Every spelling of a value that can appear in a file.
const forms = new Map();
for (const v of values) {
  const json = JSON.stringify(v).slice(1, -1);
  const ascii = json.replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const upper = ascii.replace(/\\u([0-9a-f]{4})/g, (m, h) => '\\u' + h.toUpperCase());
  const set = new Set([v, json, ascii, upper, json.replace(/\//g, '\\/'), ascii.replace(/\//g, '\\/'), JSON.stringify(json).slice(1, -1)]);
  for (const f of set) if (!forms.has(f)) forms.set(f, v);
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const source = [...forms.keys()].sort((a, b) => b.length - a.length).map(esc).join('|');
const re = new RegExp(source, 'g');
const sha = new Map(values.map((v) => [v, sha8(v)]));
const label = (s) => { const v = values.find((x) => sha.get(x) === s); return names.has(v) ? ` (${names.get(v)})` : ''; };

const MAX_LINE = 50 * 1024 * 1024;
const MAX_DEPTH = 4;
let counts = {};

// Plain text replacement, for text that is not JSON.
const raw = (text) => text.replace(re, (m) => {
  const s = sha.get(forms.get(m));
  counts[s] = (counts[s] || 0) + 1;
  return `[hush scrubbed sha:${s}]`;
});
const parses = (t) => { try { JSON.parse(t); return true; } catch { return false; } };
const looksJson = (t) => /^\s*[[{"]/.test(t);

// Text that is a JSON document is rewritten token by token; other text line by line.
function rewriteText(text, depth) {
  if (depth < MAX_DEPTH && looksJson(text) && parses(text)) return rewriteJson(text, depth);
  if (text.includes('\n')) return text.split('\n').map((l) => rewriteText(l, depth)).join('\n');
  return raw(text);
}

// Rewrites valid JSON text: each string (key or value) is decoded, rewritten,
// and encoded again only when it changed; a number holding a value becomes a
// string. Everything else stays byte for byte.
function rewriteJson(text, depth) {
  let out = '';
  let i = 0;
  const num = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const tok = text.slice(i, j + 1);
      const s = JSON.parse(tok);
      const next = rewriteText(s, depth + 1);
      out += next === s ? tok : JSON.stringify(next);
      i = j + 1;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      num.lastIndex = i;
      const tok = num.exec(text)[0];
      const next = raw(tok);
      out += next === tok ? tok : JSON.stringify(next);
      i += tok.length;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Rewrites one line; throws Skip when a line that parsed would no longer parse.
class Skip extends Error {}
function rewriteLine(line) {
  const out = rewriteText(line, 0);
  if (out !== line && looksJson(line) && parses(line) && !parses(out)) throw new Skip('a JSON line would no longer parse');
  return out;
}

function* walk(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) { yield { p, skip: 'symlink' }; return; }
  if (st.isDirectory()) { for (const n of fs.readdirSync(p).sort()) yield* walk(path.join(p, n)); return; }
  if (st.isFile()) yield { p, st };
}

// Streams file p line by line into write (null for a dry run). Returns a skip reason or null.
function scrubFile(p, st, write) {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    const dec = new StringDecoder('utf8');
    let first = true;
    let pending = '';
    // A file of at most 50 MB that is one JSON document, such as pretty-printed
    // JSON, is rewritten as a whole; a larger .json file is not scrubbed.
    if (st.size > MAX_LINE && p.endsWith('.json')) return 'a .json file larger than 50 MB; not scrubbed';
    if (st.size <= MAX_LINE) {
      const text = fs.readFileSync(fd, 'utf8');
      if (text.slice(0, 8192).includes('\0')) return 'binary';
      if (parses(text)) {
        const out = rewriteText(text, 0);
        if (out !== text && !parses(out)) throw new Skip('the JSON document would no longer parse');
        if (write) write(out);
        return null;
      }
      const lines = text.split('\n');
      const outs = lines.map(rewriteLine);
      if (write) write(outs.join('\n'));
      return null;
    }
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (first && buf.subarray(0, Math.min(n, 8192)).includes(0)) return 'binary';
      first = false;
      if (!n) break;
      const parts = dec.write(buf.subarray(0, n)).split('\n');
      parts[0] = pending + parts[0];
      pending = parts.pop();
      if (pending.length > MAX_LINE || parts.some((l) => l.length > MAX_LINE)) return 'a line is longer than 50 MB; not scrubbed';
      for (const l of parts) { const out = rewriteLine(l) + '\n'; if (write) write(out); }
    }
    pending += dec.end();
    if (pending.length > MAX_LINE) return 'a line is longer than 50 MB; not scrubbed';
    if (pending) { const out = rewriteLine(pending); if (write) write(out); }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const now = Date.now();
const total = {};
let files = 0;
let changed = 0;
let skipped = 0;
let errors = 0;
const note = (p, msg) => console.log(`${p}: ${msg}`);
const list = (c) => Object.entries(c).map(([s, n]) => `sha:${s}=${n}${label(s)}`).join(' ');

// All paths are checked before any file is rewritten.
const roots = opt.paths.filter((root) => {
  try { fs.lstatSync(root); return true; } catch { note(root, 'skipped (does not exist)'); return false; }
});
for (const root of roots) {
  let entries;
  try { entries = [...walk(root)]; } catch (e) { note(root, `error (${e.code || e.constructor.name}); not scrubbed`); errors++; continue; }
  for (const f of entries) {
    files++;
    if (f.skip) { note(f.p, `skipped (${f.skip})`); continue; }
    if (!opt.active && now - f.st.mtimeMs < 60000) { note(f.p, 'skipped (modified in the last 60 s; use --include-active)'); continue; }
    counts = {};
    let tmp = null;
    let tfd = null;
    try {
      if (opt.apply) {
        tmp = path.join(path.dirname(f.p), `.scrub-${process.pid}-${path.basename(f.p)}`);
        tfd = fs.openSync(tmp, 'wx', f.st.mode & 0o7777);
      }
      const why = scrubFile(f.p, f.st, tfd === null ? null : (s) => fs.writeSync(tfd, s));
      if (why) { note(f.p, `skipped (${why})`); skipped++; continue; }
      const n = Object.values(counts).reduce((a, b) => a + b, 0);
      if (!n) continue;
      if (opt.apply) {
        fs.closeSync(tfd);
        tfd = null;
        const again = fs.lstatSync(f.p);
        if (again.mtimeMs !== f.st.mtimeMs || again.size !== f.st.size) { note(f.p, 'skipped (changed while reading)'); skipped++; continue; }
        fs.chmodSync(tmp, f.st.mode & 0o7777);
        fs.utimesSync(tmp, f.st.atime, f.st.mtime);
        fs.renameSync(tmp, f.p);
        tmp = null;
      }
      for (const [s, c] of Object.entries(counts)) total[s] = (total[s] || 0) + c;
      changed++;
      note(f.p, `${opt.apply ? 'scrubbed ' : ''}${n} match(es) ${list(counts)}`);
    } catch (e) {
      if (e instanceof Skip) { note(f.p, `skipped (${e.message}; file unchanged)`); skipped++; } else { note(f.p, `error (${e.code || e.constructor.name}); file unchanged`); errors++; }
    } finally {
      if (tfd !== null) fs.closeSync(tfd);
      if (tmp) fs.rmSync(tmp, { force: true });
    }
  }
}
const sum = Object.values(total).reduce((a, b) => a + b, 0);
console.log(`${opt.apply ? 'applied' : 'dry run'}: ${sum} match(es) in ${changed} of ${files} file(s)`
  + (Object.keys(total).length ? ', ' + list(total) : '')
  + (skipped ? `; ${skipped} file(s) skipped, see above` : '')
  + (errors ? `; ${errors} error(s)` : '')
  + (roots.length < opt.paths.length ? `; ${opt.paths.length - roots.length} path(s) do not exist` : '')
  + (tooShort ? `; ${tooShort} value(s) shorter than minLength ignored` : ''));
process.exit(errors || !roots.length ? 1 : 0);
