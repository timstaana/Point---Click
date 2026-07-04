/* Point & Click — single-canvas cel engine with tap-to-select item use.
 * ES5 safe. Targets: Safari 8+ (iPad mini 1, iOS 8), TenFourFox / PowerFox.
 *
 * Rendering model — everything painted onto ONE <canvas> (iOS 8 flashes
 * when transparent animated GIFs are layered in the DOM, so we never do
 * that). Channels composited in order each tick:
 *   bg -> item cels -> object overlay -> character
 * Authoring stays animated GIFs; a build step (make_sheets.py) flattens
 * each stage GIF into a PNG frame-strip + images/sheets.js manifest
 * (frames / per-frame ms / loop). The engine owns the animation clock,
 * so clips restart deterministically (no ?t= cache-buster reloads).
 * Small UI art (hotbar icons, cursors, hint button) stays as GIF <img>s.
 *
 * DOM: #stage-canvas, #hotspot-layer (transparent clickable SVGs),
 * #hotbar, #hint-button, #cursor-layer.
 *
 * Interaction model:
 *   - Tap a hotspot to play its char clip, then dispatch (go / pick).
 *   - Tap an inventory item to select it, then tap a matching hotspot.
 *
 * The stage is a fixed 800x600 design surface. The hotbar overlaps the
 * bottom of the stage rather than increasing the game area. JS applies a
 * scale on load / resize to fit the viewport (aspect ratio preserved).
 */

