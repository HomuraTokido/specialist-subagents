#!/usr/bin/env node
// prd-check: the only thing that may say a PRD requirement is implemented (PRD section 0, P-1).
// It runs the end-to-end scenarios first, then the requirement tests, and reads tags like [C-2] from
// the test names. A requirement is implemented only if its own tests pass AND every scenario that
// covers it passes. Nothing here trusts anyone's claim of "done".
import { message } from '../src/presets.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOLS_DIR, '..');
const REPORTER_URL = pathToFileURL(path.join(TOOLS_DIR, 'prd-reporter.mjs')).href;

const SCENARIO_TIMEOUT_MS = 15 * 60 * 1000;
const TESTS_TIMEOUT_MS = 20 * 60 * 1000;

// Requirements whose acceptance cannot be fully decided inside this repository (doc/goal.md).
const LOCAL_ONLY = {
  'C-6': message('达标与否看当前机器的真实台账（真实使用的数字），这里只验了算法', 'Requires real usage figures from this machine’s ledger; repository checks cover the algorithm only'),
  'H-1': message('要检查各宿主自己的配置，不在这个仓库', 'Requires each host’s configuration outside this repository'),
  'H-2': message('要检查各宿主自己的配置，不在这个仓库', 'Requires each host’s configuration outside this repository'),
  'H-4': message('宿主侧的注入测试要在各宿主上做，这里只验了服务侧', 'Requires injection checks on each host; repository checks cover only the service'),
  'O-2': message('宿主侧的叫醒测试要在各宿主上做，这里只验了服务侧', 'Requires completion-notification checks on each host; repository checks cover only the service'),
  'B-2': message('Hwiki 的真实提交记录不在这个仓库，这里只用临时仓库验了', 'Requires real Hwiki commit history; repository checks use a temporary repository'),
  'K-1': message('Hwiki 的真实提交记录不在这个仓库', 'Requires real Hwiki commit history outside this repository'),
  'K-4': message('Hwiki 的真实同步记录不在这个仓库，这里只用临时仓库验了', 'Requires real Hwiki synchronization history; repository checks use a temporary repository'),
};
// Of those, the ones with no part at all that this repository can test: there is nothing to tag, so
// "no tagged test" would misreport them as forgotten rather than as checks that belong elsewhere.
const LOCAL_ONLY_WHOLLY = new Set(['H-1', 'H-2']);

// ---------- PRD parsing ----------

export function parsePrd(text) {
  const lines = text.split(/\r?\n/);
  const scenarios = [];
  const requirements = [];
  let inSection4 = false;
  let inScenarios = false;
  for (const line of lines) {
    if (/^## /.test(line)) {
      inSection4 = /^## 4\.\s*需求/.test(line);
      inScenarios = false;
      continue;
    }
    if (/^### /.test(line)) {
      inScenarios = /^### 4\.0(\s|$)/.test(line);
      continue;
    }
    if (!inSection4) continue;
    if (inScenarios) {
      const m = line.match(/^\*\*(T-\d+) (.+?)\*\*/);
      if (!m) continue;
      const covered = line.match(/覆盖：([^。]*)。/);
      const covers = covered ? covered[1].split('、').map((s) => s.trim()).filter(Boolean) : [];
      scenarios.push({ id: m[1], title: cleanTitle(m[2]), covers });
    } else {
      const m = line.match(/^\*\*([A-Z]-\d+) (.+?)\*\*/);
      if (m) requirements.push({ id: m[1], title: cleanTitle(m[2]) });
    }
  }
  return { scenarios, requirements };
}

const cleanTitle = (title) => title.trim().replace(/[。.]$/, '');

// ---------- running node:test ----------

