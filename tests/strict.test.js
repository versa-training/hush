'use strict';
// Strict masking for listed commands (part C).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { block } = require('../hooks/session-start');
const { loadConfig } = require('../hooks/hush-lib');
const { Strict, isStrict, commandOf, varied } = require('../hooks/strict');
const F = require('./fixtures');

const hex = (n) => crypto.randomBytes(n).toString('hex');
// Never starts with `-`: a fake value that looks like a flag is not masked as a value.
const b64url = (n) => crypto.randomBytes(n).toString('base64url').replace(/^-/, 'x');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-strict-'));
const cfgFile = path.join(tmp, 'cfg.json');
fs.writeFileSync(cfgFile, '{}');
process.env.HUSH_CONFIG = cfgFile;
const ENV = { ...process.env, HUSH_CONFIG: cfgFile, HUSH_LOG: path.join(tmp, 'log.jsonl') };
const cfg = loadConfig();
const HOOKS = path.join(__dirname, '../hooks');

const mask = (text) => { const s = new Strict(cfg); s.record = []; return { text: s.text(text), count: s.count, masked: s.record }; };

test('strictCommands: the listed commands match, look-alikes do not', () => {
  const yes = ['docker inspect redis', 'docker container inspect x | jq .', 'cd /srv && docker compose -f a.yml config', 'docker-compose config',
    'env', 'env | sort', 'printenv', 'sudo env', 'set', 'export -p', 'declare -x', 'declare -p', 'clever env', 'clever env --add-export',
    'kubectl get secret db -o yaml', 'kubectl -n versa get secrets', 'kubectl describe secret/db', 'systemctl show app -p Environment',
    'systemctl show-environment', 'cat .env', 'cat next/.env.local', 'head -5 /srv/app/.env.production', 'less .env', 'ps auxe', 'ps eww 123',
    'cat /proc/1/environ', 'history', 'history | tail'];
  const no = ['printenv HOME', 'env FOO=bar node x', 'env -i bash', 'export FOO=bar', 'declare -x FOO=bar', 'set -e', 'set -euo pipefail; ls',
    'ps aux', 'ps -ef', 'kubectl get pods', 'systemctl show app', 'cat README.md', 'docker ps', 'docker compose up', 'echo environment',
    'git log --grep env', 'ls .env.d'];
  for (const c of yes) assert.ok(isStrict(c, cfg), `should match: ${c}`);
  for (const c of no) assert.ok(!isStrict(c, cfg), `should not match: ${c}`);
  const own = { ...cfg, strictCommands: [...cfg.strictCommands, '\\bvault\\s+read\\b'] };
  assert.ok(isStrict('vault read secret/x', own) && !isStrict('vault read secret/x', cfg));
});

const sq = (c) => `'${c.replace(/'/g, `'"'"'`)}'`;
const ccString = (command, envScript = ':') => ['source /x/snapshot.sh 2>/dev/null || true', `${envScript}\n:`, 'shopt -u extglob 2>/dev/null || true',
  `eval ${sq(command)}${command.includes('<<') ? '' : ' < /dev/null'}`, 'pwd -P >| /tmp/claude-x-cwd'].join(' && ');

test('commandOf: the command inside the bash -c string, also with quotes, heredocs, and the wrapper text inside it', () => {
  for (const c of ['env', "echo 'a' && eval 'b' && pwd -P >| /x", 'cat <<EOF\nset\nEOF', "printf '%s\\n' \"it's\"", 'docker inspect x && eval ":"']) {
    assert.equal(commandOf(ccString(c, "echo ' && eval ' ")), c);
  }
  assert.equal(commandOf('plain text'), 'plain text');
});

