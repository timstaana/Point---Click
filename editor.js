/* Story Editor — dev tool for the design team (modern browsers only;
 * the game never loads this).
 *
 * ONE SCREEN, node-first. The map is a puzzle-dependency chart in the
 * player's own terms:
 *
 *   Node map (left)   — every node is a STEP (something the player
 *                       does: "take key", "unlock door to garden",
 *                       "make fishingrod"); every wire means "needs
 *                       this first", labelled with the item (or ⚑flag)
 *                       that carries it. Rooms are containers, not
 *                       steps: walking isn't progress, so plain exits
 *                       are thin one-way arrows between rooms (one per
 *                       direction — exits are hotspots on one side),
 *                       while a locked door is a step whose wire OPENS
 *                       the next room. Every cutscene is its own
 *                       "watch …" step: the trigger wires INTO it, and
 *                       what it causes (revealed pickups, opened
 *                       rooms) flows OUT of it — the map shows the
 *                       order the player experiences. Drag a node to
 *                       arrange (persists in editor-layout.json); drag
 *                       from a node's ● onto another to connect; click
 *                       a wire, ✕ removes it. "Tidy" re-lays the map
 *                       out as the walkthrough.
 *   Context pane (right) — whatever the selection needs: room things
 *                       get the stage (draw/move hotspot areas) above
 *                       their inspector; cutscenes get the step editor
 *                       with a stage preview; items/flags their usage;
 *                       START the game settings.
 *   Status strip (bottom) — live issue counts; click for the drawer
 *                       listing story problems and missing art/sounds.
 *
 * Everything derivable from the naming conventions is automatic:
 * room bg/idle/can't-use, pickup grab clips, walk-in clips, gate cels,
 * and hold times (from the WAV's real length). Dropdowns are scoped by
 * the same conventions — art named to the scene sorts to the top.
 * Save rewrites scenes.js via the dev server (a timestamped backup
 * lands in backups/) and stores node positions in editor-layout.json,
 * which the game never loads. */

(function () {
'use strict';

/* ---------- game data ---------- */

const SCENES = window.SCENES || {};
const CUTSCENES = window.CUTSCENES || {};
const COMBINE = window.COMBINE || [];
let COMBINE_HINT = window.COMBINE_HINT || '';
let START_CUT = window.START_CUTSCENE || '';
let START_ROOM = window.START_ROOM || Object.keys(SCENES)[0] || '';

/* ---------- editor state ---------- */

let assets = { images: [], sounds: [], soundMs: {} };
let mapSel = null;      // selected node's ref — drives the whole side pane
let wireSel = null;     // selected wire (edge key "from>to")
let room = SCENES[START_ROOM] ? START_ROOM : Object.keys(SCENES)[0];
let sel = -1;           // hotspot index on the stage (synced with mapSel)
let csPreviewStep = 0;  // which cutscene step the stage previews
let dirty = false;
let stageScale = 1;
let drawerOpen = false;

// node positions + viewport, persisted to editor-layout.json on save
let LAYOUT = { nodes: {}, view: null };
let view = { x: 40, y: 40, k: 1 };

const mapSvg = document.getElementById('map');
const mapWrap = document.getElementById('mapwrap');
const inspector = document.getElementById('inspector');
const stagebox = document.getElementById('stagebox');
const stage = document.getElementById('stage');
const ctx = stage.getContext('2d');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const imgCache = {};

function markDirty() {
  dirty = true;
  statusEl.textContent = 'unsaved';
  statusEl.style.color = '#fc6';
}
window.onbeforeunload = () => (dirty ? 'Unsaved changes' : undefined);

/* ---------- tiny DOM helpers ---------- */

function el(tag, attrs, parent) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    if (k === 'text') e.textContent = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k.slice(0, 2) === 'on') e[k] = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  (parent || document.body).appendChild(e);
  return e;
}

function word(parent, txt) { return el('span', { class: 'w', text: txt }, parent); }
function line(parent) { return el('div', { class: 'line' }, parent); }

function sec(parent, color, title) {
  const d = el('div', { class: 'sec ' + color }, parent);
  if (title) el('h3', { text: title }, d);
  return d;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const toList = v => (Array.isArray(v) ? v : v ? [v] : []);

const NAME_RE = /^[a-zA-Z]\w*$/;

/* ---------- naming conventions (one place, used everywhere) ---------- */

const conv = {
  bg:      r => 'bg_' + r + '.png',
  idle:    r => 'char_' + r + '_idle.png',
  cantUse: r => 'char_' + r + '_cant_use.png',
  pick:    (r, item) => 'char_' + r + '_pick_' + item + '.png',
  arrive:  (to, from) => 'char_' + to + '_from_' + from + '.png',
  itemCel: (r, item) => 'item_' + r + '_' + item + '.png',
  icon:    item => 'icon_' + item + '.png',
  gate:    (id, state) => 'gate_' + id + '_' + state + '.png'
};

/* ---------- asset helpers ---------- */

function hasArt(f) { return assets.images.indexOf(f) >= 0; }
function hasSound(f) { return assets.sounds.indexOf(f) >= 0; }

function stageArt() {
  return assets.images.filter(f => !/^(icon_|cursor_|ui_)/.test(f));
}

// Grouped dropdown options: each tier is [label, [prefixes]]; files match
// the first tier that claims them, leftovers land in "other art". Art
// named to the room sorts to the top of its dropdown automatically.
function artGroups(tiers) {
  const all = stageArt();
  const used = {};
  const groups = [];
  tiers.forEach(t => {
    const opts = all.filter(f => !used[f] && t[1].some(p => f.indexOf(p) === 0));
    opts.forEach(f => { used[f] = 1; });
    if (opts.length) groups.push({ label: t[0], options: opts });
  });
  const rest = all.filter(f => !used[f]);
  if (rest.length) groups.push({ label: 'other art', options: rest });
  return groups;
}

const tapClips   = r => artGroups([['this room — looks', ['char_' + r + '_look_']],
                                   ['this room — exits', ['char_' + r + '_exit_']],
                                   ['this room', ['char_' + r + '_']]]);
const useClips   = r => artGroups([['this room — item use', ['char_' + r + '_use_']],
                                   ['this room', ['char_' + r + '_']]]);
const pickClipsG = r => artGroups([['this room — pickups', ['char_' + r + '_pick_']],
                                   ['this room', ['char_' + r + '_']]]);
const objClips   = r => artGroups([['this room — overlays', ['obj_' + r + '_']],
                                   ['overlays', ['obj_']]]);
const arriveClips = t => artGroups([['walk-ins', ['char_' + t + '_from_']],
                                    ['room ' + t, ['char_' + t + '_']]]);
const cutBgClips   = () => artGroups([['cutscene art', ['cut_']], ['backgrounds', ['bg_']]]);
const cutCharClips = () => artGroups([['cutscene art', ['cut_']], ['characters', ['char_']]]);

// Sounds scoped by the vo_<room>_ / vo_generic_ convention.
function soundGroups(r) {
  const g = [];
  const used = {};
  const grab = (label, test) => {
    const opts = assets.sounds.filter(f => !used[f] && test(f));
    opts.forEach(f => { used[f] = 1; });
    if (opts.length) g.push({ label, options: opts });
  };
  grab('this room', f => f.indexOf('vo_' + r + '_') === 0);
  grab('generic lines', f => f.indexOf('vo_generic_') === 0);
  grab('effects', f => f.indexOf('vo_') !== 0);
  grab('other rooms', () => true);
  return g;
}

/* ---------- durations ---------- */

function clipLen(name) {
  const m = name && window.SHEETS && window.SHEETS[name];
  return m && !m.loop ? m.frames * m.dur : 0;
}

function soundLen(name) {
  return Math.ceil(((assets.soundMs || {})[name] || 0) / 100) * 100;
}

// hold time: only written when the voice line outlasts the clip
function autoHold(holder, animName, durKey, soundName) {
  const ms = soundLen(soundName);
  if (soundName && ms > clipLen(animName)) holder[durKey] = ms;
  else delete holder[durKey];
}

/* ---------- object model ---------- */

/* Only two shapes: a "pickup" (an item lying in the room) and a "spot"
 * (everything else). What used to be separate Exit / Needs-item types
 * is now just properties of a spot: WHERE its tap leads ("afterwards")
 * and whether a LOCK wraps it. The data shapes stay exactly what the
 * engine expects — a lock is stored as the gate/locked/open form. */

function objType(o) { return o.item ? 'pickup' : 'spot'; }
function isLocked(o) { return !!(o.gate || o.locked || o.states || o.needs); }

// the holder of the plain tap action: the gate's open state, or o itself
function tapHolder(o) {
  return (o.gate || o.locked) ? (o.open = o.open || {}) : o;
}

function goTarget(then) {
  return then && then.indexOf('go:') === 0 ? then.slice(3) : null;
}

// Wrap a spot's tap action in a lock: the action moves into the gate's
// `open` state, so nothing the user set up is lost.
function lockHotspot(o, needsItem, rn) {
  if (o.gate || o.locked) return;
  rn = rn || room;
  const open = {};
  ['anim', 'objAnim', 'sound', 'dur', 'then', 'entryAnim', 'entryDur',
   'cursor', 'setFlag', 'setFlagValue', 'clearFlag'].forEach(k => {
    if (k in o) { open[k] = o[k]; delete o[k]; }
  });
  const t = goTarget(open.then);
  o.gate = rn + '_' + (t ? t + 'door' : 'lock');
  o.locked = {};
  if (needsItem) o.locked.needs = needsItem;
  if (o.needs) { o.locked.needs = o.needs; delete o.needs; }
  if (open.cursor) o.locked.cursor = open.cursor;
  o.open = open;
}

// Remove the lock: the open-state action flattens back onto the spot.
function unlockHotspot(o) {
  const open = o.open || {};
  delete o.gate; delete o.locked; delete o.open;
  delete o.states; delete o.state; delete o.needs;
  Object.keys(open).forEach(k => { o[k] = open[k]; });
}

function objectCel(o, rn) {
  if (o.item) return conv.itemCel(rn || room, o.item);
  if (o.gate) return conv.gate(o.gate, 'closed');
  if (o.src) return o.src;
  return null;
}

// Labels are derived from what the spot DOES, not a stored type.
function objectLabel(o, i) {
  if (o.item) return 'pickup: ' + o.item;
  const act = (o.gate || o.locked) ? (o.open || {}) : o;
  const lock = isLocked(o) ? ' 🔒' : '';
  const g = goTarget(act.then);
  if (g) return 'exit → ' + g + lock;
  if (act.then && act.then.indexOf('cut:') === 0) return 'cutscene: ' + act.then.slice(4) + lock;
  if (act.then && act.then.indexOf('pick:') === 0) return 'gives: ' + act.then.slice(5) + lock;
  if (isLocked(o)) return 'locked: ' + (o.gate || (o.locked && o.locked.needs) || '#' + (i + 1));
  // name look spots after their clip: char_<room>_look_<thing>.png
  const clip = act.anim || act.objAnim || '';
  const at = clip.indexOf('_look_');
  if (at >= 0) return 'look: ' + clip.slice(at + 6).replace(/\.png$/, '');
  return 'look #' + (i + 1);
}

// bg / idle / can't-use follow the naming convention automatically
function ensureRoomDefaults(name) {
  const s = SCENES[name];
  if (!s.bg) s.bg = conv.bg(name);
  if (!s.idle) s.idle = conv.idle(name);
  if (!s.failAnim) s.failAnim = conv.cantUse(name);
}

function bbox(area) {
  const a = area || [0, 0, 100, 100];
  let [minX, minY, maxX, maxY] = a;
  for (let i = 4; i + 1 < a.length; i += 2) {
    minX = Math.min(minX, a[i]); maxX = Math.max(maxX, a[i]);
    minY = Math.min(minY, a[i + 1]); maxY = Math.max(maxY, a[i + 1]);
  }
  return [minX, minY, maxX, maxY];
}

/* ---------- stable hotspot ids ----------
 * Every hotspot gets a durable `id` (saved into scenes.js; the engine
 * ignores it). Node positions and selections key off these ids, so
 * they survive reordering, deletion and area changes. */

function ensureIds() {
  const taken = {};
  Object.keys(SCENES).forEach(rn => {
    (SCENES[rn].objects || []).forEach(o => { if (o.id) taken[o.id] = 1; });
  });
  Object.keys(SCENES).forEach(rn => {
    (SCENES[rn].objects || []).forEach(o => {
      if (o.id) return;
      let n = 1;
      while (taken['hs_' + rn + '_' + n]) n++;
      o.id = 'hs_' + rn + '_' + n;
      taken[o.id] = 1;
    });
  });
}

function newHotspot(rn, props) {
  const o = props || {};
  SCENES[rn].objects.push(o);
  ensureIds();
  return o;
}

/* ---------- spot states ----------
 * Hotspots that share the SAME area are one spot with several STATES —
 * the engine picks whichever one's flag conditions hold (that is how a
 * fountain can give the coin once and say "it's empty" ever after).
 * The editor shows the pile as a single spot with state chips instead
 * of confusing stacked rectangles. */

function areaKey(o) { return bbox(o.area).join(','); }

function groupIndices(idx) {
  const objs = SCENES[room].objects || [];
  const key = areaKey(objs[idx]);
  const out = [];
  objs.forEach((o, i) => { if (areaKey(o) === key) out.push(i); });
  return out;
}

// group hotspot indices by shared area, in first-seen order
function areaGroups(objs) {
  const groups = {};
  const order = [];
  (objs || []).forEach((o, i) => {
    const k = areaKey(o);
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(i);
  });
  return order.map(k => groups[k]);
}

function whenSummary(o) {
  const conds = toList(o.when).filter(c => c && c.flag);
  if (!conds.length) return 'always';
  return 'when ' + conds.map(c => (c.value === false ? 'not ' : '') + c.flag).join(' & ');
}

/* ---------- cross-reference index ----------
 * One walk over the data collects where every item and flag is
 * produced and consumed, and where every cutscene is triggered from.
 * A "ref" points back at the owning thing and can be jumped to. */

// Visit every action-holder (hotspot + its locked/open/item-reaction
// sub-actions, and each cutscene) with a ref to its owner.
function forEachActionHolder(cb) {
  Object.keys(SCENES).forEach(rn => {
    (SCENES[rn].objects || []).forEach((o, i) => {
      const ref = { kind: 'hotspot', room: rn, idx: i };
      cb(o, ref);
      if (o.locked) cb(o.locked, ref);
      if (o.open) cb(o.open, ref);
      [o, o.locked, o.open].forEach(h => {
        if (h && h.items) Object.keys(h.items).forEach(id => {
          if (h.items[id] && typeof h.items[id] === 'object') cb(h.items[id], ref);
        });
      });
    });
  });
  Object.keys(CUTSCENES).forEach(cn => {
    cb(CUTSCENES[cn], { kind: 'cutscene', name: cn });
  });
}

function buildRefs() {
  const items = {};
  const flags = {};
  const cutUses = {};
  const item = id => items[id] ||
    (items[id] = { found: [], made: [], given: [], needed: [], reactions: [], parts: [] });
  const flag = f => flags[f] || (flags[f] = { set: [], cleared: [], checked: [] });

  forEachActionHolder((h, ref) => {
    toList(h.when).forEach(c => { if (c && c.flag) flag(c.flag).checked.push(ref); });
    toList(h.setFlag).forEach(f => flag(f).set.push(ref));
    toList(h.clearFlag).forEach(f => flag(f).cleared.push(ref));
    if (h.needs) item(h.needs).needed.push(ref);
    if (h.items) Object.keys(h.items).forEach(id => item(id).reactions.push(ref));
    if (h.then && h.then.indexOf('pick:') === 0) item(h.then.slice(5)).given.push(ref);
    if (h.then && h.then.indexOf('cut:') === 0) {
      const c = h.then.slice(4);
      (cutUses[c] || (cutUses[c] = [])).push(ref);
    }
  });
  Object.keys(SCENES).forEach(rn => {
    (SCENES[rn].objects || []).forEach((o, i) => {
      if (o.item) item(o.item).found.push({ kind: 'hotspot', room: rn, idx: i });
    });
  });
  COMBINE.forEach((c, i) => {
    const ref = { kind: 'recipe', idx: i };
    (c.parts || []).forEach(p => { if (p) item(p).parts.push(ref); });
    if (c.makes) item(c.makes).made.push(ref);
  });
  if (START_CUT) (cutUses[START_CUT] || (cutUses[START_CUT] = [])).push({ kind: 'start' });
  return { items, flags, cutUses };
}

function collectItems() { return Object.keys(buildRefs().items).sort(); }
function collectFlags() { return Object.keys(buildRefs().flags).sort(); }

/* ---------- jump-links ---------- */

function whereLabel(ref) {
  if (ref.kind === 'hotspot') {
    const o = (SCENES[ref.room] || {}).objects || [];
    return ref.room + ' · ' + (o[ref.idx] ? objectLabel(o[ref.idx], ref.idx) : '?');
  }
  if (ref.kind === 'room') return 'room ' + ref.room;
  if (ref.kind === 'cutscene') return 'cutscene ' + ref.name;
  if (ref.kind === 'recipe') {
    const c = COMBINE[ref.idx] || {};
    return 'recipe ' + ((c.parts || []).join(' + ') || '#' + (ref.idx + 1));
  }
  if (ref.kind === 'start') return 'game start';
  return '?';
}

function refChip(parent, ref) {
  el('span', { class: 'ref', text: whereLabel(ref), onclick: () => mapSelect(ref) }, parent);
}

function refChips(parent, refs, emptyText) {
  if (!refs || !refs.length) {
    if (emptyText) el('span', { class: 'muted', text: emptyText }, parent);
    return;
  }
  const seen = {};
  refs.forEach(r => {
    const key = whereLabel(r);
    if (seen[key]) return;
    seen[key] = 1;
    refChip(parent, r);
  });
}

/* ---------- validation ---------- */

// Art + sound files each thing needs. Derived names (item cel, icon,
// gate trio) follow the same rules as the engine.
function hotspotFiles(o, rn) {
  const art = {};
  const sounds = {};
  (JSON.stringify(o).match(/[\w\-]+\.png/g) || []).forEach(f => { art[f] = 1; });
  (JSON.stringify(o).match(/[\w\-]+\.wav/g) || []).forEach(f => { sounds[f] = 1; });
  if (o.item) {
    art[conv.itemCel(rn, o.item)] = 1;
    art[conv.icon(o.item)] = 1;
    art[o.anim || conv.pick(rn, o.item)] = 1;
  }
  if (o.gate) ['closed', 'use', 'open'].forEach(s => { art[conv.gate(o.gate, s)] = 1; });
  return { art: Object.keys(art), sounds: Object.keys(sounds) };
}

// Every missing file across the whole game -> [{file, refs}]
function missingFiles() {
  const need = {};
  const add = (f, ok, ref) => {
    if (!f || ok) return;
    if (!need[f]) need[f] = [];
    need[f].push(ref);
  };
  Object.keys(SCENES).forEach(rn => {
    const s = SCENES[rn];
    ensureRoomDefaults(rn);
    const roomRef = { kind: 'room', room: rn };
    [s.bg, s.idle, s.failAnim].forEach(f => add(f, hasArt(f), roomRef));
    (s.objects || []).forEach((o, i) => {
      const ref = { kind: 'hotspot', room: rn, idx: i };
      const files = hotspotFiles(o, rn);
      files.art.forEach(f => add(f, hasArt(f), ref));
      files.sounds.forEach(f => add(f, hasSound(f), ref));
    });
  });
  Object.keys(CUTSCENES).forEach(cn => {
    const ref = { kind: 'cutscene', name: cn };
    const cs = CUTSCENES[cn];
    (JSON.stringify(cs).match(/[\w\-]+\.png/g) || []).forEach(f => add(f, hasArt(f), ref));
    (JSON.stringify(cs).match(/[\w\-]+\.wav/g) || []).forEach(f => add(f, hasSound(f), ref));
  });
  COMBINE.forEach((c, i) => {
    if (c.makes) add(conv.icon(c.makes), hasArt(conv.icon(c.makes)), { kind: 'recipe', idx: i });
  });
  if (COMBINE_HINT) add(COMBINE_HINT, hasSound(COMBINE_HINT), { kind: 'start' });
  return Object.keys(need).sort().map(f => ({ file: f, refs: need[f] }));
}

function computeIssues() {
  const out = [];
  const R = buildRefs();
  Object.keys(R.flags).sort().forEach(f => {
    const x = R.flags[f];
    if (x.checked.length && !x.set.length) {
      out.push({ level: 'error', text: 'flag "' + f + '" is required but nothing ever sets it',
                 refs: x.checked });
    }
    if (x.set.length && !x.checked.length) {
      out.push({ level: 'note', text: 'flag "' + f + '" is set but never checked',
                 refs: x.set });
    }
  });
  Object.keys(R.items).sort().forEach(id => {
    const x = R.items[id];
    const sources = x.found.length + x.made.length + x.given.length;
    const uses = x.needed.length + x.reactions.length + x.parts.length;
    if (uses && !sources) {
      out.push({ level: 'error', text: 'item "' + id + '" is needed but can never be obtained',
                 refs: x.needed.concat(x.reactions, x.parts) });
    }
    if (sources && !uses) {
      out.push({ level: 'note', text: 'item "' + id + '" is obtainable but never used',
                 refs: x.found.concat(x.made, x.given) });
    }
  });
  forEachActionHolder((h, ref) => {
    const g = goTarget(h.then);
    if (g && !SCENES[g]) {
      out.push({ level: 'error', text: 'leads to unknown room "' + g + '"', refs: [ref] });
    }
    if (h.then && h.then.indexOf('cut:') === 0 && !CUTSCENES[h.then.slice(4)]) {
      out.push({ level: 'error', text: 'plays unknown cutscene "' + h.then.slice(4) + '"',
                 refs: [ref] });
    }
  });
  if (!SCENES[START_ROOM]) {
    out.push({ level: 'error', text: 'start room "' + START_ROOM + '" does not exist',
               refs: [{ kind: 'start' }] });
  }
  if (START_CUT && !CUTSCENES[START_CUT]) {
    out.push({ level: 'error', text: 'start cutscene "' + START_CUT + '" does not exist',
               refs: [{ kind: 'start' }] });
  }
  COMBINE.forEach((c, i) => {
    if (!(c.parts && c.parts[0] && c.parts[1] && c.makes)) {
      out.push({ level: 'error', text: 'combine recipe is incomplete',
                 refs: [{ kind: 'recipe', idx: i }] });
    }
  });
  return out;
}

/* ---------- generic inputs ----------
 * All pickers refresh the whole UI on change; mutation callbacks own
 * their data edit, the picker marks dirty (unless opts.nav — pure
 * navigation). */

function selectInput(groups, value, onchange, opts) {
  opts = opts || {};
  const s = document.createElement('select');
  const flat = [];
  if (opts.blank !== false) el('option', { value: '', text: opts.blank || '(none)' }, s);
  const norm = (groups.length && groups[0] && groups[0].options !== undefined)
    ? groups : [{ label: null, options: groups }];
  norm.forEach(g => {
    const parent = g.label ? el('optgroup', { label: g.label }, s) : s;
    g.options.forEach(o => {
      flat.push(o);
      const opt = el('option', { value: o, text: opts.labelFn ? opts.labelFn(o) : o }, parent);
      if (o === value) opt.selected = true;
    });
  });
  if (value && flat.indexOf(value) === -1) {
    el('option', { value: value, text: value + ' (missing!)' }, s).selected = true;
  }
  s.onchange = () => {
    onchange(s.value);
    previewAsset(s.value); // hear/see the choice immediately
    if (!opts.nav) markDirty();
    refresh();
  };
  return s;
}

// Name dropdown with an inline "+ new…" that turns into a text input —
// no prompt() dialogs anywhere.
function namePicker(options, value, onchange, opts) {
  opts = opts || {};
  const s = document.createElement('select');
  if (opts.blank !== false) el('option', { value: '', text: opts.blank || '(none)' }, s);
  options.forEach(o => {
    const op = el('option', { value: o, text: o }, s);
    if (o === value) op.selected = true;
  });
  if (value && options.indexOf(value) === -1) {
    el('option', { value: value, text: value }, s).selected = true;
  }
  el('option', { value: '*new*', text: '+ new…' }, s);
  s.onchange = () => {
    if (s.value !== '*new*') {
      onchange(s.value);
      if (!opts.nav) markDirty();
      refresh();
      return;
    }
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'newname';
    inp.placeholder = opts.placeholder || 'name (letters/numbers)';
    s.parentNode.replaceChild(inp, s);
    inp.focus();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      if (NAME_RE.test(v)) {
        onchange(v);
        if (!opts.nav) markDirty();
      }
      refresh();
    };
    inp.onkeydown = e => {
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') { done = true; refresh(); }
    };
    inp.onblur = commit;
  };
  return s;
}

