// [T-8] PRD 4.0: the skill loop end to end. A role's runs pile up difficulties; the service has the
// refiner write a candidate; the lead reviews and enables it; the role's next run carries the new skill
// (the run's events name the version). Handyman piles up difficulties too and never gets a refiner.
// Covers S-1, S-2, S-3.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brief, openScenario, step, t } from './driver.mjs';

// Two failing commands per run, different in every run so none of them is a retry of another.
const failing = (tag, i) => t(
  `出错：npm run build-${tag}${i}-a\n出错：npm run build-${tag}${i}-b`,
  `依次运行 npm run build-${tag}${i}-a 和 npm run build-${tag}${i}-b。它们会失败，不用修，如实说明结果。`,
);

test('[T-8] Skill learning loop', { timeout: 180000 }, async () => {
  const sc = await openScenario({ refiner: true });
  try {
    const coderDir = sc.workdir({ 'README.md': '# demo\n' });
    const handymanDir = sc.workdir({ 'README.md': '# chores\n' });

    await step(1, 'coder 连跑三单，每单两条失败的命令', async () => {
      assert.equal(sc.sql("SELECT COUNT(*) AS n FROM skill_versions WHERE role = 'coder'")[0].n, 0, '开始时 HSkills 里不是空的');
      for (let i = 1; i <= 3; i += 1) {
        const reply = await sc.dispatch({ role: 'coder', cwd: coderDir, task: failing('c', i) });
        await sc.waitRun(reply);
      }
    });

    const candidate = await step(2, '30 秒内服务派 refiner，coder 出现一份候选', async () => {
      const row = await sc.until(() => sc.sql('SELECT * FROM candidates WHERE role = ?', 'coder')[0], 'coder 的候选', 30000, 200);
      assert.equal(row.state, 'pending', `候选的状态是 ${row.state}，不是 pending`);
      return row;
    });

    const version = await step(3, '组长审核启用：每条困难都判 real，decision enable', async () => {
      const ids = JSON.parse(candidate.difficulty_ids);
      assert.ok(ids.length > 0, '候选里没有困难编号');
      await sc.tool('candidate_decide', { id: candidate.id, verdicts: ids.map((difficulty) => ({ difficulty, verdict: 'real' })), decision: 'enable' });
      const rows = sc.sql("SELECT version FROM skill_versions WHERE role = 'coder' ORDER BY version DESC");
      assert.ok(rows.length > 0, '启用之后 skill_versions 里没有 coder 的版本');
      return Number(rows[0].version);
    });

    await step(4, 'coder 下一单开工时带的是新 skill，事件里记了版本', async () => {
      const reply = await sc.dispatch({ role: 'coder', cwd: coderDir, task: t('读文件：README.md', '读 README.md，一句话说它写了什么。') });
      await sc.waitRun(reply);
      const shown = await sc.seat(reply.seat);
      const skill = (shown.events ?? []).filter((event) => event.kind === 'skill').at(-1)?.body ?? '';
      assert.match(skill, new RegExp(`\\bv${version}\\b`), `skill 事件没有提到启用的第 ${version} 版：${brief(skill, 160)}`);
    });

    await step(5, 'handyman 也连跑三单、每单两条失败：困难记下了，但不派 refiner、没有候选', async () => {
      for (let i = 1; i <= 3; i += 1) {
        const reply = await sc.dispatch({ role: 'handyman', cwd: handymanDir, task: failing('h', i) });
        await sc.waitRun(reply);
      }
      await sc.sleep(3000);
      const recorded = sc.sql("SELECT COUNT(*) AS n FROM difficulties WHERE role = 'handyman'")[0].n;
      assert.ok(recorded >= 5, `handyman 只记下 ${recorded} 条困难，不够 5 条，"没派 refiner"证明不了什么`);
      assert.equal(sc.sql("SELECT COUNT(*) AS n FROM candidate_runs WHERE role = 'handyman'")[0].n, 0, '为 handyman 派了 refiner');
      assert.equal(sc.sql("SELECT COUNT(*) AS n FROM candidates WHERE role = 'handyman'")[0].n, 0, 'handyman 有了候选');
    });
  } finally {
    await sc.close();
  }
});
