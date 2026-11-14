// [T-4] PRD 4.0: expert A learns a fact only it knows; A is merged into B; a run handed to B can answer
// it, A is archived and gone from the roster, and the run after that carries no hand-off any more.
// Covers L-1, L-2, E-2, E-6.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODE, brief, openScenario, step, t } from './driver.mjs';

test('[T-4][L-1][L-2] Merging duplicate experts', { timeout: 180000 }, async () => {
  const sc = await openScenario();
  try {
    const dirX = sc.workdir({ 'secret.txt': '事实：delta=4\n' });
    const dirY = sc.workdir({ 'other.txt': '事实：eps=5\n' });

    const a = await step(1, '专家 A 在目录 X 读到只有它知道的事实 delta', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: dirX, task: t('读文件：secret.txt', '读 secret.txt，记住里面写的事实。') });
      await sc.answer(reply);
      return reply;
    });
    const b = await step(2, '专家 B 在目录 Y 读到自己的事实 eps', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: dirY, task: t('读文件：other.txt', '读 other.txt，记住里面写的事实。') });
      await sc.answer(reply);
      assert.notEqual(reply.seat, a.seat, 'A 和 B 是同一个座位，没法合并');
      return reply;
    });

    await step(3, 'seat_merge：A 并入 B', async () => {
      await sc.tool('seat_merge', { from: a.seat, into: b.seat });
    });

    await step(4, '点名派给 B：答得出 A 才知道的 delta，不联网，任务前面附了交接', async () => {
      const reply = await sc.dispatch({ role: 'explorer', seat: b.seat, task: t('问：delta', '读 secret.txt 里的 delta 是多少？凭你现在知道的回答，说明出处。') });
      assert.equal(reply.seat, b.seat, `点名 B 却落在了 ${reply.seat}`);
      const answer = await sc.answer(reply);
      assert.match(answer, MODE === 'fake' ? /delta=4/ : /\b4\b/, `B 答不出 A 的事实：${brief(answer, 160)}`);
      assert.equal((await sc.webOf(reply)).length, 0, 'B 去联网了');
      if (MODE === 'fake') {
        const [entry] = sc.brainOf(reply);
        assert.ok(entry, '没有找到这一单的脑子日志');
        assert.match(entry.prompt, /交接/, '这一单的任务前面没有附交接');
      }
    });

    await step(5, 'A 已归档（并入），不在名录里', async () => {
      const rows = await sc.seats();
      assert.equal(rows.some((row) => row.seat === a.seat), false, 'A 还在名录里');
      const shown = await sc.seat(a.seat);
      assert.equal(shown.seat.state, 'closed', `A 的状态是 ${shown.seat.state}，不是 closed`);
      const close = (shown.events ?? []).filter((event) => event.kind === 'close').map((event) => String(event.body ?? ''));
      assert.ok(close.some((body) => body.includes('Merged into')), `A 没有写明「Merged into」的 close 事件：${brief(close.join('｜') || '没有 close 事件')}`);
    });

    await step(6, '再下一单派给 B：不再附交接', async () => {
      const reply = await sc.dispatch({ role: 'explorer', seat: b.seat, task: t('问：eps', 'other.txt 里的 eps 是多少？凭你记得的回答。') });
      assert.equal(reply.seat, b.seat);
      const answer = await sc.answer(reply);
      assert.match(answer, MODE === 'fake' ? /eps=5/ : /\b5\b/, `B 答不出自己的事实：${brief(answer, 160)}`);
      if (MODE === 'fake') {
        const [entry] = sc.brainOf(reply);
        assert.ok(entry, '没有找到这一单的脑子日志');
        // The hand-off is attached once. The word alone could also come from a standing line about where
        // records are kept, so the body of the hand-off is what must be gone.
        assert.doesNotMatch(entry.prompt, /## 懂了什么/, '交接正文又附了一遍');
        assert.doesNotMatch(entry.prompt, /事实：delta=4/, '交接里的事实又附了一遍');
      }
    });
  } finally {
    await sc.close();
  }
});
