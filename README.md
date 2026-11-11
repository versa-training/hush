<div align="center">

# hush

**A Claude Code plugin that redacts secrets from the output of every tool before the model sees it. Powered by [versa](https://versa.training)**

<a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.0-blue?style=flat-square" alt="version 0.2.0"></a>
<a href="package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522-blue?style=flat-square" alt="Node 22 or newer"></a>
<a href="#install"><img src="https://img.shields.io/badge/Claude_Code-plugin-d97757?style=flat-square" alt="Claude Code plugin"></a>
<a href="package.json"><img src="https://img.shields.io/badge/dependencies-0-555?style=flat-square" alt="no dependencies"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT license"></a>

<table>
<tr>
<td align="center" width="33.3%"><h3>Every tool</h3>Bash, Read, Grep, MCP tools, and the rest pass through a <code>PostToolUse</code> hook; Bash and Monitor output is also filtered as it streams</td>
<td align="center" width="33.3%"><h3>13 patterns</h3>plus every known value from the dotenv and JSON files you list</td>
<td align="center" width="33.3%"><h3>Withheld on error</h3>if redaction throws, the output is withheld, never passed through</td>
</tr>
</table>

**[What it does](#what-it-does) · [Output filter](#output-filter) · [Install](#install) · [Config](#config) · [Fails closed](#fails-closed) · [Limits](#limits) · [Development](#development)**

</div>

## What it does

The hook runs after every tool call. It walks the tool response, keeps its shape and its non-string fields, and replaces each secret in every string with a placeholder. The model and the transcript get the redacted text.

```text
STRIPE_KEY=[hush STRIPE_KEY sha:9f2c4e1a]
DATABASE_URL=[hush DATABASE_URL sha:51d0b7c3]
[hush] redacted 2 secret(s)
```

- The placeholder is `[hush NAME sha:xxxxxxxx]`. `sha` is the first 8 hex digits of the SHA-256 of the value, so you can tell two secrets apart. A pattern match shorter than `minLength` gets no `sha`.
- For Bash, stdout ends with `[hush] redacted N secret(s)` when something was redacted. Other tools get no notice, so their shape stays intact.
- MCP tools are answered through `updatedMCPToolOutput`, all other tools through `updatedToolOutput`.
- Each call that redacts something appends one line to `~/.local/state/hush/log.jsonl` (or `$HUSH_LOG`): time, tool, and counts per name, never values.

hush finds secrets from two sources, in this order:

| Source | What is redacted |
|---|---|
| Known values | Values of `minLength` characters or more from the files you list, longest first. |
| Patterns | Env-style assignments, JWTs, database URL passwords, DSNs, PEM private keys, Bearer headers, and GitHub, Anthropic, OpenAI, AWS, Google, Slack, and Stripe tokens. |

## Output filter

Claude Code lets a `PostToolUse` hook replace the output of a successful call only. A Bash command that exits non-zero, a Monitor event, and the output file of a background command never pass through it. So hush also filters Bash and Monitor output at the source, without changing the command.

A `SessionStart` hook, `hooks/session-start.js`, runs for every source (`startup`, `resume`, `clear`, `compact`) and appends one line to the file named by `CLAUDE_ENV_FILE`:

```text
[ "${__hush_on-}" = "$$" ] || . '<plugin>/hooks/wrap.sh' || { printf '%s\n' '[hush] output withheld: wrapper unavailable'; exit 125; } # hush output filter
```

Claude Code sources that file in the shell that runs each Bash and Monitor command, before the command, also in subagents and in sessions started in a worktree. `wrap.sh` sends that shell's stdout and stderr through `hooks/filter.js`, which redacts each line with the same known values, patterns, allow list, and placeholders as the `PostToolUse` hook. At exit it waits until the filter has written everything. The command text stays as the model wrote it, so other `PreToolUse` hooks that rewrite commands and permission rules see and match the original command, and its exit code, `cd`, `set -e`, heredocs, quotes, comments, `exit`, and `&` jobs behave as before.

- Bash output ends with `[hush] redacted N secret(s)` when the filter redacted something. The `PostToolUse` hook then finds nothing left and adds nothing.
- Monitor events are redacted line by line, with no notice. A line is written as soon as it ends; a partial line after 250 ms of silence. `wrap.sh` tells the two apart by stdout: a regular file for Bash, a socket for Monitor.
- The hook never truncates the file: it appends, keeps every line other hooks wrote, and writes nothing when its line is already there. A second copy of the line, from another copy of hush, does not start a second filter. In a resumed session it replaces a hush line with another plugin path, left by an older version.
- Fails closed: if `node`, `wrap.sh`, or `filter.js` is missing, or the shell is not bash 4.1 or newer, the command does not run, the output is the one line above, and the exit code is 125. If the filter throws or dies, the output from then on is `[hush] output withheld: ...` and the exit code is 125.
- Cost, measured as the median of 20 calls: about 30 ms added to a call with no output and about 37 ms to a call with 1 MB of output.

Limits of the filter:

- It starts with the next session: the hook has to run before the first command. When `CLAUDE_ENV_FILE` is not set or the hook fails, the session shows a `[hush]` message and only successful tool results are redacted.
- Claude Code does not source the env file for commands it runs with credential variables scrubbed (`scrubCredentialEnv`, used when a remote session runs commands on this machine) or for the PowerShell tool. There only successful results are redacted. For PowerShell, Claude Code takes variables from the env file only when every line is a plain assignment, so the hush line also drops the variables that other hooks set there.
- stdout and stderr arrive merged, in the order written. Claude Code merges them for Bash anyway.
- NUL bytes are dropped and invalid UTF-8 becomes U+FFFD.
- Bash messages and `$LINENO` name a line one higher than without an env file, as with any one-line env file. `$!` before the first `&` job holds the filter's starter pid instead of being empty.
- A line longer than 64 KB is cut at a space where it can be, keeping its last 4 KB for the next part. A value longer than 4 KB that crosses a cut is split. A PEM private key block is held until its end line, up to 64 KB.
- A command that sets its own `EXIT` trap or ends with `exec` returns before the filter is done: the model gets the output only partly or not at all, never unredacted. What arrives later in the output file is redacted.

## Install

From the GitHub marketplace, which needs read access to this repository:

```text
/plugin marketplace add versa-training/hush
/plugin install hush@hush
```

As a local plugin from a clone:

```text
claude --plugin-dir /path/to/hush
```

You need Node 22 or newer on PATH.

Plugins load when a claude process starts: after installing or updating hush, restart every running claude process; `/clear` is not enough.

## Config

The defaults are in [`hush.default.json`](hush.default.json). Your file is `$HUSH_CONFIG` or `~/.config/hush/config.json`. Its `files`, `patterns`, and `allow` lists are appended to the defaults; its `minLength` replaces the default of 12.

```json
{
  "files": ["~/project/.env*", "~/project/secrets.json"],
  "patterns": [{ "name": "internal", "regex": "corp_[a-z0-9]{24}" }],
  "allow": ["1a2b3c4d"],
  "minLength": 12
}
```

| Key | Meaning |
|---|---|
| `files` | Files to read known values from. `~` and `*` within one path segment work. A missing file is skipped. |
| `patterns` | JavaScript regex source, run with flag `g`. With capture groups, only the first group is replaced. |
| `allow` | sha8 fingerprints of public values to keep. |
| `minLength` | Shortest known value to redact. |

How listed files are read:

- A file ending in `.json`, or starting with `{`, is JSON. hush takes string values whose key contains `key`, `token`, `secret`, `pass`, `auth`, `dsn`, `cred`, or `bearer`, in any case, and for such a value also the token after `Bearer`. Strings inside arrays are not read.
- Any other file is dotenv: `NAME=value` lines, with optional `export`, quotes, and `#` comments.
- A non-JSON file with no `NAME=value` line that has a value counts as bare values: each line, and the whole text if it has several lines, named after the file.

### Check your setup

```text
node /path/to/hush/scripts/check.js
```

In a clone, `npm run check` runs the same script. It lists each listed file as exists or missing, with its value count, counts patterns, allow entries, and known values, and runs a self-test with a random fake token. It never prints a value.

## Fails closed

Claude Code ignores a malformed hook output and shows the original text. So when the hook throws after reading a payload with a tool response, for example on a malformed config, it prints a valid output of the same shape with every string replaced by:

```text
[hush] output withheld: redaction failed (<error class>)
```

A plain string response is replaced by that text. The hook exits silently, leaving the output unchanged, on an unparseable payload, a payload without a response, or a response whose strings are all shorter than `minLength`. With a malformed config, only a response whose strings are all empty exits silently.

## Limits

hush does not catch:

- Encoded values, such as base64.
- Slices of a known value shorter than `minLength`.
- Values outside the listed files that match no pattern.
- Image or binary content that is not text: base64 strings are scanned, pixels are not.
- Telemetry, which sees the original output.
- A hook that times out (10 seconds) or cannot start, for example when `node` is not on PATH: fail closed covers only an error the hook throws.

### Non-secret values

A value of `minLength` characters or more in a listed file is redacted even when it is not secret, for example a region name in a `.env` file. To keep it, copy the sha from its placeholder into `allow`.

### Read dedup

Claude Code answers a repeated Read of an unchanged file with a content-free `file_unchanged` result, so the model only ever holds the first, redacted read.

## Development

```text
npm test                 # node --test tests/*.test.js
node scripts/check.js    # config status and self-test
```

Tests never print a real value; they use values from `crypto.randomBytes`. A release bumps the version in `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`, and adds a [`CHANGELOG.md`](CHANGELOG.md) entry.

## License

[MIT](LICENSE)
