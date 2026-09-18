/**
 * app — turns the hook stream into a room.
 *
 * Nothing here invents activity. Every light that comes on is a `SubagentStart`
 * that actually fired, every filename on a screen came out of a real
 * `tool_input.file_path`, and the verdict card only changes when the correcter
 * actually ran. If the room looks idle, the pipeline is idle.
 */

const $ = s => document.querySelector(s);
const cast = $('#cast');
const feed = $('#feed');
const feedRows = $('#feed .rows');
const feedToggle = $('#feed-toggle');
const wires = $('#wires');

// project.yml's hand-rolled parser keeps whatever a student typed around the
// name verbatim — meta.name: "เตือนการบ้าน" keeps its quote marks as part of
// the string. The data stays exactly as written; only the header and the
// project tab strip the wrapping quotes before showing it.
// Declared here, not next to brand() below, for the same reason QUEST_ICON
// moved up: buildTabs() reaches for it from the boot sequence before the
// module has finished executing top to bottom.
const unquote = s => String(s ?? '').trim().replace(/^["'“”‘’](.*)["'“”‘’]$/, '$1');

// A text ✓/✕ glyph sits at a different height per font and per browser — it
// never centred in the icon box the same way twice. Two-line SVGs do not have
// that problem: no baseline, no font metrics, dead centre every time.
// Declared this early, not next to quests() below, because applyProject() —
// which calls quests() — runs at the bottom of this file's own boot sequence,
// before the module has finished executing top to bottom. A const declared
// after that point is still in its temporal dead zone when quests() reaches
// for it, and throws before the list ever renders a single row.
const QUEST_ICON = {
  pass: '<svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 7"/></svg>',
  fail: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

// Same reasoning as QUEST_ICON above — a +/– glyph never sat centred the same
// way twice across fonts, and both the feed and the chat panel toggle between
// these two on every open/close, not just once at boot.
const TOGGLE_ICON = {
  plus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
};

// The connection-state chip. A function declaration, not a const — it is
// called from the boot sequence below before the rest of this module has
// executed, same reason QUEST_ICON had to move above that point instead of
// staying next to the code that uses it. Function declarations are hoisted
// whole, so this one is safe wherever it sits; a `const` here would not be.
function setMode(kind, text) {
  const label = { live: 'สด', replay: 'เล่นซ้ำ', reconnecting: 'กำลังต่อใหม่…' }[kind] ?? text ?? '';
  $('#mode').className = 'chip ' + kind;
  $('#mode .label').textContent = label;
}

// Where the command lines start and end. There used to be a circle drawn here
// (`#core`) so this point meant something on screen; it is gone, and a line
// that begins in empty air over the cushions read as a mistake. Anchored to
// the bottom edge instead — centred, just above the run bar — so the line
// visibly comes from "the room being told to do something" rather than from
// nowhere. The -90px lift in wire() (shared with every character point) pulls
// it up clear of the control bar without needing a special case here.
const CENTRE = { x: 50, y: 100 };

/* Score is a tally of things that actually happened. XP is tool calls, a level
   is finished handoffs, the streak is consecutive PASS verdicts from the
   correcter. None of it is invented — if the room is quiet, the score is too. */
const game = { xp: 0, acts: 0, handoffs: 0, streak: 0, best: 0, unlocked: new Set() };
const state = { stations: [], byId: new Map(), byAgent: new Map(), roster: null };

/* ── boot ───────────────────────────────────────────────────────────────── */

const res = await fetch('/state');
const boot = await res.json();
const { project, projects, active, roster, mode, transport, canRun, workspace } = boot;
state.roster = roster;
state.projects = projects ?? {};
state.active = active;
state.workspace = workspace;

setMode(mode === 'replay' ? 'replay' : 'live');

// The room art is optional — the CSS gradient set is a real fallback, not a
// broken-image placeholder, so a fresh clone with no art still teaches.
for (const candidate of ['art/room-empty.png', 'art/room-bg.png']) {
  if (await exists(candidate)) {
    $('#room').style.setProperty('--art', `url(${candidate})`);
    $('#room').classList.add('has-art');
    break;
  }
}
async function exists(url) {
  try { return (await fetch(url, { method: 'HEAD' })).ok; } catch { return false; }
}

buildCast();
applyProject(project);
scoreboard();
buildTabs();
wireScoreHelp();
wireControls(transport, canRun, mode);
wireChat(canRun);
wireBriefModal();
buildPicker();
$('#ws-path').textContent = state.workspace ?? '—';

/* ── the cast ───────────────────────────────────────────────────────────── */

function buildCast() {
  const painted = state.roster?.stations ?? [];   // desks that exist in the art
  const drawn   = state.roster?.extra ?? [];      // desks the room has to grow
  const all = [...painted, ...drawn.map(p => ({ ...p, drawDesk: true }))];
  for (const p of all) {
    const el = document.createElement('div');
    el.className = 'station';
    el.dataset.id = p.id;
    el.style.cssText = `left:${p.x}%; top:${p.y}%; --tint:${p.color}`;
    if (p.scale) el.style.setProperty('--figscale', p.scale);
    // The card opens away from the other row, never across it. Opening a
    // back-row card downwards laid it straight over the faces of the front
    // row, and a front-row card upwards did the same in reverse — the two
    // rows are the only things in the room that must never be covered.
    // Above the back row is wall and window; below the front row is empty
    // floor. Both are decided here, once, from the desk's own position.
    el.dataset.row = p.y < 60 ? 'back' : 'front';
    el.dataset.panel = p.y < 60 ? 'above' : 'below';
    el.dataset.side = p.x < 22 ? 'left' : p.x > 78 ? 'right' : 'centre';
    el.innerHTML = `
      <div class="screen">
        <em>${p.role ?? ''}</em>
        <p class="what">พร้อมรับงาน</p>
        <p class="msg"></p>
        <div class="bar"><i></i></div>
        <div class="count"><span class="acts">ลงมือ 0 ครั้ง</span><span class="clock">—</span></div>
      </div>
      <div class="figure">
        <div class="sprite"></div>
        <div class="shade"></div>
        <div class="pad"></div>
      </div>
      <div class="plate"><b>${p.name}</b></div>
      <div class="xp"><i></i></div>`;
    cast.appendChild(el);

    const station = { ...p, el, home: { x: p.x, y: p.y }, acts: 0, since: 0, timer: null };
    state.stations.push(station);
    state.byId.set(p.id, station);
    if (!state.byAgent.has(p.agent)) state.byAgent.set(p.agent, []);
    state.byAgent.get(p.agent).push(station);

    // Art is per-station and optional; a station with none keeps the neon pad.
    const art = `art/crew-${p.id}.png`;
    exists(art).then(ok => { if (ok) el.querySelector('.sprite').style.backgroundImage = `url(${art})`; });
    exists(`art/walk-${p.id}.png`).then(ok => {
      if (!ok) return;
      el.querySelector('.sprite').style.backgroundImage = `url(art/walk-${p.id}.png)`;
      el.dataset.frames = '2';
    });
  }
}

/** A role can own more than one station — `developer` builds both the client
 *  and the server, and which desk lights up is decided by the path it writes,
 *  not by a guess. */
function resolve(agent, path) {
  const options = state.byAgent.get(agent);
  if (!options?.length) return null;
  if (options.length === 1) return options[0];
  if (path) {
    const hit = options.find(o => o.pathPrefix && path.startsWith(o.pathPrefix));
    if (hit) return hit;
  }
  return options.find(o => o.el.classList.contains('busy')) ?? options[0];
}

/* ── choreography ───────────────────────────────────────────────────────── */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function wire(from, to, colour, bend = -14) {
  const r = wires.getBoundingClientRect();
  const x1 = r.width * from.x / 100, y1 = r.height * from.y / 100 - 90;
  const x2 = r.width * to.x / 100,   y2 = r.height * to.y / 100 - 90;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 + bend * 3;

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M${x1},${y1} Q${mx},${my} ${x2},${y2}`);
  path.setAttribute('stroke', colour);
  path.style.color = colour;
  const len = Math.hypot(x2 - x1, y2 - y1) * 1.25;
  path.style.strokeDasharray = `${len * .3} ${len}`;
  path.style.strokeDashoffset = len * .3;
  wires.appendChild(path);
  path.animate(
    [{ strokeDashoffset: len * .3, opacity: 0 },
     { opacity: 1, offset: .25 },
     { strokeDashoffset: -len, opacity: 0 }],
    { duration: 900, easing: 'cubic-bezier(.3,.7,.4,1)' }
  ).onfinish = () => path.remove();
}

/* `walk()` stood here. A role used to step out to the middle of the room to
   take its order and then walk back, which is five seconds of animation per
   stage and a character standing off its own cushion for most of it. The work
   is the point; the commute was not. */

async function dispatch(station) {
  const el = station.el;
  if (el.classList.contains('busy')) return;

  wire(CENTRE, station.home, station.color);
  await sleep(420);

  el.classList.add('awake', 'busy');
  dock();
  station.acts = 0;
  station.since = Date.now();
  paint(station, 'ได้รับคำสั่ง');
  tickClock(station);
}

/** Everything running right now, as a list. Laid out, so it cannot collide. */
/** Redrawn every second so the clock keeps ticking. The first version rebuilt
 *  every row's markup from scratch each tick — new elements every second, on
 *  every row, whether that row's data had changed or not — so the `rise`
 *  entrance animation (built for a row that just started existing) replayed
 *  once a second on every card, forever, which is a flicker, not a heartbeat.
 *  A row is now created once when a station goes busy and kept until it
 *  isn't; the tick only ever touches the two text nodes that actually change. */
function dock() {
  const busy = state.stations.filter(s => s.el.classList.contains('busy'));
  $('#dock').hidden = busy.length === 0;   // a box reporting nothing is not a box
  const el = $('#dock .rows');
  const busyIds = new Set(busy.map(s => s.id));

  for (const row of [...el.children]) {
    if (!busyIds.has(row.dataset.id)) row.remove();
  }

  for (const s of busy) {
    const secs = s.since ? Math.floor((Date.now() - s.since) / 1000) : 0;
    const clock = `${String(Math.floor(secs / 60)).padStart(2,'0')}:${String(secs % 60).padStart(2,'0')}`;
    const what = s.el.querySelector('.what').textContent;

    let row = el.querySelector(`.row[data-id="${s.id}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'row busy';
      row.dataset.id = s.id;
      row.style.setProperty('--tone', s.color);
      // The dot moved inside .info, next to <b>, so it lines up with the role
      // name specifically — as a grid sibling of the whole row it centred on
      // the row's full two-line height instead, floating between the name and
      // the activity text rather than sitting on either one.
      row.innerHTML = `<div class="info">
          <div class="name"><i class="dot"></i><b></b></div>
          <span class="what"></span>
        </div>
        <div class="meta"><span class="clock"></span><span class="n"></span></div>`;
      row.querySelector('b').textContent = s.name;
      el.appendChild(row);
    }
    row.querySelector('.what').textContent = what;
    row.querySelector('.clock').textContent = clock;
    row.querySelector('.n').textContent = `${s.acts} ครั้ง`;
  }
}
setInterval(dock, 1000);

/* Token cost of the current run. Students ask what a pipeline run costs, and a
   number nobody can see is a number nobody learns from. */
let watchedSession = null;

const compact = n =>
  n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' :
  n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

function brand() {
  const p = state.projects?.[state.active];
  const name = p ? `${state.active} · ${unquote(p.name)}` : '—';
  const u = state.usage;
  const cost = u && u.turns
    ? `<u class="${state.running ? 'live' : ''}">Session · ${compact(u.billable)} tokens · ${u.turns} เทิร์น</u>`
    : '';
  $('#projname').innerHTML = `<b title="${escape(name)}">${escape(name)}</b>${cost}`;
}

async function pollUsage() {
  if (!watchedSession) return;
  try {
    state.usage = await fetch('/usage?session=' + encodeURIComponent(watchedSession)).then(r => r.json());
    brand();
  } catch { /* server restarting */ }
}
setInterval(pollUsage, 4000);

function scoreboard() {
  $('#sxp').textContent = game.xp.toLocaleString('th-TH');
  $('#slv').textContent = 1 + Math.floor(game.handoffs / 2);
  $('#sst').textContent = game.streak;
  $('#sac').textContent = game.acts;
  $('#streakbox').classList.toggle('hot', game.streak >= 3);
}

/** One help icon explains all four cards, instead of a tooltip per card —
 *  the cards themselves stay click-through, same as the rest of #score, so
 *  they never steal a click meant for a character standing behind them. */
function wireScoreHelp() {
  const help = $('#score-help');
  const pop = $('#score-popover');
  let pinned = false;
  let closeTimer = null;

  const open = () => { clearTimeout(closeTimer); pop.hidden = false; help.setAttribute('aria-expanded', 'true'); };
  const close = () => { pop.hidden = true; help.setAttribute('aria-expanded', 'false'); pinned = false; };
  const scheduleClose = () => { closeTimer = setTimeout(() => { if (!pinned) close(); }, 120); };

  help.addEventListener('mouseenter', open);
  help.addEventListener('mouseleave', scheduleClose);
  pop.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  pop.addEventListener('mouseleave', scheduleClose);

  help.addEventListener('click', () => { pop.hidden ? (pinned = true, open()) : close(); });
  document.addEventListener('click', e => {
    if (!pop.hidden && !help.contains(e.target) && !pop.contains(e.target)) close();
  });
}

function award(station, amount, why) {
  game.xp += amount;
  station.xp = (station.xp ?? 0) + amount;
  // The title on the plate is the role's seniority, not a score — this crew is
  // eleven specialists, and a specialist does not level up out of being one.
  // XP still counts; it fills the bar, it does not rename anybody.
  station.el.querySelector('.xp i').style.width = `${Math.min(100, (station.xp % 400) / 4)}%`;

  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.textContent = `+${amount}`;
  // Outside .figure on purpose: the figure is mirrored with scaleX(-1) when the
  // character walks left, and anything inside it gets mirrored too — which is
  // right for a person and wrong for a number.
  station.el.appendChild(pop);
  setTimeout(() => pop.remove(), 1200);

  if (why) toast(why, station.name, station.color);
  scoreboard();
}

function toast(kind, text, tone) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.setProperty('--tone', tone ?? '#F0B45E');
  el.innerHTML = `<em>${kind}</em><strong>${escape(text)}</strong>`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4400);
}

