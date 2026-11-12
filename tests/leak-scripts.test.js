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

test('respond-to-leak skill: every command names the plugin root through ${CLAUDE_PLUGIN_ROOT} and an existing script', () => {
  const body = fs.readFileSync(path.join(__dirname, '../skills/respond-to-leak/SKILL.md'), 'utf8');
  assert.ok(!body.includes('$HUSH'));
  const refs = [...body.matchAll(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([\w-]+\.js)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5);
  for (const r of refs) assert.ok(fs.existsSync(S(r)), r);
  assert.equal((body.match(/scripts\//g) || []).length - 1, refs.length, 'every script command uses the quoted root');
});

const CORPUS = path.join(__dirname, '..', 'scripts', 'data', 'harmless-output.txt');
const COMMANDS = path.join(__dirname, '..', 'scripts', 'data', 'harmless-commands.txt');

test('harmless fixtures: at least 150 corpus lines, no default pattern or strict command matches them', () => {
  const text = fs.readFileSync(CORPUS, 'utf8');
  assert.ok(text.trim().split('\n').length >= 150);
  process.env.HUSH_CONFIG = path.join(dir(), 'none.json');
  const cfg = loadConfig();
  assert.deepStrictEqual(redact(text, cfg, []).counts, {});
  const cmds = fs.readFileSync(COMMANDS, 'utf8').trim().split('\n');
  assert.ok(cmds.length >= 36);
  for (const c of cmds) for (const s of cfg.strictCommands) assert.ok(!new RegExp(s, 'm').test(c), c);
});

test('add-pattern: refuses patterns and strict commands that match harmless output, by line number only', () => {
  const d = dir();
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, '{}');
  const line = path.join(d, 'line.txt');
  fs.writeFileSync(line, `acme_${alnum(24)}\n`);
  const env = { HUSH_CONFIG: cfg };
  const corpus = fs.readFileSync(CORPUS, 'utf8').split('\n');
  for (const re of ['[^\\n]+', '.{8,}', '\\S+', 'e', '[\\s\\S]{3}']) {
    const r = run('add-pattern.js', ['--name', 'bad', '--regex', re, '--test-file', line], { env });
    assert.strictEqual(r.code, 1, `${re}: ${r.out}`);
    const n = /matches line (\d+) of the harmless sample output/.exec(r.out);
    assert.ok(n, `${re}: ${r.out}`);
    const text = corpus[n[1] - 1];
    assert.ok(text.length < 4 || !r.out.includes(text), re);
  }
  fs.writeFileSync(line, 'mytool dump-config\n');
  const s = run('add-pattern.js', ['--strict-command', '.', '--test-file', line], { env });
  assert.strictEqual(s.code, 1, s.out);
  assert.match(s.out, /matches the harmless command on line \d+/);
  assert.strictEqual(run('add-pattern.js', ['--strict-command', '\\bls\\b'], { env }).code, 1);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), '{}');
});

test('add-pattern: refuses a pattern that replaces a whole multi-word test line unless a group limits it', () => {
  const d = dir();
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, '{}');
  const line = path.join(d, 'line.txt');
  fs.writeFileSync(line, `acmekey: ${alnum(24)}\n`);
  const env = { HUSH_CONFIG: cfg };
  const whole = run('add-pattern.js', ['--name', 'k', '--regex', 'acmekey: [a-f0-9]{24}', '--test-file', line], { env });
  assert.strictEqual(whole.code, 1, whole.out);
  assert.match(whole.out, /replaces the whole test line/);
  const group = run('add-pattern.js', ['--name', 'k', '--regex', 'acmekey: ([a-f0-9]{24})', '--test-file', line], { env });
  assert.strictEqual(group.code, 0, group.out);
  fs.writeFileSync(line, `acme_${alnum(24)}\n`);
  const one = run('add-pattern.js', ['--name', 'one', '--regex', 'acme_[a-f0-9]{24}', '--test-file', line], { env });
  assert.strictEqual(one.code, 0, one.out);
});

