/* Point & Click — single-canvas cel engine with tap-to-select item use.
 * ES5 safe. Targets: Safari 8+ (iPad mini 1, iOS 8), TenFourFox / PowerFox.
 *
 * Rendering model — everything painted onto ONE <canvas> (iOS 8 flashes
 * when transparent animated layers sit in the DOM, so we never do
 * that). Channels composited in order each tick:
 *   bg -> item cels -> object overlay -> character
 * All art is PNG. Animated clips are horizontal PNG frame-strips
 * described by images/sheets.js (frames / per-frame ms / loop); a name
 * with no manifest entry is a static single-frame PNG. The engine owns
 * the animation clock.
 *
 * DOM: #stage-canvas, #hotspot-layer (transparent clickable divs),
 * #hotbar, #cursor-layer (software cursor). Hotspots are plain
 * positioned divs — rectangles only (polygons use bounding box).
 *
 * Sound: Web Audio first — each room's WAVs are downloaded per scene
 * (XHR) and decoded into memory buffers, so playback is instant with no
 * network at play time. One shared <audio> element is the fallback for
 * buffers still downloading / browsers without Web Audio; iOS only lets
 * it play after being started inside a user gesture, so the first tap
 * "blesses" both it and the AudioContext. One sound at a time.
 *
 * The stage is a fixed 800x600 design surface. The hotbar overlaps the
 * bottom of the stage. JS applies a transform scale on load / resize to
 * fit the viewport (aspect ratio preserved).
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

  var gameEl, canvasEl, ctx, hotspotLayer, hotbarEl;
  var currentScale = 1;
  var lastTouchTime = 0;
  var storyFlags = {};
  var objectStates = {};

  // Bump when debugging stale caches on devices; shown in the letterbox
  // corner so you can tell at a glance which build a device is running.
  var BUILD = 'b7';

  // iOS home-screen (standalone) mode: Web Audio there can pass every
  // check (clock running, no errors) yet route no sound to the speaker,
  // so standalone always uses the blessed <audio> element instead.
  var IS_STANDALONE = !!(window.navigator && window.navigator.standalone);

  /* ---------- on-device debug readout ----------
   * No inspector reaches an iOS 8 home-screen app, so tapping the build
   * stamp toggles a small overlay fed by setDebug() from the audio code. */
  var debugEl = null;
  var debugInfo = {};

  function setDebug(key, value) {
    debugInfo[key] = String(value);
    if (!debugEl) return;
    var lines = [];
    for (var k in debugInfo) {
      if (debugInfo.hasOwnProperty(k)) lines.push(k + ': ' + debugInfo[k]);
    }
    while (debugEl.firstChild) debugEl.removeChild(debugEl.firstChild);
    debugEl.appendChild(document.createTextNode(lines.join('\n')));
  }

  function toggleDebug() {
    if (debugEl) {
      document.body.removeChild(debugEl);
      debugEl = null;
      return;
    }
    debugEl = document.createElement('div');
    debugEl.id = 'debug-overlay';
    document.body.appendChild(debugEl);
    setDebug('build', BUILD + (IS_STANDALONE ? ' standalone' : ' browser'));
  }

  var HOTBAR_SLOTS = 6;
  var DEFAULT_FAIL_ANIM = 'char_generic_cant_use.png';
  var DEFAULT_SOUNDS = {
    select: 'select.wav',
    pickup: 'pickup.wav',
    door: 'door.wav',
    fail: 'fail.wav'
  };

  function iconFor(itemId) {
    var meta = items[itemId] || {};
    return meta.icon || 'icon_' + itemId + '.png';
  }

  /* ---------- software cursor ----------
   * The native cursor is hidden (CSS) and a 40x40 #cursor-layer div
   * follows the mouse instead. It sits in SCREEN coordinates outside the
   * scaled #game element, so positioning is just clientX/Y minus the
   * hotspot — no scale math, no drift. All cursor images live in the
   * layer permanently and are toggled with display, so switching
   * cursors never touches the network (old Gecko revalidates img.src on
   * every swap). Busy shows 'wait'; while an inventory item is selected
   * the cursor is that item's icon; hotspots set 'point' (or their own
   * `cursor` name) on hover. Touch devices never show it.
   * Cursor name -> hotspot px (the item icon centres): */
  var CURSORS = {
    'default': [2, 1],
    'point':   [19, 1],
    'left':    [1, 20],
    'right':   [39, 20],
    'wait':    [20, 20]
  };
  var cursorWrap = null;
  var cursorImgs = {};
  var cursorName = null;
  var hoverCursor = null;
  var cursorX = 0;
  var cursorY = 0;

  function initCursor() {
    cursorWrap = document.createElement('div');
    cursorWrap.id = 'cursor-layer';
    cursorWrap.style.display = 'none';
    for (var n in CURSORS) {
      if (CURSORS.hasOwnProperty(n)) addCursorImg(n, 'cursor_' + n + '.png');
    }
    document.body.appendChild(cursorWrap);
    if (!window.addEventListener) return;
    window.addEventListener('mousemove', function (evt) {
      if (Date.now() - lastTouchTime < 1000) return; // synthesized after a tap
      cursorX = evt.clientX;
      cursorY = evt.clientY;
      cursorWrap.style.display = 'block';
      positionCursor();
    }, false);
    document.addEventListener('mouseout', function (evt) {
      // hide only when the mouse leaves the window entirely
      if (!(evt.relatedTarget || evt.toElement)) {
        cursorWrap.style.display = 'none';
      }
    }, false);
    window.addEventListener('touchstart', function () {
      lastTouchTime = Date.now();
      cursorWrap.style.display = 'none';
    }, false);
    updateCursor();
  }

  function positionCursor() {
    var hs = CURSORS[cursorName] || [20, 20];
    cursorWrap.style.left = (cursorX - hs[0]) + 'px';
    cursorWrap.style.top  = (cursorY - hs[1]) + 'px';
  }

  function addCursorImg(name, file) {
    var im = document.createElement('img');
    im.src = 'images/' + file;
    cursorImgs[name] = im;
    cursorWrap.appendChild(im);
    return im;
  }

  // Item icon cursors are created ahead of time (all item ids are known
  // at init), so selecting an item never waits on a network round-trip.
  function ensureItemCursor(id) {
    if (cursorWrap && !cursorImgs['item:' + id]) {
      addCursorImg('item:' + id, iconFor(id));
    }
  }

  function updateCursor() {
    if (!cursorWrap) return;
    var name = busy ? 'wait'
             : selectedItem ? 'item:' + selectedItem
             : (hoverCursor || 'default');
    if (name !== cursorName) {
      if (selectedItem) ensureItemCursor(selectedItem); // safety net
      if (!cursorImgs[name]) name = 'default';
      if (cursorImgs[cursorName]) cursorImgs[cursorName].style.display = 'none';
      cursorName = name;
      cursorImgs[name].style.display = 'block';
    }
    positionCursor();
  }

  function addHover(el, name) {
    el.onmouseover = function () { hoverCursor = name; updateCursor(); };
    el.onmouseout  = function () { hoverCursor = null; updateCursor(); };
  }

  var cutsceneActive = false;

  function updateGameClasses() {
    if (!gameEl) return;
    var cls = [];
    if (busy) cls.push('busy');
    if (cutsceneActive) cls.push('cutscene');
    gameEl.className = cls.join(' ');
  }

  function setBusy(b) {
    busy = b;
    updateGameClasses();
    updateCursor();
  }

  function init() {
    gameEl       = document.getElementById('game');
    canvasEl     = document.getElementById('stage-canvas');
    ctx          = canvasEl.getContext('2d');
    hotspotLayer = document.getElementById('hotspot-layer');
    hotbarEl     = document.getElementById('hotbar');
    initAudio();
    window.setInterval(tick, TICK_MS);
    updateScaleSoon();
    initCursor();
    // Create every item's icon cursor up front: item ids come from the
    // scene pickups and the combine recipes.
    var sn, oi, objs;
    for (sn in scenes) {
      if (!scenes.hasOwnProperty(sn)) continue;
      objs = scenes[sn].objects || [];
      for (oi = 0; oi < objs.length; oi++) {
        if (objs[oi].item) ensureItemCursor(objs[oi].item);
      }
    }
    var combos = window.COMBINE || [];
    for (var ci = 0; ci < combos.length; ci++) {
      ensureItemCursor(combos[ci].makes);
      preload(iconFor(combos[ci].makes));
      if (combos[ci].sound) warmSound(combos[ci].sound, null);
    }
    preload(DEFAULT_FAIL_ANIM);
    var defaults = window.SOUNDS || DEFAULT_SOUNDS;
    for (var sk in defaults) {
      if (defaults.hasOwnProperty(sk)) warmSound(defaults[sk], null);
    }
    if (window.COMBINE_HINT) warmSound(window.COMBINE_HINT, null);
    initHotbar();
    renderHotbar();
    var stamp = document.createElement('div');
    stamp.id = 'build-stamp';
    stamp.appendChild(document.createTextNode(BUILD));
    document.body.appendChild(stamp);
    addTap(stamp, toggleDebug);
    // Black screen until the first room (and the hotbar art) is fully
    // loaded — otherwise the hotbar pops in before the stage. If a
    // START_CUTSCENE is declared, it plays first (also fully loaded).
    gameEl.style.visibility = 'hidden';
    preloadScene(current, 'ui_hotbar.png', function () {
      var sc = window.START_CUTSCENE;
      if (sc && window.CUTSCENES && window.CUTSCENES[sc]) {
        preloadCutscene(sc, function () {
          gameEl.style.visibility = '';
          playCutscene(sc);
        });
      } else {
        gameEl.style.visibility = '';
        enterScene(current, null, 0);
      }
    });
  }

  /* ---------- responsive scaling ---------- */

  var GAME_W = 800;
  var GAME_H = 600;

  function updateScale() {
    // documentElement.client* over window.inner*: iOS 8 home-screen
    // (standalone) apps report stale innerWidth/innerHeight at launch
    // and after rotation, which pushed the bottom of the stage (the
    // hotbar) off screen.
    var de = document.documentElement;
    var vw = (de && de.clientWidth) || window.innerWidth;
    var vh = (de && de.clientHeight) || window.innerHeight;
    currentScale = Math.min(vw / GAME_W, vh / GAME_H);
    gameEl.style.left = ((vw - GAME_W * currentScale) / 2) + 'px';
    gameEl.style.top  = ((vh - GAME_H * currentScale) / 2) + 'px';
    var t = 'scale(' + currentScale + ')';
    gameEl.style.webkitTransform = t;
    gameEl.style.MozTransform = t;
    gameEl.style.transform = t;
  }

  // iOS standalone settles its viewport some time after load/rotation
  // without firing resize, so rescale again a few times to catch it.
  function updateScaleSoon() {
    updateScale();
    window.setTimeout(updateScale, 250);
    window.setTimeout(updateScale, 750);
    window.setTimeout(updateScale, 1500);
  }

  /* ---------- input ---------- */

  function addTap(el, fn) {
    el.onclick = function (evt) {
      if (evt && evt.preventDefault) evt.preventDefault();
      if (Date.now() - lastTouchTime < 500) return false; // ghost click
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

  /* ---------- sound ---------- */

  var sfxEl = null;
  var audioUnlocked = false;
  var audioCtx = null;
  var ctxState = 'locked';  // locked -> testing -> ok
  var rawSoundData = {};    // fileName -> raw bytes (kept for rebuilds)
  var soundBuffers = {};    // fileName -> decoded AudioBuffer
  var currentSource = null;

  function createAudioCtx() {
    if (audioCtx || IS_STANDALONE) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { audioCtx = new AC(); } catch (eAC) {}
  }

  function decodeSound(fileName, data) {
    try {
      // decode a copy: decodeAudioData can detach the buffer, and we
      // may need the bytes again after a context rebuild
      audioCtx.decodeAudioData(data.slice ? data.slice(0) : data, function (buf) {
        soundBuffers[fileName] = buf;
      }, function () {}); // undecodable: <audio> fallback plays it
    } catch (eDec) {}
  }

  function decodeAllSounds() {
    if (!audioCtx) return;
    for (var f in rawSoundData) {
      if (rawSoundData.hasOwnProperty(f) && !soundBuffers[f]) {
        decodeSound(f, rawSoundData[f]);
      }
    }
  }

  function initAudio() {
    createAudioCtx();
    sfxEl = document.createElement('audio');
    sfxEl.preload = 'auto';
    document.body.appendChild(sfxEl);
    sfxEl.onerror = function () {
      setDebug('el-error', (sfxEl.error && sfxEl.error.code) || '?');
    };
    sfxEl.onplaying = function () {
      setDebug('el-playing', sfxCurrent);
    };
    sfxEl.onstalled = function () {
      setDebug('el-stalled', sfxCurrent);
    };
    // Unlock on interactions. iOS 8 only credits some event types as a
    // user gesture (touchend and click are the reliable ones), so
    // listen to all of them; the listeners stay attached for good —
    // unlockAudio is a cheap no-op once everything is verified, and the
    // Web Audio verify/rebuild cycle may need several gestures.
    if (document.addEventListener) {
      document.addEventListener('touchstart', unlockAudio, false);
      document.addEventListener('touchend', unlockAudio, false);
      document.addEventListener('mousedown', unlockAudio, false);
      document.addEventListener('click', unlockAudio, false);
      document.addEventListener('touchmove', function (evt) {
        if (evt.preventDefault) evt.preventDefault();
      }, false);
    }
  }

  // iOS 8 standalone (home-screen) apps sometimes hand out a context
  // that renders SILENTLY — no errors, but currentTime never advances.
  // So: unlock with a silent buffer inside the gesture, then verify the
  // clock is running; if not, scrap the context and let the next tap
  // build a fresh one (buffers are re-decoded from the kept raw bytes).
  function unlockWebAudio() {
    createAudioCtx();
    if (!audioCtx || ctxState === 'ok') return;
    decodeAllSounds();
    try {
      if (audioCtx.resume) audioCtx.resume();
      var s = audioCtx.createBufferSource();
      s.buffer = audioCtx.createBuffer(1, 1, 22050);
      s.connect(audioCtx.destination);
      if (s.start) s.start(0); else s.noteOn(0);
    } catch (eCtx) {}
    if (ctxState === 'locked') {
      ctxState = 'testing';
      window.setTimeout(function () {
        if (audioCtx && audioCtx.currentTime > 0) {
          ctxState = 'ok';
          return;
        }
        try { if (audioCtx && audioCtx.close) audioCtx.close(); } catch (eCl) {}
        audioCtx = null;
        soundBuffers = {};
        ctxState = 'locked';
        setDebug('ctx', 'dead, rebuilt on next tap');
      }, 500);
    }
  }

  function unlockAudio() {
    unlockWebAudio();
    if (audioUnlocked || !sfxEl) return;
    try {
      // A real sound already playing means a gesture was accepted.
      if (!sfxEl.paused) { audioUnlocked = true; return; }
      sfxCurrent = DEFAULT_SOUNDS.select;
      sfxEl.src = 'sounds/' + DEFAULT_SOUNDS.select;
      sfxEl.load();
      sfxEl.play();
      // On old WebKit, paused flips to false synchronously only when
      // play() is accepted; if the gesture was rejected it stays true
      // and we retry on the next interaction.
      if (!sfxEl.paused) {
        audioUnlocked = true;
        sfxEl.pause();
        try { sfxEl.currentTime = 0; } catch (e2) {}
      }
      setDebug('el-unlocked', audioUnlocked);
    } catch (e) {
      setDebug('unlock-error', e);
    }
  }

  var sfxCurrent = null;

  function playFile(fileName) {
    if (!fileName) return;
    // Web Audio path: decoded buffer plays instantly from memory.
    // Only once the context is verified rendering (ctxState ok) — a
    // silently-dead context would eat the sound with no error.
    if (audioCtx && ctxState === 'ok' && soundBuffers[fileName]) {
      try {
        if (currentSource) {
          try {
            if (currentSource.stop) currentSource.stop(0);
            else currentSource.noteOff(0);
          } catch (eStop) {}
          currentSource = null;
        }
        if (sfxEl && !sfxEl.paused) sfxEl.pause();
        var src = audioCtx.createBufferSource();
        src.buffer = soundBuffers[fileName];
        src.connect(audioCtx.destination);
        if (src.start) src.start(0); else src.noteOn(0);
        currentSource = src;
        setDebug('play', fileName + ' (webaudio t=' +
                 Math.round(audioCtx.currentTime * 10) / 10 + ')');
        return;
      } catch (eCtx) {}
    }
    // Fallback: the single <audio> element (buffer still downloading,
    // or no Web Audio support).
    if (!sfxEl) return;
    try {
      sfxEl.pause();
      // Same file again (select.wav plays constantly): rewind and
      // replay without touching src — no reload, no request.
      if (sfxCurrent === fileName && sfxEl.readyState > 0) {
        try { sfxEl.currentTime = 0; } catch (e2) {}
        sfxEl.play();
        setDebug('play', fileName + ' (el rewind, paused=' + sfxEl.paused + ')');
        return;
      }
      sfxCurrent = fileName;
      sfxEl.src = 'sounds/' + fileName;
      sfxEl.load();
      sfxEl.play();
      setDebug('play', fileName + ' (el rs=' + sfxEl.readyState +
               ' paused=' + sfxEl.paused + ')');
    } catch (e) {
      setDebug('play-error', fileName + ' ' + e);
    }
  }

  // Resolve which file a named sfx should use for this hotspot:
  // hotspot override -> scene override -> global default.
  function sfxFile(name, h) {
    if (h) {
      if (name === 'fail') {
        if (h.failSound) return h.failSound;
      } else {
        if (h[name + 'Sound']) return h[name + 'Sound'];
        if (h.sound) return h.sound;
      }
    }
    var scene = scenes[current] || {};
    if (scene.sounds && scene.sounds[name]) return scene.sounds[name];
    var defaults = window.SOUNDS || {};
    return defaults[name] || DEFAULT_SOUNDS[name];
  }

  function playSfx(name, h) {
    playFile(sfxFile(name, h));
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
  // it changes, so idle costs nothing between frame boundaries.
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

  function enterScene(name, entryAnim, entryDur) {
    current = name;
    var scene = scenes[name];
    swapBg(scene.bg);
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
    // all channel changes land in the same tick, so the swap is atomic
    clearObject();
    swapChar(scene.idle);
    renderSceneObjects(scene);
  }

  /* ---------- cutscenes ----------
   * window.CUTSCENES[name] = { steps: [...], skip?, then?, setFlag? }.
   * Each step is { bg?, anim?, dur, sound? } using the same full-frame
   * clips as everything else: bg swaps the backdrop (and clears the
   * character unless the step also has anim); anim alone plays the
   * character clip over the current backdrop, so a cutscene can run in
   * the room or on its own art. When the steps end the cutscene object
   * itself is dispatched — then/setFlag/entryAnim all work as on any
   * hotspot. Trigger from anywhere with then: 'cut:name'. */
  function playCutscene(name) {
    var cs = (window.CUTSCENES || {})[name];
    if (!cs || !cs.steps || !cs.steps.length) {
      showIdle();
      return;
    }
    cutsceneActive = true;
    setBusy(true);
    clearHotspots();
    clearItems();
    clearObject();
    // the follow-up room loads while the cutscene plays
    if (cs.then && cs.then.indexOf('go:') === 0) {
      preloadScene(cs.then.substring(3), cs.entryAnim, null);
    }
    var i = 0;
    var timer = null;
    function finish() {
      cutsceneActive = false;
      setBusy(false);
      // staying in (or returning to) a room: restore its backdrop
      if (!cs.then || cs.then.indexOf('go:') !== 0) {
        swapBg(scenes[current].bg);
      }
      dispatch(cs);
    }
    function step() {
      if (i >= cs.steps.length) {
        finish();
        return;
      }
      var st = cs.steps[i];
      i++;
      if (st.bg) {
        swapBg(st.bg);
        if (!st.anim) channels.char = null;
      }
      if (st.anim) swapChar(st.anim);
      requestPaint();
      if (st.sound) playFile(st.sound);
      timer = window.setTimeout(step, st.dur || 2000);
    }
    if (cs.skip) {
      var skipEl = document.createElement('div');
      skipEl.className = 'hotspot';
      skipEl.style.left = '0px';
      skipEl.style.top = '0px';
      skipEl.style.width = GAME_W + 'px';
      skipEl.style.height = GAME_H + 'px';
      addTap(skipEl, function () {
        if (!cutsceneActive) return;
        if (timer) window.clearTimeout(timer);
        clearHotspots();
        finish();
      });
      hotspotLayer.appendChild(skipEl);
    }
    step();
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

  /* ---------- scene objects ---------- */

  function clearItems() {
    channels.items = [];
    requestPaint();
  }

  function renderSceneObjects(scene) {
    renderObjects(scene.objects);
  }

  var preloaded = {};
  function preload(fileName) {
    if (!fileName) return null;
    if (window.SHEETS && window.SHEETS[fileName]) {
      return getSheet(fileName).img; // stage art: warm the PNG strip
    }
    if (!preloaded[fileName]) {
      var im = new Image();
      im.src = 'images/' + fileName; // UI art: plain PNG
      preloaded[fileName] = im;
    }
    return preloaded[fileName];
  }

  /* ---------- per-scene asset preloading ----------
   * A room is only shown once every clip and sound it references is
   * loaded, so a clip never plays blank on its first run. There is no
   * loading indicator: on a room change we simply stay in the current
   * room (the exit walk-out clip usually covers the whole wait, and the
   * preload starts as soon as the exit is tapped). Art is found by
   * scanning the scene data for *.png / *.wav names plus the derived
   * pickup / gate / icon names. Sounds are warmed into the HTTP cache
   * with XHR so the single <audio> element can start them instantly. */
  var warmedSounds = {};

  // Scan any schema node (scene, cutscene) for art/sound file names.
  function scanAssets(node) {
    var art = {};
    var sounds = {};
    var str = '';
    try { str = JSON.stringify(node); } catch (e) {}
    var m = str.match(/[\w\-]+\.png/g) || [];
    var i;
    for (i = 0; i < m.length; i++) art[m[i]] = true;
    m = str.match(/[\w\-]+\.wav/g) || [];
    for (i = 0; i < m.length; i++) sounds[m[i]] = true;
    return { art: art, sounds: sounds };
  }

  function sceneAssets(name) {
    var scene = scenes[name] || {};
    var assets = scanAssets(scene);
    var art = assets.art;
    var i;
    var list = scene.objects || [];
    for (i = 0; i < list.length; i++) {
      var o = list[i];
      if (o.item) {
        art['item_' + name + '_' + o.item + '.png'] = true;
        art[iconFor(o.item)] = true;
      }
      if (o.gate) {
        art['gate_' + o.gate + '_closed.png'] = true;
        art['gate_' + o.gate + '_use.png'] = true;
        art['gate_' + o.gate + '_open.png'] = true;
      }
    }
    return assets;
  }

  function warmSound(fileName, onDone) {
    warmedSounds[fileName] = true;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'sounds/' + fileName, true);
      try { xhr.responseType = 'arraybuffer'; } catch (eRT) {}
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 200 && xhr.response && typeof xhr.response !== 'string') {
          rawSoundData[fileName] = xhr.response; // kept for ctx rebuilds
          if (audioCtx) decodeSound(fileName, xhr.response);
        }
        if (onDone) onDone();
      };
      xhr.send(null);
    } catch (e) {
      if (onDone) onDone();
    }
  }

  // Load an asset set, then call cb (synchronously if it is all cached
  // already). extraArt carries the entry clip for this particular
  // transition. cb may be null for a fire-and-forget warm-up.
  function preloadAssets(assets, extraArt, cb) {
    if (extraArt) assets.art[extraArt] = true;
    var pending = 1; // released at the end, see below
    var done = false;
    function step() {
      pending--;
      if (pending <= 0 && !done) {
        done = true;
        if (cb) cb();
      }
    }
    var f;
    for (f in assets.art) {
      if (!assets.art.hasOwnProperty(f)) continue;
      var img = preload(f);
      if (img && !img.complete) {
        pending++;
        img.addEventListener('load', step, false);
        img.addEventListener('error', step, false);
      }
    }
    for (f in assets.sounds) {
      if (!assets.sounds.hasOwnProperty(f)) continue;
      if (!warmedSounds[f]) {
        pending++;
        warmSound(f, step);
      }
    }
    if (cb) {
      // never leave the game stuck on one broken file
      window.setTimeout(function () {
        if (!done) { done = true; cb(); }
      }, 15000);
    }
    step();
  }

  function preloadScene(name, extraArt, cb) {
    preloadAssets(sceneAssets(name), extraArt, cb);
  }

  function preloadCutscene(name, cb) {
    preloadAssets(scanAssets((window.CUTSCENES || {})[name] || {}), null, cb);
  }

  // Pickups: shorthand for "an item lying in the room". Art is two files
  // named after the item id:
  //   item_<scene>_<id>.png (full-frame cel) / icon_<id>.png (40x40 icon)
  function expandItem(obj) {
    if (!obj.item) return obj;
    preload(iconFor(obj.item));
    return {
      id: obj.item,
      src: 'item_' + current + '_' + obj.item + '.png',
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

  // Authoring sugar: `hint`/`hintDur` are the friendly names for a
  // rejection voice line; the fail path reads failSound/failDur.
  function normalizeAction(o) {
    if (o) {
      if (o.hint && !o.failSound) o.failSound = o.hint;
      if (o.hintDur && !o.failDur) o.failDur = o.hintDur;
    }
    return o;
  }

  // Gates: shorthand for "blocked until the right item is used" (locked
  // door, NPC who wants something, ...). Expands to a two-state object;
  // art is three full-frame cels named after the gate id:
  //   gate_<id>_closed.png / gate_<id>_use.png / gate_<id>_open.png
  function expandGate(obj) {
    if (!obj.gate) return obj;
    var stem = 'gate_' + obj.gate;
    preload(stem + '_use.png');
    preload(stem + '_open.png');
    var locked = obj.locked || {};
    var open = obj.open || {};
    var openState = { src: stem + '_open.png' };
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
          src: stem + '_closed.png',
          needs: locked.needs,
          objAnim: stem + '_use.png',
          dur: locked.dur || 2000,
          sound: locked.sound,
          hint: locked.hint, hintDur: locked.hintDur,
          failAnim: locked.failAnim, failDur: locked.failDur, failThen: locked.failThen,
          items: locked.items, cursor: locked.cursor,
          keepItem: locked.keepItem,
          setFlag: locked.setFlag, setFlagValue: locked.setFlagValue,
          clearFlag: locked.clearFlag,
          then: locked.then,
          entryAnim: locked.entryAnim, entryDur: locked.entryDur,
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
      if (!whenMatches(obj.when) || isObjectSpent(obj)) continue;
      if (obj.src) {
        channels.items.push(makeClip(obj.src));
      }
      if (obj.area) {
        hotspotLayer.appendChild(makeHotspotEl(obj));
      }
    }
    requestPaint();
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

  function clearHotspots() {
    while (hotspotLayer.firstChild) hotspotLayer.removeChild(hotspotLayer.firstChild);
    hoverCursor = null; // mouseout never fires for removed elements
    updateCursor();
  }

  // area: [x1,y1,x2,y2] rectangle; longer polygon lists just use their
  // bounding box. Plain divs — no SVG, no extra layers.
  function makeHotspotEl(h) {
    var a = h.area || [0, 0, 0, 0];
    var minX = a[0], minY = a[1], maxX = a[2], maxY = a[3];
    for (var i = 4; i + 1 < a.length; i += 2) {
      if (a[i] < minX) minX = a[i];
      if (a[i] > maxX) maxX = a[i];
      if (a[i + 1] < minY) minY = a[i + 1];
      if (a[i + 1] > maxY) maxY = a[i + 1];
    }
    var el = document.createElement('div');
    el.className = 'hotspot';
    el.style.left = minX + 'px';
    el.style.top = minY + 'px';
    el.style.width = (maxX - minX) + 'px';
    el.style.height = (maxY - minY) + 'px';
    addTap(el, function () { handleClick(h); });
    addHover(el, h.cursor || 'point');
    return el;
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
      // Held item + a room pickup that combines with it: play the
      // pickup's grab clip, then hand the recipe to dispatch — the
      // room item goes straight into the combine, never the hotbar.
      if (h.then && h.then.indexOf('pick:') === 0) {
        var combo = findCombo(selectedItem, h.then.substring(5));
        if (combo) {
          selectedItem = null;
          renderHotbar();
          triggerHotspot(mergeEntry(h, { combo: combo }));
          return;
        }
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
    if (h.then && h.then.indexOf('go:') === 0) {
      // head start: load the next room while the walk-out clip plays
      preloadScene(h.then.substring(3), h.entryAnim, null);
    }
    if (h.then && h.then.indexOf('cut:') === 0) {
      preloadCutscene(h.then.substring(4), null);
    }
    if (!h.then && h.sound) {
      playSfx('select', h);
    }
    if (h.objAnim) swapObject(h.objAnim);
    if (h.anim) swapChar(h.anim);
    window.setTimeout(function () {
      setBusy(false);
      dispatch(h);
    }, h.dur);
  }

  function triggerWrongItem(h, itemId) {
    selectedItem = null;
    renderHotbar();
    playSfx('fail', h);
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

    // Combine-at-hotspot: the room part is used up (unless the recipe
    // keeps it) and combineItems handles the rest — consuming the held
    // part, adding the result, flags and sound.
    if (h.combo) {
      if (action.indexOf('pick:') === 0) {
        var part = action.substring(5);
        if (!inKeeps(h.combo, part)) spent[part] = true;
      }
      combineItems(h.combo);
      showIdle();
      return;
    }

    if (action.indexOf('cut:') === 0) {
      var cut = action.substring(4);
      // hold the current frame until the cutscene is fully loaded
      setBusy(true);
      preloadCutscene(cut, function () {
        setBusy(false);
        playCutscene(cut);
      });
      return;
    }

    if (action.indexOf('go:') === 0) {
      var target = action.substring(3);
      // stay in the current room (holding the walk-out's last frame,
      // wait cursor, no indicator) until the next room is fully loaded
      setBusy(true);
      preloadScene(target, h.entryAnim, function () {
        setBusy(false);
        playSfx('door', h);
        enterScene(target, h.entryAnim, h.entryDur || 1200);
      });
      return;
    }

    if (action.indexOf('pick:') === 0) {
      var item = action.substring(5);
      if (!hasItem(item)) {
        inv.push(item);
        renderHotbar();
        playSfx('pickup', h);
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
  // The bar itself is art: ui_hotbar.png, an 800x120 strip drawn behind
  // the slots; its six wells must sit on the grid above (centers at
  // x = 85 + i*126, y = 55). The selected state is a CSS circle
  // (.hotbar-selected) under the icon but above the bar art.
  // The slot divs are built once; each item gets ONE cached icon <img>
  // that is moved between slots, never recreated — recreating imgs made
  // old Gecko refetch the icon (and flash) on every hotbar change.
  var slotEls = [];
  var slotSelEls = [];
  var slotIds = [];
  var iconImgs = {};

  function initHotbar() {
    var art = document.createElement('img');
    art.className = 'hotbar-art';
    art.src = 'images/ui_hotbar.png';
    hotbarEl.appendChild(art);
    for (var i = 0; i < HOTBAR_SLOTS; i++) {
      var slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      slot.style.left = (40 + i * 126) + 'px';
      var sel = document.createElement('div');
      sel.className = 'hotbar-selected';
      sel.style.display = 'none';
      slot.appendChild(sel);
      hotbarEl.appendChild(slot);
      slotEls.push(slot);
      slotSelEls.push(sel);
      slotIds.push(null);
    }
  }

  function iconImg(id) {
    if (!iconImgs[id]) {
      var img = document.createElement('img');
      img.src = 'images/' + iconFor(id);
      img.className = 'hotbar-icon';
      addTap(img, makeHotbarTapHandler(id));
      addHover(img, 'point');
      iconImgs[id] = img;
    }
    return iconImgs[id];
  }

  function renderHotbar() {
    updateCursor(); // selection may have changed
    for (var i = 0; i < HOTBAR_SLOTS; i++) {
      var slot = slotEls[i];
      var id = i < inv.length ? inv[i] : null;
      if (slotIds[i] !== id) {
        // keep the selection overlay img (firstChild); swap only icons
        while (slot.childNodes.length > 1) slot.removeChild(slot.lastChild);
        if (id) slot.appendChild(iconImg(id));
        slotIds[i] = id;
      }
      slotSelEls[i].style.display =
        (id && id === selectedItem) ? 'block' : 'none';
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

  function inKeeps(combo, part) {
    var keeps = combo.keeps || [];
    for (var i = 0; i < keeps.length; i++) {
      if (keeps[i] === part) return true;
    }
    return false;
  }

  function combineItems(combo) {
    for (var i = 0; i < 2; i++) {
      if (!inKeeps(combo, combo.parts[i])) consume(combo.parts[i]);
    }
    if (!hasItem(combo.makes)) inv.push(combo.makes);
    spent[combo.makes] = true; // never re-pickable from a room
    eachFlag(combo.setFlag, function (f) { storyFlags[f] = true; });
    selectedItem = null;
    playFile(combo.sound || sfxFile('pickup'));
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
        // combine — the character plays the scene's fail animation with
        // the line, same as using a wrong item on a hotspot. Without a
        // hint line, just switch the selection.
        if (window.COMBINE_HINT) {
          triggerWrongItem({ failSound: window.COMBINE_HINT }, itemId);
          return;
        }
      }
      selectedItem = (selectedItem === itemId) ? null : itemId;
      playSfx('select');
      renderHotbar();
    };
  }

  /* ---------- boot ---------- */

  if (window.addEventListener) {
    window.addEventListener('load', init, false);
    window.addEventListener('resize', updateScale, false);
    window.addEventListener('orientationchange', updateScaleSoon, false);
  } else {
    window.attachEvent('onload', init);
    window.attachEvent('onresize', updateScale);
  }
})();
