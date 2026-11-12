#!/usr/bin/env node
'use strict';
const { loadConfig, loadKnown, buildKnown, compile, redact, log, failure } = require('./hush-lib');
const { Strict, isStrict, notice } = require('./strict');

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
  const command = payload.tool_input && payload.tool_input.command;
  const strict = tool === 'Bash' && typeof command === 'string' && isStrict(command, cfg);
  let long = false;
  mapStrings(r, (s) => { long = long || s.length >= cfg.minLength; return s; });
  if (!long && !strict) process.exit(0);
  const known = loadKnown(cfg).values;
  const compiled = compile(cfg);
  const index = buildKnown(known, cfg);
  const counts = {};
  let out = mapStrings(r, (s) => {
    const x = redact(s, cfg, known, compiled, index);
    for (const [k, n] of Object.entries(x.counts)) counts[k] = (counts[k] || 0) + n;
    return x.text;
  });
  const n = Object.values(counts).reduce((x, y) => x + y, 0);
  // Strict masking: stdout and stderr of a listed command, each with its own state.
  let strictCount = 0;
  if (strict) {
    const st = (s) => { const m = new Strict(cfg); const t = m.text(s); strictCount += m.count; return t; };
    if (typeof out === 'string') out = st(out);
    else out = { ...out, ...Object.fromEntries(['stdout', 'stderr'].filter((k) => typeof out[k] === 'string').map((k) => [k, st(out[k])])) };
  }
  if (n || strictCount) {
    const notes = [n ? `[hush] redacted ${n} secret(s)` : '', strictCount ? notice(strictCount) : ''].filter(Boolean).join('\n');
    if (tool === 'Bash' && typeof out.stdout === 'string') out = { ...out, stdout: `${out.stdout}\n${notes}` };
    if (strictCount) counts.strict = strictCount;
    emit(out);
    try { log(tool || 'unknown', counts); } catch { /* log is best effort */ }
  }
} catch (e) {
  const msg = failure('output withheld: redaction failed', e);
  emit(mapStrings(r, () => msg));
}
