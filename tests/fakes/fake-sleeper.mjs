// A stand-in runtime for seat lifecycle tests: it takes as long as the task says, and it has a
// grandchild, like a real runner whose tool call starts its own process. The mode is the last part
// of the task text after "任务：" (a returning seat's task carries notes in front of it):
//   hang                       start a grandchild, write both pids to $FAKE_SLEEPER_PIDS, never finish
//   finish-after:<ms>[:<backlog>]   print "before", wait, print "after", write the result file, exit 0
//   write-file:<name>          create <name> in the working directory, then finish like finish-after:10
//   fail-error                 write a result file that only says {error}, exit 1 (a runner that died early)
// The result file is what a real runner leaves: tokens, expertise, backlog and a session file.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
// The daemon hands the task either as text (-p) or as a file path (--task-file), whichever keeps
// the spawn command inside the platform's command-line limit (exec.mjs, overBudget).
const taskFileAt = args.indexOf('--task-file');
const task = taskFileAt === -1
  ? String(args[args.indexOf('-p') + 1] ?? '')
  : fs.readFileSync(args[taskFileAt + 1], 'utf8');
const mode = task.split('任务：\n').pop().trim();

const say = (line) => process.stdout.write(`${line}\n`);

if (mode === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  if (process.env.FAKE_SLEEPER_PIDS) {
    fs.writeFileSync(process.env.FAKE_SLEEPER_PIDS, JSON.stringify({ runner: process.pid, grandchild: grandchild.pid }));
  }
  say('hanging');
  setInterval(() => {}, 1000);
} else if (mode === 'fail-error') {
  fs.writeFileSync(process.env.SPECIALIST_SEAT_RESULT, JSON.stringify({ error: 'boom (fake sleeper)' }));
  process.exit(1);
} else if (mode.startsWith('finish-after:') || mode.startsWith('write-file:')) {
  if (mode.startsWith('write-file:')) fs.writeFileSync(path.join(process.cwd(), mode.slice('write-file:'.length)), 'written by the fake sleeper\n');
  const [, ms, ...backlog] = mode.startsWith('write-file:') ? ['', '10'] : mode.split(':');
  say('before');
  setTimeout(() => {
    say('after');
    let sessionFile;
    if (process.env.SPECIALIST_SEAT_SESSION_DIR) {
      sessionFile = path.join(process.env.SPECIALIST_SEAT_SESSION_DIR, 'session.jsonl');
      fs.writeFileSync(sessionFile, '{}\n');
    }
    fs.writeFileSync(process.env.SPECIALIST_SEAT_RESULT, JSON.stringify({
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
      expertise: 'fake-sleeper knows this directory',
      backlog: backlog.join(':'),
      model: 'fake/fake-sleeper',
      sessionFile,
      difficulties: [],
    }));
    process.exit(0);
  }, Number(ms));
} else {
  say(`fake-sleeper: unknown mode "${mode}"`);
  process.exit(2);
}
