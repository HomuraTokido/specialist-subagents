// [T-5] PRD 4.0: cancel one run of an expert with task_cancel: the process tree is gone, a `cancelled`
// event is recorded, the expert stays on the roster and the next run continues from what it knew.
// Covers L-5, L-2, E-6.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODE, brief, openScenario, step, t } from './driver.mjs';

// EPERM means the process exists and is somebody else's: alive.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

test('[T-5] Cancelling one run keeps the expert', { timeout: 180000 }, async () => {
  const sc = await openScenario();
  try {
    const work = sc.workdir({ 'f1.txt': '事实：alpha=1\n' });

    const run0 = await step(1, '第 0 单：专家读 f1.txt，记住 alpha', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: work, task: t('读文件：f1.txt', '读 f1.txt，记住里面写的事实。') });
      await sc.answer(reply);
      return reply;
    });

    const run1 = await step(2, '第 1 单：慢单开跑，等它的进程出现', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: work, task: t('慢：30000', '运行命令 sleep 60，然后说"做完了"。') });
      assert.equal(reply.seat, run0.seat, `第 1 单落在了 ${reply.seat}，不是 ${run0.seat}`);
      if (MODE !== 'fake') {
        await sc.sleep(5000);
        return { ...reply, pids: [] };
      }
      const slow = await sc.until(() => sc.brainSince(reply.mark).find((entry) => entry.phase === 'slow'), '慢单的进程开跑', 30000);
      return { ...reply, pids: [slow.pid, slow.grandchild] };
    });

    await step(3, 'task_cancel 取消这一单', async () => {
      await sc.tool('task_cancel', { seat: run1.seat, reason: '不用了' });
    });

    await step(4, '十秒内这一单的整棵进程树没了，座位里记了 cancelled', async () => {
      if (run1.pids.length) {
        await sc.until(() => run1.pids.every((pid) => !alive(pid)), `进程 ${run1.pids.join('、')} 消失`, 10000);
      }
      await sc.waitRun(run1, 15000);
      const shown = await sc.seat(run1.seat);
      assert.ok((shown.events ?? []).some((event) => event.kind === 'cancelled'), `座位里没有 cancelled 事件（事件种类：${[...new Set((shown.events ?? []).map((e) => e.kind))].join('、')}）`);
    });

    await step(5, '专家还在名录里，没有被关掉', async () => {
      const rows = (await sc.seats({ cwd: work })).filter((row) => row.role === 'explorer');
      const row = rows.find((r) => r.seat === run0.seat);
      assert.ok(row, `名录里没有专家 ${run0.seat}（现有：${rows.map((r) => r.seat).join('、') || '无'}）`);
      assert.notEqual(row.state, 'closed', '专家被关了');
      const shown = await sc.seat(run0.seat);
      assert.notEqual(shown.seat.state, 'closed', `专家的状态是 ${shown.seat.state}`);
    });

    await step(6, '再派一单：落在同一个专家上，接着它此前的理解，答得出 alpha，不联网', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: work, task: t('问：alpha', 'f1.txt 里的 alpha 是多少？凭你记得的回答，不要再读文件，说明出处。') });
      assert.equal(reply.seat, run0.seat, `落在了 ${reply.seat}，不是 ${run0.seat}`);
      const answer = await sc.answer(reply);
      assert.match(answer, MODE === 'fake' ? /alpha=1/ : /\b1\b/, `答不出 alpha：${brief(answer, 160)}`);
      assert.equal((await sc.webOf(reply)).length, 0, '去联网了');
    });
  } finally {
    await sc.close();
  }
});
