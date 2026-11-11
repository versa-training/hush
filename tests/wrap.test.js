'use strict';
// Tests for hooks/session-start.js, hooks/wrap.sh, and hooks/filter.js. Each
// command runs the way Claude Code 2.1.310 runs a Bash call: one `bash -c`
// string that sources the shell snapshot, then the session environment script
// (the env files of SessionStart hooks, joined by newlines), then `eval` of the
// command and `pwd -P >| <cwd file>`, with stdout and stderr on one file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const { block, install } = require('../hooks/session-start');
const { sha8 } = require('../hooks/hush-lib');

const hex = (n) => crypto.randomBytes(n).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-wrap-'));
const cfgFile = path.join(tmp, 'cfg.json');
fs.writeFileSync(cfgFile, '{}');
const ENV = { ...process.env, HUSH_CONFIG: cfgFile, HUSH_LOG: path.join(tmp, 'log.jsonl') };
const FILTER = path.join(__dirname, '../hooks/filter.js');
const START = path.join(__dirname, '../hooks/session-start.js');
const HOOKS = path.join(__dirname, '../hooks');
const sq = (c) => `'${c.replace(/'/g, `'"'"'`)}'`;

// The command string Claude Code builds. envScript null: no env file, as without hush.
function ccCommand(command, envScript, cwdFile) {
  const parts = ['source /nonexistent/snapshot.sh 2>/dev/null || true'];
  if (envScript) parts.push(`${envScript.trim()}\n:`);
  parts.push('shopt -u extglob 2>/dev/null || true');
  parts.push("{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true");
  parts.push(`eval ${sq(command)}${command.includes('<<') ? '' : ' < /dev/null'}`);
  parts.push(`pwd -P >| ${cwdFile}`);
  return parts.join(' && ');
}

let n = 0;
function runner(command, { wrapped = true, env = {}, envScript } = {}) {
  const dir = path.join(tmp, `r${n++}`);
  fs.mkdirSync(dir);
  const script = envScript !== undefined ? envScript : wrapped ? block(HOOKS) : null;
  const full = ccCommand(command, script, `${dir}/cwd`);
  return { dir, full, env: { ...ENV, ...env }, out: path.join(dir, 'out') };
}
function sh(command, opts = {}) {
  const r = runner(command, opts);
  const fd = fs.openSync(r.out, 'w');
  const p = spawnSync('/bin/bash', ['-c', r.full], { cwd: tmp, stdio: ['ignore', fd, fd], env: r.env, timeout: 60000 });
  fs.closeSync(fd);
  const cwdFile = path.join(r.dir, 'cwd');
  return { status: p.status, signal: p.signal, out: fs.readFileSync(r.out), cwd: fs.existsSync(cwdFile) ? fs.readFileSync(cwdFile, 'utf8').trim() : null };
}
const text = (r) => r.out.toString('utf8');
const unavailable = (hooks) => `[hush] output withheld: wrapper unavailable: ${hooks}/wrap.sh did not start the output filter. If hush was updated, moved, or removed, restart the claude process. Else check that node 22 or newer is on PATH and run node ${path.dirname(hooks)}/scripts/check.js`;

// Same exit status, same cwd, same bytes with and without the filter, except
// line numbers: any env script in front of the command shifts them (tested below).
const outerLines = (b) => b.toString('latin1').replace(/(line )(\d+)/g, '$1N');
function same(command) {
  const a = sh(command, { wrapped: false });
  const b = sh(command);
  assert.equal(b.status, a.status, `status for ${JSON.stringify(command)}`);
  assert.equal(b.signal, a.signal);
  assert.equal(b.cwd, a.cwd);
  assert.equal(outerLines(b.out), outerLines(a.out), `output for ${JSON.stringify(command)}`);
  return b;
}

test('session-start.js: appends the block once, keeps what other hooks wrote', () => {
  const f = path.join(tmp, 'env-a.sh');
  fs.writeFileSync(f, 'export OTHER_PLUGIN=1');
  assert.equal(install(f, HOOKS), true);
  assert.equal(install(f, HOOKS), false);
  assert.equal(fs.readFileSync(f, 'utf8'), `export OTHER_PLUGIN=1\n${block(HOOKS)}`);
  fs.appendFileSync(f, 'export LATER=2\n');
  assert.equal(install(f, HOOKS), false);
  const g = path.join(tmp, 'env-b.sh');
  assert.equal(install(g, HOOKS), true);
  assert.equal(fs.readFileSync(g, 'utf8'), block(HOOKS));
});

