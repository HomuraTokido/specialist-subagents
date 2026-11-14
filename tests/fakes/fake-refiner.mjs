// A stand-in for the refiner's runtime. Like the real one it runs in the scratch directory the service
// made for the batch, reads evidence.md (and current.md when the role already has a skill) and writes
// SKILL.md and why.md there. What it writes is decided by the file named in $FAKE_REFINER_MODE_FILE,
// read on every run so a test can change it between runs:
//   ok        (default) a valid candidate: the current text plus one added line, a section per difficulty
//   nowrite   finish without writing any file
//   bad       write a SKILL.md with no frontmatter
//   desc      write a SKILL.md whose description has angle brackets (HSkills' lint refuses that)
//   fail      write a result file that only says {error} and exit 1
//   same      judge that no change is needed: SKILL.md is current.md unchanged, why.md says why per class
import fs from 'node:fs';
import path from 'node:path';

const modeFile = process.env.FAKE_REFINER_MODE_FILE;
let mode = 'ok';
try {
  if (modeFile) mode = fs.readFileSync(modeFile, 'utf8').trim() || 'ok';
} catch {
  mode = 'ok';
}

const result = (extra = {}) => fs.writeFileSync(process.env.SPECIALIST_SEAT_RESULT, JSON.stringify({
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
  model: 'fake/fake-refiner',
  difficulties: [],
  ...extra,
}));

if (mode === 'fail') {
  result({ error: 'boom (fake refiner)' });
  process.exit(1);
}

const dir = process.cwd();
const evidence = fs.readFileSync(path.join(dir, 'evidence.md'), 'utf8');
const name = /^skill 名：(.+)$/m.exec(evidence)?.[1]?.trim() ?? 'h-unknown';
const ids = [...evidence.matchAll(/^## #(\d+)/gm)].map((m) => m[1]);
let current = null;
try {
  current = fs.readFileSync(path.join(dir, 'current.md'), 'utf8');
} catch {
  current = null;
}

if (mode === 'ok') {
  const body = current === null
    ? `---\nname: ${name}\ndescription: written by the fake refiner\n---\n\n# ${name}\n\nFirst version, from ${ids.length} difficulties.\n`
    : `${current.trimEnd()}\n\n- added by the fake refiner for ${ids.map((id) => `#${id}`).join(' ')}\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  fs.writeFileSync(path.join(dir, 'why.md'), ids.map((id) => `## #${id}\n\nAdded a line for this one.\n`).join('\n'));
} else if (mode === 'desc') {
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "Use the <role> post for things"\n---\n\n# ${name}\n`);
  fs.writeFileSync(path.join(dir, 'why.md'), ids.map((id) => `## #${id}\n\nx\n`).join('\n'));
} else if (mode === 'same') {
  fs.writeFileSync(path.join(dir, 'SKILL.md'), current ?? '');
  fs.writeFileSync(path.join(dir, 'why.md'), ids.map((id) => `## #${id}\n\n没有改动：not the post's craft.\n`).join('\n'));
} else if (mode === 'bad') {
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'no frontmatter here\n');
  fs.writeFileSync(path.join(dir, 'why.md'), ids.map((id) => `## #${id}\n\nx\n`).join('\n'));
}
process.stdout.write(`fake refiner (${mode}) wrote ${ids.length} sections\n`);
result();
process.exit(0);
