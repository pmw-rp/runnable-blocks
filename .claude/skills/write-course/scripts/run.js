#!/usr/bin/env node
// Runs a note's blocks outside Obsidian, the way "Run all" would, and checks each result with the
// plugin's own evaluate(): expected output, MD5s, file checks. Use it to test a course end to end
// against a real lab before handing it over.
//
//   node run.js NOTE [--include-manual] [--only ID,ID] [--from ID] [--keep-going]
//                    [--answer ID CODE]...   fill in an editable block, as a learner would; CODE can be @FILE
//   node run.js NOTE --reverts      runs the note's revert commands from the bottom up, like Reset all
//
// Blocks run in the note's folder, like the plugin's default working directory, with bash for
// `lang: bash` and so on. IDs can be shortened to their first 8 characters. It stops at the first
// block that fails, unless --keep-going. Exit status: the number of blocks that didn't pass.
//
// Prerequisites are enforced as in Obsidian: a block whose dependencies haven't passed, whose
// `command:` checks fail, or whose code doesn't match its `matches:` patterns is reported BLOCKED
// and not run. Results are kept in a state file ($COURSE_RUN_STATE, by default in the temp folder),
// so a lesson run later sees what its setup page's run did. --reverts clears that note's results.
//
// Results aren't written into the note, so Obsidian doesn't know these blocks ran: blocks that
// depend on them stay blocked there, and Reset can't undo them. Tear down what this built with
// --reverts (or the note's own teardown) when you're done.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { newPlugin } = require('./plugin');
const Plugin = require(process.env.RUNNABLE_BLOCKS_MAIN || path.resolve(__dirname, '../../../../main.js'));
const { evaluate, normalize, md5, blockLabel } = Plugin;

const args = process.argv.slice(2);
const note = args[0] && !args[0].startsWith('--') ? args[0] : null;
const flag = (name) => args.includes(`--${name}`);
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
if (!note) {
  console.error('Usage: node run.js NOTE [--include-manual] [--only ID,ID] [--from ID] [--keep-going] [--reverts]');
  process.exit(2);
}

const INTERPRETERS = {
  bash: ['bash'], sh: ['sh'], zsh: ['zsh'], python: ['python3'], py: ['python3'],
  js: ['node'], javascript: ['node'], node: ['node'], ruby: ['ruby'], go: ['go', 'run'],
};
const EXT = { go: 'go', python: 'py', py: 'py', js: 'js', javascript: 'js', node: 'js', ruby: 'rb' };
const cwd = path.dirname(path.resolve(note));
const env = Object.assign({}, process.env, {
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/local/go/bin', process.env.PATH].join(path.delimiter),
  OBSIDIAN_NOTE: path.resolve(note),
});

// Runs code with the interpreter for `lang`. Returns { stdout, stderr, exitCode, error }.
function runCode(lang, code, timeoutSeconds, extraEnv) {
  const interp = INTERPRETERS[lang];
  if (!interp) return { stdout: '', stderr: '', exitCode: null, error: `No interpreter for "${lang}"` };
  const tmp = path.join(os.tmpdir(), `course-run-${process.pid}-${Date.now()}.${EXT[lang] || 'sh'}`);
  fs.writeFileSync(tmp, `${code}\n`);
  const r = spawnSync(interp[0], [...interp.slice(1), tmp], {
    cwd, env: Object.assign({}, env, extraEnv), encoding: 'utf8', timeout: timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  fs.unlinkSync(tmp);
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  return {
    stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status,
    error: timedOut ? `Timed out after ${timeoutSeconds} s` : r.error ? r.error.message : null, timedOut,
  };
}

function show(text, stream) {
  const t = normalize(text || '');
  if (!t) return;
  const lines = t.split('\n');
  const shown = lines.length > 40 ? ['…', ...lines.slice(-40)] : lines;
  for (const line of shown) console.log(`${stream === 'stderr' ? '  ! ' : '  | '}${line}`);
}

const NOTE = path.resolve(note);
const STATE = process.env.COURSE_RUN_STATE || path.join(os.tmpdir(), 'course-run-state.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { /* no runs yet */ }
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));

const P = newPlugin();
// Other notes this state has results for, so dependencies on them resolve.
for (const other of new Set(Object.values(state).map((r) => r.note))) {
  if (other !== NOTE && fs.existsSync(other)) P.metasFor(fs.readFileSync(other, 'utf8'), other);
}
const metas = P.metasFor(fs.readFileSync(note, 'utf8'), NOTE).map((e) => e.meta);
for (const [path_, metas_] of P.noteIndex) {
  for (const m of metas_) if (m.id && state[m.id] && state[m.id].note === path_) P.results.set(P.keyFor(path_, m), state[m.id].res);
}
const match = (m, id) => m.id && m.id.startsWith(id.toLowerCase());

// --answer ID CODE: what a learner would type into an editable block.
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--answer') continue;
  const m = metas.find((x) => match(x, args[i + 1]));
  if (!m) { console.error(`--answer: no block ${args[i + 1]} in this note`); process.exit(2); }
  const code = args[i + 2].startsWith('@') ? fs.readFileSync(args[i + 2].slice(1), 'utf8') : args[i + 2];
  P.drafts.set(P.keyFor(NOTE, m), normalize(code));
}