function once(key, kind, text, tone) {
  if (game.unlocked.has(key)) return;
  game.unlocked.add(key);
  toast(kind, text, tone);
}

/* The cards used to be pushed apart here after layout, because several could
   be open at once and two neighbouring desks would overlap. Only the hovered
   card opens now, so there is never a second card to collide with — and the
   pushing code had in fact never been called from anywhere, which is its own
   lesson: machinery that guards nothing still has to be read by everyone who
   comes after. (BUILD-THIS 4.13 · retired here.) */

/* `focus()` used to live here — it marked the desk that moved last, because
   that was the one desk allowed to show its card. The card follows the mouse
   now, so nothing reads the class any more, and a class nobody reads is a
   thing the next reader still has to work out the meaning of. */

function paint(station, text) {
  station.el.querySelector('.what').textContent = text;
  dock();
  station.el.querySelector('.acts').textContent = `ลงมือ ${station.acts} ครั้ง`;
}

function tickClock(station) {
  clearInterval(station.timer);
  station.timer = setInterval(() => {
    if (!station.since) return;
    const s = Math.floor((Date.now() - station.since) / 1000);
    station.el.querySelector('.clock').textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

/** One panel per desk. The closing line replaces the activity line rather than
 *  floating a second box over it — two boxes per desk is what made eight desks
 *  unreadable. */
function say(station, text) {
  const el = station.el;
  const msg = el.querySelector('.msg');
  msg.textContent = text;
  el.classList.add('speaking');
  clearTimeout(msg._t);
  msg._t = setTimeout(() => el.classList.remove('speaking'), 5000);
}

function finish(station, text) {
  const el = station.el;
  if (text) say(station, text);
  wire(station.home, CENTRE, station.color, 14);
  el.classList.remove('busy');
  clearInterval(station.timer);
  station.since = 0;
  setTimeout(() => { el.classList.remove('awake'); dock(); }, 2600);
}

/* ── hud ────────────────────────────────────────────────────────────────── */

function applyProject(project) {
  const stages = state.roster?.stages ?? [];
  const at = stages.indexOf(project?.stage);
  $('#stages').innerHTML = stages
    .map((s, i) => `<div class="${at < 0 ? '' : i < at ? 'done' : i === at ? 'now' : ''}"><b>${s}</b></div>`)
    .join('');

  // The G1–G6 chip row that used to sit up here duplicated the checklist card
  // on the right — same data (project.gates × roster.gates), two renderings.
  // quests() below is the one that stayed.
  quests(project);
}

/** This is a fixed, project-wide checklist, not a second progress bar — the
 *  same six rows read the same way in every phase (confirmed in conversation:
 *  the list does not change with `project.stage`, only the ticks on it do).
 *  A gate that has never been ruled on is not "incomplete", it just has not
 *  come up yet, so it gets its own `future` class rather than sharing the
 *  bare look a merely-unstyled row would fall back to — the distinction the
 *  old two-state version (done / not-done) did not draw. */
function quests(project) {
  const ruled = new Map((project?.gates ?? []).map(g => [g.id, g]));
  $('#qlist').innerHTML = (state.roster?.gates ?? []).map(g => {
    const r = ruled.get(g.id);
    const cls = r?.result === 'pass' ? 'done' : r?.result === 'fail' ? 'fail' : 'future';
    const mark = r?.result === 'pass' ? QUEST_ICON.pass : r?.result === 'fail' ? QUEST_ICON.fail : '';
    const tries = r?.attempt > 1 ? `<span class="n">รอบ ${r.attempt}</span>` : '';
    return `<li class="${cls}">
      <span class="tick">${mark}</span>
      <span class="label"><b class="code">${g.id}</b><span class="title">${g.th}</span></span>
      ${tries}
    </li>`;
  }).join('');
}

/** Shorten a shell command to the part that carries meaning.
 *  A feed line reading `cd /Users/plug/Development/design-lazyyy/skills; grep -rn
 *  "REGISTER.md" --include=*.md --include=*.sh …` wrapped over four lines and
 *  said almost nothing; the verb and its target say the same thing in one. */
function shorten(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^cd\s+\S+\s*(&&|;)\s*/, '');            // drop the cd prefix
  t = t.replace(/\/Users\/[^/]+\/[^\s'"]*\/(skills|projects)\//g, '');  // absolute → relative
  t = t.replace(/\s+2>&1|\s+2>\/dev\/null|\s+\|\s*head\s+-?\d+/g, ''); // shell noise
  return t;
}

// The DOM used to be the only copy of this history — capped at 9 nodes, with
// the oldest deleted outright. "Show all" needs a real backing list, so the
// full run's entries live here instead; the DOM only ever renders a window
// into this array. Collapsed shows the last 5, expanded shows everything.
const feedHistory = [];
let feedExpanded = false;
const FEED_COLLAPSED_N = 5;
const FEED_FADE = [1, .8, .65, .6, .55]; // newest → oldest, within the visible window

function renderFeed() {
  const rows = feedExpanded ? feedHistory : feedHistory.slice(-FEED_COLLAPSED_N);
  feedRows.innerHTML = '';
  rows.forEach((html, i) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    div.title = div.textContent;        // full text on hover, one line on screen
    if (!feedExpanded) div.style.opacity = FEED_FADE[rows.length - 1 - i] ?? FEED_FADE.at(-1);
    feedRows.appendChild(div);
  });
  feedRows.scrollTop = feedRows.scrollHeight;
  feed.classList.toggle('expanded', feedExpanded);
  feedToggle.innerHTML = feedExpanded ? TOGGLE_ICON.minus : TOGGLE_ICON.plus;
  feedToggle.setAttribute('aria-expanded', String(feedExpanded));
  feedToggle.hidden = feedHistory.length <= FEED_COLLAPSED_N;
}

function log(html) {
  feedHistory.push(html);
  renderFeed();
}

feedToggle.addEventListener('click', () => {
  feedExpanded = !feedExpanded;
  renderFeed();
});

function verdict(word, note) {
  const box = $('#verdict');
  box.className = word || '';
  $('#vword').textContent = word || 'รอคำตัดสิน';
  $('#vnote').textContent = note || '';
  $('#stage').classList.toggle('blocked', word === 'BLOCKED');
}

const label = s => `<b style="color:${s.color}">${s.name}</b>`;

/* ── controller ─────────────────────────────────────────────────────────── */

const control = (action, extra = {}) =>
  fetch('/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  }).then(r => r.json()).catch(() => ({}));

/** The bar shows the one project this room is for.
 *  A row of tabs invited a mis-click mid-run — and switching is not a thing you
 *  do while a pipeline is writing files, it is a thing you do by leaving. */
function buildTabs() {
  const tabs = $('#tabs');
  const p = state.projects?.[state.active];
  if (!p) { tabs.innerHTML = '<span class="none">ยังไม่ได้เลือกโปรเจกต์</span>'; return; }
  tabs.innerHTML = `
    <span class="here" data-code="${state.active}"><b>${state.active}</b><u>${escape(unquote(p.name))}</u></span>
    <button id="leave" type="button" title="เปลี่ยนโปรเจกต์" aria-label="เปลี่ยนโปรเจกต์"><svg viewBox="0 0 24 24"><path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/></svg></button>`;
  $('#leave').addEventListener('click', () => {
    if (state.running && !confirm('สายงานกำลังทำงานอยู่ · ออกไปหน้าเลือกโปรเจกต์เลยไหม')) return;
    $('#splash').classList.remove('gone');
    $('#newproj').hidden = true;
    $('#pick').hidden = false;
    buildPicker();
  });
}

/** Mark the tab of whichever project an event belongs to. */
function markBusy(code) {
  if (!code) return;
  const tab = $(`#tabs [data-code="${CSS.escape(code)}"]`);
  if (!tab) return;
  tab.classList.add('busy');
  clearTimeout(tab._t);
  tab._t = setTimeout(() => tab.classList.remove('busy'), 8000);
}

/* ── chat ───────────────────────────────────────────────────────────────── */

/** Open the panel when there is something in it worth reading. A box that sits
 *  open all session saying "no commands yet" is furniture; one that appears when
 *  the crew speaks is a conversation. */
function openChat() {
  const box = $('#chat');
  if (!box.classList.contains('min')) return;
  box.classList.remove('min');
  $('#chat-min').innerHTML = TOGGLE_ICON.minus;
  $('#chat-min').setAttribute('aria-expanded', 'true');
}

function chatLine(who, text, isError = false) {
  openChat();
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = `msg ${who}${isError ? ' err' : ''}`;
  div.textContent = text;
  log.appendChild(div);
  while (log.children.length > 60) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function wireChat(canRun) {
  const form = $('#chat-form'), input = $('#chat-in'), send = $('#chat-send');

  if (!canRun) {
    input.disabled = send.disabled = true;
    input.placeholder = 'เปิดเซิร์ฟเวอร์ด้วย --allow-run เพื่อสั่งงานจากหน้านี้';
  }

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    send.disabled = true;
    const r = await control('say', { text });
    if (r.error) { chatLine('crew', r.error, true); send.disabled = false; }
  };

  form.addEventListener('submit', e => { e.preventDefault(); submit(); });
  // Enter sends, Shift+Enter breaks the line — a brief is often more than one.
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  $('#chat-new').addEventListener('click', async () => {
    await control('newchat');
    $('#chat-log').innerHTML = '';
  });

  $('#chat-min').addEventListener('click', () => {
    const box = $('#chat');
    box.classList.toggle('min');
    $('#chat-min').innerHTML = box.classList.contains('min') ? TOGGLE_ICON.plus : TOGGLE_ICON.minus;
    $('#chat-min').setAttribute('aria-expanded', String(!box.classList.contains('min')));
  });
}

function wireControls(transport, canRun, mode) {
  const play = $('#c-play');
  const paint = t => {
    play.textContent = t?.paused ? '▶' : '⏸';
    play.setAttribute('aria-label', t?.paused ? 'เล่น' : 'หยุดชั่วคราว');
  };
  paint(transport);

  play.addEventListener('click', async () => paint(await control(play.textContent === '▶' ? 'play' : 'pause')));
  $('#c-restart').addEventListener('click', () => control('restart'));
  for (const b of document.querySelectorAll('.speeds button')) {
    b.addEventListener('click', async () => {
      await control('speed', { value: Number(b.dataset.speed) });
      for (const o of document.querySelectorAll('.speeds button')) o.classList.toggle('on', o === b);
    });
  }

  // Rewind and speed belong to a recording. Leaving them on screen during a
  // live run — greyed out but present — read as "you can pause the work", which
  // is the one thing they cannot do. In live mode they are not there at all.
  if (mode !== 'replay') {
    $('#control .transport').hidden = true;
    $('#control .transport').previousElementSibling?.remove();
  }

  const run = $('#c-run');
  $('#c-stop').remove();               // one control, two states
  // Starting a real pipeline while a recording is on screen would show the
  // room one run and do another. A control that cannot mean what it says is
  // not offered.
  if (mode === 'replay') run.hidden = true;
  if (!canRun) {
    run.disabled = true;
    run.title = 'เปิดเซิร์ฟเวอร์ด้วย --allow-run เพื่อสั่งงานจากหน้านี้';
  }
  run.addEventListener('click', async () => {
    if (state.running) {
      if (!confirm('หยุดสายงานที่กำลังทำงานอยู่?')) return;
      const r = await control('stop');
      if (r.error) toast('หยุดไม่ได้', r.error, '#FB7185');
      return;
    }
    const r = await control('run');
    if (r.error) { toast('สั่งไม่ได้', r.error, '#FB7185'); return; }
    log('<b style="color:#34D399">สั่งสายงานทำงานแล้ว</b>');
  });
}

/* ── mission brief modal ────────────────────────────────────────────────── */

/** Text is already HTML-escaped by the time this runs, so matching against
 *  it is safe — the match itself carries no unescaped input, only <code>
 *  wrapped around a slice of already-safe text. A rough path shape (one or
 *  more `name/` segments, optionally leading with a dot, then a final
 *  segment) is enough to catch `project/project.yml`, `.claude/skills/...`,
 *  `project/REGISTER.md` without needing a real path grammar. */
function highlightPaths(escaped) {
  return escaped.replace(/\b(?:\.?[\w-]+\/)+[\w.-]+\b/g, m => `<code>${m}</code>`);
}

/** The brief used to live inline above the control bar, permanently taking
 *  the middle of the screen for something read once, if at all (see the
 *  comment where it's populated, below). A modal makes it what it actually
 *  is: detail you open on demand and close when you're done, not a fixture. */
function wireBriefModal() {
  const modal = $('#brief-modal');
  const dialog = $('#brief-dialog');
  const trigger = $('#c-brief');
  let lastFocus = null;

  const focusables = () => [...dialog.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )].filter(el => !el.disabled && el.offsetParent !== null);

  const onKeydown = e => {
    if (e.key === 'Escape') { e.preventDefault(); closeBrief(); return; }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  function openBrief() {
    lastFocus = document.activeElement;
    modal.hidden = false;
    trigger.classList.add('on');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeydown);
    ($('#brief-close')).focus();
  }

  function closeBrief() {
    modal.hidden = true;
    trigger.classList.remove('on');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKeydown);
    (lastFocus ?? trigger).focus();
  }

  trigger.addEventListener('click', () => (modal.hidden ? openBrief() : closeBrief()));
  $('#brief-close').addEventListener('click', closeBrief);
  $('#brief-backdrop').addEventListener('click', closeBrief);
}

/* ── the stream ─────────────────────────────────────────────────────────── */

/* The stream has to survive the server restarting under it — which happens
   every time the monitor itself is edited, and happened while a run was live.
   The old code wrote "disconnected" into a label and stopped there, so the room
   sat frozen next to a pipeline that was still working. */
let source;
let retry = 0;

function connect() {
  source = new EventSource('/events');

  source.onopen = () => {
    retry = 0;
    setMode(mode === 'replay' ? 'replay' : 'live');
  };

  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      // EventSource gives up on some failures; reopen it ourselves, backing off
      // so a server that is down does not get hammered.
      retry = Math.min(retry + 1, 6);
      setMode('retry', `ต่อใหม่ใน ${retry * 2}s`);
      setTimeout(connect, retry * 2000);
    } else {
      setMode('reconnecting');
    }
  };

  wireStream();
}

