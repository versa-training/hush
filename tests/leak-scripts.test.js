'use strict';
// Tests for scripts/add-pattern.js, add-known.js, and scrub.js. Temp dirs and random fake values only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig, loadKnown, redact, sha8 } = require('../hooks/hush-lib');

const S = (n) => path.join(__dirname, '..', 'scripts', n);
const alnum = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-leak-'));
let seq = 0;
const dir = () => { const d = path.join(tmp, `d${seq++}`); fs.mkdirSync(d); return d; };
const old = (p) => { const t = new Date(Date.now() - 3600e3); fs.utimesSync(p, t, t); return p; };
function run(script, args, { input = '', env = {} } = {}) {
  const r = spawnSync('node', [S(script), ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('add-pattern: adds a pattern, backs up, writes mode 600, redacts afterwards', () => {
  const d = dir();
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ allow: ['deadbeef'], patterns: [{ name: 'mine', regex: 'zzz[0-9]{20}' }] }));
  const fake = `acme_${alnum(24)}`;
  const line = path.join(d, 'line.txt');
  fs.writeFileSync(line, `x-acme-key: ${fake}\n`);
  const env = { HUSH_CONFIG: cfg };
  const dry = run('add-pattern.js', ['--name', 'acme', '--regex', '\\bacme_[A-Za-z0-9]{20,}', '--test-file', line, '--dry-run'], { env });
  assert.strictEqual(dry.code, 0, dry.out);
  assert.strictEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).patterns.length, 1);
  const r = run('add-pattern.js', ['--name', 'mine', '--regex', '\\bacme_[A-Za-z0-9]{20,}', '--test-file', line], { env });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /added to patterns: mine-2/);
  assert.ok(!r.out.includes(fake));
  const saved = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.deepStrictEqual(saved.allow, ['deadbeef']);
  assert.strictEqual(saved.patterns.length, 2);
  assert.strictEqual(fs.statSync(cfg).mode & 0o777, 0o600);
  assert.strictEqual(fs.readdirSync(d).filter((n) => n.startsWith('config.json.bak-')).length, 1);
  process.env.HUSH_CONFIG = cfg;
  assert.ok(!redact(`key ${fake}`, loadConfig(), []).text.includes(fake));
});

test('add-pattern: creates a missing config', () => {
  const d = dir();
  const cfg = path.join(d, 'sub', 'config.json');
  const line = path.join(d, 'line.txt');
  fs.writeFileSync(line, `acme_${alnum(24)}\n`);
  const r = run('add-pattern.js', ['--name', 'acme', '--regex', 'acme_[a-z0-9]{20,}', '--test-file', line], { env: { HUSH_CONFIG: cfg } });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).patterns[0].name, 'acme');
});

test('add-pattern: refusals leave the config unchanged', () => {
  const d = dir();
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, '{}');
  const line = path.join(d, 'line.txt');
  fs.writeFileSync(line, `acme_${alnum(24)}\n`);
  const env = { HUSH_CONFIG: cfg };
  const cases = {
    'not redacting the test line': ['--regex', 'other_[a-z0-9]{20,}'],
    'invalid regex': ['--regex', 'acme_('],
    'empty match': ['--regex', '(?:acme_[a-z0-9]{20,})?'],
    'catastrophic backtracking': ['--regex', 'acme_(?:[a-z0-9]+)+!'],
  };
  for (const [why, args] of Object.entries(cases)) {
    const r = run('add-pattern.js', ['--name', 'bad', ...args, '--test-file', line], { env });
    assert.strictEqual(r.code, 1, `${why}: ${r.out}`);
    assert.strictEqual(fs.readFileSync(cfg, 'utf8'), '{}', why);
  }
  assert.strictEqual(run('add-pattern.js', ['--name', 'x'], { env }).code, 1);
  fs.writeFileSync(line, 'one\ntwo\n');
  assert.strictEqual(run('add-pattern.js', ['--name', 'bad', '--regex', 'one', '--test-file', line], { env }).code, 1);
});

