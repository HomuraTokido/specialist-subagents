import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LIST_PRICES, equivalentCost, isOffPeak, offPeakCost, priceFactor } from '../src/pricing.mjs';
import { CLOSING_PROMPT, closingPromptFor, splitClosing } from '../src/closing.mjs';

await describe('pricing', { concurrency: false }, async () => {
// pricing.mjs: equivalentCost is what makes a subscription run comparable with a pay-per-token one,
// and the off-peak factor is what turns the runtime's peak-price cost into what DeepSeek billed.
// A wrong number here is not an error anywhere, it is a wrong dollar figure in the cost report.




const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const MILLION = { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 };

describe('equivalentCost', () => {
  it('prices a model with a cache-write price: input + cache read + cache write + output', () => {
    // claude-sonnet-5-5: $2 in, $0.2 cached, $10 out, $4 cache write per million.
    close(equivalentCost('claude-sonnet-5-5', MILLION), 2 + 0.2 + 4 + 10);
    close(equivalentCost('claude-sonnet-5-5', { cacheWrite: 500000 }), 2);
  });

  it('bills cache writes at the input price for a model that lists no cache-write price', () => {
    close(equivalentCost('gpt-5.6-terra', { cacheWrite: 1e6 }), 2);
    close(equivalentCost('gpt-5.6-terra', MILLION), 2 + 0.2 + 2 + 12);
  });

  it('is per million tokens', () => {
    close(equivalentCost('gpt-5.6-terra', { input: 1000, cacheRead: 200, output: 50 }), (2000 + 40 + 600) / 1e6);
  });

  it('returns null, not 0, for a model with no list price', () => {
    assert.equal(equivalentCost('deepseek-flash', MILLION), null);
    assert.equal(equivalentCost('claude-sonnet-9', MILLION), null);
    assert.equal(equivalentCost(undefined), null);
  });

  it('returns 0 (not null) for a priced model that used nothing', () => {
    assert.equal(equivalentCost('gpt-5.6-terra'), 0);
    assert.equal(equivalentCost('grok-4.7', {}), 0);
  });

  it('every listed model has three prices, or four with a cache-write price', () => {
    for (const [model, price] of Object.entries(LIST_PRICES)) {
      assert.ok(price.length === 3 || price.length === 4, model);
      assert.ok(price.every((p) => typeof p === 'number' && p > 0), model);
    }
  });
});

describe('DeepSeek off-peak pricing', () => {
  // Beijing is UTC+8: 10:00 Beijing on Wednesday 2026-09-30 is 02:00Z.
  const weekdayPeak = '2026-09-30T02:00:00Z';
  const weekdayLunch = '2026-09-30T04:00:00Z'; // 12:00 Beijing, the window is half-open
  const weekdayNight = '2026-09-30T16:00:00Z'; // 00:00 Beijing on Thursday
  const saturday = '2026-10-03T02:00:00Z'; // 10:00 Beijing on a Saturday

  it('peak windows are 09:00-12:00 and 14:00-18:00 on Beijing working days', () => {
    assert.equal(isOffPeak(weekdayPeak), false);
    assert.equal(isOffPeak('2026-09-30T01:00:00Z'), false); // 09:00 inclusive
    assert.equal(isOffPeak(weekdayLunch), true); // 12:00 exclusive
    assert.equal(isOffPeak('2026-09-30T06:00:00Z'), false); // 14:00
    assert.equal(isOffPeak('2026-09-30T10:00:00Z'), true); // 18:00 exclusive
    assert.equal(isOffPeak(weekdayNight), true);
  });

  it('weekends are off-peak all day, judged in Beijing time', () => {
    assert.equal(isOffPeak(saturday), true);
    // 17:00Z on Friday is already 01:00 Saturday in Beijing.
    assert.equal(isOffPeak('2026-10-02T17:00:00Z'), true);
  });

  it('an instant that cannot be parsed stays at the higher price', () => {
    assert.equal(isOffPeak('not a date'), false);
  });

  it('halves DeepSeek off-peak cost only', () => {
    assert.equal(priceFactor({ provider: 'deepseek', at: saturday }), 0.5);
    assert.equal(priceFactor({ provider: 'deepseek', at: weekdayPeak }), 1);
    assert.equal(priceFactor({ provider: 'openai', at: saturday }), 1);
    assert.equal(offPeakCost(0.2, { provider: 'deepseek', at: saturday }), 0.1);
    assert.equal(offPeakCost(null, { provider: 'deepseek', at: saturday }), null);
  });
});
});