// Scenarios run one file at a time (`serial`): each starts its own service and some time their steps
// (T-3: the second dispatch must come back at once), which parallel files on a small machine would
// turn into false failures.
// Requirement files use four workers, matching CI: each may start its own daemon and fake backend.
function runSuite(pattern, backend, timeoutMs, { serial = false } = {}) {
  const args = ['--test', `--test-concurrency=${serial ? 1 : 4}`, `--test-reporter=${REPORTER_URL}`, '--test-reporter-destination=stdout', pattern];
  // Under `node --test` this process carries NODE_TEST_CONTEXT, which would make the nested run a silent child.
  const env = { ...process.env, PRD_SCENARIO_BACKEND: backend };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const results = [];
  for (const raw of (run.stdout ?? '').split(/\r?\n/)) {
    if (!raw.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    if (obj && (obj.type === 'pass' || obj.type === 'fail')) results.push(obj);
  }
  const timedOut = run.error?.code === 'ETIMEDOUT';
  const note = timedOut
    ? message(`超时（${Math.round(timeoutMs / 60000)} 分钟）`, `Timed out (${Math.round(timeoutMs / 60000)} minutes)`)
    : run.error
      ? message(`起不来：${run.error.message}`, `Could not start: ${run.error.message}`)
      : results.length === 0 && run.status !== 0
        ? message(`没有跑出结果：${String(run.stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 200)}`, `No results: ${String(run.stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 200)}`)
        : null;
  return { results, note, timedOut };
}

const tagsOf = (name) => [...String(name).matchAll(/\[([A-Z]-\d+)\]/g)].map((m) => m[1]);
// A skipped or todo result never counts as passing.
const isPass = (r) => r.type === 'pass' && !r.skip && !r.todo;

function failureText(r) {
  if (r.type === 'pass') return r.skip ? message('被跳过了（跳过的测试不算通过）', 'Skipped (skipped tests do not count as passing)') : message('是 todo（不算通过）', 'TODO (does not count as passing)');
  return r.error || message('失败了，没有错误信息', 'Failed without an error message');
}

function resultsFor(results, id) {
  return results.filter((r) => tagsOf(r.name).includes(id));
}

// ---------- statuses ----------

export function scenarioStatuses(scenarios, results, runNote) {
  return scenarios.map((s) => {
    const tagged = resultsFor(results, s.id);
    if (tagged.length === 0) {
      return { ...s, passed: false, state: 'none', reason: runNote ? message(`没有场景测试（${runNote}）`, `No scenario tests (${runNote})`) : message('没有场景测试', 'No scenario tests') };
    }
    const bad = tagged.find((r) => !isPass(r));
    if (bad) {
      return { ...s, passed: false, state: 'failed', reason: `「${bad.name}」${failureText(bad)}` };
    }
    return { ...s, passed: true, state: 'passed', reason: null };
  });
}

export function requirementStatuses(requirements, results, scenarioList) {
  return requirements.map((req) => {
    const tagged = resultsFor(results, req.id);
    if (tagged.length === 0 && LOCAL_ONLY_WHOLLY.has(req.id)) {
      return { ...req, status: '需要本机', reason: LOCAL_ONLY[req.id] };
    }
    if (tagged.length === 0) {
      return { ...req, status: '未实现', reason: message(`没有带 [${req.id}] 的测试`, `No tests tagged [${req.id}]`) };
    }
    const bad = tagged.find((r) => !isPass(r));
    if (bad) {
      return { ...req, status: '未实现', reason: message(`「${bad.name}」没过：${failureText(bad)}`, `Test failed: ${bad.name}: ${failureText(bad)}`) };
    }
    const brokenScenario = scenarioList.find((s) => s.covers.includes(req.id) && !s.passed);
    if (brokenScenario) {
      return { ...req, status: '未实现', reason: message(`场景 ${brokenScenario.id} 没过`, `Scenario ${brokenScenario.id} failed`) };
    }
    if (LOCAL_ONLY[req.id]) {
      return { ...req, status: '需要本机', reason: LOCAL_ONLY[req.id] };
    }
    return { ...req, status: '已实现', reason: null };
  });
}

// ---------- C-6 numbers ----------

// runs(id INTEGER PRIMARY KEY, seat TEXT, started_at TEXT, load TEXT, had_records INTEGER)
// load: resumed (续上原会话) | loaded (装载记录) | fresh (全新对象)
export function c6Numbers(db, n = 50) {
  const rows = db.prepare('SELECT id, seat, load, had_records FROM runs ORDER BY id DESC LIMIT ?').all(n);
  const byLoad = { resumed: 0, loaded: 0, fresh: 0 };
  let other = 0;
  let blankOnExisting = 0;
  for (const row of rows) {
    if (row.load in byLoad) byLoad[row.load] += 1;
    else other += 1;
    if (row.had_records === 1 && row.load === 'fresh') blankOnExisting += 1;
  }
  return { n, total: rows.length, byLoad, other, blankOnExisting };
}

async function readC6(ledgerPath, n) {
  if (!fs.existsSync(ledgerPath)) return { available: false, reason: message(`算不出：没有台账文件 ${ledgerPath}`, `Unavailable: no ledger file ${ledgerPath}`) };
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(ledgerPath, { readOnly: true });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get();
    if (!table) return { available: false, reason: message('算不出：台账里还没有每一单的装载记录（runs 表）', 'Unavailable: ledger has no per-run loading records (runs table)') };
    return { available: true, ...c6Numbers(db, n) };
  } catch (err) {
    return { available: false, reason: message(`算不出：读台账出错：${err.message}`, `Unavailable: could not read ledger: ${err.message}`) };
  } finally {
    try { db?.close(); } catch { /* read-only handle, nothing to lose */ }
  }
}

