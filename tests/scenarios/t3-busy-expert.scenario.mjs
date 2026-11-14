// [T-3] PRD 4.0: an expert is busy with a slow run and a second run is handed to it at the same time.
// The second one returns at once, starts with the expert's records, and both runs end up under one
// expert whose next run sees both. Covers C-3, O-1, O-3, C-5.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODE, brief, openScenario, step, t } from './driver.mjs';

test('[T-3] Second task while the expert is busy', { timeout: 180000 }, async () => {
  const sc = await openScenario();
  try {
    const work = sc.workdir({ 'f1.txt': '事实：alpha=1\n', 'f2.txt': '事实：beta=2\n', 'f3.txt': '事实：gamma=3\n' });

    const run0 = await step(1, '第 0 单：专家读 f1.txt，记住 alpha', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: work, task: t('读文件：f1.txt', '读 f1.txt，记住里面写的事实。') });
      await sc.answer(reply);
      return reply;
    });

    const run1 = await step(2, '第 1 单：让专家忙起来（慢），先不等', async () => {
      const reply = await sc.dispatch({
        role: 'explorer', cwd: work,
        task: t('慢：5000\n读文件：f2.txt', '先运行命令 sleep 8，然后读 f2.txt，记住里面写的事实。'),
      });
      assert.equal(reply.seat, run0.seat, `第 1 单落在了 ${reply.seat}，不是第 0 单的 ${run0.seat}`);
      const state = await sc.service.call('GET', `/run?seat=${reply.seat}&run=${reply.run}`);
      assert.equal(state.json?.run?.ended, false, '第 1 单已经结束了，专家没有处在忙的状态，场景没有意义');
      return reply;
    });

    const run2 = await step(3, '第 2 单：专家正忙时再派一单，立刻拿到返回', async () => {
      const reply = await sc.dispatch({
        role: 'explorer', cwd: work,
        task: t('读文件：f3.txt\n问：alpha', '读 f3.txt，记住里面写的事实；然后回答 f1.txt 里 alpha 是多少——凭你记得的回答，不要再读 f1.txt，说明出处。'),
      });
      assert.ok(reply.elapsedMs < 3000, `第 2 单花了 ${reply.elapsedMs} 毫秒才返回（应当立刻返回）`);
      return reply;
    });

    await step(4, '第 2 单带着专家的记录开工，答得出 alpha，不联网', async () => {
      const answer = await sc.answer(run2);
      assert.match(answer, MODE === 'fake' ? /alpha=1/ : /\b1\b/, `第 2 单答不出专家此前读到的 alpha：${brief(answer, 160)}`);
      const web = await sc.webOf(run2);
      assert.equal(web.length, 0, `第 2 单去联网了：${brief(JSON.stringify(web))}`);
    });

    await step(5, '两单跑完，这个目录名录里只有一个 explorer，就是第 0 单的专家', async () => {
      await sc.waitRun(run1);
      await sc.waitRun(run2);
      const rows = (await sc.seats({ cwd: work })).filter((row) => row.role === 'explorer');
      assert.equal(rows.length, 1, `名录里有 ${rows.length} 个 explorer（分身不该是第二个专家）：${rows.map((r) => r.seat).join('、')}`);
      assert.equal(rows[0].seat, run0.seat, `名录里的专家是 ${rows[0].seat}，不是第 0 单的 ${run0.seat}`);
    });

    await step(6, '第 3 单看得到前两单的记录：beta 和 gamma 都答得出，不联网', async () => {
      const reply = await sc.dispatch({
        role: 'explorer', cwd: work,
        task: t('问：beta\n问：gamma', 'f2.txt 里的 beta 和 f3.txt 里的 gamma 各是多少？凭你记得的回答，不要再读文件，说明出处。'),
      });
      assert.equal(reply.seat, run0.seat, `第 3 单落在了 ${reply.seat}，不是 ${run0.seat}`);
      const answer = await sc.answer(reply);
      assert.match(answer, MODE === 'fake' ? /beta=2/ : /\b2\b/, `答不出 beta：${brief(answer, 160)}`);
      assert.match(answer, MODE === 'fake' ? /gamma=3/ : /\b3\b/, `答不出 gamma：${brief(answer, 160)}`);
      const web = await sc.webOf(reply);
      assert.equal(web.length, 0, `第 3 单去联网了：${brief(JSON.stringify(web))}`);
    });
  } finally {
    await sc.close();
  }
});
