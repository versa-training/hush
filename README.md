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
<td align="center" width="33.3%"><h3>28 patterns</h3>plus every known value from the dotenv and JSON files you list</td>
<td align="center" width="33.3%"><h3>Withheld on error</h3>if redaction throws, the output is withheld, never passed through</td>
</tr>
</table>

**[What it does](#what-it-does) · [Password arguments](#password-arguments) · [Literal block](#literal-block) · [Strict commands](#strict-commands) · [Output filter](#output-filter) · [Install](#install) · [Config](#config) · [Fails closed](#fails-closed) · [Limits](#limits) · [Development](#development)**

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
| Patterns | Env-style assignments, JWTs, URL passwords, DSNs, PEM private keys, Bearer and Basic headers, password arguments, and GitHub, Anthropic, OpenAI, AWS, Google, Slack, and Stripe tokens. |

## Password arguments

Fifteen patterns find a password given as a command argument, in any output: a shell command in a log, a process list, or `docker inspect`. They run for every tool, like the other patterns, and replace only the value.

| Pattern | Finds the value in |
|---|---|
| `redis-cli-a` | `redis-cli ... -a <value>` and `--pass <value>` |
| `pass-flag` | `--password <value>`, `--password=<value>`, `--pass`, `--http-password`, `--ftp-password`, `--proxy-password` |
| `requirepass` | `requirepass <value>`, `masterauth <value>`, also as `--requirepass` |
| `pgpassword` | `PGPASSWORD=<value>` |
| `mysql-p` | `-p<value>` after `mysql`, `mariadb`, `mysqldump`, or `mysqladmin` |
| `sshpass` | `sshpass -p <value>` |
| `curl-user` | `curl ... -u user:<value>` and `--user user:<value>` |
| `basic-auth` | `Authorization: Basic <value>` |
| `url-password-any` | `user:<value>@` in `redis`, `rediss`, `amqp`, `amqps`, `mongodb`, `mongodb+srv`, `http`, `https`, `ftp`, `smtp`, and `smtps` URLs |
| `argv-redis-cli`, `argv-pass-flag`, `argv-requirepass`, `argv-mysql-p`, `argv-sshpass`, `argv-curl-user` | The same arguments as a list of JSON strings, as `docker inspect` prints a command: `"redis-cli", "-a", "<value>"`, `"--requirepass", "<value>"`, also with newlines between the elements |

- A value must have 6 or more characters. One that starts with `$`, a backtick, `[`, or `<` is left alone (after a flag also one that starts with `-`), so `-a "$REDIS_PASSWORD"`, `${VAR}`, `$(cat file)`, and hush's own placeholders stay as they are. The `env` and URL password patterns also leave `$VAR`, `${VAR}`, and `$(...)` alone.
- The output filter sends each line as soon as it ends, but a pretty-printed JSON array puts a flag and its value on separate lines. So the filter holds a run of lines that are JSON string elements followed by a comma until a line that is not one arrives, and redacts the run together with that line, up to 64 KB. A Monitor event of such lines arrives with the next line, or after 250 ms of silence.
- `url-password-any`, `requirepass`, and `pass-flag` keep a value that is a placeholder or a file path, by the same rules as the [literal block](#literal-block): `https://user:password@host`, `--password <password>`, `requirepass foobared` (the default in the `redis.conf` that Redis ships), `grep requirepass /etc/redis`. A pattern in your config gets the same rule with `"skipPlaceholders": true`.
- A command that lists a flag and its value as YAML list items (`- --requirepass` then `- <value>`) is not caught by these patterns; `docker compose config` output is covered by [strict commands](#strict-commands).

## Literal block

A `PreToolUse` hook, `hooks/block.js`, checks the text of every Bash and Monitor command before it runs. A command that holds a literal password does not run: the hook exits 2, and the model gets a two-line message (three when the command writes a file, below) that names the rule, shows how to read the value from a variable or a file, and never repeats the value. The hook rewrites nothing, so it works next to other `PreToolUse` hooks.

```text
[hush] blocked: literal password in the command (rule redis-cli). Read it from an environment variable or a file instead, for example: REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ..., or redis-cli -a "$REDIS_PASSWORD"
[hush] Never write the value itself into a command. A public value can be allowed by its sha in allowLiterals; blockLiterals: false turns this check off.
```

| Rule | Blocked shape | The message suggests |
|---|---|---|
| `redis-cli` | `redis-cli -a <value>`, `--pass <value>` | `REDISCLI_AUTH`, or `-a "$REDIS_PASSWORD"` |
| `requirepass` | `requirepass <value>`, `masterauth <value>` | `--requirepass "$REDIS_PASSWORD"` |
| `password-flag` | `--password=<value>`, `--password <value>`, `--pass`, `--http-password` and the like | `--password="$DB_PASSWORD"` or a password file |
| `mysql-p` | `-p<value>` after a MySQL or MariaDB tool | `MYSQL_PWD`, or `--defaults-extra-file` |
| `sshpass` | `sshpass -p <value>` | `sshpass -e` with `SSHPASS`, or `sshpass -f` |
| `curl-user` | `curl -u user:<value>`, `--user user:<value>` | `curl -u "user:$API_PASSWORD"`, or `--netrc-file` |
| `authorization` | an `Authorization:` header with a literal token in a `curl` or `wget` command | `-H "Authorization: Bearer $API_TOKEN"`, or `-H @file` |
| `env-password` | `NAME=<value>` where `NAME` contains `PASSWORD`, `PASSWD`, `TOKEN`, `SECRET`, `API_KEY`, `APIKEY`, or `AUTH` (not `AUTHOR`), and `PGPASSWORD`, `MYSQL_PWD`, `REDISCLI_AUTH`, `SSHPASS`: inline before a command, after `env` or `export`, and in `docker run -e`, `--env`, `--env=`. Not a name ending in a setting word such as `_FILE`, `_PATH`, `_URL`, `_HOST`, `_USER`, `_NAME`, `_PROVIDER`, `_ID` | `PGPASSFILE`, or a variable |
| `conn-password` | `password=<value>`, `passwd=`, `pwd=` in a connection string, such as `psql "host=db password=<value>"` | a `PGPASSFILE` or `~/.pgpass`, or a variable |
| `redis-auth` | `redis-cli ... AUTH <value>` and `AUTH <user> <value>` | `AUTH "$REDIS_PASSWORD"`, or `REDISCLI_AUTH` |
| `httpie-auth` | `http -a user:<value>`, `--auth`, also `https`, `xh`, `xhs` | `http -a "user:$API_PASSWORD"`, or `~/.netrc` |
| `url-password` | `scheme://user:<value>@host` with any scheme | `${DB_PASSWORD}` in the URL, or a URL read from a file |

The hook reads the command the way the shell does: it removes quotes, treats `$VAR`, `${...}`, `$(...)`, and backticks as substitutions, and also checks the text inside `$(...)`, inside quoted strings (`ssh host "..."`, `bash -c '...'`), heredocs, and comments. A finding needs a value of 6 or more characters. It does not block:

- A substitution anywhere in the value: `-a "$REDIS_PASSWORD"`, `-u "user:$PASS"`, `"$(cat file)"`, also inside an inner quoted command.
- A placeholder: `<password>`, `{{x}}`, `[hush ...]`, `xxx`, `***`, `...`, the words `changeme`, `password`, `secret`, `example`, `token`, and the like, any value that contains `example`, and an all-caps name with an underscore such as `REDIS_PASSWORD` (a variable written without `$`).
- A file path such as `/etc/redis/redis.conf` or `scripts/deploy.sh`, so `grep requirepass /etc/redis` passes.
- `psql --password <database>`: for `psql` and the other PostgreSQL tools `--password` takes no value.
- A value whose sha8 is in `allow` or `allowLiterals`. The default `allowLiterals` holds the fingerprint of the well-known local Postgres and Supabase default password.
- Prose: an all-lowercase word (letters only) in the value position, inside a quoted message with spaces, given to `echo`, `printf`, `git commit -m`, `git tag -m`, or `gh pr create --title`/`--body`. So `git commit -m "feat: support --password option in cli"` passes, and `git commit -m "fix: redis-cli -a <mixed value>"` is still blocked.

A command that only mentions a shape for documentation, in an `echo` string or a heredoc, is blocked when the value position holds a literal of 6 or more characters that is not a placeholder: `echo 'redis-cli -a s3cr3tvalue'` is blocked, `echo 'redis-cli -a <password>'` is not. The message shows the sha8 only for a value of `minLength` characters or more. When the blocked command writes a file (a redirection to a path, or `tee`), the message has a third line:

```text
[hush] Example code with a sample credential can be written to a file with the Write tool, or with a placeholder such as changeme.
```

A command longer than 64 KB is checked on its first 64 KB. Set `"blockLiterals": false` in your config to turn the block off. The hook fails closed: when it cannot load the config, it blocks the command with a message that names the file and the step to recover, never a value, for example `[hush] blocked: the literal password check failed (SyntaxError in ~/.config/hush/config.json). Fix or remove ~/.config/hush/config.json, then run node <plugin>/scripts/check.js.`; the Edit and Write tools are not blocked by it. An unparseable payload passes. Cost: one `node` start per Bash and Monitor call, about 28 ms (median of 20).

The block cannot take a value back out of the transcript: the model wrote it into its tool call before the hook ran. It stops the command, so the value does not reach the process list, the shell history, or the output, and it teaches the model the variable form for the next command.

## Strict commands

Some commands print a whole configuration: every environment variable of a container, a Kubernetes secret, a dotenv file. For those, hush masks every value, not only the ones it can recognize, and keeps names and structure, so the model still sees which settings exist.

`strictCommands` in the config is a list of regexes, run on the command text with flag `m`. The defaults:

| Regex matches | For example |
|---|---|
| `docker` or `podman` `inspect`, also `container`, `image`, `network`, `volume inspect`, also after global options | `docker inspect redis`, `docker --context prod inspect app` |
| `docker compose config`, `docker-compose config`, `podman-compose config` | `docker compose -f prod.yml config` |
| bare `env` or `printenv` (no arguments), also as `/usr/bin/env` or `/bin/env`, after `sudo` or `command` | `env`, `env \| sort`, `command env` |
| bare `env` or `printenv` run in a container or pod with `docker exec`, `docker run`, `podman`, or `kubectl exec ... --` | `docker exec app env`, `kubectl exec app -- printenv` |
| bare `set` | `set` |
| bare `export`, `declare`, `typeset`, with flags only | `export -p`, `declare -x` |
| `clever env` | `clever env --add-export` |
| `kubectl get` or `describe` of `secret` or `secrets` | `kubectl get secret db -o yaml` |
| `systemctl show` with `Environment`, `systemctl show-environment` | `systemctl show app -p Environment` |
| `cat`, `less`, `more`, `head`, `tail`, `bat`, `grep`, `rg`, `sed`, `awk` of a file named `.env*`, except `.env.example`, `.env.sample`, and `.env.template` | `cat next/.env.local`, `grep TOKEN .env` |
| `ps` with a BSD-style option word that holds `e`, among its first four arguments | `ps auxe`, `ps eww 1` |
| `/proc/<pid>/environ` | `cat /proc/1/environ` |
| `history` | `history \| tail` |

A default looks at most 256 characters past the command name (200 for the `.env` readers), so it runs in linear time. The command is matched on its first 64 KB. Your config's `strictCommands` are appended, for example `["\\bvault\\s+read\\b"]`.

The output of a matching command gets these rules on top of the normal detection. A value is:

- (a) the right-hand side of `NAME=value`: a whole line (also after `export`, `declare -x`, or a YAML `- `) to its end, a JSON string `"NAME=value"` to its closing quote, and elsewhere up to whitespace or a quote;
- (b) a JSON or YAML string value whose key contains `pass`, `secret`, `token`, `key`, `auth`, `credential`, `dsn`, `cookie`, or `session` (any case), and every value in a `data:`, `stringData:`, `binaryData:` (Kubernetes secret, base64 values included), or `environment:` (Compose) block;
- (c) in an argv list, a JSON array or YAML list under `Cmd`, `Entrypoint`, `Args`, `Test`, or `Command`, or a JSON array whose first element is `CMD` or `CMD-SHELL`: every element after the first that follows an element starting with `-` (unless it is itself a flag), the part after `=` of a `--flag=value` element, and in a `CMD-SHELL` string every word after a flag;
- (d) any other word of 20 or more characters with high variety: at least three of lower case, upper case, digit, and other characters, one of them a digit. Not masked: `sha256:` digests, hex IDs, UUIDs, and MAC addresses (hex digits and separators only), timestamps, paths, image references, and URLs without credentials.

A masked value reads `[hush strict sha:xxxxxxxx]`, or `[hush strict]` for a value shorter than `minLength` and for every (d) word, where a fingerprint of a guessed token would mislead. Bash output ends with one more line:

```text
[hush] strict mask: 8 value(s) masked; ask for one value by name if you need it
```

Both paths apply it. The `PostToolUse` hook reads the command from `tool_input.command` and masks `stdout` and `stderr` of a Bash call. The output filter gets the command from `wrap.sh`, which writes bash's `BASH_EXECUTION_STRING` (the `bash -c` string that Claude Code builds) as a header at the start of the stream; the filter takes the command out of its `eval '...'` part. Claude Code runs foreground Bash, background Bash, and Monitor commands this way (seen on 2.1.310), so a failing command, a Monitor event, and a background output file are masked too. Monitor events get no count line. Where the env file is not sourced (credential-scrubbed calls, the PowerShell tool), only successful Bash results are masked.

On the test fixtures, the mask also hides values that are not secret: 4 of 10 in a `docker inspect`, 9 of 12 in `env` output, 2 of 6 in `docker compose config`, 0 of 3 in a Kubernetes secret. That is the price of a list that leaves nothing out.

## Output filter

Claude Code lets a `PostToolUse` hook replace the output of a successful call only. A Bash command that exits non-zero, a Monitor event, and the output file of a background command never pass through it. So hush also filters Bash and Monitor output at the source, without changing the command.

A `SessionStart` hook, `hooks/session-start.js`, runs for every source (`startup`, `resume`, `clear`, `compact`) and appends one line to the file named by `CLAUDE_ENV_FILE`:

```text
[ "${__hush_on-}" = "$$" ] || . '<plugin>/hooks/wrap.sh' || { printf '%s\n' '[hush] output withheld: wrapper unavailable: <plugin>/hooks/wrap.sh did not start the output filter. If hush was updated, moved, or removed, restart the claude process. Else check that node 22 or newer is on PATH and run node <plugin>/scripts/check.js'; exit 125; } # hush output filter
```

Claude Code sources that file in the shell that runs each Bash and Monitor command, before the command, also in subagents and in sessions started in a worktree. `wrap.sh` sends that shell's stdout and stderr through `hooks/filter.js`, which redacts each line with the same known values, patterns, allow list, and placeholders as the `PostToolUse` hook. At exit it waits until the filter has written everything. The command text stays as the model wrote it, so other `PreToolUse` hooks that rewrite commands and permission rules see and match the original command, and its exit code, `cd`, `set -e`, heredocs, quotes, comments, `exit`, and `&` jobs behave as before.

- Bash output ends with `[hush] redacted N secret(s)` when the filter redacted something. The `PostToolUse` hook then finds nothing left and adds nothing.
- Monitor events are redacted line by line, with no notice. A line is written as soon as it ends. `wrap.sh` tells the two apart by stdout: a regular file for Bash, a socket for Monitor.
- A partial line, with no newline yet, waits for 250 ms of silence. Then it is written up to its last space; its last word too when that word is shorter than 6 characters and no known value starts with an end of it. Any other last word is written 3 s after the last write. An open PEM private key block and a run of JSON argv lines stay held until more output arrives or the command ends. When the rest of a line arrives later, it is redacted together with the part already written, so a value split by a pause is still caught; only the part written before the pause is visible.
- The hook never truncates the file: it appends, keeps every line other hooks wrote, and writes nothing when its line is already there. A second copy of the line, from another copy of hush, does not start a second filter. In a resumed session it replaces a hush line with another plugin path, left by an older version.
- Needs bash 4.1 or newer. The hook finds the shell the way Claude Code does (`CLAUDE_CODE_SHELL` when it names bash or zsh, else `$SHELL`, else bash or zsh from `PATH` and the usual directories) and runs it once. For zsh, macOS `/bin/bash` 3.2, or any other shell it writes no line, removes an old hush line, and shows `[hush] output filter off: ...` with the reason; then only successful tool results are redacted. To turn the filter on, set `CLAUDE_CODE_SHELL` to bash 4.1 or newer and restart claude. `wrap.sh` sourced by such a shell anyway sets up nothing and returns, so commands run as without hush.
- Fails closed: if `node`, `wrap.sh`, or `filter.js` is missing, the command does not run, the output is the line above with the path of `wrap.sh` and the recovery (restart the claude process after hush was updated, moved, or removed; else check `node` and run `scripts/check.js`), and the exit code is 125. If the filter throws or dies, the output from then on is `[hush] output withheld: ...` with the file at fault and the recovery step, and the exit code is 125.
- Cost, measured as the median of 20 calls: about 31 ms added to a call with no output and about 46 ms to a call with 1 MB of output.

Limits of the filter:

- It starts with the next session: the hook has to run before the first command. When `CLAUDE_ENV_FILE` is not set or the hook fails, the session shows a `[hush]` message and only successful tool results are redacted.
- Claude Code does not source the env file for commands it runs with credential variables scrubbed (`scrubCredentialEnv`, used when a remote session runs commands on this machine) or for the PowerShell tool. There only successful results are redacted. For PowerShell, Claude Code takes variables from the env file only when every line is a plain assignment, so the hush line also drops the variables that other hooks set there.
- stdout and stderr arrive merged, in the order written. Claude Code merges them for Bash anyway.
- NUL bytes are dropped and invalid UTF-8 becomes U+FFFD.
- Bash messages and `$LINENO` name a line one higher than without an env file, as with any one-line env file. `$!` before the first `&` job holds the filter's starter pid instead of being empty.
- A line longer than 64 KB is cut at a space where it can be, keeping its last 4 KB for the next part. The cut never falls inside a known value or a pattern match: it moves to the start of the match, or after a match that starts the line. A match that runs from the start of the held text to its end holds the line up to 1 MB; past that the line is cut anyway. A PEM private key block is held until its end line, up to 64 KB.
- A pause in a partial line: the part written before the pause stays visible, at most a word shorter than 6 characters, or any word after 3 s. The rest is redacted when it arrives.
- A value split by ANSI color codes or by `\r` is two words: each half is checked on its own, and halves shorter than a pattern needs stay visible.
- stdout of a Bash command is a FIFO instead of the regular file it is without hush, so `[ -f /dev/stdout ]` and `stat` of fd 1 differ.
- The shell must be bash 4.1 or newer, see above.
- A session started before hush moved or was removed keeps the old line in its env file: every command then prints the wrapper message and exits 125 until the claude process restarts. The next `SessionStart` replaces the line.
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

The defaults are in [`hush.default.json`](hush.default.json). Your file is `$HUSH_CONFIG` or `~/.config/hush/config.json`. Its `files`, `patterns`, `allow`, `allowLiterals`, and `strictCommands` lists are appended to the defaults; its `minLength` and `blockLiterals` replace the defaults (12 and `true`).

```json
{
  "files": ["~/project/.env*", "~/project/secrets.json"],
  "patterns": [{ "name": "internal", "regex": "corp_[a-z0-9]{24}" }],
  "allow": ["1a2b3c4d"],
  "allowLiterals": ["5e6f7a8b"],
  "blockLiterals": true,
  "strictCommands": ["\\bvault\\s+read\\b"],
  "minLength": 12
}
```

| Key | Meaning |
|---|---|
| `files` | Files to read known values from. `~` and `*` within one path segment work. A missing file, a directory, and a broken symlink are skipped. Any other read error, such as a file hush may not read, fails closed with a message that names the file. |
| `patterns` | JavaScript regex source, run with flag `g`. With capture groups, only the first group is replaced. `"skipPlaceholders": true` keeps a value that is a placeholder or a file path. Must run in linear time (see below). |
| `allow` | sha8 fingerprints of public values to keep. |
| `minLength` | Shortest known value to redact. |
| `allowLiterals` | sha8 fingerprints of public literal values, such as a local database default: neither redacted nor blocked. Appended to the defaults. |
| `blockLiterals` | `false` turns the [literal block](#literal-block) off. Default `true`. |
| `strictCommands` | Regexes on the command text; a match turns on [strict masking](#strict-commands). Appended to the defaults. Must run in linear time (see below). |

Your patterns and strict commands must run in linear time: no nested or adjacent open repeats that can match the same text, such as `(a+)+`, `\w*\w*=`, or `x.*y.*z`, and a bound on each open repeat in the middle of a regex, such as `[^\n]{0,256}` instead of `[^\n]*`. hush sets no time limit per regex: a slow pattern runs on every output and makes every command wait, until the hook times out. A strict command sees at most the first 64 KB of a command, which limits the damage but does not prevent it. The tests time the default regexes only.

How listed files are read:

- A file ending in `.json`, or starting with `{`, is JSON. hush takes string values whose key contains `key`, `token`, `secret`, `pass`, `auth`, `dsn`, `cred`, or `bearer`, in any case, and for such a value also the token after `Bearer`. Strings inside arrays are not read.
- Any other file is dotenv: `NAME=value` lines, with optional `export`, quotes, and `#` comments.
- A non-JSON file with no `NAME=value` line that has a value counts as bare values: each line, and the whole text if it has several lines, named after the file.

### Check your setup

```text
node /path/to/hush/scripts/check.js
```

In a clone, `npm run check` runs the same script. It lists each listed file as `exists`, `missing`, `directory, skipped`, or `broken symlink, skipped`, with its value count, counts patterns, allow entries, and known values, and runs a self-test with a random fake token that covers a pattern, an argv pattern, the literal block, and strict masking. It never prints a value.

## When a secret leaks

If a secret reaches the model's output unredacted, the plugin ships a skill, `respond-to-leak`, that walks an agent through the response: classify the miss, extend detection, scrub the transcripts, and record it. Three scripts do the work; none takes a secret as an argument and none prints one.

- `scripts/add-pattern.js --name <name> --regex <source> --test-file <path>` adds a pattern to the user config (`$HUSH_CONFIG` or `~/.config/hush/config.json`). The test file holds one fake line the pattern must redact. It refuses a pattern that does not redact that line, is invalid, matches the empty string, or takes more than 100 ms on a 32,000-character line. `--strict-command <regex>` adds a strict command. Add-only, atomic, with a timestamped backup; `--dry-run` previews.
- `scripts/add-known.js` reads one value from stdin and appends it to `~/.config/hush/known-values` (mode 600), which the default config lists in `files`. It prints the sha8 and a count, and refuses values shorter than `minLength`.
- `scripts/scrub.js --path <dir or file>` replaces values with the placeholder in transcripts and task output. Values come from stdin or `--known`. It is a dry run unless `--apply`, handles JSON-escaped forms, skips binary files, symlinks, and files modified in the last 60 seconds (`--include-active` overrides), and prints file names, counts, and sha8 fingerprints. A value split across two lines or records is not found.

## Fails closed

Claude Code ignores a malformed hook output and shows the original text. So when the hook throws after reading a payload with a tool response, for example on a malformed config, it prints a valid output of the same shape with every string replaced by:

```text
[hush] output withheld: redaction failed (<error class> in <file>). Fix or remove <file>, then run node <plugin>/scripts/check.js.
```

The message names the file at fault and how to recover: for your config, fix or remove it; for a file listed in `files` that hush may not read, make it readable or remove it from `files`; for a damaged `hush.default.json`, reinstall hush. It never holds the error text, which may quote the file. `scripts/check.js` prints the same file and, for JSON, the position of the error.

A plain string response is replaced by that text. The hook exits silently, leaving the output unchanged, on an unparseable payload, a payload without a response, or a response whose strings are all shorter than `minLength`. With a malformed config, only a response whose strings are all empty exits silently.

## Limits

hush does not catch:

- Encoded values, such as base64 or hex, unless the encoded form itself is a known value or matches a pattern.
- Values split by ANSI codes or `\r`, and the part of a value written before a pause (see [limits of the filter](#output-filter)).
- Slices of a known value shorter than `minLength`.
- Values outside the listed files that match no pattern.
- Image or binary content that is not text: base64 strings are scanned, pixels are not.
- Telemetry, which sees the original output.
- A hook that times out (10 seconds) or cannot start, for example when `node` is not on PATH: fail closed covers only an error the hook throws.
- A literal password or a strict command after the first 64 KB of a command.

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
