'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig, loadKnown, redact, sha8 } = require('../hooks/hush-lib');

const hex = (n) => crypto.randomBytes(n).toString('hex');
const b64 = (n) => crypto.randomBytes(n).toString('base64url');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-test-'));
const write = (name, content) => { const p = path.join(tmp, name); fs.writeFileSync(p, content); return p; };

function withConfig(cfg) {
  const p = write(`cfg-${hex(4)}.json`, JSON.stringify(cfg));
  process.env.HUSH_CONFIG = p;
  const c = loadConfig();
  return { cfg: c, known: loadKnown(c).values };
}
const run = (text, cfg = {}) => {
  const { cfg: c, known } = withConfig(cfg);
  return redact(text, c, known);
};

function hook(response, env = {}) {
  const cfg = write(`hcfg-${hex(4)}.json`, '{}');
  const r = spawnSync('node', [path.join(__dirname, '../hooks/redact.js')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_response: response }),
    env: { ...process.env, HUSH_CONFIG: cfg, HUSH_LOG: path.join(tmp, 'log.jsonl'), ...env },
    encoding: 'utf8',
  });
  return { ...r, out: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null };
}

test('known value from dotenv', () => {
  const v = hex(24);
  const f = write('a.env', `# c\nexport MY_TOKEN = "${v}"\nSHORT=abc\nOTHER='${b64(20)}' # x\n`);
  const r = run(`out ${v} end`, { files: [f] });
  assert.equal(r.text, `out [hush MY_TOKEN sha:${sha8(v)}] end`);
  assert.deepEqual(r.counts, { MY_TOKEN: 1 });
});

