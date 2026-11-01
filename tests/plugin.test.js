// Tests for main.js, run with macOS's built-in JavaScript (JXA), so no Node is needed.
// Run from the repository root with tests/run.sh, which reports a summary and the exit status.
// Obsidian's API, Node's crypto/fs/path and YAML are replaced with small stand-ins below.
ObjC.import('Foundation');
function read(p) { return ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null)); }
const root = ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath);
const src = read(root + '/main.js');
const note = read(root + '/example.md');

// Minimal YAML subset standing in for Obsidian's parseYaml/stringifyYaml: nested maps, scalars, | blocks.
function scalar(v) {
  v = v.replace(/\s+#.*$/, '').trim();
  if (/^".*"$/.test(v)) return JSON.parse(v);
  if (/^'.*'$/.test(v)) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === '' || v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('{') || v.startsWith('[')) throw new Error('flow style unsupported in stub');
  return v;
}
function parseYaml(text) {
  const lines = text.split('\n');
  let i = 0;
  const indentOf = (l) => l.match(/^ */)[0].length;
  function block(indent) {
    const obj = {};
    let any = false;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim() || l.trim().startsWith('#')) { i++; continue; }
      const ind = indentOf(l);
      if (ind < indent) break;
      if (ind > indent) throw new Error('bad indent: ' + l);
      const m = l.trim().match(/^([^:]+):(.*)$/);
      if (!m) { if (!any && lines.filter((x) => x.trim()).length === 1) return scalar(l); throw new Error('not a mapping: ' + l); }
      any = true;
      const key = m[1].trim();
      const rest = m[2].trim();
      i++;
      if (rest === '|' || rest === '|-') {
        const body = [];
        let bi = null;
        while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > ind)) {
          if (lines[i].trim() && bi === null) bi = indentOf(lines[i]);
          body.push(lines[i].slice(bi || 0));
          i++;
        }
        obj[key] = body.join('\n').replace(/\n*$/, rest === '|-' ? '' : '\n');
      } else if (rest === '' || rest.startsWith('#')) {
        const next = lines.slice(i).find((x) => x.trim() && !x.trim().startsWith('#'));
        obj[key] = next && indentOf(next) > ind ? block(indentOf(next)) : null;
      } else obj[key] = scalar(rest);
    }
    return obj;
  }
  if (!text.trim()) return null;
  return block(0);
}
function stringifyYaml(v, indent) {
  indent = indent || '';
  if (v && typeof v === 'object') {
    return Object.entries(v).map(([k, x]) => (x && typeof x === 'object'
      ? `${indent}${k}:\n${stringifyYaml(x, indent + '  ')}` : `${indent}${k}: ${stringifyYaml(x, indent).replace(/\s+$/, '')}\n`)).join('');
  }
  if (typeof v === 'string' && /^[A-Za-z_][\w./-]*$/.test(v) && !/^(true|false|null)$/.test(v)) return v + '\n';
  if (typeof v === 'string' && v.includes('\n')) return '|-\n' + v.split('\n').map((l) => (l ? indent + '  ' + l : '')).join('\n') + '\n';
  return JSON.stringify(v) + '\n';
}

