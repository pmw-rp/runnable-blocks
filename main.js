'use strict';

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  MarkdownRenderChild,
  FileSystemAdapter,
  TFile,
  MarkdownView,
  TextFileView,
  setIcon,
  loadPrism,
  sanitizeHTMLToDom,
  parseYaml,
  stringifyYaml,
  editorInfoField,
  editorLivePreviewField,
} = require('obsidian');
// Obsidian's editor, for hiding the sections of the ways not chosen in Live Preview.
const CM = (() => {
  try {
    return { state: require('@codemirror/state'), view: require('@codemirror/view') };
  } catch (e) {
    return { state: {}, view: {} };
  }
})();
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SETTINGS = {
  interpreters: [
    'bash = bash {file}',
    'sh = sh {file}',
    'zsh = zsh {file}',
    'python = python3 {file}',
    'py = python3 {file}',
    'js = node {file}',
    'javascript = node {file}',
    'node = node {file}',
    'ruby = ruby {file}',
    'go = go build -o {file}.bin {file} && {file}.bin; status=$?; rm -f {file}.bin; exit $status',
  ].join('\n'),
  // GUI apps on macOS don't inherit the shell's PATH, so Homebrew tools are invisible by default.
  // /usr/local/go/bin is where Go's official installer puts it.
  extraPath: '/opt/homebrew/bin:/usr/local/bin:/usr/local/go/bin',
  cwdMode: 'note',
  timeoutSeconds: 30,
  defaultLang: 'bash',
  allowOutsideVault: false,
  checkOnOpen: false,
  // Files with these extensions open in the plugin's code editor, rather than outside Obsidian.
  codeExtensions: 'yaml, yml, json, avsc, sh, bash, zsh, py, go, js, ts, toml, ini, cfg, conf, properties, xml, sql, rb, txt, log',
};

const EXTENSIONS = {
  bash: 'sh', sh: 'sh', zsh: 'zsh', python: 'py', py: 'py',
  js: 'js', javascript: 'js', node: 'js', ruby: 'rb', ts: 'ts', go: 'go',
};

// Languages whose run blocks can list `packages:`, by the tool that installs them, and the extra
// time a block gets the first time, while they're installed.
const INSTALL_SECONDS = 300;
const PACKAGE_LANGS = { python: 'python', py: 'python', js: 'node', javascript: 'node', node: 'node', go: 'go' };

// How a block with `packages:` runs. Each set of packages gets an environment of its own, in
// lab/.packages next to the note: a virtualenv, an npm project or a Go module, made the first
// time a block needs it and reused after that. Returns { ready, ext, command(file), cleanup }: `ext`
// is the extension for the file the block's code is written to, `command` the shell command that
// installs the packages if need be and runs that file (Node and Go look for packages next to the
// code, so it's copied into the environment first), and `cleanup` what to delete afterwards.
function packageSetup(lang, packages, cwd, code) {
  const kind = PACKAGE_LANGS[lang];
  if (!kind) throw new Error(`"packages" works in python, js and go blocks, not ${lang}.`);
  const dir = path.join(cwd, 'lab', '.packages', `${kind}-${md5(`${kind}\n${[...packages].sort().join('\n')}`).slice(0, 12)}`);
  const ready = path.join(dir, '.ready');
  const q = shellQuote;
  const list = packages.map(q).join(' ');
  const name = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const install = {
    python: `python3 -m venv ${q(dir)} && ${q(path.join(dir, 'bin', 'python'))} -m pip install --quiet --disable-pip-version-check ${list}`,
    node: `mkdir -p ${q(dir)} && cd ${q(dir)} && npm init -y >/dev/null && npm install --no-fund --no-audit --loglevel=error ${list}`,
    go: `mkdir -p ${q(dir)} && cd ${q(dir)} && go mod init runblocks >/dev/null 2>&1 && go get ${list}`,
  }[kind];
  // Installing writes to stderr, so the block's output, and what it's checked against, is the code's own.
  const prepare = `{ [ -f ${q(ready)} ] || { echo "Installing ${packages.join(', ').replace(/["$`\\]/g, '')}, the first time only…"; rm -rf ${q(dir)}; ( ${install} ) && touch ${q(ready)}; }; } >&2`;
  if (kind === 'python') {
    return { ready, ext: 'py', cleanup: [], command: (file) => `${prepare} && ${q(path.join(dir, 'bin', 'python'))} ${q(file)}` };
  }
  if (kind === 'node') {
    // An ES module, with import, needs the .mjs extension in a project without "type": "module".
    const ext = /^\s*import\s/m.test(code || '') ? 'mjs' : 'js';
    const copy = path.join(dir, `${name}.${ext}`);
    return { ready, ext, cleanup: [copy], command: (file) => `${prepare} && cp ${q(file)} ${q(copy)} && node ${q(copy)}` };
  }
  // Go builds a package, so each run gets a folder of its own in the module, and the binary runs in
  // the note's folder, like any other block.
  const pkg = path.join(dir, name);
  const bin = path.join(pkg, 'run.bin');
  return {
    ready, ext: 'go', cleanup: [pkg],
    command: (file) => `${prepare} && mkdir -p ${q(pkg)} && cp ${q(file)} ${q(path.join(pkg, 'main.go'))} && ( cd ${q(dir)} && go build -o ${q(bin)} ./${name} ) && ${q(bin)}`,
  };
}

