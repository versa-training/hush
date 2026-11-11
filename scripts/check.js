#!/usr/bin/env node
'use strict';
// Prints config status and runs a self-test. Never prints a value.
const crypto = require('crypto');
const { loadConfig, loadKnown, redact, compile } = require('../hooks/hush-lib');

// An error in the config or a listed file: its class, file, and for JSON its
// position, never its message (which may quote the file).
function fail(e) {
  const cls = (e && e.constructor && e.constructor.name) || 'Error';
  const pos = /position \d+(?: \(line \d+ column \d+\))?/.exec((e && e.message) || '');
  console.log(`config error: ${cls}${e && e.hushFile ? ` in ${e.hushFile}` : ''}${pos ? ` at ${pos[0]}` : ''}`);
  console.log('self-test: FAILED (config)');
  process.exit(1);
}

let cfg;
let values;
let files;
try {
  cfg = loadConfig();
  compile(cfg);
  ({ values, files } = loadKnown(cfg));
  require('../hooks/strict').isStrict('x', cfg);
} catch (e) { fail(e); }
for (const f of files) console.log(`${f.path}: ${f.exists ? 'exists' : 'missing'}, ${f.count} value(s)`);
console.log(`patterns: ${cfg.patterns.length}, allow: ${cfg.allow.length}, known values: ${values.length}`);

const fake = crypto.randomBytes(24).toString('hex');
const checks = {
  pattern: () => !redact(`HUSH_SELFTEST_TOKEN=${fake}`, cfg, values).text.includes(fake)
    && !redact(`["redis-cli", "-a", "${fake}", "ping"]`, cfg, values).text.includes(fake),
  block: () => require('../hooks/literal').findLiterals(`redis-cli -a ${fake} ping`, cfg, new Set()).length === 1
    && require('../hooks/literal').findLiterals('redis-cli -a "$REDIS_PASSWORD" ping', cfg, new Set()).length === 0,
  strict: () => {
    const { Strict, isStrict } = require('../hooks/strict');
    const m = new Strict(cfg);
    return isStrict('docker inspect app', cfg) && !isStrict('docker ps', cfg)
      && !m.text(`{"Env": ["HUSH_SELFTEST=${fake}"]}\n`).includes(fake) && m.count === 1;
  },
};
const failed = Object.entries(checks).filter(([, f]) => { try { return !f(); } catch { return true; } }).map(([k]) => k);
console.log(`blockLiterals: ${cfg.blockLiterals !== false}, allowLiterals: ${(cfg.allowLiterals || []).length}, strictCommands: ${(cfg.strictCommands || []).length}`);
console.log(`self-test: ${failed.length ? `FAILED (${failed.join(', ')})` : 'ok'}`);
process.exit(failed.length ? 1 : 0);
