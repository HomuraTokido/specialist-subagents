// The monitor page: the one user-facing surface this service has.
//
// It is a wall of staff cards rather than a table. A table answers "which rows exist"; a wall answers
// the two questions a person actually has — who is on duty, and what is each of them doing right now.
// Each card is one role: its portrait, its state, and the step every live instance is on. Several
// instances of the same role (the clone case) share the portrait and list their steps underneath,
// because that is one specialist doing several things, not several specialists.
//
// The page is dark on purpose: the portraits are night-shift scenes, and a light frame around them
// would read as a sticker pasted onto the wrong thing. The rest follows from the art: the crop takes
// the face and the screens (the desk clutter at the bottom is for the eye, not for the card), the
// caption sits under the image rather than over it, and nothing animates except the elapsed time.
//
// Colours and controls follow「マスター」's design system, Homura Interface (DESIGN.md, TOKENS.css,
// COMPONENTS.css), and nothing else of the page does: the layout, the cards, the portraits, the half-
// width log, the type and the spacing are the wall's own. Colours are its Red-Black theme, the only
// theme here: the page's colour names (--bg, --run, ...) now point at the -dark tokens, copied under
// their token names, and only the ones used. Controls take the library's shapes and states at this
// page's size: the backend choice is a segmented control, every other clickable control a text
//
// Data: the page reads GET /wall (each role's card, the header's totals, the log's names; with
// ?role= the open role's seats) and the log's new lines from /events?since=, and only after
// /events/wait says the ledger moved, at most once every 2 s. An open seat is read once from
// /seats/:id and then grows from the same new lines. It used to read the full /seats (about 108KB
// on the real ledger) and every running seat's events once a second.
//
// Template expressions select server-side copy only; inline browser scripts contain no nested template literals.