// "+" button that swaps itself for a picker when clicked
function addButton(parent, label, makePicker) {
  const b = el('button', { class: 'mini', text: label }, parent);
  b.onclick = () => { b.parentNode.replaceChild(makePicker(), b); };
  return b;
}

function textInput(value, onchange, placeholder) {
  const t = document.createElement('input');
  t.type = 'text';
  t.value = value == null ? '' : value;
  if (placeholder) t.placeholder = placeholder;
  t.onchange = () => { onchange(t.value.trim()); markDirty(); refresh(); };
  return t;
}

function numInput(value, onchange, placeholder) {
  const t = document.createElement('input');
  t.type = 'number';
  t.value = value == null ? '' : value;
  if (placeholder) t.placeholder = placeholder;
  t.onchange = () => {
    onchange(t.value === '' ? null : Number(t.value));
    markDirty(); refresh();
  };
  return t;
}

function boolInput(value, onchange) {
  const t = document.createElement('input');
  t.type = 'checkbox';
  t.checked = !!value;
  t.onchange = () => { onchange(t.checked); markDirty(); refresh(); };
  return t;
}

function setOrDelete(o, k) {
  return v => {
    if (v === '' || v == null || v === false) delete o[k];
    else o[k] = v;
  };
}

// "afterwards" choices, grouped; keeps entryAnim in sync when the
// target is a room (walk-in clip by convention).
function afterLabel(v) {
  if (v.indexOf('go:') === 0) return 'go to ' + v.slice(3);
  if (v.indexOf('cut:') === 0) return 'play cutscene ' + v.slice(4);
  if (v.indexOf('pick:') === 0) return 'gives ' + v.slice(5);
  return v;
}

function afterGroups(includeItems) {
  const g = [
    { label: 'rooms', options: Object.keys(SCENES).map(n => 'go:' + n) },
    { label: 'cutscenes', options: Object.keys(CUTSCENES).map(n => 'cut:' + n) }
  ];
  if (includeItems) {
    g.push({ label: 'items', options: collectItems().map(x => 'pick:' + x) });
  }
  return g.filter(x => x.options.length);
}

function setThen(holder, fromRoom) {
  return v => {
    setOrDelete(holder, 'then')(v);
    const t = goTarget(v);
    if (t) holder.entryAnim = conv.arrive(t, fromRoom);
    else delete holder.entryAnim;
  };
}

// red/green chips for the files a thing needs
function artChips(parent, files) {
  const seen = {};
  let wrap = null;
  files.forEach(f => {
    if (!f || seen[f]) return;
    seen[f] = 1;
    if (!wrap) wrap = el('div', { class: 'artrow' }, parent);
    const ok = /\.wav$/.test(f) ? hasSound(f) : hasArt(f);
    el('span', { class: 'art ' + (ok ? 'ok' : 'missing'), text: f }, wrap);
  });
}

function advancedSec(parent, o) {
  const det = el('details', {}, parent);
  el('summary', { text: 'Advanced (raw JSON)' }, det);
  const t = el('textarea', { spellcheck: 'false' }, det);
  t.value = JSON.stringify(o, null, 1);
  t.onchange = () => {
    try {
      const v = JSON.parse(t.value);
      Object.keys(o).forEach(k => { delete o[k]; });
      Object.keys(v).forEach(k => { o[k] = v[k]; });
      t.style.borderColor = '';
      markDirty(); refresh();
    } catch (e) { t.style.borderColor = '#e66'; }
  };
}

/* ---------- refresh ---------- */

let refreshQueued = false;
function refresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    renderAll();
  }, 0);
}

/* ---------- stage (side pane) ----------
 * The stage shows the room of whatever is selected — room and hotspot
 * selections get the live hotspot overlay; a cutscene selection gets
 * a step preview instead. */

// what the stage is currently showing: 'room' | 'cutscene' | null
function stageMode() {
  if (!mapSel) return null;
  if (mapSel.kind === 'hotspot' || mapSel.kind === 'room') return 'room';
  if (mapSel.kind === 'cutscene') return 'cutscene';
  return null;
}

