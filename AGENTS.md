# AGENTS.md

hush is a Claude Code plugin (Node 22 or newer, no dependencies). A `PostToolUse` hook, `hooks/redact.js`, redacts secrets from the output of every tool. A `SessionStart` hook, `hooks/session-start.js`, appends a line to the file named by `CLAUDE_ENV_FILE`; Claude Code sources it before each Bash and Monitor command, and it runs `hooks/wrap.sh`, which sends the shell's output through `hooks/filter.js`. That covers failed commands, Monitor events, and background output without changing the command. A `PreToolUse` hook, `hooks/block.js` with `hooks/literal.js`, blocks Bash and Monitor commands that hold a literal password. `hooks/strict.js` masks every value in the output of the commands listed in `strictCommands`, on both paths; the filter learns the command from a header that `wrap.sh` writes. `CLAUDE.md` is a symlink to this file.

## Commands

- Tests: `npm test` (`node --test tests/*.test.js`)
- Config check and self-test: `node scripts/check.js`
- Add a pattern or strict command to the user config: `node scripts/add-pattern.js` (fake test line required)
- Register a known value from stdin: `node scripts/add-known.js`
- Scrub values from transcripts and task output: `node scripts/scrub.js` (dry run by default)
- Leak-response procedure for agents: `skills/respond-to-leak/SKILL.md`

## Rules

- No test or script ever prints a real value. Tests use values from `crypto.randomBytes`.
- The hook fails closed: on any error it withholds the output.
- No em or en dashes, no exclamation marks.
- Release: bump the version in `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`, and add a `CHANGELOG.md` entry.
