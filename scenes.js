/* Scene definitions.
 *
 * A SCENE is: bg (looping background GIF), idle (looping character clip),
 * failAnim/failDur (default wrong-item reaction), objects (list below),
 * and optional `sounds` overrides for select/pickup/door/fail.
 *
 * OBJECTS — each is one clickable thing. The common shapes:
 *
 *   look    { area, anim, dur, sound }
 *   exit    { area, anim, dur, then: 'go:scene', entryAnim, entryDur }
 *   pickup  { item: 'key', area, anim, dur }
 *   gate    { gate: 'hallway_gardendoor', area, locked: {...}, open: {...} }
 *
 *   area:  [x1,y1,x2,y2] rectangle, or a longer list for a polygon
 *   anim / objAnim: character clip / object overlay clip (both may play)
 *   dur:   length of the clip, ms — clips play once and hold
 *   then:  what happens after the clip: 'go:scene' or 'pick:item'
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
 *       items: { key: 'vo_key_wrong.wav' }              rejection line
 *       items: { key: { hint: '...', hintDur: 2100 } }  rejection, timed
 *       items: { bucket: { consume: true, anim, dur, then } }  real action
 *
 * GATES — anything blocked until the right item is used (locked door,
 * NPC who wants something, machine missing a part). Two blocks:
 *   locked: { needs, dur (use-clip length), sound, hint, hintDur, items }
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
 *         { bg: 'cut_intro_1.gif', dur: 3000, sound: 'vo_intro_1.wav' },
 *         { bg: 'cut_intro_2.gif', dur: 2500 },
 *         { anim: 'char_x.gif', dur: 2000 } // char clip over current bg
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
 * ART CONTRACT — everything except backgrounds is a full-frame 800x600
 * transparent GIF cel; scene data never contains art coordinates.
 * (Delivery stays GIF; make_sheets.py flattens stage art to PNG strips
 * for the canvas renderer and UI art to static PNGs — run it after any
 * art change. Scenes always reference the .gif names.)
 *   character clips: named explicitly in the scene (char_*.gif)
 *   gate:  gate_<id>_closed.gif  loops while blocked (whole prop!)
 *          gate_<id>_use.gif     one-shot when the right item is used
 *          gate_<id>_open.gif    loops afterwards
 *          The prop lives ONLY in the cels, never in the background,
 *          and the last _use frame must match _open.
 *   item:  item_<scene>_<id>.gif (full-frame cel of it in that room)
 *          + icon_<id> (40x40 hotbar; also the held-item cursor)
 */

// Played once at boot (before the first room). Optional.
window.START_CUTSCENE = 'intro';

window.CUTSCENES = {

  // Title cards at game start; tap to skip, lands in the bedroom.
  intro: {
    skip: true,
    steps: [
      { bg: 'cut_intro_title.gif', dur: 2600 },
      { bg: 'cut_intro_story.gif', dur: 2600 }
    ],
    then: 'go:bedroom'
  },

  // The gnome celebrates his coin (plays over the garden, right before
  // the medal appears). Triggered by the gnome gate's locked action.
  gnome_dance: {
    steps: [
      { anim: 'cut_gnome_dance.gif', dur: 2400, sound: 'pickup.wav' }
    ]
    // no `then`: back to garden idle, where gnomePaid reveals the medal
  }

};

window.COMBINE = [
  { parts: ['stick', 'string'], makes: 'fishingrod' }
];

// played when two hotbar items have no recipe (remove to switch selection instead)
window.COMBINE_HINT = 'vo_combine_wrong.wav';

window.SCENES = {

  bedroom: {
    bg: 'bg_bedroom.gif',
    idle: 'char_bedroom_idle.gif',
    failAnim: 'char_bedroom_cant_use.gif',
    failDur: 1000,
    objects: [
      { item: 'key', area: [560, 260, 720, 400],
        anim: 'char_bedroom_pick_key.gif', dur: 2000 },

      { area: [40, 120, 220, 420], cursor: 'left',
        anim: 'char_bedroom_exit_left.gif', dur: 1400,
        then: 'go:hallway',
        entryAnim: 'char_hallway_from_bedroom.gif', entryDur: 1400 },

      { area: [300, 350, 480, 470],
        anim: 'char_bedroom_look_bed.gif', dur: 2800,
        sound: 'vo_bedroom_bed_nap.wav',
        items: {
          key: { hint: 'vo_key_wrong.wav', hintDur: 2100 }
        } }
    ]
  },

  hallway: {
    bg: 'bg_hallway.gif',
    idle: 'char_hallway_idle.gif',
    failAnim: 'char_hallway_cant_use.gif',
    failDur: 1000,
    objects: [
      { area: [0, 150, 180, 450], cursor: 'left',
        anim: 'char_hallway_exit_left.gif', dur: 1400,
        then: 'go:bedroom',
        entryAnim: 'char_bedroom_from_hallway.gif', entryDur: 1400 },

      { gate: 'hallway_gardendoor', area: [620, 150, 800, 450],
        locked: {
          needs: 'key', dur: 2000, sound: 'door.wav',
          cursor: 'right',
          hint: 'vo_gardendoor_locked.wav', hintDur: 2500
        },
        open: {
          cursor: 'right',
          anim: 'char_hallway_exit_right.gif', dur: 1400,
          sound: 'door.wav',
          then: 'go:garden',
          entryAnim: 'char_garden_from_hallway.gif', entryDur: 1400
        } },

      { area: [300, 200, 500, 420],
        objAnim: 'obj_hallway_look_painting.gif', dur: 900,
        sound: 'pickup.wav'},

      { item: 'string', area: [510, 380, 620, 460],
        anim: 'char_hallway_pick_string.gif', dur: 2000 }
    ]
  },

  garden: {
    bg: 'bg_garden.gif',
    idle: 'char_garden_idle.gif',
    failAnim: 'char_garden_cant_use.gif',
    failDur: 1000,
    objects: [
      { area: [0, 150, 180, 450], cursor: 'left',
        anim: 'char_garden_exit_left.gif', dur: 1400,
        then: 'go:hallway',
        entryAnim: 'char_hallway_from_garden.gif', entryDur: 1400 },

      { item: 'stick', area: [190, 380, 300, 460],
        anim: 'char_garden_pick_stick.gif', dur: 2000 },

      { area: [400, 300, 600, 470], when: { flag: 'coinFished', value: false },
        anim: 'char_garden_look_fountain.gif', dur: 900,
        items: {
          fishingrod: { anim: 'char_garden_fish.gif', dur: 2000,
                        sound: 'pickup.wav',
                        then: 'pick:coin', setFlag: 'coinFished' }
        } },

      { area: [400, 300, 600, 470], when: { flag: 'coinFished' },
        anim: 'char_garden_look_fountain.gif', dur: 900,
        items: {
          fishingrod: { hint: 'vo_fountain_empty.wav', hintDur: 1100 }
        } },

      { gate: 'garden_gnome', area: [620, 320, 780, 470],
        locked: {
          needs: 'coin', dur: 2000, sound: 'pickup.wav',
          hint: 'vo_gnome_wants.wav', hintDur: 3100,
          setFlag: 'gnomePaid',
          then: 'cut:gnome_dance'
        },
        open: { sound: 'select.wav' } },

      { item: 'medal', when: { flag: 'gnomePaid' }, area: [640, 410, 735, 470],
        anim: 'char_garden_pick_medal.gif', dur: 2000 }
    ]
  }

};