function fitStage() {
  if (!stagebox.clientWidth) return;
  stageScale = Math.min(1, stagebox.clientWidth / 800);
  document.getElementById('stagewrap').style.transform = 'scale(' + stageScale + ')';
  stagebox.style.height = Math.round(600 * stageScale) + 'px';
}
window.addEventListener('resize', () => { if (stageMode()) fitStage(); });

function loadImg(name) {
  if (!imgCache[name]) {
    const im = new Image();
    im.onload = () => { if (stageMode()) redrawStage(); };
    im.src = 'images/' + name;
    imgCache[name] = im;
  }
  return imgCache[name];
}

// draw one frame of a clip (frame 0 = what the room looks like at rest)
function drawClipFrame(name, elapsed) {
  if (!name) return;
  const im = loadImg(name);
  if (!im.complete || !im.naturalWidth) return;
  const meta = window.SHEETS && window.SHEETS[name];
  if (!meta) { ctx.drawImage(im, 0, 0); return; }
  const fw = im.naturalWidth / meta.frames;
  let f = Math.floor((elapsed || 0) / meta.dur);
  f = meta.loop ? f % meta.frames : Math.min(f, meta.frames - 1);
  ctx.drawImage(im, f * fw, 0, fw, im.naturalHeight, 0, 0, fw, im.naturalHeight);
}

function drawFrame0(name) { drawClipFrame(name, 0); }

function drawStage() {
  const s = SCENES[room];
  ctx.clearRect(0, 0, 800, 600);
  if (!s) return;
  drawFrame0(s.bg);
  (s.objects || []).forEach(o => drawFrame0(objectCel(o)));
  drawFrame0(s.idle);
  // the hotbar overlaps the stage bottom in-game (style.css: top 480px)
  const hb = loadImg('ui_hotbar.png');
  if (hb.complete && hb.naturalWidth) ctx.drawImage(hb, 0, 480);
}

// cutscene preview: the latest backdrop up to the chosen step, then
// that step's character clip over it — same compositing as the engine
function drawCutsceneFrame(cs, stepIdx) {
  ctx.clearRect(0, 0, 800, 600);
  const steps = cs.steps || [];
  let bg = null;
  for (let i = 0; i <= Math.min(stepIdx, steps.length - 1); i++) {
    if (steps[i] && steps[i].bg) bg = steps[i].bg;
  }
  if (bg) drawFrame0(bg);
  const st = steps[stepIdx];
  if (st && st.anim) drawFrame0(st.anim);
}

function redrawStage() {
  const mode = stageMode();
  if (mode === 'room') drawStage();
  else if (mode === 'cutscene') drawCutsceneFrame(CUTSCENES[mapSel.name] || {}, csPreviewStep);
}

/* ---------- dropdown previews ----------
 * Picking a file in any dropdown previews it: clips play on the stage
 * canvas over the current view, sounds just play. */

let previewState = null;
let previewTimer = null;
let previewAudio = null;

function paintPreview() {
  if (!previewState || !stageMode() || Date.now() > previewState.until) {
    previewState = null;
    if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
    if (stageMode()) redrawStage();
    return;
  }
  redrawStage();
  drawClipFrame(previewState.name, Date.now() - previewState.start);
}

function previewClip(name) {
  if (!stageMode() || !hasArt(name)) return;
  const meta = window.SHEETS && window.SHEETS[name];
  const now = Date.now();
  let ms = 1500; // static cel: hold it on top briefly
  if (meta) ms = meta.loop ? meta.frames * meta.dur * 2 : meta.frames * meta.dur + 400;
  previewState = { name, start: now, until: now + clamp(ms, 800, 8000) };
  if (!previewTimer) previewTimer = setInterval(paintPreview, 100);
  paintPreview();
}

function previewSound(f) {
  if (!hasSound(f)) return;
  if (!previewAudio) previewAudio = new Audio();
  previewAudio.src = 'sounds/' + f;
  const p = previewAudio.play();
  if (p && p.catch) p.catch(() => {});
}

function previewAsset(v) {
  if (/\.wav$/.test(v)) previewSound(v);
  else if (/\.png$/.test(v)) previewClip(v);
}

/* ---------- hotspot overlay: select / move / resize / draw ---------- */

function renderOverlay() {
  overlay.innerHTML = '';
  if (stageMode() !== 'room') return;
  const s = SCENES[room];
  if (!s) return;
  const objs = s.objects || [];
  areaGroups(objs).forEach(idxs => {
    const primary = idxs.indexOf(sel) >= 0 ? sel : idxs[0];
    const o = objs[primary];
    const b = bbox(o.area);
    const d = el('div', { class: 'hs' + (idxs.indexOf(sel) >= 0 ? ' sel' : '') }, overlay);
    d.style.left = b[0] + 'px';
    d.style.top = b[1] + 'px';
    d.style.width = (b[2] - b[0]) + 'px';
    d.style.height = (b[3] - b[1]) + 'px';
    el('div', { class: 'tag', text: objectLabel(o, primary) +
      (idxs.length > 1 ? ' · ' + idxs.length + ' states' : '') }, d);
    const grip = el('div', { class: 'grip' }, d);
    d.onmousedown = ev => startDrag(ev, primary, 'move');
    grip.onmousedown = ev => { ev.stopPropagation(); startDrag(ev, primary, 'size'); };
  });
}

function stagePos(ev) {
  const r = overlay.getBoundingClientRect();
  return [clamp(Math.round((ev.clientX - r.left) / stageScale), 0, 800),
          clamp(Math.round((ev.clientY - r.top) / stageScale), 0, 600)];
}

function selectHotspot(idx) {
  sel = idx;
  mapSel = idx >= 0 ? { kind: 'hotspot', room: room, idx: idx }
                    : { kind: 'room', room: room };
}

