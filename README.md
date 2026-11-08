# hush

A Claude Code plugin that redacts secrets from Bash tool output before the model sees it. The model and the transcript get the redacted text. Node 22 or newer, no dependencies, MIT.

## What it does

A `PostToolUse` hook runs after each Bash call and replaces secrets in stdout and stderr with `[hush NAME sha:xxxxxxxx]`. `sha` is the first 8 hex of the SHA-256 of the value, so you can tell two secrets apart. When something was redacted, the output ends with `[hush] redacted N secret(s)`. Each redacting call adds one line of counts, never values, to `~/.local/state/hush/log.jsonl`.

Two sources:

- Known values: every value of at least `minLength` characters in the files you list (dotenv or JSON), replaced first, longest first.
- Patterns: regexes for env-style assignments, JWTs, database URL passwords, DSNs, PEM private keys, GitHub, Anthropic, OpenAI, AWS, Google, Slack, Stripe tokens, and Bearer headers.

## Install as a local plugin

    claude --plugin-dir /path/to/hush

## Config

Defaults are in `hush.default.json`. Your file is `$HUSH_CONFIG` or `~/.config/hush/config.json`. Its lists are appended to the defaults.

    {
      "files": ["~/project/.env*", "~/project/secrets.json"],
      "patterns": [{ "name": "internal", "regex": "corp_[a-z0-9]{24}" }],
      "allow": ["1a2b3c4d"],
      "minLength": 12
    }

- `files`: `~` and `*` within one path segment work. A missing file is skipped.
- `patterns`: JavaScript regex source, flag `g`. With a capture group, only the group is replaced.
- `allow`: sha8 fingerprints of public values to keep.

Run `node scripts/check.js` to see what loads and to run a self-test.

## Fails closed

Claude Code ignores a malformed hook output and shows the original text. So if the hook throws after it read a payload with output, it prints a valid output that withholds everything: `[hush] output withheld: redaction failed (<error class>)`. An unparseable payload exits silently.

## What it does not catch

- Encoded values, such as base64.
- Slices shorter than `minLength`.
- Values outside the listed files that match no pattern.
- Output of tools other than Bash.
- Telemetry, which sees the original output.

## Non-secret values

A value of `minLength` or more characters in a listed file is redacted even when it is not secret, for example a region name in a `.env` file. Copy the sha from its placeholder into `allow` to keep it. A listed file with no `NAME=value` lines counts as one value named after the file.
