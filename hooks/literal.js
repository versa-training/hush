'use strict';
// Finds literal passwords in a shell command text (the model's own Bash and
// Monitor commands). Used by hooks/block.js. Never returns a value: a finding
// is {rule, sha, length}.
const { sha8 } = require('./hush-lib');

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
const BETWEEN = `(?:["']${S}*,${S}*|${S}+)`;
const V = '([^\\s\\u0002]*)';
const PG_TOOLS = /\b(?:psql|pg_\w+|createdb|dropdb|createuser|dropuser|pgbench|vacuumdb|reindexdb|clusterdb)\b/;

// rule, regex on the cooked text (group 1 is the value), the fix shown, and an optional check.
const SHAPES = [
  { rule: 'redis-cli', cmd: /\bredis-cli\b/, re: `${BEFORE}(?:-a|--pass)${BETWEEN}${V}`, fix: 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ..., or redis-cli -a "$REDIS_PASSWORD"' },
  { rule: 'requirepass', re: `\\b(?:requirepass|masterauth)["']?${BETWEEN}${V}`, fix: 'redis-server --requirepass "$REDIS_PASSWORD"' },
  { rule: 'password-flag', re: `(?<![\\w-])--(?:http-|ftp-|proxy-)?pass(?:word)?(=|${BETWEEN})${V}`, fix: '--password="$DB_PASSWORD", or the tool\'s password file option', group: 2,
    skip: (text, m) => m[1] !== '=' && PG_TOOLS.test(text.slice(Math.max(text.lastIndexOf('\n', m.index), text.lastIndexOf('|', m.index), text.lastIndexOf(';', m.index), text.lastIndexOf('&', m.index), 0), m.index)) },
  { rule: 'mysql-p', cmd: /\b(?:mysql|mariadb|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck|mariadb-dump|mariadb-admin)\b/, re: `${BEFORE}-p([^\\s\\u0002]+)`, fix: 'MYSQL_PWD="$DB_PASSWORD" mysql ..., or --defaults-extra-file=<file>' },
  { rule: 'sshpass', re: `\\bsshpass${S}+-p${S}*${V}`, fix: 'SSHPASS="$SSH_PASSWORD" sshpass -e ..., or sshpass -f <file>' },
  { rule: 'curl-user', cmd: /\bcurl\b/, re: `${BEFORE}(?:-u${S}*|--user(?:=|${S}+))${V}`, fix: 'curl -u "user:$API_PASSWORD" ..., or curl --netrc-file <file>', user: true },
  { rule: 'authorization', cmd: /\b(?:curl|wget)\b/, re: `[Aa]uthorization:${S}*(?:(?:[Bb]earer|[Bb]asic|[Tt]oken|[Bb]ot|[Dd]igest)${S}+)?${V}`, fix: 'curl -H "Authorization: Bearer $API_TOKEN" ..., or -H @<header-file>' },
  { rule: 'env-password', re: `(?<![\\w$])(?:PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH|SSHPASS)=${V}`, fix: 'PGPASSFILE=<file> psql ..., or PGPASSWORD="$DB_PASSWORD" psql ...' },
  { rule: 'url-password', re: `\\b[A-Za-z][A-Za-z0-9+.-]{1,20}://[^\\s\\u0002/@:]*:([^\\s\\u0002@/]+)@`, fix: '"postgres://user:${DB_PASSWORD}@host/db", or a URL read from a file' },
].map((s) => ({ ...s, re: new RegExp(s.re, 'g') }));

const PLACEHOLDER_WORDS = new Set(['changeme', 'password', 'passwd', 'example', 'secret', 'redacted', 'placeholder', 'yourpassword', 'mypassword',
  'your_password', 'your-password', 'my_password', 'my-password', 'pass', 'pwd', 'token', 'yourtoken', 'your_token', 'your-token', 'none', 'null', 'undefined']);

// True when v is a placeholder, not a value: <password>, {{x}}, [hush ...],
// xxx, ***, ..., a placeholder word, or an ALL_CAPS name (a variable written without $).
function placeholder(v) {
  return /^(?:<[^<>]*>?|\{\{[^}]*\}\}|\[hush\b.*|x{3,}|X{3,}|\*{3,}|\.{3,}|\?{3,}|…+|%s)$/.test(v)
    || PLACEHOLDER_WORDS.has(v.toLowerCase())
    || /example/i.test(v)
    || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v);
}

// A file path, as in `grep requirepass /etc/redis/redis.conf`: path characters
// only, a slash, and a leading /, ./, ../, ~/ or a file extension.
const filePath = (v) => /^[\w.~-]*\/[\w./-]*$/.test(v) && (/^(?:\/|\.\.?\/|~\/)/.test(v) || /\.[A-Za-z]{1,5}$/.test(v));

const strip = (v) => v.replace(/^["'[(]+/, '').replace(/["',\])};]+$/, '');

// Checks one value; returns a finding or null.
function check(s, v, allow) {
  if (s.user) {
    const i = v.indexOf(':');
    if (i < 0) return null;
    v = v.slice(i + 1);
  }
  if (v.includes(EXP)) return null;
  v = strip(v);
  if (/\$[A-Za-z_{(]|`/.test(v)) return null;
  if (v.length < 6 || v.startsWith('-') || placeholder(v) || filePath(v)) return null;
  const sha = sha8(v);
  if (allow.has(sha)) return null;
  return { rule: s.rule, sha, length: v.length, fix: s.fix };
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
    if (depth < 8) for (const x of subs) if (x.trim()) todo.push([x, depth + 1]);
    const segs = SHAPES.some((s) => s.cmd && s.cmd.test(text)) ? text.split(/[\n|;&]/) : [];
    for (const s of SHAPES) {
      const parts = [];
      if (!s.cmd) parts.push(text);
      else for (const seg of segs) { const k = seg.search(s.cmd); if (k >= 0) parts.push(seg.slice(k)); }
      for (const part of parts) {
        for (const m of part.matchAll(s.re)) {
          if (s.skip && s.skip(part, m)) continue;
          const f = check(s, m[s.group || 1] || '', allow);
          if (f) found.push(f);
        }
      }
    }
  }
  return found;
}

module.exports = { cook, findLiterals, placeholder, EXP, SP };