test('add-pattern: refuses nested and overlapping repeats, and slow patterns; accepts safe controls', () => {
  const d = dir();
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, '{}');
  const env = { HUSH_CONFIG: cfg };
  const line = path.join(d, 'line.txt');
  fs.writeFileSync(line, `xxxy acme_${alnum(24)}\n`);
  const bad = { '(x+x+)+y': /variable repeat/, '(\\d+)+z': /variable repeat/, '(a|aa)+$': /alternatives/, '([0-9a-f]+)+!': /variable repeat/,
    '(?:acme_|acme)+[0-9a-f]{20}': /alternatives/, 'acme_\\d+\\d+\\d+z': /took/, 'zq[a-z]+[a-z]+[a-z]+@': /took/ };
  for (const [re, why] of Object.entries(bad)) {
    const t = Date.now();
    const r = run('add-pattern.js', ['--name', 'bad', '--regex', re, '--test-file', line, '--dry-run'], { env });
    assert.strictEqual(r.code, 1, `${re}: ${r.out}`);
    assert.match(r.out, why, re);
    assert.ok(Date.now() - t < 30000, re);
  }
  const fake = alnum(20);
  const good = { 'acme_[a-z0-9]{20,}': `acme_${fake}`, 'acme_(?:live|test)_[a-f0-9]{20}': `acme_live_${fake}`,
    '\\bAC(?:[0-9A-F]{4}-){3}[0-9A-F]{12}\\b': `AC${alnum(4)}-${alnum(4)}-${alnum(4)}-${alnum(12)}`.toUpperCase(),
    'acme-(?:[a-z]|[0-9])+_[a-f0-9]{8}': `acme-x1_${alnum(8)}` };
  for (const [re, l] of Object.entries(good)) {
    fs.writeFileSync(line, l + '\n');
    const r = run('add-pattern.js', ['--name', 'good', '--regex', re, '--test-file', line, '--dry-run'], { env });
    assert.strictEqual(r.code, 0, `${re}: ${r.out}`);
  }
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), '{}');
});

test('add-pattern: the same regex again is "already present" and changes nothing', () => {
  const d = dir();
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, '{}');
  const env = { HUSH_CONFIG: cfg };
  const line = path.join(d, 'line.txt');
  fs.writeFileSync(line, `acme_${alnum(24)}\n`);
  const args = ['--name', 'tk', '--regex', 'acme_[a-f0-9]{24}', '--test-file', line];
  assert.strictEqual(run('add-pattern.js', args, { env }).code, 0);
  const saved = fs.readFileSync(cfg, 'utf8');
  for (let i = 0; i < 2; i++) {
    const r = run('add-pattern.js', args, { env });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /already present: patterns \(tk\)/);
  }
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), saved);
  const dflt = run('add-pattern.js', ['--name', 'x', '--regex', '\\bAKIA[0-9A-Z]{16}\\b', '--test-file', line], { env });
  assert.match(dflt.out, /already present: patterns \(aws\)/);
});

test('add-pattern end to end: the new pattern redacts a fake line through hush-lib, the harmless corpus is untouched', () => {
  const d = dir();
  const cfg = path.join(d, 'config.json');
  const line = path.join(d, 'line.txt');
  const fake = alnum(28);
  fs.writeFileSync(line, `zorg-api-key ${fake}\n`);
  const r = run('add-pattern.js', ['--name', 'zorg', '--regex', '\\bzorg-api-key\\s+([a-f0-9]{24,64})', '--test-file', line], { env: { HUSH_CONFIG: cfg } });
  assert.strictEqual(r.code, 0, r.out);
  process.env.HUSH_CONFIG = cfg;
  const c = loadConfig();
  const out = redact(`curl said: zorg-api-key ${fake} ok`, c, []);
  assert.ok(!out.text.includes(fake));
  assert.strictEqual(out.counts.zorg, 1);
  const text = fs.readFileSync(CORPUS, 'utf8');
  assert.strictEqual(redact(text, c, []).text, text);
});

