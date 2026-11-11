---
name: respond-to-leak
description: Respond to a secret that hush did not redact. Use for "unredacted secret", "secret leaked", "hush missed", "password in output", or when a human reports a visible credential.
---

# Respond to a leaked secret

The commands below name the hush plugin directory, the one that holds `scripts/` and `hooks/`. Claude Code fills in that path when it loads this skill, so they run as written.

Never print, quote, or summarize the value. Never put it in a command, reply, ticket, commit, brief, or file. Refer to it by sha8 fingerprint or by where it came from.

## 1. Stop spreading

- Do not repeat the value, even to confirm it. Do not run `printf %s "$VALUE" | ...` or any command that holds the value as text.
- To get a fingerprint, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/scrub.js" --dry-run --known --path <transcript>`: it reads the values from the places hush knows and prints `sha:xxxxxxxx` only.
- Otherwise describe the secret by its source: file, or host and service.

## 2. Classify the miss

Run each test, in order, until one explains the leak.

| Miss | Test |
| --- | --- |
| hush not running in this process | Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check.js"` (fake values only). Then run a command that prints a fake `HUSH_TEST_TOKEN=<random 24 hex>`: no `[hush` placeholder means the hooks are not active. A process started before the plugin was installed needs a restart; `/clear` is not enough. |
| known value missing from the listed files | `check.js` lists each file in `files` with a value count. The leaking value's source file is absent, missing, or shows 0 values. |
| unanticipated shape | The source is a file or output that `files` does not cover, and no pattern in `check.js` fits the text around the value. |
| command that dumps configuration | The command printed whole structures (`docker inspect`, `env`, `kubectl get secret`, a CLI `show config`) and no `strictCommands` entry matches it. |
| path hush cannot cover | The value came in a pasted prompt, a file the human attached, or the model's own command text. Hooks see tool output, not the human's prompt. |

## 3. Update detection

Do this without asking. Use fake values only; never the leaked one.

- Unanticipated shape: write one line with the same shape and a random fake value to a temp file, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/add-pattern.js" --name <name> --regex '<source>' --test-file <file>`. It refuses a pattern that does not redact the line, is invalid, matches the empty string, or is slow. Add `--dry-run` to preview.
- Dumping command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/add-pattern.js" --strict-command '<regex>' --test-file <file with a sample command>`.
- Known remote secret: tell the human to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/add-known.js"` and pipe the value on stdin. The agent never handles the value. The script prints only the sha8 and a count.
- Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check.js"`. It must print `self-test: ok`.

## 4. Scrub

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/scrub.js" --dry-run --known --path <session>.jsonl --path <session>/subagents --path <session>/tool-results`. For a value not in the known files, the human pipes it on stdin instead of `--known`.
2. Check that the dry run lists only the expected fingerprints. Then run the same command with `--apply`.
3. The script skips files modified in the last 60 seconds, so the running session's own transcript stays unchanged. Tell the human to rerun with `--apply` after the session ends, or use `--include-active` only when no session writes to the file.
4. A value split across two lines or records is not found.

## 5. Record

Write one ticket or note for the human with:
- the fingerprint (sha8);
- the source (file, or host and service; no value);
- the leak path from step 2;
- what was added to detection;
- what was scrubbed, by file and count;
- the open question: rotate the secret? Rotation is the human's decision.

## 6. Propose a shipped default

If the new pattern or command is general, file an issue or ticket for the hush repository with the regex and a fake example line. Do not include the leaked value.

## Prevent

- Read secrets from environment variables or files. Never write them as literals in a command; hush blocks those.
- Select fields instead of dumping a whole configuration: `jq '.Config.Image'`, not `docker inspect`.