test('session-start.js: a hush line with another plugin path (older version, resumed session) is replaced, other lines kept', () => {
  const f = path.join(tmp, 'env-stale.sh');
  const stale = block(path.join(tmp, 'gone-0.1.0'));
  fs.writeFileSync(f, `export A=1\n${stale}export B=2`);
  assert.equal(install(f, HOOKS), true);
  assert.equal(fs.readFileSync(f, 'utf8'), `export A=1\nexport B=2\n${block(HOOKS)}`);
  assert.equal(install(f, HOOKS), false);
  const r = sh('echo "$A$B ok"', { envScript: fs.readFileSync(f, 'utf8') });
  assert.deepEqual([r.status, text(r)], [0, '12 ok\n']);
});

test('session-start.js as a hook: writes CLAUDE_ENV_FILE for every source; warns when it is unset', () => {
  const f = path.join(tmp, 'env-hook.sh');
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const r = spawnSync('node', [START], { input: JSON.stringify({ hook_event_name: 'SessionStart', source }), env: { ...ENV, CLAUDE_ENV_FILE: f }, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stdout], [0, '']);
  }
  assert.equal(fs.readFileSync(f, 'utf8'), block(path.join(__dirname, '../hooks')));
  const env = { ...ENV };
  delete env.CLAUDE_ENV_FILE;
  const u = spawnSync('node', [START], { input: '{}', env, encoding: 'utf8' });
  assert.equal(u.status, 0);
  assert.match(JSON.parse(u.stdout).systemMessage, /CLAUDE_ENV_FILE is not set/);
  const bad = spawnSync('node', [START], { input: '{}', env: { ...ENV, CLAUDE_ENV_FILE: path.join(tmp, 'no-such-dir', 'f.sh') }, encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.match(JSON.parse(bad.stdout).systemMessage, /output filter not set up \(Error\)/);
});

test('session-start.js: plugin path with a quote and a space is quoted', () => {
  const dir = path.join(tmp, "it's a dir");
  fs.mkdirSync(dir);
  for (const f of ['wrap.sh', 'filter.js', 'hush-lib.js', 'strict.js']) fs.copyFileSync(path.join(HOOKS, f), path.join(dir, f));
  fs.copyFileSync(path.join(__dirname, '../hush.default.json'), path.join(tmp, 'hush.default.json'));
  const v = hex(24);
  const r = sh(`echo X_TOKEN=${v}`, { envScript: block(dir) });
  assert.equal(r.status, 0);
  assert.ok(text(r).startsWith('X_TOKEN=[hush env sha:'));
});

test('the block twice (two SessionStart events, two copies of hush) starts one filter', () => {
  const v = hex(24);
  const r = sh(`echo X_TOKEN=${v}; echo "filters: $(pgrep -c -f "hooks/filter.js [0-9a-f]{16} " )"`, { envScript: block(HOOKS) + block(HOOKS) });
  assert.equal(r.status, 0);
  assert.equal(text(r).match(/\[hush\] redacted/g).length, 1);
  assert.ok(!text(r).includes(v));
});

test('another hook writes to the env script before and after the block: both effects hold', () => {
  const v = hex(24);
  const r = sh(`echo "$BEFORE_HUSH $AFTER_HUSH X_TOKEN=${v}"; exit 3`, { envScript: `export BEFORE_HUSH=b1\n${block(HOOKS)}export AFTER_HUSH=a2\n` });
  assert.equal(r.status, 3);
  assert.equal(text(r), `b1 a2 X_TOKEN=[hush env sha:${sha8(v)}]\n[hush] redacted 1 secret(s)\n`);
});

test('exit codes are preserved: 0, 1, 2, 127, exit 42, and a signal', () => {
  for (const c of ['true', 'false', 'exit 2', 'no_such_command_hush', 'echo a; exit 42', '(exit 7)']) same(c);
  const k = same('kill -TERM $$');
  assert.equal(k.signal, 'SIGTERM');
});

test('a failing command that prints a fake secret on stdout or stderr is redacted, status kept', () => {
  const v = hex(24);
  for (const c of [`echo X_TOKEN=${v}; exit 3`, `echo X_TOKEN=${v} >&2; exit 4`]) {
    const r = sh(c);
    assert.equal(r.status, Number(c.slice(-1)));
    assert.ok(!text(r).includes(v));
    assert.ok(text(r).includes(`X_TOKEN=[hush env sha:${sha8(v)}]`));
    assert.match(text(r), /\[hush\] redacted 1 secret\(s\)\n$/);
  }
});

test('cd persists: the cwd after the command is the one the command left', () => {
  const d = fs.mkdtempSync(path.join(tmp, 'cd-'));
  assert.equal(same(`cd ${d}`).cwd, fs.realpathSync(d));
  assert.equal(same(`cd ${d} && cd .. && pwd`).cwd, fs.realpathSync(tmp));
});

const TRICKY = [
  "cat <<'EOF'\n$HOME `x` \"q\" 'q'\n\tTAB\nEOF",
  'cat <<EOF\nvalue $((1+2))\nEOF\necho after',
  'cat <<-EOF\n\tindented\n\tEOF',
  'echo a\necho b\n\necho c',
  'echo one # a comment',
  'echo two # comment with \' and "',
  'echo x; exit 5',
  'echo bg & wait',
  'sleep 0.2 & echo started',
  'set -e; false; echo not printed',
  'set -euo pipefail; echo ok; false | true',
  'set -u; echo "${UNSET_VAR_HUSH:-default}"',
  `echo 'single "double" $not' "double 'single' $((2*3))" $'ansi\\tc' \\$escaped`,
  'echo "multi\nline\nstring"',
  'printf "%s\\n" a\\\nb',
  'f() { echo "fn $1"; }; f arg',
  'for i in 1 2 3; do echo $i; done | tac',
  'echo trailing backslash \\',
  'trap "echo user-trap" INT; echo x',
  'echo "$(echo nested $(echo deeper))"',
  'x=1; [[ $x == 1 ]] && echo yes',
  'printf "no newline at end"',
  'echo é ü 中文 🙂',
  'echo $0 >/dev/null; echo ok',
  'exec 3>&1; echo via3 >&3; exec 3>&-',
  'echo out; echo err >&2; echo out2',
];

for (const [i, c] of TRICKY.entries()) {
  test(`byte-exact against the unwrapped run: case ${i} ${JSON.stringify(c).slice(0, 40)}`, () => { same(c); });
}

test('bash messages and $LINENO name a line one higher, as with any one-line env file', () => {
  for (const c of ['if then', 'no_such_command_hush; echo $LINENO']) {
    const a = text(sh(c, { wrapped: false }));
    const b = text(sh(c));
    assert.equal(b, a.replace(/line (\d+)/g, (m, d) => `line ${Number(d) + 1}`).replace(/^1$/m, '2'));
    const o = text(sh(c, { envScript: 'export OTHER_PLUGIN=1' }));
    assert.equal(o, b);
  }
});

test('binary output: text survives, NUL bytes are dropped, invalid UTF-8 becomes U+FFFD', () => {
  const r = sh("printf 'a\\x00b\\xff\\xfe c\\n'");
  assert.equal(r.status, 0);
  assert.equal(text(r), 'ab\ufffd\ufffd c\n');
});

test('a background job writing after the shell exits is still redacted', async () => {
  const v = hex(24);
  const r = sh(`(sleep 0.5; echo X_TOKEN=${v}) & echo started`);
  assert.equal(r.status, 0);
  await new Promise((res) => setTimeout(res, 1500));
  const all = fs.readFileSync(path.join(tmp, `r${n - 1}`, 'out'), 'utf8');
  assert.ok(all.startsWith('started\n'));
  assert.ok(all.includes('X_TOKEN=[hush env sha:') && !all.includes(v));
});

test('a secret split across two writes of one line is redacted', () => {
  const v = hex(24);
  const r = sh(`printf 'X_TOK'; sleep 0.05; printf 'EN=${v.slice(0, 20)}'; sleep 0.05; printf '${v.slice(20)}\\n'`);
  assert.ok(!text(r).includes(v.slice(0, 20)) && !text(r).includes(v));
});

test('a PEM block written in parts is redacted as one block', () => {
  const body = crypto.randomBytes(300).toString('base64').match(/.{1,64}/g);
  const head = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
  const tail = ['-----END', 'PRIVATE', 'KEY-----'].join(' ');
  const script = [head, ...body, tail].map((l) => `echo '${l}'; sleep 0.01`).join('; ');
  const r = sh(script);
  assert.ok(!body.some((l) => text(r).includes(l)), 'PEM body leaked');
  assert.match(text(r), /\[hush pem sha:/);
});

test('large output (100 MB) and binary output pass without hanging', () => {
  const t0 = Date.now();
  const r = sh('head -c 100000000 /dev/zero | tr "\\0" "a" | fold -w 100; head -c 5000000 /dev/urandom');
  assert.equal(r.status, 0);
  assert.ok(r.out.length >= 100000000 + 1000000 && r.out.length < 120000000, `${r.out.length} bytes`);
  console.log(`# 100 MB text and 5 MB binary: ${Date.now() - t0} ms`);
});

test('a line longer than the cut size keeps a secret near the cut', () => {
  for (const pad of [65536 - 4096 - 20, 65536 - 4096 + 5, 200000]) {
    const v = hex(24);
    const r = sh(`head -c ${pad} /dev/zero | tr "\\0" "a"; printf ' X_TOKEN=${v} '; head -c 100 /dev/zero | tr "\\0" "a"`);
    assert.ok(!text(r).includes(v), `pad ${pad}`);
    assert.equal(r.out.length, pad + 2 + 'X_TOKEN='.length + `[hush env sha:${sha8(v)}]`.length + 100 + '\n[hush] redacted 1 secret(s)\n'.length);
  }
});

// Runs filter.js alone on writes (strings, or numbers: a pause in ms). Returns the text on fd 3.
function filterAlone(writes, env = {}) {
  return new Promise((resolve) => {
    const p = spawn('node', [FILTER, 'cut0', 'bash'], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'], env: { ...ENV, ...env } });
    let out = '';
    p.stdio[3].on('data', (d) => { out += d; });
    (async () => {
      for (const w of writes) {
        if (typeof w === 'number') await new Promise((res) => setTimeout(res, w));
        else p.stdin.write(w);
      }
      p.stdin.end('\0HUSH:cut0\0');
    })();
    p.on('close', () => resolve(out));
  });
}

test('a line longer than the cut size, no whitespace anywhere: a known value or a pattern match across the cut is redacted, in one read and in two', async () => {
  const known = path.join(tmp, 'cut-known.env');
  const cfg = path.join(tmp, 'cut-cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ files: [known] }));
  // The first 65,536 characters arrive in one read (or in two, the second
  // reaching 65,536), so the cut falls at 65,536 - 4,096 = 61,440.
  const cut = 65536 - 4096;
  for (const [kind, filler] of [['known', 'Z'], ['known', '{"a":"b","c":1},'], ['pattern', 'Z'], ['pattern', '{"a":"b","c":1},']]) {
    const v = hex(24);
    fs.writeFileSync(known, `CUT_SECRET=${kind === 'known' ? v : hex(24)}\n`);
    const item = kind === 'known' ? v : `X_TOKEN=${v}`;
    const fill = (n) => filler.repeat(Math.ceil(n / filler.length) + 1).slice(0, n);
    for (const at of [cut - 20, cut - 5, cut - item.length + 3]) {
      const head = fill(at) + item + fill(65536 - at - item.length);
      const tail = `${fill(5000)}\n`;
      for (const writes of [[head, 50, tail], [head.slice(0, 40000), 50, head.slice(40000), 50, tail]]) {
        const out = await filterAlone(writes, { HUSH_CONFIG: cfg });
        const tag = `${kind} ${JSON.stringify(filler)} at ${at}, ${writes.length === 3 ? 'one read' : 'two reads'}`;
        assert.ok(!out.includes(v.slice(0, 16)) && !out.includes(v.slice(-16)), tag);
        assert.ok(out.includes(kind === 'known' ? `[hush CUT_SECRET sha:${sha8(v)}]` : 'X_TOKEN=[hush env sha:'), tag);
        assert.equal(out.match(/\[hush [^\]]*\]/g).length, 1, tag);
      }
    }
  }
});

test('pauses longer than the 250 ms idle time: a value written in two parts 0.5 s and 2 s apart is redacted whole', async () => {
  const known = path.join(tmp, 'idle-known.env');
  const cfg = path.join(tmp, 'idle-cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ files: [known] }));
  for (const gap of [500, 2000]) {
    const v = hex(24);
    for (const [a, b, ph] of [[`out ${v.slice(0, 20)}`, `${v.slice(20)} end\n`, `[hush IDLE_SECRET sha:${sha8(v)}]`],
      [`X_TOK`, `EN=${v}\n`, `X_TOKEN=[hush env sha:${sha8(v)}]`],
      [`X_TOKEN=${v.slice(0, 10)}`, `${v.slice(10)}\n`, `X_TOKEN=[hush env sha:${sha8(v)}]`],
      ['redis-cli -h cache -a ', `${v} ping\n`, `-a [hush redis-cli-a sha:${sha8(v)}] ping`]]) {
      fs.writeFileSync(known, `IDLE_SECRET=${ph.includes('IDLE_SECRET') ? v : hex(24)}\n`);
      const out = await filterAlone([a, gap, b], { HUSH_CONFIG: cfg });
      assert.ok(!out.includes(v.slice(0, 10)) && !out.includes(v.slice(-10)), `${gap} ms: ${JSON.stringify(a.slice(0, 12))}`);
      assert.ok(out.includes(ph), `${gap} ms: ${out.replace(v, '<v>')}`);
    }
  }
  const v = hex(24);
  const r = sh(`printf 'X_TOKEN=${v.slice(0, 20)}'; sleep 0.5; printf '${v.slice(20)}\\n'`);
  assert.equal(r.status, 0);
  assert.ok(!text(r).includes(v.slice(0, 20)) && text(r).startsWith(`X_TOKEN=[hush env sha:${sha8(v)}]\n`));
});

test('pauses longer than the 250 ms idle time: a PEM block with a 0.5 s pause in its body and a pretty-printed Redis argv with a pause between the lines', async () => {
  const body = crypto.randomBytes(300).toString('base64').match(/.{1,64}/g);
  const head = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
  const tail = ['-----END', 'PRIVATE', 'KEY-----'].join(' ');
  for (const writes of [[`${head}\n${body.slice(0, 2).join('\n')}\n`, 500, `${body.slice(2).join('\n')}\n${tail}\n`],
    ['-----BEG', 500, `IN PRIVATE KEY-----\n${body.join('\n')}`, 500, `\n${tail}\n`]]) {
    const out = await filterAlone(writes);
    assert.ok(!body.some((l) => out.includes(l)), 'PEM body leaked');
    assert.match(out, /\[hush pem sha:/);
  }
  const pw = hex(16);
  const out = await filterAlone(['[\n    "redis-cli",\n    "-a",\n', 600, `    "${pw}",\n`, 600, '    "ping"\n]\n']);
  assert.ok(!out.includes(pw));
  assert.match(out, /"-a",\n {4}"\[hush argv-redis-cli sha:/);
});

test('a partial line without newline arrives within a bounded time: a short last word at the 250 ms idle, any other within 3 s of the last write', async () => {
  const p = spawn('node', [FILTER, 'pg', 'monitor'], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'], env: ENV });
  let out = '';
  const seen = [];
  const t0 = Date.now();
  p.stdio[3].on('data', (d) => { out += d; seen.push([out, Date.now() - t0]); });
  const at = (s) => (seen.find(([o]) => o.includes(s)) || [null, Infinity])[1];
  const closed = new Promise((res) => p.on('close', res));
  try {
    p.stdin.write('Downloading 45%');
    await new Promise((res) => setTimeout(res, 800));
    assert.ok(at('Downloading 45%') < 700, `short word after ${at('Downloading 45%')} ms`);
    const t1 = Date.now() - t0;
    p.stdin.write('\rwaiting for the server...');
    await new Promise((res) => setTimeout(res, 3600));
    assert.ok(at('waiting for the ') - t1 < 700, 'text before the last word at idle');
    const late = at('server...') - t1;
    assert.ok(late >= 2500 && late < 3500, `long last word after ${late} ms`);
  } finally {
    p.stdin.end('\0HUSH:pg\0');
    await closed;
  }
});

test('a 3 MB run of letters with no newline does not stall', () => {
  const t0 = Date.now();
  const r = sh('head -c 3000000 /dev/zero | tr "\\0" "b"');
  assert.equal(r.out.length, 3000000);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});

test('monitor mode: each line arrives at once, no notice', async () => {
  const v = hex(24);
  const r = runner(`for i in 1 2 3; do echo "line $i X_TOKEN=${v}"; sleep 1; done`);
  const p = spawn('/bin/bash', ['-c', r.full], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], env: r.env });
  const seen = [];
  const t0 = Date.now();
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; for (const l of buf.split('\n').slice(0, -1)) seen.push([l, Date.now() - t0]); buf = buf.slice(buf.lastIndexOf('\n') + 1); });
  const status = await new Promise((res) => p.on('close', res));
  assert.equal(status, 0);
  assert.equal(seen.length, 3);
  assert.ok(seen[0][1] < 700, `first line after ${seen[0][1]} ms`);
  assert.ok(seen.every(([l]) => !l.includes(v) && l.includes('[hush env sha:')));
  assert.ok(!buf.includes('redacted'));
});

test('a long-running stream is killed with its process group, no orphans', async () => {
  const r = runner('tail -f /dev/null & echo started; wait', {});
  const p = spawn('/bin/bash', ['-c', r.full], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], env: r.env, detached: true });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  await new Promise((res) => setTimeout(res, 800));
  process.kill(-p.pid, 'SIGKILL');
  await new Promise((res) => p.on('close', res));
  assert.equal(out, 'started\n');
  await new Promise((res) => setTimeout(res, 300));
  const left = spawnSync('pgrep', ['-g', String(p.pid)], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '');
});

const CHECK = `node ${path.join(__dirname, '..', 'scripts', 'check.js')}`;

test('fail closed: filter throws on a bad config: output withheld, status 125, the message names the file and the recovery', () => {
  for (const [cfg, cls] of [[{ patterns: [{ name: 'x', regex: '(' }] }, 'SyntaxError'], [{ strictCommands: ['('] }, 'SyntaxError'], ['{ not json', 'SyntaxError'], [{ patterns: 'x' }, 'TypeError']]) {
    const bad = path.join(tmp, `bad-${hex(3)}.json`);
    fs.writeFileSync(bad, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
    const v = hex(24);
    const r = sh(`echo X_TOKEN=${v}; exit 0`, { env: { HUSH_CONFIG: bad } });
    assert.equal(r.status, 125);
    assert.equal(text(r), `[hush] output withheld: redaction failed (${cls} in ${bad}). Fix or remove ${bad}, then run ${CHECK}.\n`);
  }
});

test('fail closed: node missing: command not run, one line, status 125', () => {
  const marker = path.join(tmp, 'ran');
  const r = sh(`touch ${marker}; echo X_TOKEN=${hex(24)}`, { env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 125);
  assert.equal(text(r), `${unavailable(HOOKS)}\n`);
  assert.ok(!fs.existsSync(marker));
});

test('fail closed: filter.js missing or crashing', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'nofilter-'));
  fs.copyFileSync(path.join(HOOKS, 'wrap.sh'), path.join(dir, 'wrap.sh'));
  const marker = path.join(tmp, 'ran-nofilter');
  const p = sh(`touch ${marker}; echo hi`, { envScript: block(dir) });
  assert.deepEqual([p.status, text(p)], [125, `${unavailable(dir)}\n`]);
  assert.ok(!fs.existsSync(marker));
  fs.writeFileSync(path.join(dir, 'filter.js'), 'process.exit(3)');
  const q = sh(`echo X_TOKEN=${hex(24)}`, { envScript: block(dir) });
  assert.equal(q.status, 125);
  assert.equal(text(q), `[hush] output withheld: filter failed. Run node ${path.dirname(dir)}/scripts/check.js to find the cause.\n`);
});

