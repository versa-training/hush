'use strict';
// filter.js on partial lines and over-long lines: what a pause, a `\r`
// progress line, or a forced cut leaves visible.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { sha8 } = require('../hooks/hush-lib');

const FILTER = path.join(__dirname, '../hooks/filter.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-hold-'));
const hex = (n) => crypto.randomBytes(n).toString('hex');
// Letters and digits, high variety: the shape of a generated secret.
const alnum = (n) => { let s = ''; while (s.length < n) s += crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, ''); return s.slice(0, n); };
let runs = 0;

// A config whose known-values file holds the given values.
function config(known = []) {
  const dir = path.join(tmp, `c${runs++}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'known.env'), known.map((v, i) => `HOLD${i}_SECRET=${v}\n`).join(''));
  fs.writeFileSync(path.join(dir, 'cfg.json'), JSON.stringify({ files: [path.join(dir, 'known.env')] }));
  return { HUSH_CONFIG: path.join(dir, 'cfg.json'), HUSH_LOG: path.join(dir, 'log.jsonl') };
}

// Runs filter.js on writes (strings, or numbers: a pause in ms). Returns the
// text on fd 3 and when each part of it arrived, in ms after the first write.
function filter(writes, { known = [], mode = 'bash' } = {}) {
  return new Promise((resolve) => {
    const p = spawn('node', [FILTER, 'hold0', mode], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'], env: { ...process.env, ...config(known) } });
    let out = '';
    const seen = [];
    const t0 = Date.now();
    p.stdio[3].on('data', (d) => { out += d; seen.push([out, Date.now() - t0]); });
    (async () => {
      for (const w of writes) {
        if (typeof w === 'number') await new Promise((res) => setTimeout(res, w));
        else p.stdin.write(w);
      }
      p.stdin.end('\0HUSH:hold0\0');
    })();
    p.on('close', () => resolve({ out, at: (s) => (seen.find(([o]) => o.includes(s)) || [null, Infinity])[1] }));
  });
}

// The longest run of characters of secret visible in out, outside hush's
// placeholders and notes (their letters and hex digits match by chance).
function residue(out, secret) {
  out = out.replace(/\[hush [^\]]*\]/g, '').replace(/\[hush\] .*\n/g, '');
  let best = 0;
  for (let i = 0; i < secret.length; i++) {
    for (let j = secret.length; j > i + best; j--) if (out.includes(secret.slice(i, j))) { best = j - i; break; }
  }
  return best;
}

test('forced cut at 1 MB: the rest of an over-long match is withheld, and a known value across the cut is not split', async () => {
  const value = hex(650000);
  const r = await filter([`API_KEY=${value}`, 50, ' after\n']);
  assert.ok(r.out.length < 2000, `${r.out.length} characters written`);
  for (let i = 0; i + 32 <= value.length; i += 997) assert.ok(!r.out.includes(value.slice(i, i + 32)), `value part at ${i}`);
  assert.match(r.out, /^API_KEY=\[hush env sha:[0-9a-f]{8}\]\[hush withheld\] after\n/);
  const k = alnum(40);
  for (let run = 0; run < 3; run++) {
    const s = await filter([`API_KEY=${'.'.repeat(1000000)}${k.repeat(6000)}${'.'.repeat(100000)}\n`], { known: [k] });
    assert.ok(!s.out.includes(k), `run ${run}: a copy of the known value is visible`);
    assert.ok(s.out.includes('[hush withheld]'));
  }
});

test('an open PEM header repeated over 1 MB does not stall the filter', async () => {
  const t0 = Date.now();
  const head = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
  const r = await filter([`${head}\n`.repeat(40000)]);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  assert.equal(r.out.length, `${head}\n`.length * 40000);
});
