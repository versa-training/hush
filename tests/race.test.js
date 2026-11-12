'use strict';
// Regression test for the coproc race in wrap.sh (fixed in 7dc9020): with the
// host busy, bash could reap the coproc before the shell copied its fds, and
// the command failed with status 125 (`cannot duplicate fd`). About 200
// wrapped commands, 10 at a time, while busy loops hold half the CPUs (on a
// 16-core host the old wrap.sh failed 13 and 19 of 200 in two runs).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { block } = require('../hooks/session-start');

const HOOKS = path.join(__dirname, '../hooks');
const cores = os.availableParallelism();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-race-'));
fs.writeFileSync(path.join(tmp, 'cfg.json'), '{}');
const ENV = { ...process.env, HUSH_CONFIG: path.join(tmp, 'cfg.json'), HUSH_LOG: path.join(tmp, 'log.jsonl') };
const sq = (c) => `'${c.replace(/'/g, `'"'"'`)}'`;

// [command, status, output]
const COMMANDS = [['true', 0, ''], ['false', 1, ''], ['exit 3', 3, ''], ['echo hi', 0, 'hi\n'],
  ['seq 1 300', 0, Array.from({ length: 300 }, (_, i) => `${i + 1}\n`).join('')], ['printf partial', 0, 'partial'], ['echo err >&2; exit 4', 4, 'err\n']];

function one(i) {
  const [command, status, output] = COMMANDS[i % COMMANDS.length];
  const dir = path.join(tmp, `c${i}`);
  fs.mkdirSync(dir);
  const out = path.join(dir, 'out');
  const fd = fs.openSync(out, 'w');
  const full = ['source /nonexistent 2>/dev/null || true', `${block(HOOKS).trim()}\n:`, `eval ${sq(command)} < /dev/null`, `pwd -P >| ${dir}/cwd`].join(' && ');
  return new Promise((resolve) => {
    const p = spawn('/bin/bash', ['-c', full], { cwd: dir, stdio: ['ignore', fd, fd], env: ENV });
    const kill = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.on('exit', (code) => {
      clearTimeout(kill);
      fs.closeSync(fd);
      const got = fs.readFileSync(out, 'utf8');
      resolve(code === status && got === output ? null : `${command} -> ${code} ${JSON.stringify(got.slice(0, 80))}`);
    });
  });
}

test('wrap.sh under CPU load: 200 parallel wrapped commands keep their status and output, none exits 125', { skip: cores < 2 && 'needs 2 or more cores', timeout: 20000 }, async () => {
  // Busy loops that end on their own after 30 s, in case the test dies first.
  const busy = Array.from({ length: Math.max(1, cores >> 1) }, () => spawn(process.execPath, ['-e', 'const end = Date.now() + 30000; while (Date.now() < end);'], { stdio: 'ignore' }));
  const t0 = Date.now();
  const wrong = [];
  let runs = 0;
  try {
    for (let i = 0; i < 200 && Date.now() - t0 < 15000; i += 10) {
      for (const w of await Promise.all(Array.from({ length: 10 }, (_, j) => one(i + j)))) if (w) wrong.push(w);
      runs += 10;
    }
  } finally {
    for (const b of busy) b.kill('SIGKILL');
  }
  console.log(`# race: ${runs} commands in ${Date.now() - t0} ms, ${wrong.length} wrong`);
  assert.deepEqual(wrong.slice(0, 5), []);
});
