#!/usr/bin/env node
'use strict';
const { loadConfig, loadKnown, redact, log } = require('./hush-lib');

const emit = (out) => process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: out },
}));

let payload;
try { payload = JSON.parse(require('fs').readFileSync(0, 'utf8')); } catch { process.exit(0); }
const r = payload && payload.tool_response;
if (!r || typeof r !== 'object') process.exit(0);
const stdout = typeof r.stdout === 'string' ? r.stdout : '';
const stderr = typeof r.stderr === 'string' ? r.stderr : '';
if (!stdout && !stderr) process.exit(0);

try {
  const cfg = loadConfig();
  const known = loadKnown(cfg).values;
  const a = redact(stdout, cfg, known);
  const b = redact(stderr, cfg, known);
  const counts = { ...a.counts };
  for (const [k, n] of Object.entries(b.counts)) counts[k] = (counts[k] || 0) + n;
  const n = Object.values(counts).reduce((x, y) => x + y, 0);
  if (n) {
    emit({
      stdout: `${a.text}\n[hush] redacted ${n} secret(s)`,
      stderr: b.text,
      interrupted: r.interrupted,
      isImage: r.isImage,
    });
    try { log(payload.tool_name || 'Bash', counts); } catch { /* log is best effort */ }
  }
} catch (e) {
  emit({
    stdout: `[hush] output withheld: redaction failed (${(e && e.constructor && e.constructor.name) || 'Error'})`,
    stderr: '',
    interrupted: r.interrupted,
    isImage: r.isImage,
  });
}
