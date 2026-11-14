// The settings page (/settings): what "standard" and "heavy" (the wall's lightning bolt) mean for
// each backend, which backend and level each role uses under "best", which roles stay standard when
// the bolt is on, and the order backends fall through. It edits .data/presets.json through
// POST /presets; the repository's presets.json stays the default (presets.mjs).
//
// Same red-black personal face as the wall (page.mjs): Maple Mono for everything a machine reads,
// the serif only for the page title. The model fields offer what GET /models found, and still take
// any name typed in, because a list a CLI printed today can miss a model it accepts.
//
// Select copy on the server; keep browser scripts free of nested template literals.

export function renderSettingsHtml(lang = 'en') {
  lang = lang === 'zh' ? 'zh' : 'en';
  const copy = (zh, en) => lang === 'zh' ? zh : en;
  return `<!doctype html>
<html lang="${lang}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${copy("设置", "Settings")} · specialist-subagents</title>
<style>
  @font-face { font-family: "Maple Mono CN"; src: local("Maple Mono CN"), local("MapleMono-CN-Regular"), url(/assets/fonts/maple/MapleMono-CN-Regular.ttf); font-weight: 400; font-display: swap; }
  @font-face { font-family: "Maple Mono CN"; src: local("Maple Mono CN Medium"), local("MapleMono-CN-Medium"), url(/assets/fonts/maple/MapleMono-CN-Medium.ttf); font-weight: 600; font-display: swap; }
  :root {
    color-scheme: dark;
    --bg: #090909; --card: #141113; --fg: #f3f4f6; --dim: #b6bdc8; --line: #303640; --control: #5f6672;
    --red: #dc2239; --gold: #e3c777;
    --serif: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif;
    --mono: "Maple Mono CN", ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans SC", monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font: 13px/1.6 var(--mono); font-variant-ligatures: none; }
  header {
    position: sticky; top: 0; z-index: 2; display: flex; align-items: baseline; gap: 18px; padding: 12px 24px;
    background: linear-gradient(var(--bg), color-mix(in srgb, var(--bg) 88%, transparent)); border-bottom: 1px solid var(--line);
  }
  header a { color: var(--dim); text-decoration: none; }
  header a:hover { color: var(--fg); }
  h1 { position: relative; margin: 0; font: 600 20px/1.3 var(--serif); letter-spacing: .08em; }
  h1::after { content: ""; position: absolute; left: 0; right: 0; bottom: -5px; height: 1px; background: linear-gradient(90deg, var(--gold), transparent); }
  .status { margin-left: auto; color: var(--dim); }
  .status.bad { color: var(--red); }
  main { max-width: 1080px; margin: 0 auto; padding: 22px 24px 60px; display: grid; gap: 26px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px 18px; }
  h2 { margin: 0 0 4px; font-size: 14px; font-weight: 600; letter-spacing: .06em; }
  .hint { margin: 0 0 14px; color: var(--dim); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 400; color: var(--control); font-size: 12px; letter-spacing: .08em; padding: 0 10px 8px 0; }
  td { padding: 6px 10px 6px 0; border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent); vertical-align: middle; }
  td.name { color: var(--fg); white-space: nowrap; width: 1%; padding-right: 18px; }
  td .err { display: block; color: var(--red); font-size: 11px; }
  .pair { display: flex; gap: 6px; }
  input, select {
    font: inherit; font-size: 12px; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
    padding: 4px 8px; min-width: 0;
  }
  input { flex: 1 1 auto; width: 100%; }
  select { flex: 0 0 auto; }
  input:focus, select:focus { outline: 2px solid color-mix(in srgb, var(--fg) 40%, transparent); outline-offset: 0; }
  select:disabled { color: var(--control); }
  label.check { display: inline-flex; align-items: center; gap: 6px; color: var(--dim); font-size: 12px; cursor: pointer; white-space: nowrap; }
  .bolt { color: var(--gold); }
  .order { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .order .item { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 10px; border: 1px solid var(--line); border-radius: 9999px; }
  .order .sep { color: var(--control); }
  button {
    font: inherit; font-size: 12px; color: var(--dim); background: transparent; border: 1px solid transparent; border-radius: 9999px;
    padding: 3px 10px; cursor: pointer;
  }
  button:hover:not(:disabled) { color: var(--fg); background: color-mix(in srgb, var(--fg) 8%, transparent); }
  button:disabled { opacity: .35; cursor: default; }
  .order .item button { padding: 0 6px; }
  .actions { display: flex; align-items: center; gap: 12px; }
  .actions .primary { color: #fff; background: color-mix(in srgb, var(--red) 80%, transparent); box-shadow: 0 0 14px color-mix(in srgb, var(--red) 40%, transparent); padding: 5px 18px; }
  .actions .primary:hover { background: var(--red); color: #fff; }
  @media (max-width: 760px) {
    main { padding: 16px; }
    .pair { flex-direction: column; }
  }
  header nav { white-space: nowrap; font: 12px/1.4 var(--mono); }
  header nav a { color: var(--dim); text-decoration: none; }
  header nav a:hover { color: var(--fg); text-decoration: underline; }
</style>
<header>
  <a href="/">← ${copy("专家", "Specialists")}</a>
  <h1>${copy("设置", "Settings")}</h1>
  <span class="status" id="status">${copy("读取中…", "Loading…")}</span>
  <nav aria-label="Language"><a href="?lang=en">EN</a> / <a href="?lang=zh">&#20013;&#25991;</a></nav>
</header>
<main>
  <section>
    <h2>${copy("每家的两档", "Two tiers per provider")}</h2>
    <p class="hint">${copy("首页点一家的名字用它的标准档，点名字旁边的 <span class=\"bolt\">闪电</span> 用它的大消耗档。推理档位留空就用这家自己的默认。模型名可以从列表里选，也可以直接填。", "Click a provider for its standard tier, or <span class=\"bolt\">lightning</span> for its heavy tier. Leave reasoning blank for the provider default. Select a model or type its name.")}</p>
    <table>
      <thead><tr><th></th><th>${copy("标准", "Standard")}</th><th>${copy("大消耗", "Heavy")}</th></tr></thead>
      <tbody id="levels"></tbody>
    </table>
  </section>
  <section>
    <h2>${copy("最佳默认：每个岗位用谁", "Best default: who handles each role")}</h2>
    <p class="hint">${copy("首页选「最佳默认」时，每个岗位按这里的后端和档位跑。勾上「闪电时也用标准」的岗位，首页开了闪电也不升档，比如本来就是为了省 token 的 Handyman。", "Best default uses the backend and tier configured per role. Also use standard for lightning keeps a role on its standard tier, such as the token-saving Handyman.")}</p>
    <table>
      <thead><tr><th></th><th>${copy("后端", "Backend")}</th><th>${copy("档位", "Tier")}</th><th></th></tr></thead>
      <tbody id="best"></tbody>
    </table>
  </section>
  <section>
    <h2>${copy("顺延顺序", "Fallback order")}</h2>
    <p class="hint">${copy("选中的那家跑不起来时，按这个顺序换下一家，档位不变。DeepSeek 走 pi，轮到它就到头了，所以它应该排在最后。要联网的岗位（Web Researcher）会跳过 Codex，因为 Codex 的沙箱里没有网络。", "If a provider cannot run, try the next provider at the same tier. DeepSeek uses pi as the final fallback and should come last. Network roles skip Codex because its sandbox has no network.")}</p>
    <div class="order" id="order"></div>
  </section>
  <div class="actions">
    <button type="button" class="primary" id="save">${copy("保存", "Save")}</button>
    <button type="button" id="reload">${copy("重新读取各家的模型列表", "Refresh provider model lists")}</button>
    <span class="status" id="saved"></span>
  </div>
</main>
<script>
  var LANG = ${JSON.stringify(lang)};
  document.querySelectorAll('a[href="/settings"], a[href="/"]').forEach(function (a) { a.search = '?lang=' + LANG; });
  var KINDS = ['codex', 'grok', 'claude', 'antigravity', 'deepseek'];
  var NAMES = { codex: 'Codex', grok: 'Grok', claude: 'Claude', antigravity: 'Antigravity', deepseek: 'DeepSeek' };
  var settings = null;
  var roles = [];
  var titles = {};
  var models = null;

  function esc(text) {
    return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function setStatus(id, text, bad) {
    var el = document.getElementById(id);
    el.textContent = text;
    el.className = 'status' + (bad ? ' bad' : '');
  }
  function effortsOf(kind) {
    var seen = [];
    var list = models && models[kind] ? models[kind].models : [];
    for (var i = 0; i < list.length; i++) {
      for (var j = 0; j < (list[i].efforts || []).length; j++) {
        if (seen.indexOf(list[i].efforts[j]) < 0) seen.push(list[i].efforts[j]);
      }
    }
    return seen;
  }

  function paintLevels() {
    var html = '';
    for (var k = 0; k < KINDS.length; k++) {
      var kind = KINDS[k];
      var info = models && models[kind];
      var efforts = effortsOf(kind);
      html += '<tr><td class="name">' + NAMES[kind]
        + (info && info.error ? '<span class="err">${copy("列表读不到：", "Could not list models: ")}' + esc(info.error) + '</span>' : '')
        + (info && info.written ? '<span class="err" style="color: var(--control)">${copy("没有列模型的命令，列的是别名", "No model-list CLI; showing aliases")}</span>' : '')
        + '</td>';
      var levels = ['standard', 'max'];
      for (var l = 0; l < levels.length; l++) {
        var cur = settings.levels[kind][levels[l]];
        var effortOptions = '<option value="">${copy("默认", "default")}</option>';
        var all = efforts.slice();
        if (cur.effort && all.indexOf(cur.effort) < 0) all.push(cur.effort);
        for (var e = 0; e < all.length; e++) {
          effortOptions += '<option value="' + esc(all[e]) + '"' + (all[e] === cur.effort ? ' selected' : '') + '>' + esc(all[e]) + '</option>';
        }
        html += '<td><div class="pair">'
          + '<input list="dl-' + kind + '" data-kind="' + kind + '" data-level="' + levels[l] + '" data-field="model" value="' + esc(cur.model) + '" spellcheck="false">'
          + '<select data-kind="' + kind + '" data-level="' + levels[l] + '" data-field="effort"' + (all.length ? '' : ' disabled title="${copy("还没读到这家的推理档位", "Reasoning levels have not been discovered")}"') + '>' + effortOptions + '</select>'
          + '</div></td>';
      }
      html += '</tr>';
    }
    var lists = '';
    for (var d = 0; d < KINDS.length; d++) {
      lists += '<datalist id="dl-' + KINDS[d] + '">';
      var found = models && models[KINDS[d]] ? models[KINDS[d]].models : [];
      for (var m = 0; m < found.length; m++) lists += '<option value="' + esc(found[m].id) + '">';
      lists += '</datalist>';
    }
    document.getElementById('levels').innerHTML = html + '<tr hidden><td>' + lists + '</td></tr>';
  }

  function paintBest() {
    var html = '';
    for (var r = 0; r < roles.length; r++) {
      var role = roles[r];
      var own = settings.best[role] || { kind: settings.order[0], level: 'standard' };
      var kindOptions = '';
      for (var k = 0; k < KINDS.length; k++) {
        kindOptions += '<option value="' + KINDS[k] + '"' + (KINDS[k] === own.kind ? ' selected' : '') + '>' + NAMES[KINDS[k]] + '</option>';
      }
      var stays = settings.stay_standard.indexOf(role) >= 0;
      html += '<tr><td class="name" title="' + esc(role) + '">' + esc(titles[role] || role) + '</td>'
        + '<td><select data-role="' + role + '" data-field="kind">' + kindOptions + '</select></td>'
        + '<td><select data-role="' + role + '" data-field="level">'
        + '<option value="standard"' + (own.level === 'standard' ? ' selected' : '') + '>${copy("标准", "Standard")}</option>'
        + '<option value="max"' + (own.level === 'max' ? ' selected' : '') + '>${copy("大消耗", "Heavy")}</option></select></td>'
        + '<td><label class="check"><input type="checkbox" data-role="' + role + '" data-field="stay"' + (stays ? ' checked' : '') + '> ${copy("闪电时也用标准", "Also use standard for lightning")}</label></td></tr>';
    }
    document.getElementById('best').innerHTML = html;
  }

  function paintOrder() {
    var html = '';
    for (var i = 0; i < settings.order.length; i++) {
      if (i) html += '<span class="sep">→</span>';
      html += '<span class="item">' + NAMES[settings.order[i]]
        + '<button type="button" data-move="' + i + '" data-by="-1" aria-label="${copy("往前", "Move earlier")}"' + (i === 0 ? ' disabled' : '') + '>‹</button>'
        + '<button type="button" data-move="' + i + '" data-by="1" aria-label="${copy("往后", "Move later")}"' + (i === settings.order.length - 1 ? ' disabled' : '') + '>›</button></span>';
    }
    var el = document.getElementById('order');
    el.innerHTML = html;
    var buttons = el.querySelectorAll('button[data-move]');
    for (var b = 0; b < buttons.length; b++) {
      buttons[b].onclick = function () {
        var at = Number(this.getAttribute('data-move'));
        var to = at + Number(this.getAttribute('data-by'));
        var moved = settings.order.splice(at, 1)[0];
        settings.order.splice(to, 0, moved);
        paintOrder();
      };
    }
  }

  function paintAll() { paintLevels(); paintBest(); paintOrder(); }

  // The form is the source while editing: read it back into a settings object to save.
  function readForm() {
    var next = { order: settings.order.slice(), levels: {}, best: {}, stay_standard: [] };
    for (var k = 0; k < KINDS.length; k++) next.levels[KINDS[k]] = { standard: {}, max: {} };
    var fields = document.querySelectorAll('#levels [data-field]');
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var slot = next.levels[f.getAttribute('data-kind')][f.getAttribute('data-level')];
      if (f.getAttribute('data-field') === 'model') slot.model = f.value.trim();
      else slot.effort = f.value || null;
    }
    var bestFields = document.querySelectorAll('#best [data-field]');
    for (var j = 0; j < bestFields.length; j++) {
      var g = bestFields[j];
      var role = g.getAttribute('data-role');
      var field = g.getAttribute('data-field');
      if (field === 'stay') { if (g.checked) next.stay_standard.push(role); continue; }
      next.best[role] = next.best[role] || {};
      next.best[role][field] = g.value;
    }
    return next;
  }

  async function getJson(url) {
    var res = await fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'lang=' + LANG);
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  async function loadModels(fresh) {
    setStatus('saved', '${copy("正在问各家有哪些模型…", "Listing provider models…")}');
    try {
      models = await getJson('/models' + (fresh ? '?fresh=1' : ''));
      setStatus('saved', '${copy("模型列表读于 ", "Models listed at ")}' + new Date(models.asked_at).toLocaleTimeString());
    } catch (err) {
      setStatus('saved', '${copy("模型列表读不到：", "Could not list models: ")}' + err.message + '${copy("，模型名只能手填", "; type model names manually")}', true);
    }
    if (settings) {
      var keep = readForm();
      settings = keep;
      paintAll();
    }
  }

  async function load() {
    try {
      var got = await getJson('/presets');
      settings = got.settings;
      roles = got.roles;
      titles = got.titles || {};
      setStatus('status', '${copy("已读取", "Loaded")}');
    } catch (err) {
      setStatus('status', '${copy("读不到设置：", "Could not load settings: ")}' + err.message, true);
      return;
    }
    paintAll();
    loadModels(false);
  }

  document.getElementById('save').onclick = async function () {
    var next = readForm();
    try {
      var res = await fetch('/presets?lang=' + LANG, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) });
      var body = await res.json();
      if (!res.ok) { setStatus('saved', '${copy("没保存：", "Could not save: ")}' + (body.error || res.status), true); return; }
      settings = body.settings;
      paintAll();
      setStatus('saved', '${copy("已保存，下一单起生效", "Saved; applies to the next run")}');
    } catch (err) {
      setStatus('saved', '${copy("没保存：", "Could not save: ")}' + err.message, true);
    }
  };
  document.getElementById('reload').onclick = function () { loadModels(true); };
  load();
</script>
</html>`;
}

export const SETTINGS_HTML = renderSettingsHtml('en');
