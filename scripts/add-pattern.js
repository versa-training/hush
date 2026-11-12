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

const FIXTURES = path.join(__dirname, 'data');
const CORPUS = path.join(FIXTURES, 'harmless-output.txt');
const COMMANDS = path.join(FIXTURES, 'harmless-commands.txt');
const N = 32000;
// Characters that stand for every class in the timing and overlap checks.
const CANDIDATES = [...Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)), ' ', 'é', '€', ' ', '￿'];

// Parses a regex source (already known to be valid, no u flag) into
// {branches: [[atom]]}; an atom is {kind, src, alt, quant: {min, max}}.
function parseRegex(src) {
  let i = 0;
  const quant = () => {
    let q = null;
    const c = src[i];
    if (c === '*') q = { min: 0, max: Infinity };
    else if (c === '+') q = { min: 1, max: Infinity };
    else if (c === '?') q = { min: 0, max: 1 };
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (!m) return null;
      q = { min: +m[1], max: m[2] ? (m[3] ? +m[3] : Infinity) : +m[1] };
      i += m[0].length - 1;
    } else return null;
    i++;
    if (src[i] === '?') i++;
    return q;
  };
  const atom = () => {
    const start = i;
    const c = src[i];
    if (c === '(') {
      let kind = 'group';
      i++;
      if (src.startsWith('?:', i)) i += 2;
      else if (src.startsWith('?=', i) || src.startsWith('?!', i)) { kind = 'look'; i += 2; }
      else if (src.startsWith('?<=', i) || src.startsWith('?<!', i)) { kind = 'look'; i += 3; }
      else if (src.startsWith('?<', i)) i = src.indexOf('>', i) + 1;
      const a = alt();
      i++;
      return { kind, alt: a };
    }
    if (c === '[') {
      i++;
      if (src[i] === '^') i++;
      if (src[i] === ']') i++;
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      i++;
      return { kind: 'class', src: src.slice(start, i) };
    }
    if (c === '\\') {
      const d = src[i + 1];
      i += 2;
      if (/[1-9]/.test(d)) { while (/\d/.test(src[i] || '')) i++; return { kind: 'backref' }; }
      if (d === 'k' && src[i] === '<') { i = src.indexOf('>', i) + 1; return { kind: 'backref' }; }
      if (d === 'b' || d === 'B') return { kind: 'assert' };
      if (d === 'x') i += 2;
      else if (d === 'u') i += 4;
      else if (d === 'c') i += 1;
      return { kind: 'class', src: src.slice(start, i) };
    }
    i++;
    if (c === '^' || c === '$') return { kind: 'assert' };
    return { kind: 'class', src: c };
  };
  const seq = () => {
    const items = [];
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      const a = atom();
      a.quant = quant();
      items.push(a);
    }
    return items;
  };
  const alt = () => {
    const branches = [seq()];
    while (src[i] === '|') { i++; branches.push(seq()); }
    return { branches };
  };
  return alt();
}

const ALL = new Set(CANDIDATES);
// The candidate characters a class atom matches.
function charsOf(a) {
  if (a.kind !== 'class') return ALL;
  if (!a.chars) {
    let re;
    try { re = new RegExp(`^(?:${a.src})$`); } catch { a.chars = ALL; return ALL; }
    a.chars = new Set(CANDIDATES.filter((c) => re.test(c)));
  }
  return a.chars;
}
// The characters a branch can start with; ALL when unknown or when it can be empty.
function firstChars(items) {
  const out = new Set();
  for (const a of items) {
    if (a.kind === 'assert' || a.kind === 'look') continue;
    const set = a.kind === 'group' ? firstOfAlt(a.alt) : charsOf(a);
    for (const c of set) out.add(c);
    if (set === ALL) return ALL;
    if (!a.quant || a.quant.min > 0) return out;
  }
  return ALL;
}
const firstOfAlt = (alt) => {
  const out = new Set();
  for (const b of alt.branches) { const s = firstChars(b); if (s === ALL) return ALL; for (const c of s) out.add(c); }
  return out;
};
const atomsOf = function* (alt) {
  for (const b of alt.branches) for (const a of b) { yield a; if (a.alt) yield* atomsOf(a.alt); }
};
const altsOf = function* (alt) {
  yield alt;
  for (const a of atomsOf(alt)) if (a.alt) yield a.alt;
};