function startDrag(ev, index, mode) {
  ev.preventDefault();
  if (sel !== index) { selectHotspot(index); refresh(); }
  const objs = SCENES[room].objects;
  const idxs = groupIndices(index); // all states of the spot move as one
  const start = stagePos(ev);
  const a0 = bbox(objs[index].area);
  let moved = false;
  const setArea = a => idxs.forEach(i => { objs[i].area = a.slice(); });
  function onMove(e2) {
    const p = stagePos(e2);
    const dx = p[0] - start[0], dy = p[1] - start[1];
    if (dx || dy) moved = true;
    if (mode === 'move') {
      const w = a0[2] - a0[0], h = a0[3] - a0[1];
      const x = clamp(a0[0] + dx, 0, 800 - w), y = clamp(a0[1] + dy, 0, 600 - h);
      setArea([x, y, x + w, y + h]);
    } else {
      setArea([a0[0], a0[1],
               clamp(Math.max(a0[0] + 10, a0[2] + dx), 0, 800),
               clamp(Math.max(a0[1] + 10, a0[3] + dy), 0, 600)]);
    }
    renderOverlay();
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (moved) { markDirty(); refresh(); }
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

overlay.onmousedown = ev => {
  if (ev.target !== overlay || stageMode() !== 'room') return;
  ev.preventDefault();
  const start = stagePos(ev);
  let drew = false;
  function onMove(e2) {
    const p = stagePos(e2);
    if (!drew && (Math.abs(p[0] - start[0]) > 10 || Math.abs(p[1] - start[1]) > 10)) {
      drew = true;
      newHotspot(room, { area: [start[0], start[1], p[0], p[1]] });
      selectHotspot(SCENES[room].objects.length - 1);
    }
    if (drew) {
      SCENES[room].objects[sel].area = [
        Math.min(start[0], p[0]), Math.min(start[1], p[1]),
        Math.max(start[0], p[0]), Math.max(start[1], p[1])];
      renderOverlay();
    }
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (drew) { markDirty(); refresh(); }
    else if (sel !== -1) { selectHotspot(-1); refresh(); }
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
};

/* ---------- shared inspector sections ---------- */

function whenSec(panel, o) {
  const d = sec(panel, 'story', 'Appears when');
  const conds = toList(o.when).filter(c => c && c.flag);
  const store = () => {
    if (!conds.length) delete o.when;
    else o.when = conds.length === 1 ? conds[0] : conds;
    markDirty(); refresh();
  };
  if (!conds.length) {
    const b = line(d);
    word(b, 'always');
    el('span', { class: 'muted', text: '(no flag conditions)' }, b);
  }
  conds.forEach((c, i) => {
    const b = line(d);
    if (i > 0) word(b, 'and');
    b.appendChild(namePicker(collectFlags(), c.flag, v => { c.flag = v; store(); },
      { blank: false, placeholder: 'new flag name' }));
    b.appendChild(selectInput(['is set', 'not yet set'],
      c.value === false ? 'not yet set' : 'is set',
      v => {
        if (v === 'not yet set') c.value = false; else delete c.value;
        store();
      }, { blank: false }));
    el('button', { class: 'mini danger', text: 'x',
      onclick: () => { conds.splice(i, 1); store(); } }, b);
  });
  const b = line(d);
  addButton(b, '+ condition', () =>
    namePicker(collectFlags(), '', v => { conds.push({ flag: v }); store(); },
      { blank: 'choose flag…', placeholder: 'new flag name' }));
}

function flagsLine(parent, holder, verb) {
  const flags = toList(holder.setFlag).slice();
  const store = () => {
    if (!flags.length) delete holder.setFlag;
    else holder.setFlag = flags.length === 1 ? flags[0] : flags;
    markDirty(); refresh();
  };
  const b = line(parent);
  word(b, verb);
  if (!flags.length) el('span', { class: 'muted', text: 'no flags' }, b);
  flags.forEach((f, i) => {
    if (i > 0) word(b, 'and');
    b.appendChild(namePicker(collectFlags(), f, v => { flags[i] = v; store(); },
      { blank: false, placeholder: 'new flag name' }));
    el('button', { class: 'mini danger', text: 'x',
      onclick: () => { flags.splice(i, 1); store(); } }, b);
  });
  addButton(b, '+', () =>
    namePicker(collectFlags().filter(f => flags.indexOf(f) === -1), '',
      v => { flags.push(v); store(); },
      { blank: 'choose flag…', placeholder: 'new flag name' }));
}

/* "using [item] here…" — the per-item reactions on a hotspot */
function reactionsSec(panel, holder) {
  const d = sec(panel, 'story', 'Using an item here');
  const map = holder.items || {};
  Object.keys(map).forEach(id => {
    if (typeof map[id] === 'string') map[id] = { hint: map[id] }; // normalize
    const entry = map[id];
    const refused = !!entry.hint;
    const b = line(d);
    word(b, 'using');
    b.appendChild(namePicker(collectItems(), id, v => {
      if (!v || v === id || map[v]) return;
      delete map[id];
      map[v] = entry;
    }, { blank: false, placeholder: 'new item id' }));
    b.appendChild(selectInput(['is refused', 'works'],
      refused ? 'is refused' : 'works',
      v => {
        if (v === 'is refused') {
          Object.keys(entry).forEach(k => { delete entry[k]; });
          entry.hint = assets.sounds[0] || 'fail.wav';
        } else {
          delete entry.hint;
          delete entry.hintDur;
        }
      }, { blank: false }));
    if (refused) {
      word(b, 'saying');
      b.appendChild(selectInput(soundGroups(room), entry.hint, v => {
        entry.hint = v;
        autoHold(entry, SCENES[room].failAnim, 'hintDur', v);
      }, { blank: false }));
    }
    el('button', { class: 'mini danger', text: 'x', onclick: () => {
      delete map[id];
      if (!Object.keys(map).length) delete holder.items;
      markDirty(); refresh();
    } }, b);
    if (!refused) {
      const b2 = line(d);
      word(b2, '…char plays');
      b2.appendChild(selectInput(useClips(room), entry.anim, setOrDelete(entry, 'anim')));
      word(b2, 'sound');
      b2.appendChild(selectInput(soundGroups(room), entry.sound, setOrDelete(entry, 'sound')));
      const b3 = line(d);
      word(b3, '…afterwards');
      b3.appendChild(selectInput(afterGroups(true), entry.then, setThen(entry, room),
        { blank: 'nothing', labelFn: afterLabel }));
      b3.appendChild(selectInput(['keeps the item', 'uses it up'],
        entry.consume ? 'uses it up' : 'keeps the item',
        v => {
          if (v === 'uses it up') entry.consume = true; else delete entry.consume;
        }, { blank: false }));
      flagsLine(d, entry, '…and sets');
    }
  });
  const b = line(d);
  addButton(b, '+ item reaction', () =>
    namePicker(collectItems().filter(x => !map[x]), '', v => {
      holder.items = holder.items || {};
      holder.items[v] = { hint: assets.sounds[0] || 'fail.wav' };
      markDirty(); refresh();
    }, { blank: 'choose item…', placeholder: 'new item id' }));
}

/* ---------- hotspot inspector ----------
 * One flow for every hotspot, top to bottom in play order:
 *   appears when → lock (optional) → on tap → afterwards → story.
 * A pickup swaps the middle for its item fields. No type juggling. */

function lockSec(panel, o) {
  const d = sec(panel, 'story', 'Lock');
  if (!isLocked(o)) {
    const b = line(d);
    el('span', { class: 'muted', text: 'not locked — anyone can tap it' }, b);
    addButton(b, '+ add lock', () =>
      namePicker(collectItems(), '', v => { if (v) lockHotspot(o, v, room); },
        { blank: 'opens with…', placeholder: 'new item id' }));
    return null;
  }
  if (!o.gate && !o.locked) lockHotspot(o, null, room); // legacy plain-needs spot
  const locked = o.locked = o.locked || {};
  let b = line(d);
  word(b, 'opens with');
  b.appendChild(namePicker(collectItems(), locked.needs, setOrDelete(locked, 'needs'),
    { blank: 'nothing yet', placeholder: 'new item id' }));
  word(b, 'and sound');
  b.appendChild(selectInput(soundGroups(room), locked.sound, setOrDelete(locked, 'sound')));
  b = line(d);
  word(b, 'wrong / no item says');
  b.appendChild(selectInput(soundGroups(room), locked.hint, v => {
    setOrDelete(locked, 'hint')(v);
    autoHold(locked, SCENES[room].failAnim, 'hintDur', v); // hold = line length
  }));
  b = line(d);
  word(b, 'right after unlocking');
  b.appendChild(selectInput(afterGroups(false), locked.then, setThen(locked, room),
    { blank: 'nothing special', labelFn: afterLabel }));
  flagsLine(d, locked, 'first unlock sets');
  b = line(d);
  word(b, 'prop art id');
  b.appendChild(textInput(o.gate, v => { if (NAME_RE.test(v)) o.gate = v; }));
  el('button', { class: 'mini danger', text: 'Remove lock', onclick: () => {
    if (!confirm('Remove the lock? The refuse line and unlock behaviour are dropped; ' +
                 'what happens on tap is kept.')) return;
    unlockHotspot(o);
    markDirty(); refresh();
  } }, b);
  return locked;
}

// State chips: switch between the hotspots sharing this area, and
// "+ state" to clone the current one (the one-time-use pattern: state 1
// works and sets a flag, state 2 appears when the flag is set).
function statesRow(panel, o) {
  const idxs = groupIndices(sel);
  const wrap = el('div', { class: 'typechips' }, panel);
  if (idxs.length > 1) {
    word(wrap, 'states:');
    idxs.forEach((i, n) => {
      el('div', { class: 'chip' + (i === sel ? ' active' : ''),
        text: (n + 1) + ' — ' + whenSummary(SCENES[room].objects[i]),
        onclick: () => { if (i !== sel) { selectHotspot(i); refresh(); } } }, wrap);
    });
  }
  el('div', { class: 'chip', text: '+ state',
    title: 'copy this hotspot as another state of the same spot — same ' +
           'area, shown under different flag conditions (e.g. the ' +
           'fountain after the coin has been fished)',
    onclick: () => {
      const copy = JSON.parse(JSON.stringify(o));
      delete copy.id;
      SCENES[room].objects.splice(sel + 1, 0, copy);
      ensureIds();
      selectHotspot(sel + 1);
      markDirty(); refresh();
    } }, wrap);
  return idxs.length;
}

function renderHotspot(panel, o) {
  const type = objType(o);
  const chips = el('div', { class: 'typechips' }, panel);
  [['spot', 'Spot'], ['pickup', 'Item pickup']].forEach(t => {
    el('div', { class: 'chip' + (type === t[0] ? ' active' : ''), text: t[1],
      onclick: () => {
        if (t[0] === type) return;
        if (t[0] === 'pickup') {
          if (!confirm('Turn this spot into an item pickup?' +
              (isLocked(o) ? ' Its lock is removed.' : ''))) return;
          unlockHotspot(o);
          delete o.then; delete o.entryAnim; delete o.entryDur;
          o.item = collectItems()[0] || 'newitem';
          o.anim = conv.pick(room, o.item);
        } else {
          if (!confirm('Turn this pickup into a plain spot?')) return;
          if (o.anim === conv.pick(room, o.item)) delete o.anim;
          delete o.item;
        }
        markDirty(); refresh();
      } }, chips);
  });
  const stateCount = statesRow(panel, o);

  whenSec(panel, o);

  let b, d;
  const need = [];

  if (type === 'pickup') {
    d = sec(panel, 'story', 'Pickup');
    b = line(d);
    word(b, 'gives');
    b.appendChild(namePicker(collectItems(), o.item, v => {
      if (!v) return;
      o.item = v;
      o.anim = conv.pick(room, v); // grab clip by convention
    }, { blank: false, placeholder: 'new item id' }));
    flagsLine(d, o, 'taken, sets');
    if (!o.anim) o.anim = conv.pick(room, o.item);
    d = sec(panel, 'media', 'Looks');
    b = line(d);
    word(b, 'grab clip');
    b.appendChild(selectInput(pickClipsG(room), o.anim, setOrDelete(o, 'anim')));
    reactionsSec(panel, o);
  } else {
    const locked = lockSec(panel, o);
    const tap = tapHolder(o);

    d = sec(panel, 'media', locked ? 'On tap (once unlocked)' : 'On tap');
    b = line(d);
    word(b, 'character plays');
    b.appendChild(selectInput(tapClips(room), tap.anim, v => {
      setOrDelete(tap, 'anim')(v);
      autoHold(tap, v, 'dur', tap.sound);
    }));
    b = line(d);
    word(b, 'room shows');
    b.appendChild(selectInput(objClips(room), tap.objAnim, setOrDelete(tap, 'objAnim')));
    b = line(d);
    word(b, 'saying / sound');
    b.appendChild(selectInput(soundGroups(room), tap.sound, v => {
      setOrDelete(tap, 'sound')(v);
      autoHold(tap, tap.anim, 'dur', v);
    }));

    d = sec(panel, 'nav', 'Afterwards');
    b = line(d);
    word(b, 'then');
    b.appendChild(selectInput(afterGroups(true), tap.then, setThen(tap, room),
      { blank: 'back to idle', labelFn: afterLabel }));
    if (tap.then && tap.then.indexOf('cut:') === 0 && CUTSCENES[tap.then.slice(4)]) {
      refChip(b, { kind: 'cutscene', name: tap.then.slice(4) }); // jump to edit it
    }
    const t = goTarget(tap.then);
    if (t) need.push(conv.arrive(t, room)); // arrival clip by convention
    b = line(d);
    word(b, 'hover cursor');
    b.appendChild(selectInput(['left', 'right', 'point'], tap.cursor, v => {
      setOrDelete(tap, 'cursor')(v);
      if (locked) setOrDelete(locked, 'cursor')(v); // same cursor both states
    }));

    d = sec(panel, 'story', 'Story');
    flagsLine(d, tap, 'tapped, sets');
    reactionsSec(panel, locked || o);
  }

  const files = hotspotFiles(o, room);
  artChips(panel, files.art.concat(files.sounds, need));
  advancedSec(panel, o);

  const btns = el('div', { class: 'row' }, panel);
  el('button', { class: 'mini danger big',
    text: stateCount > 1 ? 'Delete this state' : 'Delete hotspot',
    onclick: () => {
      SCENES[room].objects.splice(sel, 1);
      selectHotspot(-1); markDirty(); refresh();
    } }, btns);
}

/* ---------- room card + hotspot list ---------- */

function roomConnections(rn) {
  const to = [];
  const from = [];
  Object.keys(SCENES).forEach(other => {
    (SCENES[other].objects || []).forEach((o, i) => {
      const targets = [];
      [o, o.locked, o.open].forEach(h => {
        if (h && goTarget(h.then)) targets.push(goTarget(h.then));
      });
      targets.forEach(t => {
        if (other === rn && t !== rn) to.push({ kind: 'hotspot', room: rn, idx: i });
        if (other !== rn && t === rn) from.push({ kind: 'hotspot', room: other, idx: i });
      });
    });
  });
  return { to, from };
}

function renderRoomCard(panel) {
  ensureRoomDefaults(room);
  const s = SCENES[room];
  el('h2', { text: room + (room === START_ROOM ? '  (start room)' : '') }, panel);
  artChips(panel, [s.bg, s.idle, s.failAnim]);

  const d = sec(panel, 'nav', 'Connections');
  let b = line(d);
  word(b, 'leads to:');
  const conn = roomConnections(room);
  refChips(b, conn.to, 'nowhere — add an exit');
  b = line(d);
  word(b, 'entered from:');
  refChips(b, conn.from, 'nothing leads here');

  // every hotspot in the room — flavour spots (plain looks/exits)
  // are not story nodes, so this list is how you reach them
  el('h2', { text: 'Hotspots', style: 'margin-top:12px' }, panel);
  const ul = el('ul', { id: 'objlist' }, panel);
  const objs = s.objects || [];
  areaGroups(objs).forEach(idxs => {
    const i = idxs[0];
    const o = objs[i];
    const li = el('li', {}, ul);
    li.onclick = () => { selectHotspot(i); refresh(); };
    el('span', { class: 'lbl', text: objectLabel(o, i) }, li);
    if (idxs.length > 1) {
      el('span', { class: 'flagged', text: idxs.length + ' states',
        title: 'same area, different flag conditions' }, li);
    } else if (o.when) {
      el('span', { class: 'flagged', text: '⚑ conditional',
        title: 'only appears when its flag conditions hold' }, li);
    }
    let missing = 0;
    idxs.forEach(n => {
      const files = hotspotFiles(objs[n], room);
      missing += files.art.filter(f => !hasArt(f)).length +
                 files.sounds.filter(f => !hasSound(f)).length;
    });
    if (missing) el('span', { class: 'art missing', text: missing + ' missing' }, li);
  });
  el('button', { class: 'mini big', text: '+ Add hotspot', onclick: () => {
    newHotspot(room, { area: [340, 240, 460, 360] });
    selectHotspot(SCENES[room].objects.length - 1);
    markDirty(); refresh();
  } }, panel);

  advancedSec(panel, s);

  const btns = el('div', { class: 'row', style: 'margin-top:10px' }, panel);
  el('button', { class: 'mini danger big', text: 'Delete room', onclick: () => {
    if (Object.keys(SCENES).length < 2) { alert('Cannot delete the only room.'); return; }
    const inbound = roomConnections(room).from.length;
    if (!confirm('Delete room "' + room + '" and all its hotspots?' +
        (inbound ? '\n\n' + inbound + ' exit(s) in other rooms lead here and will break.' : ''))) return;
    delete SCENES[room];
    room = Object.keys(SCENES)[0];
    mapSel = null; sel = -1; markDirty(); refresh();
  } }, btns);
}

/* ---------- story graph ----------
 * The game's puzzle chain as a graph: items flow into the locks/spots
 * that want them, which yield rooms, cutscenes, items and flags in
 * turn. The map draws gameplay truth, not data wiring: internal
 * state-switch flags are hidden, refusal reactions aren't progression
 * edges, and rooms freely walkable between are joined by ⇄ connectors.
 * Every visible edge carries `dels` — closures that remove the data it
 * represents, so wires can be deleted right on the map. */

const SVGNS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs || {}) {
    if (k === 'text') e.textContent = attrs[k];
    else if (k.slice(0, 2) === 'on') e[k] = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  if (parent) parent.appendChild(e);
  return e;
}

/* Two visual kinds only: a STEP (something the player does) and a
 * ROOM (a place, drawn as a container with a title bar). */
const MAP_KINDS = {
  step: { fill: '#2b4a6e', stroke: '#5b8dd4', name: 'step' },
  room: { fill: '#24402d', stroke: '#6fc48c', name: 'room' }
};
const ROOM_H = 26; // room title bar height (steps use H)

function nodeH(n) { return n.kind === 'room' ? ROOM_H : H; }

// remove one flag's conditions from an object's `when`
function removeWhenFrom(obj, f) {
  const cs = toList(obj.when).filter(c => !(c && c.flag === f));
  if (!cs.length) delete obj.when;
  else obj.when = cs.length === 1 ? cs[0] : cs;
}

// remove a holder's follow-up action (then + arrival clip)
function delThen(h) {
  return () => { delete h.then; delete h.entryAnim; delete h.entryDur; };
}

// the map id of the step covering a hotspot (first state's id)
function stepNodeId(rn, idx) {
  const objs = SCENES[rn].objects || [];
  const key = areaKey(objs[idx]);
  for (let i = 0; i < objs.length; i++) {
    if (areaKey(objs[i]) === key) return 'step:' + objs[i].id;
  }
  return 'step:' + objs[idx].id;
}

// player-facing names derived from the data
function gateShort(gateId, rn) {
  return gateId ? gateId.replace(rn + '_', '').replace(/_/g, ' ') : 'it';
}

function thingName(o) {
  const clip = o.anim || o.objAnim || '';
  let at = clip.indexOf('_look_');
  if (at >= 0) return clip.slice(at + 6).replace(/\.png$/, '');
  at = clip.indexOf('_use_');
  if (at >= 0) return clip.slice(at + 5).replace(/\.png$/, '');
  return null;
}

/* THE model: every node is a STEP — something the player does, in the
 * player's own verbs ("take key", "unlock door to garden", "make
 * fishingrod", "pay the gnome"). One wire meaning: "needs this first",
 * labeled with the item that carries it (or ⚑flag for pure ordering).
 * Rooms are places, not steps: they render as containers whose title
 * bar anchors "opens the way" wires. Walking between open rooms is not
 * a step (⇄ connectors join them); a locked door IS a step, and its
 * wire opens the next container. A cutscene rides on the step that
 * triggers it ("▶ gnome_dance"); only untriggered ones (the intro)
 * stand alone as "watch …". Flavour spots (plain looks/exits,
 * refusals) are not progression: they live in the room's inspector,
 * not on the map. */
function buildStoryGraph() {
  const nodes = {};
  const edges = [];
  const seen = {};
  // lane: which room's container a step lives in ('_' = between rooms)
  const node = (id, kind, label, sub, ref, lane) => {
    if (!nodes[id]) {
      nodes[id] = { id, kind, label, sub: sub || '', ref: ref || null, lane: lane || '_' };
    }
    return nodes[id];
  };
  // hidden edges shape containment but are not drawn; del closures let
  // a wire be removed right on the map
  const edge = (a, b, hidden, label, del) => {
    if (!a || !b || a === b) return;
    const key = a + '>' + b;
    if (seen[key]) { if (del) seen[key].dels.push(del); return; }
    const e = { from: a, to: b, hidden: !!hidden, label: label || '',
                dels: del ? [del] : [] };
    seen[key] = e;
    edges.push(e);
  };
  const R = buildRefs();

  // a working (non-refusal) item reaction
  const worksEntry = e => e && typeof e === 'object' && !e.hint;

  /* ZONES: movement is not a step. Rooms the player can walk between
   * freely (unlocked exits) form one zone; a locked passage starts the
   * next. Zones drive the Tidy layout.
   * Exits are ONE-WAY (each is a hotspot in its own room), so every
   * direction draws its own arrow — a room connected both ways gets
   * two lines, and a plain exit one way + a locked door the other stay
   * two separate lines (the locked one is its unlock step's "opens"
   * wire). Clicking an exit arrow jumps to that direction's hotspot. */
  const roomZone = {};
  const roomOrder = [];
  const exits = [];
  const exitSeen = {};
  const freeAdj = {};
  Object.keys(SCENES).forEach(rn => {
    freeAdj[rn] = [];
    (SCENES[rn].objects || []).forEach((o, i) => {
      const t = goTarget(o.then);
      if (t && SCENES[t] && !isLocked(o) && !o.item) {
        freeAdj[rn].push(t);
        const k = rn + '>' + t; // directed: one arrow per direction
        if (!exitSeen[k]) {
          exitSeen[k] = 1;
          exits.push({ a: rn, b: t, ref: { kind: 'hotspot', room: rn, idx: i } });
        }
      }
    });
  });
  const claim = (seed, z) => {
    const q = [seed];
    roomZone[seed] = z;
    roomOrder.push(seed);
    while (q.length) {
      const rn = q.shift();
      freeAdj[rn].forEach(t => {
        if (roomZone[t] !== undefined) return;
        roomZone[t] = z;
        roomOrder.push(t);
        q.push(t);
      });
    }
  };
  if (SCENES[START_ROOM]) claim(START_ROOM, 0);
  let grew = true;
  while (grew) {
    grew = false;
    Object.keys(roomZone).forEach(rn => {
      (SCENES[rn].objects || []).forEach(o => {
        if (!isLocked(o)) return;
        const t = goTarget((o.open || {}).then);
        if (t && SCENES[t] && roomZone[t] === undefined) {
          claim(t, roomZone[rn] + 1);
          grew = true;
        }
      });
    });
  }
  // rooms nothing points at yet still deserve a place on the map
  Object.keys(SCENES).forEach(rn => {
    if (roomZone[rn] === undefined) { roomZone[rn] = 1; roomOrder.push(rn); }
  });
  roomOrder.forEach(rn => {
    const n = node('room:' + rn, 'room', rn, '', { kind: 'room', room: rn }, rn);
    n.start = rn === START_ROOM;
  });

  /* what every step yields and wants — resolved into wires at the end */
  const producers = {}; // item -> [stepId]
  const consumers = {}; // item -> [{step, del}]
  const setters = {};   // flag -> [stepId]
  const checkers = {};  // flag -> [{step, obj (owner of `when`)}]
  const produce = (it, s) => (producers[it] = producers[it] || []).push(s);
  const consume = (it, s, del) =>
    (consumers[it] = consumers[it] || []).push({ step: s, del });
  const setF = (f, s) => (setters[f] = setters[f] || []).push(s);
  const checkF = (f, s, obj) =>
    (checkers[f] = checkers[f] || []).push({ step: s, obj });

  /* steps from hotspots — states sharing an area are one step */
  Object.keys(SCENES).forEach(rn => {
    const objs = SCENES[rn].objects || [];
    areaGroups(objs).forEach(idxs => {
      const isStep = idxs.some(i => {
        const o = objs[i];
        if (o.item) return true;
        if (o.gate || o.locked || o.needs) return true;
        if ([o, o.open].some(h => h &&
            ((h.then || '').indexOf('cut:') === 0 || h.setFlag))) return true;
        return [o.items, o.locked && o.locked.items].some(m =>
          m && Object.keys(m).some(x => worksEntry(m[x])));
      });
      if (!isStep) return;
      const id = 'step:' + objs[idxs[0]].id;
      const gives = {};
      const subs = [];

      idxs.forEach(i => {
        const o = objs[i];
        toList(o.when).forEach(c => { if (c && c.flag) checkF(c.flag, id, o); });

        const outputs = h => {
          if (!h) return;
          const cn = h.then && h.then.indexOf('cut:') === 0 ? h.then.slice(4) : null;
          // flags set alongside a cutscene are EXPERIENCED after it
          // (the player can't act while it plays), so their
          // consequences hang off the cutscene's node
          toList(h.setFlag).forEach(f => setF(f, cn ? 'step:cut:' + cn : id));
          if (h.then && h.then.indexOf('pick:') === 0) {
            const it = h.then.slice(5);
            produce(it, id);
            gives[it] = 1;
          }
          if (cn) edge(id, 'step:cut:' + cn, false, 'plays', delThen(h));
          if (isLocked(o) && goTarget(h.then)) {
            edge(id, 'room:' + goTarget(h.then), false, 'opens', delThen(h));
          }
        };
        const uses = h => {
          if (h && h.needs) consume(h.needs, id, () => { delete h.needs; });
          if (h && h.items) Object.keys(h.items).forEach(x => {
            if (!worksEntry(h.items[x])) return; // refusals aren't progression
            consume(x, id, () => {
              delete h.items[x];
              if (!Object.keys(h.items).length) delete h.items;
            });
            outputs(h.items[x]);
          });
        };
        if (o.item) produce(o.item, id);
        uses(o); uses(o.locked);
        outputs(o); outputs(o.locked); outputs(o.open);
      });

      // the label is the player's verb, from the first state that names one
      let label = null;
      idxs.forEach(i => {
        if (label) return;
        const o = objs[i];
        if (o.item) { label = 'take ' + o.item; return; }
        if (o.gate || o.locked) {
          const openT = goTarget((o.open || {}).then) ||
                        goTarget(((o.locked || {}).then));
          const needs = (o.locked || {}).needs;
          label = openT ? 'unlock door to ' + openT
                        : 'use ' + (needs || '?') + ' on ' + gateShort(o.gate, rn);
          return;
        }
        const m = o.items || {};
        const wk = Object.keys(m).filter(x => worksEntry(m[x]))[0];
        const tn = thingName(o);
        if (wk) label = 'use ' + wk + ' on ' + (tn || 'it');
        else if (tn) label = 'tap ' + tn;
      });
      if (!label) label = 'do #' + (idxs[0] + 1);
      const giveList = Object.keys(gives);
      if (giveList.length) subs.unshift('→ ' + giveList.join(', '));
      if (idxs.length > 1) subs.push(idxs.length + ' states');
      node(id, 'step', label, subs.join('  '),
           { kind: 'hotspot', room: rn, idx: idxs[0] }, rn);
      edge('room:' + rn, id, true); // containment
    });
  });

  /* combining is ONE step: parts flow in, the result flows out.
   * Deleting any of its wires removes the whole recipe. */
  COMBINE.forEach((c, i) => {
    const id = 'step:make:' + i;
    const delRecipe = () => { COMBINE.splice(COMBINE.indexOf(c), 1); };
    node(id, 'step', 'make ' + (c.makes || '?'), 'combine',
         { kind: 'recipe', idx: i });
    (c.parts || []).forEach(p => { if (p) consume(p, id, delRecipe); });
    if (c.makes) produce(c.makes, id);
  });

  /* every cutscene is a step of its own — "watch …" — living in the
   * room whose step plays it. What it sets/reveals flows FROM it. */
  Object.keys(CUTSCENES).forEach(cn => {
    const trig = (R.cutUses[cn] || [])[0];
    const cs = CUTSCENES[cn];
    const id = 'step:cut:' + cn;
    node(id, 'step', 'watch ' + cn,
         trig ? (trig.kind === 'start' ? 'plays at boot' : '')
              : 'nothing triggers it!',
         { kind: 'cutscene', name: cn },
         trig && trig.kind === 'hotspot' ? trig.room : null);
    toList(cs.setFlag).forEach(f => setF(f, id));
    const t = goTarget(cs.then);
    if (t) edge(id, 'room:' + t, false, 'then', delThen(cs));
    else if (trig && trig.kind === 'start' && SCENES[START_ROOM]) {
      edge(id, 'room:' + START_ROOM, false, 'then');
    }
  });

  /* the wires: item wires from every step that yields an item to every
   * step that wants it; ⚑flag wires for pure "this first" ordering
   * (a flag set and checked by the same step is its internal state
   * switch — the player never experiences it, so no wire) */
  Object.keys(consumers).forEach(it => {
    consumers[it].forEach(c => {
      (producers[it] || []).forEach(p => edge(p, c.step, false, it, c.del));
    });
  });
  Object.keys(checkers).forEach(f => {
    checkers[f].forEach(c => {
      (setters[f] || []).forEach(s => {
        if (s === c.step) return;
        edge(s, c.step, false, '⚑ ' + f, () => removeWhenFrom(c.obj, f));
      });
    });
  });

  return { nodes, edges, roomZone, roomOrder, exits };
}

/* ---------- map layout ----------
 * Node positions live in LAYOUT.nodes (world coords, persisted to
 * editor-layout.json). Tidy recomputes them all with the walkthrough
 * algorithm: one horizontal band per zone, the global work column
 * first, then one column per room in discovery order — reading the
 * tidied map top-to-bottom IS the walkthrough. Nodes that appear
 * between saves are auto-placed near their room. */

const W = 150, H = 40, XGAP = 166, VGAP = 78, CGAP = 34, BGAP = 54;

function computeTidyPositions(g) {
  const ids = Object.keys(g.nodes);
  const pos = {};
  if (!ids.length) return pos;

  const preds = {};
  g.edges.forEach(e => { (preds[e.to] = preds[e.to] || []).push(e.from); });

  // band 0 = before the first room (START, intro cutscene);
  // band z+1 = zone z's rooms, their contents, and every derived node
  const roomBand = rn => (g.roomZone[rn] !== undefined ? g.roomZone[rn] + 1 : 1);
  const band = {};
  const bStack = {};
  const bandOf = id => {
    if (band[id] !== undefined) return band[id];
    const n = g.nodes[id];
    if (n.kind === 'room') return (band[id] = roomBand(n.label));
    if (n.lane !== '_') return (band[id] = roomBand(n.lane));
    if (n.kind === 'start') return (band[id] = 0);
    if (bStack[id]) return 0;
    bStack[id] = 1;
    let m = 0;
    (preds[id] || []).forEach(p => { m = Math.max(m, bandOf(p)); });
    bStack[id] = 0;
    return (band[id] = m);
  };
  ids.forEach(bandOf);

  // local rows inside a band: longest path over same-band edges
  // (room headers pin row 0; containment puts contents below them)
  const row = {};
  const rStack = {};
  const rowOf = id => {
    if (row[id] !== undefined) return row[id];
    if (g.nodes[id].kind === 'room') return (row[id] = 0);
    if (rStack[id]) return 0;
    rStack[id] = 1;
    let m = 0;
    (preds[id] || []).forEach(p => {
      if (band[p] === band[id]) m = Math.max(m, rowOf(p) + 1);
    });
    rStack[id] = 0;
    return (row[id] = m);
  };
  ids.forEach(rowOf);

  // columns: the global work column first, then one column per room
  // (in the order the player discovers them)
  const orderIdx = {};
  (g.roomOrder || []).forEach((rn, i) => { orderIdx[rn] = i; });
  const roomsInBand = {};
  ids.forEach(id => {
    const n = g.nodes[id];
    if (n.kind !== 'room') return;
    (roomsInBand[band[id]] = roomsInBand[band[id]] || []).push(n.label);
  });
  Object.keys(roomsInBand).forEach(b => {
    roomsInBand[b].sort((a, b2) => (orderIdx[a] || 99) - (orderIdx[b2] || 99));
  });

  const cells = {}; // band -> col -> row -> [ids]
  ids.forEach(id => {
    const lane = g.nodes[id].lane;
    const col = g.nodes[id].kind === 'room' ? g.nodes[id].label : lane;
    const byCol = cells[band[id]] = cells[band[id]] || {};
    const byRow = byCol[col] = byCol[col] || {};
    (byRow[row[id]] = byRow[row[id]] || []).push(id);
  });

  const maxBand = Math.max(...ids.map(id => band[id]));
  let y0 = 16;
  for (let b = 0; b <= maxBand; b++) {
    const byCol = cells[b] || {};
    const colKeys = ['_'].concat(roomsInBand[b] || []).filter(c => byCol[c]);
    let x0 = 16;
    let bandRows = 1;
    colKeys.forEach(c => {
      const rowsHere = Object.keys(byCol[c]).map(Number);
      bandRows = Math.max(bandRows, Math.max.apply(null, rowsHere) + 1);
      const colW = Math.max.apply(null, rowsHere.map(r => byCol[c][r].length)) * XGAP;
      rowsHere.sort((a, b2) => a - b2).forEach(r => {
        const cell = byCol[c][r];
        cell.sort((a, b2) => {
          const avg = id => {
            const ps = (preds[id] || []).filter(p => pos[p]);
            return ps.length ? ps.reduce((s2, p) => s2 + pos[p][0], 0) / ps.length : 1e9;
          };
          return avg(a) - avg(b2);
        });
        const off = x0 + (colW - cell.length * XGAP) / 2 + (XGAP - W) / 2;
        cell.forEach((id, si) => { pos[id] = [off + si * XGAP, y0 + r * VGAP]; });
      });
      x0 += colW + CGAP;
    });
    y0 += bandRows * VGAP - (VGAP - H) + BGAP;
  }
  return pos;
}

function tidyLayout(g) {
  const pos = computeTidyPositions(g || buildStoryGraph());
  LAYOUT.nodes = {};
  Object.keys(pos).forEach(id => { LAYOUT.nodes[id] = pos[id]; });
}

// give never-seen nodes a home: below the other members of their room,
// or off to the right of everything for global-lane nodes
function ensurePositions(g) {
  const ids = Object.keys(g.nodes);
  const missing = ids.filter(id => !LAYOUT.nodes[id]);
  if (!missing.length) return;
  if (missing.length === ids.length) { tidyLayout(g); return; }

  const placed = ids.filter(id => LAYOUT.nodes[id]);
  const occupied = p => placed.some(id => {
    const q = LAYOUT.nodes[id];
    return Math.abs(q[0] - p[0]) < W && Math.abs(q[1] - p[1]) < H + 8;
  });
  const settle = p => {
    while (occupied(p)) p = [p[0], p[1] + VGAP];
    return p;
  };
  missing.forEach(id => {
    const lane = g.nodes[id].lane;
    const mates = placed.filter(x => g.nodes[x].lane === lane && lane !== '_');
    let p;
    if (mates.length) {
      const xs = mates.map(x => LAYOUT.nodes[x][0]);
      const ys = mates.map(x => LAYOUT.nodes[x][1]);
      p = [xs.reduce((a, b) => a + b, 0) / xs.length,
           Math.max.apply(null, ys) + VGAP];
    } else {
      const xs = placed.map(x => LAYOUT.nodes[x][0]);
      p = [(xs.length ? Math.max.apply(null, xs) : 0) + XGAP + CGAP, 40];
    }
    LAYOUT.nodes[id] = settle(p);
    placed.push(id);
  });
}

/* ---------- viewport (pan / zoom) ---------- */

function toWorld(sx, sy) {
  const r = mapSvg.getBoundingClientRect();
  return [(sx - r.left - view.x) / view.k, (sy - r.top - view.y) / view.k];
}

function fitView(g) {
  const ids = Object.keys(g.nodes).filter(id => LAYOUT.nodes[id]);
  if (!ids.length) { view = { x: 40, y: 40, k: 1 }; return; }
  const xs = ids.map(id => LAYOUT.nodes[id][0]);
  const ys = ids.map(id => LAYOUT.nodes[id][1]);
  const x1 = Math.min.apply(null, xs) - 30, y1 = Math.min.apply(null, ys) - 30;
  const x2 = Math.max.apply(null, xs) + W + 30, y2 = Math.max.apply(null, ys) + H + 60;
  const bw = mapSvg.clientWidth || 800, bh = mapSvg.clientHeight || 600;
  const k = clamp(Math.min(bw / (x2 - x1), bh / (y2 - y1)), 0.25, 1.25);
  view = { x: (bw - (x2 - x1) * k) / 2 - x1 * k,
           y: (bh - (y2 - y1) * k) / 2 - y1 * k, k };
}

mapSvg.addEventListener('wheel', e => {
  e.preventDefault();
  const r = mapSvg.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const k2 = clamp(view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.2, 2.5);
  // zoom about the cursor: the world point under it stays put
  view.x = mx - (mx - view.x) * (k2 / view.k);
  view.y = my - (my - view.y) * (k2 / view.k);
  view.k = k2;
  renderMap();
}, { passive: false });

/* ---------- popups (wire meanings, add menu, name prompts) ---------- */

let popupEl = null;
function closePopup() {
  if (popupEl) { popupEl.remove(); popupEl = null; }
}
document.addEventListener('mousedown', e => {
  if (popupEl && !popupEl.contains(e.target)) closePopup();
});

function popupBase(sx, sy) {
  closePopup();
  const r = mapWrap.getBoundingClientRect();
  popupEl = el('div', { class: 'popup' }, mapWrap);
  popupEl.style.left = clamp(sx - r.left, 8, r.width - 240) + 'px';
  popupEl.style.top = clamp(sy - r.top, 8, r.height - 60) + 'px';
  popupEl.onmousedown = e => e.stopPropagation();
  return popupEl;
}

// items: [{label, sub, pick}] — pick receives the popup's screen coords
// so a follow-up prompt can open in place
function popupMenu(sx, sy, title, items) {
  const p = popupBase(sx, sy);
  if (title) el('div', { class: 'ptitle', text: title }, p);
  items.forEach(it => {
    const d = el('div', { class: 'pi', text: it.label, onclick: () => {
      closePopup();
      it.pick(sx, sy);
    } }, p);
    if (it.sub) el('div', { class: 'sub', text: it.sub }, d);
  });
}

function popupPrompt(sx, sy, title, placeholder, commit, initial) {
  const p = popupBase(sx, sy);
  if (title) el('div', { class: 'ptitle', text: title }, p);
  const inp = el('input', { type: 'text', placeholder: placeholder || '' }, p);
  if (initial) inp.value = initial;
  inp.focus();
  inp.onkeydown = e => {
    if (e.key === 'Enter') {
      const v = inp.value.trim();
      closePopup();
      if (NAME_RE.test(v)) commit(v);
    } else if (e.key === 'Escape') closePopup();
  };
}

/* ---------- wire meanings ----------
 * A wire always means "needs this first". Dropping a dragged wire on a
 * node asks HOW the dependency is carried — with an item the source
 * step yields, or with a flag for pure ordering (the editor writes the
 * setFlag/when plumbing itself). Every apply reuses the same mutation
 * helpers as the inspector, so the data shapes stay exactly what the
 * engine expects. */

function addFlagTo(holder, f) {
  const fs = toList(holder.setFlag);
  if (fs.indexOf(f) === -1) fs.push(f);
  holder.setFlag = fs.length === 1 ? fs[0] : fs;
}

function addWhenTo(obj, f, notYet) {
  const conds = toList(obj.when).filter(c => c && c.flag && c.flag !== f);
  conds.push(notYet ? { flag: f, value: false } : { flag: f });
  obj.when = conds.length === 1 ? conds[0] : conds;
}

// resolve a step node back to its live hotspot (primary state)
function hotspotOfNode(n) {
  const ref = n && n.ref;
  if (!ref || ref.kind !== 'hotspot') return null;
  const o = ((SCENES[ref.room] || {}).objects || [])[ref.idx];
  return o ? { o, rn: ref.room } : null;
}

// every item a step yields, across all its states and holders
function stepYields(n) {
  if (n.ref && n.ref.kind === 'recipe') {
    const c = COMBINE[n.ref.idx];
    return c && c.makes ? [c.makes] : [];
  }
  const hs = hotspotOfNode(n);
  if (!hs) return [];
  const out = {};
  const objs = SCENES[hs.rn].objects || [];
  const key = areaKey(hs.o);
  const scan = h => {
    if (!h) return;
    if (h.then && h.then.indexOf('pick:') === 0) out[h.then.slice(5)] = 1;
    if (h.items) Object.keys(h.items).forEach(x => {
      const e = h.items[x];
      if (e && typeof e === 'object' && !e.hint) scan(e);
    });
  };
  objs.forEach(o => {
    if (areaKey(o) !== key) return;
    if (o.item) out[o.item] = 1;
    scan(o); scan(o.locked); scan(o.open);
  });
  return Object.keys(out);
}

// the flags a step already sets (reused for ordering wires)
function stepSets(n) {
  const cs = n.ref && n.ref.kind === 'cutscene' && CUTSCENES[n.ref.name];
  if (cs) return toList(cs.setFlag);
  const hs = hotspotOfNode(n);
  if (!hs) return [];
  const out = {};
  const objs = SCENES[hs.rn].objects || [];
  const key = areaKey(hs.o);
  const scan = h => {
    if (!h) return;
    toList(h.setFlag).forEach(f => { out[f] = 1; });
    if (h.then && h.then.indexOf('cut:') === 0) {
      const c = CUTSCENES[h.then.slice(4)];
      if (c) toList(c.setFlag).forEach(f => { out[f] = 1; });
    }
    if (h.items) Object.keys(h.items).forEach(x => {
      const e = h.items[x];
      if (e && typeof e === 'object' && !e.hint) scan(e);
    });
  };
  objs.forEach(o => {
    if (areaKey(o) !== key) return;
    scan(o); scan(o.locked); scan(o.open);
  });
  return Object.keys(out);
}

// where a step's "this happened" flag should live: the moment the
// player completes it
function setterHolder(o) {
  if (o.item) return o;
  if (o.gate || o.locked) return (o.locked = o.locked || {});
  return o;
}

// a camelCase flag suggestion from the step's label ("take key" → "takeKey")
function suggestFlag(label) {
  const parts = String(label).split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return parts.map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p)).join('')
    .replace(/^[^a-zA-Z]+/, '') || 'newFlag';
}

