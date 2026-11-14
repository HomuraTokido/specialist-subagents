// A fake model whose knowledge is exactly what was loaded into its context (2026-10-11, for the
// end-to-end scenarios of PRD 4.0). The older fakes answer a constant string, so they cannot show
// whether an expert "remembers": a scenario that passes on them proves only that the plumbing runs.
// This one can be asked a question, and it answers only from what the service really put in front of
// it: the system prompt, the earlier turns of the session, this prompt, and the files it read in this
// call. A run that the service resumed badly (no history, no record path, no change note) cannot know
// the answer and goes to "the web" instead, which the scenario then sees as a tool call and a source.
//
// Both backend stand-ins call respond(): fake-codex-brain.mjs (Codex CLI) and fake-pi (FAKE_PI_BRAIN=1).
// The task is a list of one-line commands, so a test writes what the expert should do in plain text:
//
//   读文件：<relpath>             read a file (its text joins the context)
//   改文件：<relpath>=<content>   write a file; the answer gets the line 改动：<relpath>
//   出错：<command>               a bash call that fails (for the difficulty traces)
//   慢：<ms>                      stay busy for a while with a real child process under this one
//   问：<key>                     answer from context (事实：key=value lines, its own earlier 答：lines),
//                                 else from the files named by record paths, else from the "web"
//   问上次改动                    the 改动：lines of the earlier turns
//   问目录变化                    the files the service's change note lists in this prompt
//   写交接                        (a service message, not a task line) the four-section hand-off, with every
//                                 fact the context holds listed as 事实：k=v
//
// What the tools returned stays in the session, as a real model's does: respond() hands back the full
// text of every tool result of the call as `transcript`, and the backend stand-ins write it to the
// session between the user line and the assistant line. A fact read from a file in one run is therefore
// still there when the next run resumes the session, which is the whole point of resuming.
//
// Deliberately vague where a summary is asked (the closing question): the expertise note must not
// carry the facts, so a scenario cannot pass on the summary alone.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// The fakes live in tests/fakes and the brain runs from the repo even inside a sandbox (the sandbox
// copies src/, not tests/), so this is the repo's own closing prompt, the one the service really sends.
import { CLOSING_PROMPT } from '../../src/closing.mjs';

const CLOSING_ANSWER = '我是这里的常驻专家，读过这里的一些文件。\n未完成：无';
const FOLLOWUP_MARK = '刚才的运行里有这几处';
const FOLLOWUP_ANSWER = '1. 任务需要。';
const RECORD_WORDS = ['记录', '交接', '原文', '会话'];
const HANDOFF_MARK = '写交接';

// The closing context is service-owned evidence, not an instruction language.  These two small fake
// commands let T-9 exercise the wire path: a task explicitly blocked on input leaves one item, a
// later task supplying it clears that item, and an unrelated task repeats a genuine historical item.
function closingAnswer(prompt) {
  const marker = '服务收尾依据（JSON）：';
  const at = prompt.lastIndexOf(marker);
  let scope = null;
  if (at >= 0) {
    try { scope = JSON.parse(prompt.slice(at + marker.length).trim()); } catch { scope = null; }
  }
  const task = typeof scope?.task === 'string' ? scope.task.trim() : '';
  if (task.startsWith('缺输入：')) {
    const missing = task.slice('缺输入：'.length).trim() || '必要输入';
    return `我是这里的常驻专家，读过这里的一些文件。\n未完成：\n- 缺少输入：${missing}`;
  }
  if (task.startsWith('补输入：')) return CLOSING_ANSWER;
  if (typeof scope?.backlog === 'string' && scope.backlog.trim()) {
    return `我是这里的常驻专家，读过这里的一些文件。\n未完成：\n${scope.backlog.trim()}`;
  }
  return CLOSING_ANSWER;
}

const today = () => process.env.FAKE_TODAY || new Date().toISOString().slice(0, 10);
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ORIGIN = '出自上一单，原出处 ';

function logLine(entry) {
  if (!process.env.FAKE_BRAIN_LOG) return;
  fs.appendFileSync(process.env.FAKE_BRAIN_LOG, `${JSON.stringify(entry)}\n`);
}

