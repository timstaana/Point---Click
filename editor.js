/* Story Editor — dev tool for the design team (modern browsers only;
 * the game never loads this).
 *
 * Organised around how a point & click game actually fits together:
 *
 *   Rooms     — the stage: draw hotspots, edit what each one does.
 *               The inspector reads top-to-bottom in play order:
 *               appears when → what it is → looks & sound → afterwards.
 *   Story     — the connective tissue: every item (where it's found,
 *               where it's used), every flag (who sets it, who needs
 *               it), combine recipes, and the room map. Everything is
 *               a jump-link to the place it's defined.
 *   Cutscenes — timed clip sequences + where they're triggered from.
 *   Game      — start room / start cutscene / global lines.
 *   Issues    — live validation: dead flags, unobtainable items,
 *               broken links, and the missing-art request list.
 *
 * Everything derivable from the naming conventions is automatic:
 * room bg/idle/can't-use, pickup grab clips, walk-in clips, gate cels,
 * and hold times (from the WAV's real length). Dropdowns are scoped by
 * the same conventions — art named to the scene sorts to the top.
 * Save rewrites scenes.js via the dev server; every save keeps a
 * timestamped copy in backups/. */

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
let tab = 'rooms';
let room = SCENES[START_ROOM] ? START_ROOM : Object.keys(SCENES)[0];
let sel = -1;
let curCut = Object.keys(CUTSCENES)[0] || null;
let dirty = false;
let stageScale = 1;

