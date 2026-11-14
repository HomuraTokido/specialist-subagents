// [T-9] PRD 4.0: a closing list belongs only to the original user task.  Ordinary hello and a
// remembered-codeword exchange leave no invented work behind; one explicit missing input remains
// through an unrelated hello, then disappears only once that input is supplied and the work finishes.
// Covers O-5.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODE, brief, openScenario, step, t } from './driver.mjs';

test('[T-9] Handoff keeps only genuinely unfinished work', { timeout: 180000 }, async () => {
  const sc = await openScenario();
  try {
    const work = sc.workdir({ 'README.md': '# task scope\n' });
    const run = async (task) => {
      const reply = await sc.dispatch({ role: 'explorer', cwd: work, task });
      const answer = await sc.answer(reply);
      return { reply, answer, shown: await sc.seat(reply.seat) };
    };

    await step(1, 'hello 和暗号任务完成后没有服务路径或岗位职责混进待办', async () => {
      const hello = await run(t('hello', '只回复“你好”。不要检查记录路径，不要执行任何额外岗位动作。'));
      assert.equal(hello.shown.seat.backlog, null, `hello 留下了待办：${brief(hello.shown.seat.backlog)}`);
      const codeword = await run(t('事实：scope-code=青鸟', '记住暗号“青鸟”，本单只回复“记住了”。不要读取记录路径，不要做岗位常规动作，也不要编造后续工作。'));
      assert.equal(codeword.reply.seat, hello.reply.seat, '暗号没有交给同一个专家');
      assert.equal(codeword.shown.seat.backlog, null, `暗号任务留下了待办：${brief(codeword.shown.seat.backlog)}`);
      const recalled = await run(t('问：scope-code', '刚才的暗号是什么？只输出暗号，不调用工具。'));
      assert.equal(recalled.reply.seat, hello.reply.seat, '回忆暗号没有续接同一个专家');
      assert.match(recalled.answer, /青鸟/, `续接丢失了暗号：${brief(recalled.answer)}`);
      assert.equal(recalled.shown.seat.backlog, null, `回忆暗号留下了待办：${brief(recalled.shown.seat.backlog)}`);
    });

    const blocked = await step(2, '一个明确的计算要求因缺输入 B 没完成，才留下这一项', async () => {
      const got = await run(t('缺输入：B 的数值', '计算 7 + B，给出数值结果，但用户尚未提供 B。不要猜测输入，也不联网或读文件；如实说明缺少 B，计算尚未完成。'));
      assert.match(got.shown.seat.backlog ?? '', /B/, `没有留下真正缺输入的工作：${brief(got.shown.seat.backlog)}`);
      return got;
    });

    await step(3, '无关 hello 不自动执行也不清空这项历史工作', async () => {
      const got = await run(t('hello', '只回复“你好”。不要处理之前未完成的计算，也不要执行额外工作。'));
      assert.equal(got.reply.seat, blocked.reply.seat, '无关 hello 没有回到同一个专家');
      assert.match(got.shown.seat.backlog ?? '', /B/, `无关 hello 清掉了真实旧待办：${brief(got.shown.seat.backlog)}`);
    });

    await step(4, '补齐输入并完成原要求后，清单才清空', async () => {
      const got = await run(t('补输入：B=3', '现在 B = 3，请完成之前的 7 + B，只输出数值结果，不调用工具。'));
      if (MODE !== 'fake') assert.match(got.answer.trim(), /^10$/, `没有完成明确的计算：${brief(got.answer)}`);
      assert.equal(got.shown.seat.backlog, null, `补齐并完成后仍有待办：${brief(got.shown.seat.backlog)}`);
    });
  } finally {
    await sc.close();
  }
});
