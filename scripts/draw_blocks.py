#!/usr/bin/env python3
"""Draws the site's original isometric grass block and chest into web/public/img/icons."""
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance

OUT = Path(__file__).parent.parent / "web/public/img/icons"
H = 128
L = H / 2                 # true isometric: every cube edge has the same length
HALF = L * 3 ** .5 / 2
CX = H / 2
TOP, RIGHT, BOTTOM, LEFT = (CX, 0), (CX + HALF, L / 2), (CX, L), (CX - HALF, L / 2)
INK = {"k": "#21182b", "g": "#7ccb57", "G": "#4f8f3a", "h": "#9be070", "d": "#9a6742", "D": "#6f4a30", "e": "#b98258",
       "t": "#c28e58", "T": "#855b36", "u": "#dcae76", "s": "#c3c1cc", "S": "#7d7b88", "y": "#ffe29a", "Y": "#f5b94d"}


def tex(rows):
    im = Image.new("RGBA", (16, 16))
    for y, row in enumerate(rows):
        for x, c in enumerate(row):
            im.putpixel((x, y), Image.new("RGB", (1, 1), INK[c]).getpixel((0, 0)) + (255,))
    return im


def face(t, shade, a, b, c):
    """Maps t onto the parallelogram with corners a (top-left), b (top-right), c (bottom-left)."""
    det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
    ux, uy = 16 * (c[1] - a[1]) / det, -16 * (c[0] - a[0]) / det
    vx, vy = -16 * (b[1] - a[1]) / det, 16 * (b[0] - a[0]) / det
    # a one-pixel repeated edge keeps nearest-neighbor sampling from leaving seams
    pad = t.resize((18, 18), Image.NEAREST)
    pad.paste(t, (1, 1))
    out = pad.transform((H, H), Image.AFFINE, (ux, uy, 1 - ux * a[0] - uy * a[1], vx, vy, 1 - vx * a[0] - vy * a[1]), Image.NEAREST)
    mask = Image.new("L", (H, H))
    ImageDraw.Draw(mask).polygon([a, b, (b[0] + c[0] - a[0], b[1] + c[1] - a[1]), c], fill=255)
    lit = ImageEnhance.Brightness(out.convert("RGB")).enhance(shade)
    lit.putalpha(mask)
    return lit


def cube(top, left, right):
    im = Image.new("RGBA", (H, H))
    im.alpha_composite(face(top, 1, TOP, RIGHT, LEFT))
    im.alpha_composite(face(left, .8, LEFT, BOTTOM, (LEFT[0], LEFT[1] + L)))
    im.alpha_composite(face(right, .62, BOTTOM, RIGHT, (CX, H)))
    return im


def noise(seed, weights, frame=lambda x, y: None):
    r = random.Random(seed)
    return ["".join(frame(x, y) or r.choices(*zip(*weights))[0] for x in range(16)) for y in range(16)]


def grass_side(seed):
    r = random.Random(seed)
    drip = [r.choice((2, 3, 3, 4, 5)) for _ in range(16)]
    dirt = noise(seed + 1, [("d", 6), ("D", 3), ("e", 2)])
    return ["".join((r.choice("gGgh") if y < drip[x] else dirt[y][x]) for x in range(16)) for y in range(16)]


def chest_face(front):
    def frame(x, y):
        if x in (0, 15) or y in (0, 15): return "k"
        if y == 6: return "k"
        if y in (5, 7): return "T"
        if front and 6 <= x <= 9 and 4 <= y <= 9:
            return "k" if x in (6, 9) or y in (4, 9) else "y" if y < 7 else "Y"
        if x in (1, 14): return "T"
        if y % 4 == 3: return "T"
    return noise(11 + front, [("t", 7), ("u", 2), ("T", 1)], frame)


def chest_top():
    def frame(x, y):
        if x in (0, 15) or y in (0, 15): return "k"
        if x in (1, 14) or y in (1, 14): return "T"
        if y % 4 == 3: return "T"
    return noise(13, [("t", 7), ("u", 3)], frame)


OUT.mkdir(parents=True, exist_ok=True)
cube(tex(noise(3, [("g", 7), ("G", 3), ("h", 2)])), tex(grass_side(5)), tex(grass_side(8))).save(OUT / "grass.png", optimize=True)
cube(tex(chest_top()), tex(chest_face(0)), tex(chest_face(1))).save(OUT / "chest.png", optimize=True)
