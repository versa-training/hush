'use strict';
// Every shipped regex runs in bounded time: the patterns and strictCommands
// in hush.default.json, the regexes in hooks/literal.js and hooks/strict.js,
// and the functions that run them. Inputs: 32 KB and 1 MB of plain text, and
// adversarial lines built by repeating each regex's own literal fragments.
// The timing runs in a child process with a time limit, so a regex that
// hangs fails the test instead of hanging it. The limit is LIMIT_MS times the
// speed of the host: the child first times a fixed linear scan (the baseline)
// and scales the limit by baseline / REFERENCE_MS, never below 1 and never
// above 4, so super-linear cost fails on every host.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIMIT_MS = 250;
const REFERENCE_MS = 13; // baseline of the reference host, in ms
const MAX_SCALE = 4;
const SIZES = [32 * 1024, 1024 * 1024];

// The literal runs of a regex source: escapes and character classes become one
// sample character each; groups, alternations, quantifiers, and anchors end a run.
function fragments(source) {
  const runs = [];
  let run = '';
  const end = () => { if (run) runs.push(run); run = ''; };
  const ESC = { s: ' ', n: '\n', t: '\t', r: '\r', d: '1', w: 'a', S: 'x', D: 'x', W: '-' };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      const d = source[++i];
      if (d === 'b' || d === 'B') { end(); continue; }
      if (d === 'u') { run += String.fromCharCode(parseInt(source.slice(i + 1, i + 5), 16)); i += 4; continue; }
      run += ESC[d] ?? d;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      const neg = source[j] === '^';
      if (neg) j++;
      let first = null;
      for (; j < source.length && source[j] !== ']'; j++) {
        if (source[j] === '\\') { if (first === null) first = ESC[source[j + 1]] ?? source[j + 1]; j++; continue; }
        if (first === null) first = source[j];
      }
      run += neg ? 'a' : (first ?? 'a');
      i = j;
      continue;
    }
    if (c === '{') { const j = source.indexOf('}', i); if (j > 0) { i = j; continue; } }
    if (c === '(') { end(); if (source[i + 1] === '?') { i++; if (source[i + 1] === '<' && /[=!]/.test(source[i + 2])) i += 2; else i++; } continue; }
    if ('|)?*+^$.'.includes(c)) { end(); continue; }
    run += c;
  }
  end();
  return runs;
}

// Adversarial lines for one regex: each run, each run with a space and with a
// newline after it, and all runs joined.
function inputs(source) {
  const runs = [...new Set(fragments(source))];
  const frags = new Set(['a', ' ', '\n', 'a ', '"a", ', '=', ':', 'aB3/', runs.join(''), runs.join(' ')]);
  for (const r of runs) { frags.add(r); frags.add(`${r} `); frags.add(`${r}\n`); }
  return [...frags].filter(Boolean);
}

const fill = (f, n) => f.repeat(Math.ceil(n / f.length)).slice(0, n);

