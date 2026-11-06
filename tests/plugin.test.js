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
      const lit = rest.match(/^\|(\d)?(-)?$/);
      if (lit) {
        const body = [];
        let bi = lit[1] ? ind + Number(lit[1]) : null;
        while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > ind)) {
          if (lines[i].trim() && bi === null) bi = indentOf(lines[i]);
          body.push(lines[i].slice(bi || 0));
          i++;
        }
        obj[key] = body.join('\n').replace(/\n*$/, lit[2] ? '' : '\n');
      } else if (rest === '' || rest.startsWith('#')) {
        const next = lines.slice(i).find((x) => x.trim() && !x.trim().startsWith('#'));
        if (next && next.trim().startsWith('- ') && indentOf(next) >= ind) {
          // A list of scalars, such as depends-on, or of maps, such as requires
          const items = [];
          const at = indentOf(next);
          while (i < lines.length && (!lines[i].trim() || (lines[i].trim().startsWith('- ') && indentOf(lines[i]) === at))) {
            if (!lines[i].trim()) { i++; continue; }
            const first = lines[i].trim().slice(2);
            i++;
            if (!/^[\w-]+:(\s|$)/.test(first)) { items.push(scalar(first)); continue; }
            const sub = [first];
            while (i < lines.length && lines[i].trim() && indentOf(lines[i]) > at) sub.push(lines[i++].slice(at + 2));
            items.push(parseYaml(sub.join('\n')));
          }
          obj[key] = items;
        } else {
          obj[key] = next && indentOf(next) > ind ? block(indentOf(next)) : null;
        }
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
  unlinkSync: (p) => { if (!(p in files)) throw enoent(); delete files[p]; },
  mkdirSync: () => {},
  watch: () => ({ close() {} }),
};
class FileSystemAdapter { getBasePath() { return '/vault'; } }
const req = (m) => (m === 'obsidian' ? { Plugin: Stub, PluginSettingTab: Stub, MarkdownRenderChild: Stub, TextFileView: Stub, TFile, MarkdownView, FileSystemAdapter, parseYaml, stringifyYaml, Notice: class { setMessage() {} hide() {} } }
  : m === 'crypto' ? fakeCrypto : m === 'path' ? fakePath : m === 'fs' ? fakeFs : {});
const api = new Function('require', 'module', 'setTimeout', 'clearTimeout', 'window', src + `
return { parseBlocks, splitHeader, setHeaderValue, setHeaderEntry, withLearner, savedResult, loadResult, replaceBody, normalize, evaluate, hasChecks, codeExtensions, CODE_LANGS, DEFAULT_SETTINGS, Plugin: RunnableBlocksPlugin };`)(req, { exports: {} }, () => 0, () => {}, { requestAnimationFrame: () => 0 });

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
eq('replaceBody restores callout prefix', api.replaceBody('> ```run\n> old\n> ```', { lineStart: 0, lineEnd: 2, prefix: '> ' }, 'id: a\n\n---\nx'), '> ```run\n> id: a\n>\n> ---\n> x\n> ```');

// The code file view's extensions
eq('code extensions from the setting', api.codeExtensions(' .YAML, yml,sh\npy, , yml'), ['yaml', 'yml', 'sh', 'py']);
eq('Markdown is never taken over', api.codeExtensions('md, yaml'), ['yaml']);
eq('every default extension has a language', api.codeExtensions(api.DEFAULT_SETTINGS.codeExtensions).filter((e) => !api.CODE_LANGS[e]), []);

// Plugin: metas from the demo note
const P = new api.Plugin();
P.settings = { autoIds: true, defaultLang: 'bash' };
P.idJobs = new Map();
const metas = P.metasFor(note).map(({ meta }) => meta);
eq('demo block count', metas.length, 27);
eq('demo kinds', metas.map((m) => m.kind[0]).join(''), 'rrrrrrfffff' + 'r'.repeat(12) + 'f' + 'rrr');
eq('no warnings in demo', metas.flatMap((m) => m.warnings), []);
eq('callout block', [metas[metas.length - 1].lang, metas[metas.length - 1].code], ['js', 'console.log([1, 2, 3].map(n => n * n).join(" "))']);
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
eq('hasChecks', metas.map(api.hasChecks).map(Number).join(''), '011111111110001000000000000');
const sc = P.makeMeta('file', 'path: a.txt\nexpect: hi\ncheck: cat "$FILE"\n---\nhi');
eq('shorthands', [sc.expect.content, sc.check.run], ['hi', 'cat "$FILE"']);
eq('check without run warns', P.makeMeta('file', 'path: a\ncheck:\n  lang: bash\n---\nx').warnings, ['"check" needs a "run" command.']);
eq('unknown key warns', P.makeMeta('run', 'lang: bash\neditble: true\n---\nx').warnings, ['Unknown setting "editble" in this block\'s header.']);

eq('broken header warns', P.makeMeta('run', 'lang: bash\nexpect: { bad\n---\nx').warnings.length, 1);
eq('non-header text before --- does not warn', P.makeMeta('run', 'echo a: b {\n---\nx').warnings, []);

const lm = P.makeMeta('file', 'id: f1\npath: a.yaml\neditable: true\nlearner: |-\n  mine\n---\nauthor');
eq('an older note\'s learner entry is still read', [lm.code, lm.original, lm.learner], ['mine', 'author', 'mine']);
const om = P.makeMeta('file', 'id: f1\npath: a.yaml\neditable: true\noriginal: |2-\n    indented\n  author\n---\nmine');
eq('the learner\'s code is below ---, the original in the header', [om.code, om.original, om.learner], ['mine', '  indented\nauthor', 'mine']);
eq('an unedited block has no learner code', P.makeMeta('run', 'editable: true\n---\necho x').learner, null);
const edit = (src, code) => api.withLearner(P.makeMeta('run', src), src, code);
eq('editing moves the original into the header', edit('id: a\neditable: true\n---\n# your command', 'echo hi\necho there'),
  'id: a\neditable: true\noriginal: |2-\n  # your command\n---\necho hi\necho there');