if (flag('reverts')) {
  let failed = 0;
  for (const m of metas.filter((x) => x.revert).reverse()) {
    console.log(`\n=== revert ${m.id.slice(0, 8)} ${blockLabel(m)}`);
    const extra = m.kind === 'file' ? { FILE: path.resolve(cwd, m.path) } : {};
    const r = runCode(m.revert.lang, m.revert.run, m.timeout || 300, extra);
    show(r.stdout); show(r.stderr, 'stderr');
    const ok = !r.error && r.exitCode === 0;
    if (!ok) failed++;
    console.log(ok ? '  -> reverted' : `  -> REVERT FAILED: ${r.error || `exit ${r.exitCode}`}`);
  }
  // Reset also deletes file blocks' files, so the lab is back to before they were written.
  for (const m of metas.filter((x) => x.kind === 'file' && x.path)) {
    const target = path.resolve(cwd, m.path);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  for (const m of metas) if (m.id && state[m.id]) delete state[m.id];
  saveState();
  console.log(`\n${failed ? `${failed} revert(s) failed` : 'all reverts worked'}; file blocks' files deleted`);
  process.exit(failed);
}

let selected = metas.filter((m) => flag('include-manual') || !m.manual);
if (option('only')) selected = selected.filter((m) => option('only').split(',').some((id) => match(m, id)));
if (option('from')) {
  const i = selected.findIndex((m) => match(m, option('from')));
  selected = i >= 0 ? selected.slice(i) : [];
}

const summary = [];
for (const m of selected) {
  console.log(`\n=== ${m.kind} ${m.id ? m.id.slice(0, 8) : '(no id)'} ${blockLabel(m)}`);
  const key = P.keyFor(NOTE, m);
  const code = P.currentCode(key, m);
  // Command prerequisites are run each time, as the plugin does before every run.
  for (const r of m.requires.filter((x) => x.type === 'command')) {
    const c = runCode(r.lang, r.run, r.timeout);
    const passed = !c.error && c.exitCode === 0;
    P.commandChecks.set(P.commandKey(NOTE, r), { done: true, ok: passed, exitCode: c.exitCode, error: c.error });
    if (!passed) {
      console.log(`  command prerequisite failed (${c.error || `exit ${c.exitCode}`}): ${r.run}`);
      show(c.stdout); show(c.stderr, 'stderr');
    }
  }
  const prereqs = P.prerequisiteState(NOTE, m);
  if (prereqs.blocked) {
    for (const w of prereqs.waiting) console.log(`  - ${w.summary}`);
    console.log('  -> BLOCKED');
    summary.push({ m, ok: false, label: 'Blocked' });
    if (!flag('keep-going')) break;
    continue;
  }
  const started = Date.now();
  let res;
  if (m.kind === 'file') {
    const target = path.resolve(cwd, m.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, code ? `${code}\n` : '');
    res = { done: true, content: code, outputHash: md5(code), cmdHash: md5(code), exitCode: 0 };
    if (m.check) {
      const c = runCode(m.check.lang, m.check.run, m.timeout || 30, { FILE: target });
      show(c.stdout); show(c.stderr, 'stderr');
      res.check = { stdout: c.stdout, exitCode: c.exitCode, error: c.error, timedOut: c.timedOut };
    }
  } else {
    const r = runCode(m.lang, code, m.timeout || 30);
    show(r.stdout); show(r.stderr, 'stderr');
    res = { done: true, stdout: r.stdout, exitCode: r.exitCode, error: r.error, timedOut: r.timedOut, outputHash: md5(normalize(r.stdout)), cmdHash: md5(code) };
  }
  const verdict = evaluate(m, res);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const failedItems = verdict.items.filter((i) => !i.ok).map((i) => i.label + (i.detail ? ` (${i.detail})` : ''));
  const ok = verdict.status === 'pass' || verdict.status === 'ok';
  console.log(`  -> ${verdict.label}${failedItems.length ? `: ${failedItems.join(', ')}` : ''} (${secs} s)`);
  if (!ok && m.expect && m.expect.output != null) console.log(`     expected: ${JSON.stringify(m.expect.output)}`);
  summary.push({ m, ok, label: verdict.label });
  P.results.set(key, res);
  if (m.id) { state[m.id] = { note: NOTE, res }; saveState(); }
  if (!ok && !flag('keep-going')) break;
}

console.log('\nSummary:');
for (const { m, ok, label } of summary) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${m.id ? m.id.slice(0, 8) : '--------'} ${label.padEnd(9)} ${blockLabel(m)}`);
const skipped = selected.length - summary.length;
if (skipped) console.log(`  (${skipped} block(s) not run, after the failure)`);
const bad = summary.filter((s) => !s.ok).length;
process.exit(bad);
