'use strict';

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Menu,
  MarkdownRenderChild,
  FileSystemAdapter,
  TFile,
  MarkdownView,
  setIcon,
  loadPrism,
  sanitizeHTMLToDom,
  parseYaml,
  stringifyYaml,
} = require('obsidian');
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
  checkOnOpen: true,
};

const EXTENSIONS = {
  bash: 'sh', sh: 'sh', zsh: 'zsh', python: 'py', py: 'py',
  js: 'js', javascript: 'js', node: 'js', ruby: 'rb', ts: 'ts', go: 'go',
};

const FENCE_RE = /^((?:[ \t]*>)*[ \t]*)(`{3,}|~{3,})(.*)$/;

// Prism's names for languages that blocks may call something else.
const PRISM_LANGS = { sh: 'bash', zsh: 'bash', py: 'python', js: 'javascript', node: 'javascript', yml: 'yaml', text: 'none' };

// Syntax highlighting for ```file blocks, picked from the file extension.
const LANG_FOR_EXT = { yml: 'yaml', md: 'markdown', sh: 'bash', py: 'python', rb: 'ruby', txt: 'text' };

const BLOCK_RE = /^(run|file)(\s|$)/;

// Settings a block's YAML header may use. A header only counts as one if it uses at least one of
// these, so a file whose own content has a "---" line isn't mistaken for a header.
const HEADER_KEYS = new Set(['id', 'lang', 'path', 'editable', 'manual', 'timeout', 'depends-on', 'revert', 'expect', 'check', 'learner', 'result']);

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

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "run" or "file", from the fence line.
function blockKind(info) {
  return info.trim().split(/\s+/)[0];
}

// Finds every ```run and ```file fence in a note, including ones nested in callouts or lists.
function parseBlocks(text) {
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
      if (BLOCK_RE.test(open.info)) {
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

// Splits a block body into its YAML header and the code or file content below the first "---" line.
// The header may also open with a "---" line of its own, like note frontmatter.
// `lines` are the body's lines; the header spans lines[start..sep) and the content follows sep.
function splitHeader(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const none = { header: null, unknown: [], error: null, lines, start: 0, sep: -1, content: normalize(source) };
  // Only an unindented "---" counts, so a "---" inside an indented YAML value (e.g. learner: |) doesn't.
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

// Sets a top-level header entry that may span several lines (like learner: |), or removes it when
// `value` is null. The new entry goes at the end of the header; other lines are left as written.
function setHeaderEntry(source, key, value) {
  const parts = splitHeader(source);
  const entry = value == null ? [] : stringifyYaml({ [key]: value }).replace(/\s+$/, '').split('\n');
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

// Replaces a block body's content, keeping its header as written.
function withContent(source, content) {
  const parts = splitHeader(source);
  if (!parts.header) return content;
  return [...parts.lines.slice(0, parts.sep + 1), content].join('\n');
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
function blockLabel(meta) {
  if (meta.kind === 'file') return meta.path || 'file block';
  const first = (meta.code.split('\n').find((line) => line.trim()) || '').trim();
  return `${meta.lang}: ${first.length > 40 ? `${first.slice(0, 39)}…` : first}`;
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
    // Editable file blocks are kept in sync with the file on disk, both ways.
    this.synced = isFile && this.meta.editable;

    const bar = el.createDiv({ cls: 'run-block-bar' });
    if (isFile) {
      // Synced blocks write themselves as the learner types; others are written on request.
      if (!this.synced) this.runBtn = this.button(bar, 'file-output', `Write ${this.meta.path || 'file'}`, () => this.execute());
      bar.createSpan({ cls: 'run-block-lang run-block-path', text: this.meta.path || '(no path)' });
    } else {
      this.runBtn = this.button(bar, 'play', 'Run', () => this.execute());
      this.stopBtn = this.button(bar, 'square', 'Stop', () => this.plugin.stop(this.key));
      bar.createSpan({ cls: 'run-block-lang', text: this.meta.lang });
    }
    if (hasChecks(this.meta)) {
      const label = isFile ? 'Checked each time the file is written' : 'Output is checked when run';
      setIcon(bar.createSpan({ cls: 'run-block-validated', attr: { 'aria-label': label } }), 'shield-check');
    }
    this.statusEl = bar.createSpan({ cls: 'run-block-status' });
    bar.createDiv({ cls: 'run-block-spacer' });
    if (this.meta.editable) {
      this.editedEl = bar.createSpan({ cls: 'run-block-edited', text: 'edited' });
      this.resetBtn = this.button(bar, 'rotate-ccw', 'Restore the original code', () => (this.synced
        ? this.plugin.resetFile(this.ctx.sourcePath, this.meta)
        : this.plugin.setDraft(this.key, this.meta, null)));
      // Synced file blocks save themselves into the note; run blocks are saved on request.
      if (!this.synced) {
        this.saveBtn = this.button(bar, 'save', 'Save edits to note', () =>
          this.plugin.saveDraft(this.ctx.sourcePath, this.meta));
      }
    }
    if (this.meta.revert) this.revertBtn = this.button(bar, 'undo-2', 'Revert', () => this.plugin.revertBlock(this.ctx.sourcePath, this.meta));
    this.button(bar, 'hash', 'Block id and hashes', (evt) => this.hashMenu(evt));
    this.resetBlockBtn = this.button(bar, 'eraser', 'Reset', () => this.plugin.resetBlock(this.ctx.sourcePath, this.meta));

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
    if (this.synced) {
      this.register(this.plugin.watchFile(this.ctx.sourcePath, this.meta));
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

  execute() {
    return this.plugin.runCell(this.ctx.sourcePath, this.meta);
  }

  button(parent, icon, label, onClick) {
    const btn = parent.createEl('button', { cls: 'run-block-btn clickable-icon', attr: { 'aria-label': label } });
    setIcon(btn, icon);
    btn.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      onClick(evt);
    });
    return btn;
  }

  // An editable block is a <textarea> laid over a copy of its text, highlighted with Obsidian's
  // Prism. The textarea's own text is transparent, so you see the highlighted copy, with the
  // textarea's caret and selection on top. The copy sets the height, so the textarea always fits.
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
    const wrap = parent.createDiv({ cls: 'run-block-editor-wrap' });
    const lang = PRISM_LANGS[this.meta.lang] || this.meta.lang;
    const pre = wrap.createEl('pre', { cls: `run-block-highlight language-${lang}`, attr: { 'aria-hidden': 'true' } });
    const code = pre.createEl('code', { cls: `language-${lang}` });
    const ta = wrap.createEl('textarea', { cls: 'run-block-editor', attr: { spellcheck: 'false' } });
    ta.value = this.plugin.currentCode(this.key, this.meta);
    this.editor = ta;
    // Saving a result re-renders the block; if you were typing in it, carry on where you were.
    const refocus = this.plugin.refocus;
    if (refocus && refocus.key === this.key) {
      this.plugin.refocus = null;
      window.requestAnimationFrame(() => {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(refocus.start, refocus.end);
      });
    }

    const paint = () => {
      const text = ta.value;
      this.plugin.highlight(code, text, lang);
      // A trailing newline needs something after it, or the copy comes out a line short.
      if (text === '' || text.endsWith('\n')) code.appendText(' ');
    };
    this.fitEditor = paint;
    paint();
    if (!this.plugin.prism) this.plugin.prismReady.then(() => { if (!this.unloaded) paint(); });

    // Keep Live Preview from treating clicks and keys in the editor as edits to the note itself.
    for (const type of ['mousedown', 'click', 'keydown', 'keyup', 'keypress', 'beforeinput', 'paste', 'cut', 'copy']) {
      ta.addEventListener(type, (evt) => evt.stopPropagation());
    }
    ta.addEventListener('input', () => {
      paint();
      if (this.synced) this.plugin.editFile(this.ctx.sourcePath, this.meta, ta.value);
      else this.plugin.setDraft(this.key, this.meta, ta.value);
    });
    // Saving into the note re-renders the block, so synced blocks only do it once the learner moves on.
    if (this.synced) ta.addEventListener('blur', () => this.plugin.persistLearner(this.ctx.sourcePath, this.meta));
    ta.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && (evt.shiftKey || evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        this.execute();
      } else if (evt.key === 'Tab' && !evt.shiftKey) {
        evt.preventDefault();
        // execCommand keeps the insertion on the undo stack, unlike setRangeText, and fires input.
        if (!document.execCommand('insertText', false, '  ')) {
          ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
          ta.dispatchEvent(new Event('input'));
        }
      }
    });
  }

  hashMenu(evt) {
    const res = this.plugin.resultFor(this.ctx.sourcePath, this.meta);
    const cmdHash = md5(this.plugin.currentCode(this.key, this.meta));
    const copy = (hash) => navigator.clipboard.writeText(hash).then(() => new Notice(`Copied ${hash}`));
    const pin = (keyPath, hash) => this.plugin.pinValue(this.ctx.sourcePath, this.meta, keyPath, hash);
    const menu = new Menu();
    // A block's id is what other blocks list in depends-on.
    if (this.meta.id) {
      menu.addItem((i) => i.setTitle('Copy block id (for depends-on)').setIcon('link')
        .onClick(() => navigator.clipboard.writeText(this.meta.id).then(() => new Notice(`Copied ${this.meta.id}`))));
    } else {
      menu.addItem((i) => i.setTitle('This block gets an id the first time it runs').setIcon('info').setDisabled(true));
    }
    menu.addSeparator();
    if (this.meta.kind === 'file') {
      // A file block's "output" is its content, so its md5 is known without writing anything.
      menu.addItem((i) => i.setTitle(`Copy content MD5 (${cmdHash.slice(0, 8)}…)`).setIcon('copy')
        .onClick(() => copy(cmdHash)));
      menu.addItem((i) => i.setTitle('Pin content MD5 to block (expect.md5)').setIcon('pin')
        .onClick(() => pin(['expect', 'md5'], cmdHash)));
      if (this.meta.check) {
        menu.addSeparator();
        const check = res && res.done && res.check;
        if (check && !check.error) {
          const checkHash = check.stdout != null ? md5(normalize(check.stdout)) : check.outputHash;
          menu.addItem((i) => i.setTitle(`Copy check output MD5 (${checkHash.slice(0, 8)}…)`).setIcon('copy')
            .onClick(() => copy(checkHash)));
          menu.addItem((i) => i.setTitle('Pin check output MD5 to block (check.expect.md5)').setIcon('pin')
            .onClick(() => pin(['check', 'expect', 'md5'], checkHash)));
        } else {
          menu.addItem((i) => i.setTitle('Write the file to get its check output MD5').setIcon('info').setDisabled(true));
        }
      }
      menu.showAtMouseEvent(evt);
      return;
    }
    menu.addItem((i) => i.setTitle(`Copy command MD5 (${cmdHash.slice(0, 8)}…)`).setIcon('copy')
      .onClick(() => copy(cmdHash)));
    menu.addItem((i) => i.setTitle('Pin command MD5 to block (expect.command-md5)').setIcon('pin')
      .onClick(() => pin(['expect', 'command-md5'], cmdHash)));
    menu.addSeparator();
    if (res && res.done && !res.error) {
      menu.addItem((i) => i.setTitle(`Copy output MD5 (${res.outputHash.slice(0, 8)}…)`).setIcon('copy')
        .onClick(() => copy(res.outputHash)));
      menu.addItem((i) => i.setTitle('Pin output MD5 to block (expect.md5)').setIcon('pin')
        .onClick(() => pin(['expect', 'md5'], res.outputHash)));
    } else {
      menu.addItem((i) => i.setTitle('Run the block to get its output MD5').setIcon('info').setDisabled(true));
    }
    menu.showAtMouseEvent(evt);
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
      const edited = this.synced ? code !== this.meta.original : this.plugin.drafts.has(this.key);
      for (const node of [this.editedEl, this.resetBtn, this.saveBtn]) if (node) node.toggleClass('run-block-hidden', !edited);
      // Another view of the same note, or the file on disk, may have changed the content.
      if (document.activeElement !== this.editor && normalize(this.editor.value) !== code) {
        this.editor.value = code;
        this.fitEditor();
      }
    }
    // Rebuilding the output resets its scroll position and flickers, so only do it when something
    // it shows has changed.
    const deps = this.plugin.dependencyState(this.ctx.sourcePath, this.meta);
    const signature = JSON.stringify([
      res && [res.done, res.startedAt, res.chunks && res.chunks.reduce((n, c) => n + c.text.length, 0), res.error, res.exitCode, res.saved, res.check && [res.check.exitCode, res.check.error]],
      deps.waiting, this.meta.id, this.meta.expect, this.meta.check,
      rev && [rev.done, rev.ok, rev.chunks.reduce((n, c) => n + c.text.length, 0)],
      this.plugin.revertBlocker(this.ctx.sourcePath, this.meta),
      this.meta.kind === 'file' ? this.plugin.diskState(this.ctx.sourcePath, this.meta) : null,
    ]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.saveOutputScroll();
    this.statusEl.className = 'run-block-status';
    this.statusEl.empty();
    this.outEl.empty();
    this.containerEl.removeClass('is-ok', 'is-pass', 'is-fail', 'is-error', 'is-blocked');
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

  // The Revert and Reset buttons say what they'll do, and Revert is only enabled when it can run.
  renderUndoButtons(res) {
    if (this.revertBtn) {
      const blocker = this.plugin.revertBlocker(this.ctx.sourcePath, this.meta);
      this.revertBtn.disabled = !!blocker;
      this.revertBtn.setAttr('aria-label', blocker ? `Revert: unavailable, because ${blocker}` : 'Revert: undo what this block did');
    }
    if (this.resetBlockBtn) {
      this.resetBlockBtn.setAttr('aria-label', this.meta.revert && res
        ? 'Reset: revert this block, then clear its output'
        : 'Reset: clear this block\'s output');
    }
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

  // A block whose dependencies aren't complete can't run: its run button is disabled, and it says
  // what it's waiting for. Until it has run, it's also labelled Blocked.
  renderDependencies(res) {
    const { blocked, waiting } = this.plugin.dependencyState(this.ctx.sourcePath, this.meta);
    if (this.runBtn) {
      this.runBtn.disabled = blocked;
      this.runBtn.setAttr('aria-label', blocked ? 'Blocked: run the blocks it depends on first' : (this.meta.kind === 'file' ? `Write ${this.meta.path || 'file'}` : 'Run'));
    }
    this.waitEl.empty();
    this.waitEl.toggle(blocked);
    if (!blocked) return;
    setIcon(this.waitEl.createSpan({ cls: 'run-block-waiting-icon' }), 'lock');
    this.waitEl.createSpan({ text: 'Waiting for ' });
    waiting.forEach((w, i) => {
      if (i) this.waitEl.createSpan({ text: ' and ' });
      this.waitEl.createEl('code', { text: w.label });
      const where = w.line ? `line ${w.line}${w.below ? ', which is below this block' : ''}, ` : '';
      this.waitEl.createSpan({ cls: 'run-block-waiting-reason', text: ` (${where}${w.reason})` });
    });
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
        missing: ['', 'not on disk yet'],
        same: ['is-pass', 'on disk, matches this block'],
        differs: ['', 'on disk, differs from this block'],
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

class RunnableBlocksPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.results = new Map(); // key -> result; survives re-renders so output stays put while editing
    this.procs = new Map(); // key -> running process entry
    this.drafts = new Map(); // key -> edited code of an editable block, until saved or reset
    this.widgets = new Map(); // key -> Set<RunBlock>
    this.written = new Map(); // key -> md5 of what a file block last wrote to disk
    this.writeTimers = new Map(); // key -> pending write of a synced file block after typing
    this.noteIndex = new Map(); // note path -> metas of its blocks, for resolving depends-on
    this.heights = new Map(); // key -> last rendered height, so a re-render can start at it
    this.outputScroll = new Map(); // key -> { top, atBottom } of the block's output box
    this.reverts = new Map(); // key -> the block's last revert: its output and how it went
    this.revertProcs = new Map(); // key -> a revert that's running
    // Prism highlights code synchronously once loaded, so blocks never render without their code.
    this.prism = null;
    this.prismReady = loadPrism().then((prism) => { this.prism = prism; }).catch(() => {});

    for (const kind of ['run', 'file']) {
      this.registerMarkdownCodeBlockProcessor(kind, (source, el, ctx) => {
        ctx.addChild(new RunBlock(this, el, source, ctx, ctx.getSectionInfo(el), kind));
      });
    }

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
  }

  onunload() {
    for (const entry of this.procs.values()) entry.kill('stopped');
    for (const entry of this.revertProcs.values()) entry.kill('stopped');
    for (const timer of this.writeTimers.values()) clearTimeout(timer);
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
    if (parts.error) warnings.push(parts.error);
    if (h.id != null && !UUID_RE.test(String(h.id))) {
      warnings.push(`This block's id, "${h.id}", isn't a UUID. It gets a new one the first time it runs.`);
    }
    // depends-on: the ids of blocks that must have run successfully before this one can run
    const dependsOn = (h['depends-on'] == null ? [] : [].concat(h['depends-on']))
      .map((d) => String(d).trim().toLowerCase()).filter(Boolean);
    for (const d of dependsOn) {
      if (!UUID_RE.test(d)) warnings.push(`depends-on: "${d}" isn't a block id. Use the id (a UUID) of a block above.`);
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
      dependsOn,
      saved: h.result && typeof h.result === 'object' ? h.result : null,
      revert: null,
      timeout: Number(h.timeout) || null,
      source: normalize(source),
      code: parts.content,
      cmdHash: md5(parts.content),
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
      // An editable file block's learner content lives in the header; the content below "---" stays
      // the author's original.
      const learner = base.editable && h.learner != null ? normalize(String(h.learner)) : null;
      const code = learner !== null ? learner : parts.content;
      return Object.assign(base, {
        original: parts.content,
        learner,
        code,
        cmdHash: md5(code),
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
      lang: String(h.lang || this.settings.defaultLang).toLowerCase(),
      expect: { output: text(expect.output), md5: hash(expect.md5), commandMd5: hash(expect['command-md5']) },
      check: null,
    });
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
    if (sourcePath) this.noteIndex.set(sourcePath, entries.map(({ meta }) => meta));
    return entries;
  }

  // Which of a block's dependencies aren't complete. A dependency is complete once it has run
  // successfully this session: it passed its checks, or ran cleanly if it has none.
  dependencyState(sourcePath, meta) {
    const blocks = this.noteIndex.get(sourcePath) || [];
    const waiting = [];
    for (const id of meta.dependsOn || []) {
      const dep = blocks.find((m) => m.id === id);
      if (!dep) {
        waiting.push({ id, label: `${id.slice(0, 8)}…`, reason: 'not found in this note' });
        continue;
      }
      const res = this.resultFor(sourcePath, dep);
      let reason = null;
      if (!res) reason = 'not run yet';
      else if (!res.done) reason = 'running';
      else {
        const verdict = evaluate(dep, res);
        if (verdict.status === 'fail') reason = 'failed its checks';
        else if (verdict.status !== 'pass' && verdict.status !== 'ok') reason = verdict.label.toLowerCase();
      }
      if (reason) {
        waiting.push({
          id, label: blockLabel(dep), line: dep.lineStart + 1, reason,
          below: meta.lineStart != null && dep.lineStart > meta.lineStart,
        });
      }
    }
    return { blocked: waiting.length > 0, waiting };
  }

  // The processor only gets the block body; the fence line (language, id=, md5=…) has to be read from the note.
  async resolveMeta(sourcePath, source, section, kind) {
    let text = section ? section.text : null;
    if (text == null) text = await this.readNote(sourcePath);
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
      return true;
    }
    const file = this.getFile(sourcePath);
    if (!file) return false;
    let changed = false;
    await this.app.vault.process(file, (data) => {
      const after = transform(data);
      changed = after !== data;
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

  currentCode(key, meta) {
    return this.drafts.has(key) ? this.drafts.get(key) : meta.code;
  }

  // Called when a block (re-)renders: a draft equal to what the note now says has been saved.
  settleDraft(key, meta) {
    if (this.drafts.get(key) === meta.code) this.drafts.delete(key);
  }

  // Learner typing in a synced file block: keep it in memory, write the file (and validate it)
  // shortly after typing stops, and save it into the note when the editor loses focus.
  editFile(sourcePath, meta, value) {
    const key = this.keyFor(sourcePath, meta);
    const code = normalize(value);
    if (code === meta.code) this.drafts.delete(key);
    else this.drafts.set(key, code);
    this.notify(key);
    clearTimeout(this.writeTimers.get(key));
    this.writeTimers.set(key, setTimeout(() => {
      this.writeTimers.delete(key);
      const running = this.procs.get(key);
      // A check still running for an earlier version: write again once it's done.
      if (running) running.promise.then(() => this.writeFileBlock(sourcePath, meta));
      else this.writeFileBlock(sourcePath, meta);
    }, 500));
  }

  // Saves a synced file block's current content into the note's `learner:` header entry, or removes
  // the entry when the content is back to the original.
  async persistLearner(sourcePath, meta) {
    const code = this.currentCode(this.keyFor(sourcePath, meta), meta);
    // The block gets its id in the same edit, so the note is only re-rendered once.
    return this.assignId(sourcePath, meta, (body, block) => {
      // Compare with what the note says now, not `meta`: an earlier save (e.g. on blur) may have
      // changed it since this block rendered.
      const now = this.makeMeta(block.info, block.source);
      const want = code === now.original ? null : code;
      let updated = now.learner === want ? body : setHeaderEntry(body, 'learner', want);
      const res = this.results.get(this.keyFor(sourcePath, meta));
      if (res && res.done && !res.saved) updated = setHeaderEntry(updated, 'result', savedResult(meta, res));
      return updated;
    });
  }

  async resetFile(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    clearTimeout(this.writeTimers.get(key));
    this.drafts.set(key, meta.original);
    // The current result describes content that's about to be replaced, so it shouldn't be saved.
    this.results.delete(key);
    this.notify(key);
    const updated = await this.persistLearner(sourcePath, meta);
    const res = await this.writeFileBlock(sourcePath, updated);
    await this.persistResult(sourcePath, updated, res);
  }

  // Brings a synced file block up to date with its file. A change we didn't write ourselves (a
  // command, another editor) becomes the learner's content. On load, a missing file is created and
  // nothing is validated, so opening a note never runs commands.
  syncFromDisk(sourcePath, meta, { onLoad = false } = {}) {
    const key = this.keyFor(sourcePath, meta);
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
      if (e.code === 'ENOENT' && onLoad) this.writeFileBlock(sourcePath, meta, { check: false, record: false });
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
    if (!hasChecks(meta) || this.results.has(key) || this.procs.has(key)) return;
    if (meta.check && !this.settings.checkOnOpen) return;
    this.writeFileBlock(sourcePath, meta, { write: false });
  }

  // Watches a synced file block's file for changes made outside the plugin. Returns a stop function.
  watchFile(sourcePath, meta) {
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
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Watch the folder, not the file: editors often replace files, which ends a file watch.
      watcher = fs.watch(path.dirname(target), (event, filename) => {
        if (filename && filename !== name) return;
        clearTimeout(timer);
        timer = setTimeout(() => this.syncFromDisk(sourcePath, meta), 150);
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
    const code = value === null ? meta.code : normalize(value);
    if (code === meta.code) this.drafts.delete(key);
    else this.drafts.set(key, code);
    this.notify(key);
  }

  async saveDraft(sourcePath, meta) {
    if (!this.drafts.has(this.keyFor(sourcePath, meta))) return;
    meta = await this.assignId(sourcePath, meta);
    const key = this.keyFor(sourcePath, meta);
    if (!this.drafts.has(key)) return;
    const code = this.drafts.get(key);
    let found = false;
    await this.editNote(sourcePath, (data) => {
      const block = this.locate(data, meta);
      if (!block) return data;
      found = true;
      return replaceBody(data, block, withContent(block.source, code));
    });
    // The draft is dropped once the block re-renders with the saved code (settleDraft), so the
    // editor doesn't briefly fall back to the old code in between.
    new Notice(found ? 'Saved edits to note.' : 'Could not find this block in the note.');
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
    const sourcePath = key.slice(0, key.indexOf('::'));
    for (const widgets of this.widgets.values()) {
      for (const widget of widgets) {
        if (widget.meta.dependsOn.length && widget.ctx.sourcePath === sourcePath) widget.scheduleRender();
      }
    }
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
      if (m.kind !== 'file') continue;
      const fileKey = this.keyFor(sourcePath, m);
      if (this.written.get(fileKey) !== md5(this.currentCode(fileKey, m))) await this.writeFileBlock(sourcePath, m);
    }
  }

  async runCell(sourcePath, meta) {
    meta = await this.assignId(sourcePath, meta);
    const deps = this.dependencyState(sourcePath, meta);
    if (deps.blocked) {
      new Notice(`Blocked: run ${deps.waiting.map((w) => (w.line ? `line ${w.line} (${w.label})` : w.label)).join(' and ')} first.`, 6000);
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
    const res = { done: false, chunks: [], stdout: '', exitCode: null, startedAt: Date.now(), cmdHash: md5(code) };
    this.results.set(key, res);
    this.notify(key);

    const append = (stream, text) => {
      if (stream === 'stdout') res.stdout += text;
      const last = res.chunks[res.chunks.length - 1];
      if (last && last.stream === stream) last.text += text;
      else res.chunks.push({ stream, text });
      this.notify(key);
    };
    const handle = this.spawnScript(meta.lang, code, this.getFile(sourcePath), this.timeoutFor(meta), append);
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

  // Runs code with the interpreter configured for `lang`; onData(stream, text) receives output as it
  // arrives. Returns { promise, kill }, where the promise resolves to { exitCode, error?, timedOut?, stopped? }.
  spawnScript(lang, code, file, timeoutSeconds, onData, extraEnv) {
    const handle = {};
    handle.promise = new Promise((resolve) => {
      let tmp = null;
      let timer = null;
      let reason = null;
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (tmp) fs.unlink(tmp, () => {});
        resolve(outcome);
      };

      let child;
      try {
        const template = this.interpreters()[lang];
        if (!template) throw new Error(`No interpreter configured for "${lang}". Add one in Settings → Runnable Blocks.`);
        const ext = EXTENSIONS[lang] || lang;
        tmp = path.join(os.tmpdir(), `obsidian-run-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        fs.writeFileSync(tmp, `${code}\n`);
        const command = template.includes('{file}')
          ? template.split('{file}').join(shellQuote(tmp))
          : `${template} ${shellQuote(tmp)}`;
        const { base, cwd } = this.workingDir(file);
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
    await this.assignId(sourcePath, meta, (body) => setHeaderEntry(body, 'result', savedResult(meta, res)));
  }

  // Blocks that depend on this one and still have a result. Like undo, they have to be reverted first.
  activeDependents(sourcePath, meta) {
    if (!meta.id) return [];
    return (this.noteIndex.get(sourcePath) || [])
      .filter((m) => m.dependsOn.includes(meta.id) && this.resultFor(sourcePath, m));
  }

  // Why a block's revert can't run now, or null if it can.
  revertBlocker(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    if (!meta.revert) return 'it has no revert command';
    if (this.procs.has(key) || this.revertProcs.has(key)) return "it's running";
    const res = this.resultFor(sourcePath, meta);
    if (!res || !res.done) return "it hasn't run";
    const dependents = this.activeDependents(sourcePath, meta);
    if (dependents.length) return `revert or reset ${dependents.map(blockLabel).join(' and ')} first, which depend on it`;
    return null;
  }

  // Runs a block's revert command. If it works, the block's result is removed, on screen and from the
  // note, so the block is back to not having run; if it fails, the result stays. Resolves to whether
  // it worked.
  async revertBlock(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    const blocker = this.revertBlocker(sourcePath, meta);
    if (blocker) {
      new Notice(`Can't revert this block: ${blocker}.`, 6000);
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
    const handle = this.spawnScript(meta.revert.lang, meta.revert.run, file, this.timeoutFor(meta), (stream, text) => {
      const last = rev.chunks[rev.chunks.length - 1];
      if (last && last.stream === stream) last.text += text;
      else rev.chunks.push({ stream, text });
      this.notify(key);
    }, extraEnv);
    this.revertProcs.set(key, { kill: (why) => handle.kill && handle.kill(why) });
    const outcome = await handle.promise;
    this.revertProcs.delete(key);
    Object.assign(rev, outcome, { done: true, durationMs: Date.now() - rev.startedAt });
    rev.ok = !rev.error && rev.exitCode === 0;
    if (rev.ok) await this.clearBlock(sourcePath, meta);
    this.notify(key);
    return rev.ok;
  }

  // Reverts a block that has run and has a revert command, then clears all of its output. If the
  // revert fails, nothing is cleared, so you can see what went wrong.
  async resetBlock(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    const res = this.resultFor(sourcePath, meta);
    if (meta.revert && res && res.done) {
      if (!(await this.revertBlock(sourcePath, meta))) return false;
    } else if (res) {
      const dependents = this.activeDependents(sourcePath, meta);
      if (dependents.length) {
        new Notice(`Reset ${dependents.map(blockLabel).join(' and ')} first, which depend on this block.`, 6000);
        return false;
      }
    }
    this.reverts.delete(key);
    await this.clearBlock(sourcePath, meta);
    this.notify(key);
    return true;
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
      if (!this.resultFor(file.path, meta) && !this.reverts.has(this.keyFor(file.path, meta))) continue;
      notice.setMessage(`Resetting ${blockLabel(meta)}…`);
      if (!(await this.resetBlock(file.path, meta))) {
        notice.hide();
        new Notice(`Stopped resetting at ${blockLabel(meta)}, after resetting ${reset} block(s).`, 10000);
        return;
      }
      reset++;
    }
    notice.hide();
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
    const blocks = this.metasFor(await this.readNote(file.path), file.path).filter(({ meta }) => !meta.manual);
    if (!blocks.length) {
      new Notice('No run or file blocks in this note.');
      return;
    }
    const counts = { pass: 0, ok: 0 };
    const notice = new Notice(`Running ${blocks.length} block(s)…`, 0);
    for (const [i, { meta }] of blocks.entries()) {
      notice.setMessage(`Running block ${i + 1} of ${blocks.length}…`);
      const deps = this.dependencyState(file.path, meta);
      if (deps.blocked) {
        notice.hide();
        const what = deps.waiting.map((w) => `${w.label} (${w.reason})`).join(', ');
        new Notice(`Stopped at block ${i + 1} of ${blocks.length}: it's blocked, waiting for ${what}.`, 10000);
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
    new Notice(`Ran ${blocks.length} block(s): ${counts.pass} passed, ${counts.ok} without checks.`, 8000);
  }

  async pinValue(sourcePath, meta, keyPath, value) {
    meta = await this.assignId(sourcePath, meta);
    let found = false;
    await this.editNote(sourcePath, (data) => {
      const block = this.locate(data, meta);
      if (!block) return data;
      found = true;
      return replaceBody(data, block, setHeaderValue(block.source, keyPath, value, meta.kind));
    });
    new Notice(found ? `Pinned ${keyPath.join('.')}: ${value}` : 'Could not find this block in the note.');
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
      .setName('Check editable file blocks when a note opens')
      .setDesc('Shows pass/fail straight away by running each block\'s check against the file on disk. This runs the note\'s check commands without a click.')
      .addToggle((t) => t.setValue(settings.checkOnOpen).onChange((v) => { settings.checkOnOpen = v; save(); }));

    new Setting(containerEl)
      .setName('Allow file blocks to write outside the vault')
      .setDesc('Off by default, so a note can\'t overwrite files elsewhere on your computer. The vault\'s config folder is always off-limits.')
      .addToggle((t) => t.setValue(settings.allowOutsideVault).onChange((v) => { settings.allowOutsideVault = v; save(); }));
  }
}

module.exports = RunnableBlocksPlugin;
