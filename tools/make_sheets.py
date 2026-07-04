#!/usr/bin/env python3
"""make_sheets.py — turns authoring GIFs into the engine's PNG art.

Art team workflow:
  1. Put GIFs in art/ (stage clips are 800x600; a GIF set to loop
     forever becomes a looping clip, a play-once GIF becomes a one-shot
     clip that holds its last frame).
  2. Run:  python3 tools/make_sheets.py
  3. Done — images/ gets the PNG strips and images/sheets.js is updated.

Details:
  - Multi-frame GIF  -> images/<name>.png horizontal frame strip
                        + a sheets.js entry (frames / ms-per-frame / loop).
  - Single-frame GIF -> images/<name>.png static image (no entry).
  - Frame duration comes from the GIF (averaged if frames differ,
    rounded to 10ms). Existing sheets.js entries for art not in art/
    are left alone. Static art (icons, cursors, ui) can also just be
    edited directly as PNGs in images/ — no GIF needed.

Recovery:
  python3 tools/make_sheets.py --from-pngs
  regenerates art/*.gif from the current strips + sheets.js
  (bootstrap after losing the GIF sources; colors are quantized
  to the GIF palette).
"""

import json
import os
import sys

from PIL import Image, ImageSequence

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, 'art')
IMAGES = os.path.join(ROOT, 'images')
SHEETS = os.path.join(IMAGES, 'sheets.js')
STAGE_SIZE = (800, 600)


def load_sheets():
    if not os.path.exists(SHEETS):
        return {}
    src = open(SHEETS).read()
    return json.loads(src[src.index('{'):].rstrip().rstrip(';'))


def save_sheets(data):
    with open(SHEETS, 'w') as f:
        f.write('window.SHEETS = ' + json.dumps(data, indent=1, sort_keys=True) + ';\n')


def gif_frames(path):
    im = Image.open(path)
    frames, durs = [], []
    for frame in ImageSequence.Iterator(im):
        durs.append(frame.info.get('duration', 100))
        frames.append(frame.convert('RGBA'))
    # GIF loop=0 means "forever"; absent means "play once"
    loop = 1 if im.info.get('loop', None) == 0 else 0
    return frames, durs, loop


def build():
    if not os.path.isdir(ART):
        print('no art/ directory — put authoring GIFs there first')
        return
    names = sorted(n for n in os.listdir(ART) if n.lower().endswith('.gif'))
    if not names:
        print('no GIFs found in art/')
        return
    sheets = load_sheets()
    for name in names:
        frames, durs, loop = gif_frames(os.path.join(ART, name))
        out = name[:-4] + '.png'
        w, h = frames[0].size
        if len(frames) == 1:
            frames[0].save(os.path.join(IMAGES, out), optimize=True)
            sheets.pop(out, None)
            print('%-36s static %dx%d' % (out, w, h))
            continue
        strip = Image.new('RGBA', (w * len(frames), h), (0, 0, 0, 0))
        for i, frame in enumerate(frames):
            strip.paste(frame, (i * w, 0))
        strip.save(os.path.join(IMAGES, out), optimize=True)
        dur = max(10, int(round(sum(durs) / len(durs) / 10.0) * 10))
        sheets[out] = {'file': out, 'frames': len(frames), 'dur': dur, 'loop': loop}
        print('%-36s %d frames, %dms/frame, %s' %
              (out, len(frames), dur, 'loop' if loop else 'once'))
        if (w, h) != STAGE_SIZE:
            print('  WARNING: %s frames are %dx%d — stage clips must be 800x600' % (name, w, h))
    save_sheets(sheets)
    print('updated images/sheets.js (%d entries)' % len(sheets))


def to_gif_frame(rgba):
    alpha = rgba.split()[3]
    p = rgba.convert('RGB').convert('P', palette=Image.ADAPTIVE, colors=255)
    p.paste(255, alpha.point(lambda a: 255 if a <= 128 else 0))
    return p


def from_pngs():
    os.makedirs(ART, exist_ok=True)
    sheets = load_sheets()
    for name, meta in sorted(sheets.items()):
        strip = Image.open(os.path.join(IMAGES, meta['file'])).convert('RGBA')
        n = meta['frames']
        w, h = strip.size[0] // n, strip.size[1]
        frames = [to_gif_frame(strip.crop((i * w, 0, (i + 1) * w, h))) for i in range(n)]
        out = os.path.join(ART, name[:-4] + '.gif')
        kwargs = dict(save_all=True, append_images=frames[1:], duration=meta['dur'],
                      transparency=255, disposal=2, optimize=False)
        if meta.get('loop'):
            kwargs['loop'] = 0  # forever
        frames[0].save(out, **kwargs)
        print('%-36s -> art/%s (%d frames, %dms, %s)' %
              (name, os.path.basename(out), n, meta['dur'],
               'loop' if meta.get('loop') else 'once'))
    print('regenerated %d GIFs in art/' % len(sheets))


if __name__ == '__main__':
    if '--from-pngs' in sys.argv:
        from_pngs()
    else:
        build()
