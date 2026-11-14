// [T-6] PRD 4.0: the first run of an expert goes to backend one, the next is forced to backend two and
// asked about what the first read. The second must answer, with the first run's record in its prompt or
// in the files it was pointed to. Covers C-1, C-5.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODE, brief, openScenario, step, t } from './driver.mjs';

test('[T-6] Switching backends on failure', { timeout: 180000 }, async () => {
  const sc = await openScenario();
  try {
    const work = sc.workdir({ 'f1.txt': '事实：zeta=6\n' });

    const run1 = await step(1, '第一单在默认后端（Codex）读 f1.txt', async () => {
      const reply = await sc.dispatch({ role: 'coder', cwd: work, task: t('读文件：f1.txt', '读 f1.txt，记住里面写的事实。') });
      await sc.answer(reply);
      if (MODE === 'fake') {
        const [entry] = sc.brainOf(reply);
        assert.ok(entry, '没有找到这一单的脑子日志');
        assert.equal(entry.backend, 'codex', `第一单用的后端是 ${entry.backend}，不是 codex`);
      }
      return reply;
    });

    try {
      await step(2, '把后端改成 deepseek', async () => {
        await sc.setBackend('deepseek');
      });

      await step(3, '第二单用另一个后端，答得出第一单读到的 zeta，不联网，带着第一单的记录', async () => {
        const reply = await sc.dispatch({ role: 'coder', cwd: work, task: t('问：zeta', 'f1.txt 里的 zeta 是多少？凭你记得的回答，不要再读 f1.txt，说明出处。') });
        assert.equal(reply.seat, run1.seat, `落在了 ${reply.seat}，不是第一单的 ${run1.seat}`);
        const answer = await sc.answer(reply);
        assert.match(answer, MODE === 'fake' ? /zeta=6/ : /\b6\b/, `答不出第一单读到的 zeta：${brief(answer, 160)}`);
        assert.equal((await sc.webOf(reply)).length, 0, '去联网了');
        if (MODE === 'fake') {
          const [entry] = sc.brainOf(reply);
          assert.ok(entry, '没有找到这一单的脑子日志');
          assert.equal(entry.backend, 'pi', `第二单用的后端是 ${entry.backend}，不是 pi`);
          // Its context carried the first run's record: the text itself, or a record path that it read
          // (this run read no file of its own).
          const readRecord = entry.tools.some((tool) => tool.tool === 'read');
          assert.ok(entry.prompt.includes('zeta=6') || readRecord, '第二单的任务前缀里既没有第一单的记录，也没有指向记录的路径');
        }
      });
    } finally {
      await sc.setBackend('best').catch(() => {});
    }
  } finally {
    await sc.close();
  }
});
