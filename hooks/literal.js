'use strict';
// Finds literal passwords in a shell command text (the model's own Bash and
// Monitor commands). Used by hooks/block.js. Never returns a value: a finding
// is {rule, sha, length}.
const { sha8, placeholder, filePath } = require('./hush-lib');

// In the cooked text, EXP stands for a variable or command substitution and SP
// for whitespace inside one shell word, so a quoted value stays one word.
const EXP = '\u0001';
const SP = '\u0002';

// Index just after the bracket that closes the one at `start`. Quotes inside
// are skipped. Returns src.length when it is not closed.
function closing(src, start, open, close) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" && open === '(') { const j = src.indexOf("'", i + 1); if (j < 0) return src.length; i = j; continue; }
    if (c === '"' && open === '(') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return src.length;
}

// Reads a `$...` expansion at i. Returns {end, sub} (sub: inner command text to
// scan as well) or null when the `$` is a plain character.
function expansion(src, i) {
  const n = src[i + 1];
  if (n === '(') { const end = closing(src, i + 1, '(', ')'); return { end, sub: src.slice(i + 2, end - 1) }; }
  if (n === '{') return { end: closing(src, i + 1, '{', '}'), sub: null };
  if (n && /[A-Za-z0-9_@*#?!$-]/.test(n)) {
    let j = i + 1;
    if (/[A-Za-z_]/.test(n)) while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
    else j++;
    return { end: j, sub: null };
  }
  return null;
}

// Turns a command text into a cooked text: outer quotes removed, expansions
// replaced by EXP, whitespace inside a word replaced by SP, operators kept as
// separate words. Inner command substitutions are collected in subs.
function cook(src, subs = []) {
  let out = '';
  const word = (ch) => { out += /\s/.test(ch) ? (ch === '\n' ? '\n' : SP) : ch; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { if (src[i + 1] !== '\n') out += src[i + 1] || ''; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { out += ' '; continue; }
    if (c === '\n') { out += '\n'; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') { out += ` ${c} `; continue; }
    if (c === '<' || c === '>') {
      out += ' > ';
      while (src[i + 1] === '<' || src[i + 1] === '>') i++;
      if (src[i + 1] === '&') { i++; while (/[0-9-]/.test(src[i + 1] || '')) i++; }
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      for (const ch of src.slice(i + 1, end)) word(ch);
      i = end;
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      let j = i + 2;
      while (j < src.length && src[j] !== "'") { if (src[j] === '\\') j++; word(src[j] || ''); j++; }
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        const d = src[j];
        if (d === '\\' && /[$`"\\\n]/.test(src[j + 1] || '')) { if (src[j + 1] !== '\n') word(src[j + 1]); j += 2; continue; }
        if (d === '$') {
          const x = expansion(src, j);
          if (x) { out += EXP; if (x.sub) subs.push(x.sub); j = x.end; continue; }
        }
        if (d === '`') {
          const k = src.indexOf('`', j + 1);
          const end = k < 0 ? src.length : k;
          out += EXP; subs.push(src.slice(j + 1, end)); j = end + 1; continue;
        }
        word(d);
        j++;
      }
      i = j;
      continue;
    }
    if (c === '$') {
      const x = expansion(src, i);
      if (x) { out += EXP; if (x.sub) subs.push(x.sub); i = x.end - 1; continue; }
    }
    if (c === '`') {
      const k = src.indexOf('`', i + 1);
      const end = k < 0 ? src.length : k;
      out += EXP; subs.push(src.slice(i + 1, end)); i = end;
      continue;
    }
    out += c;
  }
  return { text: out, subs };
}

const S = '[\\s\\u0002]';
const BEFORE = '[\\s\\u0002"\',\\[]';
// A flag and its value: whitespace, or `", "` between two quoted list items.
const BETWEEN = `(?:["']${S}{0,16},${S}{0,16}|${S}{1,16})`;
const V = '([^\\s\\u0002]*)';
// The text of the simple command before index i, up to 400 characters back.
const lastCommand = (text, i) => { const w = text.slice(Math.max(0, i - 400), i); return w.slice(Math.max(...['\n', '|', ';', '&'].map((c) => w.lastIndexOf(c))) + 1); };
const PG_TOOLS = /\b(?:psql|pg_\w+|createdb|dropdb|createuser|dropuser|pgbench|vacuumdb|reindexdb|clusterdb)\b/;

// rule, regex on the cooked text (group 1 is the value), the fix shown, and an optional check.
const SHAPES = [
  { rule: 'redis-cli', cmd: /\bredis-cli\b/, re: `${BEFORE}(?:-a|--pass)${BETWEEN}${V}`, fix: 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ..., or redis-cli -a "$REDIS_PASSWORD"' },
  { rule: 'requirepass', re: `\\b(?:requirepass|masterauth)["']?${BETWEEN}${V}`, fix: 'redis-server --requirepass "$REDIS_PASSWORD"' },
  { rule: 'password-flag', re: `(?<![\\w-])--(?:http-|ftp-|proxy-)?pass(?:word)?(=|${BETWEEN})${V}`, fix: '--password="$DB_PASSWORD", or the tool\'s password file option', group: 2,
    skip: (text, m) => m[1] !== '=' && PG_TOOLS.test(lastCommand(text, m.index)) },
  { rule: 'mysql-p', cmd: /\b(?:mysql|mariadb|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck|mariadb-dump|mariadb-admin)\b/, re: `${BEFORE}-p([^\\s\\u0002]+)`, fix: 'MYSQL_PWD="$DB_PASSWORD" mysql ..., or --defaults-extra-file=<file>' },
  { rule: 'sshpass', re: `\\bsshpass${S}{1,16}-p${S}{0,16}${V}`, fix: 'SSHPASS="$SSH_PASSWORD" sshpass -e ..., or sshpass -f <file>' },
  { rule: 'curl-user', cmd: /\bcurl\b/, re: `${BEFORE}(?:-u${S}{0,16}|--user(?:=|${S}{1,16}))${V}`, fix: 'curl -u "user:$API_PASSWORD" ..., or curl --netrc-file <file>', user: true },
  { rule: 'authorization', cmd: /\b(?:curl|wget)\b/, re: `[Aa]uthorization:${S}{0,16}(?:(?:[Bb]earer|[Bb]asic|[Tt]oken|[Bb]ot|[Dd]igest)${S}{1,16})?${V}`, fix: 'curl -H "Authorization: Bearer $API_TOKEN" ..., or -H @<header-file>' },
  { rule: 'env-password', re: `(?<![\\w$])(PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH|SSHPASS|[A-Z0-9_]{0,64}(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY|AUTH(?!OR))[A-Z0-9_]{0,64})=${V}`, fix: 'PGPASSFILE=<file> psql ..., or PGPASSWORD="$DB_PASSWORD" psql ...' , group: 2, skip: (text, m) => NOT_SECRET_NAME.test(m[1]) },
  { rule: 'url-password', re: `\\b[A-Za-z][A-Za-z0-9+.-]{1,20}://[^\\s\\u0002/@:]{0,256}:([^\\s\\u0002@/]+)@`, fix: '"postgres://user:${DB_PASSWORD}@host/db", or a URL read from a file' },
  { rule: 'conn-password', re: `(?<![\\w$.-])(?:[Pp]ass(?:word|wd)|PASSWORD|PASSWD|[Pp]wd)=${V}`, fix: 'psql "host=db user=app" with the password in PGPASSFILE or ~/.pgpass, or password=$DB_PASSWORD from a variable' },
  { rule: 'redis-auth', cmd: /\bredis-cli\b/, re: `${BEFORE}[Aa][Uu][Tt][Hh]${S}{1,16}([^\\s\\u0002>]+)(?:${S}{1,16}([^\\s\\u0002>]+))?`, pick: (m) => (m[2] !== undefined ? 2 : 1), fix: 'redis-cli AUTH "$REDIS_PASSWORD", or REDISCLI_AUTH read from a file' },
  { rule: 'httpie-auth', cmd: /(?:^|[\s\u0002(])(?:http|https|xh|xhs)(?=[\s\u0002])/, re: `${BEFORE}(?:-a|--auth)(?:=|${S}{1,16})${V}`, fix: 'http -a "user:$API_PASSWORD" ..., or a ~/.netrc entry', user: true },
].map((s) => ({ ...s, re: new RegExp(s.re, 'gd') }));

// Names in NAME=value that hold a setting about a secret, not the secret:
// a name that contains TOKENS (a token count) or ends in a setting word.
const NOT_SECRET_NAME = /TOKENS|_(?:FILE|PATH|DIR|URL|URI|HOST|PORT|USER|USERNAME|NAME|TYPE|MODE|PROVIDER|METHOD|ENABLED|HEADER|ENDPOINT|ID|DOMAIN|ISSUER|AUDIENCE|SCOPES?|REGION|TTL|TIMEOUT|EXPIRY|LENGTH|ARN|TEMPLATE|ROTATION|COUNT|LIMIT|PREFIX|ALGORITHM)$/;

const strip = (v) => v.replace(/^["'[(]+/, '').replace(/["',\])};]+$/, '');

// Checks one value; returns a finding or null. prose(): true when the value
// sits in a message (see inMessage), where an all-lowercase word is prose.
function check(s, v, allow, prose = () => false) {
  if (s.user) {
    const i = v.indexOf(':');
    if (i < 0) return null;
    v = v.slice(i + 1);
  }
  if (v.includes(EXP)) return null;
  v = strip(v);
  if (/\$[A-Za-z_{(]|`/.test(v)) return null;
  if (v.length < 6 || v.startsWith('-') || /^\d+$/.test(v) || placeholder(v) || filePath(v)) return null;
  if (/^[a-z]+$/.test(v) && prose()) return null;
  const sha = sha8(v);
  if (allow.has(sha)) return null;
  return { rule: s.rule, sha, length: v.length, fix: s.fix };
}

// Positions of the characters in set, in order.
const positions = (text, set) => { const out = []; for (let i = 0; i < text.length; i++) if (set.includes(text[i])) out.push(i); return out; };
// The index of the first entry of sorted list a that is x or more.
function first(a, x) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
// The last entry of sorted list a below x, or -1.
const below = (a, x) => { const i = first(a, x); return i ? a[i - 1] : -1; };

// True when index at of the cooked text lies in a quoted message with
// spaces: an argument of echo or printf, of `git commit` or `git tag` after
// -m or --message, or of `gh pr create` after --title or --body. memo holds
// per-text indexes and results, so many matches in one text stay linear.
function inMessage(text, at, memo) {
  memo.sp ||= positions(text, ' \n');
  memo.sep ||= positions(text, '\n|;&(');
  memo.words ||= new Map();
  const ws = below(memo.sp, at);
  if (memo.words.has(ws)) return memo.words.get(ws);
  const next = memo.sp[first(memo.sp, at)];
  const end = next === undefined ? text.length : next;
  memo.inner ||= positions(text, SP);
  const sp = memo.inner[first(memo.inner, ws + 1)];
  let r = false;
  if (sp !== undefined && sp < end) {
    const start = below(memo.sep, ws + 1) + 1;
    const tokens = text.slice(start, Math.min(ws + 1, start + 400)).split(' ').filter(Boolean);
    while (tokens.length && (/^[A-Za-z_]\w*=/.test(tokens[0]) || ['sudo', 'command', 'builtin', 'exec'].includes(tokens[0]))) tokens.shift();
    const prev = ws > start ? text.slice(Math.max(start, below(memo.sp, ws) + 1), ws) : '';
    const head = text.slice(ws + 1, Math.min(end, ws + 20));
    const [cmd] = tokens;
    if (cmd === 'echo' || cmd === 'printf') r = true;
    else if (cmd === 'git' && (tokens.includes('commit') || tokens.includes('tag'))) r = /^-[A-Za-z]*m$|^--message$/.test(prev) || /^(?:-[A-Za-z]*m|--message=)./.test(head);
    else if (cmd === 'gh' && tokens[1] === 'pr' && tokens[2] === 'create') r = /^(?:-[tb]|--title|--body)$/.test(prev) || /^--(?:title|body)=./.test(head);
  }
  memo.words.set(ws, r);
  return r;
}

// Returns the findings in one command text: [{rule, sha, length, fix}]. A
// shape with a command (`cmd`) is searched in each simple command (the text
// between newlines, pipes, `;` and `&`) after that command's name. Command
// substitutions are searched as well, up to 8 levels deep.
function findLiterals(command, cfg, allow) {
  const found = [];
  const todo = [[command, 0]];
  while (todo.length) {
    const [src, depth] = todo.pop();
    const { text, subs } = cook(src);
    const memo = {};
    if (depth < 8) for (const x of subs) if (x.trim()) todo.push([x, depth + 1]);
    const segs = SHAPES.some((s) => s.cmd && s.cmd.test(text)) ? [...text.matchAll(/[^\n|;&]+/g)] : [];
    for (const s of SHAPES) {
      // [text searched, its offset in the cooked text]
      const parts = [];
      if (!s.cmd) parts.push([text, 0]);
      else for (const seg of segs) { const k = seg[0].search(s.cmd); if (k >= 0) parts.push([seg[0].slice(k), seg.index + k]); }
      for (const [part, off] of parts) {
        for (const m of part.matchAll(s.re)) {
          if (s.skip && s.skip(part, m)) continue;
          const g = s.pick ? s.pick(m) : s.group || 1;
          if (m[g] === undefined) continue;
          const f = check(s, m[g], allow, () => inMessage(text, off + m.indices[g][0], memo));
          if (f) found.push(f);
        }
      }
    }
  }
  return found;
}

// Every regex above that runs on command text, for the timing test.
const REGEXES = [...SHAPES.map((s) => s.re), ...SHAPES.filter((s) => s.cmd).map((s) => s.cmd), NOT_SECRET_NAME, PG_TOOLS];

module.exports = { cook, findLiterals, placeholder, EXP, SP, REGEXES };
