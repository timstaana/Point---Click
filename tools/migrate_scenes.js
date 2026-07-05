#!/usr/bin/env node
/* One-time migrator: old scenes.js (SCENES/CUTSCENES/COMBINE + flags,
 * gate/locked/open, then:) -> the step schema (window.GAME, after:,
 * flat locks, named consequences gives/plays/goes). Refuses loudly on
 * anything it can't map 1:1 (fix by hand, rerun). The old file is kept
 * as scenes.pre-steps.js.
 *
 * Usage: node tools/migrate_scenes.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'scenes.js');

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'scenes.js' });
const W = ctx.window;
if (W.GAME) {
  console.log('scenes.js already holds window.GAME — nothing to migrate.');
  process.exit(0);
}

const SCENES = W.SCENES || {};
const CUTSCENES = W.CUTSCENES || {};
const COMBINE = W.COMBINE || [];

const errors = [];
const notes = [];
const fail = m => errors.push(m);

const toList = v => (Array.isArray(v) ? v : v ? [v] : []);
const goTarget = t => (t && t.indexOf('go:') === 0 ? t.slice(3) : null);
const cutTarget = t => (t && t.indexOf('cut:') === 0 ? t.slice(4) : null);
const pickTarget = t => (t && t.indexOf('pick:') === 0 ? t.slice(5) : null);

/* ---------- pass 1: every flag's single "experienced" setter ----------
 * A flag maps to the step id the player completes to set it: the
 * hotspot's id — or, if that hotspot also plays a cutscene, the
 * cutscene's name (the flag is experienced when the cutscene ends). */
const flagSetter = {}; // flag -> step id
function recordSetter(f, id, where) {
  if (flagSetter[f] && flagSetter[f] !== id) {
    fail('flag "' + f + '" has multiple setters (' + flagSetter[f] + ', ' + id +
         ') — `after` is AND-only; hand-fix before migrating');
    return;
  }
  flagSetter[f] = id;
  notes.push('flag ' + f + ' -> after:["' + id + '"]  (set at ' + where + ')');
}

Object.keys(SCENES).forEach(rn => {
  (SCENES[rn].objects || []).forEach(o => {
    if (!o.id) fail('hotspot without id in ' + rn + ' — open+save the editor first');
    const holders = [o, o.locked, o.open];
    [o, o.locked, o.open].forEach(h => {
      if (h && h.items) Object.keys(h.items).forEach(k => {
        if (h.items[k] && typeof h.items[k] === 'object') holders.push(h.items[k]);
      });
    });
    holders.forEach(h => {
      if (!h) return;
      if (h.setFlagValue !== undefined) fail('setFlagValue on ' + o.id + ' — unsupported');
      if (h.clearFlag) fail('clearFlag on ' + o.id + ' — unsupported');
      if (h.failThen) fail('failThen on ' + o.id + ' — unsupported');
      const cn = cutTarget(h.then);
      toList(h.setFlag).forEach(f =>
        recordSetter(f, cn || o.id, rn + '/' + o.id + (cn ? ' via cutscene ' + cn : '')));
    });
  });
});
Object.keys(CUTSCENES).forEach(cn => {
  toList(CUTSCENES[cn].setFlag).forEach(f => recordSetter(f, cn, 'cutscene ' + cn));
});

function afterOf(when) {
  const after = [];
  const afterNot = [];
  toList(when).forEach(c => {
    if (!c || !c.flag) return;
    const s = flagSetter[c.flag];
    if (!s) {
      fail('flag "' + c.flag + '" is checked but never set — fix in the editor first');
      return;
    }
    (c.value === false ? afterNot : after).push(s);
  });
  return { after, afterNot };
}

/* ---------- pass 2: hotspots ---------- */

// then/entryAnim → the named consequence keys
function consequences(h, out) {
  const g = goTarget(h.then), c = cutTarget(h.then), p = pickTarget(h.then);
  if (g) {
    out.goes = g;
    if (h.entryAnim) out.entryAnim = h.entryAnim;
    if (h.entryDur) out.entryDur = h.entryDur;
  }
  if (c) out.plays = c;
  if (p) out.gives = p;
}

