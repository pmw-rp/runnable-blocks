'use strict';

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Menu,
  MarkdownRenderer,
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
const HEADER_KEYS = new Set(['id', 'lang', 'path', 'editable', 'manual', 'timeout', 'expect', 'check', 'learner']);

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
  if (expect.output !== null) add('output', normalize(res.stdout) === expect.output);
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
  if (expect.content !== null) add('content', res.content === expect.content);
  if (expect.md5) add('content MD5', res.outputHash === expect.md5);
  if (check && res.check) {
    const out = normalize(res.check.stdout);
    if (res.check.exitCode !== 0) add('check', false, `exited ${res.check.exitCode}`);
    else if (check.expect.output === null && !check.expect.md5) add('check', true);
    else {
      if (check.expect.output !== null) add('check output', out === check.expect.output);
      if (check.expect.md5) add('check MD5', md5(out) === check.expect.md5);
    }
  }
  if (items.some((i) => !i.ok)) return { status: 'fail', label: 'Fail', items };
  if (items.length) return { status: 'pass', label: 'Pass', items };
  return { status: 'ok', label: 'Written', items };
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
      this.resetBtn = this.button(bar, 'rotate-ccw', 'Reset to original', () => (this.synced
        ? this.plugin.resetFile(this.ctx.sourcePath, this.meta)
        : this.plugin.setDraft(this.key, this.meta, null)));
      // Synced file blocks save themselves into the note; run blocks are saved on request.
      if (!this.synced) {
        this.saveBtn = this.button(bar, 'save', 'Save edits to note', () =>
          this.plugin.saveDraft(this.ctx.sourcePath, this.meta));
      }
    }
    this.button(bar, 'hash', 'Hashes', (evt) => this.hashMenu(evt));
    if (!isFile) this.button(bar, 'eraser', 'Clear output', () => this.plugin.clear(this.key));

    for (const warning of this.meta.warnings) el.createDiv({ cls: 'run-block-warning', text: warning });

    const codeEl = el.createDiv({ cls: 'run-block-code' });
    if (this.meta.editable) {
      this.renderEditor(codeEl);
    } else {
      const longestTicks = Math.max(2, ...(this.meta.code.match(/`+/g) || []).map((t) => t.length));
      const fence = '`'.repeat(longestTicks + 1);
      await this.plugin.renderMarkdown(`${fence}${this.meta.lang}\n${this.meta.code}\n${fence}`, codeEl, this.ctx.sourcePath, this);
      if (this.unloaded) return;
    }

    this.outEl = el.createDiv({ cls: 'run-block-output' });
    this.plugin.attach(this);
    if (this.synced) {
      this.register(this.plugin.watchFile(this.ctx.sourcePath, this.meta));
      this.plugin.syncFromDisk(this.ctx.sourcePath, this.meta, { onLoad: true });
      this.plugin.validateOnLoad(this.ctx.sourcePath, this.meta);
    }
    this.render();
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
  renderEditor(parent) {
    const wrap = parent.createDiv({ cls: 'run-block-editor-wrap' });
    const lang = PRISM_LANGS[this.meta.lang] || this.meta.lang;
    const pre = wrap.createEl('pre', { cls: `run-block-highlight language-${lang}`, attr: { 'aria-hidden': 'true' } });
    const code = pre.createEl('code', { cls: `language-${lang}` });
    const ta = wrap.createEl('textarea', { cls: 'run-block-editor', attr: { spellcheck: 'false' } });
    ta.value = this.plugin.currentCode(this.key, this.meta);
    this.editor = ta;

    let prism = null;
    const paint = () => {
      const text = ta.value;
      const grammar = prism && prism.languages[lang];
      code.empty();
      if (grammar) code.appendChild(sanitizeHTMLToDom(prism.highlight(text, grammar, lang)));
      else code.setText(text);
      // A trailing newline needs something after it, or the copy comes out a line short.
      if (text === '' || text.endsWith('\n')) code.appendText(' ');
    };
    this.fitEditor = paint;
    paint();
    loadPrism().then((loaded) => {
      prism = loaded;
      if (!this.unloaded) paint();
    }).catch(() => {});

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
    const res = this.plugin.results.get(this.key);
    const cmdHash = md5(this.plugin.currentCode(this.key, this.meta));
    const copy = (hash) => navigator.clipboard.writeText(hash).then(() => new Notice(`Copied ${hash}`));
    const pin = (keyPath, hash) => this.plugin.pinValue(this.ctx.sourcePath, this.meta, keyPath, hash);
    const menu = new Menu();
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
          const checkHash = md5(normalize(check.stdout));
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
      if (!this.unloaded) this.render();
    });
  }

  render() {
    const res = this.plugin.results.get(this.key);
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
    this.statusEl.className = 'run-block-status';
    this.statusEl.empty();
    this.outEl.empty();
    this.containerEl.removeClass('is-ok', 'is-pass', 'is-fail', 'is-error');

    if (this.meta.kind === 'file') {
      this.renderFile(res);
      return;
    }
    if (!res) {
      this.outEl.hide();
      return;
    }
    this.outEl.show();

    const pre = this.outEl.createEl('pre', { cls: 'run-block-stream' });
    for (const chunk of res.chunks) {
      pre.createSpan({ cls: chunk.stream === 'stderr' ? 'run-stderr' : 'run-stdout', text: chunk.text });
    }
    if (!res.chunks.length) pre.createSpan({ cls: 'run-block-muted', text: running ? '' : '(no output)' });
    if (res.error) this.outEl.createDiv({ cls: 'run-block-error', text: res.error });

    if (running) {
      this.statusEl.addClass('is-running');
      this.statusEl.setText('Running…');
      return;
    }

    const verdict = evaluate(this.meta, res);
    this.statusEl.addClass(`is-${verdict.status}`);
    this.statusEl.setText(verdict.label);
    this.containerEl.addClass(`is-${verdict.status}`);

    const foot = this.outEl.createDiv({ cls: 'run-block-footer' });
    foot.createSpan({ text: `exit ${res.exitCode === null ? '—' : res.exitCode} · ${formatDuration(res.durationMs)}` });
    renderItems(foot, verdict.items);
  }

  renderFile(res) {
    const checking = !!res && !res.done;
    let verdict = null;
    if (checking) {
      this.statusEl.addClass('is-running');
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

  renderMarkdown(markdown, el, sourcePath, component) {
    if (MarkdownRenderer.render) return MarkdownRenderer.render(this.app, markdown, el, sourcePath, component);
    return MarkdownRenderer.renderMarkdown(markdown, el, sourcePath, component);
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
    return Object.assign(base, {
      lang: String(h.lang || this.settings.defaultLang).toLowerCase(),
      expect: { output: text(expect.output), md5: hash(expect.md5), commandMd5: hash(expect['command-md5']) },
      check: null,
    });
  }

  // Every block in a note, in order, with its meta. A block whose id an earlier block already has,
  // usually a pasted copy, counts as having no id, so the two never share state.
  metasFor(text) {
    const seen = new Set();
    return parseBlocks(text).map((block) => {
      const meta = this.makeMeta(block.info, block.source);
      meta.lineStart = block.lineStart;
      if (meta.id && seen.has(meta.id)) {
        meta.id = null;
        meta.warnings.push('Another block above has the same id. This one gets a new id the first time it runs.');
      }
      if (meta.id) seen.add(meta.id);
      return { block, meta };
    });
  }

  // The processor only gets the block body; the fence line (language, id=, md5=…) has to be read from the note.
  async resolveMeta(sourcePath, source, section, kind) {
    let text = section ? section.text : null;
    if (text == null) text = await this.readNote(sourcePath);
    const want = normalize(source);
    const matches = this.metasFor(text).filter(({ meta }) => meta.kind === kind && meta.source === want);
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
    // Editing redraws blocks, which can move the note's scroll position; keep it where the reader left it.
    const views = this.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view)
      .filter((v) => v instanceof MarkdownView && v.file && v.file.path === sourcePath && v.currentMode);
    const scrolls = views.map((v) => [v, v.currentMode.getScroll()]);
    const restore = () => {
      for (const [v, scroll] of scrolls) if (v.currentMode.getScroll() !== scroll) v.currentMode.applyScroll(scroll);
    };
    const changed = await this.applyEdit(sourcePath, transform);
    if (changed) {
      restore();
      // Blocks re-render a moment later, and their new heights can shift things again.
      window.requestAnimationFrame(() => window.requestAnimationFrame(restore));
      setTimeout(restore, 250);
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
      return now.learner === want ? body : setHeaderEntry(body, 'learner', want);
    });
  }

  async resetFile(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    clearTimeout(this.writeTimers.get(key));
    this.drafts.set(key, meta.original);
    this.notify(key);
    const updated = await this.persistLearner(sourcePath, meta);
    this.writeFileBlock(sourcePath, updated);
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
    if (meta.kind === 'file') return this.writeFileBlock(sourcePath, meta);
    await this.writePendingFiles(sourcePath, meta);
    return this.runBlock(sourcePath, meta);
  }

  timeoutFor(meta) {
    return meta.timeout || this.settings.timeoutSeconds;
  }

  runBlock(sourcePath, meta) {
    const key = this.keyFor(sourcePath, meta);
    const existing = this.procs.get(key);
    if (existing) return existing.promise;

    const code = this.currentCode(key, meta);
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

  clearAll(file) {
    const prefix = `${file.path}::`;
    for (const key of [...this.results.keys()]) if (key.startsWith(prefix)) this.clear(key);
  }

  async runAll(file) {
    await this.assignAllIds(file.path);
    const blocks = this.metasFor(await this.readNote(file.path)).filter(({ meta }) => !meta.manual);
    if (!blocks.length) {
      new Notice('No run or file blocks in this note.');
      return;
    }
    const counts = { pass: 0, ok: 0 };
    const notice = new Notice(`Running ${blocks.length} block(s)…`, 0);
    for (const [i, { meta }] of blocks.entries()) {
      notice.setMessage(`Running block ${i + 1} of ${blocks.length}…`);
      // Every file block is rewritten here, so a full run always starts from the note's content.
      const res = await (meta.kind === 'file' ? this.writeFileBlock(file.path, meta) : this.runBlock(file.path, meta));
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