// The latest fact for `key` in the segments, scanning them in order. A segment is
// { text, source } where source tells where its lines came from: null (the system prompt, an earlier
// turn, the prompt), { file: relpath } (read in this call), { record: path } (a session record) or
// { history: true } (an earlier turn of this session, a tool result included).
function findFact(segments, key) {
  const k = escapeRe(key);
  const fact = new RegExp(`事实：${k}=([^\\n]*)`, 'g');
  const answer = new RegExp(`答：${k}=([^\\n]*?)（出处：([^；\\n]*)；查证：([^）\\n]*)）`, 'g');
  let best = null;
  segments.forEach((segment, index) => {
    for (const [re, kind] of [[fact, 'fact'], [answer, 'answer']]) {
      re.lastIndex = 0;
      for (let m = re.exec(segment.text); m; m = re.exec(segment.text)) {
        if (!best || index > best.index || (index === best.index && m.index >= best.at)) {
          best = { index, at: m.index, kind, value: m[1].trim(), from: m[2], checked: m[3], source: segment.source };
        }
      }
    }
  });
  if (!best) return null;
  let origin;
  if (best.source?.record) origin = `出自记录 ${best.source.record}`;
  else if (best.kind === 'answer') origin = `${ORIGIN}${best.from.startsWith(ORIGIN) ? best.from.slice(ORIGIN.length) : best.from}`;
  else if (best.source?.file) origin = `读文件 ${best.source.file}`;
  else if (best.source?.history) origin = '出自上一单';
  else origin = '出自记录';
  return { value: best.value, origin, checked: best.kind === 'answer' ? best.checked : today() };
}

