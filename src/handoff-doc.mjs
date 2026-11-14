// The hand-off document's shape (PRD, 2026-10-11): four sections, in this order, wherever the service
// asks for one or reads one back — L-1 (a merge), L-3 (a split), C-1 (a session that grew past a node)
// and S-4's second layer, the pitfalls of one object.
//
// They are named here once so the request an expert is sent and the check on what came back cannot
// drift apart. The third section is the one S-4 leans on: what is peculiar to one object is written
// into that expert's hand-off, never into a role's skill.
export const HANDOFF_SECTIONS = ['懂了什么', '没做完什么', '踩过的坑', '原始记录路径'];

// The four titles as the document is meant to carry them, for the sentence the service asks with.
export const handoffTitles = () => HANDOFF_SECTIONS.map((name) => `## ${name}`).join('、');

// The same four, in prose, for a request that also says what the document is for.
export const handoffShape = () => HANDOFF_SECTIONS.join('、');

// A section heading, whatever the model put around it: `## 踩过的坑`, `##踩过的坑`, `### 踩过的坑`.
const hasSection = (body, name) => new RegExp(`^#{2,6}\\s*${name}\\s*$`, 'm').test(body);

// Which of the four a document that came back does not have: [] when it has all of them. A hand-off is
// the only place an expert's experience of one object survives, so a missing section is said out loud
// (into the seat's events) rather than left for the next reader to discover.
export function missingHandoffSections(body) {
  return HANDOFF_SECTIONS.filter((name) => !hasSection(String(body ?? ''), name));
}

// The line the service records when a hand-off came back short: which sections, and what they are for.
export function missingHandoffNote(file, missing) {
  return `交接文档 ${file} 少了这几节：${missing.join('、')}。交接固定四节——${handoffShape()}——缺一节就等于那部分理解没有交出来（尤其「踩过的坑」：它是这个对象特有的教训，不进岗位的 skill）。让写它的专家补写，或手工补进这个文件。`;
}
