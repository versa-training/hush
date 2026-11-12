# AGENTS.md

hush is a Claude Code plugin (Node 22 or newer, no dependencies). A `PostToolUse` hook, `hooks/redact.js`, redacts secrets from the output of every tool. A `SessionStart` hook, `hooks/session-start.js`, appends a line to the file named by `CLAUDE_ENV_FILE`; Claude Code sources it before each Bash and Monitor command, and it runs `hooks/wrap.sh`, which sends the shell's output through `hooks/filter.js`. That covers failed commands, Monitor events, and background output without changing the command. A `PreToolUse` hook, `hooks/block.js` with `hooks/literal.js`, blocks Bash and Monitor commands that hold a literal password. `hooks/strict.js` masks every value in the output of the commands listed in `strictCommands`, on both paths; the filter learns the command from a header that `wrap.sh` writes. `session-start.js` writes the line only when the shell Claude Code runs commands in is bash 4.1 or newer; otherwise it shows a message and only the `PostToolUse` hook redacts. `filter.js` never cuts a long line inside a match, and on idle it holds a partial last word, an open PEM block, and argv lines, then redacts the rest of a line together with the part already written. Every error message names the file at fault and the recovery step (`failure()` in `hooks/hush-lib.js`), never the error text. `CLAUDE.md` is a symlink to this file.

## Commands

- Tests: `npm test` (`node --test tests/*.test.js`)
- Config check and self-test: `node scripts/check.js`
- Add a pattern or strict command to the user config: `node scripts/add-pattern.js` (fake test line required)
- Register a known value from stdin: `node scripts/add-known.js`
- Scrub values from transcripts and task output: `node scripts/scrub.js` (dry run by default)
- Leak-response procedure for agents: `skills/respond-to-leak/SKILL.md`

## Rules

- No test or script ever prints a real value. Tests use values from `crypto.randomBytes`.
- The hook fails closed: on any error it withholds the output, with a message that names the file and how to recover.
- Regexes on commands or output run in linear time: every open repeat in the middle of a regex has a bound. `tests/regex-time.test.js` times each shipped regex on 32 KB and 1 MB of adversarial input built from its own literal fragments, and the functions that run them at 64 KB: under 250 ms each. Commands are matched on their first 64 KB (`MAX_COMMAND` in `hooks/strict.js`), so a slow user regex cannot hang a hook on a huge command.
- The respond-to-leak skill names scripts as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.js"`: Claude Code fills in the path when it loads the skill; the Bash tool has no such variable.
- No em or en dashes, no exclamation marks.
- Release: bump the version in `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`, and add a `CHANGELOG.md` entry.
