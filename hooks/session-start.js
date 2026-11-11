#!/usr/bin/env node
'use strict';
// SessionStart hook (every source): appends the filter setup to the file named
// by CLAUDE_ENV_FILE. Claude Code sources that file in the shell that runs each
// Bash and Monitor command, ahead of the command, so the command text stays as
// written. The sourced line runs hooks/wrap.sh, which sends the shell's stdout
// and stderr through hooks/filter.js.
const fs = require('fs');
const path = require('path');

const MARK = ' # hush output filter';
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// The line this hook appends, one line so that bash messages and $LINENO
// shift as little as possible. The guard skips the setup when the shell has
// already run it, so a second copy of the line (another SessionStart, another
// copy of hush) does not stack a second filter.
function block(root = __dirname) {
  const sh = quote(path.join(root, 'wrap.sh'));
  return `[ "\${__hush_on-}" = "$$" ] || . ${sh} || { printf '%s\\n' '[hush] output withheld: wrapper unavailable'; exit 125; }${MARK}\n`;
}

// Appends the block to file unless the file already holds it. Keeps every line
// other hooks wrote. A hush line with another plugin path (left by an older
// version of hush in a resumed session) is dropped, because its wrap.sh may be
// gone and the line would then withhold the output of every command.
function install(file, root = __dirname) {
  const b = block(root);
  let old = '';
  try { old = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (old.split('\n').includes(b.slice(0, -1))) return false;
  const lines = old.split('\n');
  const kept = lines.filter((l) => !l.endsWith(MARK));
  if (kept.length !== lines.length) {
    const rest = kept.join('\n');
    fs.writeFileSync(file, (rest && !rest.endsWith('\n') ? `${rest}\n` : rest) + b);
    return true;
  }
  fs.appendFileSync(file, (old && !old.endsWith('\n') ? '\n' : '') + b);
  return true;
}

function main() {
  try { fs.readFileSync(0); } catch { /* the payload is not needed */ }
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file) {
    process.stdout.write(JSON.stringify({ systemMessage: '[hush] CLAUDE_ENV_FILE is not set: Bash and Monitor output is not filtered in this session, only successful tool results are.' }));
    return;
  }
  install(file);
}

if (require.main === module) {
  try { main(); } catch (e) {
    process.stdout.write(JSON.stringify({ systemMessage: `[hush] output filter not set up (${(e && e.constructor && e.constructor.name) || 'Error'}): Bash and Monitor output is not filtered in this session, only successful tool results are.` }));
  }
}

module.exports = { block, install, quote };
