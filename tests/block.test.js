'use strict';
// PreToolUse block of literal passwords in the model's own commands (part B).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { sha8 } = require('../hooks/hush-lib');

const BLOCK = path.join(__dirname, '../hooks/block.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-block-'));
// A value with letters and digits that no placeholder rule matches.
const fake = () => `k${crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'q')}`;

function hook(command, cfg = {}, tool = 'Bash') {
  const file = path.join(tmp, `cfg-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(file, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  return spawnSync('node', [BLOCK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } }),
    env: { ...process.env, HUSH_CONFIG: file }, encoding: 'utf8',
  });
}

const BLOCKED = [
  ['redis-cli', (v) => `redis-cli -h cache -p 6380 -a ${v} ping`],
  ['redis-cli', (v) => `redis-cli --pass '${v}' info`],
  ['redis-cli', (v) => `ssh host "redis-cli -a '${v}' ping"`],
  ['redis-cli', (v) => `x=$(redis-cli -a ${v} get k); echo "$x"`],
  ['redis-cli', (v) => `docker exec r sh -c 'redis-cli -a "${v}" ping'`],
  ['requirepass', (v) => `redis-server --requirepass ${v}`],
  ['requirepass', (v) => `redis-cli -a "$P" CONFIG SET masterauth "${v}"`],
  ['requirepass', (v) => `cat > redis.conf <<'EOF'\nport 6379\nrequirepass ${v}\nEOF`],
  ['requirepass', (v) => `docker inspect --format '["redis-server", "--requirepass", "${v}"]' r`],
  ['password-flag', (v) => `mysqldump --password=${v} app`],
  ['password-flag', (v) => `wget --http-password "${v}" https://files.internal/x`],
  ['mysql-p', (v) => `mysql -uroot -h db -p${v} app -e 'select 1'`],
  ['mysql-p', (v) => `mysql -uroot -p'${v}' app`],
  ['sshpass', (v) => `sshpass -p '${v}' ssh deploy@host uptime`],
  ['curl-user', (v) => `curl -fsS -u admin:${v} https://api.internal/x`],
  ['curl-user', (v) => `curl --user "admin:${v}" https://api.internal/x`],
  ['authorization', (v) => `curl -s -H "Authorization: Bearer ${v}" https://api.internal/x`],
  ['authorization', (v) => `wget --header='Authorization: Token ${v}' https://api.internal/x`],
  ['authorization', (v) => `curl -H 'authorization: ${v}' https://api.internal/x | jq .`],
  ['env-password', (v) => `PGPASSWORD=${v} psql -h db.internal -U app`],
  ['env-password', (v) => `export PGPASSWORD='${v}'; psql -h db.internal`],
  ['env-password', (v) => `bash -c "MYSQL_PWD=${v} mysql -uroot"`],
  ['env-password', (v) => `REDISCLI_AUTH=${v} redis-cli ping`],
  ['url-password', (v) => `psql "postgres://app:${v}@db.internal:5432/app"`],
  ['url-password', (v) => `git clone https://deploy:${v}@git.internal/repo.git`],
  ['url-password', (v) => `redis-cli -u redis://default:${v}@cache:6379 ping`],
];

test('each shape is blocked with exit 2; the message names the rule and never the value', () => {
  for (const [rule, make] of BLOCKED) {
    const v = fake();
    const cmd = make(v);
    const r = hook(cmd);
    assert.equal(r.status, 2, `${rule}: ${cmd.replace(v, '<v>')}`);
    assert.match(r.stderr, new RegExp(`rule ${rule}\\b`), `${rule}: ${cmd.replace(v, '<v>')} -> ${r.stderr}`);
    assert.ok(!r.stderr.includes(v), 'value repeated');
    assert.equal(r.stdout, '', 'no updatedInput');
    assert.equal(r.stderr.trim().split('\n').length, 2, 'two lines');
  }
});

test('the Monitor tool is checked the same way', () => {
  const v = fake();
  assert.equal(hook(`while :; do redis-cli -a ${v} ping; sleep 5; done`, {}, 'Monitor').status, 2);
});

test('sha8 is shown only for a value of minLength or more', () => {
  const short = fake().slice(0, 8);
  const long = `${fake()}${fake()}`;
  assert.ok(!/sha:/.test(hook(`PGPASSWORD=${short} psql`).stderr));
  assert.match(hook(`PGPASSWORD=${long} psql`).stderr, new RegExp(`sha:${sha8(long)}`));
});

const ALLOWED = [
  'redis-cli -a "$REDIS_PASSWORD" ping',
  'redis-cli -a ${REDIS_PASSWORD} ping',
  'redis-cli -a "$(cat /run/secrets/redis)" ping',
  'redis-cli -a `cat /run/secrets/redis` ping',
  'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping',
  'ssh host \'redis-cli -a "$REDIS_PASSWORD" ping\'',
  'redis-server --requirepass "$REDIS_PASSWORD"',
  'mysql -uroot -p"$DB_PASSWORD" app',
  'mysql -uroot -p app',
  'MYSQL_PWD="$DB_PASSWORD" mysql -uroot',
  'sshpass -e ssh host',
  'SSHPASS="$(cat ~/.ssh/pw)" sshpass -e ssh host',
  'curl -u "admin:$API_PASSWORD" https://api.internal/x',
  'curl -u admin https://api.internal/x',
  'curl --netrc-file ~/.netrc https://api.internal/x',
  'curl -H "Authorization: Bearer $API_TOKEN" https://api.internal/x',
  'curl -H "Authorization: Bearer ${API_TOKEN}" -H @headers.txt https://api.internal/x',
  'PGPASSWORD="$PGPASSWORD" psql -h db.internal',
  'PGPASSFILE=~/.pgpass psql -h db.internal',
  'psql "postgres://app:${DB_PASSWORD}@db.internal/app"',
  'psql --password mydatabase',
  'docker login --password-stdin ghcr.io',
  'ls -a /var/lib/somewhere',
  'docker run -a stdout redis:7-alpine',
  'redis-cli -a <password> ping',
  'redis-cli -a xxxxxx ping',
  "redis-cli -a '******' ping",
  'redis-cli -a changeme ping',
  'redis-cli -a REDIS_PASSWORD ping',
  'PGPASSWORD=password psql',
  'curl -u user:example123 https://api.example.com',
  'PGPASSWORD=[hush pgpassword sha:1a2b3c4d] psql -h localhost',
  'redis-cli -a abc12 ping',
  'echo "Use redis-cli -a <your password> to connect"',
  'grep -rn "requirepass" /etc/redis',
  'git log --pretty=format:%h',
  'grep -n "redis-cli -a" scripts/deploy.sh',
];

test('variables, substitutions, placeholders, short values, and look-alikes are not blocked', () => {
  for (const cmd of ALLOWED) {
    const r = hook(cmd);
    assert.equal(r.status, 0, `${cmd} -> ${r.stderr}`);
  }
});

test('allow lists: the local Postgres default and a value in allow or allowLiterals pass', () => {
  const local = Buffer.from('cG9zdGdyZXM=', 'base64').toString();
  assert.equal(hook(`PGPASSWORD=${local} psql -h 127.0.0.1 -p 54322 -U ${local}`).status, 0);
  assert.equal(hook(`psql postgresql://${local}:${local}@127.0.0.1:54322/${local}`).status, 0);
  const v = fake();
  assert.equal(hook(`redis-cli -a ${v} ping`, { allow: [sha8(v)] }).status, 0);
  assert.equal(hook(`redis-cli -a ${v} ping`, { allowLiterals: [sha8(v)] }).status, 0);
});

test('documentation in a quoted string or heredoc: blocked when the value position holds a literal of 6 or more characters', () => {
  const v = fake();
  assert.equal(hook(`echo 'example: redis-cli -a ${v} ping'`).status, 2);
  assert.equal(hook(`cat <<'EOF'\nConnect with: PGPASSWORD=${v} psql\nEOF`).status, 2);
  assert.equal(hook('cat <<\'EOF\'\nConnect with: PGPASSWORD=<password> psql\nEOF').status, 0);
});

test('blockLiterals false turns the block off', () => {
  assert.equal(hook(`redis-cli -a ${fake()} ping`, { blockLiterals: false }).status, 0);
});

test('fail closed: a malformed config blocks with a message; an unparseable payload passes', () => {
  const r = hook('echo hi', '{ not json');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /check failed \(SyntaxError\)/);
  const p = spawnSync('node', [BLOCK], { input: 'nope', encoding: 'utf8' });
  assert.equal(p.status, 0);
});

