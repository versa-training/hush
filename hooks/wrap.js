#!/usr/bin/env node
'use strict';
// PreToolUse hook for Bash and Monitor: returns updatedInput whose command
// first sources wrap.sh, which sends the shell's stdout and stderr through
// filter.js, and then runs the original command unchanged in the same shell.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// Returns the wrapped command. The original follows a newline, byte for byte.
function wrap(command, mode, root = path.join(__dirname)) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const sh = quote(path.join(root, 'wrap.sh'));
  return `. ${sh} ${nonce} ${mode} || { printf '%s\\n' '[hush] output withheld: wrapper unavailable'; exit 125; }\n${command}`;
}

function main() {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  const input = payload && payload.tool_input;
  if (!input || typeof input.command !== 'string' || !input.command) return;
  const mode = payload.tool_name === 'Monitor' ? 'monitor' : 'bash';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, command: wrap(input.command, mode) } },
  }));
}

if (require.main === module) {
  try { main(); } catch (e) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[hush] command blocked: output wrapper failed (${(e && e.constructor && e.constructor.name) || 'Error'})`,
      },
    }));
  }
}

module.exports = { wrap, quote };
