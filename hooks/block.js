#!/usr/bin/env node
'use strict';
// PreToolUse hook for Bash and Monitor: blocks a command that holds a literal
// password (exit 2, message on stderr). Rewrites nothing, so it composes with
// other PreToolUse hooks. The message names the rule and, for a value of
// minLength or more characters, its sha8; never the value.
const fs = require('fs');

let payload;
try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
const command = payload && payload.tool_input && payload.tool_input.command;
if (typeof command !== 'string' || !command) process.exit(0);

// True when the command writes a file: a redirection to a path (not to an
// fd or /dev/null), or tee.
const writesFile = (c) => /(?:^|[^<>&\d])\d?>>?\|?[ \t]*(?![&( \t]|\/dev\/(?:null|stdout|stderr|tty)\b)\S/.test(c)
  || /(?:^|[\s|;&(])tee(?:\s+-[A-Za-z-]+)*\s+[^\s|;&>-]/.test(c);

function main() {
  const { loadConfig, allowSet } = require('./hush-lib');
  const cfg = loadConfig();
  if (cfg.blockLiterals === false) return 0;
  // A command longer than MAX_COMMAND is checked on its first and its last MAX_COMMAND characters.
  const { slices } = require('./strict');
  const { findLiterals } = require('./literal');
  const allow = allowSet(cfg);
  const found = slices(command).flatMap((part) => findLiterals(part, cfg, allow));
  if (!found.length) return 0;
  const f = found[0];
  const sha = f.length >= cfg.minLength ? ` sha:${f.sha}` : '';
  const more = found.length > 1 ? ` and ${found.length - 1} more` : '';
  process.stderr.write(`[hush] blocked: literal password in the command (rule ${f.rule}${sha}${more}). Read it from an environment variable or a file instead, for example: ${f.fix}\n`
    + '[hush] Never write the value itself into a command. A public value can be allowed by its sha in allowLiterals; blockLiterals: false turns this check off.\n'
    + (writesFile(command) ? '[hush] Example code with a sample credential can be written to a file with the Write tool, or with a placeholder such as changeme.\n' : ''));
  return 2;
}

let code;
try { code = main(); } catch (e) {
  const { failure } = require('./hush-lib');
  process.stderr.write(`${failure('blocked: the literal password check failed', e)} The Edit and Write tools are not blocked by this check.\n`);
  code = 2;
}
process.exit(code);
