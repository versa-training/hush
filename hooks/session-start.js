#!/usr/bin/env node
'use strict';
// SessionStart hook (every source): appends the filter setup to the file named
// by CLAUDE_ENV_FILE. Claude Code sources that file in the shell that runs each
// Bash and Monitor command, ahead of the command, so the command text stays as
// written. The sourced line runs hooks/wrap.sh, which sends the shell's stdout
// and stderr through hooks/filter.js.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MARK = ' # hush output filter';
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const arg = (s) => (/^[\w./~-]+$/.test(s) ? s : quote(s));

// The line this hook appends, one line so that bash messages and $LINENO
// shift as little as possible. The guard skips the setup when the shell has
// already run it, so a second copy of the line (another SessionStart, another
// copy of hush) does not stack a second filter.
function block(root = __dirname) {
  const wrap = path.join(root, 'wrap.sh');
  const msg = `[hush] output withheld: wrapper unavailable: ${wrap} did not start the output filter. If hush was updated, moved, or removed, restart the claude process. Else check that node 22 or newer is on PATH and run node ${arg(path.join(path.dirname(root), 'scripts', 'check.js'))}`;
  return `[ "\${__hush_on-}" = "$$" ] || . ${quote(wrap)} || { printf '%s\\n' ${quote(msg)}; exit 125; }${MARK}\n`;
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

// Removes every hush line from file, keeping the lines other hooks wrote.
function uninstall(file) {
  let old;
  try { old = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  const lines = old.split('\n');
  const kept = lines.filter((l) => !l.endsWith(MARK));
  if (kept.length === lines.length) return false;
  fs.writeFileSync(file, kept.join('\n'));
  return true;
}

const executable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
const which = (name, env) => (env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, name)).find(executable) || null;

// The shell Claude Code runs Bash and Monitor commands in, picked the way
// Claude Code 2.1.310 picks it: CLAUDE_CODE_SHELL when its path names bash or
// zsh and it can run; else $SHELL when it names bash or zsh and can run; else
// the first bash or zsh found on PATH or in /bin, /usr/bin, /usr/local/bin,
// /opt/homebrew/bin, bash first when $SHELL names bash, zsh first otherwise.
function claudeShell(env = process.env) {
  const o = env.CLAUDE_CODE_SHELL;
  if (o && (o.includes('bash') || o.includes('zsh')) && executable(o)) return o;
  const sh = env.SHELL;
  const bashFirst = Boolean(sh && sh.includes('bash'));
  const dirs = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
  const list = (bashFirst ? ['bash', 'zsh'] : ['zsh', 'bash']).flatMap((n) => dirs.map((d) => `${d}/${n}`));
  const wz = which('zsh', env);
  const wb = which('bash', env);
  if (bashFirst) { if (wb) list.unshift(wb); if (wz) list.push(wz); } else { if (wz) list.unshift(wz); if (wb) list.push(wb); }
  if (sh && (sh.includes('bash') || sh.includes('zsh')) && executable(sh)) list.unshift(sh);
  return list.find(executable) || null;
}

// [major, minor] of the bash that `shell` is, or null when it is not bash.
function bashVersion(shell) {
  const env = { ...process.env };
  for (const k of ['BASH_VERSION', 'BASH_ENV', 'ENV']) delete env[k];
  const r = spawnSync(shell, ['-c', 'printf %s "${BASH_VERSION-}"'], { env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  const m = /^(\d+)\.(\d+)/.exec(r.stdout || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// Returns null when shell is bash 4.1 or newer, else the reason the filter cannot run there.
function unsupported(shell) {
  if (!shell) return 'Claude Code found no bash or zsh';
  const v = bashVersion(shell);
  if (!v) return `Claude Code runs Bash and Monitor commands with ${shell}, which is not bash`;
  if (v[0] > 4 || (v[0] === 4 && v[1] >= 1)) return null;
  return `Claude Code runs Bash and Monitor commands with ${shell}, which is bash ${v.join('.')}`;
}

function main() {
  try { fs.readFileSync(0); } catch { /* the payload is not needed */ }
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file) {
    process.stdout.write(JSON.stringify({ systemMessage: '[hush] CLAUDE_ENV_FILE is not set: Bash and Monitor output is not filtered in this session, only successful tool results are.' }));
    return;
  }
  const why = unsupported(claudeShell());
  if (why) {
    uninstall(file);
    process.stdout.write(JSON.stringify({ systemMessage: `[hush] output filter off: ${why}, and the filter needs bash 4.1 or newer. Only successful tool results are redacted; failed commands, Monitor events, and background output are not. To turn the filter on, set CLAUDE_CODE_SHELL to the path of bash 4.1 or newer and restart claude.` }));
    return;
  }
  install(file);
}

if (require.main === module) {
  try { main(); } catch (e) {
    process.stdout.write(JSON.stringify({ systemMessage: `[hush] output filter not set up (${(e && e.constructor && e.constructor.name) || 'Error'}): Bash and Monitor output is not filtered in this session, only successful tool results are.` }));
  }
}

module.exports = { block, install, uninstall, quote, claudeShell, bashVersion, unsupported };
