/* Game data — the whole game is this one window.GAME object,
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

window.GAME = {
  "start": {
    "room": "bedroom",
    "play": "intro"
  },
  "rooms": {
    "bedroom": {
      "bg": "bg_bedroom.png",
      "idle": "char_bedroom_idle.png",
      "failAnim": "char_bedroom_cant_use.png",
      "hotspots": [
        {
          "id": "hs_bedroom_1",
          "area": [
            599,
            280,
            675,
            328
          ],
          "gives": "key",
          "anim": "char_bedroom_pick_key.png"
        },
        {
          "id": "hs_bedroom_2",
          "area": [
            41,
            122,
            221,
            422
          ],
          "cursor": "left",
          "anim": "char_bedroom_exit_left.png",
          "goes": "hallway",
          "entryAnim": "char_hallway_from_bedroom.png"
        },
        {
          "id": "hs_bedroom_3",
          "area": [
            300,
            332,
            481,
            420
          ],
          "anim": "char_bedroom_look_bed.png",
          "sound": "vo_bedroom_bed_nap.wav",
          "dur": 2800,
          "reactions": {
            "key": {
              "hint": "vo_generic_key_wrong.wav",
              "hintDur": 2100
            }
          }
        }
      ]
    },
    "hallway": {
      "bg": "bg_hallway.png",
      "idle": "char_hallway_idle.png",
      "failAnim": "char_hallway_cant_use.png",
      "hotspots": [
        {
          "id": "hs_hallway_1",
          "area": [
            13,
            151,
            180,
            451
          ],
          "cursor": "left",
          "anim": "char_hallway_exit_left.png",
          "goes": "bedroom",
          "entryAnim": "char_bedroom_from_hallway.png"
        },
        {
          "id": "hs_hallway_2",
          "area": [
            620,
            150,
            793,
            450
          ],
          "needs": "key",
          "gateArt": "hallway_gardendoor",
          "hint": "vo_hallway_gardendoor_locked.wav",
          "hintDur": 2500,
          "useSound": "door.wav",
          "cursor": "right",
          "anim": "char_hallway_exit_right.png",
          "sound": "door.wav",
          "goes": "garden",
          "entryAnim": "char_garden_from_hallway.png"
        },
        {
          "id": "hs_hallway_3",
          "area": [
            311,
            211,
            489,
            400
          ],
          "anim": "char_hallway_look_painting.png",
          "objAnim": "obj_hallway_look_painting.png",
          "sound": "pickup.wav"
        },
        {
          "id": "hs_hallway_4",
          "area": [
            517,
            390,
            578,
            434
          ],
          "gives": "string",
          "anim": "char_hallway_pick_string.png"
        }
      ]
    },
    "garden": {
      "bg": "bg_garden.png",
      "idle": "char_garden_idle.png",
      "failAnim": "char_garden_cant_use.png",
      "hotspots": [
        {
          "id": "hs_garden_1",
          "area": [
            6,
            155,
            182,
            455
          ],
          "cursor": "left",
          "anim": "char_garden_exit_left.png",
          "goes": "hallway",
          "entryAnim": "char_hallway_from_garden.png"
        },
        {
          "id": "hs_garden_2",
          "area": [
            196,
            379,
            285,
            439
          ],
          "gives": "stick",
          "anim": "char_garden_pick_stick.png"
        },
        {
          "id": "hs_garden_3",
          "area": [
            400,
            300,
            600,
            470
          ],
          "afterNot": [
            "hs_garden_3"
          ],
          "anim": "char_garden_look_fountain.png",
          "reactions": {
            "fishingrod": {
              "anim": "char_garden_use_fishingrod.png",
              "sound": "pickup.wav",
              "gives": "coin"
            }
          }
        },
        {
          "id": "hs_garden_4",
          "area": [
            400,
            300,
            600,
            470
          ],
          "after": [
            "hs_garden_3"
          ],
          "anim": "char_garden_look_fountain.png",
          "reactions": {
            "fishingrod": {
              "hint": "vo_garden_fountain_empty.wav",
              "hintDur": 1100
            }
          }
        },
        {
          "id": "hs_garden_5",
          "area": [
            646,
            307,
            753,
            477
          ],
          "needs": "coin",
          "gateArt": "garden_gnome",
          "hint": "vo_garden_gnome_wants.wav",
          "hintDur": 3100,
          "useSound": "pickup.wav",
          "onUnlock": {
            "plays": "gnome_dance"
          },
          "sound": "select.wav"
        },
        {
          "id": "hs_garden_6",
          "area": [
            635,
            403,
            693,
            466
          ],
          "after": [
            "gnome_dance"
          ],
          "gives": "medal",
          "anim": "char_garden_pick_medal.png"
        }
      ]
    }
  },
  "cutscenes": {
    "intro": {
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
      "skip": true,
      "goes": "bedroom",
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
  },
  "combine": [
    {
      "parts": [
        "stick",
        "string"
      ],
      "makes": "fishingrod"
    }
  ],
  "combineHint": "vo_generic_combine_wrong.wav"
};