// ---------- real-model archive ----------

function readLatestArchive(archiveDir) {
  try {
    const latest = JSON.parse(fs.readFileSync(path.join(archiveDir, 'latest.json'), 'utf8'));
    const list = Array.isArray(latest.scenarios) ? latest.scenarios : [];
    return { at: latest.at, backend: latest.backend, passed: list.filter((s) => s.passed).length, total: list.length };
  } catch {
    return null;
  }
}

function writeArchive(archiveDir, backend, scenarioList) {
  const at = new Date().toISOString();
  const record = {
    at,
    backend,
    scenarios: scenarioList.map((s) => ({ id: s.id, passed: s.passed, error: s.passed ? null : s.reason })),
  };
  fs.mkdirSync(archiveDir, { recursive: true });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  fs.writeFileSync(path.join(archiveDir, `${at.replaceAll(':', '-')}.json`), body);
  fs.writeFileSync(path.join(archiveDir, 'latest.json'), body);
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = { prd: 'doc/PRD.md', tests: 'tests/**/*.test.mjs', scenarios: 'tests/scenarios/*.scenario.mjs', archive: 'doc/prd-check-real', ledger: null, real: false, json: false, n: 50 };
  const valued = new Set(['prd', 'tests', 'scenarios', 'archive', 'ledger', 'n']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--real') opts.real = true;
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--') && valued.has(arg.slice(2))) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(message(`${arg} 后面要跟一个值`, `${arg} requires a value`));
      opts[arg.slice(2)] = value;
      i += 1;
    } else throw new Error(message(`不认识的参数 ${arg}`, `Unknown argument ${arg}`));
  }
  opts.n = Number(opts.n);
  if (!Number.isInteger(opts.n) || opts.n < 1) throw new Error(message('--n 要是正整数', '--n must be a positive integer'));
  return opts;
}

function render(report) {
  const label = (title) => /[\u4e00-\u9fff]/.test(title) ? '' : ' ' + title;
  const out = [];
  out.push(message('PRD 验收检查（node tools/prd-check.mjs）', 'PRD acceptance check (node tools/prd-check.mjs)'));
  out.push('');
  out.push(message(`端到端场景（${report.real ? '真模型' : '假后端'}）`, `End-to-end scenarios (${report.real ? 'real model' : 'fake backend'})`));
  for (const s of report.scenarios) {
    out.push(s.passed ? message(`${s.id} ${s.title}：过`, `${s.id}${label(s.title)}: passed`) : message(`${s.id} ${s.title}：没过——${s.reason}`, `${s.id}${label(s.title)}: failed — ${s.reason}`));
  }
  out.push('');
  out.push(message('需求', 'Requirements'));
  for (const r of report.requirements) {
    if (r.status === '已实现') out.push(message(`${r.id} ${r.title}：已实现`, `${r.id}${label(r.title)}: implemented`));
    else if (r.status === '需要本机') out.push(message(`${r.id} ${r.title}：需要本机——${r.reason}`, `${r.id}${label(r.title)}: requires local machine — ${r.reason}`));
    else out.push(message(`${r.id} ${r.title}：未实现——${r.reason}`, `${r.id}${label(r.title)}: not implemented — ${r.reason}`));
  }
  out.push('');
  const { scenarioPassed, scenarioTotal, implemented, localOnly, unimplemented, total } = report.summary;
  out.push(message(`场景 ${scenarioPassed}/${scenarioTotal} 过；需求 已实现 ${implemented}，需要本机 ${localOnly}，未实现 ${unimplemented}（共 ${total} 条）`, `Scenarios ${scenarioPassed}/${scenarioTotal} passed; requirements: ${implemented} implemented, ${localOnly} require local machine, ${unimplemented} not implemented (${total} total)`));
  if (report.runNotes.length) {
    out.push('');
    for (const note of report.runNotes) out.push(message(`注意：${note}`, `Note: ${note}`));
  }
  out.push('');
  out.push(message('C-6 真实数字（台账最近的单子）', 'C-6 real usage figures (recent ledger runs)'));
  const c6 = report.c6;
  if (!c6.available) out.push(c6.reason);
  else {
    out.push(message(`最近 ${c6.total} 单（取最新 ${c6.n} 单）`, `Recent ${c6.total} runs (latest ${c6.n} requested)`));
    out.push(message(`续上原会话 ${c6.byLoad.resumed}，装载记录 ${c6.byLoad.loaded}，全新对象 ${c6.byLoad.fresh}${c6.other ? `，其他 ${c6.other}` : ''}`, `Resumed ${c6.byLoad.resumed}, loaded records ${c6.byLoad.loaded}, fresh object ${c6.byLoad.fresh}${c6.other ? `, other ${c6.other}` : ''}`));
    out.push(message(`派给已有专家却空白开工：${c6.blankOnExisting}（目标 0）`, `Existing experts starting blank: ${c6.blankOnExisting} (target 0)`));
  }
  out.push('');
  const real = report.realArchive;
  out.push(real
    ? message(`最近一次真模型验收：${real.at}（${real.backend}），${real.passed}/${real.total} 个场景过`, `Latest real-model acceptance: ${real.at} (${real.backend}), ${real.passed}/${real.total} scenarios passed`)
    : message('还没有跑过真模型验收（node tools/prd-check.mjs --real）', 'No real-model acceptance run yet (node tools/prd-check.mjs --real)'));
  return out.join('\n');
}

