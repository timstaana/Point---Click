/* Room definitions — the whole game is data in this one file
 * (edited by hand or through the editor at /editor.html).
 *
 * window.SCENES maps room ids to ROOMS. A ROOM is: bg (looping background clip), idle (looping character clip),
 * failAnim/failDur (default wrong-item reaction), objects (the room's
 * hotspots, list below),
 * and optional `sounds` overrides for select/pickup/door/fail.
 *
 * OBJECTS (hotspots) — each is one clickable thing. The common shapes:
 *
 *   look    { area, anim, dur, sound }
 *   exit    { area, anim, dur, then: 'go:room', entryAnim, entryDur }
 *   pickup  { item: 'key', area, anim, dur }
 *   gate    { gate: 'hallway_gardendoor', area, locked: {...}, open: {...} }
 *
 *   area:  [x1,y1,x2,y2] rectangle, or a longer list for a polygon
 *   anim / objAnim: character clip / object overlay clip (both may play)
 *   dur:   OPTIONAL wait in ms. Omit it and the clip's real length
 *          (frames x ms-per-frame, straight from the GIF) is used
 *          automatically — art timing changes never need edits here.
 *          Specify only to override: hold longer than the clip (e.g.
 *          a voice line plays over the held last frame), or to time a
 *          LOOPING clip, which has no natural length. Same rule for
 *          entryDur, gate locked.dur and cutscene step durs.
 *   then:  what happens after the clip: 'go:room' or 'pick:item'
 *          (omit to just return to idle)
 *   cursor: hover cursor name -> cursor_<name>.png (40x40, same size as
 *          icons); e.g. 'left'/'right' on exits pointing toward the next
 *          room. Hotspots default to 'point'. Automatic states: busy
 *          shows 'wait', and while an inventory item is selected the
 *          cursor is that item's own icon.
 *
 * ITEM INTERACTIONS — the same idea everywhere:
 *   needs: 'key'      the one item this object wants (consumed on use
 *                     unless keepItem: true — for reusable tools)
 *   hint / hintDur:   voice line when tapped with no or a wrong item,
 *                     e.g. "It's locked, I need a key" — hintDur should
 *                     match the line so the character holds the fail pose
 *   items:            reactions to SPECIFIC items being used here:
 *       items: { key: 'vo_generic_key_wrong.wav' }              rejection line
 *       items: { key: { hint: '...', hintDur: 2100 } }  rejection, timed
 *       items: { bucket: { consume: true, anim, dur, then } }  real action
 *
 * GATES — anything blocked until the right item is used (locked door,
 * NPC who wants something, machine missing a part). Two blocks:
 *   locked: { needs, dur (use-clip length), sound, hint, hintDur, items,
 *             then, setFlag, ... — then/entryAnim run AFTER the use clip,
 *             e.g. then: 'cut:...' for a follow-up cutscene }
 *   open:   a normal click action (anim, dur, sound, then, entryAnim, ...)
 * Using the right item plays the one-shot use clip and the gate stays
 * open for the rest of the game.
 *
 * COMBINING ITEMS — select one hotbar item, then tap another:
 *   window.COMBINE = [
 *     { parts: ['rope', 'hook'], makes: 'grapple',
 *       sound: 'combine.wav', setFlag: 'madeGrapple' }
 *   ];
 *   Both parts are consumed (list reusable ones in keeps: ['knife']) and
 *   the result lands in the hotbar; a gate then simply wants the result:
 *   locked: { needs: 'grapple', ... }.
 *   A held part can also be used directly on the other part's room
 *   hotspot: the pickup's grab clip plays and the COMBINED item lands
 *   in the hotbar — the room part never passes through the inventory.
 *   window.COMBINE_HINT: voice line for a no-recipe pair, played with
 *   the scene's fail animation (like a wrong item on a hotspot); if
 *   unset, tapping two unrelated items just switches the selection.
 *   ART: only icon_<makes> (40x40) — the result never lies in a room.
 *
 * CUTSCENES — timed full-frame clip sequences, no interaction:
 *   window.CUTSCENES = {
 *     intro: {
 *       skip: true,                       // tap anywhere to skip
 *       steps: [
 *         { bg: 'cut_intro_1.png', dur: 3000, sound: 'vo_intro_1.wav' },
 *         { bg: 'cut_intro_2.png', dur: 2500 },
 *         { anim: 'char_x.png', dur: 2000 } // char clip over current bg
 *       ],
 *       then: 'go:bedroom', entryAnim: '...', setFlag: 'sawIntro'
 *     }
 *   };
 *   Trigger from any object with then: 'cut:intro' (gates, pickups and
 *   fail paths included). Steps use the normal full-frame art contract;
 *   a step's bg swaps the backdrop (clearing the character unless the
 *   step also has anim), anim alone plays over the current backdrop —
 *   so a cutscene can run inside the room or on its own art. When the
 *   steps end, then/setFlag/entryAnim behave exactly as on a hotspot
 *   (omit `then` to return to the room's idle). Everything the cutscene
 *   references is preloaded before it starts; its target room loads
 *   while it plays. The hotbar is hidden throughout.
 *   window.START_CUTSCENE = 'intro' plays one at boot, before the
 *   first room appears.
 *
 * STORY FLAGS (optional, for cross-object logic — this is how a puzzle
 * dependency chart maps onto scenes: `needs` is an item edge, `when` is
 * the AND of flag edges, `setFlag` is the node's outgoing edges):
 *   when: { flag: 'x' }                      truthy check
 *         { flag: 'x', value: false }        not-yet check
 *         [{ flag: 'x' }, { flag: 'y' }]     ALL must hold (AND)
 *         (for OR, list the object twice with different `when`s —
 *          every matching object renders)
 *   setFlag: 'x' or ['x', 'y']   set after the click completes
 *   clearFlag: 'x' or ['x', 'y'] clear after the click completes
 *   setFlagValue: with a single setFlag, set it to a specific value
 *
 * ART CONTRACT — the game runs on PNGs; scene data never contains art
 * coordinates.
 *   STATIC art: one PNG (800x600 stage cel, or 40x40 icon/cursor).
 *   ANIMATED art: a horizontal PNG strip — 800x600 frames side by
 *   side — plus one entry in images/sheets.js:
 *     "name.png": { "file": "name.png", "frames": N,
 *                   "dur": <ms per frame>, "loop": 1 or 0 }
 *   Scenes reference the name directly. No sheets.js entry = static.
 *   Stage cels other than backgrounds are transparent PNGs.
 *
 * ART WORKFLOW — ALL art is authored as GIFs in art/ (stage clips,
 * icons, cursors, ui); nobody edits strips or sheets.js by hand:
 *   1. author in art/ — animated clips are 800x600 (loop-forever GIF =
 *      looping clip, play-once GIF = one-shot); statics are
 *      single-frame GIFs at their natural size (40x40 icons/cursors,
 *      800x120 hotbar, ...)
 *   2. run:  python3 tools/make_sheets.py
 *      -> writes PNGs into images/ and updates images/sheets.js
 *   If the GIF sources are ever lost, `python3 tools/make_sheets.py
 *   --from-pngs` rebuilds all of art/ from images/.
 *   character clips: named explicitly in the scene, but ALWAYS
 *   char_<room>_<action>.png so the editor can offer the right clips
 *   per room:
 *     char_<room>_idle          char_<room>_cant_use
 *     char_<room>_look_<thing>  char_<room>_pick_<item>
 *     char_<room>_use_<item>    char_<room>_exit_<direction>
 *     char_<room>_from_<other>  (walk-in when arriving from <other>)
 *   room overlays: obj_<room>_<action>.png
 *   gate:  gate_<id>_closed.png  loops while blocked (whole prop!)
 *          gate_<id>_use.png     one-shot when the right item is used
 *          gate_<id>_open.png    loops afterwards
 *          The prop lives ONLY in the cels, never in the background,
 *          and the last _use frame must match _open.
 *   item:  item_<room>_<id>.png (full-frame cel of it in that room)
 *          + icon_<id> (40x40 hotbar; also the held-item cursor)
 *
 * SOUND NAMING — same idea as art, so the editor can scope per room:
 *   vo_<room>_<subject>_<what>.wav   room voice lines
 *   vo_generic_<what>.wav            shared lines (any room)
 *   <name>.wav                       plain sfx (select/pickup/door/fail)
 *
 * START — window.START_ROOM names the first room (default 'bedroom');
 * window.START_CUTSCENE optionally plays a cutscene before it appears.
 */