// Refuses a repeated group that holds a variable repeat, a backreference, or
// alternatives that can start with the same character: these can backtrack
// exponentially. Conservative: it also refuses some safe patterns.
function staticCheck(tree, kind) {
  const rewrite = 'Rewrite it without a repeated group that holds a repeat or overlapping alternatives:'
    + ' one character class with a bounded repeat, for example [0-9a-f]{20,64} instead of ([0-9a-f]+)+';
  for (const a of atomsOf(tree)) {
    if (!a.alt || !a.quant || a.quant.max <= 1) continue;
    for (const inner of atomsOf(a.alt)) {
      if (inner.kind === 'backref' || (inner.quant && inner.quant.min !== inner.quant.max)) {
        fail(`${kind} repeats a group that holds a variable repeat, which can take exponential time. ${rewrite}`);
      }
    }
    for (const alt of altsOf(a.alt)) {
      if (alt.branches.length < 2) continue;
      const sets = alt.branches.map(firstChars);
      for (let x = 0; x < sets.length; x++) {
        for (let y = x + 1; y < sets.length; y++) {
          if (sets[x] === ALL || sets[y] === ALL || [...sets[x]].some((c) => sets[y].has(c))) {
            fail(`${kind} repeats a group whose alternatives can start with the same character, which can take exponential time. ${rewrite}`);
          }
        }
      }
    }
  }
}

// Runs code in a child process with input on stdin; null when it fails or runs longer than 2 s.
function child(code, input) {
  const r = spawnSync(process.execPath, ['-e', code], { input: JSON.stringify(input), timeout: 2000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1 << 20 });
  return r.error || r.status !== 0 ? null : r.stdout;
}

// Lines built from the literal prefix and from every character class in the
// pattern, repeated to 32,000 characters, with and without a final mismatching character.
function adversarialGroups(src, tree, fallbackLine) {
  const prefix = literalPrefix(src) || (fallbackLine || 'a').slice(0, 4);
  const groups = [[prefix.repeat(Math.ceil(N / prefix.length)).slice(0, N), (prefix + 'a'.repeat(N)).slice(0, N),
    (prefix + ' '.repeat(N)).slice(0, N), (prefix + 'a'.repeat(N)).slice(0, N - 1) + '!']];
  const reps = [];
  for (const a of atomsOf(tree)) {
    if (a.kind !== 'class') continue;
    const set = charsOf(a);
    const rep = CANDIDATES.find((c) => set.has(c) && c !== '\n') || CANDIDATES.find((c) => set.has(c));
    if (rep === undefined || reps.some((r) => r.rep === rep)) continue;
    reps.push({ rep, miss: ['!', '\u0001', ' ', '\n', 'é', 'a', '0'].find((c) => !set.has(c)) || '!' });
  }
  for (const { rep, miss } of reps.slice(0, 48)) {
    const run = rep.repeat(N);
    groups.push([run, run.slice(0, -1) + miss, (prefix + run).slice(0, N), (prefix + run).slice(0, N - 1) + miss]);
  }
  if (reps.length > 1) {
    const mix = reps.map((r) => r.rep).join('').repeat(Math.ceil(N / reps.length)).slice(0, N);
    groups.push([mix, mix.slice(0, -1) + '!', (prefix + mix).slice(0, N)]);
  }
  return groups;
}

const TIMING = 'const [src,lines]=JSON.parse(require("fs").readFileSync(0,"utf8"));const re=new RegExp(src,"g");let worst=0;'
  + 'for(const l of lines){const t=performance.now();l.replace(re,"x");worst=Math.max(worst,performance.now()-t);}console.log(worst);';