(function () {
  'use strict';

  var scenes = window.SCENES;
  var items = window.ITEMS || {};
  var current = 'bedroom';
  var busy = false;
  var inv = [];
  var spent = {};
  var selectedItem = null;

  var gameEl, stageEl, canvasEl, ctx, hotspotLayer, hotbarEl;
  var currentScale = 1;
  var currentTx = 0;
  var currentTy = 0;
  var lastTouchTime = 0;
  var storyFlags = {};
  var objectStates = {};
  var hintMode = false;
  var hintBtnEl = null;
  var soundCache = {};
  var currentSounds = {};

  var HOTBAR_SLOTS = 6;
  var DEFAULT_FAIL_ANIM = 'char_generic_cant_use.gif';

  /* ---------- software cursor ----------
   * CSS url() cursors can't animate GIFs, so the native cursor is hidden
   * inside #game and a 40x40 <img> (same size as icons) follows the mouse.
   * It lives in game coordinates, so it scales with the art. While an
   * inventory item is selected, the cursor is that item's icon. Touch
   * devices never move it (and taps explicitly hide it).
   * Cursor name -> hotspot px (anything else centres): */
  var CURSORS = {
    'default': [2, 1],
    'point':   [19, 1],
    'left':    [1, 20],
    'right':   [39, 20],
    'wait':    [20, 20]
  };
  var cursorEl = null;
  var cursorName = null;
  var hoverCursor = null;
  var cursorX = 0;
  var cursorY = 0;

  function initCursor() {
    for (var n in CURSORS) {
      if (CURSORS.hasOwnProperty(n)) preload('cursor_' + n + '.png');
    }
    cursorEl = document.createElement('img');
    cursorEl.id = 'cursor-layer';
    cursorEl.style.display = 'none';
    gameEl.appendChild(cursorEl);
    var onMove = function (evt) {
      evt = evt || window.event;
      if (Date.now() - lastTouchTime < 1000) return; // synthesized after a tap
      // Game coordinates, unclamped: #game doesn't clip, so the cursor
      // follows into the letterbox area outside the 800x600 canvas too.
      cursorX = (evt.clientX - currentTx) / currentScale;
      cursorY = (evt.clientY - currentTy) / currentScale;
      cursorEl.style.display = 'block';
      positionCursor();
    };
    var onOut = function (evt) {
      evt = evt || window.event;
      // hide only when the mouse leaves the window entirely
      if (!(evt.relatedTarget || evt.toElement)) {
        cursorEl.style.display = 'none';
      }
    };
    var onTouch = function () {
      lastTouchTime = Date.now();
      cursorEl.style.display = 'none';
    };
    if (window.addEventListener) {
      window.addEventListener('mousemove', onMove, false);
      document.addEventListener('mouseout', onOut, false);
      window.addEventListener('touchstart', onTouch, false);
    } else if (document.attachEvent) {
      document.attachEvent('onmousemove', onMove);
      document.attachEvent('onmouseout', onOut);
    }
    updateCursor();
  }

  function positionCursor() {
    var hs = CURSORS[cursorName] || [20, 20];
    cursorEl.style.left = (cursorX - hs[0]) + 'px';
    cursorEl.style.top  = (cursorY - hs[1]) + 'px';
  }

  function iconFor(itemId) {
    var meta = items[itemId] || {};
    return meta.icon || 'icon_' + itemId + '.png';
  }

  function updateCursor() {
    if (!cursorEl) return;
    var name = busy ? 'wait'
             : selectedItem ? 'item:' + selectedItem
             : (hoverCursor || 'default');
    if (name !== cursorName) {
      cursorName = name;
      cursorEl.src = 'images/' + (selectedItem && !busy
        ? iconFor(selectedItem)
        : 'cursor_' + name + '.png');
    }
    positionCursor();
  }

  // #game carries state classes for the cursor/busy/hint styling:
  //   .busy  — an animation is playing (wait cursor, dimmed hotbar)
  //   .using — an inventory item is selected (item icon cursor)
  //   .hints — hotspot outlines are shown (per room, reset on entry)
  function updateGameClasses() {
    if (!gameEl) return;
    var cls = [];
    if (busy) cls.push('busy');
    if (selectedItem) cls.push('using');
    if (hintMode) cls.push('hints');
    gameEl.className = cls.join(' ');
    if (hintBtnEl) {
      hintBtnEl.src = 'images/' + (hintMode ? 'ui_hint_on.png' : 'ui_hint.png');
    }
    updateCursor();
  }

  function setBusy(b) {
    busy = b;
    updateGameClasses();
  }
  var DEFAULT_SOUNDS = {
    select: 'select.wav',
    pickup: 'pickup.wav',
    door: 'door.wav',
    fail: 'fail.wav'
  };

  function init() {
    gameEl       = document.getElementById('game');
    stageEl      = document.getElementById('stage');
    canvasEl     = document.getElementById('stage-canvas');
    ctx          = canvasEl.getContext('2d');
    hotspotLayer = document.getElementById('hotspot-layer');
    hotbarEl     = document.getElementById('hotbar');
    installAudioUnlocker();
    window.setInterval(tick, TICK_MS);
    updateScale();
    initCursor();
    initHintButton();
    var combos = window.COMBINE || [];
    for (var ci = 0; ci < combos.length; ci++) {
      preload(iconFor(combos[ci].makes));
    }
    renderHotbar();
    enterScene(current, null, 0);
  }

  /* ---------- responsive scaling ---------- */

  // Game canvas is 800 x 600. The hotbar overlaps the bottom of the stage.
  var GAME_W = 800;
  var GAME_H = 600;

  function updateScale() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    currentScale = Math.min(vw / GAME_W, vh / GAME_H);
    var tx = (vw - GAME_W * currentScale) / 2;
    var ty = (vh - GAME_H * currentScale) / 2;
    currentTx = tx;
    currentTy = ty;
    // zoom scales through layout, which keeps image-rendering (crisp
    // pixels) working on desktop WebKit — but on iOS every animated GIF
    // frame then repaints the whole zoomed subtree in software, which
    // flashes constantly on the iPad. Touch devices get transform (GPU
    // composited, slight smoothing on a non-retina panel); desktop
    // WebKit gets zoom; Gecko gets transform + -moz-crisp-edges.
    var useZoom = typeof gameEl.style.zoom !== 'undefined' &&
                  !('ontouchstart' in window);
    if (useZoom) {
      // zoom multiplies the element's own lengths too, hence the division
      gameEl.style.zoom = currentScale;
      gameEl.style.left = (tx / currentScale) + 'px';
      gameEl.style.top  = (ty / currentScale) + 'px';
    } else {
      gameEl.style.left = tx + 'px';
      gameEl.style.top  = ty + 'px';
      gameEl.style.transform = 'scale(' + currentScale + ')';
      gameEl.style.webkitTransform = 'scale(' + currentScale + ')';
    }
  }

  function addTap(el, fn) {
    el.onclick = function (evt) {
      if (evt && evt.preventDefault) evt.preventDefault();
      if (Date.now() - lastTouchTime < 500) return false;
      unlockAudio();
      fn(evt);
      return false;
    };
    el.ontouchstart = function (evt) {
      if (evt && evt.preventDefault) evt.preventDefault();
      lastTouchTime = Date.now();
      unlockAudio();
      fn(evt);
      return false;
    };
  }

  var soundContainer = null;
  var audioUnlocked = false;

  function initSoundContainer() {
    if (!soundContainer) {
      soundContainer = document.createElement('div');
      soundContainer.style.display = 'none';
      document.body.appendChild(soundContainer);
    }
  }

  function loadSceneSounds(scene) {
    var defaults = window.SOUNDS || DEFAULT_SOUNDS;
    currentSounds = {
      select: (scene.sounds && scene.sounds.select) || defaults.select,
      pickup: (scene.sounds && scene.sounds.pickup) || defaults.pickup,
      door:   (scene.sounds && scene.sounds.door)   || defaults.door,
      fail:   (scene.sounds && scene.sounds.fail)   || defaults.fail
    };
  }

  function getSoundFile(name, h) {
    if (h) {
      if (name === 'fail') return h.failSound || currentSounds.fail;
      var key = name + 'Sound';
      if (h[key]) return h[key];
      if (h.sound) return h.sound;
    }
    return currentSounds[name];
  }

  function createAudioElement(fileName) {
    if (!fileName) return null;
    var audio = document.createElement('audio');
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.preload = 'auto';
    audio.src = 'sounds/' + fileName;
    if (soundContainer) {
      soundContainer.appendChild(audio);
    }
    return audio;
  }

  function loadSound(fileName) {
    if (!fileName) return null;
    if (soundCache[fileName]) return soundCache[fileName];
    var audio = createAudioElement(fileName);
    soundCache[fileName] = audio;
    return audio;
  }

  function playSceneSound(name, h) {
    playSound(loadSound(getSoundFile(name, h)));
  }

  function playSound(sound) {
    if (!sound || !sound.play) return;
    try {
      sound.pause();
      sound.currentTime = 0;
      sound.play();
    } catch (e) {
      try { sound.play(); } catch (ignore) {}
    }
  }

  function collectSoundFiles() {
    var seen = {};
    var list = [];
    function add(f) {
      if (f && typeof f === 'string' && !seen[f]) { seen[f] = true; list.push(f); }
    }
    var d = window.SOUNDS || DEFAULT_SOUNDS;
    for (var k in d) { if (d.hasOwnProperty(k)) add(d[k]); }
    add(window.COMBINE_HINT);
    var combos = window.COMBINE || [];
    for (var i = 0; i < combos.length; i++) add(combos[i].sound);
    var str = '';
    try { str = JSON.stringify(window.SCENES); } catch (e) {}
    var found = str.match(/[\w\-]+\.wav/g) || [];
    for (i = 0; i < found.length; i++) add(found[i]);
    return list;
  }

  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    initSoundContainer();
    var files = collectSoundFiles();
    for (var i = 0; i < files.length; i++) {
      var a = loadSound(files[i]);
      if (!a || !a.play) continue;
      try {
        a.pause();
        a.currentTime = 0;
        a.play();
        a.pause();
        a.currentTime = 0;
      } catch (e) {}
    }
  }

  function preventTouchScroll(evt) {
    if (!evt) return;
    if (evt.preventDefault) evt.preventDefault();
    return false;
  }

  function installAudioUnlocker() {
    function unlockOnce(evt) {
      unlockAudio();
      document.removeEventListener('touchstart', unlockOnce, false);
      document.removeEventListener('touchend', unlockOnce, false);
      document.removeEventListener('mousedown', unlockOnce, false);
      document.removeEventListener('click', unlockOnce, false);
    }
    document.addEventListener('touchstart', unlockOnce, false);
    document.addEventListener('touchend', unlockOnce, false);
    document.addEventListener('mousedown', unlockOnce, false);
    document.addEventListener('click', unlockOnce, false);
    document.addEventListener('touchmove', preventTouchScroll, false);
  }

  /* ---------- canvas channels & animation clock ---------- */

  var TICK_MS = 100;
  var channels = { bg: null, items: [], obj: null, char: null };
  var sheetCache = {};
  var lastPaintKey = '';
  var needPaint = true;

  function requestPaint() { needPaint = true; }

  function getSheet(name) {
    if (sheetCache[name]) return sheetCache[name];
    var meta = (window.SHEETS && window.SHEETS[name]) || null;
    var img = new Image();
    img.onload = requestPaint;
    img.src = 'images/' + (meta ? meta.file : name);
    sheetCache[name] = {
      img: img,
      frames: meta ? meta.frames : 1,
      dur: meta ? meta.dur : 1000,
      loop: meta ? !!meta.loop : true
    };
    return sheetCache[name];
  }

  function makeClip(name) {
    return { sheet: getSheet(name), start: Date.now() };
  }

  function clipFrame(clip, now) {
    var s = clip.sheet;
    if (s.frames <= 1) return 0;
    var f = Math.floor((now - clip.start) / s.dur);
    if (s.loop) return f % s.frames;
    return f < s.frames - 1 ? f : s.frames - 1; // play once, hold last
  }

  function drawClip(clip, now) {
    var s = clip.sheet;
    if (!s.img.complete || !s.img.width) return;
    ctx.drawImage(s.img, clipFrame(clip, now) * GAME_W, 0, GAME_W, GAME_H,
                  0, 0, GAME_W, GAME_H);
  }

  // One string describing what this tick would paint; repaint only when
  // it changes, so idle costs nothing between GIF-frame boundaries.
  function paintKey(now) {
    var parts = [];
    function add(c) {
      parts.push(c ? c.sheet.img.src + ':' + clipFrame(c, now) +
                     ':' + (c.sheet.img.complete ? 1 : 0) : '-');
    }
    add(channels.bg);
    for (var i = 0; i < channels.items.length; i++) add(channels.items[i]);
    add(channels.obj);
    add(channels.char);
    return parts.join('|');
  }

  function tick() {
    var now = Date.now();
    var key = paintKey(now);
    if (!needPaint && key === lastPaintKey) return;
    // hold the previous pixels until the background can be drawn — the
    // canvas never shows a bare flash mid-swap
    if (!channels.bg || !channels.bg.sheet.img.complete) return;
    needPaint = false;
    lastPaintKey = key;
    drawClip(channels.bg, now);
    for (var i = 0; i < channels.items.length; i++) drawClip(channels.items[i], now);
    if (channels.obj) drawClip(channels.obj, now);
    if (channels.char) drawClip(channels.char, now);
  }

  function swapBg(fileName)     { channels.bg = makeClip(fileName); requestPaint(); }
  function swapChar(fileName)   { channels.char = makeClip(fileName); requestPaint(); }
  function swapObject(fileName) { channels.obj = makeClip(fileName); requestPaint(); }
  function clearObject()        { channels.obj = null; requestPaint(); }

  /* ---------- scene lifecycle ---------- */

  function initHintButton() {
    var btn = document.getElementById('hint-button');
    if (!btn) return;
    hintBtnEl = btn;
    preload('ui_hint_on.png');
    addTap(btn, function () {
      hintMode = !hintMode;
      playSceneSound('select');
      updateGameClasses();
    });
    btn.onmouseover = function () { hoverCursor = 'point'; updateCursor(); };
    btn.onmouseout  = function () { hoverCursor = null; updateCursor(); };
  }

  function enterScene(name, entryAnim, entryDur) {
    current = name;
    hintMode = false; // hints are per room
    updateGameClasses();
    var scene = scenes[name];
    swapBg(scene.bg);
    loadSceneSounds(scene);
    clearObject();
    clearItems();
    clearHotspots();
    if (entryAnim) {
      swapChar(entryAnim);
      renderSceneObjects(scene); // props must be visible during the walk-in
      setBusy(true);
      window.setTimeout(function () {
        setBusy(false);
        showIdle();
      }, entryDur);
    } else {
      showIdle();
    }
  }

  function showIdle() {
    var scene = scenes[current];
    // all channel changes land in the same tick, so the swap is atomic —
    // no load races, no flash between overlay end and new state sprite
    clearObject();
    swapChar(scene.idle);
    renderSceneObjects(scene);
  }

  /* ---------- scene items ---------- */

  function renderItems(list) {
    clearItems();
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!itemMatches(it) || hasItem(it.id) || spent[it.id]) continue;
      channels.items.push(makeClip(it.src));
    }
    requestPaint();
  }

  /* ---------- story-flag conditions ----------
   * `when` is one condition or an array of conditions that must ALL hold
   * (the AND of a puzzle dependency chart). For OR, list the object more
   * than once with different `when`s — every matching object renders. */
  function condMatches(c) {
    if (!c || !c.flag) return true;
    var flagValue = storyFlags[c.flag];
    if (c.value === undefined) return !!flagValue;
    if (c.value === false) return !flagValue;
    return flagValue === c.value;
  }

  function eachFlag(v, fn) {
    if (!v) return;
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) fn(v[i]);
    } else {
      fn(v);
    }
  }

  function whenMatches(when) {
    if (!when) return true;
    if (Array.isArray(when)) {
      for (var i = 0; i < when.length; i++) {
        if (!condMatches(when[i])) return false;
      }
      return true;
    }
    return condMatches(when);
  }

  function itemMatches(it) {
    return whenMatches(it.when);
  }

  function clearItems() {
    channels.items = [];
    requestPaint();
  }

  function renderSceneObjects(scene) {
    if (scene.objects) {
      renderObjects(scene.objects);
    } else {
      renderItems(scene.items);
      renderHotspots(scene.hotspots);
    }
  }

  // Pickups: shorthand for "an item lying in the room". Art is two files
  // named after the item id:
  //   item_<id>.gif (full-frame cel) / icon_<id>.gif (40x40 hotbar icon)
  function expandItem(obj) {
    if (!obj.item) return obj;
    preload(iconFor(obj.item));
    return {
      id: obj.item,
      src: 'item_' + current + '_' + obj.item + '.gif',
      area: obj.area, when: obj.when,
      anim: obj.anim, objAnim: obj.objAnim, dur: obj.dur,
      sound: obj.sound,
      failAnim: obj.failAnim, failDur: obj.failDur, failThen: obj.failThen,
      then: 'pick:' + obj.item,
      cursor: obj.cursor,
      hint: obj.hint, hintDur: obj.hintDur, items: obj.items,
      setFlag: obj.setFlag, setFlagValue: obj.setFlagValue, clearFlag: obj.clearFlag
    };
  }

  // Gates: shorthand for "blocked until the right item is used" (locked
  // door, NPC who wants something, ...). Expands to a two-state object;
  // art is three full-frame cels named after the gate id:
  //   gate_<id>_closed.gif / gate_<id>_use.gif / gate_<id>_open.gif
  var preloaded = {};
  function preload(fileName) {
    if (!fileName || preloaded[fileName]) return;
    preloaded[fileName] = true;
    if (window.SHEETS && window.SHEETS[fileName]) {
      getSheet(fileName); // stage art: warm the PNG strip
      return;
    }
    var im = new Image();
    im.src = 'images/' + fileName; // UI art: plain GIF
  }

  // Authoring sugar: `hint`/`hintDur` are the friendly names for a
  // rejection voice line; the fail path reads failSound/failDur.
  function normalizeAction(o) {
    if (o) {
      if (o.hint && !o.failSound) o.failSound = o.hint;
      if (o.hintDur && !o.failDur) o.failDur = o.hintDur;
    }
    return o;
  }

  function expandGate(obj) {
    if (!obj.gate) return obj;
    var stem = 'gate_' + obj.gate;
    preload(stem + '_use.gif');
    preload(stem + '_open.gif');
    var locked = obj.locked || {};
    var open = obj.open || {};
    var openState = { src: stem + '_open.gif' };
    var k;
    for (k in open) {
      if (open.hasOwnProperty(k)) openState[k] = open[k];
    }
    return {
      id: obj.gate,
      area: obj.area,
      when: obj.when,
      state: 'closed',
      states: {
        closed: {
          src: stem + '_closed.gif',
          needs: locked.needs,
          objAnim: stem + '_use.gif',
          dur: locked.dur || 2000,
          sound: locked.sound,
          hint: locked.hint, hintDur: locked.hintDur,
          failAnim: locked.failAnim, failDur: locked.failDur, failThen: locked.failThen,
          items: locked.items, cursor: locked.cursor,
          keepItem: locked.keepItem,
          setFlag: locked.setFlag, setFlagValue: locked.setFlagValue,
          clearFlag: locked.clearFlag,
          setState: 'open'
        },
        open: openState
      }
    };
  }

  // Stateful objects: `states` maps a state name to a set of props that
  // override the base object. The live state comes from objectStates[id]
  // (falling back to the declared initial `state`). Flat objects pass
  // through untouched.
  function resolveObject(obj) {
    if (!obj.states) return obj;
    var name = objectStates[obj.id] || obj.state;
    var st = obj.states[name] || {};
    var out = {};
    var k;
    for (k in obj) {
      if (obj.hasOwnProperty(k) && k !== 'states' && k !== 'state') out[k] = obj[k];
    }
    for (k in st) {
      if (st.hasOwnProperty(k)) out[k] = st[k];
    }
    return out;
  }

  function renderObjects(list) {
    clearItems();
    clearHotspots();
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      var obj = normalizeAction(resolveObject(expandGate(expandItem(list[i]))));
      if (!objectMatches(obj) || isObjectSpent(obj)) continue;
      if (obj.src) {
        channels.items.push(makeClip(obj.src));
      }
      if (obj.area) {
        hotspotLayer.appendChild(makeHotspotEl(obj));
      }
    }
    requestPaint();
  }

  function objectMatches(obj) {
    return whenMatches(obj.when);
  }

  function isObjectSpent(obj) {
    if (obj.id && (hasItem(obj.id) || spent[obj.id])) return true;
    if (obj.then && obj.then.indexOf('pick:') === 0) {
      var id = obj.then.substring(5);
      if (hasItem(id) || spent[id]) return true;
    }
    return false;
  }

  /* ---------- hotspots ---------- */

  function renderHotspots(hotspots) {
    clearHotspots();
    for (var i = 0; i < hotspots.length; i++) {
      var h = hotspots[i];
      if (!hotspotMatches(h) || isHotspotSpent(h)) continue;
      hotspotLayer.appendChild(makeHotspotEl(h));
    }
  }

  function hotspotMatches(h) {
    return whenMatches(h.when);
  }

  // A pick-hotspot is spent once its item is in inventory (or was consumed).
  function isHotspotSpent(h) {
    if (h.then && h.then.indexOf('pick:') === 0) {
      var id = h.then.substring(5);
      if (hasItem(id)) return true;
      if (spent[id]) return true;
    }
    return false;
  }

  function clearHotspots() {
    while (hotspotLayer.firstChild) hotspotLayer.removeChild(hotspotLayer.firstChild);
    hoverCursor = null; // mouseout never fires for removed elements
    updateCursor();
  }

  function makePolygonHotspot(h) {
    var points = h.area || [];
    if (points.length === 4) {
      points = [points[0], points[1], points[2], points[1], points[2], points[3], points[0], points[3]];
    }
    if (!points || points.length < 6) {
      return document.createElement('a');
    }

    var minX = points[0];
    var minY = points[1];
    var maxX = points[0];
    var maxY = points[1];

    for (var i = 2; i < points.length; i += 2) {
      var x = points[i];
      var y = points[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'hotspot hotspot-svg');
    svg.setAttribute('viewBox', '0 0 ' + (maxX - minX) + ' ' + (maxY - minY));
    svg.setAttribute('width', maxX - minX);
    svg.setAttribute('height', maxY - minY);
    svg.style.position = 'absolute';
    svg.style.left = minX + 'px';
    svg.style.top = minY + 'px';

    var relPoints = [];
    for (var j = 0; j < points.length; j += 2) {
      relPoints.push(points[j] - minX);
      relPoints.push(points[j + 1] - minY);
    }

    var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', relPoints.join(' '));
    poly.setAttribute('fill', 'transparent');
    poly.style.pointerEvents = 'all';
    addTap(poly, function () { handleClick(h); });
    poly.onmouseover = function () { hoverCursor = h.cursor || 'point'; updateCursor(); };
    poly.onmouseout  = function () { hoverCursor = null; updateCursor(); };
    svg.appendChild(poly);
    return svg;
  }

  function makeHotspotEl(h) {
    return makePolygonHotspot(h);
  }

  function getHotspotObjAnim(h) {
    return h.objAnim;
  }

  /* ---------- click and dispatch ---------- */

  // Per-item interaction: the items-entry's props override the object's.
  function mergeEntry(h, entry) {
    var out = {};
    var k;
    for (k in h) {
      if (h.hasOwnProperty(k) && k !== 'items') out[k] = h[k];
    }
    for (k in entry) {
      if (entry.hasOwnProperty(k)) out[k] = entry[k];
    }
    return out;
  }

  function handleClick(h) {
    if (busy) return;
    if (selectedItem) {
      var entry = h.items && h.items[selectedItem];
      if (entry) {
        if (typeof entry === 'string') entry = { hint: entry };
        normalizeAction(entry);
        var act = mergeEntry(h, entry);
        if (entry.hint) {
          triggerWrongItem(act, selectedItem);
          return;
        }
        if (entry.consume) act.needs = selectedItem;
        selectedItem = null;
        renderHotbar();
        triggerHotspot(act);
        return;
      }
      if (h.needs) {
        if (selectedItem === h.needs) {
          selectedItem = null;
          renderHotbar();
          triggerHotspot(h);
        } else {
          triggerWrongItem(h, selectedItem);
        }
        return;
      }
      triggerWrongItem(h, selectedItem);
      return;
    }
    if (h.needs) {
      triggerWrongItem(h, null);
      return;
    }
    triggerHotspot(h);
  }

  function triggerHotspot(h) {
    setBusy(true);
    clearHotspots();
    if (!h.then && h.sound) {
      playSceneSound('select', h);
    }
    var objAnim = getHotspotObjAnim(h);
    if (objAnim) swapObject(objAnim);
    if (h.anim) swapChar(h.anim);
    window.setTimeout(function () {
      setBusy(false);
      dispatch(h);
    }, h.dur);
  }

  function triggerWrongItem(h, itemId) {
    selectedItem = null;
    renderHotbar();
    playSceneSound('fail', h);
    var scene = scenes[current] || {};
    var failAnim = h.failAnim || scene.failAnim || DEFAULT_FAIL_ANIM;
    var failDur  = h.failDur  || scene.failDur  || 900;
    var failThen = h.failThen || scene.failThen;
    setBusy(true);
    clearHotspots();
    swapChar(failAnim);
    window.setTimeout(function () {
      setBusy(false);
      if (failThen) {
        dispatch({ then: failThen });
      } else {
        showIdle();
      }
    }, failDur);
  }

  function dispatch(h) {
    var action = h.then || '';

    if (h.needs && !h.keepItem) consume(h.needs);

    if (h.setState && h.id) {
      objectStates[h.id] = h.setState;
    }
    // setFlag / clearFlag accept one name or an array of names, so one
    // action can satisfy several puzzle dependencies at once.
    if (h.setFlagValue !== undefined && h.setFlag && !Array.isArray(h.setFlag)) {
      storyFlags[h.setFlag] = h.setFlagValue;
    } else {
      eachFlag(h.setFlag, function (f) { storyFlags[f] = true; });
    }
    eachFlag(h.clearFlag, function (f) { delete storyFlags[f]; });

    if (action.indexOf('go:') === 0) {
      playSceneSound('door', h);
      enterScene(action.substring(3), h.entryAnim, h.entryDur || 1200);
      return;
    }

    if (action.indexOf('pick:') === 0) {
      var item = action.substring(5);
      if (!hasItem(item)) {
        inv.push(item);
        renderHotbar();
        playSceneSound('pickup', h);
      }
      spent[item] = true;
      showIdle();
      return;
    }

    showIdle();
  }

  /* ---------- inventory / hotbar ---------- */

  function hasItem(item) {
    for (var i = 0; i < inv.length; i++) {
      if (inv[i] === item) return true;
    }
    return false;
  }

  function consume(item) {
    for (var i = 0; i < inv.length; i++) {
      if (inv[i] === item) { inv.splice(i, 1); break; }
    }
    renderHotbar();
  }

  // 6 slots, evenly spaced across the 800px stage:
  //   slot width 90px, padding 40px each side, gap (720 - 6*90)/5 = 36px
  //   => left(i) = 40 + i * (90 + 36) = 40 + i * 126
  function renderHotbar() {
    updateGameClasses();
    while (hotbarEl.firstChild) hotbarEl.removeChild(hotbarEl.firstChild);
    for (var i = 0; i < HOTBAR_SLOTS; i++) {
      var slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      slot.style.left = (40 + i * 126) + 'px';
      if (i < inv.length) {
        var id = inv[i];
        var meta = items[id] || {};
        var img = document.createElement('img');
        img.src = 'images/' + iconFor(id);
        img.className = 'hotbar-icon';
        addTap(img, makeHotbarTapHandler(id));
        img.onmouseover = function () { hoverCursor = 'point'; updateCursor(); };
        img.onmouseout  = function () { hoverCursor = null; updateCursor(); };
        if (id === selectedItem) {
          slot.className += ' selected';
        }
        slot.appendChild(img);
      }
      hotbarEl.appendChild(slot);
    }
  }

  /* ---------- combining items ----------
   * window.COMBINE recipes: { parts: [a, b], makes: c, sound?, setFlag? }.
   * Select one part, tap the other in the hotbar. Both are consumed and
   * the result lands in the hotbar. No recipe -> just switch selection. */
  function findCombo(a, b) {
    var list = window.COMBINE || [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i].parts;
      if (p && p.length === 2 &&
          ((p[0] === a && p[1] === b) || (p[0] === b && p[1] === a))) {
        return list[i];
      }
    }
    return null;
  }

  function combineItems(combo) {
    var keeps = combo.keeps || [];
    for (var i = 0; i < 2; i++) {
      var part = combo.parts[i];
      var kept = false;
      for (var j = 0; j < keeps.length; j++) {
        if (keeps[j] === part) kept = true;
      }
      if (!kept) consume(part);
    }
    if (!hasItem(combo.makes)) inv.push(combo.makes);
    spent[combo.makes] = true; // never re-pickable from a room
    eachFlag(combo.setFlag, function (f) { storyFlags[f] = true; });
    selectedItem = null;
    playSound(loadSound(combo.sound || getSoundFile('pickup')));
    renderHotbar();
  }

  function makeHotbarTapHandler(itemId) {
    return function () {
      if (busy) return;
      if (selectedItem && selectedItem !== itemId) {
        var combo = findCombo(selectedItem, itemId);
        if (combo) {
          combineItems(combo);
          return;
        }
        // No recipe: with a COMBINE_HINT line, treat it as a failed
        // combine; without one, just switch the selection.
        if (window.COMBINE_HINT) {
          selectedItem = null;
          playSound(loadSound(window.COMBINE_HINT));
          renderHotbar();
          return;
        }
      }
      selectedItem = (selectedItem === itemId) ? null : itemId;
      playSceneSound('select');
      renderHotbar();
    };
  }

  /* ---------- boot ---------- */

  if (window.addEventListener) {
    window.addEventListener('load', init, false);
    window.addEventListener('resize', updateScale, false);
    window.addEventListener('orientationchange', updateScale, false);
  } else {
    window.attachEvent('onload', init);
    window.attachEvent('onresize', updateScale);
  }
})();