const scrubEnv = (d) => ({ HUSH_CONFIG: path.join(d, 'none.json') });
const parsesAll = (text) => text.split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } });

test('scrub: replaces inside decoded JSON strings, so every line still parses', () => {
  const d = dir();
  const hex = alnum(24);
  const v = {
    nstart: `n${hex}`,
    quote: `q"${alnum(16)}`,
    bslash: `${alnum(10)}\\${alnum(10)}`,
    bend: `${alnum(16)}\\`,
    slash: `${alnum(10)}/${alnum(10)}`,
    uni: `ü${alnum(12)}€😀`,
  };
  const recs = [
    { content: `line1\n${hex} harmless after newline` },
    { content: `real ${v.nstart} here` },
    { content: `a ${v.quote} b ${v.bslash} c` },
    { content: `${v.bend}"` },
    { content: `say ${v.bend}n more` },
    { url: `https://x/${v.slash}/y` },
    { u: `u ${v.uni} u` },
    { nested: JSON.stringify({ inner: JSON.stringify({ deep: `x ${v.quote} ${v.bslash}` }) }) },
    { [v.slash]: 'key holds the value' },
    { log: `${JSON.stringify({ a: v.quote })}\n${JSON.stringify({ b: v.nstart })}` },
  ];
  const f = path.join(d, 's.jsonl');
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.appendFileSync(f, JSON.stringify({ a: v.uni }).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
  fs.appendFileSync(f, `not json: ${v.nstart}\n`);
  old(f);
  const r = run('scrub.js', ['--path', f, '--apply'], { input: Object.values(v).join('\n') + '\n', env: scrubEnv(d) });
  assert.strictEqual(r.code, 0, r.out);
  for (const x of Object.values(v)) assert.ok(!r.out.includes(x));
  const after = fs.readFileSync(f, 'utf8');
  const lines = after.trim().split('\n');
  assert.ok(lines.slice(0, -1).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  const deep = (o) => JSON.stringify(o);
  const decoded = lines.slice(0, -1).map((l) => JSON.parse(l));
  assert.ok(decoded[0].content.includes(`\n${hex} harmless`), 'text after an encoded newline is kept');
  const flat = (x) => (typeof x === 'string' ? (() => { try { return x + flat(JSON.parse(x)); } catch { return x; } })()
    : x && typeof x === 'object' ? Object.entries(x).map(([k, y]) => k + flat(y)).join(' ') : String(x));
  const all = decoded.map(flat).join('\n') + lines[lines.length - 1];
  for (const [k, x] of Object.entries(v)) assert.ok(!all.includes(x), `${k} left`);
  for (const l of decoded[9].log.split('\n')) JSON.parse(l);
  JSON.parse(JSON.parse(decoded[7].nested).inner);
  assert.ok(deep(decoded[8]).includes('[hush scrubbed sha:'));
  assert.ok(lines[lines.length - 1].startsWith('not json: [hush scrubbed sha:'));
});

test('scrub: a value in a JSON number, and a pretty-printed .json document', () => {
  const d = dir();
  const num = String(10 ** 15 + crypto.randomInt(10 ** 9));
  const word = alnum(20);
  const f = path.join(d, 'c.json');
  fs.writeFileSync(f, JSON.stringify({ id: Number(num), list: [`a ${word}`, { [word]: 1 }], n: 1.5e3 }, null, 2) + '\n');
  old(f);
  const r = run('scrub.js', ['--path', f, '--apply'], { input: `${num}\n${word}\n`, env: scrubEnv(d) });
  assert.strictEqual(r.code, 0, r.out);
  const text = fs.readFileSync(f, 'utf8');
  const o = JSON.parse(text);
  assert.ok(!text.includes(num) && !text.includes(word));
  assert.match(o.id, /^\[hush scrubbed sha:/);
  assert.strictEqual(o.n, 1500);
  assert.ok(text.includes('"n": 1500'), 'untouched parts keep their formatting');
});

test('scrub: missing paths are skipped with a note, the summary prints, other paths are scrubbed', () => {
  const d = dir();
  const secret = alnum(24);
  const f = transcript(d, secret);
  const env = scrubEnv(d);
  const r = run('scrub.js', ['--path', path.join(d, 'subagents'), '--path', f, '--path', path.join(d, 'tool-results'), '--apply'], { input: secret, env });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /subagents: skipped \(does not exist\)/);
  assert.match(r.out, /tool-results: skipped \(does not exist\)/);
  assert.match(r.out, /applied: 2 match\(es\) in 1 of 1 file\(s\).*2 path\(s\) do not exist/);
  assert.ok(!fs.readFileSync(f, 'utf8').includes(secret));
  const none = run('scrub.js', ['--path', path.join(d, 'nope')], { input: secret, env });
  assert.strictEqual(none.code, 1);
  assert.match(none.out, /dry run: 0 match\(es\) in 0 of 0 file\(s\)/);
});

test('scrub: --known names the known value next to its fingerprint', () => {
  const d = dir();
  const secret = alnum(24);
  const known = path.join(d, 'kv');
  fs.writeFileSync(known, `ACME_API_KEY='${secret}'\nOTHER_KEY='${alnum(24)}'\n`);
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ files: [known] }));
  const f = transcript(d, secret);
  const r = run('scrub.js', ['--path', f, '--known'], { env: { HUSH_CONFIG: cfg } });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(`sha:${sha8(secret)}=2 (ACME_API_KEY)`), r.out);
  assert.ok(!r.out.includes('OTHER_KEY') && !r.out.includes(secret));
});