// Child: times every regex on every input and prints the worst cases as JSON.
function child() {
  const { loadConfig, compile, redact, buildKnown } = require('../hooks/hush-lib');
  const literal = require('../hooks/literal');
  const strict = require('../hooks/strict');
  const cfg = loadConfig();
  const results = [];
  // Baseline: a linear regex scan over 1 MB of plain text, best of 5.
  const plain = fill('the quick brown fox jumps over the lazy dog ', 1024 * 1024);
  let baseline = Infinity;
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    plain.replace(/[a-z]+\s+[a-z]+\s+zzz/g, '');
    baseline = Math.min(baseline, performance.now() - t0);
  }
  const factor = Math.min(MAX_SCALE, Math.max(1, baseline / REFERENCE_MS));
  const limit = LIMIT_MS * factor;
  // Runs fn up to 5 times, 200 ms apart, while it is over the limit, and keeps
  // the fastest: the test bounds the work a regex does, and other test files
  // load the host at the same time.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const time = (fn) => {
    let best = Infinity;
    for (let k = 0; k < 5 && best > limit; k++) {
      if (k) Atomics.wait(pause, 0, 0, 200);
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const only = process.env.HUSH_RT_ONLY;
  const measure = (kind, name, source, fn, sizes = SIZES) => {
    if (only && only !== `${kind}:${name}`) return;
    for (const f of inputs(source)) {
      for (const n of sizes) {
        const s = fill(f, n);
        results.push({ kind, name, f: f.slice(0, 40), n, ms: time(() => fn(s)) });
      }
    }
  };
  cfg.patterns.forEach((p, i) => { const re = compile(cfg)[i].re; measure('pattern', p.name, p.regex, (s) => s.replace(re, '')); });
  cfg.strictCommands.forEach((r, i) => { const re = new RegExp(r, 'm'); measure('strictCommand', String(i), r, (s) => re.test(s)); });
  literal.REGEXES.forEach((re, i) => measure('literal', String(i), re.source, (s) => [...s.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))]));
  // The functions that run them, on the fragments of all their regexes, at
  // MAX_COMMAND characters: the longest command a hook matches, and the
  // filter's line cut (CAP). On longer text they take linear time.
  const all = [...cfg.patterns.map((p) => p.regex), ...cfg.strictCommands, ...literal.REGEXES.map((r) => r.source)].join('|');
  const compiled = compile(cfg);
  const index = buildKnown([], cfg);
  measure('function', 'findLiterals', all, (s) => literal.findLiterals(s, cfg, new Set()), [strict.MAX_COMMAND]);
  measure('function', 'isStrict', all, (s) => strict.isStrict(strict.commandOf(s), cfg), [strict.MAX_COMMAND]);
  measure('function', 'redact', all, (s) => redact(s, cfg, [], compiled, index), [strict.MAX_COMMAND]);
  // strict.js keeps its regexes inline: its function runs on the shapes it parses.
  const shapes = ['A=b ', 'export A=b\n', '"A=b", ', '"key": "v", ', 'key: v\n', '- ', '- --a\n', 'data:\n', '["CMD", "-a", ', '"Cmd": [', '[', '"a":{', 'aB3/aB3/aB3/aB3/aB3/ '].join('|');
  measure('function', 'Strict.text', `${all}|${shapes}`, (s) => new strict.Strict(cfg).text(s), [strict.MAX_COMMAND]);
  results.sort((a, b) => b.ms - a.ms);
  process.stdout.write(JSON.stringify({ count: results.length, baseline, factor, limit, worst: results.slice(0, 10) }));
}

if (process.argv[2] === '--child') {
  child();
} else {
  test(`every shipped regex and the functions that run them: under ${LIMIT_MS} ms (scaled by host speed, 1 to ${MAX_SCALE} times) on 32 KB, 1 MB, and adversarial input`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-rt-'));
    const cfgFile = path.join(tmp, 'cfg.json');
    fs.writeFileSync(cfgFile, '{}');
    const r = spawnSync(process.execPath, [__filename, '--child'], { env: { ...process.env, HUSH_CONFIG: cfgFile }, encoding: 'utf8', timeout: 240000, maxBuffer: 1 << 24 });
    assert.equal(r.signal, null, `timing child killed (${r.signal}): a regex hangs`);
    assert.equal(r.status, 0, r.stderr);
    const { count, baseline, factor, limit, worst } = JSON.parse(r.stdout);
    const w = worst[0];
    console.log(`# regex timing: baseline ${baseline.toFixed(1)} ms, factor ${factor.toFixed(2)}, limit ${limit.toFixed(0)} ms, ${count} runs, worst ${w.ms.toFixed(1)} ms (${w.kind} ${w.name}, ${JSON.stringify(w.f)} x ${w.n})`);
    const slow = worst.filter((x) => x.ms >= limit);
    assert.deepEqual(slow, [], JSON.stringify(slow));
  });

  test('fragments: escapes, classes, groups, and quantifiers', () => {
    assert.deepEqual(fragments('\\bredis-cli\\b[^\\n|;&]{0,300}?\\s(?:-a|--pass)\\s+'), ['redis-cli', 'a', ' ', '-a', '--pass', ' ']);
  });
}
