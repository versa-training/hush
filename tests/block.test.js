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
    assert.equal(r.stderr.trim().split('\n').filter((l) => !l.includes('Write tool')).length, 2, 'two lines');
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

test('fail closed: a malformed config blocks with a message that names the file and the recovery; an unparseable payload passes', () => {
  const check = `node ${path.join(__dirname, '..', 'scripts', 'check.js')}`;
  for (const [cfg, cls] of [['{ not json', 'SyntaxError'], ['{"files": "x"}', 'TypeError'], ['[1]', 'TypeError']]) {
    const r = hook('echo hi', cfg);
    assert.equal(r.status, 2, cfg);
    const file = /in (\S+)\)/.exec(r.stderr)[1];
    assert.equal(r.stderr, `[hush] blocked: the literal password check failed (${cls} in ${file}). Fix or remove ${file}, then run ${check}. The Edit and Write tools are not blocked by this check.\n`, cfg);
    assert.ok(!/blockLiterals/.test(r.stderr));
  }
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
  for (const f of ['curl ', 'curl -u a', 'redis-cli ', 'mysql ', 'a', '"', "'", '$(', '`', '${', 'https://a:', 'PGPASSWORD=', ' -a ', 'Authorization: ', '$($(', '\\', ';',
    '--password abcdefg ', 'echo "--password abcdefg ', 'git commit -m "redis-cli -a abcdefgh ', 'redis-cli AUTH ', 'http -a ', 'A_TOKEN=abcdefgh ', 'password=', 'psql --password x; ']) {
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

test('more shapes: docker -e and --env, env and inline NAME=, connection strings, redis-cli AUTH, HTTPie -a', () => {
  const shapes = [
    ['env-password', (v) => `docker run -e POSTGRES_PASSWORD=${v} postgres:16`],
    ['env-password', (v) => `docker run --env API_TOKEN=${v} app`],
    ['env-password', (v) => `docker run --env=SESSION_SECRET=${v} app`],
    ['env-password', (v) => `env GITHUB_TOKEN=${v} gh pr list`],
    ['env-password', (v) => `STRIPE_API_KEY=${v} node server.js`],
    ['env-password', (v) => `export SMTP_PASSWD='${v}'`],
    ['env-password', (v) => `OPENAI_APIKEY=${v} python x.py`],
    ['env-password', (v) => `BASIC_AUTH=${v} ./run.sh`],
    ['conn-password', (v) => `psql "host=db.internal user=app password=${v} dbname=app"`],
    ['conn-password', (v) => `sqlcmd -S db "Server=db;Uid=sa;Pwd=${v}"`],
    ['redis-auth', (v) => `redis-cli AUTH ${v}`],
    ['redis-auth', (v) => `redis-cli -h cache AUTH default ${v}`],
    ['redis-auth', (v) => `redis-cli -h cache auth ${v} > /tmp/out`],
    ['httpie-auth', (v) => `http -a admin:${v} https://api.internal/x`],
    ['httpie-auth', (v) => `https --auth=admin:${v} api.internal/x`],
  ];
  for (const [rule, make] of shapes) {
    const v = fake();
    const r = hook(make(v));
    assert.equal(r.status, 2, `${rule}: ${make('<v>')}`);
    assert.match(r.stderr, new RegExp(`rule ${rule}\\b`), `${rule}: ${make('<v>')} -> ${r.stderr}`);
    assert.ok(!r.stderr.includes(v));
  }
  const pass = ['docker run -e POSTGRES_PASSWORD="$PG_PASSWORD" postgres', 'docker run -e API_TOKEN app', 'env GITHUB_TOKEN="$(cat ~/.gh)" gh pr list',
    'GIT_AUTHOR_NAME="Max Mustermann" git commit -m x', 'AUTH_PROVIDER=github ./run', 'TOKEN_FILE=/run/secrets/token ./run', 'API_TOKEN=changeme ./run',
    'psql "host=db user=app password=<password>"', 'redis-cli AUTH "$REDIS_PASSWORD"', 'redis-cli -h cache auth', 'http -a admin https://x', 'http -a "admin:$PW" https://x',
    'curl https://api.internal/x -o out', 'TOKENIZERS_PARALLELISM=false python x.py'];
  for (const c of pass) assert.equal(hook(c).status, 0, `${c} -> ${hook(c).stderr}`);
});

test('prose in a commit, tag, PR, echo, or printf message: an all-lowercase word after a flag passes; a mixed value is still blocked', () => {
  const prose = ['git commit -m "feat: support --password option in cli"', 'git commit -m "docs: redis-cli -a requires quoting"',
    'git commit -am "fix: PGPASSWORD=whatever is read from env"', 'git tag -a v1 -m "redis-cli -a requires quoting"',
    'gh pr create --title "add --password option" --body "redis-cli -a requires quoting"', 'echo "pass it with --password option"',
    'printf "%s\\n" "use requirepass setting"', 'git commit -m "x" -m "docs: sshpass -p handling"'];
  for (const c of prose) assert.equal(hook(c).status, 0, `${c} -> ${hook(c).stderr}`);
  const v = fake();
  for (const c of [`git commit -m "fix: redis-cli -a ${v} ping"`, `echo "use --password ${v}"`, `gh pr create --title "x" --body "PGPASSWORD=${v}"`,
    'redis-cli -a requires', 'echo --password option', 'git commit -m "docs: --password Hunter2xyz"']) {
    assert.equal(hook(c).status, 2, c.replace(v, '<v>'));
  }
});

test('the block message adds the Write tool hint only when the command writes a file', () => {
  const hint = /\[hush\] Example code with a sample credential can be written to a file with the Write tool, or with a placeholder such as changeme\.\n$/;
  const v = fake();
  for (const c of [`cat > example.py <<'EOF'\nr = redis.Redis(password="x")\nPGPASSWORD=${v} psql\nEOF`, `echo "redis-cli -a ${v}" >> notes.md`, `printf 'requirepass ${v}\\n' | tee redis.conf`]) {
    const r = hook(c);
    assert.equal(r.status, 2);
    assert.match(r.stderr, hint, c.replace(v, '<v>'));
    assert.equal(r.stderr.trim().split('\n').length, 3);
  }
  for (const c of [`redis-cli -a ${v} ping`, `redis-cli -a ${v} ping 2>/dev/null`, `redis-cli -a ${v} ping >&2`]) {
    const r = hook(c);
    assert.equal(r.status, 2);
    assert.ok(!/Write tool/.test(r.stderr), c.replace(v, '<v>'));
  }
});

test('not blocked: token counts, all-digit values, and names that end in a setting word; a secret under such a word is still blocked', () => {
  const pass = ['MAX_THINKING_TOKENS=100000 claude', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000 claude -p x', 'export OPENAI_MAX_TOKENS=200000',
    'GITHUB_TOKEN_SCOPES=repo,workflow gh auth status', 'SECRET_ARN=arn:aws:secretsmanager:eu-central-1:123456789012:secret:app-db-AbCdEf node x',
    'PASSWORD_RESET_TEMPLATE=resetPasswordV2 node mail.js', 'JWT_SECRET_ROTATION=monthly node x', 'API_TOKEN_COUNT=fiveThousand node x',
    'AUTH_REQUEST_LIMIT=perMinute60 node x', 'TOKEN_PREFIX=versa_live_ node x', 'JWT_SECRET_ALGORITHM=RS256withPSS node x', 'API_KEY_HEADER=X-Api-Key node x',
    'AUTH_TOKEN_TTL=oneHour3600 node x', 'TOKEN_EXPIRY=twoWeeks14 node x', 'SECRET_NAME=prod/app node x', 'TOKEN_FILE=run/secret.txt node x',
    'AUTH_URL=https://auth.example/x node x', 'API_KEY_ID=keyId2024abc node x', 'TOKENIZERS_PARALLELISM=false node x', 'PASSWORD_MIN_LENGTH=12 node x',
    'AUTHOR=someone node x', 'SECRET_DIR=secretsDir2 node x', 'AUTH_TYPE=oauthBearer2 node x', 'AUTH_MODE=strictMode1 node x', 'TOKEN_ENABLED=enabled1 node x',
    'PASSWORD_PATH=pwdPath2 node x', 'redis-cli -a 12345678 ping', 'PGPASSWORD=20240101 psql'];
  for (const c of pass) { const r = hook(c); assert.equal(r.status, 0, `${c} -> ${r.stderr}`); }
  for (const make of [(v) => `GITHUB_TOKEN=${v} gh api x`, (v) => `API_SECRET_KEY=${v} node x`, (v) => `DB_PASSWORD=${v} node x`, (v) => `TOKEN_SCOPES_X=1 SLACK_TOKEN=${v} node x`]) {
    const v = fake();
    const r = hook(make(v));
    assert.equal(r.status, 2, make('<v>'));
    assert.ok(!r.stderr.includes(v));
  }
});

test('a command longer than 64 KB is checked on its first 64 KB', () => {
  const v = fake();
  assert.equal(hook(`redis-cli -a ${v} ping # ${'x'.repeat(70000)}`).status, 2);
  assert.equal(hook(`echo ${'x'.repeat(70000)}; redis-cli -a ${v} ping`).status, 0);
});