function migrateReactions(items, id) {
  const out = {};
  Object.keys(items).forEach(k => {
    const e = items[k];
    if (typeof e === 'string') { out[k] = e; return; }
    const r = {};
    ['hint', 'hintDur', 'anim', 'objAnim', 'sound', 'dur', 'consume'].forEach(key => {
      if (e[key] !== undefined) r[key] = e[key];
    });
    consequences(e, r);
    Object.keys(e).forEach(k2 => {
      if (['hint', 'hintDur', 'anim', 'objAnim', 'sound', 'dur', 'consume',
           'then', 'entryAnim', 'entryDur', 'setFlag'].indexOf(k2) === -1) {
        fail('unmapped key "' + k2 + '" in a reaction on ' + id);
      }
    });
    out[k] = r;
  });
  return out;
}

function migrateHotspot(o, rn) {
  const n = { id: o.id, area: o.area };
  const aa = afterOf(o.when);
  if (aa.after.length) n.after = aa.after;
  if (aa.afterNot.length) n.afterNot = aa.afterNot;
  if (o.cursor) n.cursor = o.cursor;

  const KNOWN = ['id', 'area', 'when', 'cursor', 'item', 'gate', 'locked', 'open',
                 'needs', 'items', 'anim', 'objAnim', 'sound', 'dur', 'then',
                 'entryAnim', 'entryDur', 'setFlag', 'hint', 'hintDur', 'keepItem',
                 'failAnim', 'failDur', 'src'];
  Object.keys(o).forEach(k => {
    if (KNOWN.indexOf(k) === -1) fail('unmapped key "' + k + '" on ' + rn + '/' + o.id);
  });

  if (o.item) n.gives = o.item;
  ['anim', 'objAnim', 'sound', 'dur', 'failAnim', 'failDur', 'src']
    .forEach(k => { if (o[k] !== undefined) n[k] = o[k]; });
  consequences(o, n);

  if (o.gate || o.locked || o.needs) {
    const L = o.locked || {};
    n.needs = L.needs || o.needs;
    if (o.gate) n.gateArt = o.gate;
    if (L.hint) n.hint = L.hint;
    if (L.hintDur) n.hintDur = L.hintDur;
    if (L.anim) n.useAnim = L.anim;
    if (L.sound) n.useSound = L.sound;
    if (L.dur) n.useDur = L.dur;
    if (L.keepItem) n.keepItem = L.keepItem;
    if (!n.cursor && L.cursor) n.cursor = L.cursor;
    const onUnlock = {};
    consequences(L, onUnlock);
    if (Object.keys(onUnlock).length) n.onUnlock = onUnlock;
    const O = o.open || {};
    ['anim', 'objAnim', 'sound', 'dur'].forEach(k => {
      if (O[k] !== undefined) n[k] = O[k];
    });
    if (O.cursor) n.cursor = O.cursor;
    consequences(O, n);
    if (O.items) fail('items on a gate OPEN state (' + o.id + ') — unsupported');
    const reactions = L.items || o.items;
    if (reactions) n.reactions = migrateReactions(reactions, o.id);
  } else {
    if (o.hint) { n.hint = o.hint; n.hintDur = o.hintDur; }
    if (o.keepItem) n.keepItem = o.keepItem;
    if (o.items) n.reactions = migrateReactions(o.items, o.id);
  }
  return n;
}

const GAME = {
  start: { room: W.START_ROOM || Object.keys(SCENES)[0] },
  rooms: {},
  cutscenes: {},
  combine: COMBINE.map(c => {
    const out = { parts: c.parts, makes: c.makes };
    if (c.keeps) out.keeps = c.keeps;
    if (c.sound) out.sound = c.sound;
    if (c.setFlag) fail('setFlag on a combine recipe — unsupported');
    return out;
  })
};
if (W.START_CUTSCENE) GAME.start.play = W.START_CUTSCENE;
if (W.COMBINE_HINT) GAME.combineHint = W.COMBINE_HINT;

Object.keys(SCENES).forEach(rn => {
  const s = SCENES[rn];
  const room = { bg: s.bg, idle: s.idle };
  if (s.failAnim) room.failAnim = s.failAnim;
  if (s.failDur) room.failDur = s.failDur;
  if (s.sounds) room.sounds = s.sounds;
  room.hotspots = (s.objects || []).map(o => migrateHotspot(o, rn));
  GAME.rooms[rn] = room;
});

