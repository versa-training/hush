#!/usr/bin/env node
'use strict';
// Registers one known secret value, read from stdin, so hush redacts it everywhere.
// Prints only the sha8 and the count.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, loadKnown, sha8 } = require('../hooks/hush-lib');

const fail = (msg) => { console.error(`add-known: ${msg}`); process.exit(1); };
if (process.argv.length > 2) fail('the value comes from stdin only, never from an argument');
if (process.stdin.isTTY) fail('pipe the value on stdin');

const value = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
const cfg = loadConfig();
if (/[\r\n\0]/.test(value)) fail('multi-line values are not supported');
if (value.length < cfg.minLength) fail(`the value is shorter than minLength (${cfg.minLength})`);

const file = process.env.HUSH_KNOWN_VALUES || path.join(os.homedir(), '.config/hush/known-values');
const sha = sha8(value);
let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
// A dotenv line with single quotes: the loader keeps the text between the outer quotes as is.
const line = `KNOWN_${sha}='${value}'`;
const had = text.split('\n').includes(line);
if (!had) text += (text && !text.endsWith('\n') ? '\n' : '') + line + '\n';

const dir = path.dirname(file);
fs.mkdirSync(dir, { recursive: true });
const tmp = path.join(dir, `.known-values.tmp-${process.pid}`);
fs.writeFileSync(tmp, text, { mode: 0o600 });
const { values } = loadKnown({ files: [tmp], minLength: 1 });
if (!values.some((v) => v.value === value)) { fs.rmSync(tmp, { force: true }); fail('the loader does not read this value back; nothing was written'); }
fs.renameSync(tmp, file);
fs.chmodSync(file, 0o600);

const listed = loadKnown({ files: cfg.files, minLength: 1 }).files.some((f) => f.path === file);
console.log(`sha:${sha} ${had ? 'already registered' : 'registered'}, ${values.length} value(s) in the file`);
if (!listed) console.error('add-known: this file is not in the hush config "files" list; add it there');