export async function main(argv) {
  const opts = parseArgs(argv);
  const resolve = (p) => path.resolve(REPO_ROOT, p);
  const prdPath = resolve(opts.prd);
  let prdText;
  try { prdText = fs.readFileSync(prdPath, 'utf8'); } catch (err) { throw new Error(message(`读不了 PRD ${prdPath}：${err.message}`, `Could not read PRD ${prdPath}: ${err.message}`)); }
  const { scenarios, requirements } = parsePrd(prdText);
  if (requirements.length === 0) throw new Error(message(`PRD ${prdPath} 里没有解析出任何需求（要在「## 4. 需求」下，写成 **X-1 标题**）`, `No requirements parsed from PRD ${prdPath}; use **X-1 title** entries in section 4`));

  const backend = opts.real ? 'real' : 'fake';
  const scenarioRun = runSuite(opts.scenarios, backend, SCENARIO_TIMEOUT_MS, { serial: true });
  // With --real the scenarios are the only thing that runs on the real model; requirement tests stay on the fake.
  const testRun = runSuite(opts.tests, 'fake', TESTS_TIMEOUT_MS);

  const scenarioList = scenarioStatuses(scenarios, scenarioRun.results, scenarioRun.timedOut ? scenarioRun.note : null);
  const requirementList = requirementStatuses(requirements, testRun.results, scenarioList);

  const archiveDir = resolve(opts.archive);
  if (opts.real) writeArchive(archiveDir, process.env.PRD_REAL_BACKEND || 'deepseek-flash', scenarioList);

  const ledgerPath = opts.ledger ? resolve(opts.ledger) : process.env.SPECIALIST_SUBAGENTS_DB || path.join(REPO_ROOT, '.data', 'ledger.sqlite3');
  const c6 = await readC6(ledgerPath, opts.n);

  const runNotes = [];
  if (scenarioRun.timedOut) runNotes.push(message(`场景那一轮：${scenarioRun.note}`, `Scenario run: ${scenarioRun.note}`));
  if (testRun.note) runNotes.push(message(`需求测试那一轮：${testRun.note}`, `Requirement test run: ${testRun.note}`));
  // A test file that fails to load is reported as a failed result named after the file, with no tag at all.
  for (const r of testRun.results) {
    if (r.type === 'fail' && r.nesting === 0 && tagsOf(r.name).length === 0 && r.file && path.resolve(r.name) === path.resolve(r.file)) {
      runNotes.push(message(`测试文件整个没跑起来：${r.name}：${r.error ?? ''}`, `Test file could not run: ${r.name}: ${r.error ?? ''}`));
    }
  }

  const count = (status) => requirementList.filter((r) => r.status === status).length;
  const summary = {
    scenarioPassed: scenarioList.filter((s) => s.passed).length,
    scenarioTotal: scenarioList.length,
    implemented: count('已实现'),
    localOnly: count('需要本机'),
    unimplemented: count('未实现'),
    total: requirementList.length,
  };
  const ok = summary.scenarioPassed === summary.scenarioTotal && summary.implemented === summary.total;
  const report = { ok, real: opts.real, scenarios: scenarioList, requirements: requirementList, summary, runNotes, c6, realArchive: readLatestArchive(archiveDir) };

  process.stdout.write(`${opts.json ? JSON.stringify(report, null, 2) : render(report)}\n`);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(message(`prd-check 出错：${err.message}\n`, `prd-check failed: ${err.message}\n`));
      process.exitCode = 2;
    },
  );
}
