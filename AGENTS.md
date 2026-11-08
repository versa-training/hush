# AGENTS.md

hush is a Claude Code plugin (Node 22 or newer, no dependencies). One `PostToolUse` hook, `hooks/redact.js`, redacts secrets from Bash output. `CLAUDE.md` is a symlink to this file.

## Commands

- Tests: `npm test` (`node --test tests/*.test.js`)
- Config check and self-test: `node scripts/check.js`

## Rules

- No test or script ever prints a real value. Tests use values from `crypto.randomBytes`.
- The hook fails closed: on any error it withholds the output.
- No em or en dashes, no exclamation marks.
- Release: bump the version in `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`, and add a `CHANGELOG.md` entry.
