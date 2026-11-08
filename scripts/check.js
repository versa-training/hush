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
const out = redact(`HUSH_SELFTEST_TOKEN=${fake}`, cfg, values).text;
const ok = !out.includes(fake);
console.log(`self-test: ${ok ? 'ok' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
