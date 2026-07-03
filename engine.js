/* Point & Click — layered-cel engine with tap-to-select item use.
 * ES5 safe. Targets: Safari 9+ (iPad mini 1), TenFourFox / PowerFox.
 *
 * Rendering model — 5 stacked layers inside #stage:
 *   1. #bg-layer     : scene background, opaque, looping ambient
 *   2. #item-layer   : per-item <img> overlays, hidden once picked up
 *   3. #char-layer   : single 800x500 transparent character clip
 *   4. #hotspot-layer: transparent clickable divs
 *   5. #hotbar       : 6 circular slots along the bottom
 *
 * Interaction model:
 *   - Tap a hotspot to play its char clip, then dispatch (go / pick).
 *   - Tap an inventory item to select it, then tap a matching hotspot.
 *
 * The stage is a fixed 800x600 design surface. The hotbar overlaps the
 * bottom of the stage rather than increasing the game area. JS applies a
 * scale() transform on load / resize to fit the viewport (aspect ratio
 * preserved).
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

  var gameEl, stageEl, bgImg, objImg, charImg, itemLayer, hotspotLayer, hotbarEl;
  var swapSeq = 0;
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
      if (CURSORS.hasOwnProperty(n)) preload('cursor_' + n + '.gif');
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
    return meta.icon || 'icon_' + itemId + '.gif';
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
        : 'cursor_' + name + '.gif');
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
      hintBtnEl.src = 'images/' + (hintMode ? 'ui_hint_on.gif' : 'ui_hint.gif');
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
    bgImg        = document.getElementById('bg-layer');
    objImg       = document.getElementById('obj-layer');
    charImg      = document.getElementById('char-layer');
    itemLayer    = document.getElementById('item-layer');
    hotspotLayer = document.getElementById('hotspot-layer');
    hotbarEl     = document.getElementById('hotbar');
    updateScale();
    initCursor();
    initHintButton();
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
    if (typeof gameEl.style.zoom !== 'undefined') {
      // WebKit: transform rasterizes at 800x600 then GPU-smooths, ignoring
      // image-rendering. `zoom` scales through layout instead, so images
      // resample with the crisp-pixel hints. zoom multiplies the element's
      // own lengths too, hence the division.
      gameEl.style.zoom = currentScale;
      gameEl.style.left = (tx / currentScale) + 'px';
      gameEl.style.top  = (ty / currentScale) + 'px';
    } else {
      // Gecko (TenFourFox): no zoom, but -moz-crisp-edges is honoured
      // under transforms, so transform scaling stays crisp.
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
      fn(evt);
      return false;
    };
    el.ontouchstart = function (evt) {
      if (evt && evt.preventDefault) evt.preventDefault();
      lastTouchTime = Date.now();
      fn(evt);
      return false;
    };
  }

  function createSound(fileName) {
    if (!fileName || (typeof window.Audio !== 'function' && typeof window.Audio !== 'object')) {
      return null;
    }
    try {
      var audio = new Audio('sounds/' + fileName);
      audio.preload = 'auto';
      return audio;
    } catch (e) {
      return null;
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
      // fail must never fall back to the object's success sound
      if (name === 'fail') return h.failSound || currentSounds.fail;
      var key = name + 'Sound';
      if (h[key]) return h[key];
      if (h.sound) return h.sound;
    }
    return currentSounds[name];
  }

  function loadSound(fileName) {
    if (!fileName) return null;
    if (soundCache[fileName]) return soundCache[fileName];
    soundCache[fileName] = createSound(fileName);
    return soundCache[fileName];
  }

  function playSceneSound(name, h) {
    playSound(loadSound(getSoundFile(name, h)));
  }

  function playSound(sound) {
    if (!sound || !sound.play) return;
    try {
      sound.currentTime = 0;
      sound.play();
    } catch (e) {
      try { sound.play(); } catch (ignore) {}
    }
  }

  /* ---------- layer swap helpers ---------- */

  function reloadSrc(img, fileName) {
    swapSeq++;
    var next = new Image();
    next.onload = function () {
      img.src = next.src;
    };
    next.onerror = function () {
      img.src = 'images/' + fileName + '?t=' + swapSeq;
    };
    next.src = 'images/' + fileName + '?t=' + swapSeq;
  }

  function swapBg(fileName)   { bgImg.src = 'images/' + fileName; }
  function swapObject(fileName) { objImg.style.display = ''; reloadSrc(objImg, fileName); }
  function swapChar(fileName) { reloadSrc(charImg, fileName); }
  function clearObject() {
    objImg.style.display = 'none';
    objImg.src = '';
  }

  /* ---------- scene lifecycle ---------- */

  function initHintButton() {
    var btn = document.getElementById('hint-button');
    if (!btn) return;
    hintBtnEl = btn;
    preload('ui_hint_on.gif');
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
    swapChar(scene.idle);
    renderSceneObjects(scene);
    clearObjectWhenReady();
  }

  // Keep the previous action's last overlay frame visible until the item
  // layer's images have actually loaded, so a state swap (e.g. a gate's
  // _use clip ending) doesn't flash the bare background. Skips the clear
  // if another swap started in the meantime.
  function clearObjectWhenReady() {
    var seq = swapSeq;
    var imgs = itemLayer.getElementsByTagName('img');
    var pending = 1;
    function done() {
      pending--;
      if (pending <= 0 && swapSeq === seq) clearObject();
    }
    for (var i = 0; i < imgs.length; i++) {
      if (!imgs[i].complete) {
        pending++;
        imgs[i].onload = done;
        imgs[i].onerror = done;
      }
    }
    done();
  }

  /* ---------- scene items ---------- */

  function renderItems(list) {
    clearItems();
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!itemMatches(it) || hasItem(it.id) || spent[it.id]) continue;
      var img = document.createElement('img');
      img.src = 'images/' + it.src;
      img.className = 'item';
      img.style.left = it.x + 'px';
      img.style.top = it.y + 'px';
      itemLayer.appendChild(img);
    }
  }

  function itemMatches(it) {
    if (!it.when) return true;
    if (it.when.flag) {
      var flagValue = storyFlags[it.when.flag];
      if (it.when.value === undefined) return !!flagValue;
      return flagValue === it.when.value;
    }
    return true;
  }

  function clearItems() {
    while (itemLayer.firstChild) itemLayer.removeChild(itemLayer.firstChild);
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
    preload('icon_' + obj.item + '.gif');
    return {
      id: obj.item,
      src: 'item_' + obj.item + '.gif',
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
    var im = new Image();
    im.src = 'images/' + fileName;
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
        var img = document.createElement('img');
        img.src = 'images/' + obj.src;
        img.className = 'item';
        img.style.left = (obj.x || 0) + 'px';
        img.style.top = (obj.y || 0) + 'px';
        itemLayer.appendChild(img);
      }
      if (obj.area) {
        hotspotLayer.appendChild(makeHotspotEl(obj));
      }
    }
  }

  function objectMatches(obj) {
    if (!obj.when) return true;
    if (obj.when.flag) {
      var flagValue = storyFlags[obj.when.flag];
      if (obj.when.value === undefined) return !!flagValue;
      if (obj.when.value === false) return !flagValue;
      return flagValue === obj.when.value;
    }
    return true;
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
    if (!h.when) return true;
    if (h.when.flag) {
      var flagValue = storyFlags[h.when.flag];
      if (h.when.value === undefined) return !!flagValue;
      if (h.when.value === false) return !flagValue;
      return flagValue === h.when.value;
    }
    return true;
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

    if (h.needs) consume(h.needs);

    if (h.setState && h.id) {
      objectStates[h.id] = h.setState;
    }
    if (h.setFlagValue !== undefined && h.setFlag) {
      storyFlags[h.setFlag] = h.setFlagValue;
    } else if (h.setFlag) {
      storyFlags[h.setFlag] = true;
    }
    if (h.clearFlag) {
      delete storyFlags[h.clearFlag];
    }

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

  function makeHotbarTapHandler(itemId) {
    return function () {
      if (busy) return;
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
