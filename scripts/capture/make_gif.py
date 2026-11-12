"""Turns a recorded folder of frames into a small, smooth GIF.

usage: python make_gif.py out/switch ../../docs/media/switch-accounts.gif [target_width]

One palette is built from the whole clip, so colors never flicker between frames. Frames that look the same
as the one before are merged (their delays added), which keeps the file small without losing smoothness.
"""
import json
import os
import sys

from PIL import Image, ImageChops

src, dest = sys.argv[1], sys.argv[2]
target_w = int(sys.argv[3]) if len(sys.argv) > 3 else 0
meta = json.load(open(os.path.join(src, 'meta.json')))
crop, dpr = meta['crop'], meta['dpr']
box = tuple(int(round(v * dpr)) for v in (crop['x'], crop['y'], crop['x'] + crop['width'], crop['y'] + crop['height']))

names = sorted(f for f in os.listdir(src) if f.endswith('.jpg'))
frames, delays = [], []
for name, delay in zip(names, meta['delays']):
    im = Image.open(os.path.join(src, name)).convert('RGB').crop(box)
    if target_w and im.width != target_w:
        im = im.resize((target_w, round(im.height * target_w / im.width)), Image.LANCZOS)
    frames.append(im)
    delays.append(max(delay, 10))

# Merge near-identical neighbours.
merged, mdelays = [frames[0]], [delays[0]]
for im, d in zip(frames[1:], delays[1:]):
    diff = ImageChops.difference(im, merged[-1]).convert('L').point(lambda v: 255 if v > 14 else 0)
    if diff.getbbox() is None:
        mdelays[-1] += d
    else:
        merged.append(im)
        mdelays.append(d)

# One palette for the clip (sampled), no dithering.
step = max(1, len(merged) // 14)
sample = merged[::step][:14]
sheet = Image.new('RGB', (sample[0].width, sample[0].height * len(sample)))
for i, im in enumerate(sample):
    sheet.paste(im, (0, i * im.height))
pal = sheet.quantize(colors=int(os.environ.get('GIF_COLORS', '80')), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
out = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in merged]

# GIF delays are in 1/100 s; round to that and keep the clip's real length.
mdelays = [max(2, round(d / 10)) * 10 for d in mdelays]
os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
out[0].save(dest, save_all=True, append_images=out[1:], duration=mdelays, loop=0, optimize=False, disposal=1)
print(f'{dest}: {len(names)} frames -> {len(out)}, {os.path.getsize(dest) / 1e6:.1f} MB, {sum(mdelays) / 1000:.1f}s, {out[0].size}')
