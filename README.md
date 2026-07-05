# Point & Click

A one-file-of-data adventure game engine for very old devices, plus the
tooling to build games for it without touching code.

- **Game**: ES5, single canvas, runs on Safari 8 (iPad mini 1 / iOS 8)
  and TenFourFox. `index.html` + `engine.js` + `scenes.js`.
- **Editor**: `/editor.html` — modern browsers only, rewrites `scenes.js`
  through the dev server (a timestamped backup lands in `backups/` on
  every save).

## Quick start

```
npm start              # dev server → http://localhost:8080
                       #   game:   http://localhost:8080/
                       #   editor: http://localhost:8080/editor.html
npm run sheets         # rebuild images/ + sheets.js from the GIFs in art/
npm run generate-certs # one-time: self-signed certs for the HTTPS port
```

Old devices must use the **HTTP** port — a self-signed cert silently
breaks audio on iOS even after the warning is accepted.

## How a game fits together

Everything is one `window.GAME` object in `scenes.js` (documented in
detail in its header), shaped like the editor's step map:

- **Rooms** (`GAME.rooms`) — a background, an idle character clip, and
  a list of **hotspots**.
- **Hotspots are steps** — one shape for everything. A pickup is just
  `gives: 'key'`. A lock is `needs: 'coin'` (+ `hint`, `useAnim`,
  `gateArt`, `onUnlock`). What a successful tap causes are the named
  keys `gives` / `plays` / `goes`, run in that order.
- **No flags.** The engine records completed step ids in a `done` set;
  `after: ['gnome_dance']` / `afterNot: [...]` on any hotspot gate its
  existence on those steps. Hotspots sharing one area are one spot with
  several after-switched **states** (fountain full / fountain empty).
- **Items** live in the hotbar; **combine** recipes merge two into one
  (their completion id is `make:<result>`).
- **Cutscenes** (`GAME.cutscenes`) — timed full-frame clip sequences,
  triggered by a step's `plays:` or at boot (`GAME.start.play`).
  Finishing one is itself a step other things can be `after`.

The editor is **one screen**: a node map on the left, a context pane
(stage + inspector) on the right, and an issues strip at the bottom.
The map is a **puzzle-dependency chart in the player's own terms**:
every node is a *step* ("take key", "unlock door to garden", "make
fishingrod", "watch gnome_dance"), every wire means *"needs this
first"* — labelled with the item that carries it, or dashed for plain
`after` ordering. Rooms are containers, not steps — a locked door is a
step whose wire *opens* the next room; plain exits are thin one-way
arrows (one per direction). Drag between nodes to wire logic; click a
wire to delete it; node positions persist in `editor-layout.json`
(never loaded by the game). The issues drawer lists broken wiring
(unobtainable items, unknown after-steps) and every missing art/sound
file with what needs it.

## Art workflow

Author **GIFs in `art/`** — never edit `images/` or `sheets.js` by hand:

1. Stage clips are 800×600; loop-forever GIF = looping clip, play-once
   GIF = one-shot. Statics (icons 40×40, hotbar 800×120) are
   single-frame GIFs at natural size.
2. `npm run sheets` converts them to the PNG strips the engine uses.

Timing lives in the GIF: the engine reads each clip's real length, so
re-timing art never requires data edits.

### Naming = wiring

Names follow strict conventions, and both the engine and the editor
derive art from them (room defaults, grab clips, walk-ins, gate cels,
per-room dropdown scoping):

| art | pattern |
|---|---|
| room background / idle / fail | `bg_<room>` · `char_<room>_idle` · `char_<room>_cant_use` |
| character actions | `char_<room>_look_<thing>` · `_pick_<item>` · `_use_<item>` · `_exit_<dir>` |
| walk-in from another room | `char_<room>_from_<other>` |
| room overlay | `obj_<room>_<action>` |
| item in room / hotbar icon | `item_<room>_<item>` · `icon_<item>` |
| lock prop (3 cels) | `gate_<id>_closed` / `_use` / `_open` |
| cutscene art | `cut_<cutscene>_<step>` |
| voice lines | `vo_<room>_<subject>_<what>.wav` · `vo_generic_<what>.wav` |

## Device gotchas (why the engine looks the way it does)

`engine.js` must stay ES5 and is full of deliberate workarounds —
single-canvas rendering (iOS 8 flashes layered DOM animation), Web Audio
verify-and-rebuild (iOS 8 standalone hands out silently dead contexts),
`no-store` headers for code (the home-screen shell caches JS for weeks).
Read the comments before "cleaning up" anything in it.
