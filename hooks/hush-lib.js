'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sha8 = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 8);
const home = (p) => (p === '~' || p.startsWith('~/') ? os.homedir() + p.slice(1) : p);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function loadConfig() {
  const cfg = readJson(path.join(__dirname, '..', 'hush.default.json'));
  const userFile = home(process.env.HUSH_CONFIG || '~/.config/hush/config.json');
  if (fs.existsSync(userFile)) {
    const u = readJson(userFile);
    for (const k of ['files', 'patterns', 'allow']) cfg[k] = cfg[k].concat(u[k] || []);
    if (u.minLength) cfg.minLength = u.minLength;
  }
  return cfg;
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
function redact(text, cfg, known, compiled = compile(cfg)) {
  const counts = {};
  const made = [];
  text = text.replace(/\0/g, '');
  const allow = new Set(cfg.allow);
  const ph = (name, v) => {
    made.push(`[hush ${name.replace(/[^A-Za-z0-9_.:-]/g, '_')}${v.length >= cfg.minLength ? ' sha:' + sha8(v) : ''}]`);
    return `\0${made.length - 1}\0`;
  };
  const hit = (name) => (counts[name] = (counts[name] || 0) + 1);
  for (const { name, value } of known) {
    if (allow.has(sha8(value))) continue;
    text = outside(text, (seg) => {
      const parts = seg.split(value);
      if (parts.length < 2) return seg;
      for (let i = 1; i < parts.length; i++) hit(name);
      return parts.join(ph(name, value));
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

const compile = (cfg) => cfg.patterns.map((p) => ({ name: p.name, re: new RegExp(p.regex, 'g') }));

function log(tool, counts) {
  const file = process.env.HUSH_LOG || path.join(os.homedir(), '.local/state/hush/log.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), tool, counts }) + '\n', { mode: 0o600 });
}

module.exports = { loadConfig, loadKnown, redact, compile, expand, log, sha8 };
