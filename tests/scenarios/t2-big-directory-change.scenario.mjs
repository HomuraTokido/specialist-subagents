// [T-2] PRD 4.0: a coder expert does one run in a repository; the repository then changes by 30 files
// and 500+ lines; a second run asks what it changed last time and what is different now. The expert must
// continue its understanding (a big change must not start it over). Covers C-2, C-5, E-3.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODE, brief, openScenario, step, t } from './driver.mjs';

test('[T-2] Continuing after a major directory refactor', { timeout: 180000 }, async () => {
  const sc = await openScenario();
  try {
    const work = sc.workdir({ 'README.md': '# demo\n' }, { git: true });

    const first = await step(1, '第一单：在仓库里新建 src/a.txt', async () => {
      const reply = await sc.dispatch({ role: 'coder', cwd: work, task: t('改文件：src/a.txt=hello', '新建文件 src/a.txt，内容写 hello。做完说明你改了哪个文件。') });
      const answer = await sc.answer(reply);
      assert.match(answer, /src\/a\.txt/, `第一单没有改成：${brief(answer)}`);
      return reply;
    });

    await step(2, '仓库里再提交 30 个新文件、600 行', async () => {
      const files = {};
      for (let i = 1; i <= 30; i += 1) {
        files[`lib/m${String(i).padStart(2, '0')}.txt`] = Array.from({ length: 20 }, (_, n) => `line ${i}-${n + 1}`).join('\n') + '\n';
      }
      sc.writeFiles(work, files);
      sc.commitAll(work, 'thirty new files');
    });

    await step(3, '第二单问上次改了什么、现在变了什么：落在同一个专家上，答得出上次改动', async () => {
      const task = t(
        '问上次改动\n问目录变化',
        '我上次让你改了哪个文件？另外这个仓库自从你上次来过之后有什么变化？只凭你记得的和服务告诉你的回答，不要重新探索。',
      );
      const reply = await sc.dispatch({ role: 'coder', cwd: work, task });
      assert.equal(reply.seat, first.seat, `落在了另一个座位 ${reply.seat}，不是第一单的 ${first.seat}`);
      const answer = await sc.answer(reply);
      assert.match(answer, MODE === 'fake' ? /上次改动：[^\n]*src\/a\.txt/ : /src\/a\.txt/, `答不出上次改动（续上原来的理解）：${brief(answer, 160)}`);
      if (MODE === 'fake') {
        assert.doesNotMatch(answer, /目录变化：不知道/, `服务没有告诉它目录变了：${brief(answer, 160)}`);
        const count = Number(/目录变化：(\d+)/.exec(answer)?.[1] ?? 0);
        assert.ok(count >= 30 || /变化清单|change-?list|\.data[\\/]/.test(answer), `答不出这次的变化（要列出 ≥ 30 个文件，或说明清单文件在哪）：${brief(answer, 160)}`);
      } else {
        assert.match(answer, /lib|30|三十|新增|新文件/, `答不出这次的变化：${brief(answer, 160)}`);
      }
    });
  } finally {
    await sc.close();
  }
});
