'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sha8 = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 8);
const home = (p) => (p === '~' || p.startsWith('~/') ? os.homedir() + p.slice(1) : p);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const ROOT = path.join(__dirname, '..');
const DEFAULT_FILE = path.join(ROOT, 'hush.default.json');
const LISTS = ['files', 'patterns', 'allow', 'allowLiterals', 'strictCommands'];

// Tags an error with the file it came from, for the recovery message.
function at(e, file) {
  if (e && typeof e === 'object' && !e.hushFile) e.hushFile = file;
  return e;
}

// The user config's lists and patterns have the right types; else a TypeError.
function validate(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) throw new TypeError('not an object');
  for (const k of LISTS) if (u[k] !== undefined && !Array.isArray(u[k])) throw new TypeError(`${k} is not a list`);
  for (const p of u.patterns || []) if (!p || typeof p.name !== 'string' || typeof p.regex !== 'string') throw new TypeError('a pattern needs a name and a regex');
}

// The default config with the user config ($HUSH_CONFIG or
// ~/.config/hush/config.json) appended. cfg.userFile names the user config;
// entries from index cfg.defaults[k] on in list k come from it.
function loadConfig() {
  let cfg;
  try { cfg = readJson(DEFAULT_FILE); } catch (e) { throw at(e, DEFAULT_FILE); }
  const userFile = home(process.env.HUSH_CONFIG || '~/.config/hush/config.json');
  cfg.userFile = userFile;
  cfg.defaults = Object.fromEntries(LISTS.map((k) => [k, (cfg[k] || []).length]));
  if (fs.existsSync(userFile)) {
    let u;
    try { u = readJson(userFile); validate(u); } catch (e) { throw at(e, userFile); }
    for (const k of LISTS) cfg[k] = (cfg[k] || []).concat(u[k] || []);
    if (u.minLength) cfg.minLength = u.minLength;
    if (typeof u.blockLiterals === 'boolean') cfg.blockLiterals = u.blockLiterals;
  }
  return cfg;
}

// The file that entry i of list k came from.
const sourceOf = (cfg, k, i) => (cfg.userFile && cfg.defaults && i >= cfg.defaults[k] ? cfg.userFile : DEFAULT_FILE);

// Compiles entry i of list k; an invalid regex is tagged with its file.
function regex(cfg, k, i, source, flags) {
  try { return new RegExp(source, flags); } catch (e) { throw at(e, sourceOf(cfg, k, i)); }
}

const quoteArg = (s) => (/^[\w./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const CHECK = `node ${quoteArg(path.join(ROOT, 'scripts', 'check.js'))}`;

// The line shown when an error makes hush withhold output or block a
// command: the error class, the file it came from, and the recovery step.
// Never the error message, which may quote the file.
function failure(what, e) {
  const cls = (e && e.constructor && e.constructor.name) || 'Error';
  const file = e && e.hushFile;
  if (!file) return `[hush] ${what} (${cls}). Run ${CHECK} to find the cause.`;
  if (file === DEFAULT_FILE) return `[hush] ${what} (${cls} in ${file}). The plugin is damaged: reinstall hush, then restart the claude process.`;
  if (e.hushKnown) return `[hush] ${what} (${cls} in ${file}, a file listed in "files"). Make it readable, or remove it from "files" in ${e.hushKnown}, then run ${CHECK}.`;
  return `[hush] ${what} (${cls} in ${file}). Fix or remove ${file}, then run ${CHECK}.`;
}

// Expand ~ and `*` within one path segment.
function expand(pattern) {
  let paths = [''];
  const segs = home(pattern).split('/');
  segs.forEach((seg, i) => {
    const next = [];
    for (const base of paths) {
      if (!seg.includes('*')) { next.push(i ? base + '/' + seg : seg); continue; }
      const re = new RegExp('^' + seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
      let names = [];
      try { names = fs.readdirSync(base || '/'); } catch { /* missing dir */ }
      for (const n of names) if (re.test(n)) next.push(base + '/' + n);
    }
    paths = next;
  });
  return paths;
}

const SECRET_KEY = /key|token|secret|pass|auth|dsn|cred|bearer/i;

function parseDotenv(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, '');
    out.push([m[1], v]);
  }
  return out;
}

function parseJson(node, key = '', out = []) {
  if (typeof node === 'string') {
    if (SECRET_KEY.test(key)) {
      out.push([key, node]);
      const b = /Bearer\s+(\S+)/.exec(node);
      if (b) out.push([key, b[1]]);
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) parseJson(v, k, out);
  }
  return out;
}

// Returns {values: [{name, value}], files: [{path, exists, count}]}.
function loadKnown(cfg) {
  const values = [];
  const files = [];
  for (const f of cfg.files) {
    for (const p of expand(f)) {
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { files.push({ path: p, exists: false, count: 0 }); continue; }
      const isJson = p.endsWith('.json') || text.trimStart().startsWith('{');
      let pairs = isJson ? parseJson(JSON.parse(text)) : parseDotenv(text).filter(([, v]) => v);
      // A file with no NAME=value lines holds bare values: each line, plus the whole text if multi-line.
      if (!isJson && !pairs.length && text.trim()) {
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length > 1) lines.push(text.trim());
        pairs = lines.map((l) => [path.basename(p), l]);
      }
      const good = pairs.filter(([, v]) => v.length >= cfg.minLength);
      files.push({ path: p, exists: true, count: good.length });
      for (const [name, value] of good) values.push({ name, value });
    }
  }
  const seen = new Set();
  return {
    values: values.sort((a, b) => b.value.length - a.value.length).filter((x) => !seen.has(x.value) && seen.add(x.value)),
    files,
  };
}