const FENCE_RE = /^((?:[ \t]*>)*[ \t]*)(`{3,}|~{3,})(.*)$/;

// Prism's names for languages that blocks may call something else.
const PRISM_LANGS = { sh: 'bash', zsh: 'bash', py: 'python', js: 'javascript', node: 'javascript', yml: 'yaml', text: 'none' };

// Syntax highlighting for ```file blocks, picked from the file extension.
const LANG_FOR_EXT = { yml: 'yaml', md: 'markdown', sh: 'bash', py: 'python', rb: 'ruby', txt: 'text' };

const BLOCK_RE = /^(run|file)(\s|$)/;
const CHOOSE_RE = /^choose(\s|$)/;

// The code editor's view, and the Prism language for each file extension it opens.
const CODE_VIEW = 'runnable-blocks-code';
const CODE_LANGS = {
  yaml: 'yaml', yml: 'yaml', json: 'json', avsc: 'json', sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python',
  go: 'go', js: 'javascript', ts: 'typescript', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
  properties: 'properties', xml: 'markup', sql: 'sql', rb: 'ruby', txt: 'none', log: 'none',
};
// Highlighting re-runs on every keystroke, so very large files are shown plain.
const MAX_HIGHLIGHT = 200000;

// Settings a block's YAML header may use. A header only counts as one if it uses at least one of
// these, so a file whose own content has a "---" line isn't mistaken for a header.
const HEADER_KEYS = new Set(['id', 'lang', 'path', 'editable', 'manual', 'idempotent', 'timeout', 'depends-on', 'requires', 'instead-of', 'packages', 'env', 'revert', 'expect', 'check', 'original', 'learner', 'result']);

// Saved output is cut to this many characters per stream; checks then compare hashes instead.
const MAX_SAVED_OUTPUT = 10000;

// Files bigger than this aren't read back into an editable block.
const MAX_SYNC_BYTES = 1024 * 1024;

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

// Hashes are taken over normalized text so line endings and trailing blank lines don't matter.
function normalize(text) {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

// Block ids are UUIDs, such as 3f2b8c1e-9d4a-4c7e-8b1f-2a6d5e9c0b47.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Seconds a `requires: - command:` check may take, unless it sets its own timeout.
const PREREQ_TIMEOUT = 10;
// A failed command check is run again when its block next renders, once it's this old (ms), since
// what it checks for (a running cluster, say) may well be there by then.
const RECHECK_FAILED_MS = 5000;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "run" or "file", from the fence line.
function blockKind(info) {
  return info.trim().split(/\s+/)[0];
}

// Finds every ```run and ```file fence in a note, including ones nested in callouts or lists.
function parseBlocks(text, infoRe = BLOCK_RE) {
  const lines = text.split('\n');
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(FENCE_RE);
    if (!open) {
      if (m) open = { lineStart: i, prefix: m[1], fence: m[2], info: m[3].trim(), body: [] };
      continue;
    }
    const closes = m && m[2][0] === open.fence[0] && m[2].length >= open.fence.length && m[3].trim() === '';
    if (closes) {
      if (infoRe.test(open.info)) {
        blocks.push({
          lineStart: open.lineStart, lineEnd: i, prefix: open.prefix, info: open.info, source: open.body.join('\n'),
        });
      }
      open = null;
    } else {
      open.body.push(line.startsWith(open.prefix) ? line.slice(open.prefix.length) : line);
    }
  }
  return blocks;
}

// The ```choose blocks in a note: { line, lineEnd, forId, chosen, prompt, labels, warnings }.
// `chosen` is the id of the way the learner picked, which the plugin writes into the block. Like a
// block's result, it's the learner's, not the course's.
function parseChoosers(text) {
  return parseBlocks(text, CHOOSE_RE).map((b) => {
    const out = { line: b.lineStart, lineEnd: b.lineEnd, forId: null, chosen: null, prompt: null, labels: {}, warnings: [] };
    let header = null;
    try {
      header = parseYaml(b.source);
    } catch (e) {
      out.warnings.push(`The chooser's YAML doesn't parse: ${e.message}`);
      return out;
    }
    if (!header || typeof header !== 'object' || !header.for) {
      out.warnings.push('A chooser needs "for:", the id of the usual way\'s first block.');
      return out;
    }
    const id = String(header.for).trim();
    if (UUID_RE.test(id)) out.forId = id;
    else out.warnings.push(`for: "${id}" isn't a block id. Use the id (a UUID) of the usual way's first block.`);
    if (header.chosen != null && UUID_RE.test(String(header.chosen).trim())) out.chosen = String(header.chosen).trim();
    if (header.prompt != null) out.prompt = String(header.prompt);
    if (header.labels && typeof header.labels === 'object') {
      for (const [k, v] of Object.entries(header.labels)) out.labels[k] = String(v);
    }
    return out;
  });
}

// Sets the way picked in the note's chooser for forId: its `chosen:` line, at the end of the block.
// A null wayId removes it.
function setChosen(text, forId, wayId) {
  let out = text;
  for (const block of parseBlocks(text, CHOOSE_RE).reverse()) {
    const [chooser] = parseChoosers('```choose\n' + block.source + '\n```');
    if (chooser.forId !== forId) continue;
    const lines = block.source.split('\n').filter((line) => !/^chosen\s*:/.test(line));
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (wayId) lines.push(`chosen: ${wayId}`);
    out = replaceBody(out, block, lines.join('\n'));
  }
  return out;
}

// The note's headings, outside code blocks, callouts and frontmatter: { line, level, text }.
function noteHeadings(lines) {
  const out = [];
  let i = 0;
  if (/^---\s*$/.test(lines[0] || '')) {
    const end = lines.findIndex((l, j) => j > 0 && /^---\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  let fence = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(FENCE_RE);
    if (fence) {
      if (m && m[2][0] === fence[0] && m[2].length >= fence.length && m[3].trim() === '') fence = null;
      continue;
    }
    if (m) {
      fence = m[2];
      continue;
    }
    const h = line.match(/^(#{1,6})[ \t]+(.*?)[ \t#]*$/);
    if (h) out.push({ line: i, level: h[1].length, text: h[2] });
  }
  return out;
}

// The section a line is in: from the heading above it to the next heading at that level or above.
// `to` is the first line after it. Null if there's no heading above the line.
function sectionAround(headings, line, total) {
  let heading = null;
  for (const h of headings) {
    if (h.line > line) break;
    heading = h;
  }
  if (!heading) return null;
  const next = headings.find((h) => h.line > heading.line && h.level <= heading.level);
  return { heading, from: heading.line, to: next ? next.line : total };
}

// The line a block's `id:` is on, inside a callout or not. -1 if it isn't in the note.
function lineOfId(lines, id) {
  return lines.findIndex((l) => l.replace(/^(?:[ \t]*>)*[ \t]*/, '') === `id: ${id}`);
}

// Splits a block body into its YAML header and the code or file content below the first "---" line.
// The header may also open with a "---" line of its own, like note frontmatter.
// `lines` are the body's lines; the header spans lines[start..sep) and the content follows sep.
function splitHeader(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const none = { header: null, unknown: [], error: null, lines, start: 0, sep: -1, content: normalize(source) };
  // Only an unindented "---" counts, so a "---" inside an indented YAML value (e.g. original: |) doesn't.
  const isSep = (line) => /^---[ \t]*$/.test(line);
  const start = isSep(lines[0]) ? 1 : 0;
  const sep = lines.findIndex((line, i) => i >= start && isSep(line));
  if (sep < 0) return none;
  let header;
  try {
    header = parseYaml(lines.slice(start, sep).join('\n'));
  } catch (e) {
    // Commands with ": " or " #" in them are a common way to break YAML; say so if this was meant as a header.
    const meant = lines.slice(start, sep).some((line) => /^(\w[\w-]*)\s*:/.test(line) && HEADER_KEYS.has(line.split(':')[0].trim()));
    return meant ? Object.assign({}, none, { error: `The header isn't valid YAML (${e.message.split('\n')[0]}). Quote values that contain ": " or " #", or use "|".` }) : none;
  }
  if (header == null) header = {};
  if (typeof header !== 'object' || Array.isArray(header)) return none;
  const keys = Object.keys(header);
  if (keys.length && !keys.some((k) => HEADER_KEYS.has(k))) return none;
  return {
    header, unknown: keys.filter((k) => !HEADER_KEYS.has(k)), error: null, lines, start, sep,
    content: normalize(lines.slice(sep + 1).join('\n')),
  };
}

// Which key a shorthand scalar stands for, e.g. `expect: 3` means expect.output in a run block.
function shorthandKey(kind, keyPath) {
  const at = keyPath.join('.');
  if (at === 'expect') return kind === 'file' ? 'content' : 'output';
  if (at === 'check') return 'run';
  if (at === 'check.expect') return 'output';
  return 'value';
}

// Sets one header value (`keyPath` like ['id'] or ['check', 'expect', 'md5']) and returns the new
// block body. Edits lines in place so the author's formatting and comments survive; a body without
// a header gets one. Falls back to re-serialising the header when its layout is unusual (a shorthand
// scalar like `expect: 3` that has to become a map, or a flow map like `{ md5: x }`).
function setHeaderValue(source, keyPath, value, kind) {
  const parts = splitHeader(source);
  const scalar = stringifyYaml(value).trim();
  const entry = (indent, keys) => keys.map((k, j) => `${indent}${'  '.repeat(j)}${k}:${j === keys.length - 1 ? ` ${scalar}` : ''}`);
  if (!parts.header) return [...entry('', keyPath), '---', ...parts.lines].join('\n');

  const rebuild = () => {
    const header = JSON.parse(JSON.stringify(parts.header));
    let node = header;
    keyPath.slice(0, -1).forEach((k, d) => {
      if (node[k] == null) node[k] = {};
      else if (typeof node[k] !== 'object') node[k] = { [shorthandKey(kind, keyPath.slice(0, d + 1))]: node[k] };
      node = node[k];
    });
    node[keyPath[keyPath.length - 1]] = value;
    const yaml = stringifyYaml(header).replace(/\s+$/, '').split('\n');
    return [...parts.lines.slice(0, parts.start), ...yaml, ...parts.lines.slice(parts.sep)].join('\n');
  };

  const lines = parts.lines.slice();
  const indentOf = (line) => line.match(/^[ \t]*/)[0];
  const skip = (line) => line.trim() === '' || line.trim().startsWith('#');
  // The map being searched: lines [from, to) whose own entries sit at `indent`.
  let from = parts.start;
  let to = parts.sep;
  let indent = '';
  for (let d = 0; d < keyPath.length; d++) {
    const key = keyPath[d];
    const re = new RegExp(`^${escapeRe(key)}\\s*:(.*)$`);
    let idx = -1;
    for (let i = from; i < to && idx < 0; i++) {
      if (!skip(lines[i]) && indentOf(lines[i]) === indent && re.test(lines[i].slice(indent.length))) idx = i;
    }
    if (idx < 0) {
      // Missing: add the rest of the path. A top-level id goes first, other top-level keys last,
      // and nested keys right under their parent.
      const at = d > 0 ? from : key === 'id' ? from : to;
      lines.splice(at, 0, ...entry(indent, keyPath.slice(d)));
      return lines.join('\n');
    }
    if (d === keyPath.length - 1) {
      lines[idx] = `${indent}${key}: ${scalar}`;
      return lines.join('\n');
    }
    const rest = lines[idx].slice(indent.length).match(re)[1].trim();
    if (rest && !rest.startsWith('#')) return rebuild();
    let end = idx + 1;
    while (end < to && (skip(lines[end]) || indentOf(lines[end]).length > indent.length)) end++;
    const child = lines.slice(idx + 1, end).find((line) => !skip(line));
    from = idx + 1;
    to = end;
    indent = child ? indentOf(child) : `${indent}  `;
  }
  return lines.join('\n');
}

// Sets a top-level header entry that may span several lines (like original: |), or removes it when
// `value` is null. The new entry goes at the end of the header; other lines are left as written.
// `literal` writes a string as a literal block, line for line, whatever YAML would choose.
function setHeaderEntry(source, key, value, literal) {
  const parts = splitHeader(source);
  const entry = value == null ? [] : literal ? literalEntry(key, String(value))
    : stringifyYaml({ [key]: value }).replace(/\s+$/, '').split('\n');
  if (!parts.header) return entry.length ? [...entry, '---', ...parts.lines].join('\n') : source;
  const lines = parts.lines.slice();
  const keyRe = new RegExp(`^${escapeRe(key)}\\s*:`);
  let sep = parts.sep;
  for (let i = parts.start; i < sep;) {
    if (!keyRe.test(lines[i])) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < sep && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) end++;
    lines.splice(i, end - i);
    sep -= end - i;
  }
  lines.splice(sep, 0, ...entry);
  return lines.join('\n');
}

// A header entry as a literal block, keeping every line exactly. The indentation indicator ("2")
// lets lines start with spaces, and "-" drops the final newline, which notes don't keep anyway.
// Git's clean filter (strip-progress.py in the vault) reads entries in this shape.
function literalEntry(key, value) {
  if (value === '') return [`${key}: ""`];
  return [`${key}: |2-`, ...value.split('\n').map((line) => (line ? `  ${line}` : ''))];
}

// A block body with the content below its "---" replaced by `content`.
function setContent(source, content) {
  const parts = splitHeader(source);
  if (!parts.header) return content;
  return [...parts.lines.slice(0, parts.sep + 1), ...(content === '' ? [] : content.split('\n'))].join('\n');
}

// A block body whose code is `code`. The code always goes below "---", so the note reads as what
// was run, even without the plugin. While it differs from the author's original, the original is
// kept in the header, as `original:`, and it moves back below "---" once the code is the original
// again. An older note's `learner:` entry (the answer in the header) is converted.
// `now` is the block as the note says now, not as it rendered: an earlier save may have changed it.
function withLearner(now, body, code) {
  const keep = code === now.original ? null : now.original;
  if (now.code === code && now.stored === keep && now.legacy === null) return body;
  const updated = setHeaderEntry(setHeaderEntry(body, 'learner', null), 'original', keep, true);
  return setContent(updated, code);
}

// Writes `body` back into `block` within the note's text, restoring any callout/list prefix.
function replaceBody(text, block, body) {
  const lines = text.split('\n');
  const cr = lines[block.lineStart].endsWith('\r') ? '\r' : '';
  const prefixed = body.split('\n').map((line) => (line ? block.prefix + line : block.prefix.replace(/[ \t]+$/, '')) + cr);
  lines.splice(block.lineStart + 1, block.lineEnd - block.lineStart - 1, ...prefixed);
  return lines.join('\n');
}

// A short description of a block, for messages about it: its file, or its first line of code.
// A text editor with syntax highlighting: a <textarea> laid over a copy of its text, highlighted with
// Obsidian's Prism. The textarea's own text is transparent, so you see the highlighted copy, with the
// textarea's caret and selection on top. The copy sets the height, so the textarea always fits.
// Used by editable blocks and by the code file view. `isolate` stops clicks and keys reaching the
// note around it; `onRun` is called on Shift/Cmd/Ctrl+Enter. Returns { wrap, textarea, paint }.
function codeEditor(plugin, parent, { lang, value, onInput, isolate = false, onRun = null, cls = '' }) {
  const wrap = parent.createDiv({ cls: `run-block-editor-wrap ${cls}`.trim() });
  const pre = wrap.createEl('pre', { cls: `run-block-highlight language-${lang}`, attr: { 'aria-hidden': 'true' } });
  const code = pre.createEl('code', { cls: `language-${lang}` });
  const ta = wrap.createEl('textarea', { cls: 'run-block-editor', attr: { spellcheck: 'false' } });
  ta.value = value;

  const paint = () => {
    const text = ta.value;
    if (text.length > MAX_HIGHLIGHT) code.setText(text);
    else plugin.highlight(code, text, lang);
    // A trailing newline needs something after it, or the copy comes out a line short.
    if (text === '' || text.endsWith('\n')) code.appendText(' ');
  };
  paint();
  if (!plugin.prism) plugin.prismReady.then(paint);

  if (isolate) {
    for (const type of ['mousedown', 'click', 'keydown', 'keyup', 'keypress', 'beforeinput', 'paste', 'cut', 'copy']) {
      ta.addEventListener(type, (evt) => evt.stopPropagation());
    }
  }
  ta.addEventListener('input', () => {
    paint();
    onInput(ta.value);
  });
  ta.addEventListener('keydown', (evt) => {
    if (onRun && evt.key === 'Enter' && (evt.shiftKey || evt.metaKey || evt.ctrlKey)) {
      evt.preventDefault();
      onRun();
    } else if (evt.key === 'Tab' && !evt.shiftKey) {
      evt.preventDefault();
      // execCommand keeps the insertion on the undo stack, unlike setRangeText, and fires input.
      if (!document.execCommand('insertText', false, '  ')) {
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    }
  });
  return { wrap, textarea: ta, paint };
}

// Opens code and config files (YAML, shell scripts, Python, …) in Obsidian, in a highlighted editor.
// Obsidian loads the file and saves it shortly after each edit. Line endings are kept as they were.
class CodeFileView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.editor = null;
    this.crlf = false;
  }

  getViewType() {
    return CODE_VIEW;
  }

  getIcon() {
    return 'file-code';
  }

  getViewData() {
    const text = this.editor ? this.editor.textarea.value : this.data;
    return this.crlf ? text.replace(/\n/g, '\r\n') : text;
  }

  // `clear` means a different file: start a fresh editor. Otherwise the file changed on disk, so
  // update the text and keep the cursor where it was.
  setViewData(data, clear) {
    this.crlf = data.includes('\r\n');
    const text = this.crlf ? data.replace(/\r\n/g, '\n') : data;
    this.data = text;
    if (clear || !this.editor) {
      this.contentEl.empty();
      const ext = this.file ? this.file.extension.toLowerCase() : '';
      this.editor = codeEditor(this.plugin, this.contentEl, {
        lang: CODE_LANGS[ext] || ext || 'none',
        value: text,
        cls: 'run-code-file',
        onInput: (value) => {
          this.data = value;
          this.requestSave();
        },
      });
      return;
    }
    const ta = this.editor.textarea;
    if (ta.value === text) return;
    const { selectionStart, selectionEnd } = ta;
    ta.value = text;
    ta.setSelectionRange(Math.min(selectionStart, text.length), Math.min(selectionEnd, text.length));
    this.editor.paint();
  }

  clear() {
    this.data = '';
    this.editor = null;
    this.contentEl.empty();
  }
}

// The extensions in the code editor setting, without dots, duplicates, or Markdown.
function codeExtensions(setting) {
  const exts = String(setting || '').split(/[\s,]+/).map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean);
  return [...new Set(exts)].filter((e) => e !== 'md');
}

// A note's name, as Obsidian shows it: its file name without the folder or .md.
function noteName(path) {
  return path.replace(/^.*\//, '').replace(/\.md$/, '');
}

function firstLine(code) {
  const first = (code.split('\n').find((line) => line.trim()) || '').trim();
  return first.length > 40 ? `${first.slice(0, 39)}…` : first;
}

function blockLabel(meta) {
  if (meta.kind === 'file') return meta.path || 'file block';
  return `${meta.lang}: ${firstLine(meta.code)}`;
}

function hasChecks(meta) {
  return Object.values(meta.expect).some((v) => v !== null) || !!meta.check;
}

function evaluate(meta, res) {
  if (meta.kind === 'file') return evaluateFile(meta, res);
  const items = [];
  const add = (label, ok, detail) => items.push({ label, ok, detail });
  if (res.error) {
    return { status: 'error', label: res.timedOut ? 'Timed out' : res.stopped ? 'Stopped' : 'Error', items };
  }
  const { expect } = meta;
  if (expect.output !== null) {
    add('output', res.stdout != null && !res.truncated ? normalize(res.stdout) === expect.output : res.outputHash === md5(expect.output));
  }
  if (expect.md5) {
    const ok = res.outputHash === expect.md5;
    add('output MD5', ok, ok ? null : `got ${res.outputHash.slice(0, 8)}…`);
  }
  // res.cmdHash is the code that actually ran, which differs from the note for edited blocks.
  if (expect.commandMd5) add('command', res.cmdHash === expect.commandMd5);
  if (items.some((i) => !i.ok)) return { status: 'fail', label: 'Fail', items };
  if (items.length) return { status: 'pass', label: 'Pass', items };
  if (res.exitCode !== 0) return { status: 'error', label: `Exit ${res.exitCode}`, items };
  return { status: 'ok', label: 'Done', items };
}

// Whether a block's result is a success: it finished, and passed its checks, or ran cleanly without any.
function succeeded(meta, res) {
  if (!res || !res.done) return false;
  const { status } = evaluate(meta, res);
  return status === 'pass' || status === 'ok';
}

// A file block passes when every validation it declares passes. Each check is listed in `items`.
function evaluateFile(meta, res) {
  const items = [];
  const add = (label, ok, detail) => items.push({ label, ok, detail });
  const checkError = res.check && res.check.error;
  if (res.error || checkError) {
    const label = checkError && res.check.timedOut ? 'Timed out' : 'Error';
    return { status: 'error', label, items };
  }
  const { expect, check } = meta;
  if (expect.content !== null) add('content', res.content != null ? res.content === expect.content : res.outputHash === md5(expect.content));
  if (expect.md5) add('content MD5', res.outputHash === expect.md5);
  if (check && res.check) {
    // A saved check result has only its output's hash
    const outHash = res.check.stdout != null ? md5(normalize(res.check.stdout)) : res.check.outputHash;
    if (res.check.exitCode !== 0) add('check', false, `exited ${res.check.exitCode}`);
    else if (check.expect.output === null && !check.expect.md5) add('check', true);
    else {
      if (check.expect.output !== null) add('check output', outHash === md5(check.expect.output));
      if (check.expect.md5) add('check MD5', outHash === check.expect.md5);
    }
  }
  if (items.some((i) => !i.ok)) return { status: 'fail', label: 'Fail', items };
  if (items.length) return { status: 'pass', label: 'Pass', items };
  return { status: 'ok', label: 'Written', items };
}

// What gets saved in a block's `result:` header entry. Output is cut to MAX_SAVED_OUTPUT
// characters per stream; the hashes cover all of it, so checks still evaluate.
function savedResult(meta, res) {
  const cut = (text) => (text && text.length > MAX_SAVED_OUTPUT ? text.slice(0, MAX_SAVED_OUTPUT) : text);
  const saved = { ran: new Date(res.startedAt || Date.now()).toISOString(), 'duration-ms': res.durationMs || 0 };
  if (res.error) saved.error = res.error;
  if (res.timedOut) saved['timed-out'] = true;
  if (res.stopped) saved.stopped = true;
  if (meta.kind === 'file') {
    saved['content-md5'] = res.outputHash;
    if (res.check) {
      saved.check = { exit: res.check.exitCode, 'output-md5': md5(normalize(res.check.stdout || '')) };
      if (res.check.error) saved.check.error = res.check.error;
      if (res.check.timedOut) saved.check['timed-out'] = true;
    }
    return saved;
  }
  const stdout = res.stdout || '';
  const stderr = res.chunks.filter((c) => c.stream === 'stderr').map((c) => c.text).join('');
  Object.assign(saved, { exit: res.exitCode, 'output-md5': res.outputHash, 'command-md5': res.cmdHash });
  if (stdout) saved.stdout = cut(normalize(stdout));
  if (stderr) saved.stderr = cut(normalize(stderr));
  if (stdout.length > MAX_SAVED_OUTPUT || stderr.length > MAX_SAVED_OUTPUT) saved.truncated = true;
  return saved;
}

// Turns a saved `result:` back into the shape of a live result.
function loadResult(meta, saved) {
  const res = {
    done: true, saved: true,
    startedAt: Date.parse(saved.ran) || null,
    durationMs: Number(saved['duration-ms']) || 0,
    error: saved.error || undefined,
    timedOut: saved['timed-out'] === true,
    stopped: saved.stopped === true,
  };
  if (meta.kind === 'file') {
    return Object.assign(res, {
      exitCode: 0, chunks: [], stdout: '', outputHash: String(saved['content-md5'] || ''), cmdHash: String(saved['content-md5'] || ''),
      check: saved.check ? {
        exitCode: saved.check.exit, outputHash: String(saved.check['output-md5'] || ''),
        error: saved.check.error || undefined, timedOut: saved.check['timed-out'] === true,
      } : undefined,
    });
  }
  const stdout = saved.stdout == null ? '' : String(saved.stdout);
  const stderr = saved.stderr == null ? '' : String(saved.stderr);
  return Object.assign(res, {
    exitCode: saved.exit == null ? null : Number(saved.exit),
    stdout, truncated: saved.truncated === true,
    chunks: [{ stream: 'stdout', text: stdout }, { stream: 'stderr', text: stderr }].filter((c) => c.text),
    outputHash: String(saved['output-md5'] || ''), cmdHash: String(saved['command-md5'] || ''),
  });
}

// When a result was produced: a time today, or a date and time.
function formatRan(time) {
  if (!time) return '';
  const when = new Date(time);
  const sameDay = when.toDateString() === new Date().toDateString();
  return sameDay ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : when.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function shellQuote(s) {
  return process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}

function killTree(child, signal) {
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (e) {
    try { child.kill(signal); } catch (e2) { /* already gone */ }
  }
}

function formatDuration(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// Widget for both ```run blocks (execute code) and ```file blocks (write their content to disk).
class RunBlock extends MarkdownRenderChild {
  constructor(plugin, el, source, ctx, section, kind) {
    super(el);
    this.plugin = plugin;
    this.source = source;
    this.ctx = ctx;
    this.section = section;
    this.kind = kind;
    this.renderPending = false;
  }

  async onload() {
    const el = this.containerEl;
    el.addClass('run-block');
    // When Obsidian re-renders this block (say, because its result was just saved), the new widget
    // starts empty and fills in asynchronously. Holding it at the old widget's height until then
    // stops everything below it jumping up and back down.
    const heldHeight = this.plugin.heights.get(this.plugin.keyForSource(this.ctx.sourcePath, this.source));
    if (heldHeight) el.style.minHeight = `${heldHeight}px`;
    // Section info tells identical blocks apart; it can be missing at processor time, so ask again.
    const section = this.section || this.ctx.getSectionInfo(el);
    this.meta = await this.plugin.resolveMeta(this.ctx.sourcePath, this.source, section, this.kind);
    if (this.unloaded) return;
    this.key = this.plugin.keyFor(this.ctx.sourcePath, this.meta);
    this.plugin.settleDraft(this.key, this.meta);
    const isFile = this.meta.kind === 'file';
    if (isFile) el.addClass('run-block-file');
    // Editable file blocks are written when the learner saves, and take in changes made to the file elsewhere.
    this.synced = isFile && this.meta.editable;

    const bar = el.createDiv({ cls: 'run-block-bar' });
    if (isFile) {
      // Written on request, like a run block runs: the write button, or Shift+Enter in the editor.
      this.runBtn = this.button(bar, 'save', `Write ${this.meta.path || 'file'}`, () => this.execute(), { keepFocus: true });
      bar.createSpan({ cls: 'run-block-lang run-block-path', text: this.meta.path || '(no path)' });
    } else {
      this.runBtn = this.button(bar, 'play', 'Run', () => this.execute(), { keepFocus: true });
      this.stopBtn = this.button(bar, 'square', 'Stop', () => this.plugin.stop(this.key));
      bar.createSpan({ cls: 'run-block-lang', text: this.meta.lang });
    }
    if (!this.meta.idempotent) {
      setIcon(bar.createSpan({ cls: 'run-block-validated', attr: { 'aria-label': "Runs once: this block isn't idempotent, so it can't be run again until it's reset" } }), 'repeat-1');
    }
    if (hasChecks(this.meta)) {
      const label = isFile ? 'Checked each time the file is written' : 'Output is checked when run';
      setIcon(bar.createSpan({ cls: 'run-block-validated', attr: { 'aria-label': label } }), 'shield-check');
    }
    this.statusEl = bar.createSpan({ cls: 'run-block-status' });
    bar.createDiv({ cls: 'run-block-spacer' });
    if (this.meta.editable) {
      this.editedEl = bar.createSpan({ cls: 'run-block-edited', text: 'edited' });
    }
    // Reset reverts what the block did, if it has a revert command (↶), or just clears it (eraser).
    this.resetBlockBtn = this.button(bar, this.meta.revert ? 'undo-2' : 'eraser', 'Reset',
      () => this.plugin.resetBlock(this.ctx.sourcePath, this.meta));

    // Shows which dependencies a blocked block is waiting for
    this.waitEl = el.createDiv({ cls: 'run-block-waiting' });
    for (const warning of this.meta.warnings) el.createDiv({ cls: 'run-block-warning', text: warning });

    const codeEl = el.createDiv({ cls: 'run-block-code' });
    if (this.meta.editable) {
      this.renderEditor(codeEl);
    } else {
      this.renderCode(codeEl);
    }

    this.outEl = el.createDiv({ cls: 'run-block-output' });
    this.plugin.attach(this);
    // Every file block watches its file, so what it shows (and whether it can be reset) stays current.
    if (isFile) this.register(this.plugin.watchFile(this.ctx.sourcePath, this.meta, this.synced));
    if (this.synced) {
      this.plugin.syncFromDisk(this.ctx.sourcePath, this.meta, { onLoad: true });
      this.plugin.validateOnLoad(this.ctx.sourcePath, this.meta);
    }
    this.render();
    window.requestAnimationFrame(() => {
      el.style.minHeight = '';
      if (!this.unloaded) this.rememberHeight();
    });
  }

  onunload() {
    this.unloaded = true;
    this.plugin.detach(this);
  }

  // What's left on screen when the plugin is turned off: just the block's code.
  showPlainCode() {
    this.unloaded = true;
    const el = this.containerEl;
    el.empty();
    el.removeClass('run-block', 'run-block-file', 'is-ok', 'is-pass', 'is-fail', 'is-error', 'is-blocked', 'is-running');
    el.style.minHeight = '';
    el.createEl('pre').createEl('code', { text: this.meta ? this.meta.code : this.source });
  }

  execute() {
    return this.plugin.runCell(this.ctx.sourcePath, this.meta);
  }

  // `keepFocus`: pressing the button doesn't take focus from the block's editor. The editor saves the
  // learner's code into the note when it loses focus, which re-renders the block, so the click would
  // land on a button that's just been replaced, and be lost. The run saves the code anyway.
  button(parent, icon, label, onClick, { keepFocus = false } = {}) {
    const btn = parent.createEl('button', { cls: 'run-block-btn clickable-icon', attr: { 'aria-label': label } });
    setIcon(btn, icon);
    if (keepFocus) btn.addEventListener('mousedown', (evt) => evt.preventDefault());
    btn.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      onClick(evt);
    });
    return btn;
  }

  // Read-only code, highlighted synchronously so a re-rendered block never shows without it.
  renderCode(parent) {
    const lang = PRISM_LANGS[this.meta.lang] || this.meta.lang;
    const pre = parent.createEl('pre', { cls: `language-${lang}` });
    const code = pre.createEl('code', { cls: `language-${lang}` });
    const paint = () => this.plugin.highlight(code, this.meta.code, lang);
    paint();
    if (!this.plugin.prism) this.plugin.prismReady.then(() => { if (!this.unloaded) paint(); });
    const copy = pre.createEl('button', { cls: 'copy-code-button', attr: { 'aria-label': 'Copy' } });
    setIcon(copy, 'copy');
    copy.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      navigator.clipboard.writeText(this.meta.code).then(() => new Notice('Copied'));
    });
  }

  renderEditor(parent) {
    const editor = codeEditor(this.plugin, parent, {
      lang: PRISM_LANGS[this.meta.lang] || this.meta.lang,
      value: this.plugin.currentCode(this.key, this.meta),
      // Keep Live Preview from treating clicks and keys in the editor as edits to the note itself.
      isolate: true,
      onInput: (value) => {
        this.plugin.setDraft(this.key, this.meta, value);
      },
      onRun: () => this.execute(),
    });
    const ta = editor.textarea;
    this.editor = ta;
    this.fitEditor = editor.paint;
    // Saving a result re-renders the block; if you were typing in it, carry on where you were.
    const refocus = this.plugin.refocus;
    if (refocus && refocus.key === this.key) {
      this.plugin.refocus = null;
      window.requestAnimationFrame(() => {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(refocus.start, refocus.end);
      });
    }
    // The learner's version is saved into the note below "---", with the original kept as
    // `original:`. Saving re-renders the block, so it's done once the learner moves on, not as they type.
    // A block that has re-rendered since isn't saved: the new one has the learner's text, and this
    // one's meta is out of date.
    ta.addEventListener('blur', () => {
      if (this.unloaded || !ta.isConnected) return;
      this.plugin.persistLearner(this.ctx.sourcePath, this.meta, normalize(ta.value));
    });
  }

  scheduleRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    window.requestAnimationFrame(() => {
      this.renderPending = false;
      if (this.unloaded) return;
      this.render();
      if (!this.containerEl.style.minHeight) this.rememberHeight();
    });
  }

  // The output box's scroll position is kept in the plugin, so it survives this widget being
  // rebuilt, or replaced when Obsidian re-renders the block.
  saveOutputScroll() {
    const pre = this.outEl && this.outEl.querySelector('.run-block-stream');
    // A box that isn't on screen reports 0, which would wipe the real position.
    if (!pre || !this.key || !pre.isConnected || pre.clientHeight === 0) return;
    this.plugin.outputScroll.set(this.key, {
      top: pre.scrollTop,
      atBottom: pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4,
    });
  }

  restoreOutputScroll(pre, running) {
    const apply = () => this.applyOutputScroll(pre, running);
    apply();
    // A new widget may not be laid out yet, and then setting scrollTop does nothing: try again once it is.
    window.requestAnimationFrame(() => {
      apply();
      window.requestAnimationFrame(apply);
    });
    pre.addEventListener('scroll', () => this.saveOutputScroll(), { passive: true });
  }

  applyOutputScroll(pre, running) {
    if (!pre || !pre.isConnected || pre.clientHeight === 0) return;
    const saved = this.plugin.outputScroll.get(this.key);
    // While output streams in, keep following it if you were already at the bottom.
    if (saved) pre.scrollTop = running && saved.atBottom ? pre.scrollHeight : saved.top;
    else if (running) pre.scrollTop = pre.scrollHeight;
  }

  // Browsers reset the scroll position of an element taken out of the page and put back, which
  // Obsidian's editor does to blocks when the note changes. This puts the saved position back.
  reapplyOutputScroll() {
    const pre = this.outEl && this.outEl.querySelector('.run-block-stream');
    const res = this.plugin.resultFor(this.ctx.sourcePath, this.meta);
    this.applyOutputScroll(pre, !!res && !res.done);
  }

  // Remembers how tall this block is, so a re-render of it can start at that height.
  rememberHeight() {
    const height = this.containerEl.offsetHeight;
    if (height > 0 && this.key) this.plugin.heights.set(this.key, height);
  }

  render() {
    const res = this.plugin.resultFor(this.ctx.sourcePath, this.meta);
    const rev = this.plugin.reverts.get(this.key);
    const reverting = !!rev && !rev.done;
    const running = !!res && !res.done;
    if (this.stopBtn) {
      this.runBtn.toggleClass('run-block-hidden', running);
      this.stopBtn.toggleClass('run-block-hidden', !running);
    }
    if (this.editor) {
      const code = this.plugin.currentCode(this.key, this.meta);
      const edited = code !== this.meta.original;
      // Reset is the way back to the original.
      this.editedEl.toggleClass('run-block-hidden', !edited);
      // Another view of the same note, or the file on disk, may have changed the content.
      if (document.activeElement !== this.editor && normalize(this.editor.value) !== code) {
        this.editor.value = code;
        this.fitEditor();
      }
    }
    // Rebuilding the output resets its scroll position and flickers, so only do it when something
    // it shows has changed.
    if (this.plugin.settings.checkOnOpen) this.plugin.checkPrerequisites(this.ctx.sourcePath, this.meta);
    const deps = this.plugin.prerequisiteState(this.ctx.sourcePath, this.meta);
    const signature = JSON.stringify([
      res && [res.done, res.startedAt, res.chunks && res.chunks.reduce((n, c) => n + c.text.length, 0), res.error, res.exitCode, res.saved, res.check && [res.check.exitCode, res.check.error]],
      deps.waiting, this.meta.id, this.meta.expect, this.meta.check,
      rev && [rev.done, rev.ok, rev.chunks.reduce((n, c) => n + c.text.length, 0)],
      this.plugin.resetBlocker(this.ctx.sourcePath, this.meta),
      this.plugin.rerunBlocker(this.ctx.sourcePath, this.meta),
      this.meta.kind === 'file' ? this.plugin.diskState(this.ctx.sourcePath, this.meta) : null,
    ]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.saveOutputScroll();
    this.statusEl.className = 'run-block-status';
    this.statusEl.empty();
    this.outEl.empty();
    this.containerEl.removeClass('is-ok', 'is-pass', 'is-fail', 'is-error', 'is-blocked', 'is-replaced');
    // Only change is-running when running starts or stops: removing it even briefly, while output
    // streams in, restarts its pulse animation.
    this.containerEl.toggleClass('is-running', running || reverting);
    this.renderDependencies(res);
    this.renderUndoButtons(res);

    if (this.meta.kind === 'file') {
      this.renderFile(res);
      this.renderRevert(rev);
      return;
    }
    if (!res) {
      this.outEl.toggle(!!rev);
      this.renderRevert(rev);
      return;
    }
    this.outEl.show();

    const pre = this.outEl.createEl('pre', { cls: 'run-block-stream' });
    for (const chunk of res.chunks) {
      pre.createSpan({ cls: chunk.stream === 'stderr' ? 'run-stderr' : 'run-stdout', text: chunk.text });
    }
    if (!res.chunks.length) pre.createSpan({ cls: 'run-block-muted', text: running ? '' : '(no output)' });
    this.restoreOutputScroll(pre, running);
    if (res.error) this.outEl.createDiv({ cls: 'run-block-error', text: res.error });

    if (running) {
      this.statusEl.addClass('is-running');
      this.containerEl.addClass('is-running');
      this.statusEl.setText('Running…');
      return;
    }

    const verdict = evaluate(this.meta, res);
    this.statusEl.addClass(`is-${verdict.status}`);
    this.statusEl.setText(verdict.label);
    this.containerEl.addClass(`is-${verdict.status}`);

    const foot = this.outEl.createDiv({ cls: 'run-block-footer' });
    foot.createSpan({ text: `exit ${res.exitCode === null ? '—' : res.exitCode} · ${formatDuration(res.durationMs)}${res.startedAt ? ` · ran ${formatRan(res.startedAt)}` : ''}` });
    if (res.truncated) foot.createSpan({ cls: 'run-block-muted', text: `output cut to ${MAX_SAVED_OUTPUT} characters` });
    renderItems(foot, verdict.items);
    this.renderRevert(rev);
  }

  // The Reset button says what it'll do, and is only enabled when there's something it can reset.
  renderUndoButtons(res) {
    if (!this.resetBlockBtn) return;
    const blocker = this.plugin.resetBlocker(this.ctx.sourcePath, this.meta);
    const again = this.meta.idempotent ? '' : ', so it can run again';
    this.resetBlockBtn.disabled = !!blocker;
    this.resetBlockBtn.setAttr('aria-label', blocker ? `Reset: unavailable, because ${blocker}`
      : this.synced ? `Reset: ${this.meta.revert && res ? 'undo what this block did, then ' : ''}discard the edits and delete ${this.meta.path}`
      : this.meta.editable ? `Reset: ${this.meta.revert && res ? 'undo what this block did, ' : ''}${res ? 'clear its result, ' : ''}and put the original code back${again}`
      : this.meta.kind === 'file' ? `Reset: ${this.meta.revert && res ? 'undo what this block did, then ' : ''}clear its result and delete ${this.meta.path}${again}`
      : this.meta.revert && res ? `Reset: undo what this block did, then clear its result${again}`
      : res ? `Reset: clear this block's result${again}`
      : "Reset: clear the revert's output");
  }

  // A block's last revert: in progress, done (the block is back to not having run), or failed (the
  // block keeps its result, and the revert's output shows what went wrong).
  renderRevert(rev) {
    if (!rev) return;
    if (!rev.done) {
      this.statusEl.className = 'run-block-status is-running';
      this.statusEl.setText('Reverting…');
    } else if (rev.ok && !this.plugin.resultFor(this.ctx.sourcePath, this.meta)) {
      this.statusEl.className = 'run-block-status is-reverted';
      this.statusEl.setText('Reverted');
    }
    const box = this.outEl.createDiv({ cls: `run-block-revert ${!rev.done ? 'is-running' : rev.ok ? 'is-ok' : 'is-error'}` });
    const title = !rev.done ? 'Reverting…'
      : rev.ok ? `Reverted ${formatRan(rev.startedAt)}`
      : `Revert failed: ${rev.error || `exit ${rev.exitCode}`}. The block's result is kept.`;
    box.createDiv({ cls: 'run-block-revert-title', text: title });
    if (rev.chunks.length) {
      const pre = box.createEl('pre', { cls: 'run-block-stream' });
      for (const chunk of rev.chunks) pre.createSpan({ cls: chunk.stream === 'stderr' ? 'run-stderr' : 'run-stdout', text: chunk.text });
    }
  }

  // A block whose prerequisites aren't met can't run: its run button is disabled, and it lists what
  // it needs. Until it has run, it's also labelled Blocked.
  renderDependencies(res) {
    const { blocked, waiting } = this.plugin.prerequisiteState(this.ctx.sourcePath, this.meta);
    const once = this.plugin.rerunBlocker(this.ctx.sourcePath, this.meta);
    if (this.runBtn) {
      this.runBtn.disabled = blocked || !!once;
      this.runBtn.setAttr('aria-label', blocked ? `Blocked: ${waiting.map((w) => w.summary).join('; ')}`
        : once ? `Can't run again: ${once}`
        : (this.meta.kind === 'file' ? `Write ${this.meta.path || 'file'}` : 'Run'));
    }
    // An alternative that hasn't run says what it's instead of: Run all doesn't choose it.
    const instead = !blocked && !res ? (this.meta.insteadOf || []).map((id) => this.plugin.findBlock(id, this.ctx.sourcePath)).filter(Boolean) : [];
    this.waitEl.empty();
    this.waitEl.toggle(blocked || !!once || instead.length > 0);
    if (!blocked) {
      if (once) {
        setIcon(this.waitEl.createSpan({ cls: 'run-block-waiting-icon' }), 'repeat-1');
        this.waitEl.createSpan({ text: `Runs once: ${once}.` });
      } else if (instead.length) {
        setIcon(this.waitEl.createSpan({ cls: 'run-block-waiting-icon' }), 'split');
        this.waitEl.createSpan({ text: 'Instead of ' });
        instead.forEach((f, i) => {
          if (i) this.waitEl.createSpan({ text: i === instead.length - 1 ? ' and ' : ', ' });
          this.waitEl.createEl('code', { text: blockLabel(f.meta) });
          this.waitEl.createSpan({ cls: 'run-block-waiting-reason', text: ` (line ${f.meta.lineStart + 1}${f.path === this.ctx.sourcePath ? '' : ` in ${noteName(f.path)}`})` });
        });
        this.waitEl.createSpan({ text: '. Run all takes the other way, so run this with ▶ to choose it.' });
      }
      return;
    }
    // A block of another note, as code, with a link to its note.
    const blockRef = (w) => {
      this.waitEl.createEl('code', { text: w.label });
      if (!w.note) return;
      this.waitEl.createSpan({ text: ' in ' });
      const link = this.waitEl.createEl('a', { cls: 'internal-link', text: noteName(w.note), href: w.note });
      link.addEventListener('click', (evt) => {
        evt.preventDefault();
        this.plugin.app.workspace.openLinkText(w.note, this.ctx.sourcePath, evt.metaKey || evt.ctrlKey);
      });
    };
    const reason = (text) => this.waitEl.createSpan({ cls: 'run-block-waiting-reason', text: ` (${text})` });
    // The other way is in use (this block is replaced, or on the path not taken): it isn't needed,
    // rather than blocked.
    const replaced = waiting.find((w) => w.type === 'replaced' || w.type === 'other-path');
    if (replaced) {
      setIcon(this.waitEl.createSpan({ cls: 'run-block-waiting-icon' }), 'split');
      this.waitEl.createSpan({ text: replaced.chosen ? 'Not needed: the chooser is set to the way at ' : "Not needed: you're using " });
      blockRef(replaced);
      reason(`line ${replaced.line}`);
      this.waitEl.createSpan({ text: replaced.chosen ? '. Choose this way there to do this instead.' : ' instead. Reset that to do this instead.' });
      if (!res) {
        this.statusEl.addClass('is-replaced');
        this.statusEl.setText('Not needed');
        this.containerEl.addClass('is-replaced');
      }
      return;
    }
    setIcon(this.waitEl.createSpan({ cls: 'run-block-waiting-icon' }), 'lock');
    this.waitEl.createSpan({ text: 'Before this can run: ' });
    waiting.forEach((w, i) => {
      if (i) this.waitEl.createSpan({ text: '; ' });
      if (w.type === 'matches') {
        this.waitEl.createSpan({ text: w.message });
      } else if (w.type === 'command') {
        if (w.message) this.waitEl.createSpan({ text: `${w.message} ` });
        this.waitEl.createEl('code', { text: w.label });
        reason(w.message ? w.reason : `has to succeed: ${w.reason}`);
      } else {
        this.waitEl.createSpan({ text: w.message ? `${w.message}: run ` : 'run ' });
        blockRef(w);
        const where = w.line ? `line ${w.line}${w.below ? ', which is below this block' : ''}, ` : '';
        reason(`${where}${w.reason}`);
      }
    });
    if (waiting.some((w) => w.type === 'command' && w.failed)) {
      const again = this.waitEl.createEl('button', { cls: 'run-block-recheck', text: 'Check again' });
      again.addEventListener('click', () => this.plugin.checkPrerequisites(this.ctx.sourcePath, this.meta, { force: true }));
    }
    if (!res) {
      this.statusEl.addClass('is-blocked');
      this.statusEl.setText('Blocked');
      this.containerEl.addClass('is-blocked');
    }
  }

  renderFile(res) {
    const checking = !!res && !res.done;
    let verdict = null;
    if (checking) {
      this.statusEl.addClass('is-running');
      this.containerEl.addClass('is-running');
      this.statusEl.setText('Checking…');
    } else if (res) {
      verdict = evaluate(this.meta, res);
      this.statusEl.addClass(`is-${verdict.status}`);
      this.statusEl.setText(verdict.label);
      this.containerEl.addClass(`is-${verdict.status}`);
    }
    this.outEl.show();
    if (res && res.error) this.outEl.createDiv({ cls: 'run-block-error', text: res.error });

    // The check's output is only used for validation, never shown; just report if it couldn't run.
    const check = res && res.done && res.check;
    if (check && check.error) this.outEl.createDiv({ cls: 'run-block-error', text: `check: ${check.error}` });

    const disk = this.plugin.diskState(this.ctx.sourcePath, this.meta);
    const foot = this.outEl.createDiv({ cls: 'run-block-footer' });
    if (disk.error) {
      if (!res || !res.error) foot.createSpan({ cls: 'is-fail', text: disk.error });
    } else {
      const states = {
        missing: ['', this.meta.editable ? 'not on disk yet: press save to write it' : 'not on disk yet'],
        same: ['is-pass', 'on disk, matches this block'],
        differs: ['', this.meta.editable ? 'not saved to disk yet: press save to write it' : 'on disk, differs from this block'],
      };
      const [cls, text] = states[disk.state];
      foot.createSpan({ text: disk.relPath });
      foot.createSpan({ cls, text });
    }
    if (verdict) renderItems(foot, verdict.items);
    if (res && res.done && res.startedAt) foot.createSpan({ text: `written ${formatRan(res.startedAt)}` });
  }
}

