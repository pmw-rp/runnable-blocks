// Loads the Runnable Blocks plugin (main.js at the repository root) outside Obsidian, with Obsidian's
// API stubbed and real YAML parsing from js-yaml, so the scripts here read notes exactly as the
// plugin does. Install js-yaml once with: npm install --prefix <this folder>
const fs = require('fs');
const path = require('path');
const Module = require('module');
let yaml;
try {
  yaml = require('js-yaml');
} catch (e) {
  console.error(`js-yaml is missing. Run: npm install --prefix ${__dirname}`);
  process.exit(2);
}
const stub = class {};
const obsidian = {
  Plugin: class { constructor() { this.app = { workspace: {}, vault: { adapter: {} } }; } },
  PluginSettingTab: stub, Setting: stub, Notice: class { setMessage() {} hide() {} }, MarkdownRenderChild: stub,
  FileSystemAdapter: stub, TFile: stub, MarkdownView: stub, TextFileView: stub,
  setIcon() {}, loadPrism() { return Promise.resolve(null); }, sanitizeHTMLToDom() {},
  parseYaml: (t) => yaml.load(t), stringifyYaml: (v) => yaml.dump(v),
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'obsidian' ? obsidian : load.call(this, request, ...rest);
};
global.window = { requestAnimationFrame() {} };

const MAIN = process.env.RUNNABLE_BLOCKS_MAIN || path.resolve(__dirname, '../../../../main.js');
const Plugin = require(MAIN);

// A plugin instance with just the state that parsing and prerequisite checks need.
function newPlugin() {
  const P = new Plugin();
  P.settings = { defaultLang: 'bash', interpreters: {} };
  Object.assign(P, { noteIndex: new Map(), drafts: new Map(), results: new Map(), commandChecks: new Map() });
  return P;
}

// Indexes every note given, so dependencies between notes resolve. Returns the plugin.
function indexNotes(notes) {
  const P = newPlugin();
  for (const note of notes) P.metasFor(fs.readFileSync(note, 'utf8'), path.resolve(note));
  return P;
}

module.exports = { newPlugin, indexNotes };
