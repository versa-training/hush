#!/usr/bin/env node
'use strict';
// Replaces secret values in transcripts and task output files with the hush placeholder.
// Reports file names, counts, and sha8 fingerprints only. A value split across two
// lines or two records is not found.
const fs = require('fs');
const path = require('path');
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
if (opt.known) values.push(...loadKnown(cfg).values.map((v) => v.value));
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
const re = new RegExp([...forms.keys()].sort((a, b) => b.length - a.length).map(esc).join('|'), 'g');
const sha = new Map(values.map((v) => [v, sha8(v)]));

function* walk(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) { yield { p, skip: 'symlink' }; return; }
  if (st.isDirectory()) { for (const n of fs.readdirSync(p).sort()) yield* walk(path.join(p, n)); return; }
  if (st.isFile()) yield { p, st };
}

const now = Date.now();
const total = {};
let files = 0;
let changed = 0;
const note = (p, msg) => console.log(`${p}: ${msg}`);
for (const root of opt.paths) {
  try { fs.lstatSync(root); } catch { fail('a --path does not exist'); }
  for (const f of walk(root)) {
    files++;
    if (f.skip) { note(f.p, `skipped (${f.skip})`); continue; }
    if (!opt.active && now - f.st.mtimeMs < 60000) { note(f.p, 'skipped (modified in the last 60 s; use --include-active)'); continue; }
    if (f.st.size > 256 * 1024 * 1024) { note(f.p, 'skipped (larger than 256 MB)'); continue; }
    const buf = fs.readFileSync(f.p);
    if (buf.subarray(0, 8192).includes(0)) { note(f.p, 'skipped (binary)'); continue; }
    const counts = {};
    const out = buf.toString('utf8').replace(re, (m) => {
      const s = sha.get(forms.get(m));
      counts[s] = (counts[s] || 0) + 1;
      return `[hush scrubbed sha:${s}]`;
    });
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!n) continue;
    const list = Object.entries(counts).map(([s, c]) => `sha:${s}=${c}`).join(' ');
    if (!opt.apply) {
      for (const [s, c] of Object.entries(counts)) total[s] = (total[s] || 0) + c;
      changed++;
      note(f.p, `${n} match(es) ${list}`);
      continue;
    }
    const again = fs.lstatSync(f.p);
    if (again.mtimeMs !== f.st.mtimeMs || again.size !== f.st.size) { note(f.p, 'skipped (changed while reading)'); continue; }
    const tmp = path.join(path.dirname(f.p), `.scrub-${process.pid}-${path.basename(f.p)}`);
    fs.writeFileSync(tmp, out, { mode: f.st.mode & 0o7777 });
    fs.chmodSync(tmp, f.st.mode & 0o7777);
    fs.utimesSync(tmp, f.st.atime, f.st.mtime);
    fs.renameSync(tmp, f.p);
    for (const [s, c] of Object.entries(counts)) total[s] = (total[s] || 0) + c;
    changed++;
    note(f.p, `scrubbed ${n} match(es) ${list}`);
  }
}
const sum = Object.values(total).reduce((a, b) => a + b, 0);
console.log(`${opt.apply ? 'applied' : 'dry run'}: ${sum} match(es) in ${changed} of ${files} file(s)`
  + (Object.keys(total).length ? ', ' + Object.entries(total).map(([s, c]) => `sha:${s}=${c}`).join(' ') : '')
  + (tooShort ? `; ${tooShort} value(s) shorter than minLength ignored` : ''));