class Stub {}
class TFile {}
class MarkdownView {}
let uuidCount = 0;
const fakeCrypto = { createHash: () => ({ t: '', update(t) { this.t = t; return this; }, digest() { return 'h:' + this.t; } }),
  randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, '0')}` };
const norm = (p) => {
  const out = [];
  for (const part of p.split('/')) { if (part === '..') out.pop(); else if (part && part !== '.') out.push(part); }
  return '/' + out.join('/');
};
const fakePath = {
  extname: (p) => (p.match(/\.[^./]+$/) || [''])[0],
  join: (...a) => norm(a.join('/')),
  resolve: (...a) => norm(a.reduce((acc, x) => (x.startsWith('/') ? x : acc + '/' + x), '')),
  dirname: (p) => norm(p + '/..'),
  basename: (p) => p.split('/').pop(),
  isAbsolute: (p) => p.startsWith('/'),
  relative: (from, to) => {
    const f = norm(from).split('/').filter(Boolean); const t = norm(to).split('/').filter(Boolean);
    let i = 0; while (i < f.length && f[i] === t[i]) i++;
    return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/');
  },
  delimiter: ':',
};
const files = {};
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const fakeFs = {
  readFileSync: (p) => { if (!(p in files)) throw enoent(); return files[p]; },
  statSync: (p) => { if (!(p in files)) throw enoent(); return { size: files[p].length }; },
  writeFileSync: (p, d) => { files[p] = d; },
  mkdirSync: () => {},
  watch: () => ({ close() {} }),
};
class FileSystemAdapter { getBasePath() { return '/vault'; } }
const req = (m) => (m === 'obsidian' ? { Plugin: Stub, PluginSettingTab: Stub, MarkdownRenderChild: Stub, TFile, MarkdownView, FileSystemAdapter, parseYaml, stringifyYaml, Notice: class {} }
  : m === 'crypto' ? fakeCrypto : m === 'path' ? fakePath : m === 'fs' ? fakeFs : {});
const api = new Function('require', 'module', 'setTimeout', 'clearTimeout', 'window', src + `
return { parseBlocks, splitHeader, setHeaderValue, setHeaderEntry, withContent, replaceBody, normalize, evaluate, hasChecks, Plugin: RunnableBlocksPlugin };`)(req, { exports: {} }, () => 0, () => {}, { requestAnimationFrame: () => 0 });

const out = [];
const eq = (name, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  out.push((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : `\n       got  ${JSON.stringify(a)}\n       want ${JSON.stringify(b)}`));
};

// Header splitting
const sh = api.splitHeader('id: a1\nlang: bash\n---\necho hi\n');
eq('header parsed', sh.header, { id: 'a1', lang: 'bash' });
eq('content below ---', sh.content, 'echo hi');
eq('leading --- allowed', api.splitHeader('---\nlang: python\n---\nprint(1)').content, 'print(1)');
eq('no header without ---', api.splitHeader('echo a').header, null);
eq('content --- after header kept', api.splitHeader('path: a.yaml\n---\na: 1\n---\nb: 2').content, 'a: 1\n---\nb: 2');
eq('yaml file with --- but no known keys is content', api.splitHeader('apiVersion: v1\nkind: Pod\n---\nkind: Service').header, null);
eq('non-mapping before --- is content', api.splitHeader('echo a\n---\necho b').header, null);
eq('unknown keys reported', api.splitHeader('lang: bash\neditble: true\n---\nx').unknown, ['editble']);

// Header editing keeps formatting
eq('insert id into header', api.setHeaderValue('# a comment\nlang: bash\n---\nx', ['id'], 'q1'), 'id: q1\n# a comment\nlang: bash\n---\nx');
eq('insert id into leading-dash header', api.setHeaderValue('---\nlang: bash\n---\nx', ['id'], 'q1'), '---\nid: q1\nlang: bash\n---\nx');
eq('replace id', api.setHeaderValue('id: old\nlang: bash\n---\nx', ['id'], 'new1'), 'id: new1\nlang: bash\n---\nx');
eq('add header when missing', api.setHeaderValue('echo hi', ['id'], 'q1'), 'id: q1\n---\necho hi');
eq('add nested key to new map', api.setHeaderValue('lang: bash\n---\nx', ['expect', 'md5'], 'abc'), 'lang: bash\nexpect:\n  md5: abc\n---\nx');
eq('replace nested key', api.setHeaderValue('expect:\n    output: 3\n    md5: old # was\n---\nx', ['expect', 'md5'], 'abc'), 'expect:\n    output: 3\n    md5: abc\n---\nx');
eq('add nested key keeps sibling indent', api.setHeaderValue('check:\n    run: ls\n---\nx', ['check', 'md5'], 'abc'), 'check:\n    md5: abc\n    run: ls\n---\nx');
eq('nested key next to block scalar', api.setHeaderValue('check:\n  run: |\n    md5: not this\n  lang: py\n---\nx', ['check', 'md5'], 'z'), 'check:\n  md5: z\n  run: |\n    md5: not this\n  lang: py\n---\nx');
eq('shorthand value expands', api.splitHeader(api.setHeaderValue('expect: 3\n---\nx', ['expect', 'md5'], 'abc')).header, { expect: { output: 3, md5: 'abc' } });
eq('numeric-looking value is quoted', api.setHeaderValue('lang: bash\n---\nx', ['id'], '123'), 'id: "123"\nlang: bash\n---\nx');

// Multi-line header entries
eq('indented --- is not a separator', api.splitHeader('learner: |-\n  a: 1\n  ---\n  b: 2\npath: x\n---\norig').header, { learner: 'a: 1\n---\nb: 2', path: 'x' });
eq('set learner entry', api.setHeaderEntry('id: a\npath: x\n---\norig', 'learner', 'l1\nl2'), 'id: a\npath: x\nlearner: |-\n  l1\n  l2\n---\norig');
eq('replace learner entry', api.setHeaderEntry('id: a\nlearner: |-\n  old\n\n  more\npath: x\n---\norig', 'learner', 'new'), 'id: a\npath: x\nlearner: new\n---\norig');
eq('remove learner entry', api.setHeaderEntry('id: a\nlearner: |-\n  old\npath: x\n---\norig', 'learner', null), 'id: a\npath: x\n---\norig');
eq('learner round trip', api.splitHeader(api.setHeaderEntry('path: x\n---\norig', 'learner', 'a: 1\n---\n  b')).header.learner, 'a: 1\n---\n  b');

// Three-level header edits (check.expect.md5)
eq('pin check.expect.md5 into existing check', api.setHeaderValue('path: a\ncheck:\n  run: ls\n---\nx', ['check', 'expect', 'md5'], 'abc', 'file'),
  'path: a\ncheck:\n  expect:\n    md5: abc\n  run: ls\n---\nx');
eq('pin check.expect.md5 into existing expect', api.setHeaderValue('check:\n  run: ls\n  expect:\n      output: 3\n---\nx', ['check', 'expect', 'md5'], 'abc', 'file'),
  'check:\n  run: ls\n  expect:\n      md5: abc\n      output: 3\n---\nx');
eq('replace check.expect.md5', api.setHeaderValue('check:\n  run: ls\n  expect:\n    md5: old\n---\nx', ['check', 'expect', 'md5'], 'new', 'file'),
  'check:\n  run: ls\n  expect:\n    md5: new\n---\nx');
eq('pin when no check map', api.setHeaderValue('path: a\n---\nx', ['check', 'expect', 'md5'], 'abc', 'file'), 'path: a\ncheck:\n  expect:\n    md5: abc\n---\nx');
eq('check.expect shorthand expands to output', api.splitHeader(api.setHeaderValue('check:\n  run: ls\n  expect: 3\n---\nx', ['check', 'expect', 'md5'], 'abc', 'file')).header.check,
  { run: 'ls', expect: { output: 3, md5: 'abc' } });
eq('file expect shorthand expands to content', api.splitHeader(api.setHeaderValue('expect: hi\n---\nx', ['expect', 'md5'], 'abc', 'file')).header.expect, { content: 'hi', md5: 'abc' });
eq('sibling deeper lines not matched', api.setHeaderValue('check:\n  run: |\n    expect: no\n  lang: py\n---\nx', ['check', 'expect', 'md5'], 'z', 'file'),
  'check:\n  expect:\n    md5: z\n  run: |\n    expect: no\n  lang: py\n---\nx');

// Content replacement
eq('withContent keeps header', api.withContent('id: a\nlang: bash\n---\nold', 'new\ncode'), 'id: a\nlang: bash\n---\nnew\ncode');
eq('withContent without header', api.withContent('old', 'new'), 'new');
eq('replaceBody restores callout prefix', api.replaceBody('> ```run\n> old\n> ```', { lineStart: 0, lineEnd: 2, prefix: '> ' }, 'id: a\n\n---\nx'), '> ```run\n> id: a\n>\n> ---\n> x\n> ```');

// Plugin: metas from the demo note
const P = new api.Plugin();
P.settings = { autoIds: true, defaultLang: 'bash' };
P.idJobs = new Map();
const metas = P.metasFor(note).map(({ meta }) => meta);
eq('demo block count', metas.length, 16);
eq('demo kinds', metas.map((m) => m.kind[0]).join(''), 'rrrrrrfffffrrrrr');
eq('no warnings in demo', metas.flatMap((m) => m.warnings), []);
eq('callout block', [metas[15].lang, metas[15].code], ['js', 'console.log([1, 2, 3].map(n => n * n).join(" "))']);
eq('exact output expect', metas[1].expect.output, 'Hello from Obsidian');
eq('command md5 expect', metas[5].expect, { output: null, md5: '8977ecbb8cb82d77fb091c7a7f186163', commandMd5: 'e69b4f45ed0327caa6fab84ce09cc4bb' });
eq('editable + placeholder', [metas[4].editable, metas[4].code], [true, '# your command here']);
eq('file check', metas[6].check, { lang: 'bash', run: `awk '/replicas:/ {print $2}' "$FILE"`, expect: { output: '3', md5: null } });
eq('file content hidden header', metas[6].code.split('\n')[0], 'service:');
eq('file lang from extension', metas[6].lang, 'yaml');
eq('check md5', metas[7].check.expect.md5, '72c3fe04e3ed7af4b331fe00852acfa7');
eq('expect content', metas[8].expect, { content: 'MODE=production', md5: null });
eq('multi-line check', metas[10].check.run, 'import json, os\njson.load(open(os.environ["FILE"]))\nprint("valid JSON")');
eq('timeout', metas[13].timeout, 2);
eq('go example', [metas[14].lang, metas[14].expect.output], ['go', 'Hello from Go: 5050']);
eq('hasChecks', metas.map(api.hasChecks).map(Number).join(''), '0111111111100010');
const sc = P.makeMeta('file', 'path: a.txt\nexpect: hi\ncheck: cat "$FILE"\n---\nhi');
eq('shorthands', [sc.expect.content, sc.check.run], ['hi', 'cat "$FILE"']);
eq('check without run warns', P.makeMeta('file', 'path: a\ncheck:\n  lang: bash\n---\nx').warnings, ['"check" needs a "run" command.']);
eq('unknown key warns', P.makeMeta('run', 'lang: bash\neditble: true\n---\nx').warnings, ['Unknown setting "editble" in this block\'s header.']);

eq('broken header warns', P.makeMeta('run', 'lang: bash\nexpect: { bad\n---\nx').warnings.length, 1);
eq('non-header text before --- does not warn', P.makeMeta('run', 'echo a: b {\n---\nx').warnings, []);

const lm = P.makeMeta('file', 'id: f1\npath: a.yaml\neditable: true\nlearner: |-\n  mine\n---\nauthor');
eq('learner content is current, original kept', [lm.code, lm.original, lm.learner], ['mine', 'author', 'mine']);
eq('learner ignored unless editable', P.makeMeta('file', 'path: a\nlearner: x\n---\ny').code, 'y');

// Evaluation
const R = (meta, res) => api.evaluate(meta, Object.assign({ exitCode: 0, stdout: '' }, res));
eq('exact output pass', R(metas[1], { stdout: 'Hello from Obsidian\n', outputHash: 'x' }).status, 'pass');
eq('exact output fail', R(metas[1], { stdout: 'nope', outputHash: 'x' }).status, 'fail');
eq('md5 fail detail', R(metas[2], { outputHash: 'deadbeef00' }).items, [{ label: 'output MD5', ok: false, detail: 'got deadbeef…' }]);
eq('command check uses ran code', R(metas[5], { outputHash: '8977ecbb8cb82d77fb091c7a7f186163', cmdHash: 'other' }).items.map((i) => i.ok), [true, false]);
eq('no checks, exit 3', R(metas[12], { exitCode: 3 }).label, 'Exit 3');
const F = (meta, res) => api.evaluate(meta, Object.assign({ exitCode: 0, content: meta.code, outputHash: 'h:' + meta.code }, res));
eq('file check expect fail', F(metas[6], { check: { stdout: '1\n', exitCode: 0 } }).items, [{ label: 'check output', ok: false }]);
eq('file check expect pass', F(metas[6], { check: { stdout: '3\n', exitCode: 0 } }).status, 'pass');
eq('file check md5 mismatch', F(metas[7], { check: { stdout: 'x', exitCode: 0 } }).status, 'fail');
eq('file check md5 pass', F(P.makeMeta('file', 'path: a\ncheck:\n  run: x\n  expect:\n    md5: h:3\n---\ny'), { check: { stdout: '3\n', exitCode: 0 } }).status, 'pass');
eq('check.expect shorthand', P.makeMeta('file', 'path: a\ncheck:\n  run: x\n  expect: 3\n---\ny').check.expect, { output: '3', md5: null });
eq('old check.md5 warns with hint', P.makeMeta('file', 'path: a\ncheck:\n  run: x\n  md5: abc\n---\ny').warnings, ['Unknown setting "check.md5" (did you mean "check.expect.md5"?).']);
eq('unknown expect key warns', P.makeMeta('run', 'lang: bash\nexpect:\n  ouput: 3\n---\nx').warnings, ['Unknown setting "expect.ouput".']);
eq('file content pass', F(metas[8], { content: 'MODE=production' }).status, 'pass');
eq('file validator exit', F(metas[10], { check: { stdout: '', exitCode: 1 } }).items, [{ label: 'check', ok: false, detail: 'exited 1' }]);
eq('file no checks', F(P.makeMeta('file', 'path: x\n---\ny'), {}).label, 'Written');

// Ids: only UUIDs count, duplicates lose theirs, and nothing is assigned until a block runs
const U1 = '11111111-1111-4111-8111-111111111111';
eq('uuid id kept', P.makeMeta('run', `id: ${U1}\n---\nls`).id, U1);
eq('short id is no id', P.makeMeta('run', 'id: k3f9qz\nlang: bash\n---\nls').id, null);
eq('short id warns', P.makeMeta('run', 'id: k3f9qz\nlang: bash\n---\nls').warnings.length, 1);
const dupMetas = P.metasFor('```run\nid: ' + U1 + '\n---\na\n```\n```run\nid: ' + U1 + '\n---\nb\n```\n').map(({ meta }) => meta);
eq('pasted duplicate loses its id', [dupMetas[0].id, dupMetas[1].id], [U1, null]);
eq('pasted duplicate warns', dupMetas[1].warnings.some((w) => w.includes('same id')), true);
let disk = '```run\n# your command here\n```\n\n```run\nlang: bash\n---\n# your command here\n```\n> ```file\n> id: dup\n> path: a.yaml\n> ---\n> k: v\n> ```\n```run\nid: ' + U1 + '\n---\nls\n```\n```run\nid: ' + U1 + '\n---\nls -l\n```\n';
P.app = { workspace: { getLeavesOfType: () => [] }, vault: {
  getAbstractFileByPath: () => new TFile(),
  process: (f, fn) => { disk = fn(disk); return Promise.resolve(disk); },
  cachedRead: () => Promise.resolve(disk) } };