function renderItems(parent, items) {
  for (const item of items) {
    const text = `${item.label} ${item.ok ? '✓' : '✗'}${item.detail ? ` (${item.detail})` : ''}`;
    parent.createSpan({ cls: item.ok ? 'is-pass' : 'is-fail', text });
  }
}

// Widget for ```choose blocks: one button per way of doing a step (the usual way, and each
// instead-of alternative to it). Picking one hides the sections of the others, and Run all takes it.
class ChooseBlock extends MarkdownRenderChild {
  constructor(plugin, el, source, ctx) {
    super(el);
    this.plugin = plugin;
    this.source = source;
    this.ctx = ctx;
  }

  onload() {
    this.containerEl.addClass('run-block-choose');
    this.plugin.choosers.add(this);
    this.render();
  }

  onunload() {
    this.plugin.choosers.delete(this);
  }

  async render() {
    const path = this.ctx.sourcePath;
    const info = this.ctx.getSectionInfo(this.containerEl);
    const file = this.plugin.getFile(path);
    const text = (info && info.text) || (file ? await this.plugin.app.vault.cachedRead(file) : '');
    const [chooser] = parseChoosers('```choose\n' + this.source + '\n```');
    const el = this.containerEl;
    el.empty();
    for (const warning of chooser.warnings) el.createDiv({ cls: 'run-block-warning', text: warning });
    if (!chooser.forId) return;
    const ways = this.plugin.chooserWays(chooser.forId, path);
    if (ways.length < 2) {
      el.createDiv({ cls: 'run-block-warning', text: ways.length ? 'No block is instead-of the block this chooser is for, so there is nothing to choose.' : `There's no block ${chooser.forId} in the vault.` });
      return;
    }
    const current = this.plugin.currentWay(chooser.forId, path);
    const label = (w) => this.plugin.wayLabel(w, chooser, text);
    if (chooser.prompt) el.createDiv({ cls: 'run-block-choose-prompt', text: chooser.prompt });
    const row = el.createDiv({ cls: 'run-block-choose-ways' });
    for (const way of ways) {
      const active = current && current.way.id === way.id;
      const btn = row.createEl('button', { cls: `run-block-choose-way${active ? ' is-active mod-cta' : ''}`, text: label(way) });
      // Locked to the way in use. Not the disabled attribute: a disabled button shows no tooltip.
      const locked = current && current.locked && !active;
      if (locked) {
        btn.addClass('is-disabled');
        btn.setAttr('aria-disabled', 'true');
        btn.setAttr('aria-label', `You're using ${label(current.way)}. To choose another way, reset its blocks first.`);
      }
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        if (!locked) this.plugin.chooseWay(chooser.forId, way.id, path);
      });
    }
  }
}

class RunnableBlocksPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.results = new Map(); // key -> result; survives re-renders so output stays put while editing
    this.removed = new Set(); // keys of file blocks whose file Reset deleted
    this.resetting = new Set(); // keys of synced file blocks being reset, which mustn't sync or validate meanwhile
    this.commandChecks = new Map(); // commandKey -> outcome of a `requires: - command:` check
    this.procs = new Map(); // key -> running process entry
    this.drafts = new Map(); // key -> edited code of an editable block, until saved or reset
    this.widgets = new Map(); // key -> Set<RunBlock>
    this.written = new Map(); // key -> md5 of what a file block last wrote to disk
    this.noteIndex = new Map(); // note path -> metas of its blocks, for resolving depends-on across the vault
    this.heights = new Map(); // key -> last rendered height, so a re-render can start at it
    this.outputScroll = new Map(); // key -> { top, atBottom } of the block's output box
    this.reverts = new Map(); // key -> the block's last revert: its output and how it went
    this.revertProcs = new Map(); // key -> a revert that's running
    // Prism highlights code synchronously once loaded, so blocks never render without their code.
    this.prism = null;
    this.prismReady = loadPrism().then((prism) => { this.prism = prism; }).catch(() => {});

    // The way picked in a chooser was once kept in the settings. It's in the note now.
    if (this.settings.choices) {
      delete this.settings.choices;
      await this.saveSettings();
    }
    this.chooserIndex = new Map(); // note path -> its choosers, with the way picked in each
    this.choosers = new Set(); // ChooseBlock widgets on screen
    this.hiddenShown = new Map(); // note path -> the hidden sections last applied, to spot changes

    for (const kind of ['run', 'file']) {
      this.registerMarkdownCodeBlockProcessor(kind, (source, el, ctx) => {
        ctx.addChild(new RunBlock(this, el, source, ctx, ctx.getSectionInfo(el), kind));
      });
    }
    this.registerMarkdownCodeBlockProcessor('choose', (source, el, ctx) => {
      ctx.addChild(new ChooseBlock(this, el, source, ctx));
    });
    // Reading view: hide each section of a way that wasn't chosen.
    this.registerMarkdownPostProcessor((el, ctx) => this.hideIfNotChosen(el, ctx));
    // Live Preview: the same, with an editor extension.
    const hiding = this.wayHidingExtension();
    if (hiding) this.registerEditorExtension(hiding);

    this.addCommand({
      id: 'run-all',
      name: 'Run all blocks in current note',
      checkCallback: (checking) => {
        const file = this.activeFile();
        if (!file) return false;
        if (!checking) this.runAll(file);
        return true;
      },
    });

    this.addCommand({
      id: 'reset-all',
      name: 'Reset all blocks in current note',
      checkCallback: (checking) => {
        const file = this.activeFile();
        if (!file) return false;
        if (!checking) this.resetAll(file);
        return true;
      },
    });

    this.addCommand({
      id: 'clear-all',
      name: 'Clear all outputs in current note',
      checkCallback: (checking) => {
        const file = this.activeFile();
        if (!file) return false;
        if (!checking) this.clearAll(file);
        return true;
      },
    });

    this.addSettingTab(new RunnableBlocksSettingTab(this.app, this));

    // Code and config files open in the plugin's editor. An extension another plugin, or Obsidian
    // itself, already handles is left to it.
    this.registerView(CODE_VIEW, (leaf) => new CodeFileView(leaf, this));
    this.codeExtensionsSkipped = [];
    for (const ext of codeExtensions(this.settings.codeExtensions)) {
      try {
        this.registerExtensions([ext], CODE_VIEW);
      } catch (e) {
        this.codeExtensionsSkipped.push(ext);
      }
    }

    // When the plugin is reloaded, or turned on while Obsidian is running, open notes can still show
    // blocks rendered by the previous version, especially inside callouts, which Obsidian doesn't
    // re-render. Redraw them. At app start there's nothing stale, so this is skipped.
    if (this.app.workspace.layoutReady) this.app.workspace.onLayoutReady(() => this.redrawOpenNotes());

    // A block can depend on blocks in other notes, so every note's blocks are indexed, not just the
    // open ones', and kept up to date as notes change.
    this.app.workspace.onLayoutReady(() => this.indexVault());
    this.registerEvent(this.app.vault.on('modify', (file) => this.indexNote(file)));
    this.registerEvent(this.app.vault.on('create', (file) => this.indexNote(file)));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (this.noteIndex.delete(file.path)) this.notifyDependents();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.noteIndex.delete(oldPath);
      this.indexNote(file);
    }));
  }

  async indexVault() {
    for (const file of this.app.vault.getMarkdownFiles()) await this.indexNote(file, { quiet: true });
    this.notifyDependents();
  }

  // Indexes a note's blocks. Notes without any are skipped, unless they had some before.
  async indexNote(file, { quiet = false } = {}) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    const text = await this.app.vault.cachedRead(file);
    const has = /^\s*(>\s*)*(```|~~~)\s*(run|file)\b/m.test(text);
    if (!has && !this.noteIndex.has(file.path)) return;
    if (has) this.metasFor(text, file.path);
    else this.noteIndex.delete(file.path);
    if (!quiet) this.notifyDependents();
  }

  // Finds a block by id: in the given note first, then anywhere in the vault. Returns { path, meta } or null.
  findBlock(id, sourcePath) {
    const here = (this.noteIndex.get(sourcePath) || []).find((m) => m.id === id);
    if (here) return { path: sourcePath, meta: here };
    for (const [path, metas] of this.noteIndex) {
      if (path === sourcePath) continue;
      const meta = metas.find((m) => m.id === id);
      if (meta) return { path, meta };
    }
    return null;
  }

  // Re-renders every open note that has runnable blocks, keeping each view's scroll and cursor.
  async redrawOpenNotes() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      if (!parseBlocks(view.getViewData ? view.getViewData() : view.data || '').length) continue;
      if (view.getMode() === 'preview') {
        view.previewMode.rerender(true);
      } else if (typeof leaf.rebuildView === 'function') {
        // Not part of Obsidian's documented API, so only used if it's there.
        const state = view.getEphemeralState();
        await leaf.rebuildView();
        if (leaf.view && leaf.view.setEphemeralState) leaf.view.setEphemeralState(state);
      }
    }
  }

  onunload() {
    for (const entry of this.procs.values()) entry.kill('stopped');
    for (const entry of this.revertProcs.values()) entry.kill('stopped');
    // Obsidian may leave these blocks on screen; show their plain code rather than buttons that no
    // longer do anything.
    for (const widgets of this.widgets.values()) for (const widget of widgets) widget.showPlainCode();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  activeFile() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view && view.file;
  }

  getFile(sourcePath) {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    return file instanceof TFile ? file : null;
  }


  interpreters() {
    const map = {};
    for (const line of this.settings.interpreters.split('\n')) {
      const m = line.match(/^\s*([\w+#.-]+)\s*=\s*(.+?)\s*$/);
      if (m) map[m[1].toLowerCase()] = m[2];
    }
    return map;
  }

  // Everything about a block, from its fence line (run/file) and YAML header. See README for the keys.
  makeMeta(info, source) {
    const kind = blockKind(info);
    const parts = splitHeader(source);
    const h = parts.header || {};
    const text = (v) => (v == null ? null : normalize(String(v)));
    const hash = (v) => (v == null ? null : String(v).trim().toLowerCase());
    const warnings = parts.unknown.map((k) => `Unknown setting "${k}" in this block's header.`);
    // Once a learner edits an editable block, their code is below "---", and the author's original
    // is kept in the header, as `original:`, so Reset can always bring it back. Older notes have
    // it the other way round: the answer in `learner:`, and the original below "---".
    const stored = h.editable === true && h.original != null ? normalize(String(h.original)) : null;
    const legacy = h.editable === true && stored === null && h.learner != null ? normalize(String(h.learner)) : null;
    const original = stored !== null ? stored : parts.content;
    const code = legacy !== null ? legacy : parts.content;
    // The learner's code, or null for a block that hasn't been edited.
    const learner = stored !== null ? parts.content : legacy;
    if (parts.error) warnings.push(parts.error);
    if (h.id != null && !UUID_RE.test(String(h.id))) {
      warnings.push(`This block's id, "${h.id}", isn't a UUID. It gets a new one the first time it runs.`);
    }
    // requires: what has to be true before the block can run. depends-on is shorthand for its block entries.
    const requires = this.parseRequires(h['depends-on'], h.requires, warnings);
    const dependsOn = requires.filter((r) => r.type === 'block').map((r) => r.id);
    // instead-of: the blocks this one is an alternative to, such as "use your own cluster" instead of
    // "create a kind cluster". It starts an alternative path: it and the blocks that depend on it.
    // Once the path is in use, those blocks aren't needed, and once it has succeeded, they count as
    // done for the blocks that depend on them.
    const insteadOf = [];
    for (const v of h['instead-of'] == null ? [] : [].concat(h['instead-of'])) {
      const id = String(v).trim().toLowerCase();
      if (UUID_RE.test(id)) insteadOf.push(id);
      else warnings.push(`instead-of: "${v}" isn't a block id. Use the id (a UUID) of the block this replaces.`);
    }
    // packages: what a python, js or go block's code imports, installed for it (see packageSetup).
    // env: variables to set for the block's code and its revert.
    const lang = String(h.lang || (kind === 'file' ? '' : this.settings.defaultLang)).toLowerCase();
    const packages = h.packages == null ? [] : [].concat(h.packages).filter((p) => p != null && String(p).trim()).map((p) => String(p).trim());
    if (packages.length && kind === 'file') warnings.push('"packages" is for run blocks: a file block only writes its file.');
    else if (packages.length && !PACKAGE_LANGS[lang]) warnings.push(`"packages" works in python, js and go blocks, not ${lang}.`);
    const env = {};
    if (h.env != null && (typeof h.env !== 'object' || Array.isArray(h.env))) {
      warnings.push('"env" needs a map of names to values, such as REDPANDA_BROKERS: 127.0.0.1:9092.');
    } else if (h.env != null) {
      for (const [k, v] of Object.entries(h.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) warnings.push(`env: "${k}" isn't a valid variable name.`);
        else if (v != null && typeof v === 'object') warnings.push(`env: ${k} needs a single value, not a list or map.`);
        else env[k] = v == null ? '' : String(v);
      }
      if (kind === 'file' && Object.keys(env).length) warnings.push('"env" is for run blocks: a file block only writes its file.');
    }
    // A scalar is shorthand for the map's main key (`expect: 3`, `check: <command>`); unknown keys
    // inside the maps get a warning, with a pointer for likely mix-ups.
    const asMap = (value, keyPath, allowed) => {
      if (value == null) return {};
      const map = typeof value === 'object' ? value : { [shorthandKey(kind, keyPath)]: value };
      for (const k of Object.keys(map)) {
        if (allowed.includes(k)) continue;
        const at = `${keyPath.join('.')}.${k}`;
        const hint = { 'check.md5': 'check.expect.md5', 'check.output': 'check.expect.output', 'expect.output': 'expect.content' }[at];
        warnings.push(`Unknown setting "${at}"${hint && kind === 'file' ? ` (did you mean "${hint}"?)` : ''}.`);
      }
      return map;
    };
    const expect = asMap(h.expect, ['expect'], kind === 'file' ? ['content', 'md5'] : ['output', 'md5', 'command-md5']);
    const base = {
      kind,
      // Only a UUID counts; anything else is replaced the first time the block runs.
      id: h.id != null && UUID_RE.test(String(h.id)) ? String(h.id).toLowerCase() : null,
      editable: h.editable === true,
      // Left out of "Run all", e.g. a teardown step at the end of a setup page.
      manual: h.manual === true,
      // idempotent: false marks a block that would fail, or do harm, if run a second time.
      idempotent: h.idempotent !== false,
      requires,
      dependsOn,
      insteadOf,
      saved: h.result && typeof h.result === 'object' ? h.result : null,
      revert: null,
      timeout: Number(h.timeout) || null,
      source: normalize(source),
      original,
      learner,
      stored,
      legacy,
      code,
      cmdHash: md5(code),
      warnings,
    };
    if (kind === 'file') {
      const target = h.path == null ? null : String(h.path);
      const ext = target ? path.extname(target).slice(1).toLowerCase() : '';
      const c = h.check == null ? null : asMap(h.check, ['check'], ['lang', 'run', 'expect']);
      if (c && c.run == null) warnings.push('"check" needs a "run" command.');
      base.revert = this.parseRevert(h.revert, this.settings.defaultLang, warnings);
      // A check's expect has the same shape as a run block's: the command's output, or its MD5.
      const checkExpect = c ? asMap(c.expect, ['check', 'expect'], ['output', 'md5']) : {};
      return Object.assign(base, {
        path: target,
        lang: String(h.lang || LANG_FOR_EXT[ext] || ext || 'text').toLowerCase(),
        expect: { content: text(expect.content), md5: hash(expect.md5) },
        check: c && c.run != null ? {
          lang: String(c.lang || this.settings.defaultLang).toLowerCase(),
          run: normalize(String(c.run)),
          expect: { output: text(checkExpect.output), md5: hash(checkExpect.md5) },
        } : null,
      });
    }
    base.revert = this.parseRevert(h.revert, String(h.lang || this.settings.defaultLang), warnings);
    return Object.assign(base, {
      lang,
      packages: PACKAGE_LANGS[lang] ? packages : [],
      env,
      expect: { output: text(expect.output), md5: hash(expect.md5), commandMd5: hash(expect['command-md5']) },
      check: null,
    });
  }

  // A block's prerequisites, in order: the depends-on ids, then the requires entries. Each entry is
  // one of
  //   block: <id>      that block has run successfully (a bare id is short for this)
  //   command: <code>  this command exits 0 (with optional lang and timeout)
  //   matches: <re>    the block's own code matches this regular expression (with optional flags)
  // and may have a message, shown to the learner instead of the default description.
  parseRequires(dependsOn, requires, warnings) {
    const out = [];
    const block = (value, where, message) => {
      const id = String(value).trim().toLowerCase();
      if (!id) return;
      if (!UUID_RE.test(id)) warnings.push(`${where}: "${value}" isn't a block id. Use the id (a UUID) of a block above.`);
      out.push({ type: 'block', id, message });
    };
    for (const d of dependsOn == null ? [] : [].concat(dependsOn)) block(d, 'depends-on', null);
    const allowed = { block: ['message'], command: ['lang', 'timeout', 'message'], matches: ['flags', 'message'] };
    (requires == null ? [] : [].concat(requires)).forEach((item, i) => {
      const where = `requires, entry ${i + 1}`;
      if (item == null) return;
      if (typeof item !== 'object') return block(item, where, null);
      const types = Object.keys(allowed).filter((k) => item[k] != null);
      if (types.length !== 1) {
        warnings.push(`${where}: needs one of "block", "command" or "matches".`);
        return;
      }
      const type = types[0];
      for (const k of Object.keys(item)) {
        if (k !== type && !allowed[type].includes(k)) warnings.push(`Unknown setting "${k}" in ${where}.`);
      }
      const message = item.message == null ? null : String(item.message).trim() || null;
      if (type === 'block') return block(item.block, where, message);
      if (type === 'command') {
        return out.push({
          type, message,
          lang: String(item.lang || this.settings.defaultLang).toLowerCase(),
          run: normalize(String(item.command)),
          timeout: Number(item.timeout) || PREREQ_TIMEOUT,
        });
      }
      const pattern = String(item.matches);
      const flags = item.flags == null ? '' : String(item.flags);
      try {
        new RegExp(pattern, flags);
      } catch (e) {
        warnings.push(`${where}: "${pattern}" isn't a valid regular expression (${e.message}).`);
        return;
      }
      out.push({ type, message, pattern, flags });
    });
    return out;
  }

  // revert: a command that undoes what the block did, as a string, or a map with lang and run.
  parseRevert(value, defaultLang, warnings) {
    if (value == null) return null;
    const map = typeof value === 'object' ? value : { run: value };
    if (map.run == null) {
      warnings.push('"revert" needs a "run" command.');
      return null;
    }
    return { lang: String(map.lang || defaultLang).toLowerCase(), run: normalize(String(map.run)) };
  }

  // Every block in a note, in order, with its meta. A block whose id an earlier block already has,
  // usually a pasted copy, counts as having no id, so the two never share state.
  metasFor(text, sourcePath) {
    const seen = new Set();
    const entries = parseBlocks(text).map((block) => {
      const meta = this.makeMeta(block.info, block.source);
      meta.lineStart = block.lineStart;
      if (meta.id && seen.has(meta.id)) {
        meta.id = null;
        meta.warnings.push('Another block above has the same id. This one gets a new id the first time it runs.');
      }
      if (meta.id) seen.add(meta.id);
      return { block, meta };
    });
    // Remember the note's blocks, so dependencies between them can be looked up by id.
    if (sourcePath) {
      this.noteIndex.set(sourcePath, entries.map(({ meta }) => meta));
      if (!this.chooserIndex) this.chooserIndex = new Map();
      this.chooserIndex.set(sourcePath, parseChoosers(text));
    }
    return entries;
  }

  // Which of a block's prerequisites aren't met, in the order they're listed. A block prerequisite is
  // met once that block has run successfully: it passed its checks, or ran cleanly if it has none. A
  // command is met once it has exited 0; one that hasn't been checked yet doesn't block, since it's
  // checked when the block runs. A pattern is met while the block's current code matches it.
  // Each entry in `waiting` has a `reason`, and a `summary` for notices.
  prerequisiteState(sourcePath, meta) {
    const waiting = [];
    // Two ways of doing the same thing (see instead-of) can't both be in use: a block can't run while
    // an alternative to it has, nor an alternative while a block it replaces has.
    // The way that's used instead: one that's been started, or picked in a chooser.
    const usedInstead = (other) => {
      const label = blockLabel(other.meta);
      const note = other.path === sourcePath ? null : other.path;
      const chosen = !this.pathInUse(this.alternativePath(other)) && !this.resultFor(other.path, other.meta);
      return {
        type: 'replaced', id: other.meta.id, label, line: other.meta.lineStart + 1, note, reason: chosen ? 'chosen' : 'in use', chosen,
        summary: chosen
          ? `it isn't needed: the chooser is set to the way at line ${other.meta.lineStart + 1} (${label})${note ? ` in ${noteName(note)}` : ''}. Choose this way there to do this instead`
          : `it isn't needed: you're using line ${other.meta.lineStart + 1} (${label})${note ? ` in ${noteName(note)}` : ''} instead. Reset that to do this instead`,
      };
    };
    const alt = this.replacement(sourcePath, meta);
    if (alt) waiting.push(usedInstead(alt));
    const others = new Set();
    for (const start of this.pathsThrough(sourcePath, meta)) for (const id of start.meta.insteadOf) others.add(id);
    for (const id of others) {
      const found = this.findBlock(id, sourcePath);
      if (!found || !this.resultFor(found.path, found.meta)) continue;
      const label = blockLabel(found.meta);
      const note = found.path === sourcePath ? null : found.path;
      waiting.push({
        type: 'other-path', id, label, line: found.meta.lineStart + 1, note, reason: 'already run',
        summary: `reset line ${found.meta.lineStart + 1} (${label})${note ? ` in ${noteName(note)}` : ''} first: this is instead of it`,
      });
    }
    // Alternatives to the same blocks, such as creating a cluster with k3s or using your own instead
    // of with kind, are alternatives to each other too: only one of them can be in use.
    const mine = this.pathsThrough(sourcePath, meta);
    const siblings = new Map();
    for (const start of mine) {
      for (const other of this.siblingAlternatives(start)) {
        if (!mine.some((s) => s.meta.id === other.meta.id)) siblings.set(other.meta.id, other);
      }
    }
    for (const other of siblings.values()) {
      if (this.pathInUse(this.alternativePath(other)) || this.isChosen(other)) waiting.push(usedInstead(other));
    }
    // The usual way picked in a chooser: its alternatives aren't needed either.
    for (const start of mine) {
      for (const forId of start.meta.insteadOf) {
        if (this.choiceFor(forId) !== forId || this.wayInUse(this.chooserWays(forId, start.path))) continue;
        const usual = this.findBlock(forId, start.path);
        if (usual && !waiting.some((w) => w.type === 'replaced')) waiting.push(usedInstead(usual));
      }
    }
    for (const req of meta.requires || []) {
      if (req.type === 'command') {
        const check = this.commandChecks.get(this.commandKey(sourcePath, req));
        if (!check || (check.done && check.ok)) continue;
        const reason = !check.done ? 'checking' : check.error ? check.error : `exit ${check.exitCode}`;
        const label = firstLine(req.run);
        waiting.push({
          type: 'command', label, reason, message: req.message, failed: check.done,
          summary: req.message || `\`${label}\` has to succeed (${reason})`,
        });
        continue;
      }
      if (req.type === 'matches') {
        const code = this.currentCode(this.keyFor(sourcePath, meta), meta);
        if (new RegExp(req.pattern, req.flags).test(code)) continue;
        const message = req.message || "The code isn't in the expected form yet";
        waiting.push({ type: 'matches', label: message, reason: "doesn't match", message, summary: message });
        continue;
      }
      const id = req.id;
      const found = this.findBlock(id, sourcePath);
      if (!found) {
        const label = `${id.slice(0, 8)}…`;
        waiting.push({ type: 'block', id, label, reason: 'not found in the vault', message: req.message, summary: req.message || `${label} isn't in the vault` });
        continue;
      }
      const dep = found.meta;
      // A block in another note: `note` is its path, for the link to it.
      const note = found.path === sourcePath ? null : found.path;
      const res = this.resultFor(found.path, dep);
      let reason = null;
      if (!res) reason = 'not run yet';
      else if (!res.done) reason = 'running';
      else {
        const verdict = evaluate(dep, res);
        if (verdict.status === 'fail') reason = 'failed its checks';
        else if (verdict.status !== 'pass' && verdict.status !== 'ok') reason = verdict.label.toLowerCase();
      }
      // An alternative path that has succeeded stands in for the blocks it replaces.
      if (reason && this.alternativesFor(dep).some((start) => this.pathSucceeded(start))) reason = null;
      if (reason) {
        const label = blockLabel(dep);
        waiting.push({
          type: 'block', id, label, line: dep.lineStart + 1, reason, message: req.message, note,
          below: !note && meta.lineStart != null && dep.lineStart > meta.lineStart,
          summary: req.message || `run line ${dep.lineStart + 1} (${label})${note ? ` in ${noteName(note)}` : ''} first`,
        });
      }
    }
    return { blocked: waiting.length > 0, waiting };
  }

  // Command prerequisites are cached per note and command, so blocks sharing one check share its result.
  commandKey(sourcePath, req) {
    return `${sourcePath}::${req.lang}::${req.run}`;
  }

  // Runs a block's command prerequisites that haven't been checked yet, or failed a while ago (see
  // RECHECK_FAILED_MS), or all of them with `force`. One already running isn't started again.
  // Resolves once they've all finished.
  checkPrerequisites(sourcePath, meta, { force = false } = {}) {
    const file = this.getFile(sourcePath);
    return Promise.all((meta.requires || []).filter((r) => r.type === 'command').map((req) => {
      const key = this.commandKey(sourcePath, req);
      const known = this.commandChecks.get(key);
      const stale = known && known.done && !known.ok && Date.now() - known.at >= RECHECK_FAILED_MS;
      if (known && (!known.done || (!force && !stale))) return known.promise;
      const check = { done: false, output: '' };
      const handle = this.spawnScript(req.lang, req.run, file, req.timeout, (stream, text) => { check.output += text; });
      check.promise = handle.promise.then((outcome) => {
        Object.assign(check, outcome, { done: true, ok: outcome.exitCode === 0 && !outcome.error, at: Date.now() });
        this.notifyDependents();
        return check;
      });
      this.commandChecks.set(key, check);
      this.notifyDependents();
      return check.promise;
    }));
  }

  // Lets every failed command check run again as soon as its block renders. Called when a block
  // finishes running or reverting: that's usually what fixes them, for example starting the cluster.
  expireFailedChecks() {
    for (const check of this.commandChecks.values()) if (check.done && !check.ok) check.at = 0;
  }

  // The processor only gets the block body; the fence line (language, id=, md5=…) has to be read from the note.
  async resolveMeta(sourcePath, source, section, kind) {
    // In Reading view, a section's text can still be empty when its block is first rendered. Taken
    // as the note, it would empty the note's entry in the index, so read the note instead.
    let text = section ? section.text : null;
    if (!text) text = await this.readNote(sourcePath);
    const want = normalize(source);
    const matches = this.metasFor(text, sourcePath).filter(({ meta }) => meta.kind === kind && meta.source === want);
    const inSection = section && matches.find(({ block }) => block.lineStart >= section.lineStart && block.lineEnd <= section.lineEnd);
    const hit = inSection || matches[0];
    return hit ? hit.meta : this.makeMeta(kind, source);
  }

  // Finds a block in the note's text: by its id, or, for a block without one yet, by its content,
  // preferring the copy on the line it was last seen on.
  locate(text, meta) {
    const entries = this.metasFor(text);
    if (meta.id) {
      const hit = entries.find(({ meta: m }) => m.id === meta.id);
      return hit ? hit.block : null;
    }
    const same = entries.filter(({ meta: m }) => !m.id && m.kind === meta.kind && m.source === meta.source);
    const hit = same.find(({ block }) => block.lineStart === meta.lineStart) || same[0];
    return hit ? hit.block : null;
  }

  // Blocks are keyed by their id= so drafts and output stay with the block while its code or fence
  // line changes. Until a block has an id, it falls back to a key derived from its content.
  // Highlights `text` into a <code> element with Obsidian's Prism, or shows it plain until Prism loads.
  highlight(codeEl, text, lang) {
    const grammar = this.prism && this.prism.languages[lang];
    codeEl.empty();
    if (grammar) codeEl.appendChild(sanitizeHTMLToDom(this.prism.highlight(text, grammar, lang)));
    else codeEl.setText(text);
  }

  // A block's key from its raw text alone, before anything else is known: only for blocks with an id.
  keyForSource(sourcePath, source) {
    const header = splitHeader(source).header;
    const id = header && header.id != null ? String(header.id).toLowerCase() : '';
    return UUID_RE.test(id) ? `${sourcePath}::id:${id}` : null;
  }

  keyFor(sourcePath, meta) {
    if (meta.id) return `${sourcePath}::id:${meta.id}`;
    return `${sourcePath}::src:${md5(`${meta.kind}\n${meta.path || ''}\n${meta.lang}\n${meta.source}`)}`;
  }

  // A view where the note is being edited (Live Preview or source mode), if any.
  openView(sourcePath) {
    return this.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view)
      .find((v) => v instanceof MarkdownView && v.file && v.file.path === sourcePath && v.editor
        && v.getMode() === 'source') || null;
  }

  // The note's current text: the open editor's, which may be ahead of the file on disk.
  async readNote(sourcePath) {
    const view = this.openView(sourcePath);
    if (view) return view.editor.getValue();
    const file = this.getFile(sourcePath);
    return file ? this.app.vault.cachedRead(file) : '';
  }

  // Changes a note's text. Goes through the open editor when there is one, so unsaved typing isn't
  // overwritten and the cursor stays put; otherwise edits the file on disk. `transform` returns the
  // new text, or the same text for no change. Resolves to whether anything changed.
  async editNote(sourcePath, transform) {
    // Editing redraws blocks, which can move the note's scroll position; keep it where the reader left
    // it. This uses each view's scroll container in pixels: Obsidian's getScroll()/applyScroll() work
    // in whole lines, and restoring a line inside a tall block scrolls that block to the top.
    const scrollers = this.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view)
      .filter((v) => v instanceof MarkdownView && v.file && v.file.path === sourcePath)
      .map((v) => v.contentEl.querySelector(v.getMode() === 'source' ? '.cm-scroller' : '.markdown-preview-view'))
      .filter(Boolean)
      .map((el) => [el, el.scrollTop]);
    const restore = () => {
      for (const [el, top] of scrollers) if (el.isConnected && el.scrollTop !== top) el.scrollTop = top;
      // Blocks' own output boxes lose their scroll position too, if they were moved in the page.
      for (const widgets of this.widgets.values()) {
        for (const widget of widgets) if (widget.ctx.sourcePath === sourcePath && !widget.unloaded) widget.reapplyOutputScroll();
      }
    };
    const changed = await this.applyEdit(sourcePath, transform);
    if (changed) {
      restore();
      // Blocks re-render on the next frame; correct once more after that.
      window.requestAnimationFrame(restore);
      // Reading view re-renders a changed note a little later; put output boxes back after that too.
      setTimeout(() => {
        for (const widgets of this.widgets.values()) {
          for (const widget of widgets) if (widget.ctx.sourcePath === sourcePath && !widget.unloaded) widget.reapplyOutputScroll();
        }
      }, 300);
    }
    return changed;
  }

  async applyEdit(sourcePath, transform) {
    const view = this.openView(sourcePath);
    if (view) {
      const editor = view.editor;
      const before = editor.getValue();
      const after = transform(before);
      if (after === before) return false;
      // Replace only the span that differs.
      let start = 0;
      while (start < before.length && start < after.length && before[start] === after[start]) start++;
      let endBefore = before.length;
      let endAfter = after.length;
      while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
        endBefore--;
        endAfter--;
      }
      editor.replaceRange(after.slice(start, endAfter), editor.offsetToPos(start), editor.offsetToPos(endBefore));
      this.metasFor(after, sourcePath);
      return true;
    }
    const file = this.getFile(sourcePath);
    if (!file) return false;
    let changed = false;
    await this.app.vault.process(file, (data) => {
      const after = transform(data);
      changed = after !== data;
      // Index the note's blocks as edited straight away, so nothing acts on their old versions.
      if (changed) this.metasFor(after, sourcePath);
      return after;
    });
    return changed;
  }

  // Gives a block a UUID id the first time it runs, writing it into the block's header. Anything
  // the block built up under its content-based key (a draft, output, a result) moves to the new id.
  // Resolves to the block's meta with its id.
  async assignId(sourcePath, meta, extraEdit) {
    if (meta.id && !extraEdit) return meta;
    const id = meta.id || crypto.randomUUID();
    // Editing the block re-renders it. Record its height under the key it will have afterwards,
    // so the new widget starts at that height.
    const finalKey = this.keyFor(sourcePath, Object.assign({}, meta, { id }));
    for (const widget of this.widgets.get(this.keyFor(sourcePath, meta)) || []) {
      const height = widget.containerEl.offsetHeight;
      if (height > 0) this.heights.set(finalKey, height);
    }
    let found = false;
    await this.editNote(sourcePath, (data) => {
      const block = this.locate(data, meta);
      if (!block) return data;
      found = true;
      let body = meta.id ? block.source : setHeaderValue(block.source, ['id'], id, meta.kind);
      if (extraEdit) body = extraEdit(body, block);
      return body === block.source ? data : replaceBody(data, block, body);
    });
    if (!found || meta.id) return meta;
    const updated = Object.assign({}, meta, { id });
    this.rekey(this.keyFor(sourcePath, meta), this.keyFor(sourcePath, updated), updated);
    return updated;
  }

  // Moves a block's state, and its widgets, from one key to another. Running processes stay put:
  // they finish under the key they started with, and ids are assigned before anything runs.
  rekey(from, to, meta) {
    if (from === to) return;
    for (const map of [this.results, this.drafts, this.written]) {
      if (map.has(from)) {
        map.set(to, map.get(from));
        map.delete(from);
      }
    }
    for (const widget of [...(this.widgets.get(from) || [])]) {
      this.detach(widget);
      widget.key = to;
      widget.meta = meta;
      this.attach(widget);
    }
    this.notify(to);
  }

  // Before Run all: gives every block in the note that hasn't got one a UUID id, in one edit.
  async assignAllIds(sourcePath) {
    const before = this.metasFor(await this.readNote(sourcePath)).map(({ meta }) => meta);
    if (before.every((meta) => meta.id)) return;
    const ids = before.map((meta) => meta.id || crypto.randomUUID());
    await this.editNote(sourcePath, (text) => {
      const entries = this.metasFor(text);
      if (entries.length !== ids.length) return text;
      // Bottom-up, so earlier blocks' line numbers stay valid as headers grow.
      return entries.map((entry, i) => ({ ...entry, id: ids[i] })).reverse()
        .reduce((acc, { block, meta, id }) => (meta.id ? acc : replaceBody(acc, block, setHeaderValue(block.source, ['id'], id, meta.kind))), text);
    });
    before.forEach((meta, i) => {
      if (!meta.id) this.rekey(this.keyFor(sourcePath, meta), this.keyFor(sourcePath, Object.assign({}, meta, { id: ids[i] })), Object.assign({}, meta, { id: ids[i] }));
    });
  }

  // A block's code: what's being typed into it, or else what the note says now. `meta` can be out of
  // date: a block re-renders whenever its note is edited (saving an editor, saving a result), and a
  // click or a run can still come from the old one.
  currentCode(key, meta) {
    if (this.drafts.has(key)) return this.drafts.get(key);
    return this.freshMeta(key.slice(0, key.indexOf('::')), meta).code;
  }

  // The latest version of a block, from the note's index, or `meta` itself if it isn't indexed.
  freshMeta(sourcePath, meta) {
    if (!meta.id) return meta;
    return (this.noteIndex.get(sourcePath) || []).find((m) => m.id === meta.id && m.kind === meta.kind) || meta;
  }

  // Called when a block (re-)renders: a draft equal to what the note now says has been saved.
  settleDraft(key, meta) {
    if (this.drafts.get(key) === meta.code) this.drafts.delete(key);
  }

  // Saves an editable block's current code into the note, below "---", keeping the author's original
  // as `original:` in the header, or putting the original back when the code is the same as it.
  // `code` defaults to the block's current code; pass the editor's text when saving from an editor.
  async persistLearner(sourcePath, meta, code = this.currentCode(this.keyFor(sourcePath, meta), meta)) {
    // The block gets its id in the same edit, so the note is only re-rendered once.
    return this.assignId(sourcePath, meta, (body, block) => {
      let updated = withLearner(this.makeMeta(block.info, block.source), body, code);
      const res = this.results.get(this.keyFor(sourcePath, meta));
      if (res && res.done && !res.saved) updated = setHeaderEntry(updated, 'result', savedResult(meta, res));
      return updated;
    });
  }

  // Brings a synced file block up to date with its file. A change we didn't write ourselves (a
  // command, another editor) becomes the learner's content. On load, a missing file is created and
  // nothing is validated, so opening a note never runs commands.
  syncFromDisk(sourcePath, meta, { onLoad = false } = {}) {
    const key = this.keyFor(sourcePath, meta);
    if (this.resetting.has(key)) return;
    let target;
    try {
      ({ target } = this.resolveTarget(this.getFile(sourcePath), meta.path));
    } catch (e) {
      return;
    }
    let disk;
    try {
      if (fs.statSync(target).size > MAX_SYNC_BYTES) return;
      disk = normalize(fs.readFileSync(target, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT' && onLoad && !this.removed.has(key)) this.writeFileBlock(sourcePath, meta, { check: false, record: false });
      return;
    }
    const hash = md5(disk);
    if (hash === this.written.get(key)) return;
    this.written.set(key, hash);
    if (disk === this.currentCode(key, meta)) return;
    if (disk === meta.code) this.drafts.delete(key);
    else this.drafts.set(key, disk);
    this.notify(key);
    if (!onLoad) this.writeFileBlock(sourcePath, meta);
    // Don't re-render a block the learner is typing in; its blur handler saves instead.
    const typing = [...(this.widgets.get(key) || [])].some((w) => w.editor && w.editor === document.activeElement);
    if (!typing) this.persistLearner(sourcePath, meta);
  }

  // Shows a synced file block's pass/fail as soon as its note opens, by checking the file as it is on
  // disk (after syncFromDisk). Skipped once the block has a result this session, and for blocks with
  // a check command when the setting is off: their content checks alone could show a false green.
  validateOnLoad(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    if (!hasChecks(meta) || this.results.has(key) || this.procs.has(key) || this.resetting.has(key) || this.removed.has(key)) return;
    if (meta.check && !this.settings.checkOnOpen) return;
    this.writeFileBlock(sourcePath, meta, { write: false });
  }

  // Watches a file block's file for changes made outside the plugin: a synced block takes them in, and
  // any file block re-renders. Returns a stop function.
  watchFile(sourcePath, meta, synced) {
    let target;
    try {
      ({ target } = this.resolveTarget(this.getFile(sourcePath), meta.path));
    } catch (e) {
      return () => {};
    }
    const name = path.basename(target);
    let timer = null;
    let watcher;
    try {
      // A synced block's file is created on open, so its folder is too. Other blocks only watch a folder
      // that's already there; until then, their own writes re-render them.
      if (synced) fs.mkdirSync(path.dirname(target), { recursive: true });
      // Watch the folder, not the file: editors often replace files, which ends a file watch.
      watcher = fs.watch(path.dirname(target), (event, filename) => {
        if (filename && filename !== name) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (synced) this.syncFromDisk(sourcePath, meta);
          this.notify(this.keyFor(sourcePath, meta));
        }, 150);
      });
    } catch (e) {
      return () => {};
    }
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }

  setDraft(key, meta, value) {
    const code = value === null ? meta.original : normalize(value);
    if (code === meta.code) this.drafts.delete(key);
    else this.drafts.set(key, code);
    this.notify(key);
  }

  attach(widget) {
    if (!this.widgets.has(widget.key)) this.widgets.set(widget.key, new Set());
    this.widgets.get(widget.key).add(widget);
  }

  detach(widget) {
    const set = this.widgets.get(widget.key);
    if (!set) return;
    set.delete(widget);
    if (!set.size) this.widgets.delete(widget.key);
  }

  notify(key) {
    const set = this.widgets.get(key);
    if (set) for (const widget of set) widget.scheduleRender();
    // Blocks that depend on this one may now be unblocked, or blocked again. That only changes when
    // it starts or finishes, not with each chunk of output.
    const res = this.results.get(key);
    if (res && !res.done && res.chunks && res.chunks.length) return;
    if (res && res.done && !res.expiredChecks) {
      res.expiredChecks = true;
      this.expireFailedChecks();
    }
    this.notifyDependents();
  }

  // Re-renders the blocks that have prerequisites, in any note, since they can depend on blocks in
  // other notes. A block whose state hasn't changed skips the re-render.
  notifyDependents() {
    for (const widgets of this.widgets.values()) {
      for (const widget of widgets) {
        const m = widget.meta;
        if (m.requires.length || m.insteadOf.length || this.alternativesFor(m).length) widget.scheduleRender();
      }
    }
    // Choosers show which way is in use, and what's hidden follows it.
    if (this.choosers) for (const chooser of this.choosers) chooser.render();
    if (this.choosers) this.refreshWays();
  }

  // Commands may change files on disk, which changes what file blocks report about them.
  refreshFileWidgets(sourcePath) {
    for (const set of this.widgets.values()) {
      for (const widget of set) {
        if (widget.meta.kind !== 'file' || widget.ctx.sourcePath !== sourcePath) continue;
        if (widget.synced) this.syncFromDisk(sourcePath, widget.meta);
        widget.scheduleRender();
      }
    }
  }

  workingDir(file) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return { base: undefined, cwd: undefined };
    const base = adapter.getBasePath();
    const cwd = this.settings.cwdMode === 'vault' || !file || !file.parent ? base : path.join(base, file.parent.path);
    return { base, cwd };
  }

  // Resolves a file block's path against the working directory. Writing into the vault's config
  // folder (plugins, settings) is always refused; leaving the vault needs a setting.
  resolveTarget(file, relPath) {
    if (!relPath) throw new Error('File block needs a path, e.g. ```file config.yaml');
    const { base, cwd } = this.workingDir(file);
    if (!base) throw new Error('File blocks need a vault stored on disk.');
    const target = path.resolve(cwd, relPath);
    const inside = (dir) => {
      const rel = path.relative(dir, target);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    if (inside(path.join(base, this.app.vault.configDir))) {
      throw new Error(`Refusing to write into ${this.app.vault.configDir}: ${relPath}`);
    }
    if (!inside(base) && !this.settings.allowOutsideVault) {
      throw new Error(`Refusing to write outside the vault: ${relPath} (see plugin settings)`);
    }
    return { target, relPath: inside(base) ? path.relative(base, target) : target };
  }

  diskState(sourcePath, meta) {
    let resolved;
    try {
      resolved = this.resolveTarget(this.getFile(sourcePath), meta.path);
    } catch (e) {
      return { error: e.message };
    }
    const code = this.currentCode(this.keyFor(sourcePath, meta), meta);
    let state = 'missing';
    try {
      state = normalize(fs.readFileSync(resolved.target, 'utf8')) === code ? 'same' : 'differs';
    } catch (e) {
      if (e.code !== 'ENOENT') return { error: e.message };
    }
    return { state, relPath: resolved.relPath };
  }

  // Writes a file block to disk, then runs its check (if any) against the written file.
  // `check: false` skips the check; `record: false` writes without showing a result;
  // `write: false` only validates the file as it already is.
  writeFileBlock(sourcePath, meta, { check: runCheck = true, record = true, write = true } = {}) {
    const key = this.keyFor(sourcePath, meta);
    const existing = this.procs.get(key);
    if (existing) return existing.promise;

    const file = this.getFile(sourcePath);
    const code = this.currentCode(key, meta);
    const hash = md5(code);
    if (record) this.reverts.delete(key);
    const res = {
      done: false, chunks: [], stdout: '', exitCode: 0, startedAt: Date.now(), cmdHash: hash, outputHash: hash, content: code,
    };
    const finish = () => {
      res.done = true;
      res.durationMs = Date.now() - res.startedAt;
      this.notify(key);
      return res;
    };
    let target;
    try {
      ({ target } = this.resolveTarget(file, meta.path));
      if (write) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, code ? `${code}\n` : '');
        this.written.set(key, hash);
        this.removed.delete(key);
      }
    } catch (e) {
      res.error = e.message;
    }
    if (!record) {
      res.done = true;
      this.notify(key);
      return Promise.resolve(res);
    }
    this.results.set(key, res);
    if (res.error || !meta.check || !runCheck) return Promise.resolve(finish());

    this.notify(key);
    const check = { stdout: '', stderr: '' };
    res.check = check;
    const handle = this.spawnScript(meta.check.lang, meta.check.run, file, this.timeoutFor(meta),
      (stream, text) => { check[stream] += text; }, { FILE: target });
    const entry = { kill: (why) => handle.kill && handle.kill(why) };
    this.procs.set(key, entry);
    entry.promise = handle.promise.then((outcome) => {
      Object.assign(check, outcome);
      if (this.procs.get(key) === entry) this.procs.delete(key);
      return finish();
    });
    return entry.promise;
  }

  // File blocks above a run block are written first if they changed since they were last written,
  // so edits are picked up without clobbering changes that earlier commands made to the file.
  async writePendingFiles(sourcePath, meta) {
    const file = this.getFile(sourcePath);
    if (!file) return;
    const key = this.keyFor(sourcePath, meta);
    const metas = this.metasFor(await this.readNote(sourcePath)).map(({ meta }) => meta);
    const self = metas.findIndex((m) => m.kind === 'run' && this.keyFor(sourcePath, m) === key);
    for (const m of metas.slice(0, Math.max(self, 0))) {
      if (m.kind !== 'file' || this.rerunBlocker(sourcePath, m) || this.replacement(sourcePath, m) || this.onUnusedPath(sourcePath, m)) continue;
      const fileKey = this.keyFor(sourcePath, m);
      if (this.written.get(fileKey) !== md5(this.currentCode(fileKey, m))) await this.writeFileBlock(sourcePath, m);
    }
  }

  async runCell(sourcePath, meta) {
    meta = await this.assignId(sourcePath, this.freshMeta(sourcePath, meta));
    // Commands are checked again before every run: what was installed or running earlier may not be now.
    await this.checkPrerequisites(sourcePath, meta, { force: true });
    const deps = this.prerequisiteState(sourcePath, meta);
    if (deps.blocked) {
      new Notice(`Blocked: ${deps.waiting.map((w) => w.summary).join('; ')}.`, 6000);
      return null;
    }
    const once = this.rerunBlocker(sourcePath, meta);
    if (once) {
      new Notice(`Can't run this block again: ${once}.`, 6000);
      return null;
    }
    let res;
    if (meta.kind === 'file') {
      res = await this.writeFileBlock(sourcePath, meta);
    } else {
      await this.writePendingFiles(sourcePath, meta);
      res = await this.runBlock(sourcePath, meta);
    }
    await this.persistResult(sourcePath, meta, res);
    return res;
  }

  timeoutFor(meta) {
    return meta.timeout || this.settings.timeoutSeconds;
  }

  runBlock(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    const existing = this.procs.get(key);
    if (existing) return existing.promise;

    const code = this.currentCode(key, meta);
    this.reverts.delete(key);
    // `code` is what ran: saved with the result, whatever the block shows by the time it finishes.
    const res = { done: false, chunks: [], stdout: '', exitCode: null, startedAt: Date.now(), cmdHash: md5(code), code };
    this.results.set(key, res);
    this.notify(key);

    const append = (stream, text) => {
      if (stream === 'stdout') res.stdout += text;
      const last = res.chunks[res.chunks.length - 1];
      if (last && last.stream === stream) last.text += text;
      else res.chunks.push({ stream, text });
      this.notify(key);
    };
    const handle = this.spawnScript(meta.lang, code, this.getFile(sourcePath), this.timeoutFor(meta), append, meta.env, meta.packages);
    const entry = { kill: (why) => handle.kill && handle.kill(why) };
    this.procs.set(key, entry);
    entry.promise = handle.promise.then((outcome) => {
      Object.assign(res, outcome, {
        done: true,
        durationMs: Date.now() - res.startedAt,
        outputHash: md5(normalize(res.stdout)),
      });
      if (this.procs.get(key) === entry) this.procs.delete(key);
      this.notify(key);
      this.refreshFileWidgets(sourcePath);
      return res;
    });
    return entry.promise;
  }

  // Runs code with the interpreter configured for `lang`, or, given packages, in their environment
  // (see packageSetup). onData(stream, text) receives output as it arrives. Returns { promise, kill },
  // where the promise resolves to { exitCode, error?, timedOut?, stopped? }.
  spawnScript(lang, code, file, timeoutSeconds, onData, extraEnv, packages) {
    const handle = {};
    handle.promise = new Promise((resolve) => {
      let tmp = null;
      let cleanup = [];
      let timer = null;
      let reason = null;
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (tmp) fs.unlink(tmp, () => {});
        for (const p of cleanup) fs.rm(p, { recursive: true, force: true }, () => {});
        resolve(outcome);
      };

      let child;
      try {
        const { base, cwd } = this.workingDir(file);
        let command;
        if (packages && packages.length) {
          const setup = packageSetup(lang, packages, cwd, code);
          // The first run installs the packages, which isn't counted against the block's timeout.
          if (timeoutSeconds > 0 && !fs.existsSync(setup.ready)) timeoutSeconds += INSTALL_SECONDS;
          tmp = path.join(os.tmpdir(), `obsidian-run-${Date.now()}-${Math.random().toString(36).slice(2)}.${setup.ext}`);
          cleanup = setup.cleanup;
          command = setup.command(tmp);
        } else {
          const template = this.interpreters()[lang];
          if (!template) throw new Error(`No interpreter configured for "${lang}". Add one in Settings → Runnable Blocks.`);
          const ext = EXTENSIONS[lang] || lang;
          tmp = path.join(os.tmpdir(), `obsidian-run-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
          command = template.includes('{file}')
            ? template.split('{file}').join(shellQuote(tmp))
            : `${template} ${shellQuote(tmp)}`;
        }
        fs.writeFileSync(tmp, `${code}\n`);
        const env = Object.assign({}, process.env, {
          PATH: [this.settings.extraPath, process.env.PATH].filter(Boolean).join(path.delimiter),
        }, extraEnv);
        if (base) env.OBSIDIAN_VAULT = base;
        if (base && file) env.OBSIDIAN_NOTE = path.join(base, file.path);
        child = spawn(command, { shell: true, cwd, env, detached: process.platform !== 'win32' });
      } catch (e) {
        finish({ exitCode: null, error: e.message });
        return;
      }

      handle.kill = (why) => {
        reason = why;
        killTree(child, 'SIGTERM');
        setTimeout(() => { if (!settled) killTree(child, 'SIGKILL'); }, 2000);
      };

      child.stdin.end();
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => onData('stdout', d));
      child.stderr.on('data', (d) => onData('stderr', d));
      child.on('error', (e) => finish({ exitCode: null, error: e.message }));
      child.on('close', (exitCode) => {
        const outcome = { exitCode };
        if (reason === 'timeout') Object.assign(outcome, { timedOut: true, error: `Timed out after ${timeoutSeconds} s` });
        if (reason === 'stopped') Object.assign(outcome, { stopped: true, error: 'Stopped' });
        finish(outcome);
      });

      if (timeoutSeconds > 0) timer = setTimeout(() => handle.kill('timeout'), timeoutSeconds * 1000);
    });
    return handle;
  }

  stop(key) {
    const entry = this.procs.get(key);
    if (entry && entry.kill) entry.kill('stopped');
  }

  clear(key) {
    this.stop(key);
    this.results.delete(key);
    this.notify(key);
  }

  // A block's result: the one from this session if there is one, otherwise the one saved in the note.
  resultFor(sourcePath, meta) {
    return this.results.get(this.keyFor(sourcePath, meta)) || (meta.saved ? loadResult(meta, meta.saved) : null);
  }

  // Saves a finished result into the block's header, as `result:`. If you're typing in the block,
  // the cursor is put back once the note has re-rendered.
  async persistResult(sourcePath, meta, res) {
    if (!res || !res.done || !meta.id) return;
    const key = this.keyFor(sourcePath, meta);
    const typing = [...(this.widgets.get(key) || [])].find((w) => w.editor && w.editor === document.activeElement);
    if (typing) this.refocus = { key, start: typing.editor.selectionStart, end: typing.editor.selectionEnd };
    // An editable block's code is saved with its result, so the note says what produced it. That's
    // the code that ran, not the block's code now: the block may have re-rendered while it ran (its
    // editor is saved when you click ▶), and `meta` is from before then.
    const code = res.code != null ? res.code : res.content != null ? res.content : this.currentCode(key, meta);
    await this.assignId(sourcePath, meta, (body, block) => {
      const updated = setHeaderEntry(body, 'result', savedResult(meta, res));
      return meta.editable ? withLearner(this.makeMeta(block.info, updated), updated, code) : updated;
    });
  }

  // Blocks that depend on this one and still have a result. Like undo, they have to be reverted first.
  // They can be in any note. Each is described for messages: its label, and its note if it's another.
  // A block on an alternative path also holds up the dependents of the blocks the path stands in for.
  activeDependents(sourcePath, meta) {
    if (!meta.id) return [];
    const ids = [meta.id];
    for (const start of this.pathsThrough(sourcePath, meta)) if (start.path === sourcePath) ids.push(...start.meta.insteadOf);
    const out = [];
    for (const [path, metas] of this.noteIndex) {
      for (const m of metas) {
        if (!m.dependsOn.some((id) => ids.includes(id)) || !this.resultFor(path, m)) continue;
        out.push(path === sourcePath ? blockLabel(m) : `${blockLabel(m)} in ${noteName(path)}`);
      }
    }
    return out;
  }

  // The blocks, in any note, that name this one in their `instead-of`.
  alternativesFor(meta) {
    if (!meta.id) return [];
    const out = [];
    for (const [path, metas] of this.noteIndex) {
      for (const m of metas) if (m.insteadOf && m.insteadOf.includes(meta.id)) out.push({ path, meta: m });
    }
    return out;
  }

  // The other alternatives to any of the blocks this alternative replaces.
  siblingAlternatives(start) {
    const out = [];
    for (const [path, metas] of this.noteIndex) {
      for (const m of metas) {
        if (m.id === start.meta.id || !m.insteadOf || !m.insteadOf.some((id) => start.meta.insteadOf.includes(id))) continue;
        out.push({ path, meta: m });
      }
    }
    return out;
  }

  // A chooser's ways: the usual way (the block it's for), then each alternative to that block.
  // Each is { id, path, meta, usual }; the usual way's id is the chooser's for-id.
  chooserWays(forId, sourcePath) {
    const usual = this.findBlock(forId, sourcePath);
    if (!usual) return [];
    return [{ id: forId, path: usual.path, meta: usual.meta, usual: true },
      ...this.alternativesFor(usual.meta).map((s) => ({ id: s.meta.id, path: s.path, meta: s.meta, usual: false }))];
  }

  // The way that's been started, by its results: the usual way if a block any alternative replaces
  // has one, or an alternative whose path is in use. Null if none has.
  wayInUse(ways) {
    if (!ways.length) return null;
    const usualIds = new Set([ways[0].id]);
    for (const w of ways.slice(1)) for (const id of w.meta.insteadOf) usualIds.add(id);
    for (const id of usualIds) {
      const found = this.findBlock(id, ways[0].path);
      if (found && this.resultFor(found.path, found.meta)) return ways[0];
    }
    return ways.slice(1).find((w) => this.pathInUse(this.alternativePath(w))) || null;
  }

  // The way a chooser shows: the one in use, which can't be changed until it's reset (locked), or
  // else the one picked. Null if neither.
  currentWay(forId, sourcePath) {
    const ways = this.chooserWays(forId, sourcePath);
    const inUse = this.wayInUse(ways);
    if (inUse) return { way: inUse, locked: true };
    const picked = ways.find((w) => w.id === this.choiceFor(forId));
    return picked ? { way: picked, locked: false } : null;
  }

  // Whether an alternative was picked in a chooser, before any way has been started. It then counts
  // as the way in use: Run all takes it, and the other ways' blocks aren't needed.
  isChosen(start) {
    for (const forId of start.meta.insteadOf) {
      if (this.choiceFor(forId) !== start.meta.id) continue;
      if (!this.wayInUse(this.chooserWays(forId, start.path))) return true;
    }
    return false;
  }

  // The way picked in the chooser for forId, from its `chosen:` line, in any note. Null if none.
  choiceFor(forId) {
    for (const choosers of (this.chooserIndex || new Map()).values()) {
      const chooser = choosers.find((c) => c.forId === forId && c.chosen);
      if (chooser) return chooser.chosen;
    }
    return null;
  }

  // Picks a way, by writing it into the chooser's block in the note.
  async chooseWay(forId, wayId, sourcePath) {
    const current = this.currentWay(forId, sourcePath);
    if (current && current.locked) return;
    // Editing the note indexes it as edited, choosers and all.
    await this.editNote(sourcePath, (text) => setChosen(text, forId, wayId));
    this.notifyDependents();
  }

  // Forgets the ways picked in a note's choosers.
  async clearChoices(sourcePath, text) {
    const picked = parseChoosers(text).filter((c) => c.forId && c.chosen);
    if (!picked.length) return;
    await this.editNote(sourcePath, (t) => picked.reduce((acc, c) => setChosen(acc, c.forId, null), t));
    this.notifyDependents();
  }

  // A way's button label: the chooser's label for it, or else its section's heading, without
  // numbering such as "2b." and a leading "Or".
  wayLabel(way, chooser, text) {
    if (chooser.labels[way.id]) return chooser.labels[way.id];
    const lines = text.split('\n');
    const at = lineOfId(lines, way.meta.id);
    const section = at >= 0 && sectionAround(noteHeadings(lines), at, lines.length);
    if (!section) return blockLabel(way.meta);
    const heading = section.heading.text.replace(/^[\w.]+\.\s+/, '').replace(/^or\s+/i, '');
    return heading.charAt(0).toUpperCase() + heading.slice(1);
  }

  // The sections of a note to hide, as [from, to) line ranges: for each chooser in it, the section
  // of each way in this note that isn't the one shown. A section is left alone if it would take the
  // chooser, or the shown way, or another way, with it.
  hiddenSections(sourcePath, text) {
    if (!text.includes('```choose')) return [];
    const lines = text.split('\n');
    const headings = noteHeadings(lines);
    const out = [];
    for (const chooser of parseChoosers(text)) {
      if (!chooser.forId) continue;
      const current = this.currentWay(chooser.forId, sourcePath);
      if (!current) continue;
      const ways = this.chooserWays(chooser.forId, sourcePath)
        .map((w) => ({ w, at: lineOfId(lines, w.meta.id) }))
        .filter(({ at }) => at >= 0);
      for (const { w, at } of ways) {
        if (w.id === current.way.id) continue;
        const s = sectionAround(headings, at, lines.length);
        if (!s) continue;
        const inside = (line) => line >= s.from && line < s.to;
        if (inside(chooser.line) || ways.some((o) => o.w.id !== w.id && inside(o.at))) continue;
        out.push([s.from, s.to]);
      }
    }
    return out;
  }

  // Reading view: hides a rendered section if it's in a way that isn't chosen. Its text can still be
  // empty when it's first rendered, so until it's there, this tries again shortly.
  hideIfNotChosen(el, ctx, tries = 0) {
    const info = ctx.getSectionInfo(el);
    if (!info || !info.text) {
      if (tries < 40) setTimeout(() => this.hideIfNotChosen(el, ctx, tries + 1), 50);
      return;
    }
    if (!info.text.includes('```choose')) return;
    const hidden = this.hiddenSections(ctx.sourcePath, info.text);
    el.toggleClass('run-block-way-hidden', hidden.some(([from, to]) => info.lineStart >= from && info.lineEnd < to));
  }

  // Live Preview: replaces the hidden sections' lines, so they take no space. It's rebuilt when the
  // note changes, when the editor switches between Live Preview and Source mode (which shows
  // everything), and when told to (refreshWays).
  wayHidingExtension() {
    const { StateField, StateEffect, Prec } = CM.state;
    const { EditorView, Decoration } = CM.view;
    if (!StateField || !StateEffect || !Prec || !EditorView || !Decoration) return null;
    this.refreshWaysEffect = StateEffect.define();
    const plugin = this;
    const livePreview = (state) => !editorLivePreviewField || state.field(editorLivePreviewField, false) !== false;
    const build = (state) => {
      const info = editorInfoField && state.field(editorInfoField, false);
      const file = info && info.file;
      if (!file || !livePreview(state)) return Decoration.none;
      const ranges = plugin.hiddenSections(file.path, state.doc.toString());
      if (!ranges.length) return Decoration.none;
      const doc = state.doc;
      return Decoration.set(ranges.map(([from, to]) => Decoration.replace({ block: true })
        .range(doc.line(from + 1).from, doc.line(Math.min(to, doc.lines)).to)), true);
    };
    const field = StateField.define({
      create: build,
      update(decorations, tr) {
        if (tr.docChanged || tr.effects.some((e) => e.is(plugin.refreshWaysEffect))
          || livePreview(tr.startState) !== livePreview(tr.state)) return build(tr.state);
        return decorations;
      },
      provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f))],
    });
    return Prec.highest(field);
  }

  // Re-applies the hidden sections in every open note with a chooser, if they've changed.
  refreshWays() {
    if (!this.app || !this.app.workspace) return;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const text = view.getViewData ? view.getViewData() : view.data || '';
      if (!text.includes('```choose')) continue;
      const hidden = JSON.stringify(this.hiddenSections(view.file.path, text));
      const key = `${leaf.id || ''}:${view.file.path}`;
      if (this.hiddenShown.get(key) === hidden) continue;
      this.hiddenShown.set(key, hidden);
      const cm = view.editor && view.editor.cm;
      if (cm && this.refreshWaysEffect) cm.dispatch({ effects: this.refreshWaysEffect.of(null) });
      if (view.getMode() === 'preview') this.applyHiddenInReadingView(view, JSON.parse(hidden));
    }
  }

  // Reading view: shows and hides the sections already rendered, in place, so the page doesn't
  // scroll. The renderer's sections and their lines aren't part of Obsidian's documented API, so
  // without them this re-renders the whole note instead.
  applyHiddenInReadingView(view, hidden) {
    const renderer = view.previewMode && view.previewMode.renderer;
    if (!renderer || !Array.isArray(renderer.sections) || typeof renderer.queueRender !== 'function') {
      view.previewMode.rerender(true);
      return;
    }
    const scroller = renderer.previewEl;
    const top = scroller ? scroller.scrollTop : null;
    for (const section of renderer.sections) {
      if (!section.el || !section.start || !section.end) continue;
      const on = hidden.some(([from, to]) => section.start.line >= from && section.end.line < to);
      if (section.el.hasClass('run-block-way-hidden') === on) continue;
      section.el.toggleClass('run-block-way-hidden', on);
      section.computed = false; // its height changed: measure it again
    }
    renderer.queueRender();
    if (scroller && top != null) scroller.scrollTop = top;
  }

  // An alternative path: the block that starts it (with instead-of), then the blocks that depend on
  // it, directly or through each other, in any note. Each is { path, meta }. Blocks both ways need,
  // such as installing an operator once there's a cluster, depend on the usual blocks instead, so
  // they aren't part of it.
  alternativePath(start) {
    const steps = [start];
    const ids = new Set([start.meta.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [path, metas] of this.noteIndex) {
        for (const m of metas) {
          if (!m.id || ids.has(m.id) || !m.dependsOn.some((d) => ids.has(d))) continue;
          ids.add(m.id);
          steps.push({ path, meta: m });
          grew = true;
        }
      }
    }
    return steps;
  }

  // A path is in use once any of its blocks has run, or is running. It has succeeded, and stands in
  // for the blocks it replaces, once its blocks in the note it starts in have all succeeded, apart
  // from manual ones. Its blocks in other notes, such as a lesson's step only needed on this path,
  // run later, so they don't count.
  pathInUse(steps) {
    return steps.some(({ path, meta }) => this.resultFor(path, meta));
  }

  pathSucceeded(start) {
    return this.alternativePath(start).filter(({ path }) => path === start.path)
      .every(({ path, meta }) => meta.manual || succeeded(meta, this.resultFor(path, meta)));
  }

  // The starts of the alternative paths this block is on: itself, if it has instead-of, or the
  // alternatives it depends on.
  pathsThrough(sourcePath, meta) {
    if (!meta.id) return [];
    const starts = [];
    for (const [path, metas] of this.noteIndex) {
      for (const m of metas) {
        if (!m.insteadOf || !m.insteadOf.length) continue;
        const start = { path, meta: m };
        if (this.alternativePath(start).some((step) => step.meta.id === meta.id)) starts.push(start);
      }
    }
    return starts;
  }

  // Whether a block is on an alternative path that isn't in use, which Run all leaves alone.
  onUnusedPath(sourcePath, meta) {
    return this.pathsThrough(sourcePath, meta).some((start) => !this.pathInUse(this.alternativePath(start)) && !this.isChosen(start));
  }

  // The alternative this block has been replaced by: the start of a path that's in use, or one
  // picked in a chooser. Null if none.
  replacement(sourcePath, meta) {
    return this.alternativesFor(meta).find((start) => this.pathInUse(this.alternativePath(start)) || this.isChosen(start)) || null;
  }

  // Why a block can't run again, or null if it can: a block that isn't idempotent runs once, until
  // it's reverted or reset.
  rerunBlocker(sourcePath, meta) {
    if (meta.idempotent) return null;
    const res = this.resultFor(sourcePath, meta);
    if (!res || !res.done) return null;
    return "it isn't idempotent and has already run. Reset it to run it again";
  }

  // Why a block's revert can't run now, or null if it can.
  revertBlocker(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    if (!meta.revert) return 'it has no revert command';
    if (this.procs.has(key) || this.revertProcs.has(key)) return "it's running";
    const res = this.resultFor(sourcePath, meta);
    if (!res || !res.done) return "it hasn't run";
    const dependents = this.activeDependents(sourcePath, meta);
    if (dependents.length) return `reset ${dependents.join(' and ')} first, which depend on it`;
    return null;
  }

  // Why a block can't be reset now, or null if it can.
  resetBlocker(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    if (this.procs.has(key) || this.revertProcs.has(key)) return "it's running";
    const res = this.resultFor(sourcePath, meta);
    const edited = meta.editable && this.currentCode(key, meta) !== meta.original;
    const onDisk = meta.kind === 'file' && ['same', 'differs'].includes(this.diskState(sourcePath, meta).state);
    if (!res && !this.reverts.has(key) && !edited && !onDisk) return 'there\'s nothing to reset';
    const dependents = res ? this.activeDependents(sourcePath, meta) : [];
    if (dependents.length) return `reset ${dependents.join(' and ')} first, which depend on it`;
    return null;
  }

  // Runs a block's revert command. If it works, the block's result is removed, on screen and from the
  // note, so the block is back to not having run; if it fails, the result stays. Resolves to whether
  // it worked.
  async revertBlock(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    const blocker = this.revertBlocker(sourcePath, meta);
    if (blocker) {
      new Notice(`Can't reset this block: ${blocker}.`, 6000);
      return false;
    }
    const rev = { done: false, chunks: [], startedAt: Date.now() };
    this.reverts.set(key, rev);
    this.notify(key);
    const file = this.getFile(sourcePath);
    let extraEnv;
    if (meta.kind === 'file') {
      try {
        extraEnv = { FILE: this.resolveTarget(file, meta.path).target };
      } catch (e) { /* the command runs without FILE */ }
    }
    // A revert in the block's own language can use its packages; every revert gets its env.
    const packages = meta.revert.lang === meta.lang ? meta.packages : null;
    const handle = this.spawnScript(meta.revert.lang, meta.revert.run, file, this.timeoutFor(meta), (stream, text) => {
      const last = rev.chunks[rev.chunks.length - 1];
      if (last && last.stream === stream) last.text += text;
      else rev.chunks.push({ stream, text });
      this.notify(key);
    }, Object.assign({}, meta.env, extraEnv), packages);
    this.revertProcs.set(key, { kill: (why) => handle.kill && handle.kill(why) });
    const outcome = await handle.promise;
    this.revertProcs.delete(key);
    Object.assign(rev, outcome, { done: true, durationMs: Date.now() - rev.startedAt });
    rev.ok = !rev.error && rev.exitCode === 0;
    if (rev.ok) await this.clearBlock(sourcePath, meta);
    this.expireFailedChecks();
    this.notify(key);
    return rev.ok;
  }

  // Resets a block. One that has run and has a revert command is reverted: if that works, its result
  // is cleared and the revert's output shows what was undone; if it fails, the result stays, so you
  // can see what went wrong. Any other block's result is just cleared.
  async resetBlock(sourcePath, meta) {
    meta = this.freshMeta(sourcePath, meta);
    const key = this.keyFor(sourcePath, meta);
    const blocker = this.resetBlocker(sourcePath, meta);
    if (blocker) {
      new Notice(`Can't reset this block: ${blocker}.`, 6000);
      return false;
    }
    const res = this.resultFor(sourcePath, meta);
    // Editable blocks go back to the author's original. Clearing the result re-renders the block,
    // which would check a synced file block's file again, so that's held off meanwhile.
    const restore = meta.editable;
    if (restore) this.resetting.add(key);
    try {
      let ok = true;
      if (meta.revert && res && res.done) ok = await this.revertBlock(sourcePath, meta);
      else {
        this.reverts.delete(key);
        await this.clearBlock(sourcePath, meta);
        this.notify(key);
      }
      if (ok && meta.kind === 'file') this.removeWrittenFile(sourcePath, meta);
      if (ok && restore) await this.discardEdits(sourcePath, meta);
      return ok;
    } finally {
      this.resetting.delete(key);
      // It re-rendered when its result was cleared, before its file was deleted.
      this.notify(key);
    }
  }

  // Editable file blocks follow changes to their file on disk, and reset to the author's original.
  isSynced(meta) {
    return meta.kind === 'file' && meta.editable;
  }

  // Part of resetting an editable block: the learner's edits are removed from the note.
  async discardEdits(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    this.drafts.set(key, meta.original);
    this.results.delete(key);
    await this.persistLearner(sourcePath, meta);
  }

  // Part of resetting a file block: deletes its file, as long as it's still the one the block wrote
  // (the block's content, or what was last written). One that has changed since is kept, with a notice.
  // A removed file stays removed, rather than being recreated when the note re-renders, until the
  // block writes it again: when it's edited, written, or a run block below needs it.
  removeWrittenFile(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    let target;
    try {
      ({ target } = this.resolveTarget(this.getFile(sourcePath), meta.path));
    } catch (e) {
      return;
    }
    let disk;
    try {
      disk = md5(normalize(fs.readFileSync(target, 'utf8')));
    } catch (e) {
      return;
    }
    const ours = [this.written.get(key), md5(this.currentCode(key, meta)), md5(meta.original != null ? meta.original : meta.code)];
    if (!ours.includes(disk)) {
      new Notice(`Kept ${meta.path}: it has changed since this block wrote it.`, 8000);
      return;
    }
    try {
      fs.unlinkSync(target);
    } catch (e) {
      new Notice(`Couldn't delete ${meta.path}: ${e.message}`, 8000);
      return;
    }
    this.written.delete(key);
    this.removed.add(key);
  }

  // Resets every block in the note, from the bottom up so blocks are reverted before the ones they
  // depend on. Stops at the first block that can't be reset.
  async resetAll(file) {
    const ids = this.metasFor(await this.readNote(file.path), file.path).map(({ meta }) => meta).reverse();
    const notice = new Notice('Resetting…', 0);
    let reset = 0;
    for (const original of ids) {
      // Re-read the block each time: earlier resets change the note.
      const meta = this.metasFor(await this.readNote(file.path), file.path).map((e) => e.meta)
        .find((m) => (original.id ? m.id === original.id : m.lineStart === original.lineStart)) || original;
      if (this.resetBlocker(file.path, meta) === "there's nothing to reset") continue;
      notice.setMessage(`Resetting ${blockLabel(meta)}…`);
      if (!(await this.resetBlock(file.path, meta))) {
        notice.hide();
        new Notice(`Stopped resetting at ${blockLabel(meta)}, after resetting ${reset} block(s).`, 10000);
        return;
      }
      reset++;
    }
    notice.hide();
    // Every block is reset, so no way is in use: forget the ways picked in the note's choosers too.
    await this.clearChoices(file.path, await this.readNote(file.path));
    new Notice(`Reset ${reset} block(s).`, 6000);
  }

  // Clears a block's output, on screen and in the note.
  async clearBlock(sourcePath, meta) {
    this.clear(this.keyFor(sourcePath, meta));
    if (meta.saved) await this.assignId(sourcePath, meta, (body) => setHeaderEntry(body, 'result', null));
  }

  async clearAll(file) {
    const prefix = `${file.path}::`;
    for (const key of [...this.reverts.keys()]) if (key.startsWith(prefix)) this.reverts.delete(key);
    for (const key of [...this.results.keys()]) if (key.startsWith(prefix)) this.clear(key);
    await this.editNote(file.path, (text) => this.metasFor(text).reverse().reduce(
      (acc, { block, meta }) => (meta.saved ? replaceBody(acc, block, setHeaderEntry(block.source, 'result', null)) : acc), text));
  }

  async runAll(file) {
    await this.assignAllIds(file.path);
    // An alternative path (instead-of) is a choice, made with ▶, so Run all takes the usual one. Once
    // an alternative is in use, Run all follows it instead, and skips the blocks it replaces.
    const blocks = this.metasFor(await this.readNote(file.path), file.path).filter(({ meta }) => !meta.manual);
    if (!blocks.length) {
      new Notice('No run or file blocks in this note.');
      return;
    }
    const counts = { pass: 0, ok: 0, kept: 0, replaced: 0 };
    const notice = new Notice(`Running ${blocks.length} block(s)…`, 0);
    for (const [i, { meta }] of blocks.entries()) {
      notice.setMessage(`Running block ${i + 1} of ${blocks.length}…`);
      if (this.replacement(file.path, meta) || this.onUnusedPath(file.path, meta)) {
        counts.replaced++;
        continue;
      }
      await this.checkPrerequisites(file.path, meta, { force: true });
      const deps = this.prerequisiteState(file.path, meta);
      if (deps.blocked) {
        notice.hide();
        const what = deps.waiting.map((w) => w.summary).join('; ');
        new Notice(`Stopped at block ${i + 1} of ${blocks.length}: it's blocked. ${what}.`, 10000);
        return;
      }
      if (this.rerunBlocker(file.path, meta)) {
        // Already run, and not safe to run again: keep its result, if it was a success.
        const earlier = evaluate(meta, this.resultFor(file.path, meta)).status;
        if (earlier === 'ok' || earlier === 'pass') {
          counts.kept++;
          continue;
        }
        notice.hide();
        new Notice(`Stopped at block ${i + 1} of ${blocks.length}: it isn't idempotent, and it already ran and failed. Reset it to run it again.`, 10000);
        return;
      }
      // Every file block is rewritten here, so a full run always starts from the note's content.
      const res = await (meta.kind === 'file' ? this.writeFileBlock(file.path, meta) : this.runBlock(file.path, meta));
      await this.persistResult(file.path, meta, res);
      const verdict = evaluate(meta, res);
      // Like a notebook, stop at the first problem: later blocks usually depend on earlier ones.
      if (verdict.status === 'fail' || verdict.status === 'error') {
        notice.hide();
        new Notice(`Stopped at block ${i + 1} of ${blocks.length}: ${verdict.label}. ${counts.pass + counts.ok} block(s) before it ran fine.`, 10000);
        return;
      }
      counts[verdict.status]++;
    }
    notice.hide();
    const kept = counts.kept ? `, ${counts.kept} kept from an earlier run (not idempotent)` : '';
    const replaced = counts.replaced ? `, ${counts.replaced} skipped (on the path not taken)` : '';
    new Notice(`Ran ${blocks.length - counts.kept - counts.replaced} block(s): ${counts.pass} passed, ${counts.ok} without checks${kept}${replaced}.`, 8000);
  }

}

class RunnableBlocksSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    new Setting(containerEl)
      .setName('Interpreters')
      .setDesc('One per line: language = command. {file} is replaced with a temp file holding the block\'s code.')
      .addTextArea((t) => {
        t.setValue(settings.interpreters).onChange((v) => { settings.interpreters = v; save(); });
        t.inputEl.rows = 10;
        t.inputEl.addClass('run-block-settings-textarea');
      });

    new Setting(containerEl)
      .setName('Default language')
      .setDesc('Used when a block is written as just ```run.')
      .addText((t) => t.setValue(settings.defaultLang).onChange((v) => { settings.defaultLang = v.trim().toLowerCase() || 'bash'; save(); }));

    new Setting(containerEl)
      .setName('Extra PATH entries')
      .setDesc('Prepended to PATH, separated by ":" (";" on Windows). Obsidian does not see your shell profile\'s PATH.')
      .addText((t) => t.setValue(settings.extraPath).onChange((v) => { settings.extraPath = v.trim(); save(); }));

    new Setting(containerEl)
      .setName('Working directory')
      .addDropdown((d) => d
        .addOption('note', 'Folder of the note')
        .addOption('vault', 'Vault root')
        .setValue(settings.cwdMode)
        .onChange((v) => { settings.cwdMode = v; save(); }));

    new Setting(containerEl)
      .setName('Timeout (seconds)')
      .setDesc('Blocks are killed after this long. 0 disables. Override per block with timeout=N.')
      .addText((t) => t.setValue(String(settings.timeoutSeconds)).onChange((v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) { settings.timeoutSeconds = n; save(); }
      }));

    new Setting(containerEl)
      .setName('Check when a note opens')
      .setDesc('Shows pass/fail straight away by running each editable file block\'s check against the file on disk, and runs each block\'s command prerequisites (requires: - command:). This runs the note\'s check commands without a click. When off, they run when you press play.')
      .addToggle((t) => t.setValue(settings.checkOnOpen).onChange((v) => { settings.checkOnOpen = v; save(); }));

    const skipped = this.plugin.codeExtensionsSkipped || [];
    new Setting(containerEl)
      .setName('Open these files in the code editor')
      .setDesc(`File extensions, separated by commas, that open in Obsidian with syntax highlighting rather than in another app. Turn on "Detect all file extensions" (Files and links) to see them in the file explorer. Reload the plugin after changing this.${skipped.length ? ` Already handled elsewhere, so left alone: ${skipped.join(', ')}.` : ''}`)
      .addTextArea((t) => t.setValue(settings.codeExtensions).onChange((v) => { settings.codeExtensions = v; save(); }));

    new Setting(containerEl)
      .setName('Allow file blocks to write outside the vault')
      .setDesc('Off by default, so a note can\'t overwrite files elsewhere on your computer. The vault\'s config folder is always off-limits.')
      .addToggle((t) => t.setValue(settings.allowOutsideVault).onChange((v) => { settings.allowOutsideVault = v; save(); }));
  }
}

module.exports = RunnableBlocksPlugin;
// For scripts that check and run notes outside Obsidian, such as the write-course skill's. Obsidian
// only uses the class itself.
Object.assign(module.exports, { evaluate, normalize, md5, blockLabel, withLearner, packageSetup, parseChoosers, setChosen });