test('(a) NAME=value: plain lines, JSON strings, export, declare -x, and mid-line', () => {
  const v = () => b64url(9);
  const a = v(), b = v(), c = v(), d = v(), e = v();
  const r = mask(`A_NAME=${a}\n  "Env": ["B_NAME=${b}", "PATH=/usr/bin"],\nexport C_NAME=${c}\ndeclare -x D_NAME="${d}"\n1234 node x.js E_NAME=${e} OTHER=1\n`);
  for (const x of [a, b, c, d, e]) assert.ok(!r.text.includes(x));
  assert.match(r.text, /^A_NAME=\[hush strict sha:[0-9a-f]{8}\]$/m);
  assert.match(r.text, /"PATH=\[hush strict\]"/);
  assert.match(r.text, /^declare -x D_NAME="\[hush strict sha:/m);
  assert.match(r.text, /E_NAME=\[hush strict sha:\w+\] OTHER=\[hush strict\]/);
});

test('(b) JSON and YAML values under secret-looking keys, and Kubernetes data blocks', () => {
  const a = b64url(12), b = b64url(12), c = b64url(12), d = b64url(12);
  const r = mask(`{"apiKey": "${a}", "name": "web"}\nsessionCookie: '${b}'\ndata:\n  username: ${c}\n  ca.crt: ${d}\nkind: Secret\n`);
  for (const x of [a, b, c, d]) assert.ok(!r.text.includes(x));
  assert.match(r.text, /"name": "web"/);
  assert.match(r.text, /^kind: Secret$/m);
});

test('(c) argv lists: pretty and compact JSON, CMD-SHELL, YAML lists', () => {
  const a = b64url(9), b = b64url(9), c = b64url(9), d = b64url(9);
  const pretty = JSON.stringify({ Cmd: ['server', '--token', a, '--port=8080', 'run'] }, null, 2);
  const compact = JSON.stringify({ Test: ['CMD-SHELL', `redis-cli -a ${b} ping || exit 1`], X: ['CMD', 'tool', '-p', c] });
  const yaml = `command:\n  - redis-server\n  - --requirepass\n  - ${d}\n  - --appendonly\n`;
  const r = mask(`${pretty}\n${compact}\n${yaml}`);
  for (const x of [a, b, c, d]) assert.ok(!r.text.includes(x), r.text);
  assert.match(r.text, /"server",\n\s+"--token",\n\s+"\[hush strict sha:\w+\]",\n\s+"--port=\[hush strict\]",\n\s+"run"/);
  assert.match(r.text, /redis-cli -a \[hush strict sha:\w+\] ping \|\| exit 1/);
  assert.match(r.text, /- --appendonly/);
});

test('(d) varied words are masked; digests, hex IDs, UUIDs, timestamps, paths, images, and plain URLs are kept', () => {
  const tok = `Ab1${b64url(24)}`;
  assert.ok(varied(tok));
  const keep = [`sha256:${hex(32)}`, hex(32), '6f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b', '2026-11-11T09:14:03.123456789Z', '/var/lib/docker/overlay2/Ab12Cd34Ef56Gh78/merged',
    `ghcr.io/versa-training/app:2026.11.1@sha256:${hex(32)}`, 'https://github.com/versa-training/App2026', 'HostConfig.RestartPolicy.MaximumRetryCount'];
  for (const k of keep) assert.ok(!varied(k), k);
  assert.ok(varied(`https://u:${tok}@host.example/x`));
  const r = mask(`label ${tok} kept ${keep.join(' ')}\n`);
  assert.ok(!r.text.includes(tok));
  assert.match(r.text, /label \[hush strict\] kept/);
  for (const k of keep) assert.ok(r.text.includes(k), k);
});

const FIXTURES = {
  'docker inspect (pretty)': ['docker inspect app', () => { const a = F.appInspect(); return { text: a.json, secrets: a.secrets }; }],
  'docker inspect (compact)': ['docker inspect --format "{{json .}}" app', () => { const a = F.appInspect(); return { text: a.compact, secrets: a.secrets }; }],
  env: ['env', F.envOutput],
  'kubectl get secret -o yaml': ['kubectl get secret db-credentials -o yaml', F.kubeSecret],
  'docker compose config': ['docker compose config', F.composeConfig],
};

function hook(command, stdout) {
  const r = spawnSync('node', [path.join(HOOKS, 'redact.js')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false } }), env: ENV, encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput.stdout : stdout;
}

test('fixtures through redact.js: every fake secret is gone; false-positive counts', () => {
  const fp = [];
  for (const [name, [command, make]] of Object.entries(FIXTURES)) {
    const fx = make();
    const out = hook(command, fx.text);
    for (const s of fx.secrets) assert.ok(!out.includes(s), `${name}: a secret is left`);
    assert.match(out, /\n\[hush\] strict mask: \d+ value\(s\) masked; ask for one value by name if you need it$/);
    const m = mask(fx.text);
    const wrong = m.masked.filter((v) => !fx.secrets.some((s) => v.includes(s))).length;
    fp.push(`${name}: ${m.count} masked, ${wrong} not secret`);
  }
  console.log(`# strict false positives: ${fp.join('; ')}`);
});

test('a command that is not listed: output unchanged by strict rules', () => {
  const fx = F.envOutput();
  const plain = hook('cat saved-env.txt', fx.text);
  assert.ok(!plain.includes('[hush strict'));
  assert.ok(plain.includes('SHELL=/bin/bash') && plain.includes('EDITOR=vim'));
  const p = spawnSync('node', [path.join(HOOKS, 'redact.js')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'A=b\n', stderr: '' } }), env: ENV, encoding: 'utf8' });
  assert.equal(p.stdout, '');
});

// The streaming filter, run the way Claude Code runs a command.
function sh(command) {
  const out = path.join(tmp, `out-${hex(4)}`);
  const full = ccString(command, block(HOOKS).trim()).replace('pwd -P >| /tmp/claude-x-cwd', `pwd -P >| ${tmp}/cwd`);
  const fd = fs.openSync(out, 'w');
  const p = spawnSync('/bin/bash', ['-c', full], { cwd: tmp, stdio: ['ignore', fd, fd], env: ENV, timeout: 60000 });
  fs.closeSync(fd);
  return { status: p.status, text: fs.readFileSync(out, 'utf8') };
}