function wireStream() {
  source.addEventListener('project', e => applyProject(JSON.parse(e.data)));

  source.addEventListener('projects', e => {
  state.projects = JSON.parse(e.data);
  applyProject(state.projects[state.active] ?? { stage: null, gates: [] });
  buildTabs();
});

  source.addEventListener('active', e => {
  state.active = JSON.parse(e.data).code;
  buildTabs();
});

  source.addEventListener('transport', e => {
  const t = JSON.parse(e.data);
  const play = $('#c-play');
  play.textContent = t.paused ? '▶' : '⏸';
});

  source.addEventListener('chat', e => {
  const { who, text } = JSON.parse(e.data);
  chatLine(who, text);
});

    source.addEventListener('hook', e => {
    const ev = JSON.parse(e.data);

    // A run announced by the script itself — the button must reflect it whether
    // the run came from the button or from a terminal.
    if (ev.kind === 'run') {
      const run = $('#c-run');
      state.running = ev.state === 'started';
      brand();
      if (state.running) {
        run.classList.add('running');
        run.textContent = '■ หยุดสายงาน';
      } else {
        run.classList.remove('running');
        run.textContent = '▶ เริ่มทำงาน';
      }
      return;
    }

    if (ev.kind !== 'stage') return;

    // Wake the desk whose role this stage belongs to. Without this the room
    // stayed dark for the whole run, because a role driven from the shell never
    // produces the SubagentStart the characters listen for.
    const st = ev.agent ? resolve(ev.agent, null) : null;
    if (st) {
      if (ev.state === 'done') {
        finish(st, `${ev.stage} เสร็จ`);
      } else {
        dispatch(st);
        paint(st, `กำลังทำระยะ ${ev.stage}`);
      }
    }

  });

  source.addEventListener('run', e => {
    const { state: st, code } = JSON.parse(e.data);
    const run = $('#c-run');
    $('#chat-send').disabled = st === 'started';
    state.running = st === 'started';
    brand();
    if (st === 'started') {
      openChat();
      run.classList.add('running');
      run.textContent = '■ หยุดสายงาน';
      run.title = 'สายงานกำลังทำงาน · กดเพื่อหยุด';
      toast('เริ่มแล้ว', 'สายงานกำลังทำงานจริง', '#34D399');
    } else {
      run.classList.remove('running');
      run.textContent = '▶ เริ่มทำงาน';
      run.title = '';
      toast(st === 'stopped' ? 'หยุดแล้ว' : 'จบแล้ว',
            st === 'stopped' ? 'ผู้ใช้สั่งหยุด' : `จบด้วยรหัส ${code ?? '—'}`,
            st === 'stopped' ? '#F0B429' : '#F0B45E');
    }
  });

  source.addEventListener('reset', () => {
  feedHistory.length = 0;
  feedExpanded = false;
  renderFeed();
  Object.assign(game, { xp: 0, acts: 0, handoffs: 0, streak: 0, best: 0 });
  game.unlocked.clear();
  scoreboard();
  for (const s of state.stations) {
    s.xp = 0;
    s.el.querySelector('.xp i').style.width = '0%';
  }
  verdict(null, '');
  for (const s of state.stations) {
    s.el.classList.remove('awake', 'busy', 'rework');
    s.el.style.left = s.home.x + '%';
    s.el.style.top = s.home.y + '%';
    clearInterval(s.timer);
  }
});

  source.addEventListener('hook', e => {
  const ev = JSON.parse(e.data);
  markBusy(ev.project);
  if (ev.session && ev.session !== watchedSession) { watchedSession = ev.session; pollUsage(); }
  const station = ev.agent ? resolve(ev.agent, ev.path) : null;

  switch (ev.kind) {
    case 'prompt':
      log(`<b>เจ้าของโปรเจกต์</b> สั่ง — ${escape(shorten(ev.text).slice(0, 90))}`);
      // Kept, not shown. The brief is the longest thing on screen and it sat
      // across the middle of the room for the whole run; it is read once, if at
      // all. The button in the bar opens it when someone wants it.
      $('#brief-body').innerHTML = highlightPaths(escape(ev.text ?? ''));
      $('#c-brief').disabled = false;
      break;

    case 'agent_start':
      if (!station) { log(`<b>${escape(ev.agent)}</b> เริ่มทำงาน (ยังไม่มีโต๊ะของตัวเอง)`); break; }
      log(`${label(station)} ได้รับคำสั่ง`);
      dispatch(station);
      break;

    case 'tool': {
      const target = station ?? resolve(ev.agent, ev.path);
      if (ev.verdict) {
        const note = { PASS: 'ตรวจแล้ว ผ่าน', CORRECTED: 'ยังไม่ผ่าน ต้องแก้แล้วตรวจใหม่',
                       BLOCKED: 'หยุดไว้ก่อน ต้องให้คนจริงมาทำ' }[ev.verdict];
        verdict(ev.verdict, note);
        const vtone = { PASS: '#34D399', CORRECTED: '#F0B429', BLOCKED: '#FB7185' }[ev.verdict] ?? '#F0B45E';
        log(`<b style="color:${vtone}">correcter</b> — ${ev.verdict}`);
        if (ev.verdict === 'PASS') {
          game.streak++;
          game.best = Math.max(game.best, game.streak);
          game.xp += 200;
          toast('ประตูผ่าน', `correcter รับรอง · ผ่านติดกัน ${game.streak}`, '#34D399');
          if (game.streak === 3) once('s3', 'ปลดล็อก', 'ผ่านสามประตูรวด', '#34D399');
        } else {
          if (game.streak >= 3) once('broke', 'สถิติจบ', `ผ่านติดกันสูงสุด ${game.best}`, '#F0B429');
          game.streak = 0;
          if (ev.verdict === 'CORRECTED') toast('ตีกลับ', 'ตีกลับให้แก้ แล้วตรวจใหม่', '#F0B429');
          if (ev.verdict === 'BLOCKED') toast('หยุดสายงาน', 'เขียนโค้ดเพิ่มไม่ช่วย ต้องให้คนจริงมาทำ', '#FB7185');
        }
        scoreboard();
        if (ev.verdict === 'CORRECTED') {
          const back = state.stations.find(s => s.el.classList.contains('busy'));
          if (back) {
            back.el.classList.add('rework');
            wire(CENTRE, back.home, '#F0B429', 20);
            setTimeout(() => back.el.classList.remove('rework'), 1200);
          }
        }
        break;
      }
      if (!target) {
        // No agent on the event means the orchestrator itself did it. Dropping
        // these made the room look asleep while the lead was reading the repo,
        // planning, and running the correcter — which is most of a run.
        game.acts++;
        const doing = ev.path ? `${ev.tool} ${ev.path}` : `${ev.tool} ${shorten(ev.text)}`.trim();
        log(`<b style="color:#F0B45E">ORCHESTRATOR</b> <span class="meta">${escape(doing)}</span>`);
        scoreboard();
        break;
      }
      target.acts++;
      game.acts++;
      const what = ev.path ? `${ev.tool} ${ev.path}` : `${ev.tool} ${shorten(ev.text)}`.trim();
      paint(target, what);
      award(target, 10);
      if (ev.path) log(`${label(target)} <span class="meta">${escape(what)}</span>`);
      if (game.acts === 1) once('first', 'ปลดล็อก', 'ลงมือครั้งแรกของสายงาน');
      break;
    }

    case 'agent_stop': {
      if (!station) break;
      game.handoffs++;
      log(`${label(station)} ส่งงาน`);
      award(station, 50, 'ส่งงานสำเร็จ');
      finish(station, ev.text || 'เสร็จแล้ว');
      dock();
      if (game.handoffs === 1) once('h1', 'ปลดล็อก', 'ส่งไม้ต่อครั้งแรก', '#34D399');
      break;
    }

    case 'turn_end':
      break;

    case 'standing':
      log(`<b style="color:#F0B429">ยังเปิดอยู่</b> ${escape(ev.text ?? '')}`);
      $('#vnote').textContent = ev.text ?? '';
      toast('สายงานจบรอบ', 'ผ่านครบทุกด่าน', '#34D399');
      break;

    case 'session_start':
      log('<b>เปิดห้อง</b> — session เริ่มแล้ว');
      break;
  }
});
}