window.START_ROOM = "bedroom";

window.START_CUTSCENE = "intro";

window.CUTSCENES = {
  "intro": {
    "skip": true,
    "steps": [
      {
        "bg": "cut_intro_title.png",
        "dur": 2600
      },
      {
        "bg": "cut_intro_story.png",
        "dur": 2600
      }
    ],
    "then": "go:bedroom",
    "entryAnim": "char_bedroom_from_hallway.png"
  },
  "gnome_dance": {
    "steps": [
      {
        "anim": "cut_gnome_dance.png",
        "dur": 2400,
        "sound": "pickup.wav"
      }
    ]
  }
};

window.COMBINE = [
  {
    "parts": [
      "stick",
      "string"
    ],
    "makes": "fishingrod"
  }
];

window.COMBINE_HINT = "vo_generic_combine_wrong.wav";

window.SCENES = {
  "bedroom": {
    "bg": "bg_bedroom.png",
    "idle": "char_bedroom_idle.png",
    "failAnim": "char_bedroom_cant_use.png",
    "objects": [
      {
        "item": "key",
        "area": [
          599,
          280,
          675,
          328
        ],
        "anim": "char_bedroom_pick_key.png",
        "id": "hs_bedroom_1"
      },
      {
        "area": [
          41,
          122,
          221,
          422
        ],
        "cursor": "left",
        "anim": "char_bedroom_exit_left.png",
        "then": "go:hallway",
        "entryAnim": "char_hallway_from_bedroom.png",
        "id": "hs_bedroom_2"
      },
      {
        "area": [
          300,
          332,
          481,
          420
        ],
        "anim": "char_bedroom_look_bed.png",
        "dur": 2800,
        "sound": "vo_bedroom_bed_nap.wav",
        "items": {
          "key": {
            "hint": "vo_generic_key_wrong.wav",
            "hintDur": 2100
          }
        },
        "id": "hs_bedroom_3"
      }
    ]
  },
  "hallway": {
    "bg": "bg_hallway.png",
    "idle": "char_hallway_idle.png",
    "failAnim": "char_hallway_cant_use.png",
    "objects": [
      {
        "area": [
          13,
          151,
          180,
          451
        ],
        "cursor": "left",
        "anim": "char_hallway_exit_left.png",
        "then": "go:bedroom",
        "entryAnim": "char_bedroom_from_hallway.png",
        "id": "hs_hallway_1"
      },
      {
        "gate": "hallway_gardendoor",
        "area": [
          620,
          150,
          793,
          450
        ],
        "locked": {
          "needs": "key",
          "sound": "door.wav",
          "cursor": "right",
          "hint": "vo_hallway_gardendoor_locked.wav",
          "hintDur": 2500
        },
        "open": {
          "cursor": "right",
          "anim": "char_hallway_exit_right.png",
          "sound": "door.wav",
          "then": "go:garden",
          "entryAnim": "char_garden_from_hallway.png"
        },
        "id": "hs_hallway_2"
      },
      {
        "area": [
          311,
          211,
          489,
          400
        ],
        "objAnim": "obj_hallway_look_painting.png",
        "sound": "pickup.wav",
        "anim": "char_hallway_look_painting.png",
        "id": "hs_hallway_3"
      },
      {
        "item": "string",
        "area": [
          517,
          390,
          578,
          434
        ],
        "anim": "char_hallway_pick_string.png",
        "id": "hs_hallway_4"
      }
    ]
  },
  "garden": {
    "bg": "bg_garden.png",
    "idle": "char_garden_idle.png",
    "failAnim": "char_garden_cant_use.png",
    "objects": [
      {
        "area": [
          6,
          155,
          182,
          455
        ],
        "cursor": "left",
        "anim": "char_garden_exit_left.png",
        "then": "go:hallway",
        "entryAnim": "char_hallway_from_garden.png",
        "id": "hs_garden_1"
      },
      {
        "item": "stick",
        "area": [
          196,
          379,
          285,
          439
        ],
        "anim": "char_garden_pick_stick.png",
        "id": "hs_garden_2"
      },
      {
        "area": [
          400,
          300,
          600,
          470
        ],
        "when": {
          "flag": "coinFished",
          "value": false
        },
        "anim": "char_garden_look_fountain.png",
        "items": {
          "fishingrod": {
            "anim": "char_garden_use_fishingrod.png",
            "sound": "pickup.wav",
            "then": "pick:coin",
            "setFlag": "coinFished"
          }
        },
        "id": "hs_garden_3"
      },
      {
        "area": [
          400,
          300,
          600,
          470
        ],
        "when": {
          "flag": "coinFished"
        },
        "anim": "char_garden_look_fountain.png",
        "items": {
          "fishingrod": {
            "hint": "vo_garden_fountain_empty.wav",
            "hintDur": 1100
          }
        },
        "id": "hs_garden_4"
      },
      {
        "gate": "garden_gnome",
        "area": [
          646,
          307,
          753,
          477
        ],
        "locked": {
          "needs": "coin",
          "sound": "pickup.wav",
          "hint": "vo_garden_gnome_wants.wav",
          "hintDur": 3100,
          "setFlag": "gnomePaid",
          "then": "cut:gnome_dance"
        },
        "open": {
          "sound": "select.wav"
        },
        "id": "hs_garden_5"
      },
      {
        "item": "medal",
        "when": {
          "flag": "gnomePaid"
        },
        "area": [
          635,
          403,
          693,
          466
        ],
        "anim": "char_garden_pick_medal.png",
        "id": "hs_garden_6"
      }
    ]
  }
};