test('filter: a listed command is masked when it fails and when it succeeds; a non-listed one is not', () => {
  const fx = F.appInspect();
  const file = path.join(tmp, 'inspect.json');
  fs.writeFileSync(file, fx.json);
  const ok = sh(`docker() { cat ${file}; }; docker inspect app`);
  const bad = sh(`docker() { cat ${file}; return 3; }; docker inspect app`);
  for (const r of [ok, bad]) {
    for (const s of fx.secrets) assert.ok(!r.text.includes(s));
    assert.match(r.text, /\[hush\] strict mask: \d+ value\(s\) masked/);
  }
  assert.deepEqual([ok.status, bad.status], [0, 3]);
  const other = sh(`cat ${file}`);
  assert.ok(!other.text.includes('[hush strict') && other.text.includes('"NODE_ENV=production"'));
});

test('filter: monitor mode masks line by line with no notice', async () => {
  const p = spawn('node', [path.join(HOOKS, 'filter.js'), 'nn', 'monitor'], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'], env: ENV });
  let out = '';
  p.stdio[3].on('data', (d) => { out += d; });
  const v = b64url(12);
  p.stdin.write(`\0HUSHCMD:nn\0${ccString('env')}\0`);
  p.stdin.write(`HOME=/root\nDB_PASS=${v}\n`);
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(out, `HOME=[hush strict]\nDB_PASS=[hush strict sha:${require('../hooks/hush-lib').sha8(v)}]\n`);
  p.stdin.end('\0HUSH:nn\0');
  await new Promise((res) => p.on('close', res));
  assert.ok(!out.includes('strict mask'));
});

test('strictCommands: exec env in containers and pods, docker global options, /usr/bin/env and command env, readers of .env files', () => {
  const yes = ['docker exec app env', 'docker exec -it app printenv', 'docker run --rm alpine env', 'podman exec -u 0 app /usr/bin/env',
    'kubectl exec -n versa pod/app -- env', 'kubectl exec app -c web -- printenv', 'docker --context prod inspect app', 'docker -H tcp://h:2375 container inspect x',
    'docker --host=unix:///run/x.sock inspect x', '/usr/bin/env', '/bin/env | sort', 'command env', 'grep TOKEN .env', 'sed -n 1,5p .env.local',
    "awk -F= '{print $1}' .env.production", 'tail -n 3 .env', 'bat .env', 'more .env'];
  const no = ['docker exec app env FOO=1 node x', 'kubectl exec app -- ls', 'docker exec app ls /env', 'docker run --name inspect x', 'command -v env',
    'grep x .env.example', 'cat .env.sample', 'sed -n 1p .env.template', 'grep -rn foo src'];
  for (const c of yes) assert.ok(isStrict(c, cfg), `should match: ${c}`);
  for (const c of no) assert.ok(!isStrict(c, cfg), `should not match: ${c}`);
});

test('strictCommands: every default regex runs in under 1 s on 32,000-character adversarial commands', () => {
  let worst = { ms: 0 };
  for (const f of ['docker -a ', 'docker -a b ', 'docker --x=y ', 'docker exec ', 'kubectl exec -- ', 'kubectl ', 'grep .env ', 'cat x/.env', '/usr/bin/env ', 'command env ', 'docker compose ', 'cat ', ' a']) {
    const s = f.repeat(Math.ceil(32000 / f.length)).slice(0, 32000);
    for (const r of cfg.strictCommands) {
      const t0 = performance.now();
      new RegExp(r, 'm').test(s);
      const ms = performance.now() - t0;
      if (ms > worst.ms) worst = { ms, f, r: r.slice(0, 30) };
    }
  }
  console.log(`# worst strict command time: ${worst.ms.toFixed(0)} ms (${JSON.stringify(worst.f)})`);
  assert.ok(worst.ms < 1000, JSON.stringify(worst));
});

test('strictCommands: sed -i without -n edits a .env file in place and is not strict; sed that prints a .env file is', () => {
  const no = ["sed -i 's/^A=.*/A=1/' .env", "sed -i.bak -e 's/x/y/' next/.env.local", "sed --in-place 's/a/b/' .env", "sed -Ei 's/a/b/' .env",
    "sed -i 's/a/b/' .env && echo rc=$?"];
  const yes = ['sed -n 1p .env', "sed 's/x/y/' .env", 'sed -n -i p .env', 'sed --quiet 1p .env', "sed -En '/KEY/p' .env.local", "sed -i 's/a/b/' x.txt; sed -n 1p .env"];
  for (const c of no) assert.ok(!isStrict(c, cfg), `should not match: ${c}`);
  for (const c of yes) assert.ok(isStrict(c, cfg), `should match: ${c}`);
});

test('a command longer than 64 KB is matched on its first and its last 64 KB, not in the middle', () => {
  assert.ok(isStrict(`env; echo ${'x'.repeat(70000)}`, cfg));
  assert.ok(isStrict(`echo ${'x'.repeat(70000)}; env`, cfg));
  const doc = 'line of a large document, 123 words\n'.repeat(Math.ceil(67584 / 36)).slice(0, 67584);
  assert.ok(isStrict(`cat > /tmp/doc.txt <<'EOF'\n${doc}EOF\ncat .env`, cfg));
  assert.ok(!isStrict(`echo ${'x'.repeat(70000)}; env; echo ${'x'.repeat(70000)}`, cfg));
});