Object.assign(P, { results: new Map(), procs: new Map(), drafts: new Map(), widgets: new Map(), written: new Map(), writeTimers: new Map() });
const sync = out.length;
const original = disk;
const second = () => P.metasFor(disk)[1].meta;
const oldKey = P.keyFor('n.md', second());
P.drafts.set(oldKey, 'echo draft');
P.results.set(oldKey, { done: true, stdout: 'earlier output' });
P.resolveMeta('n.md', '# your command here', null, 'run').then(() => {
  eq('rendering a block writes nothing', disk, original);
  return P.assignId('n.md', second());
}).then((updated) => {
  const ms = P.metasFor(disk).map(({ meta }) => meta);
  eq('assignId gives the block a UUID', /^[0-9a-f-]{36}$/.test(updated.id), true);
  eq('assignId writes it into that block only', [ms[0].id, ms[1].id === updated.id, ms[2].id], [null, true, null]);
  eq('assignId keeps the header', ms[1].lang, 'bash');
  const newKey = P.keyFor('n.md', updated);
  eq('draft moves to the new id', [P.drafts.has(oldKey), P.drafts.get(newKey)], [false, 'echo draft']);
  eq('output moves to the new id', P.results.get(newKey).stdout, 'earlier output');
  return P.assignId('n.md', ms[1]).then((again) => eq('a block with an id keeps it', again.id, updated.id));
}).then(() => P.assignAllIds('n.md')).then(() => {
  const ms = P.metasFor(disk).map(({ meta }) => meta);
  eq('Run all: every block has a UUID', ms.every((m) => m.id && /^[0-9a-f-]{36}$/.test(m.id)), true);
  eq('Run all: ids unique', new Set(ms.map((m) => m.id)).size, 5);
  eq('Run all: short id replaced', ms[2].id !== 'dup', true);
  eq('Run all: first of a duplicate pair keeps its id', ms[3].id, U1);
  eq('Run all: header-less block got a header, code intact', ms[0].code, '# your command here');
  eq('Run all: callout block still parses', [ms[2].path, ms[2].code], ['a.yaml', 'k: v']);
  eq('Run all: no warnings left', ms.flatMap((m) => m.warnings), []);
  const before = disk;
  return P.assignAllIds('n.md').then(() => eq('Run all again changes nothing', disk, before));
}).then(() => {
  // Sync: note text with one editable file block, a fake vault on disk at /vault.
  disk = '```file\nid: ' + U1 + '\npath: demo/a.yaml\neditable: true\n---\nreplicas: 1\n```\n';
  P.app.vault.adapter = new FileSystemAdapter();
  P.app.vault.configDir = '.obsidian';
  P.settings.cwdMode = 'vault';
  Object.assign(P, { results: new Map(), procs: new Map(), drafts: new Map(), widgets: new Map(), written: new Map(), writeTimers: new Map() });
  const fm = () => P.metasFor(disk)[0].meta;
  const key = P.keyFor('n.md', fm());
  P.syncFromDisk('n.md', fm(), { onLoad: true });
  eq('missing file created on load', files['/vault/demo/a.yaml'], 'replicas: 1\n');
  eq('no result shown for load write', P.results.has(key), false);
  P.validateOnLoad('n.md', fm());
  eq('no checks: nothing validated on load', P.results.has(key), false);
  // A block with a content check: validated on load without rewriting the file.
  disk = disk.replace('editable: true\n', 'editable: true\nexpect:\n  content: "replicas: 3"\n');
  files['/vault/demo/a.yaml'] = 'replicas: 1\n';
  P.written.set(key, 'stale');
  P.syncFromDisk('n.md', fm(), { onLoad: true });
  P.validateOnLoad('n.md', fm());
  eq('wrong file shows fail on open', P.results.has(key) && api.evaluate(fm(), P.results.get(key)).status, 'fail');
  P.results.delete(key);
  P.settings.checkOnOpen = false;
  const withCheck = P.makeMeta('file', 'id: ' + U1 + '\npath: demo/a.yaml\neditable: true\nexpect: x\ncheck: grep x "$FILE"\n---\ny');
  P.validateOnLoad('n.md', withCheck);
  eq('setting off: blocks with a check command stay unvalidated', P.results.has(key), false);
  disk = disk.replace('expect:\n  content: "replicas: 3"\n', '');
  P.syncFromDisk('n.md', fm());
  eq('own write ignored', P.drafts.has(key), false);
  files['/vault/demo/a.yaml'] = 'replicas: 3\n';
  P.syncFromDisk('n.md', fm());
  eq('external change adopted', P.currentCode(key, fm()), 'replicas: 3');
  return new Promise((r) => r()).then(() => {
    eq('external change saved into note as learner', fm().learner, 'replicas: 3');
    eq('original kept in note', fm().original, 'replicas: 1');
    P.settleDraft(key, fm());
    eq('draft settled after re-render', P.drafts.has(key), false);
    return P.resetFile('n.md', fm());
  }).then(() => new Promise((r) => r())).then(() => {
    eq('reset rewrites file', files['/vault/demo/a.yaml'], 'replicas: 1\n');
    eq('reset removes learner from note', fm().learner, null);
    eq('note body after reset', disk, '```file\nid: ' + U1 + '\npath: demo/a.yaml\neditable: true\n---\nreplicas: 1\n```\n');
  });
}).then(() => {
  console.log(out.slice(sync).join('\n'));
  console.log('async tests finished');
}).catch((e) => console.log('FAIL async threw ' + e + '\n' + e.stack));
out.slice(0, sync).join('\n');