// Every key the context holds a fact for, newest value wins (a 答： line counts too: it is what the
// expert itself concluded earlier). Order of first appearance, so the hand-off reads like the session.
function allFacts(segments) {
  const keys = [];
  for (const { text } of segments) {
    for (const m of text.matchAll(/(?:事实|答)：([^=\n（]+)=/g)) {
      const key = m[1].trim();
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys.map((key) => [key, findFact(segments, key)?.value]).filter(([, value]) => value !== undefined);
}

const reply = (key, found) => `答：${key}=${found.value}（出处：${found.origin}；查证：${found.checked}）`;

// Absolute paths of existing files on lines that talk about a record: the handoff line cli-runner
// writes (上一段会话的完整记录在 <path>，需要时可以读) is the case this exists for.
function recordPaths(text) {
  const found = [];
  for (const line of text.split('\n')) {
    if (!RECORD_WORDS.some((word) => line.includes(word))) continue;
    // The CJK punctuation ends a path inside the sentence; ASCII punctuation is trimmed from its end.
    const re = /(?:[A-Za-z]:\\[^\s"'`<>|，。；、）（]+|(?<![\w.:~/-])\/[^\s"'`<>|，。；、）（]+)/g;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const file = m[0].replace(/[，。,;；）)]+$/, '');
      try {
        if (fs.statSync(file).isFile() && !found.includes(file)) found.push(file);
      } catch {
        // not a file that exists: some other path in the sentence
      }
    }
  }
  return found;
}

// A session record is JSON lines of { role, text }: the text is what the model saw, so lines of
// another shape are taken as they are.
function recordText(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split('\n').map((line) => {
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.text === 'string') return entry.text;
    } catch {
      // not JSON: the line itself
    }
    return line;
  }).join('\n');
}

const preview = (text) => String(text).slice(0, 200);

async function sleepMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function respond({ backend, system = '', history = [], prompt, cwd }) {
  const tools = [];
  const answer = [];
  // The full text of every tool result, in order: what the session keeps of this call's tools.
  const transcript = [];
  // What kind of call this is comes from the prompt's own part, the text after its last 任务：: since C-1 a
  // fresh session's prompt can carry the earlier session as text (cli-runner's handoff note), and that text
  // holds the earlier closing questions and follow-ups, which are not this call's.
  const own = prompt.lastIndexOf('任务：\n') >= 0 ? prompt.slice(prompt.lastIndexOf('任务：\n')) : prompt;
  const kind = own.includes(CLOSING_PROMPT) ? 'closing' : own.includes(FOLLOWUP_MARK) ? 'followup' : own.includes(HANDOFF_MARK) ? 'handoff' : 'task';
  const meta = { backend, seatName: process.env.SPECIALIST_SEAT_NAME ?? null, cwd, pid: process.pid };

  if (kind === 'closing') answer.push(closingAnswer(prompt));
  else if (kind === 'followup') answer.push(FOLLOWUP_ANSWER);
  else if (kind === 'handoff') {
    // The service's merge/split request. Deliberately not filtered by a sub-object named after
    // `写交接：`: the fake lists everything it knows, and a scenario checks the receiver can use it.
    const known = allFacts([{ text: system }, ...history.map((text) => ({ text })), { text: prompt }]);
    answer.push(['## 懂了什么', ...known.map(([key, value]) => `事实：${key}=${value}`), '## 没做完什么', '无', '## 踩过的坑', '无', '## 原始记录路径', '（见服务附上的清单）'].join('\n'));
  } else {
    const segments = [
      { text: system, source: null },
      ...history.map((text) => ({ text, source: { history: true } })),
      { text: prompt, source: null },
    ];
    const baseText = [system, ...history, prompt].join('\n');
    const marker = prompt.lastIndexOf('任务：\n');
    const commands = (marker >= 0 ? prompt.slice(marker + '任务：\n'.length) : prompt).split('\n').map((line) => line.trim());

    for (const line of commands) {
      let m;
      if ((m = /^读文件：(.+)$/.exec(line))) {
        const rel = m[1].trim();
        const abs = path.resolve(cwd, rel);
        try {
          const text = fs.readFileSync(abs, 'utf8');
          tools.push({ tool: 'read', arg: abs, isError: false, output: preview(text) });
          transcript.push(text);
          segments.push({ text, source: { file: rel } });
        } catch {
          tools.push({ tool: 'read', arg: abs, isError: true, output: 'ENOENT' });
          transcript.push('ENOENT');
        }
      } else if ((m = /^改文件：([^=]+)=(.*)$/.exec(line))) {
        const rel = m[1].trim();
        const abs = path.resolve(cwd, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, m[2]);
        tools.push({ tool: 'write', arg: abs, isError: false, output: `wrote ${rel}` });
        transcript.push(`wrote ${rel}`);
        answer.push(`改动：${rel}`);
      } else if ((m = /^出错：(.+)$/.exec(line))) {
        tools.push({ tool: 'bash', arg: m[1].trim(), isError: true, output: 'exit 1' });
        transcript.push('exit 1');
      } else if ((m = /^慢：(\d+)$/.exec(line))) {
        // A real process tree for the runner to cope with: the grandchild is not detached, so killing
        // this process's tree must take it too, and a test can check it is gone afterwards.
        const grandchild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
        logLine({ phase: 'slow', ...meta, grandchild: grandchild.pid, ms: Number(m[1]) });
        await sleepMs(Number(m[1]));
        grandchild.kill();
      } else if ((m = /^问：(.+)$/.exec(line))) {
        const key = m[1].trim();
        let found = findFact(segments, key);
        if (!found) {
          // Not in the context: the service may have handed over where the earlier session is kept.
          const read = new Set(segments.filter((s) => s.source?.record).map((s) => s.source.record));
          for (const file of recordPaths(baseText)) {
            if (read.has(file)) continue;
            let text;
            try {
              text = recordText(file);
            } catch {
              continue;
            }
            tools.push({ tool: 'read', arg: file, isError: false, output: preview(text) });
            transcript.push(text);
            segments.push({ text, source: { record: file } });
          }
          found = findFact(segments, key);
        }
        if (found) answer.push(reply(key, found));
        else {
          tools.push({ tool: 'bash', arg: `node tools/web-search.mjs "${key}"`, isError: false, output: '' });
          let world = {};
          try {
            world = JSON.parse(fs.readFileSync(process.env.FAKE_WORLD, 'utf8'));
          } catch {
            // no world: nothing on the web
          }
          const web = Object.hasOwn(world, key)
            ? `答：${key}=${world[key]}（出处：联网 https://example.test/${key}；查证：${today()}）`
            : `答：${key} 查不到（查证：${today()}）`;
          tools.at(-1).output = web;
          transcript.push(web);
          answer.push(web);
        }
      } else if (line === '问上次改动') {
        const files = [];
        for (const text of history) for (const entry of text.split('\n')) {
          const hit = /^改动：(.+)$/.exec(entry.trim());
          if (hit) files.push(hit[1].trim());
        }
        answer.push(files.length ? `上次改动：${files.join(',')}` : '上次改动：不知道');
      } else if (line === '问目录变化') {
        // Only this prompt: the change note is the service's, written for this visit.
        const listed = [];
        let under = false;
        for (const entry of prompt.split('\n')) {
          if (entry.includes('提交里改动的文件') || entry.includes('现在未提交的改动')) under = true;
          else if (under && !entry.trim()) under = false;
          else if (under && !entry.trim().startsWith('……')) listed.push(entry.trim());
        }
        answer.push(listed.length ? `目录变化：${listed.length} 个文件：${listed.slice(0, 5).join(',')}` : '目录变化：不知道');
      }
    }
  }

  const text = answer.length ? answer.join('\n') : '好的。';
  logLine({
    phase: 'answer', ...meta, resumed: history.length > 0, kind, prompt, answer: text,
    tools: tools.map((t) => ({ tool: t.tool, arg: t.arg, isError: t.isError })),
  });
  return { answer: text, tools, transcript: transcript.join('\n') };
}