function checkRegex(src, kind, fallbackLine) {
  try { new RegExp(src, 'g'); } catch { fail(`${kind} is not a valid regular expression`); }
  if (new RegExp(src).test('')) fail(`${kind} matches the empty string`);
  const tree = parseRegex(src);
  staticCheck(tree, kind);
  for (const lines of adversarialGroups(src, tree, fallbackLine)) {
    const out = child(TIMING, [src, lines]);
    if (out === null) fail(`${kind} took more than 2 s on a 32,000-character line`);
    const ms = parseFloat(out);
    if (!(ms <= 100)) fail(`${kind} took ${Math.round(ms)} ms on a 32,000-character line (limit 100 ms)`);
  }
}

// The 1-based number of the first line in file that the regex matches, 0 for none.
// The whole text is tried too, for a pattern that spans lines.
const FIRST_HIT = 'const [src,flags,text]=JSON.parse(require("fs").readFileSync(0,"utf8"));const lines=text.split("\\n");'
  + 'let n=lines.findIndex((l)=>new RegExp(src,flags).test(l))+1;'
  + 'if(!n){const m=new RegExp(src,flags).exec(text);if(m)n=text.slice(0,m.index).split("\\n").length;}console.log(n);';
function firstHit(file, src, flags) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { fail(`cannot read ${file}; reinstall hush`); }
  const out = child(FIRST_HIT, [src, flags, text.replace(/\n$/, '')]);
  if (out === null) fail(`the check against ${file} did not finish in 2 s`);
  return parseInt(out, 10);
}

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

let testLine = null;
if (opt['test-file']) {
  try { testLine = fs.readFileSync(opt['test-file'], 'utf8').replace(/\r?\n$/, ''); } catch { fail('cannot read the test file'); }
  if (!testLine) fail('the test file must hold exactly one non-empty line');
  if (/[\r\n]/.test(testLine)) {
    fail('the test file holds more than one line, but patterns are matched per line, so it must hold exactly one. For a value in a block, such as a key body below a marker line, '
      + 'write the marker and a fake body on one line and capture the body after the marker, as in `-----BEGIN ACME KEY-----\\s*([A-Za-z0-9+/=]{40,4000})`');
  }
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
  const same = current.patterns.find((p) => p.regex === opt.regex);
  if (same) { console.log(`already present: patterns (${same.name})`); process.exit(0); }
  checkRegex(opt.regex, 'the pattern', testLine);
  const probe = { patterns: [{ name: 'probe', regex: opt.regex }], minLength: current.minLength, allow: [], allowLiterals: [] };
  if (redact(testLine, probe, []).text === testLine) fail('the pattern does not redact the test line');
  // A match that is the whole multi-word test line would hide the context around every value.
  const m = new RegExp(opt.regex).exec(testLine);
  const replaced = m && (typeof m[1] === 'string' ? m[1] : m[0]);
  if (m && replaced.trim() === testLine.trim() && testLine.trim().split(/\s+/).length > 1) {
    fail('the pattern replaces the whole test line, not only the value; match only the value, or put the value in a capture group, as in `key: ([a-f0-9]{24})`');
  }
  const hit = firstHit(CORPUS, opt.regex, 'g');
  if (hit) fail(`the pattern matches line ${hit} of the harmless sample output (${CORPUS}); make it more specific, for example a fixed prefix and a bounded character class`);
  const taken = new Set(current.patterns.map((p) => p.name));
  let name = opt.name;
  for (let n = 2; taken.has(name); n++) name = `${opt.name}-${n}`;
  entry = { list: 'patterns', value: { name, regex: opt.regex } };
} else {
  entry = { list: 'strictCommands', value: opt['strict-command'] };
  if ((current.strictCommands || []).includes(entry.value)) { console.log('already present: strictCommands'); process.exit(0); }
  checkRegex(opt['strict-command'], 'the strict command', testLine);
  if (testLine && !new RegExp(opt['strict-command'], 'm').test(testLine)) fail('the strict command does not match the test line');
  const hit = firstHit(COMMANDS, opt['strict-command'], 'm');
  if (hit) fail(`the strict command matches the harmless command on line ${hit} of ${COMMANDS}; make it more specific`);
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