await describe('closing', { concurrency: false }, async () => {
// splitClosing: the seat's answer to the closing question is one text, and the service has to tell
// the expertise note from the list of what was left undone. Getting it wrong is silent: a backlog
// swallowed into the expertise is never handed to the next run, and a "无" kept as a backlog would
// put a phantom task in front of every following run.




describe('splitClosing', () => {
  it('separates the expertise note from the 未完成 list', () => {
    const out = splitClosing('读过 src/ 和 tests/，能回答构建问题。\n未完成：\n- 没读 docs/\n- 没跑集成测试');
    assert.equal(out.expertise, '读过 src/ 和 tests/，能回答构建问题。');
    assert.equal(out.backlog, '- 没读 docs/\n- 没跑集成测试');
  });

  it('accepts the ASCII colon and a list on the same line', () => {
    const out = splitClosing('专长说明\n未完成: 还差 A 和 B');
    assert.equal(out.expertise, '专长说明');
    assert.equal(out.backlog, '还差 A 和 B');
  });

  for (const nothing of ['未完成：无', '未完成：无。', '未完成：没有，全部做完了', '未完成: none', '未完成：N/A', '未完成：', '**未完成：无**', '未完成：\n无']) {
    it(`leaves the backlog empty for ${JSON.stringify(nothing)}`, () => {
      const out = splitClosing(`专长说明\n${nothing}`);
      assert.equal(out.expertise, '专长说明');
      assert.equal(out.backlog, '');
    });
  }

  it('does not mistake a word that merely starts with 无 for "nothing left"', () => {
    assert.equal(splitClosing('说明\n未完成：无线模块没测').backlog, '无线模块没测');
    assert.equal(splitClosing('说明\n未完成：\n- 无法连接的那台机器没查').backlog, '- 无法连接的那台机器没查');
  });

  // Markdown variants of the marker line (2026-09-30): each one used to fall through to "no marker",
  // which made the whole answer expertise and lost the backlog.
  for (const marker of ['**未完成**：', '**未完成：**', '### 未完成', '未完成:', '- **未完成**：', '> 未完成：']) {
    it(`finds the marker written as ${JSON.stringify(marker)}`, () => {
      const out = splitClosing(`专长说明\n${marker}\n- 没读 docs/`);
      assert.equal(out.expertise, '专长说明');
      assert.equal(out.backlog, '- 没读 docs/');
    });
  }

  for (const nothing of ['无', '- 无', '* 无', '1. 无', '（无）', '(无)', '无。', 'none', '没有', '没有了', '- 没有。']) {
    it(`reads ${JSON.stringify(nothing)} under the marker as nothing left`, () => {
      assert.equal(splitClosing(`专长说明\n### 未完成\n${nothing}`).backlog, '');
    });
  }

  it('keeps a real list item that starts with 无 as backlog', () => {
    assert.equal(splitClosing('说明\n未完成：\n- 无法读取 x.md').backlog, '- 无法读取 x.md');
    assert.equal(splitClosing('说明\n**未完成**：\n1. 无线模块没测').backlog, '1. 无线模块没测');
    assert.equal(splitClosing('说明\n未完成：\n- 无\n- 没读 docs/').backlog, '- 无\n- 没读 docs/');
  });

  it('a line that only starts with 未完成 and has no colon is not the marker', () => {
    const text = '说明\n未完成的部分很多，见上文。';
    assert.deepEqual(splitClosing(text), { expertise: text, backlog: null });
  });

  it('keeps an answer without the marker whole as expertise, and says the backlog is unknown (null, not "")', () => {
    const out = splitClosing('只有专长说明，没有那一行。');
    assert.deepEqual(out, { expertise: '只有专长说明，没有那一行。', backlog: null });
  });

  it('only treats 未完成： at the start of a line as the marker', () => {
    const text = '这个目录里有很多未完成：标记的 TODO 注释。';
    assert.deepEqual(splitClosing(text), { expertise: text, backlog: null });
  });

  it('survives empty input, and an empty answer is unknown, never "nothing left"', () => {
    assert.deepEqual(splitClosing(''), { expertise: '', backlog: null });
    assert.deepEqual(splitClosing(null), { expertise: '', backlog: null });
    assert.deepEqual(splitClosing(undefined), { expertise: '', backlog: null });
  });

  it('the closing prompt asks for the very marker the splitter looks for', () => {
    assert.match(CLOSING_PROMPT, /未完成：/);
    assert.match(CLOSING_PROMPT, /未完成：无/);
  });

  it('[O-5] takes the original task and historical backlog only from the service closing-context file', () => {
    const before = process.env.SPECIALIST_SEAT_CLOSING_CONTEXT;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-closing-'));
    const file = path.join(dir, 'result.json.closing.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ task: '只回复 hello，禁止检查未读记录', backlog: '- 等用户给验证码' }));
      process.env.SPECIALIST_SEAT_CLOSING_CONTEXT = file;
      const prompt = closingPromptFor('服务提示：未读记录在 C:\\old\\records.jsonl');
      assert.ok(prompt, 'valid service context makes one closing prompt');
      assert.match(prompt, /服务收尾依据（JSON）：/);
      const scope = JSON.parse(prompt.slice(prompt.lastIndexOf('服务收尾依据（JSON）：') + '服务收尾依据（JSON）：'.length).trim());
      assert.deepEqual(scope, { task: '只回复 hello，禁止检查未读记录', backlog: '- 等用户给验证码' });
      assert.doesNotMatch(scope.task, /服务提示|records\.jsonl/);
      assert.match(prompt, /明确要求/);
      assert.match(prompt, /不能变成待办/);
    } finally {
      if (before === undefined) delete process.env.SPECIALIST_SEAT_CLOSING_CONTEXT;
      else process.env.SPECIALIST_SEAT_CLOSING_CONTEXT = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
});
