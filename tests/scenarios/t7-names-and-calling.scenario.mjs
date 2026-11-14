// [T-7] PRD 4.0: an object nobody has touched gets a new expert with a meaningful name; the lead renames
// it and calls it by seat id. The reply says who took the task and that it is new; the roster shows the
// new name; the call by seat lands on the same expert. Covers E-1, E-2, E-3, E-5, E-6.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brief, openScenario, step, t } from './driver.mjs';

test('[T-7] Naming and addressing a new expert', { timeout: 180000 }, async () => {
  const sc = await openScenario();
  try {
    const work = sc.workdir({ 'README.md': '# config loader\n' }, { name: 'config-loader' });
    const NEW_NAME = 'explorer · 配置加载';

    const first = await step(1, '派给没碰过的目录：新开专家，回复说清是谁、是新开的，名字里没有座位号', async () => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: work, task: t('问：nothing', '这个目录里有什么？一句话回答。') });
      assert.equal(reply.reused, false, 'reused 不是 false');
      assert.ok(reply.name, '回复里没有专家的名字');
      assert.ok(String(reply.note).includes(reply.name), `note 没有点出专家的名字「${reply.name}」：${brief(reply.note, 160)}`);
      assert.match(String(reply.note), /new expert|first visit/i, `note 没说这是新开的专家：${brief(reply.note, 160)}`);
      assert.ok(!reply.name.includes(reply.seat) && !/seat-/.test(reply.name), `名字里带着座位号：${reply.name}`);
      await sc.answer(reply);
      return reply;
    });

    await step(2, 'seat_rename 改成语义名，名录里只有新名字', async () => {
      await sc.tool('seat_rename', { seat: first.seat, name: NEW_NAME });
      const rows = await sc.seats();
      const row = rows.find((r) => r.seat === first.seat);
      assert.ok(row, '名录里找不到这个专家');
      assert.equal(row.name, NEW_NAME, `名录里的名字是「${row.name}」`);
      assert.equal(rows.some((r) => r.name === first.name), false, `旧名「${first.name}」还在名录里`);
    });

    await step(3, '按座位号点名再派一单：落在同一个专家上，note 里是新名字', async () => {
      const reply = await sc.dispatch({ role: 'explorer', seat: first.seat, task: t('问：nothing', '这个目录里有什么？一句话回答。') });
      assert.equal(reply.seat, first.seat, `点名却落在了 ${reply.seat}`);
      assert.equal(reply.reused, true, 'reused 不是 true');
      assert.ok(String(reply.note).includes(NEW_NAME), `note 里没有新名字「${NEW_NAME}」：${brief(reply.note, 160)}`);
      await sc.answer(reply);
    });
  } finally {
    await sc.close();
  }
});
