// [T-1] PRD 4.0: ask a domain expert a factual question; in another MCP session ask the same question.
// The second run must not go to the web or Hwiki, and must say it comes from the earlier run, with the
// date it was checked. Covers E-2, E-3, E-4, C-1, B-1, O-1, O-5.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODE, brief, openScenario, step, t } from './driver.mjs';

test('[T-1] Asking the same question twice reuses the expert', { timeout: 180000 }, async () => {
  const sc = await openScenario();
  try {
    sc.world({ 'mcp-spec': '2026-06-18' });
    const task = t('问：mcp-spec', 'MCP 规范最新一版是哪天发布的？请查证，说明出处和查证日期。');
    // A real model cannot be made to say one exact string, so it only has to produce a date.
    const VALUE = MODE === 'fake' ? /mcp-spec=2026-06-18/ : /20\d\d/;
    const again = MODE === 'fake' ? /出自上一单/ : /上一单|上次|之前|前面|已有|记录/;

    const first = await step(1, '甲会话问领域专家一个事实，它去联网查', async () => {
      const reply = await sc.dispatch({ role: 'web_researcher', domain: 'agent-infra', task });
      const answer = await sc.answer(reply);
      assert.match(answer, VALUE, `回答里没有查到的值：${brief(answer)}`);
      const web = await sc.webOf(reply);
      assert.ok(web.length > 0, '第一次没有联网，后面"第二次不联网"就什么也证明不了');
      return reply;
    });

    await step(2, '换一个 MCP 会话问同一个问题，落在同一个专家上，不联网，注明出自上一单和查证日期', async () => {
      const other = sc.client();
      const reply = await sc.dispatch({ role: 'web_researcher', domain: 'agent-infra', task, client: other });
      assert.equal(reply.seat, first.seat, `落在了另一个座位 ${reply.seat}，不是第一次的 ${first.seat}`);
      assert.equal(reply.reused, true, 'reused 不是 true：服务没认出这是回来的专家');
      const answer = await sc.answer(reply);
      assert.match(answer, VALUE, `回答里没有值：${brief(answer)}`);
      assert.match(answer, again, `回答没有注明出自上一单：${brief(answer)}`);
      assert.match(answer, /查证/, `回答没有带查证日期：${brief(answer)}`);
      const web = await sc.webOf(reply);
      assert.equal(web.length, 0, `第二次又联网了：${brief(JSON.stringify(web))}`);
    });
  } finally {
    await sc.close();
  }
});
