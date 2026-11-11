#!/usr/bin/env node
'use strict';
// Adds one pattern, or one strict command, to the user's hush config. Add-only.
// Never prints the test line or any value.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, redact } = require('../hooks/hush-lib');

const USAGE = 'usage: add-pattern.js --name <name> --regex <source> --test-file <path> [--dry-run]\n'
  + '       add-pattern.js --strict-command <regex> [--test-file <path>] [--dry-run]';
const fail = (msg) => { console.error(`add-pattern: ${msg}`); process.exit(1); };

const opt = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') opt.dry = true;
  else if (['--name', '--regex', '--test-file', '--strict-command'].includes(a) && i + 1 < argv.length) opt[a.slice(2)] = argv[++i];
  else fail(`unknown or incomplete argument\n${USAGE}`);
}
if (!!opt.regex === !!opt['strict-command'] || (opt.regex && (!opt.name || !opt['test-file']))) fail(USAGE);

// Literal text at the start of a regex source, for the adversarial line.
function literalPrefix(src) {
  const s = src.replace(/^(?:\^|\\b|\(\?<?[!=][^)]*\)|\(\?:)+/, '');
  let out = '';
  let i = 0;
  for (; i < s.length; i++) {
    if (s[i] === '\\' && /[^A-Za-z0-9]/.test(s[i + 1] || 'a')) { out += s[++i]; continue; }
    if (/[A-Za-z0-9_:@=\-/ ]/.test(s[i])) { out += s[i]; continue; }
    break;
  }
  // A quantifier binds to the last character only.
  if (out && /^[*+?{]/.test(s.slice(i))) out = out.slice(0, -1);
  return out;
}

function checkRegex(src, kind, fallbackLine) {
  try { new RegExp(src, 'g'); } catch { fail(`${kind} is not a valid regular expression`); }
  if (new RegExp(src).test('')) fail(`${kind} matches the empty string`);
  const prefix = literalPrefix(src) || (fallbackLine || 'a').slice(0, 4);
  const n = 32000;
  const lines = [prefix.repeat(Math.ceil(n / prefix.length)).slice(0, n), (prefix + 'a'.repeat(n)).slice(0, n),
    (prefix + ' '.repeat(n)).slice(0, n), (prefix + 'a'.repeat(n)).slice(0, n - 1) + '!'];
  const code = 'const [src,lines]=JSON.parse(require("fs").readFileSync(0,"utf8"));const re=new RegExp(src,"g");let worst=0;'
    + 'for(const l of lines){const t=performance.now();l.replace(re,"x");worst=Math.max(worst,performance.now()-t);}console.log(worst);';
  const r = spawnSync(process.execPath, ['-e', code], { input: JSON.stringify([src, lines]), timeout: 3000, encoding: 'utf8' });
  if (r.error || r.status !== 0) fail(`${kind} took too long on a 32,000-character line`);
  const ms = parseFloat(r.stdout);
  if (ms > 100) fail(`${kind} took ${Math.round(ms)} ms on a 32,000-character line (limit 100 ms)`);
}

let testLine = null;
if (opt['test-file']) {
  try { testLine = fs.readFileSync(opt['test-file'], 'utf8').replace(/\r?\n$/, ''); } catch { fail('cannot read the test file'); }
  if (!testLine || /[\r\n]/.test(testLine)) fail('the test file must hold exactly one non-empty line');
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? os.homedir() + p.slice(1) : p);
const target = expandHome(process.env.HUSH_CONFIG || '~/.config/hush/config.json');
let user = {};
if (fs.existsSync(target)) {
  try { user = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { fail('the config file is not valid JSON; fix it by hand'); }
}
const current = loadConfig();
let entry;
if (opt.regex) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(opt.name)) fail('the name may only hold letters, digits, and _ . : -');
  checkRegex(opt.regex, 'the pattern', testLine);
  const probe = { patterns: [{ name: 'probe', regex: opt.regex }], minLength: current.minLength, allow: [], allowLiterals: [] };
  if (redact(testLine, probe, []).text === testLine) fail('the pattern does not redact the test line');
  const taken = new Set(current.patterns.map((p) => p.name));
  let name = opt.name;
  for (let n = 2; taken.has(name); n++) name = `${opt.name}-${n}`;
  entry = { list: 'patterns', value: { name, regex: opt.regex } };
} else {
  checkRegex(opt['strict-command'], 'the strict command', testLine);
  if (testLine && !new RegExp(opt['strict-command']).test(testLine)) fail('the strict command does not match the test line');
  entry = { list: 'strictCommands', value: opt['strict-command'] };
  if ((current.strictCommands || []).includes(entry.value)) { console.log('already present: strictCommands'); process.exit(0); }
}
const label = typeof entry.value === 'string' ? 'one entry' : entry.value.name;

if (opt.dry) {
  console.log(`dry run: would add to ${entry.list} in ${target}: ${label}`);
  process.exit(0);
}

const next = { ...user, [entry.list]: [...(user[entry.list] || []), entry.value] };
const dir = path.dirname(target);
fs.mkdirSync(dir, { recursive: true });
const tmp = path.join(dir, `.config.json.tmp-${process.pid}`);
fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
const saved = process.env.HUSH_CONFIG;
try {
  process.env.HUSH_CONFIG = tmp;
  const check = loadConfig();
  for (const p of check.patterns) new RegExp(p.regex, 'g');
  if (!check[entry.list].some((x) => JSON.stringify(x) === JSON.stringify(entry.value))) throw new Error('missing');
} catch {
  fs.rmSync(tmp, { force: true });
  fail('the new config did not load; nothing was changed');
} finally {
  if (saved === undefined) delete process.env.HUSH_CONFIG; else process.env.HUSH_CONFIG = saved;
}
if (fs.existsSync(target)) {
  const bak = `${target}.bak-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}`;
  fs.copyFileSync(target, bak);
  fs.chmodSync(bak, 0o600);
}
fs.renameSync(tmp, target);
console.log(`added to ${entry.list}: ${label}`);
