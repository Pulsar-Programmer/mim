#!/usr/bin/env python3
"""Builds the site's grass block and its grass and bedrock strips from a local Minecraft jar, opened read-only.
Usage: python3 scripts/extract_mc_assets.py [path/to/version.jar]"""
import io, sys, zipfile
from pathlib import Path
from PIL import Image, ImageChops
from draw_blocks import cube

JAR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Library/Application Support/minecraft/versions/1.21.5/1.21.5.jar"
OUT = Path(__file__).parent.parent / "web/public/img/mc"

with zipfile.ZipFile(JAR) as jar:
    tex = lambda n: Image.open(io.BytesIO(jar.read(f"assets/minecraft/textures/block/{n}.png"))).convert("RGBA")
    OUT.mkdir(parents=True, exist_ok=True)
    tint = lambda im, color: ImageChops.multiply(im, Image.new("RGBA", im.size, color))
    def grass_side(color):
        side = tex("grass_block_side")
        side.alpha_composite(tint(tex("grass_block_side_overlay"), color))
        return side
    grass_side((124, 189, 107, 255)).save(OUT / "ground.png", optimize=True)
    PLAINS = (145, 189, 89, 255)  # the game's default grass color
    side = grass_side(PLAINS)
    cube(tint(tex("grass_block_top"), PLAINS), side, side).save(OUT / "grass-block.png", optimize=True)
    tex("bedrock").save(OUT / "bedrock.png", optimize=True)
