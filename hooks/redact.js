#!/usr/bin/env node
'use strict';
const { loadConfig, loadKnown, redact, log } = require('./hush-lib');

let payload;
try { payload = JSON.parse(require('fs').readFileSync(0, 'utf8')); } catch { process.exit(0); }
const r = payload && payload.tool_response;
if (r === undefined || r === null || typeof r !== 'object' && typeof r !== 'string') process.exit(0);
const tool = payload.tool_name || '';

const emit = (out) => process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    [tool.startsWith('mcp__') ? 'updatedMCPToolOutput' : 'updatedToolOutput']: out,
  },
}));

// Rebuilds the value with fn applied to every string, keeping shape and other fields.
const mapStrings = (node, fn) => {
  if (typeof node === 'string') return fn(node);
  if (Array.isArray(node)) return node.map((x) => mapStrings(x, fn));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, mapStrings(v, fn)]));
  return node;
};

let any = false;
mapStrings(r, (s) => { any = any || s.length > 0; return s; });
if (!any) process.exit(0);

try {
  const cfg = loadConfig();
  let long = false;
  mapStrings(r, (s) => { long = long || s.length >= cfg.minLength; return s; });
  if (!long) process.exit(0);
  const known = loadKnown(cfg).values;
  const counts = {};
  let out = mapStrings(r, (s) => {
    const x = redact(s, cfg, known);
    for (const [k, n] of Object.entries(x.counts)) counts[k] = (counts[k] || 0) + n;
    return x.text;
  });
  const n = Object.values(counts).reduce((x, y) => x + y, 0);
  if (n) {
    if (tool === 'Bash' && typeof out.stdout === 'string') out = { ...out, stdout: `${out.stdout}\n[hush] redacted ${n} secret(s)` };
    emit(out);
    try { log(tool || 'unknown', counts); } catch { /* log is best effort */ }
  }
} catch (e) {
  const msg = `[hush] output withheld: redaction failed (${(e && e.constructor && e.constructor.name) || 'Error'})`;
  emit(mapStrings(r, () => msg));
}
