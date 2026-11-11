'use strict';
// Password-argument patterns, plain and as argv lists (part A).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { loadConfig, redact, compile, buildKnown } = require('../hooks/hush-lib');
const { redisInspect } = require('./fixtures');

const hex = (n) => crypto.randomBytes(n).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-pat-'));
const cfgFile = path.join(tmp, 'cfg.json');
fs.writeFileSync(cfgFile, '{}');
process.env.HUSH_CONFIG = cfgFile;
const ENV = { ...process.env, HUSH_CONFIG: cfgFile, HUSH_LOG: path.join(tmp, 'log.jsonl') };
const cfg = loadConfig();
const compiled = compile(cfg);
const index = buildKnown([], cfg);
const red = (t) => redact(t, cfg, [], compiled, index);

test('each new pattern redacts a fake value and names itself', () => {
  const cases = [
    ['redis-cli-a', (v) => `redis-cli -h cache.internal -p 6380 -a ${v} ping`],
    ['redis-cli-a', (v) => `redis-cli --pass '${v}' info`],
    ['pass-flag', (v) => `tool --password ${v} --verbose`],
    ['pass-flag', (v) => `wget --http-password "${v}" https://x.example/`],
    ['requirepass', (v) => `CONFIG SET requirepass ${v}`],
    ['requirepass', (v) => `masterauth "${v}"`],
    ['pgpassword', (v) => `PGPASSWORD=${v.slice(0, 8)} psql -h db.example`],
    ['mysql-p', (v) => `mysql -u root -h db -p${v} app`],
    ['sshpass', (v) => `sshpass -p '${v}' ssh host`],
    ['curl-user', (v) => `curl -s -u admin:${v} https://api.example/x`],
    ['curl-user', (v) => `curl --user=admin:${v} https://api.example/x`],
    ['basic-auth', (v) => `Authorization: Basic ${Buffer.from(v).toString('base64')}`],
    ['url-password-any', (v) => `amqps://user:${v}@mq.example:5671/vhost`],
    ['url-password-any', (v) => `https://deploy:${v}@git.example/repo.git`],
    ['argv-redis-cli', (v) => `["CMD", "redis-cli", "-h", "localhost", "-a", "${v}", "ping"]`],
    ['argv-pass-flag', (v) => `["tool", "--password", "${v}"]`],
    ['argv-requirepass', (v) => `["redis-server", "--requirepass", "${v}"]`],
    ['argv-mysql-p', (v) => `["mysql", "-uroot", "-p${v}"]`],
    ['argv-sshpass', (v) => `["sshpass", "-p", "${v}", "ssh", "host"]`],
    ['argv-curl-user', (v) => `["curl", "-fsS", "-u", "admin:${v}", "http://x"]`],
  ];
  for (const [name, make] of cases) {
    const v = hex(10);
    const text = make(v);
    const r = red(text);
    const secret = name === 'pgpassword' ? v.slice(0, 8) : name === 'basic-auth' ? Buffer.from(v).toString('base64') : v;
    assert.ok(!r.text.includes(secret), `${name}: ${text.replace(secret, '<v>')} -> ${r.text}`);
    assert.ok(r.counts[name] >= 1, `${name} counted: ${JSON.stringify(r.counts)}`);
  }
});

test('variable references, placeholders, and look-alike flags are left alone', () => {
  const keep = [
    'redis-cli -a "$REDIS_PASSWORD" ping',
    'redis-cli -a ${REDIS_PASSWORD} ping',
    'redis-cli -a "$(cat /run/secrets/redis)" ping',
    'redis-cli -a `cat /run/secrets/redis` ping',
    'PGPASSWORD="$PGPASSWORD" psql',
    'mysql -u root -p app',
    'ls -a /tmp/somewhere-long',
    'docker run -a stdout redis:7-alpine',
    'docker login --password-stdin ghcr.io',
    'curl -u "admin:$API_PASS" https://x',
    'sshpass -e ssh host',
    '["redis-cli", "-a", "$REDIS_PASSWORD", "ping"]',
    '["redis-server", "--requirepass", "${REDIS_PASSWORD}"]',
    'PGPASSWORD=[hush pgpassword sha:12345678] psql',
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping',
    'export API_TOKEN=${OTHER_API_TOKEN}',
    'DATABASE_URL=postgres://app:${DB_PASSWORD}@db:5432/app',
    'DB_PASSWORD="$(cat /run/secrets/db_password)"',
  ];
  for (const t of keep) assert.equal(red(t).text, t, t);
});

