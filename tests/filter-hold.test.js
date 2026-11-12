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

test('a known value written in two parts, 4 s and 10 s apart: split after 6 or more characters shows 0 characters, after 5 at most 5', async () => {
  const k = alnum(40);
  const cases = [];
  for (const [split, gap] of [[5, 4000], [6, 4000], [20, 4000], [39, 4000], [20, 10000]]) {
    cases.push(filter([`value ${k.slice(0, split)}`, gap, `${k.slice(split)} done\n`], { known: [k] }).then((r) => [split, gap, r]));
  }
  cases.push(filter(['v ', 300, k.slice(0, 5), 4000, k.slice(5, 20), 4000, `${k.slice(20)}\n`], { known: [k] }).then((r) => ['5+15', 'two pauses', r]));
  const ph = `[hush HOLD0_SECRET sha:${sha8(k)}]`;
  for (const [split, gap, r] of await Promise.all(cases)) {
    if (split === 5 || split === '5+15') {
      // A start shorter than PARTIAL is written after 3 s; the rest is redacted with it.
      assert.ok(residue(r.out, k) <= 5, `split ${split}: ${residue(r.out, k)} characters`);
      assert.ok(r.out.includes(ph), `split ${split}: placeholder`);
      continue;
    }
    assert.equal(r.out, `value ${ph} done\n[hush] redacted 1 secret(s)\n`, `split ${split}, pause ${gap}`);
  }
});

test('an unknown 40-character high-variety token that matches a pattern once complete shows at most 5 characters', async () => {
  const cases = [];
  for (const split of [5, 20]) {
    const gh = `ghp_${alnum(36)}`;
    cases.push(filter([`token ${gh.slice(0, split)}`, 4000, `${gh.slice(split)}\n`]).then((r) => [`ghp_ split ${split}`, gh, r]));
    const tok = alnum(40);
    cases.push(filter([`API_TOKEN: ${tok.slice(0, split)}`, 4000, `${tok.slice(split)}\n`]).then((r) => [`API_TOKEN: split ${split}`, tok, r]));
  }
  for (const [name, secret, r] of await Promise.all(cases)) assert.ok(residue(r.out, secret) <= 5, `${name}: ${residue(r.out, secret)} characters`);
});

test('with 20 known values loaded, a last word that ends in a short start of one appears within 3.5 s; a known value split after 3 or 8 characters with a 10 s pause shows at most 5 characters', async () => {
  const known = Array.from({ length: 20 }, () => hex(20));
  const k = alnum(40);
  const [port, s8, s3] = await Promise.all([
    filter(['Server listening on port 3000', 3700], { mode: 'monitor', known: [...known, `000${hex(20)}`] }),
    filter([`value ${k.slice(0, 8)}`, 10000, `${k.slice(8)} done\n`], { known: [...known, k] }),
    filter([`value ${k.slice(0, 3)}`, 10000, `${k.slice(3)} done\n`], { known: [...known, k] }),
  ]);
  assert.ok(port.at('port 3000') < 3500, `port 3000 after ${port.at('port 3000')} ms`);
  for (const [name, r] of [['split 8', s8], ['split 3', s3]]) {
    assert.ok(residue(r.out, k) <= 5, `${name}: ${residue(r.out, k)} characters`);
    assert.match(r.out, /\[hush HOLD20_SECRET sha:[0-9a-f]{8}\] done\n/, name);
  }
});

test('a prompt without newline still appears within 3.5 s; a short progress word at the 250 ms idle', async () => {
  const [prompt, progress] = await Promise.all([
    filter(['Password:', 3700], { mode: 'monitor', known: [hex(20)] }),
    filter(['Downloading 45%', 800], { mode: 'monitor' }),
  ]);
  assert.ok(prompt.at('Password:') < 3500, `Password: after ${prompt.at('Password:')} ms`);
  assert.ok(progress.at('Downloading 45%') < 700, `progress after ${progress.at('Downloading 45%')} ms`);
});

test('a \\r progress line still updates; a known value growing on it shows at most 5 characters', async () => {
  const bar = await filter(['\r 10%', 600, '\r 20%', 600, '\r 30%', 600, '\r done\n'], { mode: 'monitor' });
  assert.ok(bar.at('\r 10%') < 500 && bar.at('\r 20%') < 1100 && bar.at('\r 30%') < 1700, 'each update arrives before the next');
  assert.equal(bar.out, '\r 10%\r 20%\r 30%\r done\n');
  const k = alnum(40);
  const r = await filter([`\rkey ${k.slice(0, 13)}`, 1200, `\rkey ${k.slice(0, 26)}`, 3500, `\rkey ${k}\n`], { known: [k] });
  assert.ok(residue(r.out, k) <= 5, `${residue(r.out, k)} characters`);
  assert.match(r.out, /\[hush HOLD0_SECRET partial\]/);
});

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