function wireMeanings(g, fromId, toId) {
  const fn = g.nodes[fromId], tn = g.nodes[toId];
  const out = [];
  // apply may return false to take over (it opens its own prompt)
  const add = (label, sub, apply) => out.push({ label, sub, pick: (sx, sy) => {
    if (apply(sx, sy) === false) return;
    markDirty();
    refresh();
  } });

  const fromRoom = fn.kind === 'room' ? fn.ref.room : null;
  const toRoom = tn.kind === 'room' ? tn.ref.room : null;

  /* step → step */
  if (fn.kind === 'step' && tn.kind === 'step') {
    const items = stepYields(fn);
    const target = hotspotOfNode(tn);

    items.forEach(it => {
      if (tn.ref.kind === 'recipe') {
        const c = COMBINE[tn.ref.idx];
        if (c && (c.parts || []).indexOf(it) === -1) {
          add('ingredient: ' + it, 'goes into ' + (c.makes || 'the recipe'), () => {
            c.parts = c.parts || ['', ''];
            const slot = c.parts.indexOf('');
            if (slot === -1) c.parts.push(it); else c.parts[slot] = it;
          });
        }
      } else if (target && !target.o.item) {
        const o = target.o;
        if (o.gate || o.locked) {
          add(it + ' unlocks it', 'the lock opens with ' + it, () => {
            (o.locked = o.locked || {}).needs = it;
          });
        } else {
          add('needs a lock opened by ' + it, 'wraps the step in a lock', () => {
            lockHotspot(o, it, target.rn);
          });
        }
        add('works with ' + it + ' used on it', 'an item reaction with its own clip', () => {
          const holder = o.locked || o;
          holder.items = holder.items || {};
          if (!holder.items[it]) holder.items[it] = { consume: true };
        });
      }
    });

    // pure ordering: carried by a flag the editor wires up
    const owner = target && target.o; // `when` lives on the hotspot
    if (owner) {
      const already = stepSets(fn);
      add('must happen first', already.length
          ? 'uses its flag ⚑' + already[0]
          : 'creates a ⚑ flag between them', (sx, sy) => {
        if (already.length) {
          addWhenTo(owner, already[0], false);
          return;
        }
        popupPrompt(sx, sy, 'name the flag that remembers "' + fn.label + '"',
          'flag name', f => {
            const src = hotspotOfNode(fn);
            const holder = src ? setterHolder(src.o)
              : (fn.ref.kind === 'cutscene' ? CUTSCENES[fn.ref.name] : null);
            if (!holder) return;
            addFlagTo(holder, f);
            addWhenTo(owner, f, false);
            markDirty();
            refresh();
          }, suggestFlag(fn.label));
        return false;
      });
    }

    // triggering a not-yet-triggered cutscene folds it onto this step
    if (tn.ref.kind === 'cutscene' && fn.ref.kind === 'hotspot') {
      const src = hotspotOfNode(fn);
      const cn = tn.ref.name;
      if (src && !src.o.item) {
        add('this step plays ' + cn, 'the cutscene rides on the step', () =>
          setThen(tapHolder(src.o), src.rn)('cut:' + cn));
        if (src.o.gate || src.o.locked) {
          add('unlocking plays ' + cn, null, () =>
            setThen(src.o.locked = src.o.locked || {}, src.rn)('cut:' + cn));
        }
      } else if (src) {
        add('taking it plays ' + cn, null, () =>
          setThen(src.o, src.rn)('cut:' + cn));
      }
    }
  }

  /* step → room: the step opens the way (or is a plain exit) */
  if (fn.kind === 'step' && toRoom) {
    const src = hotspotOfNode(fn);
    if (src && !src.o.item) {
      const o = src.o;
      add('opens the way to ' + toRoom, 'a locked passage this step unlocks', () => {
        if (!o.gate && !o.locked) lockHotspot(o, null, src.rn);
        setThen(tapHolder(o), src.rn)('go:' + toRoom);
      });
      add('walk-through exit to ' + toRoom, 'always open — joins the rooms', () =>
        setThen(tapHolder(o), src.rn)('go:' + toRoom));
    }
    if (fn.ref.kind === 'cutscene') {
      const cs = CUTSCENES[fn.ref.name];
      if (cs) add('afterwards go to ' + toRoom, 'pick the walk-in clip in the inspector',
        () => { cs.then = 'go:' + toRoom; delete cs.entryAnim; });
    }
  }

  /* room → room: draw a new exit between them */
  if (fromRoom && toRoom) {
    add('add an exit to ' + toRoom, 'a walk-through hotspot (place it on the stage)', () => {
      const o = newHotspot(fromRoom, { area: [340, 240, 460, 360] });
      setThen(o, fromRoom)('go:' + toRoom);
      mapSelect({ kind: 'hotspot', room: fromRoom,
                  idx: SCENES[fromRoom].objects.length - 1 });
    });
  }

  return out;
}

