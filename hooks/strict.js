'use strict';
// Strict masking for the output of commands listed in `strictCommands`
// (configuration dumps such as `docker inspect` or `env`). Every value is
// masked, names and structure stay. Works line by line with state across
// lines, so the streaming filter and the PostToolUse hook share it.
//
// A value is:
// (a) the right-hand side of NAME=value: a whole line (also after `export`,
//     `declare -x`, or a YAML `- `) to its end, a JSON string "NAME=value" to
//     its closing quote, and elsewhere up to whitespace or a quote;
// (b) a JSON or YAML string value whose key matches SECRET_KEY, and every
//     value inside a `data:`, `stringData:`, `binaryData:` (Kubernetes
//     secrets), or `environment:` (Compose) block;
// (c) in an argv list (a JSON array or YAML list under Cmd, Entrypoint,
//     Args, Test, or Command, or a JSON array whose first element is CMD or
//     CMD-SHELL): every element after the first that follows an element
//     starting with `-`, the part after `=` of a `--flag=value` element, and
//     in a CMD-SHELL string every word after a flag;
// (d) any other word of 20 or more characters with high variety: at least
//     three of lower case, upper case, digit, other, one of them a digit.
//     Not: sha256 digests, hex IDs, UUIDs and MAC addresses (hex digits and
//     separators only), timestamps, paths, image references, and URLs
//     without credentials.
const { sha8 } = require('./hush-lib');

const SECRET_KEY = /pass|secret|token|key|auth|credential|dsn|cookie|session/i;
const ARGV_KEY = /^(?:cmd|entrypoint|args|test|command)$/i;
const FLAG = /^--?[A-Za-z][\w.-]*$/;

const IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d+)?(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*(?::\w[\w.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
function varied(w) {
  if (w.length < 20 || w.startsWith('[hush')) return false;
  if (!/\d/.test(w)) return false;
  const classes = /[a-z]/.test(w) + /[A-Z]/.test(w) + 1 + /[^A-Za-z0-9]/.test(w);
  if (classes < 3) return false;
  if (/^sha256:/.test(w) || /^[0-9a-fA-F:.-]+$/.test(w)) return false;
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d|$)/.test(w)) return false;
  if (/^(?:\/|\.\.?\/|~\/)/.test(w)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^@\s]*$/.test(w)) return false;
  if (IMAGE.test(w)) return false;
  return true;
}

// Returns true when the command text matches one of cfg.strictCommands.
function isStrict(command, cfg) {
  if (!command) return false;
  return (cfg.strictCommands || []).some((r) => new RegExp(r, 'm').test(command));
}

// The command inside the string Claude Code passes to `bash -c`
// (`... && eval '<command>' [< /dev/null] && pwd -P >| <file>`). Returns the
// whole string when it does not have that shape.
function commandOf(exec) {
  const end = exec.lastIndexOf(' && pwd -P >| ');
  if (end < 0) return exec;
  let at = exec.indexOf(' && eval ');
  while (at >= 0 && at < end) {
    let i = at + 9;
    let out = '';
    for (; i < end && !/\s/.test(exec[i]); i++) {
      const c = exec[i];
      if (c === "'") { const j = exec.indexOf("'", i + 1); if (j < 0) break; out += exec.slice(i + 1, j); i = j; continue; }
      if (c === '"') {
        let j = i + 1;
        for (; j < exec.length && exec[j] !== '"'; j++) { if (exec[j] === '\\') j++; out += exec[j]; }
        i = j;
        continue;
      }
      if (c === '\\') { i++; out += exec[i]; continue; }
      out += c;
    }
    const tail = exec.slice(i, end);
    if (tail === '' || tail === ' < /dev/null') return out;
    at = exec.indexOf(' && eval ', at + 1);
  }
  return exec;
}

class Strict {
  constructor(cfg) {
    this.minLength = cfg.minLength;
    this.count = 0;
    this.arr = null;
    this.yarr = null;
    this.block = null;
  }

  // A copy of the state, to mask a partial line without advancing the state.
  clone() {
    const c = Object.assign(Object.create(Strict.prototype), this);
    for (const k of ['arr', 'yarr', 'block']) if (this[k]) c[k] = { ...this[k] };
    return c;
  }