test('scrub: a line longer than 50 MB skips the file with a note and leaves it unchanged', () => {
  const d = dir();
  const secret = alnum(24);
  const f = path.join(d, 'big.jsonl');
  fs.writeFileSync(f, `${JSON.stringify({ a: secret })}\n`);
  fs.appendFileSync(f, `{"b":"${'x'.repeat(50 * 1024 * 1024 + 10)}"}\n`);
  old(f);
  const before = fs.statSync(f).size;
  const r = run('scrub.js', ['--path', f, '--apply'], { input: secret, env: scrubEnv(d) });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /big\.jsonl: skipped \(a line is longer than 50 MB; not scrubbed\)/);
  assert.match(r.out, /1 file\(s\) skipped/);
  assert.strictEqual(fs.statSync(f).size, before);
  assert.deepStrictEqual(fs.readdirSync(d), ['big.jsonl']);
});

test('respond-to-leak skill: the self-test command passes the literal block', () => {
  const body = fs.readFileSync(path.join(__dirname, '../skills/respond-to-leak/SKILL.md'), 'utf8');
  const m = /`(node -e '[^`]*HUSH_TEST_[^`]*')`/.exec(body);
  assert.ok(m, 'the skill names an exact self-test command');
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: m[1] } });
  const env = { ...process.env, HUSH_CONFIG: path.join(dir(), 'none.json') };
  const b = spawnSync('node', [path.join(__dirname, '../hooks/block.js')], { input: payload, encoding: 'utf8', env });
  assert.strictEqual(b.status, 0, b.stderr);
  const out = spawnSync('bash', ['-c', m[1]], { encoding: 'utf8' }).stdout;
  assert.match(out, /^HUSH_TEST_TOKEN=[0-9a-f]{24}\n$/);
  process.env.HUSH_CONFIG = env.HUSH_CONFIG;
  assert.ok(redact(out, loadConfig(), []).text.includes('[hush'));
});
