// What a SKILL.md has to be to go into HSkills at all (2026-10-01, the skill loop).
//
// HSkills lints every skill (skills/skill-creator/scripts/lint_skills.py) and its rule is that the
// errors are zero before anything is distributed. A candidate that would fail that lint must not be
// registered when the refiner writes it, and must not be written into HSkills when the lead enables it
// (the lead may have edited the file in between), so both places ask this one function. It mirrors the
// lint's errors for an own skill: a frontmatter that parses, `name` equal to the skill's directory,
// a `description` that is there, at most 1024 characters and without angle brackets, no TODO
// placeholders. It does not judge whether the skill is any good; that is the lead's call.
//
// The lint parses the frontmatter with a YAML library; this service has none and does not take a
// dependency for one check. The frontmatter is read as the flat `key: value` map a skill uses, with
// the three scalar forms a description comes in (plain, quoted, block). What it cannot see is
// structure under `metadata:`; the enable reply tells the lead to run the lint before committing.
//
// Every message says what is wrong and what to do about it: the reader is the refiner's failed
// attempt record or the lead.
//
// Also mirrored: the Skill links rules the lint turns into errors (at most one parent; every target a
// skill under skills/). Not mirrored: the structure under `metadata:` (verified needs by and at, sources
// entries need resource), which needs a YAML parser.

import fs from 'node:fs';
import path from 'node:path';
import { message } from './presets.mjs';

// HSkills' rule for a SKILL.md: fewer than 500 lines. The lint itself only warns at 500; the rule is stricter.
export const SKILL_MAX_LINES = 500;
// The host's limit for a description, which the lint turns into an error.
export const DESCRIPTION_MAX_CHARS = 1024;
// Far beyond any SKILL.md of fewer than 500 lines. This check runs inside the daemon on whatever the
// refiner (or a lead's edit) left in a file, so a degenerate one is refused before any regex sees it.
export const SKILL_MAX_CHARS = 300_000;

// Lines the way the lint counts them (Python's str.splitlines() on text read with universal newlines):
// a final line break does not start another line. Splitting on \n alone counted one more, so a
// 499-line file ending in a newline was refused as 500 (2026-10-01 review).
function lineCount(text) {
  if (!text) return 0;
  const pieces = text.split(/\r\n|\r|\n/).length;
  return /(\r\n|\r|\n)$/.test(text) ? pieces - 1 : pieces;
}

// HSkills' Skill links (skill-creator/SKILL.md): a `## Skill links` section, one `- <type>: [Title](../<name>/SKILL.md)`
// per line, the same pattern the lint reads (LINK_RE in lint_skills.py).
const LINK_RE = /^- (\w+):\s*\[[^\]]*\]\(\.\.\/([^/)]+)\/SKILL\.md\)/;
function skillLinks(body) {
  const links = [];
  let inSection = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      inSection = line.trim() === '## Skill links';
      continue;
    }
    if (!inSection) continue;
    const match = LINK_RE.exec(line.trim());
    if (match) links.push({ type: match[1], target: match[2] });
  }
  return links;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const KEY_LINE = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/;