test('add-pattern: strict command is appended once, refused when it does not match the test line', () => {
  const d = dir();
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ strictCommands: ['old'] }));
  const line = path.join(d, 'line.txt');
  fs.writeFileSync(line, 'mytool dump-config --all\n');
  const env = { HUSH_CONFIG: cfg };
  const re = '\\bmytool\\s+dump-config\\b';
  assert.strictEqual(run('add-pattern.js', ['--strict-command', re, '--test-file', line], { env }).code, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).strictCommands, ['old', re]);
  assert.match(run('add-pattern.js', ['--strict-command', re], { env }).out, /already present/);
  assert.strictEqual(run('add-pattern.js', ['--strict-command', '\\bother\\b', '--test-file', line], { env }).code, 1);
  assert.strictEqual(run('add-pattern.js', ['--strict-command', ''], { env }).code, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).strictCommands.length, 2);
});

test('add-known: registers a value, loader reads it, output holds only the fingerprint', () => {
  const d = dir();
  const known = path.join(d, 'known-values');
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ files: [known] }));
  const env = { HUSH_CONFIG: cfg, HUSH_KNOWN_VALUES: known };
  const tricky = `${alnum(8)}'"=#\\/é ${alnum(8)}`;
  for (const v of [alnum(24), tricky, `'${alnum(16)}'`]) {
    const r = run('add-known.js', [], { input: v + '\n', env });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(r.out.includes(`sha:${sha8(v)}`));
    assert.ok(!r.out.includes(v));
    process.env.HUSH_CONFIG = cfg;
    const c = loadConfig();
    const { values } = loadKnown(c);
    assert.ok(values.some((x) => x.value === v));
    assert.ok(!redact(`out ${v} end`, c, values).text.includes(v));
  }
  assert.strictEqual(fs.statSync(known).mode & 0o777, 0o600);
  assert.strictEqual(fs.readFileSync(known, 'utf8').trim().split('\n').length, 3);
  const again = run('add-known.js', [], { input: tricky, env });
  assert.match(again.out, /already registered/);
  assert.strictEqual(fs.readFileSync(known, 'utf8').trim().split('\n').length, 3);
});

test('add-known: refuses short values, multi-line values, empty stdin, and arguments', () => {
  const d = dir();
  const known = path.join(d, 'known-values');
  const env = { HUSH_CONFIG: path.join(d, 'none.json'), HUSH_KNOWN_VALUES: known };
  assert.strictEqual(run('add-known.js', [], { input: 'short', env }).code, 1);
  assert.strictEqual(run('add-known.js', [], { input: `${alnum(14)}\n${alnum(14)}\n`, env }).code, 1);
  assert.strictEqual(run('add-known.js', [], { input: '', env }).code, 1);
  const arg = alnum(20);
  const r = run('add-known.js', [arg], { input: arg, env });
  assert.strictEqual(r.code, 1);
  assert.ok(!r.out.includes(arg));
  assert.ok(!fs.existsSync(known));
});

function transcript(d, secret) {
  const rec = (s) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: s }] } });
  const f = path.join(d, 's.jsonl');
  fs.writeFileSync(f, [rec(`plain ${secret} end`), rec(`again ${secret}`), rec('nothing here')].join('\n') + '\n', { mode: 0o640 });
  fs.chmodSync(f, 0o640);
  return old(f);
}

test('scrub: dry run reports, apply rewrites atomically and keeps the mode', () => {
  const d = dir();
  const secret = alnum(24);
  const f = transcript(d, secret);
  const env = { HUSH_CONFIG: path.join(d, 'none.json') };
  const before = fs.readFileSync(f, 'utf8');
  const dry = run('scrub.js', ['--path', d], { input: secret + '\n', env });
  assert.strictEqual(dry.code, 0, dry.out);
  assert.match(dry.out, new RegExp(`sha:${sha8(secret)}=2`));
  assert.ok(!dry.out.includes(secret));
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
  const r = run('scrub.js', ['--path', d, '--apply'], { input: secret + '\n', env });
  assert.strictEqual(r.code, 0, r.out);
  const after = fs.readFileSync(f, 'utf8');
  assert.ok(!after.includes(secret));
  assert.strictEqual(after.split(`[hush scrubbed sha:${sha8(secret)}]`).length - 1, 2);
  for (const l of after.trim().split('\n')) JSON.parse(l);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o640);
  assert.deepStrictEqual(fs.readdirSync(d), ['s.jsonl']);
});