eq('the original keeps leading spaces and blank lines', edit('editable: true\n---\n  a\n\nb', 'x'), 'editable: true\noriginal: |2-\n    a\n\n  b\n---\nx');
eq('an empty original is kept too', edit('editable: true\n---\n', 'x'), 'editable: true\noriginal: ""\n---\nx');
eq('editing again keeps the original', edit('editable: true\noriginal: |2-\n  orig\n---\nfirst', 'second'), 'editable: true\noriginal: |2-\n  orig\n---\nsecond');
eq('back to the original removes the entry', edit('editable: true\noriginal: |2-\n  orig\n---\nfirst', 'orig'), 'editable: true\n---\norig');
eq('no change leaves the body alone', edit('editable: true\noriginal: |2-\n  orig\n---\nfirst', 'first'), 'editable: true\noriginal: |2-\n  orig\n---\nfirst');
eq('an older learner entry is converted', edit('editable: true\nlearner: mine\n---\norig', 'mine'), 'editable: true\noriginal: |2-\n  orig\n---\nmine');
eq('an older learner entry back to the original is removed', edit('editable: true\nlearner: mine\n---\norig', 'orig'), 'editable: true\n---\norig');
const rt = edit('editable: true\n---\n  - a: 1\n---\nb', 'x');
eq('the original round-trips through the header', P.makeMeta('run', rt).original, '  - a: 1\n---\nb');
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

// Saved results: what goes into result:, and back
const runMeta = P.makeMeta('run', 'id: eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\nlang: bash\nexpect:\n  output: hello\n---\necho hello');
const live = { done: true, startedAt: Date.parse('2026-11-01T10:00:00Z'), durationMs: 42, exitCode: 0, stdout: 'hello\n',
  chunks: [{ stream: 'stdout', text: 'hello\n' }, { stream: 'stderr', text: 'a warning\n' }], outputHash: 'h:hello', cmdHash: 'h:echo hello' };
const saved = api.savedResult(runMeta, live);
eq('saved run result', saved, { ran: '2026-11-01T10:00:00.000Z', 'duration-ms': 42, exit: 0, 'output-md5': 'h:hello', 'command-md5': 'h:echo hello', stdout: 'hello', stderr: 'a warning' });
const back = api.loadResult(runMeta, api.splitHeader(api.setHeaderEntry('lang: bash\n---\nx', 'result', saved)).header.result);
eq('loaded run result', [back.exitCode, back.stdout, back.chunks.map((c) => c.stream), back.durationMs, back.saved], [0, 'hello', ['stdout', 'stderr'], 42, true]);
eq('a loaded result evaluates the same', api.evaluate(runMeta, back).status, api.evaluate(runMeta, live).status);
const big = 'x'.repeat(12000) + '\nhello';
const bigMeta = P.makeMeta('run', 'id: eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\nlang: bash\nexpect:\n  output: ' + JSON.stringify(big) + '\n---\nprint');
const bigSaved = api.savedResult(bigMeta, Object.assign({}, live, { stdout: big, chunks: [{ stream: 'stdout', text: big }], outputHash: 'h:' + big }));
eq('long output is cut', [bigSaved.stdout.length, bigSaved.truncated], [10000, true]);
eq('cut output still passes its exact check, by hash', api.evaluate(bigMeta, api.loadResult(bigMeta, bigSaved)).status, 'pass');
const errSaved = api.savedResult(runMeta, Object.assign({}, live, { error: 'Timed out after 2 s', timedOut: true, exitCode: null }));
eq('a timeout is saved and loaded', api.evaluate(runMeta, api.loadResult(runMeta, errSaved)).label, 'Timed out');
const fileMeta = P.makeMeta('file', 'id: ffffffff-ffff-4fff-8fff-ffffffffffff\npath: a.yaml\ncheck:\n  run: x\n  expect: "3"\n---\nreplicas: 3');
const fileLive = { done: true, startedAt: 1, durationMs: 5, exitCode: 0, outputHash: 'h:replicas: 3', content: 'replicas: 3', check: { stdout: '3\n', stderr: '', exitCode: 0 } };
const fileSaved = api.savedResult(fileMeta, fileLive);
eq('saved file result has no check output, only its hash', [fileSaved['content-md5'], fileSaved.check], ['h:replicas: 3', { exit: 0, 'output-md5': 'h:3' }]);
eq('a loaded file result passes its check', api.evaluate(fileMeta, api.loadResult(fileMeta, fileSaved)).status, 'pass');