test('fail closed: wrap.sh missing (plugin directory moved or removed): the message names the path and says to restart claude', () => {
  const marker = path.join(tmp, 'ran-nowrap');
  const gone = path.join(tmp, 'no-such-dir', 'hooks');
  const p = sh(`touch ${marker}`, { envScript: block(gone) });
  assert.equal(p.status, 125);
  assert.ok(text(p).endsWith(`${unavailable(gone)}\n`));
  assert.match(text(p), /no-such-dir\/hooks\/wrap\.sh did not start the output filter\. If hush was updated, moved, or removed, restart the claude process\./);
  assert.ok(!fs.existsSync(marker));
});

// zsh: on PATH, or HUSH_TEST_ZSH (a zsh binary unpacked without root).
const ZSH = process.env.HUSH_TEST_ZSH || spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout.trim() || null;
const SHELLS = [['dash', fs.existsSync('/bin/dash') ? '/bin/dash' : null], ['zsh', ZSH]];

for (const [name, shell] of SHELLS) {
  test(`a shell that is not bash 4.1 or newer (${name}): the line, sourced anyway, sets up no filter; the command runs with its own status and output`, { skip: !shell && `${name} not installed` }, () => {
    const marker = path.join(tmp, `ran-${name}`);
    const r = spawnSync(shell, ['-c', ccCommand(`touch ${marker}; echo plain out; echo err >&2; exit 3`, block(HOOKS), path.join(tmp, `cwd-${name}`))], { cwd: tmp, env: ENV, encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.equal(r.stdout, 'plain out\n');
    assert.equal(r.stderr, 'err\n');
    assert.ok(fs.existsSync(marker));
  });
}

// A fake shell named for zsh or bash, so that Claude Code's rule accepts it as CLAUDE_CODE_SHELL.
function fakeShell(name, body) {
  const d = fs.mkdtempSync(path.join(tmp, 'shell-'));
  const f = path.join(d, name);
  fs.writeFileSync(f, body, { mode: 0o755 });
  return f;
}

test('session-start.js: the shell Claude Code would use is not bash 4.1 or newer: no line, hush lines removed, a message says why', () => {
  const cases = [
    ['zsh named dash', fs.existsSync('/bin/dash') && fakeShell('zsh', '#!/bin/sh\nexec /bin/dash "$@"\n'), /with .*\/zsh, which is not bash/],
    ['bash 3.2', fakeShell('bash', '#!/bin/sh\nprintf %s "3.2.57(1)-release"\n'), /which is bash 3\.2/],
    ['real zsh', ZSH, /which is not bash/],
  ];
  for (const [name, shell, why] of cases) {
    if (!shell) continue;
    const f = path.join(tmp, `env-off-${name.replace(/\W/g, '')}.sh`);
    fs.writeFileSync(f, `export A=1\n${block(path.join(tmp, 'old'))}export B=2\n`);
    const r = spawnSync('node', [START], { input: '{}', env: { ...ENV, CLAUDE_ENV_FILE: f, CLAUDE_CODE_SHELL: shell }, encoding: 'utf8' });
    assert.equal(r.status, 0, name);
    const msg = JSON.parse(r.stdout).systemMessage;
    assert.match(msg, /^\[hush\] output filter off: /, name);
    assert.match(msg, why, name);
    assert.match(msg, /needs bash 4\.1 or newer.*set CLAUDE_CODE_SHELL to the path of bash 4\.1 or newer and restart claude/, name);
    assert.equal(fs.readFileSync(f, 'utf8'), 'export A=1\nexport B=2\n', name);
  }
  const ok = path.join(tmp, 'env-on.sh');
  const r = spawnSync('node', [START], { input: '{}', env: { ...ENV, CLAUDE_ENV_FILE: ok, CLAUDE_CODE_SHELL: '/bin/bash' }, encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout, fs.readFileSync(ok, 'utf8')], [0, '', block(HOOKS)]);
});

test('session-start.js: picks the shell the way Claude Code does', () => {
  const { claudeShell } = require('../hooks/session-start');
  const z = fakeShell('zsh', '#!/bin/sh\n');
  const b = fakeShell('bash', '#!/bin/sh\n');
  const PATH = `${path.dirname(z)}:${path.dirname(b)}`;
  assert.equal(claudeShell({ CLAUDE_CODE_SHELL: z, SHELL: '/bin/bash', PATH }), z);
  assert.equal(claudeShell({ CLAUDE_CODE_SHELL: '/bin/dash', SHELL: b, PATH }), b, 'an override that names neither bash nor zsh is ignored');
  assert.equal(claudeShell({ SHELL: z, PATH }), z);
  assert.equal(claudeShell({ SHELL: '/bin/fish', PATH }), z, 'zsh first when SHELL names neither');
  assert.equal(claudeShell({ SHELL: '/usr/local/bin/bash-missing', PATH }), b, 'bash first when SHELL names bash');
});

test('filter.js alone: per-line flush, marker ends the call, ack 0', async () => {
  const v = hex(24);
  const p = spawn('node', [FILTER, 'abc', 'bash'], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'], env: ENV });
  const out = [];
  p.stdio[3].on('data', (d) => out.push(d.toString()));
  p.stdin.write(`a X_TOK`);
  p.stdin.write(`EN=${v}\nb\n`);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(out.join(''), `a X_TOKEN=[hush env sha:${sha8(v)}]\nb\n`);
  let ack = '';
  p.stdout.on('data', (d) => { ack += d; });
  p.stdin.write('tail\0HUSH:abc\0');
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(ack, '0\n');
  assert.ok(out.join('').endsWith('b\ntail\n[hush] redacted 1 secret(s)\n'));
  p.stdin.end();
  assert.equal(await new Promise((res) => p.on('close', res)), 0);
});

test('filter.js alone: a wrong nonce is not a marker', async () => {
  const p = spawn('node', [FILTER, 'right', 'bash'], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'], env: ENV });
  let out = '';
  let ack = '';
  p.stdio[3].on('data', (d) => { out += d; });
  p.stdout.on('data', (d) => { ack += d; });
  p.stdin.end('x\0HUSH:wrong\0y\n');
  await new Promise((res) => p.on('close', res));
  assert.equal(out, 'xHUSH:wrongy\n');
  assert.equal(ack, '0\n');
});

test('output already redacted by the wrapper passes redact.js unchanged', () => {
  const v = hex(24);
  const r = sh(`echo DB_PASSWORD=${v} Authorization: Bearer ${hex(20)}`);
  const p = spawnSync('node', [path.join(__dirname, '../hooks/redact.js')], { input: JSON.stringify({ tool_name: 'Bash', tool_response: { stdout: text(r), stderr: '' } }), env: ENV, encoding: 'utf8' });
  assert.deepEqual([p.status, p.stdout], [0, '']);
});

test('latency: median of 20 runs', () => {
  const med = (c, w) => {
    const t = [];
    for (let i = 0; i < 20; i++) { const t0 = process.hrtime.bigint(); sh(c, { wrapped: w }); t.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    return t.sort((a, b) => a - b)[10];
  };
  const big = 'head -c 1000000 /dev/zero | tr "\\0" "a" | fold -w 100';
  const r = { trueRaw: med('true', false), trueWrapped: med('true', true), mbRaw: med(big, false), mbWrapped: med(big, true) };
  console.log(`# latency ms: true ${r.trueRaw.toFixed(1)} -> ${r.trueWrapped.toFixed(1)} (+${(r.trueWrapped - r.trueRaw).toFixed(1)}), 1 MB ${r.mbRaw.toFixed(1)} -> ${r.mbWrapped.toFixed(1)} (+${(r.mbWrapped - r.mbRaw).toFixed(1)})`);
  assert.ok(r.trueWrapped - r.trueRaw < 80);
});

test('limit: a command with its own EXIT trap or a final exec returns before the filter is done; the late output is redacted', async () => {
  const v = hex(24);
  for (const c of [`trap "echo user-trap" EXIT; echo X_TOKEN=${v}; exit 4`, `exec node -e "console.log('X_TOKEN=${v}'); process.exit(6)"`]) {
    const r = sh(c);
    assert.ok([4, 6].includes(r.status));
    await new Promise((res) => setTimeout(res, 500));
    const late = fs.readFileSync(path.join(tmp, `r${n - 1}`, 'out'), 'utf8');
    assert.ok(late.includes('X_TOKEN=[hush env sha:') && !late.includes(v));
  }
});