test('latency: median of 20 hook calls', () => {
  const t = [];
  for (let i = 0; i < 20; i++) { const t0 = process.hrtime.bigint(); hook('git status && npm test -- --watch=false'); t.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  const med = t.sort((a, b) => a - b)[10];
  console.log(`# block hook median: ${med.toFixed(1)} ms`);
  assert.ok(med < 200);
});

test('linear time: detection on 32,000-character and 1 MB adversarial commands', () => {
  process.env.HUSH_CONFIG = path.join(tmp, 'none.json');
  const { findLiterals } = require('../hooks/literal');
  const { loadConfig, allowSet } = require('../hooks/hush-lib');
  const cfg = loadConfig();
  const allow = allowSet(cfg);
  let worst = 0;
  for (const f of ['curl ', 'curl -u a', 'redis-cli ', 'mysql ', 'a', '"', "'", '$(', '`', '${', 'https://a:', 'PGPASSWORD=', ' -a ', 'Authorization: ', '$($(', '\\', ';']) {
    for (const n of [32000, 1e6]) {
      const s = f.repeat(Math.ceil(n / f.length)).slice(0, n);
      const t0 = performance.now();
      findLiterals(s, cfg, allow);
      worst = Math.max(worst, performance.now() - t0);
    }
  }
  console.log(`# worst detection time: ${worst.toFixed(0)} ms`);
  assert.ok(worst < 1000);
});