// Re-render heights are looked up by the id in the block's raw text
P.heights = new Map();
eq('key from raw text, with an id', P.keyForSource('n.md', 'id: ' + 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' + '\nlang: bash\n---\nls'), P.keyFor('n.md', { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
eq('no key from raw text without an id', P.keyForSource('n.md', 'lang: bash\n---\nls'), null);
eq('no key from raw text with a short id', P.keyForSource('n.md', 'id: k3f9qz\n---\nls'), null);

// Idempotency
eq('blocks are idempotent by default', P.makeMeta('run', 'lang: bash\n---\nls').idempotent, true);
eq('idempotent: false', P.makeMeta('run', 'lang: bash\nidempotent: false\n---\nmkdir x').idempotent, false);

// Revert commands
eq('revert as a command', P.makeMeta('run', 'lang: python\nrevert: rm -rf x\n---\nprint(1)').revert, { lang: 'python', run: 'rm -rf x' });
eq('revert as a map', P.makeMeta('run', 'lang: bash\nrevert:\n  lang: python\n  run: print(2)\n---\nls').revert, { lang: 'python', run: 'print(2)' });
eq('file block revert uses the default language', P.makeMeta('file', 'path: a.txt\nrevert: rm -f "$FILE"\n---\nx').revert, { lang: 'bash', run: 'rm -f "$FILE"' });
eq('revert without run warns', P.makeMeta('run', 'lang: bash\nrevert:\n  lang: bash\n---\nls').warnings, ['"revert" needs a "run" command.']);
eq('no revert', P.makeMeta('run', 'lang: bash\n---\nls').revert, null);

// Dependencies, using the demo's four dependency blocks
Object.assign(P, { reverts: new Map(), revertProcs: new Map(), results: new Map(), procs: new Map(), drafts: new Map(), widgets: new Map(), written: new Map(), writeTimers: new Map(), noteIndex: new Map(), commandChecks: new Map(), resetting: new Set(), removed: new Set() });
const dm = P.metasFor(note, 'demo.md').map(({ meta }) => meta);
const [dA, dB, dC, dD] = dm.slice(15, 19);
const waitingFor = (meta) => P.prerequisiteState('demo.md', meta).waiting.map((w) => w.reason);
eq('depends-on as one id', dB.dependsOn, [dA.id]);
eq('depends-on as a list', dD.dependsOn, [dA.id, dC.id]);
eq('blocked until the dependency has run', [P.prerequisiteState('demo.md', dB).blocked, waitingFor(dB)], [true, ['not run yet']]);
eq('waiting names the line', P.prerequisiteState('demo.md', dB).waiting[0].line, dA.lineStart + 1);
eq('waiting labels the block', P.prerequisiteState('demo.md', dB).waiting[0].label, 'bash: mkdir -p demo');
P.results.set(P.keyFor('demo.md', dA), { done: false });
eq('blocked while the dependency runs', waitingFor(dB), ['running']);
P.results.set(P.keyFor('demo.md', dA), { done: true, exitCode: 0, stdout: '' });
eq('unblocked once the dependency ran cleanly', P.prerequisiteState('demo.md', dB).blocked, false);
P.results.set(P.keyFor('demo.md', dC), { done: true, exitCode: 1, stdout: '' });
eq('a dependency that exited with an error blocks', waitingFor(dD), ['exit 1']);
P.results.set(P.keyFor('demo.md', dC), { done: true, exitCode: 0, stdout: '' });
eq('unblocked once every dependency is complete', P.prerequisiteState('demo.md', dD).blocked, false);
const checked = P.metasFor('```run\nid: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nexpect: yes\n---\necho no\n```\n```run\nid: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\ndepends-on: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n---\nls\n```\n', 'checked.md').map(({ meta }) => meta);
P.results.set(P.keyFor('checked.md', checked[0]), { done: true, exitCode: 0, stdout: 'no' });
eq('a dependency that failed its checks blocks', P.prerequisiteState('checked.md', checked[1]).waiting.map((w) => w.reason), ['failed its checks']);
P.results.set(P.keyFor('checked.md', checked[0]), { done: true, exitCode: 0, stdout: 'yes' });
eq('a dependency that passed its checks unblocks', P.prerequisiteState('checked.md', checked[1]).blocked, false);
const lost = P.makeMeta('run', 'id: cccccccc-cccc-4ccc-8ccc-cccccccccccc\ndepends-on: 99999999-9999-4999-8999-999999999999\n---\nls');
eq('an unknown id blocks', P.prerequisiteState('demo.md', lost).waiting.map((w) => w.reason), ['not found in the vault']);

// Dependencies on blocks in other notes
const setupNote = '```run\nid: 5e7a0000-0000-4000-8000-000000000001\nlang: bash\n---\nkind create cluster\n```\n';
const labNote = '```run\nid: 1ab00000-0000-4000-8000-000000000002\nlang: bash\ndepends-on: 5e7a0000-0000-4000-8000-000000000001\n---\nkubectl get pods\n```\n';
const [setupBlock] = P.metasFor(setupNote, 'course/1 Setup.md').map(({ meta }) => meta);
const [labBlock] = P.metasFor(labNote, 'course/2 Lab.md').map(({ meta }) => meta);
const crossWait = () => P.prerequisiteState('course/2 Lab.md', labBlock).waiting;
eq('a block in another note is found', [crossWait()[0].reason, crossWait()[0].note, crossWait()[0].line], ['not run yet', 'course/1 Setup.md', 1]);
eq('it is never "below" this block', crossWait()[0].below, false);
eq('the summary names the other note', crossWait()[0].summary, 'run line 1 (bash: kind create cluster) in 1 Setup first');
P.results.set(P.keyFor('course/1 Setup.md', setupBlock), { done: true, exitCode: 0, stdout: '' });
eq('its result in the other note unblocks', P.prerequisiteState('course/2 Lab.md', labBlock).blocked, false);
P.results.set(P.keyFor('course/2 Lab.md', labBlock), { done: true, exitCode: 0, stdout: '' });
eq('the dependent in the other note holds up a reset', P.resetBlocker('course/1 Setup.md', setupBlock), 'reset bash: kubectl get pods in 2 Lab first, which depend on it');
P.results.delete(P.keyFor('course/2 Lab.md', labBlock));
eq('until it is reset', P.resetBlocker('course/1 Setup.md', setupBlock), null);
const localFirst = P.metasFor(setupNote.replace('kind create cluster', 'echo copy') + labNote, 'course/3 Copy.md').map(({ meta }) => meta);
eq('a block in the same note wins over one elsewhere with the same id', P.prerequisiteState('course/3 Copy.md', localFirst[1]).waiting[0].note, null);
P.results.delete(P.keyFor('course/1 Setup.md', setupBlock));
['course/1 Setup.md', 'course/2 Lab.md', 'course/3 Copy.md'].forEach((n) => P.noteIndex.delete(n));
eq('a non-UUID dependency warns', P.makeMeta('run', 'lang: bash\ndepends-on: first-block\n---\nls').warnings.length, 1);
const above = Object.assign(P.makeMeta('run', 'id: dddddddd-dddd-4ddd-8ddd-dddddddddddd\ndepends-on: ' + dD.id + '\n---\nls'), { lineStart: 0 });
P.results.delete(P.keyFor('demo.md', dD));
eq('a dependency below the block is flagged', P.prerequisiteState('demo.md', above).waiting[0].below, true);
eq('no dependencies, never blocked', P.prerequisiteState('demo.md', dA).blocked, false);

// Alternative paths: "use your own cluster" (choose it, then check it) instead of creating one and checking it
{
  const id = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n.repeat(12)}`;
  const block = (i, header, code) => '```run\nid: ' + id(i) + '\n' + header + '---\n' + code + '\n```\n';
  const altNote = block('1', 'expect: all set\n', 'echo all set')
    + block('2', 'depends-on: ' + id('1') + '\ninstead-of:\n  - ' + id('4') + '\n  - ' + id('5') + '\nrevert: echo undo\n', 'use my cluster')
    + block('3', 'depends-on: ' + id('2') + '\nexpect: ready\n', 'echo ready')
    + block('4', 'depends-on: ' + id('1') + '\nrevert: kind delete cluster\n', 'kind create cluster')
    + block('5', 'depends-on: ' + id('4') + '\nexpect: 5 nodes ready\n', 'echo 5 nodes ready')
    + block('6', 'depends-on:\n  - ' + id('4') + '\n  - ' + id('5') + '\n', 'helm install');
  const [tools, own, ownCheck, create, ready, install] = P.metasFor(altNote, 'alt.md').map(({ meta }) => meta);
  const ok = { done: true, exitCode: 0, stdout: '' };
  const set = (m, res) => P.results.set(P.keyFor('alt.md', m), res);
  const reasons = (m) => P.prerequisiteState('alt.md', m).waiting.map((w) => w.type + ':' + w.reason);
  set(tools, Object.assign({}, ok, { stdout: 'all set' }));
  eq('instead-of is parsed', own.insteadOf, [id('4'), id('5')]);
  eq('a non-UUID instead-of warns', P.makeMeta('run', 'instead-of: kind\n---\nx').warnings.length, 1);
  eq('the path is the alternative and what depends on it', P.alternativePath({ path: 'alt.md', meta: own }).map((st) => st.meta.id), [id('2'), id('3')]);
  eq('both blocks of the path know their start', [own, ownCheck, install].map((m) => P.pathsThrough('alt.md', m).length), [1, 1, 0]);
  eq('before either way is chosen, both can start', [reasons(own), reasons(create)], [[], []]);
  eq('Run all leaves the alternative path alone', [P.onUnusedPath('alt.md', own), P.onUnusedPath('alt.md', ownCheck), P.onUnusedPath('alt.md', create)], [true, true, false]);
  set(own, ok);
  eq('once the path is in use, the blocks it replaces are not needed', [reasons(create)[0], reasons(ready)[0]], ['replaced:in use', 'replaced:in use']);
  eq('and the rest of the path is no longer skipped', P.onUnusedPath('alt.md', ownCheck), false);
  eq('but they only count as done once the whole path has succeeded', reasons(install), ['block:not run yet', 'block:not run yet']);
  set(ownCheck, Object.assign({}, ok, { stdout: 'ready' }));
  eq('then the next steps can run', reasons(install), []);
  eq('the replaced block names the alternative', P.prerequisiteState('alt.md', create).waiting[0].label, 'bash: use my cluster');
  set(install, ok);
  eq('a block on the path can\'t be reset while the next steps have results', P.resetBlocker('alt.md', ownCheck), 'reset bash: helm install first, which depend on it');
  P.results.delete(P.keyFor('alt.md', install));
  set(ownCheck, Object.assign({}, ok, { stdout: 'not ready' }));
  eq('a path with a failed block still holds the other way', reasons(create), ['replaced:in use']);
  eq('but stands in for nothing', reasons(install), ['block:not run yet', 'block:not run yet']);
  P.results.delete(P.keyFor('alt.md', ownCheck));
  P.results.delete(P.keyFor('alt.md', own));
  set(create, ok);
  eq('once the usual way has run, the whole alternative path is blocked', [reasons(own), reasons(ownCheck)], [['other-path:already run'], ['other-path:already run', 'block:not run yet']]);
  eq('and says to reset it first', P.prerequisiteState('alt.md', own).waiting[0].summary, 'reset line 24 (bash: kind create cluster) first: this is instead of it');
  eq('the usual way unblocks its next step as before', reasons(ready), []);
  eq('an alternative found from the block it replaces', P.alternativesFor(create).map((a) => a.meta.id), [id('2')]);
  [tools, own, ownCheck, create, ready, install].forEach((m) => P.results.delete(P.keyFor('alt.md', m)));
  P.noteIndex.delete('alt.md');
}

// Prerequisites: requires
const reqMeta = (header) => Object.assign(P.makeMeta('run', 'id: eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\nlang: bash\neditable: true\n' + header + '---\nkubectl get pods'), { lineStart: 99 });
const rq = reqMeta('requires:\n  - ' + dA.id + '\n  - block: ' + dC.id + '\n    message: Create the topic\n  - command: command -v kubectl\n    message: Install kubectl\n  - matches: ^kubectl scale\n    flags: m\n    message: Use kubectl scale\n');
eq('requires parses each kind', rq.requires.map((r) => r.type), ['block', 'block', 'command', 'matches']);
eq('requires block ids count as dependencies', rq.dependsOn, [dA.id, dC.id]);
eq('a command gets the default language and timeout', [rq.requires[2].lang, rq.requires[2].timeout, rq.requires[2].run], ['bash', 10, 'command -v kubectl']);
eq('depends-on and requires combine', reqMeta('depends-on: ' + dA.id + '\nrequires:\n  - matches: x\n').requires.map((r) => r.type), ['block', 'matches']);
eq('an entry with two kinds warns', reqMeta('requires:\n  - command: ls\n    matches: x\n').warnings, ['requires, entry 1: needs one of "block", "command" or "matches".']);
eq('an unknown key in an entry warns', reqMeta('requires:\n  - command: ls\n    flags: i\n').warnings, ['Unknown setting "flags" in requires, entry 1.']);
eq('a bad pattern warns and is left out', [reqMeta('requires:\n  - matches: "("\n').warnings.length, reqMeta('requires:\n  - matches: "("\n').requires.length], [1, 0]);
P.results.set(P.keyFor('demo.md', dA), { done: true, exitCode: 0, stdout: '' });
eq('an unchecked command and an unmatched pattern', P.prerequisiteState('demo.md', rq).waiting.map((w) => [w.type, w.reason]), [['matches', "doesn't match"]]);
eq('the pattern says what to do', P.prerequisiteState('demo.md', rq).waiting[0].summary, 'Use kubectl scale');
P.drafts.set(P.keyFor('demo.md', rq), 'kubectl scale sts/redpanda --replicas=4');
eq('the learner\'s code matching unblocks', P.prerequisiteState('demo.md', rq).blocked, false);
eq('a pattern without a message has a default', P.prerequisiteState('demo.md', reqMeta('requires:\n  - matches: nope\n')).waiting[0].summary, "The code isn't in the expected form yet");
P.commandChecks.set(P.commandKey('demo.md', rq.requires[2]), { done: false });
eq('a command being checked blocks', waitingFor(rq), ['checking']);
P.commandChecks.set(P.commandKey('demo.md', rq.requires[2]), { done: true, ok: false, exitCode: 1 });
eq('a failed command blocks', [waitingFor(rq), P.prerequisiteState('demo.md', rq).waiting[0].failed], [['exit 1'], true]);
eq('a failed command without a message says what failed', P.prerequisiteState('demo.md', reqMeta('requires:\n  - command: command -v kubectl\n')).waiting[0].summary, '`command -v kubectl` has to succeed (exit 1)');
P.commandChecks.set(P.commandKey('demo.md', rq.requires[2]), { done: true, ok: true, exitCode: 0 });
eq('a command that succeeded is met', P.prerequisiteState('demo.md', rq).blocked, false);
P.drafts.clear();
P.commandChecks.clear();
// A failed command check is run again once it's a few seconds old, or after any block finishes.
const spawned = [];
const [realSpawn, realGetFile] = [P.spawnScript, P.getFile];
P.spawnScript = (lang, code) => { spawned.push(code); return { promise: Promise.resolve({ exitCode: 0 }) }; };
P.getFile = () => null;
const cmdReq = reqMeta('requires:\n  - command: kind get clusters\n');
const cmdKey = P.commandKey('demo.md', cmdReq.requires[0]);
P.commandChecks.set(cmdKey, { done: true, ok: false, exitCode: 1, at: Date.now(), promise: Promise.resolve() });
P.checkPrerequisites('demo.md', cmdReq);
eq('a check that has just failed is not run again on render', spawned.length, 0);
P.commandChecks.get(cmdKey).at = Date.now() - 6000;
P.checkPrerequisites('demo.md', cmdReq);
eq('one that failed a while ago is', spawned, ['kind get clusters']);
P.commandChecks.set(cmdKey, { done: true, ok: false, exitCode: 1, at: Date.now(), promise: Promise.resolve() });
P.expireFailedChecks();
P.checkPrerequisites('demo.md', cmdReq);
eq('and so is one any block finishing has expired', spawned.length, 2);
P.commandChecks.set(cmdKey, { done: true, ok: true, exitCode: 0, at: 0, promise: Promise.resolve() });
P.checkPrerequisites('demo.md', cmdReq);
eq('a check that passed is left alone until the block runs', spawned.length, 2);
Object.assign(P, { spawnScript: realSpawn, getFile: realGetFile });
P.commandChecks.clear();
const [pCmd, pEx] = dm.slice(19, 21);
eq('demo command prerequisites', pCmd.requires.map((r) => r.run), ['command -v git', 'test -f demo/started.txt']);
eq('demo exercise is blocked by its placeholder', waitingFor(pEx), ["doesn't match"]);
P.drafts.set(P.keyFor('demo.md', pEx), '# count them\nwc -l demo/started.txt');
eq('demo exercise unblocks with wc -l', P.prerequisiteState('demo.md', pEx).blocked, false);
P.drafts.clear();
P.results.delete(P.keyFor('demo.md', dA));
const gated = P.runCell('demo.md', dB);

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
Object.assign(P, { reverts: new Map(), revertProcs: new Map(), results: new Map(), procs: new Map(), drafts: new Map(), widgets: new Map(), written: new Map(), writeTimers: new Map() });
const sync = out.length;
const original = disk;
const second = () => P.metasFor(disk)[1].meta;
const oldKey = P.keyFor('n.md', second());
P.drafts.set(oldKey, 'echo draft');
P.results.set(oldKey, { done: true, stdout: 'earlier output' });
gated.then((res) => {
  eq('a blocked block refuses to run', [res, P.results.has(P.keyFor('demo.md', dB))], [null, false]);
  return P.resolveMeta('n.md', '# your command here', null, 'run');
}).then(() => {
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
  Object.assign(P, { reverts: new Map(), revertProcs: new Map(), results: new Map(), procs: new Map(), drafts: new Map(), widgets: new Map(), written: new Map(), writeTimers: new Map(), resetting: new Set(), removed: new Set() });
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

    // Reset (the toolbar button, and Reset all): the learner's edits go, and the original is checked.
    disk = '```file\nid: ' + U1 + '\npath: demo/a.yaml\neditable: true\nexpect:\n  content: "replicas: 3"\nlearner: "replicas: 3"\n---\nreplicas: 1\n```\n';
    files['/vault/demo/a.yaml'] = 'replicas: 3\n';
    P.drafts.clear();
    return P.writeFileBlock('n.md', fm(), { write: false });
  }).then(() => {
    eq('before reset: the learner\'s file passes', api.evaluate(fm(), P.results.get(key)).status, 'pass');
    eq('an edited file block can be reset', P.resetBlocker('n.md', fm()), null);
    return P.resetBlock('n.md', fm());
  }).then(() => new Promise((r) => r())).then(() => {
    eq('reset deletes the file', '/vault/demo/a.yaml' in files, false);
    eq('reset removes the learner\'s content from the note', [fm().learner, fm().code], [null, 'replicas: 1']);
    eq('reset leaves no result', [P.results.has(key), fm().saved], [false, null]);
    eq('reset leaves nothing being reset', P.resetting.size, 0);
    P.syncFromDisk('n.md', fm(), { onLoad: true });
    P.validateOnLoad('n.md', fm());
    eq('a re-render doesn\'t recreate or check it', ['/vault/demo/a.yaml' in files, P.results.has(key)], [false, false]);
    eq('then there\'s nothing to reset', P.resetBlocker('n.md', fm()), "there's nothing to reset");
    return P.writeFileBlock('n.md', fm(), { check: false, record: false });
  }).then(() => {
    eq('writing it again brings it back', [files['/vault/demo/a.yaml'], P.removed.size], ['replicas: 1\n', 0]);
    eq('an unedited file on disk can be reset', P.resetBlocker('n.md', fm()), null);
    files['/vault/demo/a.yaml'] = 'someone else\n';
    P.removeWrittenFile('n.md', fm());
    eq('a file changed by something else is kept', files['/vault/demo/a.yaml'], 'someone else\n');

    disk = '```file\nid: 33333333-3333-4333-8333-333333333333\npath: demo/b.txt\n---\nplain\n```\n';
    return P.writeFileBlock('n.md', fm());
  }).then(() => {
    eq('a non-editable file block writes its file', files['/vault/demo/b.txt'], 'plain\n');
    return P.resetBlock('n.md', fm());
  }).then(() => {
    eq('and Reset deletes it', ['/vault/demo/b.txt' in files, P.results.has(P.keyFor('n.md', fm()))], [false, false]);
    files['/vault/demo/b.txt'] = 'plain\n';
    P.results.clear();
    eq('a file block whose file is on disk can be reset, with no result', P.resetBlocker('n.md', fm()), null);
    // An editable run block: the learner's answer goes in `learner:`, and the original stays.
    disk = '```run\nid: 44444444-4444-4444-8444-444444444444\nlang: bash\neditable: true\n---\n# your command here\n```\n';
    P.results.clear();
    P.drafts.clear();
    eq('an editable run block starts with its original', [fm().code, fm().original, fm().learner], ['# your command here', '# your command here', null]);
    P.setDraft(P.keyFor('n.md', fm()), fm(), 'echo answer');
    return P.persistLearner('n.md', fm());
  }).then(() => {
    eq('leaving the editor saves the answer as learner', [fm().learner, fm().code], ['echo answer', 'echo answer']);
    eq('and keeps the original in the header', [fm().original, fm().stored], ['# your command here', '# your command here']);
    eq('with the answer below ---', disk.split('---\n')[1], 'echo answer\n```\n');
    P.settleDraft(P.keyFor('n.md', fm()), fm());
    eq('the saved answer counts as edited, so it can be reset', P.resetBlocker('n.md', fm()), null);
    P.setDraft(P.keyFor('n.md', fm()), fm(), 'echo better answer');
    const res = { done: true, startedAt: 1000, durationMs: 5, exitCode: 0, stdout: 'better answer\n', chunks: [], outputHash: 'h:better answer', cmdHash: 'h:echo better answer' };
    P.results.set(P.keyFor('n.md', fm()), res);
    return P.persistResult('n.md', fm(), res);
  }).then(() => {
    eq('running saves the answer with its result', [fm().learner, fm().saved && fm().saved.stdout], ['echo better answer', 'better answer']);
    eq('the original is still there', fm().original, '# your command here');
    P.settleDraft(P.keyFor('n.md', fm()), fm());
    return P.resetBlock('n.md', fm());
  }).then(() => {
    eq('Reset puts the original code back', [fm().learner, fm().code, fm().saved], [null, '# your command here', null]);
    eq('and clears the result', P.results.has(P.keyFor('n.md', fm())), false);
    P.settleDraft(P.keyFor('n.md', fm()), fm());
    eq('then there is nothing to reset', P.resetBlocker('n.md', fm()), "there's nothing to reset");
    // Clicking ▶ saves the editor first, which re-renders the block while it runs. The result is
    // saved from the block as it was, and must keep the answer that ran.
    disk = '```run\nid: 55555555-5555-4555-8555-555555555555\nlang: bash\neditable: true\n---\n# your command here\n```\n';
    const before = fm();
    const k = P.keyFor('n.md', before);
    P.setDraft(k, before, 'seq 1 3 | rpk topic produce orders');
    return P.persistLearner('n.md', before).then(() => {
      P.settleDraft(k, fm());
      const res = { done: true, startedAt: 1, durationMs: 5, exitCode: 0, stdout: 'ok', chunks: [], outputHash: 'h:ok', cmdHash: 'h:x', code: 'seq 1 3 | rpk topic produce orders' };
      return P.persistResult('n.md', before, res);
    }).then(() => {
      eq('a result saved from the block as it was keeps the answer that ran', [fm().learner, fm().saved && fm().saved.stdout], ['seq 1 3 | rpk topic produce orders', 'ok']);
    });
  }).then(() => {
    // The learner saves a first try by leaving the editor, then finishes the answer and clicks ▶.
    // The click lands on the block from before that save re-rendered it.
    disk = '```run\nid: 66666666-6666-4666-8666-666666666666\nlang: bash\neditable: true\n---\n# your command here\n```\n';
    const first = fm();
    const k = P.keyFor('n.md', first);
    P.setDraft(k, first, 'rpk security acl create --allow-principal producer-app --operation write');
    return P.persistLearner('n.md', first).then(() => {
      const second = fm();
      P.settleDraft(k, second);
      P.setDraft(k, second, 'rpk security acl create --allow-principal producer-app --operation write --topic orders');
      return P.persistLearner('n.md', second).then(() => {
        P.settleDraft(k, fm());
        eq('an out-of-date block still sees the latest answer', P.currentCode(k, second), 'rpk security acl create --allow-principal producer-app --operation write --topic orders');
        eq('and its latest version is found', P.freshMeta('n.md', first).learner, 'rpk security acl create --allow-principal producer-app --operation write --topic orders');
      });
    });
  }).then(() => {
    eq('a learner entry on a block that is not editable is ignored', P.makeMeta('run', 'lang: bash\nlearner: echo x\n---\necho y').code, 'echo y');
  });
}).then(() => {
  // Results saved in the note: after a run, and still there after a restart
  disk = '```run\nid: ' + U1 + '\nlang: bash\n---\necho hi\n```\n```run\nid: 22222222-2222-4222-8222-222222222222\ndepends-on: ' + U1 + '\n---\nls\n```\n';
  P.results = new Map();
  const first = () => P.metasFor(disk, 'n.md')[0].meta;
  const res = { done: true, startedAt: 1000, durationMs: 7, exitCode: 0, stdout: 'hi\n', chunks: [{ stream: 'stdout', text: 'hi\n' }], outputHash: 'h:hi', cmdHash: 'h:echo hi' };
  return P.persistResult('n.md', first(), res).then(() => {
    eq('the result is saved in the note', [first().saved && first().saved.stdout, first().saved && first().saved.exit], ['hi', 0]);
    eq('the code is untouched', first().code, 'echo hi');
    P.results = new Map();
    const restored = P.resultFor('n.md', first());
    eq('after a restart the saved result is used', [restored && restored.stdout, restored && api.evaluate(first(), restored).status], ['hi', 'ok']);
    eq('a saved result counts for dependencies', P.prerequisiteState('n.md', P.metasFor(disk, 'n.md')[1].meta).blocked, false);
    return P.clearBlock('n.md', first());
  }).then(() => {
    eq('clearing removes the result from the note', [first().saved, P.resultFor('n.md', first())], [null, null]);
    eq('and blocks dependents again', P.prerequisiteState('n.md', P.metasFor(disk, 'n.md')[1].meta).blocked, true);
  });
}).then(() => {
  // Revert and reset. Commands don't really run: spawnScript is replaced, and records what it was given.
  const UA = '33333333-3333-4333-8333-333333333333';
  const UB = '44444444-4444-4444-8444-444444444444';
  disk = '```run\nid: ' + UA + '\nlang: bash\nrevert: rm -rf demo/a\n---\nmkdir -p demo/a\n```\n'
    + '```run\nid: ' + UB + '\nlang: bash\ndepends-on: ' + UA + '\nrevert: rm -f demo/a/b\n---\ntouch demo/a/b\n```\n';
  Object.assign(P, { results: new Map(), reverts: new Map(), revertProcs: new Map(), procs: new Map() });
  const ran = [];
  let exitCode = 0;
  P.spawnScript = (lang, code, file, timeout, onData) => {
    ran.push(code);
    onData('stdout', 'reverting ' + code + '\n');
    return { promise: Promise.resolve({ exitCode }), kill() {} };
  };
  const m = () => P.metasFor(disk, 'n.md').map(({ meta }) => meta);
  const done = (stdout) => ({ done: true, startedAt: 1, durationMs: 1, exitCode: 0, stdout, chunks: [], outputHash: 'h', cmdHash: 'h' });
  P.results.set(P.keyFor('n.md', m()[0]), done('a'));
  P.results.set(P.keyFor('n.md', m()[1]), done('b'));
  return P.persistResult('n.md', m()[0], P.results.get(P.keyFor('n.md', m()[0]))).then(() => {
    eq('nothing to revert before a run', P.revertBlocker('n.md', P.makeMeta('run', 'id: 55555555-5555-4555-8555-555555555555\nrevert: x\n---\ny')), "it hasn't run");
    eq('a dependent with a result blocks the revert', /first, which depend on it/.test(P.revertBlocker('n.md', m()[0])), true);
    return P.revertBlock('n.md', m()[0]);
  }).then((ok) => {
    eq('a blocked revert does nothing', [ok, ran.length], [false, 0]);
    exitCode = 1;
    return P.revertBlock('n.md', m()[1]);
  }).then((ok) => {
    eq('a failed revert keeps the result', [ok, !!P.resultFor('n.md', m()[1]), P.reverts.get(P.keyFor('n.md', m()[1])).ok], [false, true, false]);
    exitCode = 0;
    return P.revertBlock('n.md', m()[1]);
  }).then((ok) => {
    eq('a revert runs the revert command', ran[ran.length - 1], 'rm -f demo/a/b');
    eq('a successful revert removes the result', [ok, P.resultFor('n.md', m()[1])], [true, null]);
    eq('the revert output is kept to show', P.reverts.get(P.keyFor('n.md', m()[1])).chunks[0].text, 'reverting rm -f demo/a/b\n');
    eq('once its dependent is reverted, a block can be reverted', P.revertBlocker('n.md', m()[0]), null);
    return P.revertBlock('n.md', m()[0]);
  }).then(() => {
    eq('a revert removes the saved result from the note', [m()[0].saved, m()[1].saved], [null, null]);
    eq('dependents are blocked again', P.prerequisiteState('n.md', m()[1]).blocked, true);
    // Reset on a block with a revert command reverts it, and keeps the revert's output to show
    P.results.set(P.keyFor('n.md', m()[0]), done('a'));
    return P.resetBlock('n.md', m()[0]);
  }).then((ok) => {
    eq('reset reverts a block with a revert command', [ok, ran[ran.length - 1], P.resultFor('n.md', m()[0])], [true, 'rm -rf demo/a', null]);
    eq('and shows what the revert did', P.reverts.get(P.keyFor('n.md', m()[0])).ok, true);
    return P.resetBlock('n.md', m()[0]);
  }).then((ok) => {
    eq('resetting again clears the revert output', [ok, P.reverts.has(P.keyFor('n.md', m()[0]))], [true, false]);
    eq('then there is nothing to reset', P.resetBlocker('n.md', m()[0]), "there's nothing to reset");
    // Reset without a revert command just clears; with dependents that have results, it refuses
    disk = disk.replace('revert: rm -rf demo/a\n', '');
    P.results.set(P.keyFor('n.md', m()[0]), done('a'));
    P.results.set(P.keyFor('n.md', m()[1]), done('b'));
    return P.resetBlock('n.md', m()[0]);
  }).then((ok) => {
    eq('reset refuses while a dependent has a result', [ok, !!P.resultFor('n.md', m()[0])], [false, true]);
    eq('and says why', /first, which depend on it/.test(P.resetBlocker('n.md', m()[0])), true);
    ran.length = 0;
    return P.resetAll({ path: 'n.md' });
  }).then(() => {
    eq('reset all works bottom up', ran, ['rm -f demo/a/b']);
    eq('reset all clears every block', [P.resultFor('n.md', m()[0]), P.resultFor('n.md', m()[1])], [null, null]);
  });
}).then(() => {
  // Idempotency: a block that isn't idempotent runs once, until it's reset
  const UO = '66666666-6666-4666-8666-666666666666';
  const UL = '77777777-7777-4777-8777-777777777777';
  disk = '```run\nid: ' + UO + '\nlang: bash\nidempotent: false\n---\nmkdir demo/once\n```\n'
    + '```run\nid: ' + UL + '\nlang: bash\n---\nls demo\n```\n';
  Object.assign(P, { results: new Map(), reverts: new Map(), revertProcs: new Map(), procs: new Map() });
  const m = () => P.metasFor(disk, 'n.md').map(({ meta }) => meta);
  const ran = [];
  let exitCode = 0;
  P.runBlock = (path, meta) => {
    ran.push(meta.code);
    const res = { done: true, startedAt: 1, durationMs: 1, exitCode, stdout: '', chunks: [], outputHash: 'h', cmdHash: 'h' };
    P.results.set(P.keyFor(path, meta), res);
    return Promise.resolve(res);
  };
  P.writePendingFiles = () => Promise.resolve();
  eq('runnable before it has run', P.rerunBlocker('n.md', m()[0]), null);
  return P.runCell('n.md', m()[0]).then(() => {
    eq('can run once', ran, ['mkdir demo/once']);
    eq('then it says why it cannot run again', /isn't idempotent and has already run\. Reset it/.test(P.rerunBlocker('n.md', m()[0])), true);
    eq('an idempotent block can always run again', P.rerunBlocker('n.md', m()[1]), null);
    return P.runCell('n.md', m()[0]);
  }).then((res) => {
    eq('running it again is refused', [res, ran.length], [null, 1]);
    ran.length = 0;
    return P.runAll({ path: 'n.md' });
  }).then(() => {
    eq('Run all keeps a run-once block that succeeded, and carries on', ran, ['ls demo']);
    P.results.get(P.keyFor('n.md', m()[0])).exitCode = 1;
    ran.length = 0;
    return P.runAll({ path: 'n.md' });
  }).then(() => {
    eq('Run all stops at a run-once block that failed', ran, []);
    return P.resetBlock('n.md', m()[0]);
  }).then(() => {
    eq('after a reset it can run again', P.rerunBlocker('n.md', m()[0]), null);
    return P.runCell('n.md', m()[0]);
  }).then(() => eq('and it runs', ran, ['mkdir demo/once']));
}).then(() => {
  console.log(out.slice(sync).join('\n'));
  console.log('async tests finished');
}).catch((e) => console.log('FAIL async threw ' + e + '\n' + e.stack));
out.slice(0, sync).join('\n');