const stage = document.getElementById('stage');
const ctx = stage.getContext('2d');
const overlay = document.getElementById('overlay');
const right = document.getElementById('right');
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
function lockHotspot(o, needsItem) {
  if (o.gate || o.locked) return;
  const open = {};
  ['anim', 'objAnim', 'sound', 'dur', 'then', 'entryAnim', 'entryDur',
   'cursor', 'setFlag', 'setFlagValue', 'clearFlag'].forEach(k => {
    if (k in o) { open[k] = o[k]; delete o[k]; }
  });
  const t = goTarget(open.then);
  o.gate = room + '_' + (t ? t + 'door' : 'lock');
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

function objectCel(o) {
  if (o.item) return conv.itemCel(room, o.item);
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
 * The heart of the Story/Issues tabs: one walk over the data collects
 * where every item and flag is produced and consumed, and where every
 * cutscene is triggered from. A "ref" points back at the owning thing
 * and can be jumped to. */

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

function gotoRef(ref) {
  if (ref.kind === 'hotspot' || ref.kind === 'room') {
    if (SCENES[ref.room]) {
      room = ref.room;
      sel = ref.kind === 'hotspot' ? ref.idx : -1;
    }
    setTab('rooms');
  } else if (ref.kind === 'cutscene') {
    if (CUTSCENES[ref.name]) curCut = ref.name;
    setTab('cutscenes');
  } else if (ref.kind === 'recipe') {
    setTab('story');
  } else {
    setTab('game');
  }
}

function refChip(parent, ref) {
  el('span', { class: 'ref', text: whereLabel(ref), onclick: () => gotoRef(ref) }, parent);
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

// Every missing file across the whole game -> [{file, kind, refs}]
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

function updateBadge() {
  const missing = missingFiles();
  const issues = computeIssues();
  const errors = issues.filter(i => i.level === 'error').length + missing.length;
  const total = errors + issues.filter(i => i.level === 'note').length;
  const badge = document.getElementById('issuebadge');
  badge.textContent = String(total);
  badge.className = 'badge' + (errors ? '' : ' zero');
}

/* ---------- generic inputs ----------
 * All pickers refresh the whole UI on change; mutation callbacks own
 * their data edit, the picker marks dirty (unless opts.nav — pure
 * navigation, e.g. choosing which cutscene to look at). */

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

/* ---------- stage ---------- */

function fitStage() {
  const box = document.getElementById('stagebox');
  if (!box.clientWidth) return;
  stageScale = Math.min(1, box.clientWidth / 800);
  document.getElementById('stagewrap').style.transform = 'scale(' + stageScale + ')';
  box.style.height = Math.round(600 * stageScale) + 'px';
}
window.addEventListener('resize', () => { if (tab === 'rooms') { fitStage(); } });

function loadImg(name) {
  if (!imgCache[name]) {
    const im = new Image();
    im.onload = () => { if (tab === 'rooms') drawStage(); };
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

/* ---------- dropdown previews ----------
 * Picking a file in any dropdown previews it: clips play on the stage
 * canvas over the room (rooms tab only), sounds just play. */

let previewState = null;
let previewTimer = null;
let previewAudio = null;

function paintPreview() {
  if (!previewState || tab !== 'rooms' || Date.now() > previewState.until) {
    previewState = null;
    if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
    if (tab === 'rooms') drawStage();
    return;
  }
  drawStage();
  drawClipFrame(previewState.name, Date.now() - previewState.start);
}

function previewClip(name) {
  if (tab !== 'rooms' || !hasArt(name)) return;
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

function renderOverlay() {
  overlay.innerHTML = '';
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

function startDrag(ev, index, mode) {
  ev.preventDefault();
  if (sel !== index) { sel = index; renderOverlay(); renderRight(); }
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
    if (moved) { markDirty(); renderRight(); }
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

overlay.onmousedown = ev => {
  if (ev.target !== overlay) return;
  ev.preventDefault();
  const start = stagePos(ev);
  let drew = false;
  function onMove(e2) {
    const p = stagePos(e2);
    if (!drew && (Math.abs(p[0] - start[0]) > 10 || Math.abs(p[1] - start[1]) > 10)) {
      drew = true;
      SCENES[room].objects.push({ area: [start[0], start[1], p[0], p[1]] });
      sel = SCENES[room].objects.length - 1;
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
    else if (sel !== -1) { sel = -1; renderOverlay(); renderRight(); }
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
      namePicker(collectItems(), '', v => { if (v) lockHotspot(o, v); },
        { blank: 'opens with…', placeholder: 'new item id' }));
    return null;
  }
  if (!o.gate && !o.locked) lockHotspot(o); // legacy plain-needs spot
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
        onclick: () => { if (i !== sel) { sel = i; refresh(); } } }, wrap);
    });
  }
  el('div', { class: 'chip', text: '+ state',
    title: 'copy this hotspot as another state of the same spot — same ' +
           'area, shown under different flag conditions (e.g. the ' +
           'fountain after the coin has been fished)',
    onclick: () => {
      SCENES[room].objects.splice(sel + 1, 0, JSON.parse(JSON.stringify(o)));
      sel = sel + 1;
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
      sel = -1; markDirty(); refresh();
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

  advancedSec(panel, s);

  const btns = el('div', { class: 'row' }, panel);
  el('button', { class: 'mini danger big', text: 'Delete room', onclick: () => {
    if (Object.keys(SCENES).length < 2) { alert('Cannot delete the only room.'); return; }
    const inbound = roomConnections(room).from.length;
    if (!confirm('Delete room "' + room + '" and all its hotspots?' +
        (inbound ? '\n\n' + inbound + ' exit(s) in other rooms lead here and will break.' : ''))) return;
    delete SCENES[room];
    room = Object.keys(SCENES)[0];
    sel = -1; markDirty(); refresh();
  } }, btns);
}

function renderRoomsRight() {
  const panel = el('div', { class: 'panel' }, right);
  if (sel >= 0 && SCENES[room].objects[sel]) renderHotspot(panel, SCENES[room].objects[sel]);
  else renderRoomCard(panel);

  const listPanel = el('div', { class: 'panel' }, right);
  el('h2', { text: 'Hotspots in ' + room }, listPanel);
  const ul = el('ul', { id: 'objlist' }, listPanel);
  const objs = SCENES[room].objects || [];
  areaGroups(objs).forEach(idxs => {
    const i = idxs.indexOf(sel) >= 0 ? sel : idxs[0];
    const o = objs[i];
    const li = el('li', { class: idxs.indexOf(sel) >= 0 ? 'sel' : '' }, ul);
    li.onclick = () => { sel = i; renderOverlay(); renderRight(); };
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
    SCENES[room].objects.push({ area: [340, 240, 460, 360] });
    sel = SCENES[room].objects.length - 1;
    markDirty(); refresh();
  } }, listPanel);
}

function renderRoomTabs() {
  const wrap = document.getElementById('roomtabs');
  wrap.innerHTML = '';
  Object.keys(SCENES).forEach(name => {
    el('div', { class: 'roomtab' + (name === room ? ' active' : ''), text: name,
      onclick: () => { room = name; sel = -1; refresh(); } }, wrap);
  });
  const add = el('div', { class: 'roomtab add', text: '+ room' }, wrap);
  add.onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'newname';
    inp.placeholder = 'room id, e.g. kitchen';
    add.parentNode.replaceChild(inp, add);
    inp.focus();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      if (NAME_RE.test(v) && !SCENES[v]) {
        SCENES[v] = { objects: [] };
        ensureRoomDefaults(v);
        room = v; sel = -1; markDirty();
      }
      refresh();
    };
    inp.onkeydown = e => {
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') { done = true; refresh(); }
    };
    inp.onblur = commit;
  };
}

/* ---------- story tab ---------- */

function xrefTable(panel, headers) {
  const table = el('table', { class: 'xref' }, panel);
  const tr = el('tr', {}, table);
  headers.forEach(h => el('th', { text: h }, tr));
  return table;
}

function renderStory() {
  const R = buildRefs();

  const ip = el('div', { class: 'panel' }, right);
  el('h2', { text: 'Items — where each one is found and used' }, ip);
  const itemNames = Object.keys(R.items).sort();
  if (!itemNames.length) el('div', { class: 'muted', text: 'No items yet — add a Pickup hotspot in a room.' }, ip);
  else {
    const t = xrefTable(ip, ['item', 'how you get it', 'where it’s used']);
    itemNames.forEach(id => {
      const x = R.items[id];
      const tr = el('tr', {}, t);
      const nameTd = el('td', { class: 'name' }, tr);
      el('div', { text: id }, nameTd);
      artChips(nameTd, [conv.icon(id)]);
      const getTd = el('td', {}, tr);
      refChips(getTd, x.found.concat(x.made, x.given), 'nowhere — unobtainable!');
      const useTd = el('td', {}, tr);
      refChips(useTd, x.needed.concat(x.reactions, x.parts), 'never used');
    });
  }

  const fp = el('div', { class: 'panel' }, right);
  el('h2', { text: 'Flags — the puzzle dependency chart' }, fp);
  const flagNames = Object.keys(R.flags).sort();
  if (!flagNames.length) el('div', { class: 'muted', text: 'No flags yet — set one from any hotspot’s story section.' }, fp);
  else {
    const t = xrefTable(fp, ['flag', 'set by', 'needed by']);
    flagNames.forEach(f => {
      const x = R.flags[f];
      const tr = el('tr', {}, t);
      el('td', { class: 'name', text: f }, tr);
      const setTd = el('td', {}, tr);
      refChips(setTd, x.set, 'nothing sets it!');
      if (x.cleared.length) {
        word(setTd, 'cleared by:');
        refChips(setTd, x.cleared);
      }
      const chkTd = el('td', {}, tr);
      refChips(chkTd, x.checked, 'nothing checks it');
    });
  }

  const cp = el('div', { class: 'panel' }, right);
  el('h2', { text: 'Combining items' }, cp);
  COMBINE.forEach((c, i) => {
    c.parts = c.parts || ['', ''];
    const d = sec(cp, 'story');
    const b = line(d);
    b.appendChild(namePicker(collectItems(), c.parts[0], v => { c.parts[0] = v; },
      { blank: false, placeholder: 'new item id' }));
    word(b, '+');
    b.appendChild(namePicker(collectItems(), c.parts[1], v => { c.parts[1] = v; },
      { blank: false, placeholder: 'new item id' }));
    word(b, '=');
    b.appendChild(namePicker(collectItems(), c.makes, v => { c.makes = v; },
      { blank: false, placeholder: 'new item id' }));
    el('button', { class: 'mini danger', text: 'x',
      onclick: () => { COMBINE.splice(i, 1); markDirty(); refresh(); } }, b);
    if (c.makes) artChips(d, [conv.icon(c.makes)]);
  });
  el('button', { class: 'mini big', text: '+ Add recipe', onclick: () => {
    COMBINE.push({ parts: ['', ''], makes: '' }); markDirty(); refresh();
  } }, cp);

  const rp = el('div', { class: 'panel' }, right);
  el('h2', { text: 'Room map' }, rp);
  const t = xrefTable(rp, ['room', 'leads to', 'entered from']);
  Object.keys(SCENES).forEach(rn => {
    const conn = roomConnections(rn);
    const tr = el('tr', {}, t);
    const nameTd = el('td', { class: 'name' }, tr);
    el('span', { class: 'ref', text: rn + (rn === START_ROOM ? ' ★' : ''),
      onclick: () => gotoRef({ kind: 'room', room: rn }) }, nameTd);
    const toTd = el('td', {}, tr);
    refChips(toTd, conn.to, 'dead end');
    const fromTd = el('td', {}, tr);
    refChips(fromTd, conn.from, rn === START_ROOM ? 'start room' : 'unreachable!');
  });
}

/* ---------- cutscenes tab ---------- */

function renderCutscenes() {
  const panel = el('div', { class: 'panel' }, right);
  el('h2', { text: 'Cutscenes' }, panel);
  const names = Object.keys(CUTSCENES);
  if (!names.length) curCut = null;
  else if (names.indexOf(curCut) === -1) curCut = names[0];

  const row = el('div', { class: 'row' }, panel);
  row.appendChild(namePicker(names, curCut, v => {
    if (CUTSCENES[v]) { curCut = v; return; }
    CUTSCENES[v] = { steps: [{}] };
    curCut = v;
    markDirty();
  }, { blank: false, nav: true, placeholder: 'new cutscene id' }));

  if (!curCut) {
    el('div', { class: 'muted', text: 'No cutscenes yet — pick "+ new…" above.' }, panel);
    return;
  }
  const cs = CUTSCENES[curCut];

  const trig = line(panel);
  word(trig, 'triggered by:');
  refChips(trig, buildRefs().cutUses[curCut], 'nothing — wire it to a hotspot’s "afterwards"');

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

  el('h2', { text: 'Steps' }, panel);
  const table = el('table', { class: 'steps' }, panel);
  const head = el('tr', {}, table);
  ['backdrop', 'char clip', 'ms', 'sound', ''].forEach(h => {
    el('td', { html: '<b>' + h + '</b>' }, head);
  });
  (cs.steps || []).forEach((st, i) => {
    const tr = el('tr', {}, table);
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
    if (!confirm('Delete cutscene "' + curCut + '"?')) return;
    delete CUTSCENES[curCut];
    curCut = Object.keys(CUTSCENES)[0] || null;
    markDirty(); refresh();
  } }, btns);
}

/* ---------- game tab ---------- */

function renderGame() {
  const panel = el('div', { class: 'panel' }, right);
  el('h2', { text: 'Game' }, panel);

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
  el('div', { class: 'muted', text: 'Recipes live in the Story tab.' }, d);
}

/* ---------- issues tab ---------- */

function renderIssues() {
  const issues = computeIssues();
  const missing = missingFiles();

  const sp = el('div', { class: 'panel' }, right);
  el('h2', { text: 'Story problems' }, sp);
  if (!issues.length) el('div', { class: 'allgood', text: 'No story problems.' }, sp);
  issues.forEach(iss => {
    const d = el('div', { class: 'issue' }, sp);
    el('span', { class: 'kind ' + iss.level, text: iss.level }, d);
    el('span', { text: iss.text }, d);
    refChips(d, iss.refs);
  });

  const ap = el('div', { class: 'panel' }, right);
  el('h2', { text: 'Missing files — the art & sound request list' }, ap);
  if (!missing.length) el('div', { class: 'allgood', text: 'Every referenced file exists.' }, ap);
  missing.forEach(m => {
    const d = el('div', { class: 'issue' }, ap);
    el('span', { class: 'art missing', text: m.file }, d);
    refChips(d, m.refs);
  });
  if (missing.length) {
    el('div', { class: 'muted', text:
      'Author these as GIFs in art/ and run: python3 tools/make_sheets.py' }, ap);
  }
}

/* ---------- shell ---------- */

function renderRight() {
  right.innerHTML = '';
  if (tab === 'rooms') renderRoomsRight();
  else if (tab === 'story') renderStory();
  else if (tab === 'cutscenes') renderCutscenes();
  else if (tab === 'game') renderGame();
  else renderIssues();
}

function renderAll() {
  document.getElementById('left').style.display = tab === 'rooms' ? '' : 'none';
  right.className = tab === 'rooms' ? '' : 'wide';
  if (tab === 'rooms') {
    fitStage(); renderRoomTabs(); drawStage(); renderOverlay();
  }
  renderRight();
  updateBadge();
}

const tabEls = document.querySelectorAll('.tab');
function setTab(name) {
  tab = name;
  tabEls.forEach(x => {
    x.className = 'tab' + (x.getAttribute('data-tab') === name ? ' active' : '');
  });
  renderAll();
}
tabEls.forEach(t => { t.onclick = () => setTab(t.getAttribute('data-tab')); });

document.getElementById('reloadbtn').onclick = () => {
  if (!dirty || confirm('Discard unsaved changes?')) { dirty = false; location.reload(); }
};

document.getElementById('savebtn').onclick = () => {
  statusEl.textContent = 'saving…'; statusEl.style.color = '#8cf';
  fetch('/api/scenes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startRoom: START_ROOM || null,
      startCutscene: START_CUT || null,
      cutscenes: CUTSCENES,
      combine: COMBINE,
      combineHint: COMBINE_HINT || null,
      scenes: SCENES
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

renderAll(); // render immediately; dropdowns fill in when assets arrive

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
})();