/* ---------- the node canvas ---------- */

let lastGraph = null;
let wireDrag = null; // { from, x, y (world), over }

function refNodeId(ref) {
  if (!ref) return null;
  if (ref.kind === 'hotspot') {
    const objs = (SCENES[ref.room] || {}).objects || [];
    if (!objs[ref.idx]) return null;
    return stepNodeId(ref.room, ref.idx);
  }
  if (ref.kind === 'room') return 'room:' + ref.room;
  if (ref.kind === 'cutscene') return 'step:cut:' + ref.name;
  if (ref.kind === 'recipe') return 'step:make:' + ref.idx;
  return null;
}

// issue badge counts per node; problems on off-map things roll up onto
// their room (flavour spots) or the step that triggers them (cutscenes)
function badgeCounts(g) {
  const counts = {};
  const R = buildRefs();
  const bump = ref => {
    let id = refNodeId(ref);
    if ((!id || !g.nodes[id]) && ref) {
      if (ref.kind === 'hotspot') id = 'room:' + ref.room;
      else if (ref.kind === 'cutscene') {
        const trig = (R.cutUses[ref.name] || [])
          .filter(t => t.kind === 'hotspot')[0];
        if (trig) id = refNodeId(trig);
      }
    }
    if (id && g.nodes[id]) counts[id] = (counts[id] || 0) + 1;
  };
  computeIssues().forEach(iss => (iss.refs || []).slice(0, 1).forEach(bump));
  missingFiles().forEach(m => (m.refs || []).slice(0, 1).forEach(bump));
  return counts;
}

function edgeGeom(a, b, ha, hb) {
  ha = ha || H; hb = hb || H;
  const acx = a[0] + W / 2, acy = a[1] + ha / 2;
  const bcx = b[0] + W / 2, bcy = b[1] + hb / 2;
  let p1, p2, c1, c2;
  if (Math.abs(bcy - acy) >= Math.abs(bcx - acx)) {
    const s = bcy >= acy ? 1 : -1;
    p1 = [acx, a[1] + (s > 0 ? ha : 0)];
    p2 = [bcx, b[1] + (s > 0 ? 0 : hb)];
    const bend = clamp(Math.abs(bcy - acy) / 2, 26, 60) * s;
    c1 = [p1[0], p1[1] + bend];
    c2 = [p2[0], p2[1] - bend];
  } else {
    const s = bcx >= acx ? 1 : -1;
    p1 = [a[0] + (s > 0 ? W : 0), acy];
    p2 = [b[0] + (s > 0 ? 0 : W), bcy];
    const bend = clamp(Math.abs(bcx - acx) / 2, 26, 60) * s;
    c1 = [p1[0] + bend, p1[1]];
    c2 = [p2[0] - bend, p2[1]];
  }
  return { d: 'M' + p1[0] + ' ' + p1[1] + ' C' + c1[0] + ' ' + c1[1] + ' ' +
              c2[0] + ' ' + c2[1] + ' ' + p2[0] + ' ' + p2[1],
           mid: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] };
}

function nodeAt(wx, wy, exclude) {
  if (!lastGraph) return null;
  const ids = Object.keys(lastGraph.nodes);
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    if (id === exclude) continue;
    const p = LAYOUT.nodes[id];
    if (p && wx >= p[0] && wx <= p[0] + W &&
        wy >= p[1] && wy <= p[1] + nodeH(lastGraph.nodes[id])) return id;
  }
  return null;
}

function deleteWire(key) {
  if (!lastGraph) return;
  const e = lastGraph.edges.filter(x => x.from + '>' + x.to === key)[0];
  if (!e) return;
  if (!e.dels.length) {
    alert('This connection can’t be removed from the map.');
    return;
  }
  if (!confirm('Remove this connection' + (e.label ? ' (“' + e.label + '”)' : '') + '?')) return;
  e.dels.forEach(d => d());
  wireSel = null;
  markDirty();
  refresh();
}

