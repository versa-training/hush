# Changelog

## 0.3.0

- An output filter, set up from `CLAUDE_ENV_FILE`, redacts Bash and Monitor output at the source: failed commands, Monitor events, and background output. Needs bash 4.1 or newer; for other shells it is off with a message.
- A `PreToolUse` hook blocks Bash and Monitor commands that hold a literal password, with the rule, a sha8, and a fix.
- Strict masking hides every value in the output of commands that dump configuration (`strictCommands`).
- Password argument patterns, plain and as argv lists; placeholders and file paths are kept.
- The `respond-to-leak` skill and the scripts `add-pattern.js`, `add-known.js`, and `scrub.js`.
- Error messages name the file at fault and the recovery step. An unreadable listed file fails closed.
- Plugins load when a claude process starts: restart every running claude process after updating; `/clear` is not enough.

## 0.2.0

- The hook runs for every tool (matcher `*`), not only Bash. It redacts every string in the response, keeps the shape, and answers MCP tools through `updatedMCPToolOutput`.
- Fails closed for every shape. A response with no string of `minLength` or more exits silently.

## 0.1.0

- First release. A `PostToolUse` hook for Bash redacts known values from listed dotenv and JSON files and values that match 13 default patterns. It fails closed.
- `scripts/check.js` shows the loaded files and runs a self-test.