connect();

function escape(s) {
  return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

/* ── entrance ───────────────────────────────────────────────────────────── */

/** Choosing a project is the first thing that happens, so it happens first —
 *  before the room, not buried in a chat box behind it. */
function buildPicker() {
  const list = $('#pick-list');
  const gates = state.roster?.gates ?? [];
  list.innerHTML = Object.entries(state.projects).map(([code, p]) => {
    const ruled = new Map((p.gates ?? []).map(g => [g.id, g]));
    const dots = gates.map(g => {
      const r = ruled.get(g.id);
      return `<i class="${r?.result === 'pass' ? 'pass' : r?.result === 'fail' ? 'fail' : ''}"></i>`;
    }).join('');
    return `<button class="proj" data-code="${code}">
        <b>${code}</b>
        <span class="who"><span>${escape(p.name ?? code)}</span><em>ระยะ ${p.stage ?? 'ยังไม่เริ่ม'}</em></span>
        <span class="gates">${dots}</span>
      </button>`;
  }).join('');

  for (const b of list.querySelectorAll('.proj')) {
    b.addEventListener('click', () => enterRoom(b.dataset.code));
  }

  // A recording is not a project, and on a fresh clone there is no project to
  // click — so `--replay` had no way past this screen at all, which is exactly
  // the mode that exists to show the room without waiting for real agents.
  const replay = $('#pick-replay');
  replay.hidden = mode !== 'replay';
  if (!replay.hidden && !replay.dataset.wired) {
    replay.dataset.wired = '1';
    replay.addEventListener('click', () => enterRoom(null));
  }
}

async function enterRoom(code) {
  if (code && code !== state.active) {
    const r = await control('switch', { code });
    if (r.active) state.active = r.active;
  }
  applyProject(state.projects[state.active] ?? { stage: null, gates: [] });
  buildTabs();
  brand();
  $('#splash').classList.add('gone');
}

/* ── workspace chooser ──────────────────────────────────────────────────── */

/** The native chooser, opened by the server. Asking the browser for a folder
 *  gives a handle with no path behind it; a symlink and a shell script both
 *  need the path, so the dialog is opened on the machine instead. */
$('#ws-pick').addEventListener('click', async () => {
  const btn = $('#ws-pick');
  btn.disabled = true; btn.textContent = 'กำลังเลือก…';
  const picked = await control('pickdir');
  btn.disabled = false; btn.textContent = 'เลือกโฟลเดอร์…';

  if (picked.cancelled) return;
  if (picked.error) { toast('เลือกไม่ได้', picked.error, '#FB7185'); return; }

  const r = await control('workspace', { path: picked.path });
  if (r.error) { toast('ใช้โฟลเดอร์นี้ไม่ได้', r.error, '#FB7185'); return; }

  state.workspace = r.workspace;
  $('#ws-path').textContent = r.workspace;
  const fresh = await fetch('/state').then(x => x.json());
  state.projects = fresh.projects;
  state.active = fresh.active;
  buildPicker();
  buildTabs();
});

$('#pick-new').addEventListener('click', () => {
  // `#browse` used to be hidden here too — a hand-built folder browser, since
  // replaced by the OS's own picker (see pickdir below). Its markup went with
  // it; this line calling `.hidden` on the element that no longer exists did
  // not, and threw on every single click — the button never actually opened
  // the form underneath it.
  $('#pick').hidden = true;
  $('#newproj').hidden = false;
  $('#newproj [name=name]').focus();
});
$('#np-cancel').addEventListener('click', () => {
  $('#newproj').hidden = true;
  $('#pick').hidden = false;
});

// suggest a code from the name, but let it be overtyped
$('#newproj [name=name]').addEventListener('input', e => {
  const codeField = $('#newproj [name=code]');
  if (codeField.dataset.touched) return;
  const words = e.target.value.trim().split(/\s+/).filter(Boolean);
  codeField.value = (words.length > 1
    ? words.map(w => w[0]).join('')
    : (e.target.value.replace(/[^A-Za-z0-9ก-๙]/g, ''))
  ).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
});
$('#newproj [name=code]').addEventListener('input', e => { e.target.dataset.touched = '1'; });

$('#newproj [name=git]').addEventListener('change', e => {
  $('#remote-wrap').hidden = e.target.value !== 'remote';
});

$('#newproj').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#np-err');
  err.hidden = true;
  const data = Object.fromEntries(new FormData(e.target).entries());
  data.code = String(data.code || '').toUpperCase();
  const go = $('#np-go');
  go.disabled = true; go.textContent = 'กำลังเปิด…';

  const r = await control('create', { action: 'create', ...data });
  go.disabled = false; go.textContent = 'เปิดโครงการ';

  if (r.error) { err.textContent = r.error; err.hidden = false; return; }

  const fresh = await fetch('/state').then(x => x.json());
  state.projects = fresh.projects;
  state.active = fresh.active;
  buildPicker();
  await enterRoom(r.code);
  log(`<b style="color:#34D399">เปิดโปรเจกต์ ${escape(r.code)}</b> — ${escape(data.name)}`);
  if (r.open) toast('มีคำถามค้าง', `${r.open} ข้อยังเป็น TBD`, '#F0B429');
  if (r.git === 'init')   toast('git', 'สร้าง repo และคอมมิตแรกแล้ว', '#F0B45E');
  if (r.git === 'remote') toast('git', 'เชื่อม origin แล้ว · ยังไม่ push', '#F0B45E');
  if (typeof r.git === 'string' && r.git.startsWith('failed')) toast('git ล้มเหลว', r.git, '#FB7185');
  chatLine('crew', `เปิดโปรเจกต์ ${r.code} แล้ว · พิมพ์ /gate เพื่อดูว่ายังขาดอะไร`);
});
