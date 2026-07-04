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
 *   cursor: hover cursor name -> cursor_<name>.gif (40x40 animated cel,
 *          same size as icons); e.g. 'left'/'right' on exits pointing
 *          toward the next room. Hotspots default to 'point'. Automatic
 *          states: busy shows 'wait', and while an inventory item is
 *          selected the cursor is that item's own icon.
 *
 * ITEM INTERACTIONS — the same idea everywhere:
 *   needs: 'key'      the one item this object wants (consumed on use)
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
 *   character clips: named explicitly in the scene (char_*.gif)
 *   gate:  gate_<id>_closed.gif  loops while blocked (whole prop!)
 *          gate_<id>_use.gif     one-shot when the right item is used
 *          gate_<id>_open.gif    loops afterwards
 *          The prop lives ONLY in the cels, never in the background,
 *          and the last _use frame must match _open.
 *   item:  item_<id>.gif (in the room) + icon_<id>.gif (40x40 hotbar)
 */

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
        sound: 'pickup.wav'}
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

      { area: [400, 300, 600, 470],
        anim: 'char_garden_look_fountain.gif', dur: 900 }
    ]
  }

};