  mask(v, heuristic = false) {
    if (!v || v.startsWith('[hush')) return v;
    this.count++;
    if (this.record) this.record.push(v);
    return heuristic || v.length < this.minLength ? '[hush strict]' : `[hush strict sha:${sha8(v)}]`;
  }

  // Masks the inside of a quoted value, keeping the quotes.
  quoted(v) {
    const m = /^(["'])(.*)\1$/.exec(v);
    return m ? m[1] + this.mask(m[2]) + m[1] : this.mask(v);
  }

  words(text) {
    return text.replace(/[^\s"'`,;()[\]{}<>]{20,}/g, (w) => (varied(w) ? this.mask(w, true) : w));
  }

  // A CMD-SHELL string: words after a flag, NAME=value words, varied words.
  shell(s) {
    let prevFlag = false;
    return s.split(/(\s+)/).map((w) => {
      if (!w || /^\s+$/.test(w)) return w;
      let out;
      const kv = /^([A-Za-z_]\w*=|--?[A-Za-z][\w.-]*=)(.+)$/.exec(w);
      if (prevFlag && !FLAG.test(w)) out = this.mask(w);
      else if (kv) out = kv[1] + this.mask(kv[2]);
      else out = this.words(w);
      prevFlag = FLAG.test(w);
      return out;
    }).join('');
  }

  // One argv element (JSON string content or YAML item). Returns null when the
  // first element shows that the list is not an argv.
  elem(st, v) {
    const i = st.i++;
    if (i === 0) {
      if (v === 'CMD' || v === 'CMD-SHELL') { st.argv = true; st.shell = v === 'CMD-SHELL'; return v; }
      if (!st.argv) return null;
    }
    let out;
    const kv = /^(--?[A-Za-z][\w.-]*=)(.+)$/.exec(v);
    if (st.shell) out = this.shell(v);
    else if (i > 0 && st.prevFlag && !FLAG.test(v)) out = this.mask(v);
    else if (kv) out = kv[1] + this.mask(kv[2]);
    else out = this.words(v);
    st.prevFlag = FLAG.test(v);
    return out;
  }

  // A compact JSON array on one line.
  inlineArray(key, body) {
    const items = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    if (!items.length) return null;
    const st = { i: 0, argv: ARGV_KEY.test(key || ''), prevFlag: false, shell: false };
    if (!st.argv && items[0] !== 'CMD' && items[0] !== 'CMD-SHELL') return null;
    let k = 0;
    return body.replace(/"((?:[^"\\]|\\.)*)"/g, () => `"${this.elem(st, items[k++]) ?? items[k - 1]}"`);
  }

  inline(l) {
    // (a) a whole NAME=value line
    const line = /^(\s*(?:-\s+)?(?:(?:export|declare|typeset|local|readonly)\s+(?:-[A-Za-z]+\s+)*)?)([A-Za-z_][A-Za-z0-9_]*)=(.*?)(\r?)$/.exec(l);
    if (line) return line[3] ? line[1] + line[2] + '=' + this.quoted(line[3]) + line[4] : l;
    // (c) compact argv arrays
    l = l.replace(/(?:"([A-Za-z]+)"\s*:\s*)?\[([^[\]]*)\]/g, (m, key, body) => {
      const r = this.inlineArray(key, body);
      return r === null ? m : m.slice(0, m.length - body.length - 1) + r + ']';
    });
    // (b) compact data objects
    l = l.replace(/("(?:data|stringData|binaryData)"\s*:\s*\{)([^{}]*)\}/g, (m, head, body) => head + body.replace(/("(?:[^"\\]|\\.)*"\s*:\s*")((?:[^"\\]|\\.)*)"/g, (x, k, v) => `${k}${this.mask(v)}"`) + '}');
    // (a) "NAME=value" JSON strings
    l = l.replace(/"([A-Za-z_][A-Za-z0-9_]*)=((?:[^"\\]|\\.)*)"/g, (m, k, v) => `"${k}=${this.mask(v)}"`);
    // (b) "key": "value" with a secret key
    l = l.replace(/"((?:[^"\\]|\\.)*)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (m, k, sep, v) => (SECRET_KEY.test(k) ? `"${k}"${sep}"${this.mask(v)}"` : m));
    // (b) YAML key: value with a secret key
    const y = /^(\s*(?:-\s+)?)(["']?)([\w.-]+)\2(\s*:\s+)(.+?)(\r?)$/.exec(l);
    if (y && SECRET_KEY.test(y[3]) && !/^[[{|>]/.test(y[5])) l = y[1] + y[2] + y[3] + y[2] + y[4] + this.quoted(y[5]) + y[6];
    // (a) NAME=value elsewhere in the line
    l = l.replace(/(?<![\w$.\-/])([A-Za-z_][A-Za-z0-9_]*)=([^\s"',;&|)]+)/g, (m, k, v) => `${k}=${this.mask(v)}`);
    // (d)
    return this.words(l);
  }

  line(l) {
    const ind = /^\s*/.exec(l)[0].length;
    const t = l.trim();
    if (this.arr) {
      if (/^\]\s*,?$/.test(t)) { this.arr = null; return l; }
      const m = /^(\s*)"((?:[^"\\]|\\.)*)"(\s*,?\s*)$/.exec(l);
      const out = m ? this.elem(this.arr, m[2]) : null;
      if (out !== null) return `${m[1]}"${out}"${m[3]}`;
      this.arr = null;
    }
    if (this.yarr) {
      const m = /^(\s*)-(\s+)(["']?)(.*?)\3(\s*)$/.exec(l);
      if (m && m[1].length >= this.yarr.ind) return `${m[1]}-${m[2]}${m[3]}${this.elem(this.yarr, m[4])}${m[3]}${m[5]}`;
      if (t) this.yarr = null; else return l;
    }
    if (this.block) {
      if (!t) return l;
      if (ind > this.block.ind) {
        if (this.block.scalar) return l.slice(0, ind) + this.mask(t);
        const j = /^(\s*"(?:[^"\\]|\\.)*"\s*:\s*)"((?:[^"\\]|\\.)*)"(.*)$/.exec(l);
        if (j) return `${j[1]}"${this.mask(j[2])}"${j[3]}`;
        const k = /^(\s*[^:\s"'-][^:]*:\s+)(.+?)(\r?)$/.exec(l);
        if (k) return k[1] + this.quoted(k[2]) + k[3];
        return this.inline(l);
      }
      this.block = null;
    }
    let m = /^\s*"([A-Za-z]+)"\s*:\s*\[\s*$/.exec(l) || /^\s*\[\s*$/.exec(l);
    if (m) { this.arr = { i: 0, argv: ARGV_KEY.test(m[1] || ''), prevFlag: false, shell: false }; return l; }
    m = /^(\s*)(?:-\s+)?["']?([A-Za-z]+)["']?:\s*$/.exec(l);
    if (m && ARGV_KEY.test(m[2])) { this.yarr = { ind: m[1].length, i: 0, argv: true, prevFlag: false, shell: false }; return l; }
    m = /^(\s*)"?(?:data|stringData|binaryData|environment)"?\s*:\s*\{?\s*$/.exec(l);
    if (m) { this.block = { ind: m[1].length, scalar: false }; return l; }
    m = /^(\s*)(?:-\s+)?["']?([\w.-]+)["']?\s*:\s*[|>][-+]?\d*\s*$/.exec(l);
    if (m && SECRET_KEY.test(m[2])) { this.block = { ind: m[1].length, scalar: true }; return l; }
    return this.inline(l);
  }

  // Masks a run of text; a partial last line is treated as a line.
  text(s) {
    return s.split('\n').map((l, i, a) => (i === a.length - 1 && l === '' ? l : this.line(l))).join('\n');
  }

  notice() {
    return notice(this.count);
  }
}

const notice = (n) => `[hush] strict mask: ${n} value(s) masked; ask for one value by name if you need it`;

module.exports = { Strict, isStrict, commandOf, notice, varied };
