# AGENTS.md

hush is a Claude Code plugin (Node 22 or newer, no dependencies). A `PostToolUse` hook, `hooks/redact.js`, redacts secrets from the output of every tool. A `PreToolUse` hook for Bash and Monitor, `hooks/wrap.js`, rewrites the command so its output streams through `hooks/filter.js` (set up by `hooks/wrap.sh`), which covers failed commands, Monitor events, and background output. `CLAUDE.md` is a symlink to this file.

## Commands

- Tests: `npm test` (`node --test tests/*.test.js`)
- Config check and self-test: `node scripts/check.js`

## Rules

- No test or script ever prints a real value. Tests use values from `crypto.randomBytes`.
- The hook fails closed: on any error it withholds the output.
- No em or en dashes, no exclamation marks.
- Release: bump the version in `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`, and add a `CHANGELOG.md` entry.
