#!/usr/bin/env node
'use strict';
// Prints config status and runs a self-test. Never prints a value.
const crypto = require('crypto');
const { loadConfig, loadKnown, redact } = require('../hooks/hush-lib');

const cfg = loadConfig();
const { values, files } = loadKnown(cfg);
for (const f of files) console.log(`${f.path}: ${f.exists ? 'exists' : 'missing'}, ${f.count} value(s)`);
console.log(`patterns: ${cfg.patterns.length}, allow: ${cfg.allow.length}, known values: ${values.length}`);

const fake = crypto.randomBytes(24).toString('hex');
const checks = {
  pattern: () => !redact(`HUSH_SELFTEST_TOKEN=${fake}`, cfg, values).text.includes(fake)
    && !redact(`["redis-cli", "-a", "${fake}", "ping"]`, cfg, values).text.includes(fake),
  block: () => require('../hooks/literal').findLiterals(`redis-cli -a ${fake} ping`, cfg, new Set()).length === 1
    && require('../hooks/literal').findLiterals('redis-cli -a "$REDIS_PASSWORD" ping', cfg, new Set()).length === 0,
};
const failed = Object.entries(checks).filter(([, f]) => { try { return !f(); } catch { return true; } }).map(([k]) => k);
console.log(`blockLiterals: ${cfg.blockLiterals !== false}, allowLiterals: ${(cfg.allowLiterals || []).length}`);
console.log(`self-test: ${failed.length ? `FAILED (${failed.join(', ')})` : 'ok'}`);
process.exit(failed.length ? 1 : 0);