// sha8 fingerprints of public values: `allow`, plus `allowLiterals`, the
// public literals (such as a local database default) that commands may hold.
const allowSet = (cfg) => new Set([...(cfg.allow || []), ...(cfg.allowLiterals || [])]);

const TOKEN = /\0\d+\0/g;

// Applies fn to the text outside tokens that stand for placeholders made in this run.
const outside = (text, fn) => {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    parts.push(fn(text.slice(last, m.index)), m[0]);
    last = m.index + m[0].length;
  }
  parts.push(fn(text.slice(last)));
  return parts.join('');
};

// Returns {text, counts}; counts maps NAME or pattern name to replacements.
function redact(text, cfg, known, compiled = compile(cfg), index = buildKnown(known, cfg)) {
  const counts = {};
  const made = [];
  text = text.replace(/\0/g, '');
  const ph = (name, v) => {
    made.push(`[hush ${name.replace(/[^A-Za-z0-9_.:-]/g, '_')}${v.length >= cfg.minLength ? ' sha:' + sha8(v) : ''}]`);
    return `\0${made.length - 1}\0`;
  };
  const allow = allowSet(cfg);
  const hit = (name) => (counts[name] = (counts[name] || 0) + 1);
  // A string shorter than minLength cannot hold a known value.
  if (index.re && text.length >= cfg.minLength) {
    text = text.replace(index.re, (m) => {
      const name = index.names.get(m);
      hit(name);
      return ph(name, m);
    });
  }
  for (const { name, re } of compiled) {
    text = outside(text, (seg) => seg.replace(re, (m, ...args) => {
      const g = typeof args[0] === 'string' ? args[0] : null;
      const v = g ?? m;
      if (allow.has(sha8(v))) return m;
      hit(name);
      if (g === null) return ph(name, m);
      const i = m.lastIndexOf(g);
      return m.slice(0, i) + ph(name, g) + m.slice(i + g.length);
    }));
  }
  return { text: text.replace(TOKEN, (t) => made[parseInt(t.slice(1), 10)]), counts };
}

// One alternation for all known values, longest first; allow-listed values are left out.
function buildKnown(known, cfg) {
  const allow = allowSet(cfg);
  const names = new Map();
  for (const { name, value } of known) if (!allow.has(sha8(value)) && !names.has(value)) names.set(value, name);
  if (!names.size) return { re: null, names };
  const alt = [...names.keys()].sort((x, y) => y.length - x.length).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return { re: new RegExp(alt.join('|'), 'g'), names };
}

const compile = (cfg) => cfg.patterns.map((p, i) => ({ name: p.name, re: regex(cfg, 'patterns', i, p.regex, 'g') }));

function log(tool, counts) {
  const file = process.env.HUSH_LOG || path.join(os.homedir(), '.local/state/hush/log.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), tool, counts }) + '\n', { mode: 0o600 });
}

module.exports = { allowSet, buildKnown, loadConfig, loadKnown, redact, compile, expand, log, sha8, failure, regex, at, ROOT, DEFAULT_FILE };