test('allowLiterals: the local Postgres default is neither redacted in a URL nor after PGPASSWORD', () => {
  const local = Buffer.from('cG9zdGdyZXM=', 'base64').toString();
  const t = `PGPASSWORD=${local} psql postgres://${local}:${local}@127.0.0.1:54322/${local}`;
  assert.equal(red(t).text, t);
});

const pretty = (v) => JSON.stringify(redisInspect(v), null, 4);
const compact = (v) => JSON.stringify(redisInspect(v));

test('docker inspect of a Redis container (bd-74pdt6): pretty and compact, through redact.js', () => {
  for (const form of [pretty, compact]) {
    const v = hex(16);
    const r = spawnSync('node', [path.join(__dirname, '../hooks/redact.js')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat inspect.json' }, tool_response: { stdout: form(v), stderr: '' } }),
      env: ENV, encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput.stdout;
    assert.ok(!out.includes(v), form.name);
    assert.equal((out.match(/\[hush argv-/g) || []).length, 3, `${form.name}: Args, Cmd, Healthcheck`);
  }
});

function filterRun(lines, gapMs) {
  return new Promise((resolve) => {
    const p = spawn('node', [path.join(__dirname, '../hooks/filter.js'), 'n0nce', 'bash'], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'], env: ENV });
    let out = '';
    p.stdio[3].on('data', (d) => { out += d; });
    let i = 0;
    const next = () => {
      if (i < lines.length) { p.stdin.write(lines[i++]); setTimeout(next, gapMs); return; }
      p.stdin.end('\0HUSH:n0nce\0');
    };
    next();
    p.on('close', () => resolve(out));
  });
}

test('docker inspect of a Redis container: pretty (one write per line, 20 ms apart) and compact, through filter.js', async () => {
  for (const form of [pretty, compact]) {
    const v = hex(16);
    const lines = form(v).split(/(?<=\n)/).map((l, i, a) => (i === a.length - 1 ? `${l}\n` : l));
    const out = await filterRun(lines, form === pretty ? 20 : 0);
    assert.ok(!out.includes(v), form.name);
    assert.match(out, /\[hush\] redacted 3 secret\(s\)\n$/);
  }
});

test('linear time: every pattern on 32,000-character and 3 MB adversarial lines', () => {
  const frags = ['a', 'redis-cli ', ' -a ', '"redis-cli", ', '"-a", ', '--password ', 'requirepass ', 'PGPASSWORD=', 'mysql ', ' -p',
    'sshpass -p ', 'curl ', ' -u a:', 'Authorization: Basic ', 'https://a:', '"curl", ', '"--user", ', '"mysql", ', '"x", ', '\\"', '"'];
  let worst = { ms: 0 };
  for (const { name, re } of compiled) {
    for (const f of frags) {
      for (const n of [32000, 3e6]) {
        const s = f.repeat(Math.ceil(n / f.length)).slice(0, n);
        const t0 = performance.now();
        s.replace(re, '');
        const ms = performance.now() - t0;
        if (ms > worst.ms) worst = { ms, name, f, n };
      }
    }
  }
  console.log(`# worst pattern time: ${worst.ms.toFixed(0)} ms (${worst.name}, ${JSON.stringify(worst.f)} x ${worst.n})`);
  assert.ok(worst.ms < 1500, JSON.stringify(worst));
});

test('url-password-any, requirepass, and pass-flag keep placeholders, documented defaults, and file paths', () => {
  const keep = ['https://user:password@host.example/x', 'amqp://user:pass@mq.example:5672', 'mongodb://admin:<password>@db.example/app',
    'https://user:changeme@host.example', 'tool --password changeme', 'tool --password <password>', 'tool --password /run/secrets/db_password',
    'grep requirepass /etc/redis/redis.conf', 'requirepass foobared', 'masterauth <password>', 'tool --password ./secrets/pw.txt'];
  for (const t of keep) assert.equal(red(t).text, t, t);
  for (const [name, make] of [['url-password-any', (v) => `https://deploy:${v}@git.example/r.git`], ['requirepass', (v) => `requirepass ${v}`], ['pass-flag', (v) => `tool --password ${v}`]]) {
    const v = hex(10);
    const r = red(make(v));
    assert.ok(!r.text.includes(v) && r.counts[name] === 1, name);
  }
});