Object.keys(CUTSCENES).forEach(cn => {
  const c = CUTSCENES[cn];
  const out = { steps: c.steps || [] };
  if (c.skip) out.skip = true;
  const g = goTarget(c.then);
  if (g) out.goes = g;
  else if (c.then) fail('cutscene ' + cn + ' has non-go then: ' + c.then);
  if (c.entryAnim) out.entryAnim = c.entryAnim;
  if (c.entryDur) out.entryDur = c.entryDur;
  GAME.cutscenes[cn] = out;
});

/* ---------- validate: every after ref resolves ---------- */
const stepIds = {};
Object.keys(GAME.rooms).forEach(rn =>
  GAME.rooms[rn].hotspots.forEach(h => { stepIds[h.id] = 1; }));
Object.keys(GAME.cutscenes).forEach(cn => { stepIds[cn] = 1; });
Object.keys(GAME.rooms).forEach(rn =>
  GAME.rooms[rn].hotspots.forEach(h => {
    toList(h.after).concat(toList(h.afterNot)).forEach(id => {
      if (!stepIds[id]) fail('after ref "' + id + '" on ' + h.id + ' resolves to nothing');
    });
  }));

if (errors.length) {
  console.error('MIGRATION REFUSED — nothing written:');
  errors.forEach(e => console.error('  ✗ ' + e));
  process.exit(1);
}

const HEADER = `/* Game data — the whole game is this one window.GAME object,
 * written by the editor at /editor.html (hand-editable in a pinch).
 * It is shaped like the editor's step map:
 *
 * GAME.start      { room, play? }  first room; optional boot cutscene.
 * GAME.rooms      room id -> { bg, idle, failAnim, sounds?, hotspots }
 * GAME.cutscenes  name -> { steps: [{bg?, anim?, dur?, sound?}...],
 *                           skip?, goes?, entryAnim?, entryDur? }
 * GAME.combine    [{ parts: [a,b], makes, keeps?, sound? }]
 * GAME.combineHint  voice line for a no-recipe pair.
 *
 * A HOTSPOT is one clickable step — one shape for everything:
 *   id, area [x1,y1,x2,y2]     identity + where (id is the STEP id)
 *   after / afterNot           exists only once these step ids are
 *                              done / not yet done (no flags — deps
 *                              are on steps; own id in afterNot means
 *                              "until I'm done")
 *   needs                      item that unlocks it; while locked:
 *     hint/hintDur             refusal line
 *     useAnim/useSound/useDur  the one-shot unlock clip
 *     gateArt                  cel trio gate_<id>_closed/_use/_open
 *     onUnlock { gives?, plays?, goes?, entryAnim? }  fires once
 *   gives / plays / goes       what a successful tap does, in that
 *                              order (item to hotbar / cutscene /
 *                              walk to room + entryAnim/entryDur).
 *                              gives alone = a pickup lying in the
 *                              room (cel item_<room>_<item>.png).
 *   anim/objAnim/sound/dur     presentation (dur optional — the
 *                              clip's real GIF length is used)
 *   reactions { item: 'vo.wav' | { hint... } | { anim?, sound?,
 *               gives?, plays?, goes?, consume? } }   per-item uses
 *
 * The engine marks done[id] when a step completes (unlock for locked
 * ones, finish for cutscenes) — that is all the story state there is.
 * Art/sound naming conventions are unchanged (see README). */
`;

function emit(obj) { return JSON.stringify(obj, null, 2); }
const out = HEADER + '\nwindow.GAME = ' + emit(GAME) + ';\n';

fs.writeFileSync(path.join(ROOT, 'scenes.pre-steps.js'), fs.readFileSync(SRC));
fs.writeFileSync(SRC, out);

console.log('Migrated. Old data kept as scenes.pre-steps.js');
notes.forEach(n => console.log('  · ' + n));
console.log('  rooms: ' + Object.keys(GAME.rooms).length +
            ', hotspots: ' + Object.keys(stepIds).length +
            ', cutscenes: ' + Object.keys(GAME.cutscenes).length +
            ', recipes: ' + GAME.combine.length);