export function renderMonitorHtml(lang = 'en') {
  lang = lang === 'zh' ? 'zh' : 'en';
  const copy = (zh, en) => lang === 'zh' ? zh : en;
  return `<!doctype html>
<html lang="${lang}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${copy("专家", "Specialists")} · specialist-subagents</title>
<style>
  /* The code face (provisional, see Homura Interface DESIGN.md): Maple Mono CN, monospaced with its
     own matching CJK. An installed copy wins; otherwise the files under assets/fonts/maple/ (machine
     local, not in git); without either the stack falls back to the system's monospace. */
  @font-face { font-family: "Maple Mono CN"; src: local("Maple Mono CN"), local("MapleMono-CN-Regular"), url(/assets/fonts/maple/MapleMono-CN-Regular.ttf); font-weight: 400; font-display: swap; }
  @font-face { font-family: "Maple Mono CN"; src: local("Maple Mono CN Medium"), local("MapleMono-CN-Medium"), url(/assets/fonts/maple/MapleMono-CN-Medium.ttf); font-weight: 600; font-display: swap; }
  :root {
    color-scheme: dark;
    /* Homura Interface, Red-Black (TOKENS.css): the values this page uses, under their token names. */
    --colors-background-dark: #090909;
    --colors-surface-dark: #141113;
    --colors-primary-dark: #f3f4f6;
    --colors-secondary-dark: #b6bdc8;
    --colors-outline-dark: #303640;
    --colors-outline-control-dark: #5f6672;
    --colors-tertiary-dark: #dc2239;
    --colors-gold-dark: #e3c777;
    --material-edge-width: 1px;
    --material-edge-light-dark: rgba(255, 255, 255, 0.18);
    --components-glass-regular-dark-background-color: rgba(8, 8, 10, 0.7);
    --components-segmented-padding: 3px;
    --components-segmented-selected-dark-background-color: rgba(243, 244, 246, 0.12);
    --rounded-full: 9999px;
    --control-switch-padding: 2px;
    --control-thumb-shadow: 0 1px 3px rgba(20, 30, 50, 0.18);
    --state-hover-tint: 8%;
    --state-focus-ring-width: 3px;
    --state-focus-ring-tint: 50%;
    --motion-press-duration: 120ms;
    --motion-press-scale: 0.98;
    --motion-selection-duration: 180ms;
    --motion-expand-easing: cubic-bezier(0.2, 0.8, 0.2, 1);
    /* The wall's own colour names, each pointing at its token. On duty is gold, done is white, failed
       is red and idle is the control grey: four values that stay apart on black. */
    --bg: var(--colors-background-dark); --card: var(--colors-surface-dark);
    --fg: var(--colors-primary-dark); --dim: var(--colors-secondary-dark);
    --line: var(--colors-outline-dark); --control: var(--colors-outline-control-dark);
    --run: var(--colors-gold-dark); --ok: var(--colors-primary-dark); --bad: var(--colors-tertiary-dark);
    --accent: var(--colors-primary-dark);
    --panel: 50vw;
    /* The page header and the log panel's head share one height, so their bottom lines meet. */
    --bar: 50px;
    /* Names on the wall are worn, everything technical is printed: the serif (Homura Interface's own
       face) only for the cards' nameplates and the page title; the code face for the whole log panel
       (its names and headings included), the counts, the clocks and the controls. */
    --serif: "Source Han Serif", "Noto Serif SC", "Songti SC", "SimSun", serif;
    --mono: "Maple Mono CN", ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans SC", monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg);
    font: 13px/1.6 var(--mono);
  }
  header {
    position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
    min-height: var(--bar); padding: 12px 16px 13px;
    background: linear-gradient(var(--bg), color-mix(in srgb, var(--bg) 88%, transparent));
    border-bottom: 1px solid var(--line);
    backdrop-filter: blur(10px);
  }
  header h1 {
    position: relative; margin: 0; font: 600 20px/1.2 var(--serif); letter-spacing: .12em;
  }
  /* The one piece of gold on the screen: a short hairline under the title, jewellery-sized. */
  header h1::after {
    content: ""; position: absolute; left: 1px; bottom: -6px; width: 22px; height: 1px; background: var(--colors-gold-dark);
  }
  #counts { font-size: 12px; }
  /* A service error that lasts (HSkills' skills directory missing): one line in the failure red between
     the counts and the live dot, cut with an ellipsis so the header keeps its height; the whole
     sentence is its tooltip. */
  #alarm {
    flex: 1 1 0; min-width: 0; font-size: 12px; color: var(--bad);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #alarm[hidden] { display: none; }
  .dim { color: var(--dim); }
  .live { margin-left: auto; color: var(--dim); font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
  .live::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .live.stale::before { background: var(--bad); box-shadow: none; }
  /* Controls, from Homura Interface's COMPONENTS.css at this page's size and in its type. A choice
     among a few values is a segmented control (.hi-segmented): one carrier, the selected item a thin
     fill. Every other clickable control is a text button (.hi-button): no fill or border at rest, a
     tint on hover. All of them press slightly and share one soft focus ring; none of them uses red. */
  .seg {
    display: inline-flex; flex-wrap: wrap; gap: 2px; padding: var(--components-segmented-padding);
    background: var(--components-glass-regular-dark-background-color);
    border: var(--material-edge-width) solid var(--material-edge-light-dark); border-radius: var(--rounded-full);
  }
  .seg button, .btn {
    font: inherit; color: var(--fg); background: transparent;
    border: var(--material-edge-width) solid transparent; border-radius: var(--rounded-full); cursor: pointer;
    transition: background-color var(--motion-selection-duration) ease, transform var(--motion-press-duration) ease;
  }
  .btn:hover { background: color-mix(in srgb, var(--fg) var(--state-hover-tint), transparent); }
  .seg button[aria-pressed="true"], .btn[aria-pressed="true"] { background: var(--components-segmented-selected-dark-background-color); }
  .seg button:active, .btn:active, .switch:active { transform: scale(var(--motion-press-scale)); }
  .seg button:focus-visible, .btn:focus-visible, .switch:focus-visible {
    outline: var(--state-focus-ring-width) solid color-mix(in srgb, var(--fg) var(--state-focus-ring-tint), transparent);
    outline-offset: 0;
  }
  /* The backend choice floats over the wall, a glass capsule centred on the wall's half: it is a
     setting you reach for now and then, not a line of the page. Its current item is the page's one
     bright red. */
  #backend-controls {
    position: fixed; z-index: 4; bottom: 18px; left: calc((100vw - var(--panel)) / 2); transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px; padding: 5px 6px 5px 14px;
    background: rgba(18, 15, 16, .72); border: 1px solid rgba(255, 255, 255, .09); border-radius: var(--rounded-full);
    box-shadow: 0 14px 40px rgba(0, 0, 0, .65), inset 0 1px 0 rgba(255, 255, 255, .06);
    backdrop-filter: blur(18px) saturate(1.3);
  }
  #backend-controls .lbl { font: 12px var(--mono); color: var(--dim); white-space: nowrap; }
  #backend-controls .seg { background: transparent; border-color: transparent; padding: 0; }
  #wall { padding-bottom: 84px; }
  /* Each backend is one pill holding two buttons: its name (that backend first, standard) and a
     small lightning bolt (that backend first, heavy: the stronger model and higher effort set on
     /settings). The pill of the current choice is red; a lit bolt is gold. "Best" has no bolt: it is
     each role's own pick. */
  #backend-controls .pick { display: inline-flex; align-items: center; border-radius: var(--rounded-full); transition: background-color .15s ease, box-shadow .15s ease; }
  #backend-controls .seg .pick button { padding: 2px 11px; font-size: 12px; color: var(--dim); background: transparent; }
  #backend-controls .seg .pick .bolt {
    display: inline-grid; place-items: center; margin-left: -7px; padding: 3px 9px 3px 3px;
    color: color-mix(in srgb, var(--dim) 50%, transparent);
  }
  #backend-controls .bolt svg { display: block; width: 11px; height: 11px; fill: currentColor; }
  #backend-controls .seg .pick .bolt:hover { color: var(--fg); }
  #backend-controls .seg .pick .bolt[aria-pressed="true"] { color: #ffd36a; filter: drop-shadow(0 0 4px rgba(255, 211, 106, .75)); }
  #backend-controls .pick.on {
    background: color-mix(in srgb, var(--colors-tertiary-dark) 78%, transparent);
    box-shadow: 0 0 14px color-mix(in srgb, var(--colors-tertiary-dark) 45%, transparent);
  }
  #backend-controls .seg .pick.on .main { color: #fff; }
  #backend-controls .seg .pick.on .bolt { color: rgba(255, 255, 255, .5); }
  #backend-controls .seg .pick.on .bolt[aria-pressed="true"] { color: #ffd36a; }
  #backend-controls .gear {
    font: 12px var(--mono); color: var(--dim); text-decoration: none; padding: 2px 10px; border-radius: var(--rounded-full);
  }
  #backend-controls .gear:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) var(--state-hover-tint), transparent); }
  #wall {
    display: grid; gap: 14px; padding: 16px; align-items: stretch;
    grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
  }
  /* Every card wears its character's own colour (--role, read from the portrait once it loads; the
     control grey until then): the hover and selected frame, the on-duty glow, the nameplate's lamp
     light and the open drawer all take it. Gold stays the on-duty lamp, red stays failure.
     Cards in one row are the same height (the grid stretches them): the portrait keeps its own
     height and the facts under it take up the rest, so a card with an extra row does not leave its
     neighbours' bottom edges hanging higher. */
  .card {
    --role: var(--control);
    display: flex; flex-direction: column;
    background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
    cursor: pointer; transition: transform .12s ease, border-color .12s ease, box-shadow .2s ease;
  }
  .card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--role) 70%, transparent); }
  .card.sel { border-color: var(--role); box-shadow: 0 0 0 1px var(--role), 0 0 24px color-mix(in srgb, var(--role) 30%, transparent); }
  /* The card carries the same current state as its lamp, large enough to read across the room. A
     post on duty is framed in its own colour, and the frame works like the speaking ring on a call:
     it flares each time the post does something (a tool call, a line of output) and fades over a few
     seconds of silence, so a post that is busy keeps flickering and a post that is on duty but has
     gone quiet sits dark. --speak (0 to 1) is set from the newest event's time by paintVoices(). A
     post whose latest run failed is framed red. Portraits are never dimmed. History never colours
     a card. */
  .card.running {
    --speak: 0;
    border-color: color-mix(in srgb, var(--role) calc(45% + 55% * var(--speak)), transparent);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--role) calc(20% + 60% * var(--speak)), transparent),
      0 0 calc(8px + 30px * var(--speak)) color-mix(in srgb, var(--role) calc(8% + 40% * var(--speak)), transparent);
    transition: transform .12s ease, border-color .6s ease, box-shadow .6s ease;
  }
  .card.failed, .card.interrupted { border-color: var(--bad); }
  @media (prefers-reduced-motion: reduce) {
    .card.running { transition: none; }
  }
  .art { position: relative; background: var(--bg); }
  /* The portrait is the authoritative source: it is shown whole, at whatever ratio it was drawn in.
     The card takes the image's own shape instead of cropping it into a slot of ours. */
  .art img { display: block; width: 100%; height: auto; }
  .art .fallback {
    aspect-ratio: 4 / 5; display: none; place-items: center;
    color: var(--line); font-size: 46px; font-weight: 700; letter-spacing: .04em;
  }
  .lamp {
    position: absolute; top: 9px; right: 9px; width: 9px; height: 9px; border-radius: 50%;
    box-shadow: 0 0 0 3px rgba(0, 0, 0, .5);
  }
  .lamp.running { background: var(--run); }
  .lamp.failed, .lamp.interrupted { background: var(--bad); }
  .lamp.done { background: var(--ok); }
  .lamp.open, .lamp.closed, .lamp.unused { background: var(--control); }
  /* Under the portrait: the post's state, its current steps and its record, on a ground faintly
     tinted with the character's colour. */
  .body {
    flex: 1 1 auto;
    padding: 11px 13px 13px;
    background: linear-gradient(color-mix(in srgb, var(--role) 7%, var(--card)), var(--card) 70%);
    border-top: 1px solid color-mix(in srgb, var(--role) 28%, var(--line));
  }
  /* The post's name is a pane of glass laid on the foot of the portrait, the way Homura Interface
     does glass: the picture shows through, blurred and a little more saturated, under a dark tint;
     a 1px ring catches light on the top-left edge and falls to shadow on the bottom-right, never a
     uniform stroke. Adapted for a nameplate: smaller blur radius and shadow than a panel, and the
     lit edge takes the character's colour while the post is on duty or selected. */
  .plate {
    --edge-lit: rgba(255, 255, 255, .2);
    position: absolute; left: 10px; bottom: 10px; z-index: 0; max-width: calc(100% - 20px);
    padding: 3px 11px 4px; border-radius: 8px;
    background: color-mix(in srgb, var(--role) 8%, rgba(8, 8, 10, .5));
    -webkit-backdrop-filter: blur(12px) saturate(1.25); backdrop-filter: blur(12px) saturate(1.25);
    box-shadow: 0 6px 18px rgba(0, 0, 0, .35);
    transition: background .3s ease;
  }
  .plate::after {
    content: ""; position: absolute; inset: -1px; z-index: 2; padding: 1px; border-radius: inherit; pointer-events: none;
    background: linear-gradient(135deg, var(--edge-lit) 0%, transparent 38%, transparent 62%, rgba(0, 0, 0, .5) 100%);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude;
  }
  .card.running .plate, .card.sel .plate {
    --edge-lit: color-mix(in srgb, var(--role) 70%, rgba(255, 255, 255, .3));
    background: color-mix(in srgb, var(--role) 16%, rgba(8, 8, 10, .5));
  }
  .name {
    display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    font: 600 17px/1.3 var(--serif); letter-spacing: .05em; color: var(--fg);
    opacity: .86; transition: opacity .3s ease, text-shadow .3s ease;
  }
  .card.running .name, .card.sel .name, .card:hover .name { opacity: 1; }
  .card.running .name, .card.sel .name { text-shadow: 0 0 10px color-mix(in srgb, var(--role) 60%, transparent); }
  /* The facts under the portrait are a two-column form, not loose lines: a dim label column of
     equal width on the left, the values starting on one vertical line on the right, the same size
     and separator in every row and on every card, so the eye can run down a row of cards and
     compare. */
  .facts {
    display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 12px; margin: 0;
    font-size: 12px; line-height: 1.5; color: var(--dim); font-variant-numeric: tabular-nums;
  }
  .facts dt { color: color-mix(in srgb, var(--dim) 70%, transparent); letter-spacing: .08em; }
  .facts dd { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .facts .sep { margin: 0 .45em; opacity: .6; }
  .state.running { color: var(--run); }
  .state.failed, .state.interrupted { color: var(--bad); }
  .state.done { color: var(--ok); }
  .facts .line { display: block; overflow: hidden; text-overflow: ellipsis; }
  .facts .line.now { color: var(--fg); }
  .facts .who { color: var(--dim); margin-right: .5em; }
  #drawer {
    --role: var(--control);
    position: fixed; top: 0; right: 0; height: 100vh; width: var(--panel);
    background: var(--bg); border-left: 1px solid color-mix(in srgb, var(--role) 40%, var(--line));
    display: flex; flex-direction: column; z-index: 3;
    transition: border-color .3s ease;
  }
  /* The log panel is always there: by default it is the whole service's log, growing as work
     happens; a card narrows it to that role. The wall keeps the space to its left. */
  body { padding-right: var(--panel); }
  /* A text button keeps its words where the plain words were: its padding reaches out past them. */
  #drawer .back { margin: -2px -9px -2px auto; padding: 2px 9px; }
  #drawer .back[hidden] { display: none; }
  #stream .who { color: var(--dim); }
  #stream .at { color: var(--control); }
  #stream .task { color: var(--fg); }
  /* Output keeps its own shape; Markdown in it is shown, not spelled: bold is bold, a heading a
     small serif heading, code a quiet chip. */
  #stream b { color: var(--fg); font-weight: 600; }
  #stream b.h { font-size: 13.5px; }
  #stream code { padding: 0 4px; border-radius: 4px; background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); }
  /* Narrow (a portrait window, the DSH sidebar tab): the log comes first, right under the header,
     and the wall follows. Only the visual order changes; the wide layout pins the drawer right. */
  @media (max-width: 900px) {
    #backend-controls { left: 50%; }
    body { padding-right: 0; display: flex; flex-direction: column; }
    #drawer { position: static; width: auto; height: 60vh; border-left: 0; border-bottom: 1px solid var(--line); order: 1; }
    #backend-controls { order: 2; }
    #wall { order: 3; }
  }
  #drawer .head {
    display: flex; align-items: baseline; gap: 12px; min-height: var(--bar); padding: 14px 16px 12px;
    border-bottom: 1px solid var(--line);
  }
  #drawer .head .title { font: 600 15px/1.3 var(--mono); color: var(--fg); }
  #drawer .head .title.role { text-shadow: 0 0 14px color-mix(in srgb, var(--role) 60%, transparent); }
  #instances { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px 0; }
  #instances .btn { font-size: 12px; padding: 2px 9px; }
  #dExpertise {
    margin: 10px 16px 0; padding: 8px 10px; border-left: 2px solid color-mix(in srgb, var(--role) 70%, var(--control));
    color: var(--dim); white-space: pre-wrap; font-size: 12px;
  }
  /* The log as a terminal-style duty record. Every row is three columns: a dim clock, a gutter with
     the speaker's colour running down it like a branch line, and the content. A run opens with a
     header (face, name, task; a spinner while it runs), its tool calls are one-line breadcrumbs, its
     answer reads at full strength, and everything the service says about the run (usage, blocks,
     unfinished work, exit) folds into one footer line. */
  #stream { flex: 1; overflow: auto; padding: 10px 14px 14px 8px; word-break: break-word; font-variant-ligatures: none; }
  #stream .row { display: grid; grid-template-columns: 62px 22px minmax(0, 1fr); align-items: start; }
  #stream .row > .t { color: var(--control); font-size: 11.5px; text-align: right; padding: 1px 6px 0 0; font-variant-numeric: tabular-nums; }
  #stream .row > .g { align-self: stretch; position: relative; }
  #stream .row > .g::before {
    content: ""; position: absolute; left: 10px; top: 0; bottom: 0; width: 2px;
    background: color-mix(in srgb, var(--g, var(--control)) 55%, transparent);
  }
  #stream .row > .c { white-space: pre-wrap; padding: 1px 0; }
  #stream .row.hd { margin-top: 14px; }
  #stream .row.hd:first-child { margin-top: 0; }
  #stream .row.hd > .g::before { top: 12px; }
  #stream .row.hd > .g .av {
    position: absolute; left: 0; top: 0; width: 22px; height: 22px; border-radius: 50%;
    background: var(--card) center 16% / cover no-repeat;
    box-shadow: 0 0 0 1.5px var(--g, var(--control)), 0 0 10px color-mix(in srgb, var(--g, var(--control)) 40%, transparent);
  }
  #stream .row.hd > .c { padding: 1px 0 4px 6px; }
  #stream .hd .nm { font: 600 13px/1.4 var(--mono); color: var(--g, var(--fg)); }
  #stream .hd .task {
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    color: var(--fg); margin-top: 1px;
  }
  #stream .row.ct > .c { padding-left: 6px; }
  #stream .ct .nm { font: 600 12px/1.4 var(--mono); color: var(--g, var(--dim)); opacity: .85; }
  #stream .spin { display: none; margin-left: 8px; color: var(--g, var(--fg)); font-size: 12px; }
  #stream .spin.on { display: inline; }
  #stream .spin.on::before { content: "⠋"; animation: spin 0.9s steps(1) infinite; display: inline-block; width: 1em; }
  @keyframes spin {
    0% { content: "⠋"; } 10% { content: "⠙"; } 20% { content: "⠹"; } 30% { content: "⠸"; } 40% { content: "⠼"; }
    50% { content: "⠴"; } 60% { content: "⠦"; } 70% { content: "⠧"; } 80% { content: "⠇"; } 90% { content: "⠏"; }
  }
  #stream .row.tool > .c { padding-left: 6px; color: var(--control); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #stream .tool .tn { color: var(--dim); margin-right: 8px; }
  #stream .row.out > .c { padding-left: 6px; color: var(--fg); }
  #stream .row.meta > .c { padding-left: 6px; color: var(--control); }
  #stream .row.err > .c { padding-left: 6px; color: var(--bad); }
  #stream .row.ft > .g::before { bottom: 50%; }
  #stream .row.ft > .g::after {
    content: ""; position: absolute; left: 7px; top: calc(50% - 4px); width: 8px; height: 8px; border-radius: 50%;
    background: var(--g, var(--control));
  }
  #stream .row.ft.bad > .g::after { background: var(--bad); }
  #stream .row.ft > .c {
    margin: 3px 0 2px 6px; padding: 2px 10px; justify-self: start; border-radius: var(--rounded-full);
    background: color-mix(in srgb, var(--fg) 6%, transparent); color: var(--dim); font-size: 12px; white-space: normal;
  }
  #stream .ft .ok { color: var(--fg); }
  #stream .ft.bad .ok { color: var(--bad); }
  #stream .ft .sep { color: var(--control); margin: 0 6px; }
  #stream .row.vd > .c { padding-left: 6px; color: var(--dim); font-size: 12px; }
  #stream .row.vd.rej > .c { color: var(--bad); }
  #stream .stderr, #stream .error { color: var(--bad); }
  #stream .meta { color: var(--dim); }
  #drawer .foot {
    display: flex; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--line); color: var(--dim);
  }
  /* "Follow" is an on/off control, so it is a switch (.hi-switch): red track when on, the control grey
     when off, the thumb on the side it means. Apple's geometry, scaled to the line it sits on. */
  .switch {
    position: relative; margin-left: auto; padding: 0 0 0 32px; user-select: none; cursor: pointer;
    font: inherit; color: var(--dim); background: none; border: 0; border-radius: var(--rounded-full);
    transition: transform var(--motion-press-duration) ease;
  }
  .switch::before, .switch::after { content: ""; position: absolute; top: 50%; border-radius: var(--rounded-full); }
  .switch::before {
    left: 0; width: 26px; height: 16px; margin-top: -8px; background: var(--control);
    transition: background-color var(--motion-selection-duration) ease;
  }
  .switch::after {
    left: var(--control-switch-padding); width: 12px; height: 12px; margin-top: -6px;
    background: var(--card); box-shadow: var(--control-thumb-shadow);
    transition: transform var(--motion-selection-duration) var(--motion-expand-easing);
  }
  .switch[aria-checked="true"] { color: var(--fg); }
  .switch[aria-checked="true"]::before { background: var(--colors-tertiary-dark); }
  .switch[aria-checked="true"]::after { transform: translateX(10px); }
  header nav { white-space: nowrap; font: 12px/1.4 var(--mono); }
  header nav a { color: var(--dim); text-decoration: none; }
  header nav a:hover { color: var(--fg); text-decoration: underline; }
</style>
<header>
  <h1>${copy("专家", "Specialists")}</h1>
  <span class="dim" id="counts">…</span>
  <span id="alarm" role="alert" hidden></span>
  <span class="live" id="live">live</span>
  <nav aria-label="Language"><a href="?lang=en">EN</a> / <a href="?lang=zh">&#20013;&#25991;</a></nav>
</header>
<div id="backend-controls" title="${copy("下一单用谁：最佳默认是每个岗位各用自己配好的后端；点一家就是这家优先，闪电是这家的大消耗档；跑不起来时按设置里的顺序换下一家", "Next run: best default uses the configured backend per role; provider buttons prioritize a provider; lightning uses its heavy tier; failures follow the configured fallback order")}">
  <span class="lbl">${copy("下一单", "Next run")}</span>
  <div class="choices seg" role="group" aria-label="${copy("下一单用谁", "Backend for the next run")}">
    <span class="pick" data-kind="best"><button type="button" class="main" data-mode="best">${copy("最佳默认", "Best default")}</button></span>
    <span class="pick" data-kind="codex"><button type="button" class="main" data-mode="codex">Codex</button><button type="button" class="bolt" data-bolt="codex" aria-pressed="false" title="Codex ${copy("大消耗", "Heavy")}${copy("：换强模型、推理拉高（在设置里配）", ": stronger model and higher reasoning (configured in Settings)")}" aria-label="Codex ${copy("大消耗", "Heavy")}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.4 1 3 9.2h4.2L6.3 15 13 6.6H8.7z"/></svg></button></span>
    <span class="pick" data-kind="grok"><button type="button" class="main" data-mode="grok">Grok</button><button type="button" class="bolt" data-bolt="grok" aria-pressed="false" title="Grok ${copy("大消耗", "Heavy")}${copy("：换强模型、推理拉高（在设置里配）", ": stronger model and higher reasoning (configured in Settings)")}" aria-label="Grok ${copy("大消耗", "Heavy")}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.4 1 3 9.2h4.2L6.3 15 13 6.6H8.7z"/></svg></button></span>
    <span class="pick" data-kind="claude"><button type="button" class="main" data-mode="claude">Claude</button><button type="button" class="bolt" data-bolt="claude" aria-pressed="false" title="Claude ${copy("大消耗", "Heavy")}${copy("：换强模型、推理拉高（在设置里配）", ": stronger model and higher reasoning (configured in Settings)")}" aria-label="Claude ${copy("大消耗", "Heavy")}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.4 1 3 9.2h4.2L6.3 15 13 6.6H8.7z"/></svg></button></span>
    <span class="pick" data-kind="antigravity"><button type="button" class="main" data-mode="antigravity">Antigravity</button><button type="button" class="bolt" data-bolt="antigravity" aria-pressed="false" title="Antigravity ${copy("大消耗", "Heavy")}${copy("：换强模型、推理拉高（在设置里配）", ": stronger model and higher reasoning (configured in Settings)")}" aria-label="Antigravity ${copy("大消耗", "Heavy")}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.4 1 3 9.2h4.2L6.3 15 13 6.6H8.7z"/></svg></button></span>
    <span class="pick" data-kind="deepseek"><button type="button" class="main" data-mode="deepseek">DeepSeek</button><button type="button" class="bolt" data-bolt="deepseek" aria-pressed="false" title="DeepSeek ${copy("大消耗", "Heavy")}${copy("：换强模型、推理拉高（在设置里配）", ": stronger model and higher reasoning (configured in Settings)")}" aria-label="DeepSeek ${copy("大消耗", "Heavy")}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.4 1 3 9.2h4.2L6.3 15 13 6.6H8.7z"/></svg></button></span>
  </div>
  <a class="gear" href="/settings" title="${copy("每家标准档和大消耗档各用哪个模型，最佳默认里每个岗位用谁", "Configure provider tiers and best defaults per role")}">${copy("设置", "Settings")}</a>
</div>
<div id="wall"></div>
<aside id="drawer">
  <div class="head">
    <span class="title" id="dTitle">${copy("全部流水", "All activity")}</span>
    <span class="dim" id="dMeta"></span>
    <button type="button" class="back btn" id="dBack" hidden>${copy("全部流水", "All activity")} Esc</button>
  </div>
  <div id="dExpertise" style="display:none"></div>
  <div id="instances"></div>
  <div id="stream"></div>
  <div class="foot">
    <span id="dFoot"></span>
    <button type="button" class="switch" id="follow" role="switch" aria-checked="true">${copy("跟随", "Follow")}</button>
  </div>
</aside>
<script>
  var LANG = ${JSON.stringify(lang)};
  document.querySelectorAll('a[href="/settings"], a[href="/"]').forEach(function (a) { a.search = '?lang=' + LANG; });
  var wall = document.getElementById('wall');
  var streamEl = document.getElementById('stream');
  var drawer = document.getElementById('drawer');
  // What GET /wall last said: the roles in wall order, each role's card (store.wallView), the
  // header's totals, the names the log goes by, and the open role's seats.
  var roles = [];
  var cards = {};
  var totals = { seats: 0, running: 0, failed: 0 };
  var names = {};
  var instances = { role: null, seats: [] };
  // The newest event the last /wall read covers: the next wait starts from it.
  var ledgerSeq = 0;
  var lastRead = 0;
  var order = [];
  var cursor = 0;
  var openSeat = null;
  // The open seat as /seats/:id last returned it, and the newest of its events the log shows.
  var drawerSeat = null;
  var seatSeq = 0;
  var seatEmpty = false;
  var follow = true;
  // null = the whole service's log; a role id = that role's seats. The global log is kept here and
  // only grows: each read asks for the events after the last seq it has.
  var viewRole = null;
  // roles.json may give a role a place on the wall (wall_order, default 0); attention sorts within it.
  var wallOrder = {};
  // Each post's name as people read it (roles.json title, e.g. "Web Researcher"); the id stays for tools.
  var titles = {};
  // The wall is rebuilt from a string each second. Rebuilding when nothing changed re-created every
  // <img>, and a role without a portrait re-requested it, collapsed until the error came back, then
  // grew into its fallback: a card blinking once a second. Both are remembered instead.
  var missingArt = {};
  var lastWallHtml = '';
  // Each character's colour, read from the portrait once it has loaded: the hue of its most saturated
  // area, weighted towards the upper middle where the hair and face are (the screens around them are
  // the same teal in every scene and would make everyone the same colour). Lifted to a lightness that
  // reads on black. Until it is read, a card wears the control grey.
  var roleColor = {};
  function readRoleColor(img, role) {
    if (roleColor[role] || !img.naturalWidth) return;
    try {
      var w = 60, h = 80;
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      var px = ctx.getImageData(0, 0, w, h).data;
      // The band around the face (middle third across, upper half down) holds the hair; the screens
      // behind it are the same blue in every scene. A portrait with too little colour there (black
      // hair, a muted palette) falls back to the whole picture, and one with none keeps the grey.
      var histogram = function (x0, x1, y0, y1) {
        var bins = [];
        for (var b = 0; b < 36; b++) bins.push(0);
        for (var y = Math.floor(y0 * h); y < y1 * h; y++) {
          for (var x = Math.floor(x0 * w); x < x1 * w; x++) {
            var i = (y * w + x) * 4;
            var r = px[i] / 255, g = px[i + 1] / 255, bl = px[i + 2] / 255;
            var max = Math.max(r, g, bl), min = Math.min(r, g, bl), l = (max + min) / 2, d = max - min;
            if (d < 0.1 || l < 0.12 || l > 0.85) continue;
            var s = d / (1 - Math.abs(2 * l - 1));
            var hue = max === r ? ((g - bl) / d) % 6 : max === g ? (bl - r) / d + 2 : (r - g) / d + 4;
            bins[Math.floor(((hue * 60 + 360) % 360) / 10) % 36] += s;
          }
        }
        var top = 0;
        for (var k = 1; k < 36; k++) if (bins[k] > bins[top]) top = k;
        return { bin: top, weight: bins[top] };
      };
      var pick = histogram(0.35, 0.65, 0.1, 0.5);
      if (pick.weight < 5) pick = histogram(0, 1, 0, 1);
      if (pick.weight < 5) return;
      var best = pick.bin;
      roleColor[role] = 'hsl(' + (best * 10 + 5) + ', 72%, 68%)';
      streamEl.style.setProperty('--c-' + role, roleColor[role]);
      // Repaint after the current pass: this runs from inside paintWall's loop over the portraits.
      if (!recolourPending) {
        recolourPending = true;
        setTimeout(function () { recolourPending = false; lastWallHtml = ''; paintWall(); paintDrawerColour(); }, 0);
      }
    } catch (err) { /* a portrait the canvas cannot read keeps the grey */ }
  }
  var recolourPending = false;
  function roleStyle(role) { return roleColor[role] ? ' style="--role: ' + roleColor[role] + '"' : ''; }
  function roleOfSeat(seatId) { return String(seatId || '').replace(/^seat-/, '').replace(/-\\d+$/, ''); }
  function paintDrawerColour() {
    drawer.style.setProperty('--role', viewRole && roleColor[viewRole] ? roleColor[viewRole] : 'var(--control)');
  }
  var feed = [];
  // When each role last did anything, from the log's own timestamps; drives the speaking frame.
  var spokeAt = {};
  var VOICE_FADE_MS = 8000;
  function paintVoices() {
    var now = Date.now();
    var cardEls = wall.getElementsByClassName('card');
    for (var v = 0; v < cardEls.length; v++) {
      var el = cardEls[v];
      if (!el.classList.contains('running')) continue;
      var heard = spokeAt[el.getAttribute('data-role')];
      var speak = heard ? Math.max(0, Math.min(1, 1 - (now - heard) / VOICE_FADE_MS)) : 0;
      el.style.setProperty('--speak', speak.toFixed(2));
    }
  }
  var feedSeq = 0;
  var feedLoaded = false;
  var FEED_CAP = 2000;
  // The ledger is read again only after /events/wait says it moved, and never sooner than this
  // after the last read, however busy it is. An idle page holds one wait open per WAIT_MS.
  var MIN_GAP_MS = 2000;
  var WAIT_MS = 25000;
  var backendChoice = { mode: 'best', max: false };

  var STATE_WORD = {
    running: '${copy("在岗", "running")}', open: '${copy("待启", "starting")}', failed: '${copy("失败", "failed")}', interrupted: '${copy("中断", "interrupted")}', done: '${copy("完成", "done")}', closed: '${copy("关闭", "closed")}', unused: '${copy("还没被叫过", "never run")}'
  };
  var WORST = { running: 0, failed: 1, interrupted: 1, open: 2, done: 3, closed: 4, unused: 5 };

  function weight(state) { return WORST[state] === undefined ? 9 : WORST[state]; }
  function cardOf(role) {
    return cards[role] || { seats: 0, states: {}, latest: null, last_failed_at: null, live: [], experts: [] };
  }

  // W-1 (2026-10-11): the role's experts, opened up inside its card. What a lead wants from a role's
  // card is who of this role knows what: the expert, the object it is the expert of, how many runs it
  // has been given, and the L-4 signal that its session has grown too long to keep as one. The card's
  // look is not touched; this is one more row of facts.
  var EXPERTS_SHOWN = 3;
  function expertRow(card, role) {
    var list = card.experts || [];
    if (!list.length) return '';
    var s = '<span class="sep">·</span>';
    var html = '<dt>${copy("专家", "Specialists")}</dt><dd>';
    for (var i = 0; i < list.length && i < EXPERTS_SHOWN; i++) {
      var e = list[i];
      var who = e.name || e.object || String(e.seat).replace('seat-' + role + '-', '#');
      html += '<span class="line">' + esc(who)
        + (e.object ? s + esc(e.object) : '')
        + s + e.runs + '${copy(" 单", " runs")}'
        + (e.suggest_split ? s + '${copy("建议拆分", "split suggested")}' : '')
        + '</span>';
    }
    if (list.length > EXPERTS_SHOWN) html += '<span class="line">${copy("…另有 ", "…and ")}' + (list.length - EXPERTS_SHOWN) + '${copy(" 个", "")}</span>';
    return html + '</dd>';
  }
  // A card is about now: running if something is running, otherwise the newest seat. It used to show
  // the *worst* state in the role's whole history, which kept a card red for eight days while nothing
  // was wrong (tester: two failures from 2026-09-10) and made the wall contradict the completion
  // notice — the notice said done, the card said failed. History belongs in the drawer, not on the wall.
  // Attention (the order within a wall place) still goes by the worst state any seat of the role is in.
  function worstOf(role) {
    var states = cardOf(role).states;
    var best = 9;
    for (var state in states) if (states[state] > 0 && weight(state) < best) best = weight(state);
    return best;
  }
  function when(ts) {
    if (!ts) return '';
    var s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return Math.round(s) + '${copy(" 秒前", " seconds ago")}';
    if (s < 3600) return Math.round(s / 60) + '${copy(" 分钟前", " minutes ago")}';
    if (s < 86400) return Math.round(s / 3600) + '${copy(" 小时前", " hours ago")}';
    return Math.round(s / 86400) + '${copy(" 天前", " days ago")}';
  }
  function mmss(from, to) {
    if (!from) return '';
    var s = Math.max(0, ((to ? new Date(to) : new Date()) - new Date(from)) / 1000);
    var m = Math.floor(s / 60);
    var r = Math.floor(s % 60);
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }
  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // A live seat's current step is its last line (GET /wall carries it as last_line); a role with
  // nothing running is described well enough by its newest seat's state and time.
  function stepsFor(role) {
    var card = cardOf(role);
    var out = [];
    if (card.live.length) {
      for (var i = 0; i < card.live.length; i++) {
        var live = card.live[i];
        out.push({
          who: live.name ? live.name.replace(role + ' · ', '') : live.seat.replace('seat-' + role + '-', '#'),
          text: live.last_line || '…',
          now: true
        });
      }
      return out;
    }
    var last = card.latest;
    if (!last) return [];
    out.push({ who: '', text: '${copy("待命", "idle")}', now: false });
    return out;
  }

  function paintWall() {
    order = roles.slice().sort(function (a, b) {
      var byPlace = (wallOrder[a] || 0) - (wallOrder[b] || 0);
      if (byPlace !== 0) return byPlace;
      var byAttention = worstOf(a) - worstOf(b);
      return byAttention !== 0 ? byAttention : (a < b ? -1 : 1);
    });
    var html = '';
    for (var i = 0; i < order.length; i++) {
      var role = order[i];
      var card = cardOf(role);
      var live = card.live;
      // State and time always describe the same seat: what is running now, or the newest finished one.
      var shown = live.length ? live[0] : card.latest;
      // A post nobody has called yet is not "closed" (that reads as switched off); it is simply unused.
      var state = live.length ? 'running' : (shown ? shown.state : 'unused');
      var right = !shown
        ? ''
        : live.length
          ? (live.length > 1 ? live.length + '${copy(" 个", "")} ' : '') + mmss(shown.run_started_at || shown.opened_at)
          : when(shown.updated_at);
      // The briefing a lead actually scans for: how many of this role's runs succeeded, how many
      // failed, when the last failure was, and how long the last run took. Counts are ledger facts and
      // never colour the card — the lamp reports state, the numbers report history, so eight-day-old
      // failures inform without keeping the card red.
      var wins = card.states.done || 0;
      var losses = (card.states.failed || 0) + (card.states.interrupted || 0);
      var lastFail = card.last_failed_at;
      // that took ~14s showed 1.5s), so the number would have been wrong for every card. A real
      // duration needs the event timestamps; until then no number beats a wrong one.
      var steps = stepsFor(role);
      var stepsHtml = '';
      for (var s = 0; s < steps.length; s++) {
        stepsHtml += '<span class="line' + (steps[s].now ? ' now' : '') + '">'
          + (steps[s].who ? '<span class="who">' + esc(steps[s].who) + '</span>' : '')
          + esc(steps[s].text) + '</span>';
      }
      var sep = '<span class="sep">·</span>';
      html += '<div class="card ' + state + (role === viewRole ? ' sel' : '') + '" data-role="' + role + '"' + roleStyle(role) + '>'
        + '<div class="art">'
        + (missingArt[role]
            ? '<div class="fallback" style="display:grid">' + esc(role.slice(0, 2).toUpperCase()) + '</div>'
            : '<img src="/assets/roles/' + role + '.png" alt="">'
              + '<div class="fallback">' + esc(role.slice(0, 2).toUpperCase()) + '</div>')
        + '<span class="lamp ' + state + '"></span>'
        + '<span class="plate"><span class="name" title="' + esc(role) + '">' + esc(titles[role] || role) + '</span></span>'
        + '</div>'
        + '<div class="body">'
        + '<dl class="facts">'
        + '<dt>${copy("状态", "State")}</dt><dd><span class="state ' + state + '">' + (STATE_WORD[state] || state) + '</span>' + (right ? sep + right : '') + '</dd>'
        + '<dt>${copy("当前", "Current")}</dt><dd>' + (stepsHtml || '<span class="line">' + (card.seats ? '${copy("待命", "idle")}' : '${copy("还没有被叫过", "Never run")}') + '</span>') + '</dd>'
        + '<dt>${copy("战绩", "Record")}</dt><dd>'
        + (card.seats
            ? wins + '${copy(" 成功", " ok")}' + sep + losses + ' ${copy("失败", "fail")}'
            : '—')
        + '</dd>'
        + (lastFail ? '<dt>${copy("失败", "Last failure")}</dt><dd>${copy("最近一次 ", "")}' + when(lastFail) + '</dd>' : '')
        + expertRow(card, role)
        + '</dl>'
        + '</div></div>';
    }
    if (cursor >= order.length) cursor = Math.max(0, order.length - 1);
    if (html === lastWallHtml) { paintVoices(); return; }
    lastWallHtml = html;
    wall.innerHTML = html;
    paintVoices();
    var cardEls = wall.getElementsByClassName('card');
    for (var c = 0; c < cardEls.length; c++) {
      cardEls[c].onclick = function () { openFor(this.getAttribute('data-role')); };
    }
    // A portrait can be missing (three of the four do not exist yet): show the initials instead of a
    // broken frame. The handler is attached after the fact so the markup stays free of inline script.
    var imgs = wall.getElementsByTagName('img');
    for (var m = 0; m < imgs.length; m++) {
      imgs[m].onerror = showFallback;
      imgs[m].onload = colourFromPortrait;
      if (imgs[m].complete && imgs[m].naturalWidth === 0) showFallback.call(imgs[m]);
      else if (imgs[m].complete) colourFromPortrait.call(imgs[m]);
    }
    if (cursor >= order.length) cursor = Math.max(0, order.length - 1);
  }

  function colourFromPortrait() {
    var card = this.closest('.card');
    if (card) readRoleColor(this, card.getAttribute('data-role'));
  }
  function showFallback() {
    var card = this.closest('.card');
    if (card) missingArt[card.getAttribute('data-role')] = true;
    this.style.display = 'none';
    var box = this.parentNode.getElementsByClassName('fallback')[0];
    if (box) box.style.display = 'grid';
  }

  function nameOf(seatId) {
    return names[seatId] || seatId.replace('seat-', '');
  }
  function clock(ts) {
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  // Markdown in a runner's output is shown, not spelled: headings, bold and inline code. The text is
  // escaped first, so nothing here can open a tag of its own.
  function md(html) {
    return html
      .replace(/^#{1,4} +(.+)$/gm, '<b class="h">$1</b>')
      .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>')
      .replace(/\\x60([^\\x60\\n]+)\\x60/g, '<code>$1</code>');
  }
  // The log is rendered as a duty record (see the #stream styles). What a run says about itself
  // along the way (usage, blocks it hit, the unfinished list) is held per seat and printed once, in
  // the footer its exit closes it with. All of this state belongs to the view being drawn and is
  // reset whenever the stream is drawn from scratch (resetRecord).
  var lastSpeaker = null;
  var lastClock = '';
  var runOf = {};
  function resetRecord() { lastSpeaker = null; lastClock = ''; runOf = {}; }
  function runFor(seat) { return runOf[seat] || (runOf[seat] = { at: null, usage: null, blocks: 0, backlog: 0 }); }
  function gut(seat) { return ' style="--g: var(--c-' + roleOfSeat(seat) + ', var(--control))"'; }
  // A clock only where it changed: a run of rows in the same second shows it once.
  function clockCell(e) {
    var c = clock(e.at);
    var shown = c === lastClock ? '' : c;
    lastClock = c;
    return '<span class="t">' + shown + '</span>';
  }
  function row(cls, e, gutter, content) {
    return '<div class="row ' + cls + '"' + gut(e.seat) + ' data-seat="' + esc(e.seat) + '">'
      + clockCell(e) + '<span class="g">' + (gutter || '') + '</span><div class="c">' + content + '</div></div>';
  }
  function avatar(seat) {
    return '<span class="av" style="background-image: url(/assets/roles/' + roleOfSeat(seat) + '.png)"></span>';
  }
  // Two shapes exist: subscription runs name the model right after the output count, DeepSeek runs
  // put it in brackets after the price. The model is the first "provider/model" in brackets.
  function usageShort(text) {
    var io = /(?:\\u8f93\\u5165 (\\d+) token.*?\\u8f93\\u51fa (\\d+) token|\\binput (\\d+) tokens?.*?\\boutput (\\d+) tokens?)/i.exec(text);
    var cost = /\\$([0-9.]+)/.exec(text);
    var named = /[（(]([A-Za-z0-9.-]+\\/[A-Za-z0-9.-]+)/.exec(text);
    if (!io) return esc(text);
    var inTok = io[1] || io[3];
    var outTok = io[2] || io[4];
    var model = named ? named[1].replace(/^[A-Za-z-]+\\//, '') : '';
    return '${copy("入 ", "in ")}' + inTok + '${copy(" / 出 ", " / out ")}' + outTok
      + (cost ? '<span class="sep">·</span>$' + Number(cost[1]).toFixed(2) : '')
      + (model ? '<span class="sep">·</span>' + esc(model) : '');
  }
  function lineHtml(e, withWho) {
    if (e.body === null || e.body === undefined) return '';
    var run = runFor(e.seat);
    var html = '';
    // Another seat's line interleaved into this view: a short continuation marker says who is back.
    if (withWho && e.kind !== 'task' && e.seat !== lastSpeaker && ['stdout', 'stderr', 'exit', 'error'].indexOf(e.kind) >= 0
        && !(e.kind === 'stdout' && !String(e.body).trim())) {
      html += row('ct', e, '', '<span class="nm">' + esc(nameOf(e.seat)) + '</span>');
      lastSpeaker = e.seat;
    }
    var body = String(e.body);
    switch (e.kind) {
      case 'task':
        run.at = e.at; run.usage = null; run.blocks = 0; run.backlog = 0;
        lastSpeaker = e.seat;
        return html + row('hd', e, avatar(e.seat),
          '<span class="nm">' + esc(nameOf(e.seat)) + '</span><span class="spin" data-seat="' + esc(e.seat) + '" data-seq="' + e.seq + '"></span>'
          + '<div class="task">' + esc(body) + '</div>');
      case 'stdout': {
        if (!body.trim()) return html;
        var tool = /^· (\\S+)\\s*(.*)$/.exec(body);
        if (tool) return html + row('tool', e, '', '<span class="tn">⏺ ' + esc(tool[1]) + '</span>' + esc(tool[2]));
        return html + row('out', e, '', md(esc(body)));
      }
      case 'usage': run.usage = body; return html;
      case 'difficulty': run.blocks += 1; return html;
      case 'backlog': run.backlog = Math.max(1, body.split('\\n').length - 1); return html;
      case 'runner': case 'session': case 'cwd':
        return withWho ? html : html + row('meta', e, '', esc(body));
      case 'exit': {
        var ok = body === '0';
        var took = run.at ? mmss(run.at, e.at) : '';
        var parts = ['<span class="ok">' + (ok ? '${copy("✓ 结束", "✓ done")}' : '${copy("✗ 退出码 ", "✗ exit code ")}' + esc(body)) + '</span>'];
        if (took) parts.push(took);
        if (run.usage) parts.push(usageShort(run.usage));
        if (run.blocks) parts.push('${copy("受阻 ", "blocked ")}' + run.blocks + '${copy(" 次", " times")}');
        if (run.backlog) parts.push('${copy("未完成 ", "unfinished ")}' + run.backlog + '${copy(" 条", " items")}');
        return html + row('ft' + (ok ? '' : ' bad'), e, '', parts.join('<span class="sep">·</span>'));
      }
      case 'verdict':
        return html + row('vd' + (/^rejected/.test(body) ? ' rej' : ''), e, '', '${copy("验收 · ", "verdict · ")}' + esc(body));
      case 'stderr': case 'error': case 'cancelled': case 'interrupted':
        return html + row('err', e, '', esc(body));
      // A run that started without its skill because HSkills' skills directory is missing says so in
      // a skill event marked \\u9519\\u8bef\\uff1a (skill-loop.mjs); that one is red, every other skill event plain.
      case 'skill':
        return html + row(/^(?:\\u9519\\u8bef\\uff1a|Error: )/.test(body) ? 'err' : 'meta', e, '', esc(body));
      default:
        return html + row('meta', e, '', esc(body));
    }
  }
  // A header's spinner turns while its run is on: the seat is running and this is its newest header.
  function paintSpinners() {
    var running = {};
    for (var r in cards) for (var i = 0; i < cards[r].live.length; i++) running[cards[r].live[i].seat] = true;
    var spins = streamEl.getElementsByClassName('spin');
    var newest = {};
    for (var s = 0; s < spins.length; s++) {
      var seat = spins[s].getAttribute('data-seat');
      if (!newest[seat] || Number(spins[s].getAttribute('data-seq')) > Number(newest[seat].getAttribute('data-seq'))) newest[seat] = spins[s];
    }
    for (var t = 0; t < spins.length; t++) {
      var on = running[spins[t].getAttribute('data-seat')] && newest[spins[t].getAttribute('data-seat')] === spins[t];
      spins[t].className = on ? 'spin on' : 'spin';
    }
  }

  function showGlobal() {
    viewRole = null;
    openSeat = null;
    drawerSeat = null;
    seatSeq = 0;
    document.getElementById('dTitle').textContent = '${copy("全部流水", "All activity")}';
    document.getElementById('dMeta').textContent = '';
    document.getElementById('dBack').hidden = true;
    document.getElementById('dExpertise').style.display = 'none';
    document.getElementById('instances').innerHTML = '';
    document.getElementById('dFoot').textContent = '${copy("所有座位 · 有动作就往下长", "All seats · appends on new activity")}';
    document.getElementById('dTitle').className = 'title';
    paintDrawerColour();
    resetRecord();
    var html = '';
    for (var i = 0; i < feed.length; i++) html += lineHtml(feed[i], true);
    streamEl.innerHTML = html || '<span class="meta">${copy("（还没有任何动作）", "(No activity yet)")}</span>';
    paintSpinners();
    if (follow) streamEl.scrollTop = streamEl.scrollHeight;
    paintWall();
  }

  // Clicking the role already shown goes back to the global log.
  function openFor(role) {
    if (viewRole === role) { showGlobal(); return; }
    var card = cardOf(role);
    var pick = card.live.length ? card.live[0].seat : (card.latest ? card.latest.seat : null);
    if (!pick) return;
    viewRole = role;
    openSeat = pick;
    drawerSeat = null;
    document.getElementById('dBack').hidden = false;
    document.getElementById('dTitle').className = 'title role';
    paintDrawerColour();
    paintWall();
    paintInstances(role);
    loadSeat();
    // The role's seats come with /wall?role=; until they arrive the instance row stays empty.
    readWall().then(function () { if (viewRole === role) paintInstances(role); });
  }

  // The log's new lines. In the whole-service view they all go in; with a card open, only the open
  // seat's, after the last one its own read already showed.
  async function pullFeed() {
    var fresh;
    try {
      fresh = await getJson(feedLoaded ? '/events?since=' + feedSeq : '/events?tail=300');
    } catch (err) { return []; }
    feedLoaded = true;
    if (!fresh.length) return fresh;
    feedSeq = fresh[fresh.length - 1].seq;
    for (var f = 0; f < fresh.length; f++) {
      var heard = Date.parse(fresh[f].at);
      var speaker = roleOfSeat(fresh[f].seat);
      if (heard && !(spokeAt[speaker] >= heard)) spokeAt[speaker] = heard;
    }
    paintVoices();
    feed = feed.concat(fresh);
    if (feed.length > FEED_CAP) feed = feed.slice(feed.length - FEED_CAP);
    var atBottom = streamEl.scrollTop + streamEl.clientHeight >= streamEl.scrollHeight - 30;
    var html = '';
    if (viewRole === null) {
      if (feed.length === fresh.length) { streamEl.innerHTML = ''; resetRecord(); } // the first lines replace the empty-state note
      for (var i = 0; i < fresh.length; i++) html += lineHtml(fresh[i], true);
    } else if (drawerSeat) {
      html = seatLines(fresh);
      if (html && seatEmpty) { streamEl.innerHTML = ''; seatEmpty = false; }
    }
    if (!html) return fresh;
    streamEl.insertAdjacentHTML('beforeend', html);
    paintSpinners();
    if (follow && atBottom) streamEl.scrollTop = streamEl.scrollHeight;
    return fresh;
  }
  function seatLines(events) {
    var html = '';
    for (var i = 0; i < events.length; i++) {
      if (events[i].seat !== openSeat || events[i].seq <= seatSeq) continue;
      html += lineHtml(events[i], false);
      seatSeq = events[i].seq;
    }
    return html;
  }

  // Directory experts are named after their directory and listed first; the one-shot seats from
  // before 2026-09-22 have nothing left to reuse and fold away behind one button.
  var showLegacy = false;
  function paintInstances(role) {
    var box = document.getElementById('instances');
    var list = instances.role === role ? instances.seats : [];
    if (list.length < 2) { box.innerHTML = ''; return; }
    var experts = [];
    var legacy = [];
    for (var i = 0; i < list.length; i++) (list[i].name ? experts : legacy).push(list[i]);
    var prefix = role + ' · ';
    var label = function (s) {
      if (s.name) return s.name.indexOf(prefix) === 0 ? s.name.slice(prefix.length) : s.name;
      return s.seat.replace('seat-' + role + '-', '#');
    };
    var shown = experts.slice();
    for (var j = 0; j < legacy.length; j++) {
      if (showLegacy || legacy[j].seat === openSeat || legacy[j].state === 'running') shown.push(legacy[j]);
    }
    var html = '';
    for (var k = 0; k < shown.length; k++) {
      html += '<button type="button" class="btn" aria-pressed="' + (shown[k].seat === openSeat ? 'true' : 'false') + '" data-seat="' + shown[k].seat + '">'
        + esc(label(shown[k])) + ' · ' + (STATE_WORD[shown[k].state] || shown[k].state) + '</button>';
    }
    if (legacy.length) {
      html += '<button type="button" class="btn more" aria-expanded="' + (showLegacy ? 'true' : 'false') + '" data-more="1">'
        + (showLegacy ? '${copy("收起一次性座位", "Hide one-shot seats")}' : '${copy("一次性座位", "One-shot seats")} ' + legacy.length + '${copy(" 个", "")}') + '</button>';
    }
    box.innerHTML = html;
    var buttons = box.getElementsByTagName('button');
    for (var b = 0; b < buttons.length; b++) {
      buttons[b].onclick = function () {
        if (this.getAttribute('data-more')) { showLegacy = !showLegacy; paintInstances(role); return; }
        openSeat = this.getAttribute('data-seat'); drawerSeat = null; paintInstances(role); loadSeat();
      };
    }
  }

  // The open seat, read once: its row and newest events. After this its lines come from the log's
  // new lines, and the row is read again (without events) only when the seat itself moved.
  async function loadSeat() {
    if (!openSeat) return;
    var wanted = openSeat;
    var full;
    try {
      full = await getJson('/seats/' + encodeURIComponent(wanted));
    } catch (err) {
      showGlobal();
      return;
    }
    if (wanted !== openSeat || viewRole === null) return;
    showSeat(full.seat);
    var atBottom = streamEl.scrollTop + streamEl.clientHeight >= streamEl.scrollHeight - 30;
    resetRecord();
    var html = '';
    var events = full.events || [];
    for (var i = 0; i < events.length; i++) html += lineHtml(events[i], false);
    seatSeq = events.length ? events[events.length - 1].seq : 0;
    if (full.events_omitted > 0) {
      html = '<span class="meta">${copy("（更早的 ", "(")}' + full.events_omitted + '${copy(" 条事件没有显示，只列最新的 ", " earlier events omitted; showing the latest ")}' + events.length + '${copy(" 条）", ")")}</span>\\n' + html;
    }
    html += seatLines(feed); // lines that reached the log while this was being read
    streamEl.innerHTML = html || '<span class="meta">${copy("（还没有输出）", "(No output yet)")}</span>';
    paintSpinners();
    seatEmpty = !html;
    if (follow && atBottom) streamEl.scrollTop = streamEl.scrollHeight;
  }
  async function loadSeatRow() {
    var wanted = openSeat;
    var full;
    try {
      full = await getJson('/seats/' + encodeURIComponent(wanted) + '?tail=0');
    } catch (err) { return; }
    if (wanted === openSeat && viewRole !== null) showSeat(full.seat);
  }
  function showSeat(seat) {
    drawerSeat = seat;
    var expertiseEl = document.getElementById('dExpertise');
    expertiseEl.textContent = seat.expertise || '';
    expertiseEl.style.display = seat.expertise ? '' : 'none';
    paintSeatMeta();
  }
  // Called every second as well: a running seat's elapsed time is the one thing that moves.
  function paintSeatMeta() {
    if (viewRole === null || !drawerSeat) return;
    var seat = drawerSeat;
    document.getElementById('dTitle').textContent = seat.name || seat.id;
    document.getElementById('dMeta').textContent = [
      seat.role,
      'owner=' + (seat.owner || '-'),
      'cwd=' + (seat.cwd || '-'),
      'pid=' + (seat.pid === null || seat.pid === undefined ? '-' : seat.pid),
      seat.state === 'open' ? '${copy("未启动", "never run")}' : (seat.state === 'running' ? mmss(seat.run_started_at || seat.opened_at) + '${copy(" 已跑", " elapsed")}' : mmss(seat.run_started_at || seat.opened_at, seat.updated_at) + '${copy(" 用时", " duration")}')
    ].join(' · ');
    document.getElementById('dFoot').textContent = STATE_WORD[seat.state] || seat.state;
  }

  async function getJson(url) {
    var res = await fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'lang=' + LANG);
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  function setLive(ok) {
    document.getElementById('live').textContent = ok ? 'live' : '${copy("服务不可达", "unreachable")}';
    document.getElementById('live').className = ok ? 'live' : 'live stale';
  }

  // The header's error line while HSkills' skills directory is missing (/wall's hskills): the short
  // sentence in red, the whole one with the fix on hover. Gone as soon as /wall says it is there.
  // hskillsOk is what the header shows now; /events/wait answers with the service's current value.
  var hskillsOk = true;
  function paintAlarm(hskills) {
    var alarm = document.getElementById('alarm');
    hskillsOk = !hskills || hskills.ok !== false;
    alarm.textContent = hskillsOk ? '' : (hskills.brief || hskills.error || '');
    alarm.title = hskillsOk ? '' : (hskills.error || '');
    alarm.hidden = hskillsOk;
  }

  // GET /wall: every card, the header's counts and the names the log goes by; with a card open, that
  // role's seats as well.
  async function readWall() {
    var view;
    try {
      view = await getJson('/wall?recent=1' + (viewRole !== null ? '&role=' + encodeURIComponent(viewRole) : ''));
    } catch (err) {
      setLive(false);
      return false;
    }
    setLive(true);
    ledgerSeq = view.ledger_seq;
    var nextRoles = [];
    var nextCards = {};
    var nextOrder = {};
    for (var i = 0; i < view.roles.length; i++) {
      var entry = view.roles[i];
      nextRoles.push(entry.role);
      nextCards[entry.role] = entry;
      nextOrder[entry.role] = entry.wall_order || 0;
      if (entry.title) titles[entry.role] = entry.title;
    }
    roles = nextRoles;
    cards = nextCards;
    wallOrder = nextOrder;
    totals = view.totals || totals;
    names = view.names || {};
    if (view.instances) instances = view.instances;
    var due = view.difficulties ? view.difficulties.due : 0;
    var pendingCandidates = view.candidates ? view.candidates.pending : 0;
    document.getElementById('counts').textContent =
      '${copy("在岗", "active")} ' + totals.running + ' · ${copy("历史失败", "failed runs")} ' + totals.failed + '${copy(" · 共 ", " · ")}' + totals.seats + '${copy(" 个座位", " seat(s)")}'
      + (due ? ' · ${copy("困难待裁决", "difficulties to decide")} ' + due + '${copy(" 类", " categories")}' : '')
      + (pendingCandidates ? ' · ${copy("skill 候选待核对", "skill candidate to review")} ' + pendingCandidates + '${copy(" 个", "")}' : '');
    paintAlarm(view.hskills);
    paintWall();
    return true;
  }

  // One read: the log's new lines first (so /wall's names cover them), then /wall, then the open
  // seat's row if that seat started a run or changed state.
  async function refresh() {
    lastRead = Date.now();
    var fresh = await pullFeed();
    if (!(await readWall())) return;
    paintSpinners();
    if (viewRole === null || !openSeat || !drawerSeat) return;
    var moved = false;
    for (var i = 0; i < fresh.length; i++) if (fresh[i].seat === openSeat && fresh[i].kind === 'task') moved = true;
    if (instances.role === viewRole) {
      for (var j = 0; j < instances.seats.length; j++) {
        var s = instances.seats[j];
        if (s.seat === openSeat && (s.state !== drawerSeat.state || s.updated_at !== drawerSeat.updated_at)) moved = true;
      }
    }
    if (moved) await loadSeatRow();
  }

  // Wait for the ledger to move, then read it; a wait that times out with nothing new costs one short
  // answer. When the service cannot be reached the page says so and tries again every MIN_GAP_MS.
  // A wait whose hskills_ok differs from the header is read too: HSkills can go missing or come back
  // while the ledger stands still.
  async function watch() {
    for (;;) {
      var woke = null;
      try {
        woke = await getJson('/events/wait?since=' + ledgerSeq + '&timeoutMs=' + WAIT_MS);
        setLive(true);
      } catch (err) {
        setLive(false);
      }
      if (woke && !woke.changed && (woke.hskills_ok === undefined || woke.hskills_ok === hskillsOk)) continue;
      var gap = lastRead + MIN_GAP_MS - Date.now();
      if (gap > 0) await new Promise(function (resolve) { setTimeout(resolve, gap); });
      await refresh();
    }
  }

  function paintBackendPreference() {
    var picks = document.querySelectorAll('#backend-controls .pick');
    for (var i = 0; i < picks.length; i++) {
      var kind = picks[i].getAttribute('data-kind');
      var on = kind === backendChoice.mode;
      picks[i].classList.toggle('on', on);
      picks[i].querySelector('.main').setAttribute('aria-pressed', on ? 'true' : 'false');
      var bolt = picks[i].querySelector('.bolt');
      if (bolt) bolt.setAttribute('aria-pressed', on && backendChoice.max ? 'true' : 'false');
    }
  }

  async function loadBackendPreference() {
    try {
      var saved = await getJson('/backend');
      if (saved && saved.mode) backendChoice = { mode: saved.mode, max: !!saved.max };
    } catch (err) { /* default highlight is Best */ }
    paintBackendPreference();
  }

  async function chooseBackend(next) {
    try {
      var res = await fetch('/backend?lang=' + LANG, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next)
      });
      if (!res.ok) throw new Error(String(res.status));
      var saved = await res.json();
      backendChoice = { mode: saved.mode, max: !!saved.max };
      paintBackendPreference();
    } catch (err) { /* keep the last confirmed selection */ }
  }
  // The name picks that backend and keeps its bolt as it was; the bolt picks that backend and turns
  // its heavy level on, or off when it was already on.
  var mains = document.querySelectorAll('#backend-controls .main');
  for (var mi = 0; mi < mains.length; mi++) {
    mains[mi].onclick = function () {
      var mode = this.getAttribute('data-mode');
      chooseBackend({ mode: mode, max: mode === backendChoice.mode ? backendChoice.max : false });
    };
  }
  var bolts = document.querySelectorAll('#backend-controls .bolt');
  for (var bo = 0; bo < bolts.length; bo++) {
    bolts[bo].onclick = function () {
      var mode = this.getAttribute('data-bolt');
      chooseBackend({ mode: mode, max: !(mode === backendChoice.mode && backendChoice.max) });
    };
  }
  loadBackendPreference();

  var followEl = document.getElementById('follow');
  function paintFollow() { followEl.setAttribute('aria-checked', follow ? 'true' : 'false'); }
  document.getElementById('dBack').onclick = showGlobal;
  followEl.onclick = function () {
    follow = !follow;
    paintFollow();
    if (follow) streamEl.scrollTop = streamEl.scrollHeight;
  };
  paintFollow();
  streamEl.addEventListener('scroll', function () {
    if (streamEl.scrollTop + streamEl.clientHeight < streamEl.scrollHeight - 30 && follow) {
      follow = false;
      paintFollow();
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { showGlobal(); return; }
    if (!order.length) return;
    var step = (event.key === 'ArrowRight' || event.key === 'ArrowDown') ? 1
      : (event.key === 'ArrowLeft' || event.key === 'ArrowUp') ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    cursor = Math.min(order.length - 1, Math.max(0, cursor + step));
    openFor(order[cursor]);
  });

  document.getElementById('dFoot').textContent = '${copy("所有座位 · 有动作就往下长", "All seats · appends on new activity")}';
  refresh().then(watch);
  // Between reads only time moves: the elapsed clocks and "minutes ago" tick here from what was read.
  setInterval(function () { paintWall(); paintSeatMeta(); }, 1000);
</script>
</html>`;
}

export const MONITOR_HTML = renderMonitorHtml('en');