test('scrub: JSON-escaped, slash-escaped, ascii-escaped, and nested forms', () => {
  const d = dir();
  const secret = `${alnum(6)}"q\\b/s/é${alnum(6)}`;
  const f = path.join(d, 'e.jsonl');
  const lines = [
    JSON.stringify({ a: secret }),
    JSON.stringify({ a: secret }).replace(/\//g, '\\/'),
    JSON.stringify({ a: secret }).replace('é', '\\u00e9'),
    JSON.stringify({ a: JSON.stringify({ inner: secret }) }),
  ];
  fs.writeFileSync(f, lines.join('\n') + '\n');
  old(f);
  const r = run('scrub.js', ['--path', f, '--apply'], { input: secret, env: { HUSH_CONFIG: path.join(d, 'none.json') } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /sha:\w{8}=4/);
  const after = fs.readFileSync(f, 'utf8');
  assert.ok(!after.includes('q\\\\b') && !after.includes('\\u00e9') && !after.includes('é'));
  for (const l of after.trim().split('\n')) JSON.parse(l);
});

test('scrub: --known uses the known values and does not read stdin', () => {
  const d = dir();
  const secret = alnum(24);
  const known = path.join(d, 'kv');
  fs.writeFileSync(known, `KNOWN_x='${secret}'\n`);
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ files: [known] }));
  const f = transcript(d, secret);
  const r = run('scrub.js', ['--path', f, '--known', '--apply'], { env: { HUSH_CONFIG: cfg } });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!fs.readFileSync(f, 'utf8').includes(secret));
});

test('scrub: skips binary, active, and symlinked files; refuses missing --path, short values, both modes', () => {
  const d = dir();
  const secret = alnum(24);
  const env = { HUSH_CONFIG: path.join(d, 'none.json') };
  const bin = path.join(d, 'b.bin');
  fs.writeFileSync(bin, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(secret)]));
  old(bin);
  const active = path.join(d, 'active.jsonl');
  fs.writeFileSync(active, `x ${secret}\n`);
  const outside = dir();
  const target = path.join(outside, 'o.txt');
  fs.writeFileSync(target, `x ${secret}\n`);
  old(target);
  fs.symlinkSync(target, path.join(d, 'link.txt'));
  const r = run('scrub.js', ['--path', d, '--apply'], { input: secret, env });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /b\.bin: skipped \(binary\)/);
  assert.match(r.out, /active\.jsonl: skipped \(modified in the last 60 s/);
  assert.match(r.out, /link\.txt: skipped \(symlink\)/);
  assert.ok(fs.readFileSync(active, 'utf8').includes(secret));
  assert.ok(fs.readFileSync(target, 'utf8').includes(secret));
  assert.ok(fs.readFileSync(bin).includes(secret));
  const inc = run('scrub.js', ['--path', d, '--apply', '--include-active'], { input: secret, env });
  assert.ok(!fs.readFileSync(active, 'utf8').includes(secret));
  assert.ok(!inc.out.includes(secret));
  assert.ok(fs.readFileSync(target, 'utf8').includes(secret));
  assert.strictEqual(run('scrub.js', [], { input: secret, env }).code, 1);
  assert.strictEqual(run('scrub.js', ['--path', d], { input: 'short\n', env }).code, 1);
  assert.strictEqual(run('scrub.js', ['--path', d, '--apply', '--dry-run'], { input: secret, env }).code, 1);
});

test('scrub: a value split across two records is not found', () => {
  const d = dir();
  const secret = alnum(24);
  const f = path.join(d, 'split.jsonl');
  fs.writeFileSync(f, `${JSON.stringify({ a: secret.slice(0, 12) })}\n${JSON.stringify({ a: secret.slice(12) })}\n`);
  old(f);
  const r = run('scrub.js', ['--path', f, '--apply'], { input: secret, env: { HUSH_CONFIG: path.join(d, 'none.json') } });
  assert.match(r.out, /0 match\(es\) in 0 of 1/);
});