test('known value from JSON, including Bearer part and short values ignored', () => {
  const v = hex(20);
  const t = hex(20);
  const f = write('b.json', JSON.stringify({ a: { apiKey: v, authorization: `Bearer ${t}`, tokenShort: 'abc', name: hex(20) } }));
  const r = run(`${v} ${t}`, { files: [f] });
  assert.ok(!r.text.includes(v) && !r.text.includes(t));
  assert.match(r.text, /\[hush apiKey sha:/);
});

test('bare-value file is redacted under its basename', () => {
  const v = hex(24);
  const f = write('bare-token', `${v}\n`);
  assert.equal(run(`x ${v}`, { files: [f] }).text, `x [hush bare-token sha:${sha8(v)}]`);
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64(40)}==\n-----END PRIVATE KEY-----`;
  assert.ok(!run(pem, { files: [write('key.pem', pem + '\n')] }).text.includes('BEGIN PRIVATE KEY-----\n'));
});

test('multi-line bare file: each line and the whole text are redacted', () => {
  const a = hex(20), b = hex(20);
  const f = write('bare-list', `${a}\n${b}\n`);
  assert.equal(run(`x ${b}`, { files: [f] }).text, `x [hush bare-list sha:${sha8(b)}]`);
  assert.ok(!run(`${a}\n${b}`, { files: [f] }).text.includes(a));
});

test('fake placeholder wrapping a value does not hide it', () => {
  const v = hex(24);
  const f = write('ph.env', `P_TOKEN=${v}\n`);
  assert.ok(!run(`[hush ${v}]`, { files: [f] }).text.includes(v));
  assert.ok(!run(`\0\0[hush ${v}] \u00000\u0000 ${v}`, { files: [f] }).text.includes(v));
  assert.ok(!run(`[hush X_TOKEN=${v}]`).text.includes(v));
});

test('glob files and missing file skipped', () => {
  const v = hex(20);
  write('g1.env', `A_SECRET=${v}\n`);
  const r = run(v, { files: [path.join(tmp, 'g*.env'), path.join(tmp, 'nope.env')] });
  assert.ok(!r.text.includes(v));
});

const PATTERNS = {
  jwt: [`eyJ${b64(12)}.eyJ${b64(20)}.${b64(20)}`, `eyJ.notajwt`],
  dsn: [`https://${hex(16)}@o1.ingest.example.io/5`, `https://${hex(8)}@example.io/5`],
  pem: [`-----BEGIN PRIVATE KEY-----\n${b64(40)}\n-----END PRIVATE KEY-----`, '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----'],
  github: [`ghp_${b64(30).slice(0, 36).replace(/[-_]/g, 'a')}`, 'ghp_short'],
  anthropic: [`sk-ant-${b64(30)}`, 'sk-ant-x'],
  openai: [`sk-proj-${b64(30)}`, 'sk-short'],
  aws: [`AKIA${hex(8).toUpperCase()}`, 'AKIA1234'],
  google: [`AIza${b64(27).slice(0, 35)}`, 'AIzaShort'],
  slack: [`xoxb-${hex(8)}-${hex(8)}`, 'xoxb-1'],
  stripe: [`sk_live_${hex(12)}`, 'sk_live_abc'],
};

for (const [name, [pos, neg]] of Object.entries(PATTERNS)) {
  test(`pattern ${name}: match and non-match`, () => {
    const r = run(`x ${pos} y`);
    assert.ok(r.counts[name] >= 1, `${name} not matched`);
    assert.ok(!r.text.includes(pos));
    assert.equal(run(`x ${neg} y`).text, `x ${neg} y`);
  });
}

test('bearer token', () => {
  const t = b64(24);
  const r = run(`Authorization: Bearer ${t}`);
  assert.equal(r.text, `Authorization: Bearer [hush bearer sha:${sha8(t)}]`);
});

test('env assignment replaces only the value', () => {
  const v = b64(24);
  assert.equal(run(`DB_PASSWORD=${v}`).text, `DB_PASSWORD=[hush env sha:${sha8(v)}]`);
  assert.equal(run(`"api_key": "${v}"`).text, `"api_key": "[hush env sha:${sha8(v)}]"`);
});

test('url password only', () => {
  const v = b64(12);
  assert.equal(run(`postgres://app:${v}@db:5432/x`).text, `postgres://app:[hush url-password sha:${sha8(v)}]@db:5432/x`);
});

test('negatives: git sha, uuid, prose', () => {
  const s = `commit ${hex(20)} ${crypto.randomUUID()} The password: short. Enter your password: ok\n`;
  assert.equal(run(s).text, s);
});

test('allow list keeps public value', () => {
  const v = hex(20);
  const f = write('al.env', `X_TOKEN=${v}\n`);
  assert.equal(run(`a ${v} b`, { files: [f], allow: [sha8(v)] }).text, `a ${v} b`);
  assert.equal(run(`TOKEN=${v}`, { allow: [sha8(v)] }).text, `TOKEN=${v}`);
});

test('known value and pattern overlap give one placeholder', () => {
  const v = hex(20);
  const f = write('ov.env', `API_TOKEN=${v}\n`);
  const r = run(`API_TOKEN=${v}`, { files: [f] });
  assert.equal(r.text, `API_TOKEN=[hush API_TOKEN sha:${sha8(v)}]`);
  assert.equal(Object.values(r.counts).reduce((a, b) => a + b), 1);
});

test('hook: redacts stdout and stderr, keeps other fields, notes count', () => {
  const v = b64(24);
  const r = hook({ stdout: `X_TOKEN=${v}`, stderr: `err Authorization: Bearer ${v}`, interrupted: false, isImage: false });
  const o = r.out.updatedToolOutput;
  assert.ok(!r.stdout.includes(v));
  assert.match(o.stdout, /\[hush\] redacted 2 secret\(s\)$/);
  assert.match(o.stderr, /\[hush bearer sha:/);
  assert.equal(o.interrupted, false);
  assert.equal(o.isImage, false);
});

test('hook: no output when nothing matches or payload is bad', () => {
  assert.equal(hook({ stdout: 'hello world', stderr: '' }).stdout, '');
  const r = spawnSync('node', [path.join(__dirname, '../hooks/redact.js')], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook: fails closed on a bad regex', () => {
  const bad = write('bad.json', JSON.stringify({ patterns: [{ name: 'x', regex: '(' }] }));
  const r = hook({ stdout: 'secret stuff', stderr: 'e' }, { HUSH_CONFIG: bad });
  assert.equal(r.status, 0);
  assert.equal(r.out.updatedToolOutput.stdout, '[hush] output withheld: redaction failed (SyntaxError)');
  assert.equal(r.out.updatedToolOutput.stderr, '');
});

test('log holds counts, no value', () => {
  const v = b64(24);
  hook({ stdout: `X_TOKEN=${v}`, stderr: '' });
  const log = fs.readFileSync(path.join(tmp, 'log.jsonl'), 'utf8');
  assert.ok(log.includes('"env":1'));
  assert.ok(!log.includes(v) && !log.includes(sha8(v)));
});

test('performance: 100 KB, 250 known values', () => {
  const vals = Array.from({ length: 250 }, () => hex(16));
  const f = write('perf.env', vals.map((v, i) => `K${i}_TOKEN=${v}`).join('\n'));
  const { cfg, known } = withConfig({ files: [f] });
  let text = '';
  while (text.length < 100 * 1024) text += `line ${hex(8)} ${vals[text.length % 250]} some log text here\n`;
  const t0 = performance.now();
  const r = redact(text, cfg, known);
  const ms = performance.now() - t0;
  console.log(`# perf: ${ms.toFixed(1)} ms for ${(text.length / 1024).toFixed(0)} KB`);
  assert.ok(ms < 100, `${ms} ms`);
  assert.ok(!vals.some((v) => r.text.includes(v)));
});