// A plain YAML scalar cannot start with one of these (they open a collection, an alias, an anchor, a tag,
// a directive, a reserved character or a block indicator), so a description starting with one is not
// the string it looks like.
const PLAIN_START_BAD = /^[[\]{}*&!%@`|>#,]|^[-?]\s/;

// The frontmatter as { entries: Map(key -> { first, rest }), problems }. `first` is what follows the
// colon on the key's own line, `rest` the indented or blank lines after it.
function readFrontmatter(front) {
  const entries = new Map();
  const problems = [];
  let current = null;
  front.split(/\r?\n/).forEach((line, index) => {
    const no = index + 1;
    if (!line.trim()) { current?.rest.push(''); return; }
    if (line.startsWith('#')) return;
    if (/^\t/.test(line)) {
      problems.push(message(`frontmatter 第 ${no} 行用 tab 缩进，YAML 不允许，改成空格`, `frontmatter line ${no} uses tab indentation, which YAML forbids; use spaces`));
      return;
    }
    if (/^[ ]/.test(line)) {
      if (current) current.rest.push(line);
      else problems.push(message(`frontmatter 第 ${no} 行有缩进，但它前面没有键`, `frontmatter line ${no} is indented without a preceding key`));
      return;
    }
    if (line.startsWith('- ') && current) { current.rest.push(line); return; }
    const match = KEY_LINE.exec(line);
    if (!match) {
      problems.push(message(
        `frontmatter 第 ${no} 行不是「键: 值」的形式（${line.slice(0, 40)}），YAML 会解析失败；每个键独占一行，描述太长要折行就缩进或改用 > 块`,
        `frontmatter line ${no} is not "key: value" (${line.slice(0, 40)}), so YAML parsing will fail; keep one key per line and indent or use a > block for wrapped values`,
      ));
      return;
    }
    current = { first: (match[2] ?? '').trim(), rest: [] };
    entries.set(match[1], current);
  });
  return { entries, problems };
}

const unquote = (value) => String(value).trim().replace(/^(["'])(.*)\1$/, '$2');

// The string a `description` entry means, or a problem that says why it would not parse. `null` text
// with no problem means the key is absent.
function readDescription(entry) {
  if (!entry) return { text: null, problems: [] };
  const lines = [entry.first, ...entry.rest];
  const joined = lines.join('\n').trim();
  const head = entry.first;

  // Block scalar: `>` or `|` (with an optional - + or indent digit) and then indented lines. Anything
  // goes inside, so `: ` and `<` are judged only by the checks on the finished text.
  if (/^[>|][+-]?\d*[ \t]*(#.*)?$/.test(head)) {
    const body = entry.rest.map((line) => line.trim()).filter(Boolean);
    return { text: body.join(head.startsWith('>') ? ' ' : '\n'), problems: [] };
  }

  // Quoted scalar, possibly over several lines: the closing quote must be there, and nothing but a
  // comment may follow it.
  if (joined.startsWith('"') || joined.startsWith("'")) {
    const quote = joined[0];
    let i = 1;
    let inner = '';
    let closed = false;
    for (; i < joined.length; i += 1) {
      const ch = joined[i];
      if (quote === '"' && ch === '\\') { inner += joined[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) {
        if (quote === "'" && joined[i + 1] === "'") { inner += "'"; i += 1; continue; }
        closed = true;
        break;
      }
      inner += ch;
    }
    if (!closed) {
      return {
        text: null,
        problems: [message(`description 以 ${quote} 开头但引号没有闭合，YAML 会解析失败；补上结尾的 ${quote}`, `description starts with ${quote} without a closing ${quote}, so YAML parsing will fail`)],
      };
    }
    const after = joined.slice(i + 1).trim();
    if (after && !after.startsWith('#')) {
      return {
        text: null,
        problems: [message(`description 的结尾引号后面还有字（${after.slice(0, 30)}），YAML 会解析失败；引号里面出现同样的引号要转义`, `description has trailing text after its closing quote (${after.slice(0, 30)}), so YAML parsing will fail; escape inner matching quotes`)],
      };
    }
    return { text: inner.replace(/\s*\n\s*/g, ' ').trim(), problems: [] };
  }

  // Plain scalar (the common case, and where the trouble is).
  const folded = joined.split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
  if (!folded) return { text: '', problems: [] };
  if (PLAIN_START_BAD.test(folded)) {
    return {
      text: null,
      problems: [message(`description 没加引号，开头的「${folded[0]}」在 YAML 里是记号，不是文字，会解析成别的东西；整段用双引号括起来`, `description is unquoted and starts with YAML indicator "${folded[0]}"; wrap the value in double quotes`)],
    };
  }
  if (/:(\s|$)/.test(joined)) {
    return {
      text: null,
      problems: [message('description 没加引号，里面有「: 」（冒号后跟空格），YAML 会把它读成嵌套的键而解析失败；整段用双引号括起来，或改用 > 块', 'description is unquoted and contains ": ", which YAML parses as a nested key; wrap in double quotes or use a > block')],
    };
  }
  return { text: folded, problems: [] };
}

// What a run is handed of a SKILL.md (architecture 4.5): the text after the frontmatter, trimmed. The
// frontmatter is for the host that lists skills (name, description, metadata such as verified), not
// for a model already told to work as this post; stamp.py rewrites it after an enable, which must
// not read as a new version of the skill. A file without a frontmatter is handed over whole. A UTF-8
// byte order mark in front of the opening --- is dropped first, or the frontmatter would not be seen.
export function skillBody(text) {
  const plain = String(text ?? '').replace(/^﻿/, '');
  const front = FRONT.exec(plain);
  return (front ? plain.slice(front.index + front[0].length) : plain).trim();
}

// The problems that keep `text` out of HSkills as the SKILL.md of the skill called `name`; empty means
// it passes. `skillsDir` is <HSkills>/skills: given, every Skill links target must be a skill there,
// as the lint requires; without it only the number of parents is checked.
export function checkSkillText(text, name, { skillsDir = null } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [message('正文是空的', 'Skill text is empty')];
  if (text.length > SKILL_MAX_CHARS) {
    return [message(
      `正文 ${text.length} 字，远远超出一个 skill 的长度（上限 ${SKILL_MAX_CHARS} 字），要收短到少于 ${SKILL_MAX_LINES} 行`,
      `Skill text is ${text.length} characters, exceeding the limit (${SKILL_MAX_CHARS}); shorten to fewer than ${SKILL_MAX_LINES} lines`,
    )];
  }
  const problems = [];
  const lines = lineCount(text);
  if (lines >= SKILL_MAX_LINES) {
    problems.push(message(`正文 ${lines} 行，HSkills 的规矩是少于 ${SKILL_MAX_LINES} 行，要收短`, `Skill text is ${lines} lines; HSkills requires fewer than ${SKILL_MAX_LINES} lines`));
  }
  const front = FRONT.exec(text);
  if (!front) {
    problems.push(message('开头没有 frontmatter（用 --- 包起来的 name 和 description）', 'Missing opening frontmatter (--- block with name and description)'));
    return problems;
  }
  const { entries, problems: yamlProblems } = readFrontmatter(front[1]);
  problems.push(...yamlProblems);

  const given = entries.get('name');
  if (!given || unquote([given.first, ...given.rest].join(' ')) !== name) {
    problems.push(message(`frontmatter 里的 name 要写成 ${name}`, `frontmatter name must be ${name}`));
  }

  const description = readDescription(entries.get('description'));
  problems.push(...description.problems);
  if (description.text === null && !description.problems.length) {
    problems.push(message('frontmatter 里没有 description', 'frontmatter is missing description'));
  } else if (description.text !== null) {
    const chars = [...description.text].length;
    if (!description.text) problems.push(message('frontmatter 里的 description 是空的', 'frontmatter description is empty'));
    if (chars > DESCRIPTION_MAX_CHARS) {
      problems.push(message(`description ${chars} 字，宿主上限 ${DESCRIPTION_MAX_CHARS}，要收短`, `description is ${chars} chars; host limit is ${DESCRIPTION_MAX_CHARS}`));
    }
    if (/[<>]/.test(description.text)) {
      problems.push(message('description 里不能有尖括号（< 或 >），换成别的写法', 'description must not contain angle brackets (< or >)'));
    }
    if (description.text.startsWith('[TODO')) {
      problems.push(message('description 是 TODO 占位符，写成真正的描述', 'description is still a [TODO placeholder; write a real description'));
    }
  }

  const body = text.slice(front.index + front[0].length);
  // Spaces and tabs only, never \s: \s also matches line breaks, and on a long run of blank lines the
  // multiline ^ restarts at every one of them, which made this check quadratic (2026-10-01 review).
  if (/^[ \t]*\[TODO:/m.test(body)) {
    problems.push(message('正文里还有 [TODO: 占位符，写完或删掉', 'Skill body still contains a [TODO: placeholder; complete or remove it'));
  }

  const links = skillLinks(body);
  const parents = links.filter((link) => link.type === 'parent').map((link) => link.target);
  if (parents.length > 1) {
    problems.push(message(`Skill links 里有 ${parents.length} 个 parent（${parents.join('、')}），HSkills 只允许一个，留一个`, `Skill links lists ${parents.length} parents (${parents.join(', ')}); HSkills allows only one`));
  }
  if (skillsDir) {
    const missing = [...new Set(links.map((link) => link.target))]
      .filter((target) => target !== name && !fs.existsSync(path.join(skillsDir, target, 'SKILL.md')));
    if (missing.length) {
      problems.push(message(
        `Skill links 指向的 ${missing.join('、')} 在 HSkills 的 skills/ 下不存在，lint 会报错；删掉这几行或改成存在的 skill`,
        `Skill links target(s) ${missing.join(', ')} do not exist under HSkills skills/, which lint will reject; remove them or point to existing skills`,
      ));
    }
  }
  return problems;
}
