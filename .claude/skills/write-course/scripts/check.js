#!/usr/bin/env node
// Checks course notes the way the plugin reads them: every block parses, has a UUID that's unique
// across the notes, and its dependencies exist (in the same note or another one, and never below it).
// Pass every note of the course, and any notes it depends on, such as a setup page.
//
//   node check.js NOTE...                        report each block, its settings and any problems
//   node check.js NOTE... --patterns ID CODE...   try candidate commands against a block's `matches:`
//                                                 patterns: which ones each would still fail
// Exit status: the number of problems found.
const fs = require('fs');
const path = require('path');
const { indexNotes } = require('./plugin');

const args = process.argv.slice(2);
const p = args.indexOf('--patterns');
const notes = (p >= 0 ? args.slice(0, p) : args).map((n) => path.resolve(n));
const P = indexNotes(notes);

if (p >= 0) {
  const [id, ...codes] = args.slice(p + 1);
  const found = [...P.noteIndex.entries()].flatMap(([note, metas]) => metas.map((m) => ({ note, m }))).find(({ m }) => m.id && m.id.startsWith(id));
  if (!found) { console.error(`No block with id ${id}`); process.exit(2); }
  const { note, m } = found;
  for (const code of codes) {
    P.drafts.set(P.keyFor(note, m), code);
    const failing = P.prerequisiteState(note, m).waiting.filter((w) => w.type === 'matches').map((w) => w.message);
    console.log(`${failing.length ? 'BLOCKED' : 'allowed'}  ${JSON.stringify(code)}`);
    for (const message of failing) console.log(`           - ${message}`);
  }
  process.exit(0);
}

const seen = new Map();
let problems = 0;
const problem = (text) => { problems++; console.log(`    PROBLEM ${text}`); };
for (const note of notes) {
  const metas = P.noteIndex.get(note) || [];
  console.log(`\n${path.basename(note)}: ${metas.length} blocks`);
  for (const m of metas) {
    const first = (m.code.split('\n').find((l) => l.trim()) || '').slice(0, 50);
    const reqs = m.requires.map((r) => r.type).join(',');
    const flags = [m.idempotent ? '' : 'once', m.revert ? 'revert' : '', m.manual ? 'manual' : '', m.editable ? 'editable' : '',
      reqs && `needs[${reqs}]`, m.insteadOf.length ? `instead-of[${m.insteadOf.length}]` : ''].filter(Boolean).join(' ');
    console.log(`  line ${String(m.lineStart + 1).padStart(4)} ${m.kind.padEnd(4)} ${m.id ? m.id.slice(0, 8) : 'NO-ID   '} ${flags.padEnd(36)} ${first}`);
    for (const w of m.warnings) problem(w);
    if (!m.id) problem('no id: give it one with: uuidgen | tr A-Z a-z');
    else if (seen.has(m.id)) problem(`same id as a block in ${path.basename(seen.get(m.id))}`);
    else seen.set(m.id, note);
    for (const r of m.requires.filter((x) => x.type === 'block')) {
      const dep = P.findBlock(r.id, note);
      if (!dep) problem(`depends on ${r.id}, which isn't in any of these notes`);
      else if (dep.path === note && dep.meta.lineStart > m.lineStart) problem(`depends on ${r.id.slice(0, 8)}, which is below it`);
    }
    for (const id of m.insteadOf) {
      const alt = P.findBlock(id, note);
      if (!alt) problem(`instead-of ${id}, which isn't in any of these notes`);
      else if (alt.meta.id === m.id) problem('instead-of names the block itself');
      else if (alt.meta.insteadOf.length) problem(`instead-of ${id.slice(0, 8)}, which is itself an alternative`);
    }
    // `kubectl config` only edits the kubeconfig, so it doesn't need one.
    if (m.revert && /\bkubectl\b(?!\s+config\b)(?![^\n]*--context)/.test(m.revert.run)) problem('revert runs kubectl without --context, so it acts on whatever cluster is current');
  }
}
console.log(`\n${problems} problem(s)`);
process.exit(problems);
