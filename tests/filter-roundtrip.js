// Edits blocks as the plugin would, then checks the vault's git clean filter (strip-progress.py) gives
// back each note as the author wrote it. Needs Node, and js-yaml installed for the write-course scripts.
// Usage: node tests/filter-roundtrip.js [path to strip-progress.py]
const { execFileSync } = require('child_process');
const { newPlugin } = require('../.claude/skills/write-course/scripts/plugin.js');
const { withLearner } = require('../main.js');
const FILTER = process.argv[2] || '/Users/pmw/Documents/LearningPath/Learning Path/.gitfilters/strip-progress.py';
const P = newPlugin();
const originals = [
  '# your command here', '', '  indented first\nthen not', 'a\n\nb\n\n\nc', '---', 'x\n---\ny', 'key: value\nother: "q"',
  "it's 'quoted'", '"double"', '\ttab start\n\t\tmore', '- list\n- items', '| pipe\n> gt', 'trailing   \nspaces  ',
  '#!/bin/bash\nset -e\necho "a: b #c"', 'ünïcödé ✓', '   \n  x', '```\nnested fence?\n```'.replace(/```/g, '~~~'),
];
const answers = ['echo answer', 'multi\nline\n  answer', '', '---\nlooks like a separator'];
const wrap = (prefix, body) => ['```run', ...body.split('\n'), '```'].map((l) => (l ? prefix + l : prefix.replace(/[ \t]+$/, ''))).join('\n');
let fails = 0, n = 0;
for (const prefix of ['', '> ', '> > ']) for (const orig of originals) for (const answer of answers) {
  const body = `id: 00000000-0000-4000-8000-000000000001\nlang: bash\neditable: true\n---\n${orig}`;
  const meta = P.makeMeta('run', body);
  if (answer === meta.original) continue;
  let edited = withLearner(meta, body, answer);
  edited = edited.replace('editable: true\n', 'editable: true\nresult:\n  exitCode: 0\n  stdout: |-\n    hi\n');
  const back = P.makeMeta('run', edited);
  const note = `# Note\n\nText.\n\n${wrap(prefix, edited)}\n\nAfter.\n`;
  const want = `# Note\n\nText.\n\n${wrap(prefix, body.replace(/\s+$/, ''))}\n\nAfter.\n`;
  const got = execFileSync('python3', [FILTER], { input: note }).toString();
  n++;
  const problems = [];
  if (back.code !== answer.replace(/\s+$/, '')) problems.push(`plugin reads code ${JSON.stringify(back.code)}`);
  if (back.original !== meta.original) problems.push(`plugin reads original ${JSON.stringify(back.original)}`);
  if (got !== want) problems.push(`filter gave\n${got}\nwanted\n${want}`);
  // Reset: back to the original, and the note is as the author wrote it.
  const reset = withLearner(back, edited, meta.original);
  if (P.makeMeta('run', reset).stored !== null || P.makeMeta('run', reset).code !== meta.original) problems.push('reset left the original in the header');
  if (problems.length) { fails++; console.log(`FAIL prefix=${JSON.stringify(prefix)} orig=${JSON.stringify(orig)} answer=${JSON.stringify(answer)}\n  ${problems.join('\n  ')}`); }
}
console.log(`${n - fails}/${n} round trips ok`);
process.exitCode = fails ? 1 : 0;
