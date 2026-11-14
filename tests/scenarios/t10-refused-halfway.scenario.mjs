// [T-10] PRD 4.0 (2026-10-24): a Claude expert is stopped halfway by its model's safety filter, after it
// has written a file that ends inside a function. The run must still end done, with the takeover's
// result: the changed files listed with their lines, the file finished by a session that has none of the
// expert's history, one takeover in the events. The expert itself carries on in its own session, knows
// what only that session holds, and is told the directory changed; a fresh fork asked the same question
// does not know it. Covers O-6, C-7.
//
// The refused leg is the fake Claude in both modes (no real model refuses on demand), with its own
// CLAUDE_CONFIG_DIR so nothing lands in the machine's ~/.claude. The takeover leg is Codex: the fake
// brain here, the real CLI and model under --real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FAKE_CLAUDE, tempDir } from '../lib/sandbox.mjs';
import { MODE, brief, openScenario, step, t } from './driver.mjs';

const KNOWS = /kestrel=7|kestrel\s*(的值)?\s*(是|为|=|：|:)\s*7/i;

test('[T-10] Stopped halfway and completed by a fresh session', { timeout: 600000 }, async () => {
  const own = tempDir('ssa-t10-');
  const modeFile = path.join(own, 'claude-mode.json');
  const setClaude = (modes) => fs.writeFileSync(modeFile, JSON.stringify(modes));
  setClaude({});
  const sc = await openScenario({
    env: { SPECIALIST_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_MODE_FILE: modeFile, CLAUDE_CONFIG_DIR: path.join(own, 'claude') },
  });
  try {
    const work = sc.workdir({ 'notes.txt': '第一行\n' }, { git: true });
    await sc.setBackend('claude');

    const expert = await step(1, '专家第一单在 Claude 上，会话里记下一个只有它知道的事实', async () => {
      const reply = await sc.dispatch({ role: 'coder', cwd: work, task: '事实：kestrel=7\n问：kestrel' });
      assert.match(await sc.answer(reply), KNOWS, '第一单没记住 kestrel');
      return reply;
    });

    const takenOver = await step(2, '第二单写了半个文件后被拦截，由不带历史的新会话接着做完', async () => {
      setClaude({ main: 'refuse-after-tools' });
      const reply = await sc.dispatch({
        role: 'coder',
        cwd: work,
        task: t(
          '改文件：half.js=export function half() { return 1; }\n问：kestrel',
          'half.js 写到一半停下了。把它补完整：导出函数 half()，返回 1，别的文件不要改。然后回答：kestrel 的值是多少？不知道就直说不知道，不要猜。',
        ),
      });
      assert.equal(reply.seat, expert.seat, `落在了 ${reply.seat}，不是专家 ${expert.seat}`);
      const answer = await sc.answer(reply, MODE === 'real' ? 480000 : 60000);
      assert.match(answer, /Files already changed when stopped/, `结果开头没有改动清单：${brief(answer, 200)}`);
      assert.match(answer, /half\.js \(\+2 -0\)/, `清单里没有 half.js 和它的行数：${brief(answer, 300)}`);
      assert.doesNotMatch(answer, KNOWS, `接手的会话知道旧会话里的事实，说明它带了历史：${brief(answer, 200)}`);
      const half = fs.readFileSync(path.join(work, 'half.js'), 'utf8');
      assert.match(half, /return\s+1/, `half.js 没有补完：${brief(half)}`);
      assert.equal((half.match(/\{/g) ?? []).length, (half.match(/\}/g) ?? []).length, `half.js 的括号不配对：${brief(half)}`);
      const events = (await sc.seat(reply.seat)).events.filter((e) => e.seq > reply.run);
      const takeovers = events.filter((e) => e.kind === 'takeover');
      assert.equal(takeovers.length, 1, `takeover 事件有 ${takeovers.length} 条`);
      assert.match(takeovers[0].body, /Blocked mid-run.*completed by a fresh/, brief(takeovers[0].body, 200));
      if (MODE === 'fake') {
        const handed = sc.brainSince(reply.mark).filter((entry) => entry.phase === 'answer' && entry.kind === 'task');
        const codex = handed.filter((entry) => entry.backend === 'codex');
        assert.equal(codex.length, 1, `codex 接手了 ${codex.length} 次`);
        assert.equal(codex[0].resumed, false, '接手的不是新会话');
        assert.match(codex[0].prompt, /从现场接着做/);
        assert.doesNotMatch(codex[0].prompt, /kestrel=7/, '接手的提示里有旧会话的内容');
      }
      return reply;
    });

    await step(3, '专家下一单仍续自己的会话：答得出那个事实，也知道目录变了', async () => {
      setClaude({});
      const reply = await sc.dispatch({ role: 'coder', cwd: work, task: '问：kestrel\n问目录变化' });
      assert.equal(reply.seat, expert.seat);
      const answer = await sc.answer(reply);
      assert.match(answer, KNOWS, `专家答不出自己会话里的事实：${brief(answer, 200)}`);
      assert.match(answer, /half\.js/, `专家没被告知 half.js 变了：${brief(answer, 200)}`);
      return takenOver;
    });

    await step(4, '不带上下文的分身问同一个事实答不出，专家还是原来那个', async () => {
      const reply = await sc.dispatch({ role: 'coder', cwd: work, fork: 'fresh', task: '问：kestrel' });
      assert.notEqual(reply.seat, expert.seat, '没有开分身');
      assert.equal(reply.fresh, true, `回复里没说是不带上下文的分身：${brief(reply.note, 160)}`);
      const answer = await sc.answer(reply);
      assert.doesNotMatch(answer, KNOWS, `不带上下文的分身知道专家的事实：${brief(answer, 200)}`);
      const rows = await sc.seats({ role: 'coder' });
      assert.deepEqual(rows.filter((row) => row.cwd && path.resolve(row.cwd) === path.resolve(work)).map((row) => row.seat), [expert.seat], '名录里这个目录的专家不止原来那位');
    });
  } finally {
    await sc.setBackend('best').catch(() => {});
    await sc.close();
    fs.rmSync(own, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
