#!/usr/bin/env python3
"""Builds web/public/img/mc from a local Minecraft jar. Opens the jar read-only.
Usage: python3 scripts/extract_mc_assets.py [path/to/version.jar]"""
import io, sys, zipfile
from pathlib import Path
from PIL import Image, ImageChops, ImageEnhance

JAR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Library/Application Support/minecraft/versions/1.21.5/1.21.5.jar"
OUT = Path(__file__).parent.parent / "web/public/img/mc"
GRASS = (124, 189, 107, 255)
N = 128  # isometric block canvas

ITEMS = {"pickaxe": "item/iron_pickaxe", "sword": "item/diamond_sword", "chain": "item/chain", "apple": "item/apple",
         "book": "item/book", "map": "item/map", "compass": "item/compass_16", "painting": "item/painting",
         "lantern": "item/lantern", "xp": "item/experience_bottle", "pane": "block/glass"}
BLOCKS = {"wool": ("white_wool",) * 3, "crafting": ("crafting_table_top", "crafting_table_front", "crafting_table_side"),
          "furnace": ("furnace_top", "furnace_side", "furnace_front"),
          "blast": ("blast_furnace_top", "blast_furnace_side", "blast_furnace_front")}
PENGUIN = ["................", ".....kkkkkk.....", "....kkkkkkkk....", "...kkwkkkkwkk...", "...kkkkYYkkkk...", "...kkkYYYYkkk...", "..kkkwwwwwwkkk..", ".kkkwwwwwwwwkkk.", ".kk.kwwwwwwk.kk.", ".k..kwwwwwwk..k.", "....kwwwwwwk....", "....kkwwwwkk....", "...YYYkkkkYYY...", "..YYYY....YYYY..", "................", "................"]


def face(tex, shade, a, b, c):
    """Maps tex onto the parallelogram with corners a (u0,v0), b (u1,v0), c (u0,v1)."""
    w, h = tex.size
    det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
    ux, uy = w * (c[1] - a[1]) / det, -w * (c[0] - a[0]) / det
    vx, vy = -h * (b[1] - a[1]) / det, h * (b[0] - a[0]) / det
    m = (ux, uy, -ux * a[0] - uy * a[1], vx, vy, -vx * a[0] - vy * a[1])
    # ponytail: a repeated edge hides nearest-neighbor seams between faces
    padded = Image.new("RGBA", (w + 2, h + 2))
    padded.paste(tex.resize((w + 2, h + 2), Image.NEAREST))
    padded.paste(tex, (1, 1))
    m = (m[0], m[1], m[2] + 1, m[3], m[4], m[5] + 1)
    out = padded.transform((N, N), Image.AFFINE, m, Image.NEAREST)
    mask = Image.new("L", (N, N))
    from PIL import ImageDraw
    d = (b[0] + c[0] - a[0], b[1] + c[1] - a[1])
    ImageDraw.Draw(mask).polygon([a, b, d, c], fill=255)
    out.putalpha(ImageChops.multiply(mask, out.getchannel("A")))
    rgb = ImageEnhance.Brightness(out.convert("RGB")).enhance(shade)
    rgb.putalpha(out.getchannel("A"))
    return rgb


def iso(top, left, right):
    im = Image.new("RGBA", (N, N))
    for layer in (face(top, 1, (64, 0), (127, 32), (0, 32)), face(left, .78, (0, 32), (64, 64), (0, 96)), face(right, .6, (64, 64), (127, 32), (64, 127))):
        im.alpha_composite(layer)
    return im


def tint(im, color):
    return ImageChops.multiply(im, Image.new("RGBA", im.size, color))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(JAR) as jar:
        def tex(name):
            im = Image.open(io.BytesIO(jar.read(f"assets/minecraft/textures/{name}.png"))).convert("RGBA")
            return im.crop((0, 0, im.width, im.width))  # animated textures stack frames vertically

        for name, path in ITEMS.items():
            tex(path).save(OUT / f"{name}.png", optimize=True)
        for name, (t, l, r) in BLOCKS.items():
            iso(tex(f"block/{t}"), tex(f"block/{l}"), tex(f"block/{r}")).save(OUT / f"{name}.png", optimize=True)

        side = tex("block/grass_block_side")
        side.alpha_composite(tint(tex("block/grass_block_side_overlay"), GRASS))
        side.save(OUT / "ground.png", optimize=True)
        iso(tint(tex("block/grass_block_top"), GRASS), side, side).save(OUT / "grass.png", optimize=True)
        tex("block/bedrock").save(OUT / "bedrock.png", optimize=True)

        c = Image.open(io.BytesIO(jar.read("assets/minecraft/textures/entity/chest/normal.png"))).convert("RGBA")
        def stack(x):
            f = Image.new("RGBA", (14, 15))
            f.paste(c.crop((x, 14, x + 14, 19)), (0, 0))
            f.paste(c.crop((x, 33, x + 14, 43)), (0, 5))
            return f
        front = stack(14)
        front.alpha_composite(c.crop((1, 1, 3, 5)), (6, 3))
        iso(c.crop((14, 0, 28, 14)), stack(0), front).save(OUT / "chest.png", optimize=True)

    ink = {"k": (33, 24, 43, 255), "w": (255, 243, 220, 255), "Y": (245, 185, 77, 255)}
    p = Image.new("RGBA", (16, 16))
    for y, row in enumerate(PENGUIN):
        for x, ch in enumerate(row):
            if ch in ink:
                p.putpixel((x, y), ink[ch])
    p.save(OUT / "penguin.png", optimize=True)
    print(f"wrote {len(list(OUT.glob('*.png')))} images from {JAR.name}")


main()