function renderMap(reuse) {
  const g = lastGraph = reuse || buildStoryGraph();
  ensurePositions(g);
  const badges = badgeCounts(g);
  const P = LAYOUT.nodes;
  const selNodeId = refNodeId(mapSel);

  mapSvg.innerHTML = '';
  const defs = svgEl('defs', {}, mapSvg);
  const marker = svgEl('marker', { id: 'maparrow', viewBox: '0 0 10 10',
    refX: '9', refY: '5', markerWidth: '7', markerHeight: '7',
    orient: 'auto-start-reverse' }, defs);
  svgEl('path', { d: 'M0 0 L10 5 L0 10 z', fill: '#67718c' }, marker);
  const markerSel = svgEl('marker', { id: 'maparrowsel', viewBox: '0 0 10 10',
    refX: '9', refY: '5', markerWidth: '7', markerHeight: '7',
    orient: 'auto-start-reverse' }, defs);
  svgEl('path', { d: 'M0 0 L10 5 L0 10 z', fill: '#8cf' }, markerSel);
  const markerExit = svgEl('marker', { id: 'maparrowexit', viewBox: '0 0 10 10',
    refX: '9', refY: '5', markerWidth: '7', markerHeight: '7',
    orient: 'auto-start-reverse' }, defs);
  svgEl('path', { d: 'M0 0 L10 5 L0 10 z', fill: 'rgba(111,196,140,0.8)' }, markerExit);

  // background rect: pan + double-click-to-add-room live here
  const bg = svgEl('rect', { width: '100%', height: '100%', fill: 'transparent' }, mapSvg);
  bg.onmousedown = startPan;
  bg.ondblclick = e => {
    const w = toWorld(e.clientX, e.clientY);
    popupPrompt(e.clientX, e.clientY, 'New room', 'room id, e.g. kitchen', v => {
      if (SCENES[v]) return;
      SCENES[v] = { objects: [] };
      ensureRoomDefaults(v);
      LAYOUT.nodes['room:' + v] = [w[0] - W / 2, w[1] - H / 2];
      markDirty();
      mapSelect({ kind: 'room', room: v });
    });
  };

  const world = svgEl('g', { transform:
    'translate(' + view.x + ' ' + view.y + ') scale(' + view.k + ')' }, mapSvg);

  const ids = Object.keys(g.nodes);

  // room containers: a dashed box around the room's title bar + steps
  (g.roomOrder || []).forEach(rn => {
    const members = ids.filter(id => g.nodes[id].lane === rn && P[id]);
    if (!members.length) return;
    const xs = members.map(id => P[id][0]);
    const ys = members.map(id => P[id][1]);
    const y2s = members.map(id => P[id][1] + nodeH(g.nodes[id]));
    const rect = svgEl('rect', {
      x: Math.min.apply(null, xs) - 12, y: Math.min.apply(null, ys) - 12,
      width: Math.max.apply(null, xs) + W - Math.min.apply(null, xs) + 24,
      height: Math.max.apply(null, y2s) - Math.min.apply(null, ys) + 24,
      rx: 12, fill: 'rgba(76,175,109,0.05)', stroke: 'rgba(111,196,140,0.35)',
      'stroke-dasharray': '5 4'
    }, world);
    rect.onmousedown = startPan;
    rect.ondblclick = e => {
      e.stopPropagation();
      newHotspot(rn, { area: [340, 240, 460, 360] });
      markDirty();
      mapSelect({ kind: 'hotspot', room: rn, idx: SCENES[rn].objects.length - 1 });
    };
  });

  // exits between rooms: ONE-WAY arrows, one per direction. Each is
  // nudged to the right of its travel direction so a pair of opposite
  // exits shows as two parallel lines. Click jumps to the exit spot.
  (g.exits || []).forEach(x => {
    const a = P['room:' + x.a];
    const b2 = P['room:' + x.b];
    if (!a || !b2) return;
    const dx = b2[0] - a[0], dy = b2[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const px = -dy / len * 7, py = dx / len * 7; // perpendicular nudge
    const geom = edgeGeom([a[0] + px, a[1] + py], [b2[0] + px, b2[1] + py],
                          ROOM_H, ROOM_H);
    svgEl('path', { d: geom.d, fill: 'none',
      stroke: 'rgba(111,196,140,0.55)', 'stroke-width': '1.5',
      'marker-end': 'url(#maparrowexit)' }, world);
    const t = svgEl('text', { x: geom.mid[0] + px, y: geom.mid[1] + py + 3,
      'text-anchor': 'middle',
      fill: 'rgba(111,196,140,0.8)', 'font-size': '11', 'font-family': 'sans-serif',
      'paint-order': 'stroke', stroke: '#191b21', 'stroke-width': '4',
      text: 'exit' }, world);
    t.style.pointerEvents = 'all';
    t.style.cursor = 'pointer';
    t.onmousedown = e => e.stopPropagation();
    t.onclick = () => mapSelect(x.ref);
  });

  // story edges under the nodes; labels say what the connection does
  const touching = {};
  g.edges.forEach(e => {
    if (e.hidden) return;
    const a = P[e.from], b = P[e.to];
    if (!a || !b) return;
    const key = e.from + '>' + e.to;
    const isSel = wireSel === key;
    const geom = edgeGeom(a, b, nodeH(g.nodes[e.from]), nodeH(g.nodes[e.to]));
    const p = svgEl('path', { d: geom.d, fill: 'none',
      stroke: isSel ? '#8cf' : '#4a5064', 'stroke-width': isSel ? '2.5' : '1.5',
      'marker-end': isSel ? 'url(#maparrowsel)' : 'url(#maparrow)' }, world);
    (touching[e.from] = touching[e.from] || []).push(p);
    (touching[e.to] = touching[e.to] || []).push(p);
    // fat invisible twin catches clicks
    const hit = svgEl('path', { d: geom.d, fill: 'none', stroke: 'transparent',
      'stroke-width': '13' }, world);
    hit.style.cursor = 'pointer';
    hit.style.pointerEvents = 'stroke';
    hit.onmousedown = ev => ev.stopPropagation();
    hit.onclick = () => { wireSel = wireSel === key ? null : key; renderMap(g); };
    if (e.label) {
      svgEl('text', { x: geom.mid[0], y: geom.mid[1] + 3,
        'text-anchor': 'middle', fill: isSel ? '#bfe0ff' : '#93a0bd', 'font-size': '10',
        'font-family': 'sans-serif', 'paint-order': 'stroke',
        stroke: '#191b21', 'stroke-width': '4', text: e.label }, world);
    }
    if (isSel) {
      const del = svgEl('g', {}, world);
      svgEl('circle', { cx: geom.mid[0], cy: geom.mid[1] - 14, r: 9,
        fill: '#5a2626', stroke: '#ff9d9d' }, del);
      const xt = svgEl('text', { x: geom.mid[0], y: geom.mid[1] - 10,
        'text-anchor': 'middle', fill: '#ff9d9d', 'font-size': '11',
        'font-family': 'sans-serif', text: '✕' }, del);
      xt.style.pointerEvents = 'none';
      del.style.cursor = 'pointer';
      del.onmousedown = ev => ev.stopPropagation();
      del.onclick = () => deleteWire(key);
    }
  });

  // wire being dragged right now
  if (wireDrag) {
    const a = P[wireDrag.from];
    svgEl('path', { d: 'M' + (a[0] + W) + ' ' +
      (a[1] + nodeH(g.nodes[wireDrag.from]) / 2) +
      ' L' + wireDrag.x + ' ' + wireDrag.y,
      fill: 'none', stroke: '#d4a72c', 'stroke-width': '2',
      'stroke-dasharray': '6 4' }, world);
  }

  // nodes: steps, and each room's title bar
  ids.forEach(id => {
    const n = g.nodes[id];
    const k = MAP_KINDS[n.kind];
    const p = P[id];
    if (!p) return;
    const [x, y] = p;
    const h = nodeH(n);
    const grp = svgEl('g', { style: 'cursor:move' }, world);
    const isSel = selNodeId === id;
    const isOver = wireDrag && wireDrag.over === id;
    svgEl('rect', { x: x, y: y, width: W, height: h, rx: n.kind === 'room' ? 6 : 8,
      fill: k.fill, stroke: isSel || isOver ? '#fff' : k.stroke,
      'stroke-width': isSel || isOver ? '3' : '1.5' }, grp);
    if (n.kind === 'room') {
      svgEl('text', { x: x + W / 2, y: y + 17, 'text-anchor': 'middle',
        fill: '#b5e0c3', 'font-size': '12', 'font-weight': 'bold',
        'font-family': 'sans-serif',
        text: (n.start ? '▶ ' : '') + n.label }, grp);
    } else {
      svgEl('text', { x: x + W / 2, y: y + (n.sub ? 17 : 24), 'text-anchor': 'middle',
        fill: '#fff', 'font-size': '12', 'font-family': 'sans-serif',
        text: n.label.length > 21 ? n.label.slice(0, 20) + '…' : n.label }, grp);
      if (n.sub) {
        svgEl('text', { x: x + W / 2, y: y + 31, 'text-anchor': 'middle',
          fill: k.stroke, 'font-size': '10', 'font-family': 'sans-serif',
          text: n.sub.length > 26 ? n.sub.slice(0, 25) + '…' : n.sub }, grp);
      }
    }
    if (badges[id]) {
      const bd = svgEl('g', {}, grp);
      svgEl('circle', { cx: x + W - 2, cy: y + 2, r: 8,
        fill: '#c0392b', stroke: '#191b21', 'stroke-width': '1.5' }, bd);
      const bt = svgEl('text', { x: x + W - 2, y: y + 5.5, 'text-anchor': 'middle',
        fill: '#fff', 'font-size': '10', 'font-family': 'sans-serif',
        text: String(badges[id]) }, bd);
      bt.style.pointerEvents = 'none';
      bd.style.cursor = 'pointer';
      bd.onmousedown = ev => ev.stopPropagation();
      bd.onclick = () => { drawerOpen = true; refresh(); };
    }
    // ● port: drag from here to connect this node to another
    const port = svgEl('circle', { cx: x + W, cy: y + h / 2, r: 5.5,
      fill: k.stroke, stroke: '#14151a', 'stroke-width': '1.5' }, grp);
    port.style.cursor = 'crosshair';
    port.onmousedown = ev => { ev.stopPropagation(); startWireDrag(ev, id); };

    grp.onmouseover = () => (touching[id] || []).forEach(pp => {
      pp.setAttribute('stroke', '#8cf'); pp.setAttribute('stroke-width', '2.5');
    });
    grp.onmouseout = () => (touching[id] || []).forEach(pp => {
      pp.setAttribute('stroke', '#4a5064'); pp.setAttribute('stroke-width', '1.5');
    });
    grp.onmousedown = ev => startNodeDrag(ev, id, g);
  });
}

/* ---------- map interactions ---------- */

function startPan(ev) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  closePopup();
  const sx = ev.clientX, sy = ev.clientY;
  const v0 = { x: view.x, y: view.y };
  let moved = false;
  mapSvg.classList.add('panning');
  function onMove(e2) {
    moved = true;
    view.x = v0.x + (e2.clientX - sx);
    view.y = v0.y + (e2.clientY - sy);
    renderMap(lastGraph);
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    mapSvg.classList.remove('panning');
    if (!moved && wireSel) { wireSel = null; renderMap(lastGraph); }
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function startNodeDrag(ev, id, g) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  closePopup();
  const start = toWorld(ev.clientX, ev.clientY);
  // a room header drags its whole container
  const moveIds = g.nodes[id].kind === 'room'
    ? Object.keys(g.nodes).filter(x =>
        x === id || (g.nodes[x].lane === g.nodes[id].label && LAYOUT.nodes[x]))
    : [id];
  const starts = {};
  moveIds.forEach(x => { starts[x] = LAYOUT.nodes[x].slice(); });
  let moved = false;
  function onMove(e2) {
    const p = toWorld(e2.clientX, e2.clientY);
    const dx = p[0] - start[0], dy = p[1] - start[1];
    if (Math.abs(dx) > 3 / view.k || Math.abs(dy) > 3 / view.k) moved = true;
    if (!moved) return;
    moveIds.forEach(x => {
      LAYOUT.nodes[x] = [starts[x][0] + dx, starts[x][1] + dy];
    });
    renderMap(g);
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (moved) markDirty();
    else if (g.nodes[id].ref) mapSelect(g.nodes[id].ref);
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function startWireDrag(ev, fromId) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  closePopup();
  const g = lastGraph;
  const w0 = toWorld(ev.clientX, ev.clientY);
  wireDrag = { from: fromId, x: w0[0], y: w0[1], over: null };
  function onMove(e2) {
    const p = toWorld(e2.clientX, e2.clientY);
    wireDrag.x = p[0];
    wireDrag.y = p[1];
    wireDrag.over = nodeAt(p[0], p[1], fromId);
    renderMap(g);
  }
  function onUp(e2) {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    const target = wireDrag.over;
    wireDrag = null;
    renderMap(g);
    if (!target) return;
    const meanings = wireMeanings(g, fromId, target);
    if (!meanings.length) return; // nothing sensible — wire snaps back
    if (meanings.length === 1) {
      closePopup();
      meanings[0].pick(e2.clientX, e2.clientY);
      return;
    }
    popupMenu(e2.clientX, e2.clientY,
      g.nodes[fromId].label + ' → ' + g.nodes[target].label, meanings);
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// selecting a node opens it in the side pane (stage + inspector)
function mapSelect(ref) {
  mapSel = ref;
  wireSel = null;
  if (ref && ref.kind === 'hotspot') { room = ref.room; sel = ref.idx; }
  else if (ref && ref.kind === 'room') { room = ref.room; sel = -1; }
  else if (ref && ref.kind === 'cutscene') csPreviewStep = 0;
  refresh();
}

document.addEventListener('keydown', e => {
  const t = document.activeElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (e.key === 'Escape') { closePopup(); if (wireSel) { wireSel = null; renderMap(lastGraph); } }
  if ((e.key === 'Delete' || e.key === 'Backspace') && wireSel) {
    e.preventDefault();
    deleteWire(wireSel);
  }
});

/* ---------- toolbar: add / tidy / fit ---------- */

document.getElementById('tidybtn').onclick = () => {
  tidyLayout();
  markDirty();
  fitView(lastGraph || buildStoryGraph());
  refresh();
};

document.getElementById('fitbtn').onclick = () => {
  fitView(lastGraph || buildStoryGraph());
  renderMap(lastGraph);
};

document.getElementById('addbtn').onclick = e => {
  const roomPick = then => popupMenu(e.clientX, e.clientY + 20, 'in which room?',
    Object.keys(SCENES).map(rn => ({ label: rn, pick: () => then(rn) })));
  popupMenu(e.clientX, e.clientY + 10, 'Add to the game', [
    { label: 'Room…', sub: 'a place with a background and hotspots', pick: () =>
      popupPrompt(e.clientX, e.clientY + 10, 'New room', 'room id, e.g. kitchen', v => {
        if (SCENES[v]) return;
        SCENES[v] = { objects: [] };
        ensureRoomDefaults(v);
        markDirty();
        mapSelect({ kind: 'room', room: v });
      }) },
    { label: 'Take an item…', sub: 'a pickup lying in a room', pick: () =>
      roomPick(rn => popupPrompt(e.clientX, e.clientY + 10, 'New item in ' + rn,
        'item id, e.g. rope', v => {
          newHotspot(rn, { item: v, area: [340, 240, 460, 360], anim: conv.pick(rn, v) });
          markDirty();
          mapSelect({ kind: 'hotspot', room: rn, idx: SCENES[rn].objects.length - 1 });
        })) },
    { label: 'Step in a room…', sub: 'a hotspot: lock, item use, lever…', pick: () =>
      roomPick(rn => {
        newHotspot(rn, { area: [340, 240, 460, 360] });
        markDirty();
        mapSelect({ kind: 'hotspot', room: rn, idx: SCENES[rn].objects.length - 1 });
      }) },
    { label: 'Make an item (combine)', sub: 'item + item = new item', pick: () => {
        COMBINE.push({ parts: ['', ''], makes: '' });
        markDirty();
        mapSelect({ kind: 'recipe', idx: COMBINE.length - 1 });
      } },
    { label: 'Cutscene…', sub: 'a timed clip sequence', pick: () =>
      popupPrompt(e.clientX, e.clientY + 10, 'New cutscene', 'cutscene id, e.g. finale', v => {
        if (CUTSCENES[v]) return;
        CUTSCENES[v] = { steps: [{}] };
        markDirty();
        mapSelect({ kind: 'cutscene', name: v });
      }) }
  ]);
};

/* ---------- side pane (stage + inspector) ---------- */

function validateSel() {
  if (!mapSel) return;
  const k = mapSel.kind;
  if (k === 'hotspot' &&
      !(SCENES[mapSel.room] && SCENES[mapSel.room].objects[mapSel.idx])) mapSel = null;
  else if (k === 'room' && !SCENES[mapSel.room]) mapSel = null;
  else if (k === 'cutscene' && !CUTSCENES[mapSel.name]) mapSel = null;
  else if (k === 'recipe' && !COMBINE[mapSel.idx]) mapSel = null;
  if (!SCENES[room]) { room = Object.keys(SCENES)[0]; sel = -1; }
}

function renderRecipeView(panel, i) {
  const c = COMBINE[i];
  el('h2', { text: 'combine recipe' }, panel);
  c.parts = c.parts || ['', ''];
  const d = sec(panel, 'story');
  const b = line(d);
  b.appendChild(namePicker(collectItems(), c.parts[0], v => { c.parts[0] = v; },
    { blank: false, placeholder: 'new item id' }));
  word(b, '+');
  b.appendChild(namePicker(collectItems(), c.parts[1], v => { c.parts[1] = v; },
    { blank: false, placeholder: 'new item id' }));
  word(b, '=');
  b.appendChild(namePicker(collectItems(), c.makes, v => { c.makes = v; },
    { blank: false, placeholder: 'new item id' }));
  if (c.makes) artChips(d, [conv.icon(c.makes)]);
  el('div', { class: 'muted', text:
    'Both parts are consumed; the result lands in the hotbar. ' +
    'Only icon_' + (c.makes || '<makes>') + '.png is needed on disk.' }, d);
  const btns = el('div', { class: 'row' }, panel);
  el('button', { class: 'mini danger big', text: 'Delete recipe', onclick: () => {
    COMBINE.splice(i, 1);
    mapSel = null;
    markDirty(); refresh();
  } }, btns);
}

// game-level settings (the START node)
function renderGameSettings(panel) {
  el('h2', { text: 'Game start' }, panel);
  let d = sec(panel, 'nav', 'Start');
  let b = line(d);
  word(b, 'the game starts in');
  b.appendChild(selectInput(Object.keys(SCENES), START_ROOM,
    v => { START_ROOM = v; }, { blank: false }));
  word(b, 'after cutscene');
  b.appendChild(selectInput(Object.keys(CUTSCENES), START_CUT,
    v => { START_CUT = v; }, { blank: 'no intro' }));

  d = sec(panel, 'story', 'Combining');
  b = line(d);
  word(b, 'a no-recipe pair says');
  b.appendChild(selectInput(soundGroups(''), COMBINE_HINT,
    v => { COMBINE_HINT = v; }, { blank: 'nothing (just switch selection)' }));
}

// the full editor for one cutscene; steps preview on the stage
function renderCutsceneEditor(panel, csName) {
  const cs = CUTSCENES[csName];
  el('h2', { text: 'cutscene: ' + csName }, panel);

  const trig = line(panel);
  word(trig, 'triggered by:');
  refChips(trig, buildRefs().cutUses[csName],
    'nothing — drag a wire from a spot to this node');

  const d = sec(panel, 'nav', 'Playback');
  let b = line(d);
  word(b, 'tap to skip');
  b.appendChild(boolInput(cs.skip, setOrDelete(cs, 'skip')));
  word(b, 'afterwards');
  b.appendChild(selectInput(afterGroups(false).filter(g => g.label === 'rooms'),
    cs.then, setOrDelete(cs, 'then'), { blank: 'back to the room', labelFn: afterLabel }));
  const csTarget = goTarget(cs.then);
  if (csTarget) {
    word(b, 'arriving with');
    b.appendChild(selectInput(arriveClips(csTarget), cs.entryAnim, setOrDelete(cs, 'entryAnim')));
  }
  const ds = sec(panel, 'story', 'Story');
  flagsLine(ds, cs, 'finished, sets');

  el('h2', { text: 'Steps — click a row to preview it above' }, panel);
  const table = el('table', { class: 'steps' }, panel);
  const head = el('tr', {}, table);
  ['backdrop', 'char clip', 'ms', 'sound', ''].forEach(h => {
    el('td', { html: '<b>' + h + '</b>' }, head);
  });
  (cs.steps || []).forEach((st, i) => {
    const tr = el('tr', { class: i === csPreviewStep ? 'prev' : '' }, table);
    tr.onclick = () => { csPreviewStep = i; redrawStage(); renderSide(); };
    el('td', {}, tr).appendChild(selectInput(cutBgClips(), st.bg, setOrDelete(st, 'bg')));
    el('td', {}, tr).appendChild(selectInput(cutCharClips(), st.anim, setOrDelete(st, 'anim')));
    el('td', {}, tr).appendChild(numInput(st.dur, setOrDelete(st, 'dur'), 'auto'));
    el('td', {}, tr).appendChild(selectInput(soundGroups(room), st.sound, v => {
      setOrDelete(st, 'sound')(v);
      autoHold(st, st.anim || st.bg, 'dur', v);
    }));
    el('td', {}, tr).appendChild(el('button', { class: 'mini danger', text: 'x',
      onclick: () => { cs.steps.splice(i, 1); markDirty(); refresh(); } }, tr));
  });
  const btns = el('div', { class: 'row' }, panel);
  el('button', { class: 'mini big', text: '+ Add step', onclick: () => {
    cs.steps.push({}); markDirty(); refresh();
  } }, btns);
  el('button', { class: 'mini danger big', text: 'Delete cutscene', onclick: () => {
    if (!confirm('Delete cutscene "' + csName + '"?')) return;
    delete CUTSCENES[csName];
    mapSel = null;
    markDirty(); refresh();
  } }, btns);
}

function renderSide() {
  validateSel();
  const mode = stageMode();
  const hint = document.getElementById('stagehint');
  stagebox.style.display = mode ? '' : 'none';
  overlay.style.display = mode === 'room' ? '' : 'none';
  hint.textContent = mode === 'room'
    ? 'drag on empty space to draw a hotspot · drag to move · blue corner resizes'
    : '';
  if (mode) { fitStage(); redrawStage(); renderOverlay(); }

  inspector.innerHTML = '';
  const panel = el('div', { class: 'panel' }, inspector);
  if (!mapSel) {
    el('h2', { text: 'The map is the walkthrough' }, panel);
    el('div', { class: 'muted', html:
      'Every node is a <b>step</b> — something the player does. Every ' +
      'wire means <b>“needs this first”</b>, labelled with the item ' +
      '(or ⚑flag) that carries it. Rooms are the dashed boxes; a ' +
      'locked door is a step whose wire <i>opens</i> the next box.<br><br>' +
      '<b>click a step</b> — edit it here (stage above for its room)<br>' +
      '<b>drag a node</b> — arrange the map (saved with the game)<br>' +
      '<b>drag from a node’s ●</b> — connect: “this needs that”<br>' +
      '<b>click a wire</b> — select it; ✕ removes the connection<br>' +
      '<b>double-click</b> — new room (empty space) or step (in a room)<br>' +
      '<b>Tidy</b> — lay the map out as the walkthrough, top to bottom' }, panel);
    renderGameSettings(el('div', { class: 'panel' }, inspector));
    return;
  }
  if (mapSel.kind === 'hotspot') {
    el('h2', { text: room + ' · ' + objectLabel(SCENES[room].objects[sel], sel) }, panel);
    renderHotspot(panel, SCENES[room].objects[sel]);
  } else if (mapSel.kind === 'room') {
    renderRoomCard(panel);
  } else if (mapSel.kind === 'cutscene') {
    renderCutsceneEditor(panel, mapSel.name);
  } else if (mapSel.kind === 'recipe') {
    renderRecipeView(panel, mapSel.idx);
  } else {
    renderGameSettings(panel);
  }
}

/* ---------- issues strip + drawer ---------- */

function renderStatusStrip() {
  const strip = document.getElementById('issuestrip');
  strip.innerHTML = '';
  const issues = computeIssues();
  const missing = missingFiles();
  const errors = issues.filter(i => i.level === 'error').length + missing.length;
  const notes = issues.filter(i => i.level === 'note').length;
  if (!errors && !notes) {
    el('span', { class: 'ok', text: '✓ no problems' }, strip);
  } else {
    if (errors) el('span', { class: 'err', text: '⚠ ' + errors + ' problem' +
      (errors === 1 ? '' : 's') }, strip);
    if (errors && notes) el('span', { text: ' · ' }, strip);
    if (notes) el('span', { class: 'note', text: notes + ' note' +
      (notes === 1 ? '' : 's') }, strip);
  }
  el('span', { class: 'muted', text: drawerOpen ? '  ▾' : '  ▴' }, strip);
  strip.onclick = () => { drawerOpen = !drawerOpen; refresh(); };

  const drawer = document.getElementById('drawer');
  drawer.className = drawerOpen ? 'open' : '';
  drawer.innerHTML = '';
  if (!drawerOpen) return;
  el('h2', { text: 'Story problems', style: 'font-size:13px;margin:0 0 6px' }, drawer);
  if (!issues.length) el('div', { class: 'allgood', text: 'No story problems.' }, drawer);
  issues.forEach(iss => {
    const d = el('div', { class: 'issue' }, drawer);
    el('span', { class: 'kind ' + iss.level, text: iss.level }, d);
    el('span', { text: iss.text }, d);
    refChips(d, iss.refs);
  });
  el('h2', { text: 'Missing files — the art & sound request list',
    style: 'font-size:13px;margin:12px 0 6px' }, drawer);
  if (!missing.length) el('div', { class: 'allgood', text: 'Every referenced file exists.' }, drawer);
  missing.forEach(m => {
    const d = el('div', { class: 'issue' }, drawer);
    el('span', { class: 'art missing', text: m.file }, d);
    refChips(d, m.refs);
  });
  if (missing.length) {
    el('div', { class: 'muted', text:
      'Author these as GIFs in art/ and run: python3 tools/make_sheets.py' }, drawer);
  }
}

/* ---------- shell ---------- */

function renderAll() {
  ensureIds();
  renderMap();
  renderSide();
  renderStatusStrip();
}

document.getElementById('reloadbtn').onclick = () => {
  if (!dirty || confirm('Discard unsaved changes?')) { dirty = false; location.reload(); }
};

document.getElementById('savebtn').onclick = () => {
  statusEl.textContent = 'saving…'; statusEl.style.color = '#8cf';
  LAYOUT.view = view;
  LAYOUT.v = 2;
  fetch('/api/scenes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startRoom: START_ROOM || null,
      startCutscene: START_CUT || null,
      cutscenes: CUTSCENES,
      combine: COMBINE,
      combineHint: COMBINE_HINT || null,
      scenes: SCENES,
      layout: LAYOUT
    })
  }).then(r => r.json()).then(r => {
    if (r.ok) {
      dirty = false;
      statusEl.textContent = 'saved ✓'; statusEl.style.color = '#8f8';
    } else {
      statusEl.textContent = 'save failed'; statusEl.style.color = '#e66';
      alert('Save failed: ' + (r.error || 'unknown'));
    }
  }).catch(e => {
    statusEl.textContent = 'save failed'; statusEl.style.color = '#e66';
    alert('Save failed: ' + e);
  });
};

/* ---------- boot ---------- */

ensureIds();
renderAll(); // render immediately; dropdowns fill in when assets arrive

fetch('/editor-layout.json').then(r => (r.ok ? r.json() : null)).then(l => {
  if (l && l.nodes && l.v === 2) { // older layouts keyed different node ids
    LAYOUT = l;
    if (l.view) view = l.view;
    renderAll();
  } else {
    // first run: tidy, and frame the whole map
    tidyLayout();
    fitView(lastGraph || buildStoryGraph());
    renderAll();
  }
}).catch(() => {});

fetch('/api/assets').then(r => {
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}).then(a => {
  assets = a;
  assets.soundMs = assets.soundMs || {};
  renderAll();
}).catch(e => {
  statusEl.textContent = 'no asset lists'; statusEl.style.color = '#e66';
  alert('Could not load /api/assets — dropdowns will be empty.\n\n' +
        'Most likely an OLD dev server is still running: stop it and ' +
        'restart with `node server.js`.\n\n(' + e + ')');
});

// console handle for debugging (and the headless editor smoke test)
window.EDITOR = {
  graph: buildStoryGraph,
  select: mapSelect,
  meanings: wireMeanings,
  tidy: tidyLayout,
  state: () => ({ mapSel, room, sel, dirty, LAYOUT })
};

})();
