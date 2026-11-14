// The closing question every runner asks once the task is done, and how its answer is split.
//
// One question, two answers, so the backlog costs no extra round at full context: the expertise
// note the seat keeps for whoever dispatches next, and what this run left undone. The second half
// exists because unfinished work looked exactly like finished work: seat-librarian-1 was handed 364
// changed files on 2026-09-29, edited 10 and reported only what it edited; the other 350 then fell
// behind its next baseline and would never have been shown to it again. The service carries the
// backlog into the seat's next task (exec.mjs).

import fs from 'node:fs';

export const CLOSING_PROMPT =
  '（服务消息，不是新任务）不要调用任何工具，只凭你已经读过的东西，写两段。' +
  '第一段用不超过 5 行，写给派活的人看，沿用已有且确认的专长，只补充本单实际新增的认识；没有新增时保留旧专长，不要编造读过的文件、模块或能力。' +
  '然后单独一行写「未完成：」，下面只列本单原始用户任务明确要求、且确实还没完成的事项，每行一件。' +
  '未读的记录路径、岗位常规职责、服务提示、没有被要求的动作或明确禁止的动作，都不能变成待办。' +
  '历史清单只是背景，不是这单的新任务：不能自动执行或扩大它；本单无关时，真实或无法确认的旧项原样保留，不能因为没处理就清掉。' +
  '只有本单明确授权处理且已经完成，或有明确证据表明历史项原本未被要求或被禁止时才删。没有真实剩余时只写「未完成：无」。' +
  '只输出这两段，不要客套或前后缀。';

// The daemon writes this next to the result before it starts a runner.  Keeping the original task out
// of the wrapped runtime prompt is what lets the closing question distinguish the user's task from the
// records, hand-off notes, and historical backlog the service prepended for this run.
export function closingPromptFor(fallbackTask) {
  const file = process.env.SPECIALIST_SEAT_CLOSING_CONTEXT;
  let context;
  if (!file) {
    context = { task: String(fallbackTask ?? ''), backlog: null };
  } else {
    try {
      context = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      process.stderr.write(`收尾依据文件读不到或不是 JSON（${file}；${err?.message ?? err}）：跳过收尾，保留原来的专长和未完成清单。\n`);
      return null;
    }
    if (!context || Array.isArray(context) || typeof context.task !== 'string' || (typeof context.backlog !== 'string' && context.backlog !== null)) {
      process.stderr.write(`收尾依据文件内容无效（${file}；需要 { task: string, backlog: string|null }）：跳过收尾，保留原来的专长和未完成清单。\n`);
      return null;
    }
  }
  return `${CLOSING_PROMPT}\n\n服务收尾依据（JSON）：\n${JSON.stringify(context)}`;
}

// The dispatcher's own task, without the records, hand-off notes and backlog the service put in front
// of it: what a session that takes the task over without the seat's history is given (cli-runner.mjs,
// takeOver). The same file as above; the task the runner was started with when there is none.
export function originalTask(fallbackTask) {
  const file = process.env.SPECIALIST_SEAT_CLOSING_CONTEXT;
  if (file) {
    try {
      const context = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof context?.task === 'string' && context.task.trim()) return context.task;
    } catch {
      // fall back to the task as the runner got it
    }
  }
  return String(fallbackTask ?? '');
}

// The marker line as models actually write it: "未完成：", "未完成:", "**未完成：**", "**未完成**：",
// "- **未完成**：", or a heading such as "### 未完成" with the list on the following lines. A colon lets
// text follow on the same line; without one the line must be the marker and nothing else, so a
// sentence that merely starts with 未完成 is not taken for it.
const DECOR = '[*_`]*';
const MARKER = new RegExp(`^[ \\t]*(?:[#>*_\`-]+[ \\t]*)*未完成${DECOR}[ \\t]*(?:[:：]${DECOR}|$)`, 'm');
// A no, in the shapes seen or likely: "无", "无。", "- 无", "* 无", "1. 无", "（无）", "(无)",
// "没有，全部做完了", "none". One line only, and the word must end there: "- 无法读取 x.md" is a real
// backlog item, not a "无". An empty remainder counts as nothing left too.
const NOTHING = /^[\s*_`>-]*(?:\d+[.)、][ \t]*)?[（(【[]?[ \t]*(?:(?:没有了|没有|无|none|nothing|n\/a)(?![\p{L}\p{N}])[^\n]*)?$/iu;

// { expertise, backlog }. backlog is a string when the answer says what is left ('' meaning nothing
// is), and null when the answer does not say: no marker at all, or no answer. Null must never clear
// the seat's stored backlog (exec.mjs keeps the old one for anything that is not a string), because
// a disobedient or missing answer is not evidence that the work is done (2026-09-30 review: a failed
// closing round used to clear the very list that exists to keep unfinished work).
export function splitClosing(text) {
  const answer = String(text ?? '').trim();
  const match = MARKER.exec(answer);
  if (!match) return { expertise: answer, backlog: null };
  const expertise = answer.slice(0, match.index).trim();
  const rest = answer.slice(match.index + match[0].length).trim();
  return { expertise, backlog: NOTHING.test(rest) ? '' : rest };
}
