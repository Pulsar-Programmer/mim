#!/usr/bin/env python3
"""Copies the site's grass and bedrock strips from a local Minecraft jar, opened read-only.
Usage: python3 scripts/extract_mc_assets.py [path/to/version.jar]"""
import io, sys, zipfile
from pathlib import Path
from PIL import Image, ImageChops

JAR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Library/Application Support/minecraft/versions/1.21.5/1.21.5.jar"
OUT = Path(__file__).parent.parent / "web/public/img/mc"

with zipfile.ZipFile(JAR) as jar:
    tex = lambda n: Image.open(io.BytesIO(jar.read(f"assets/minecraft/textures/block/{n}.png"))).convert("RGBA")
    OUT.mkdir(parents=True, exist_ok=True)
    side = tex("grass_block_side")
    overlay = tex("grass_block_side_overlay")
    side.alpha_composite(ImageChops.multiply(overlay, Image.new("RGBA", overlay.size, (124, 189, 107, 255))))
    side.save(OUT / "ground.png", optimize=True)
    tex("bedrock").save(OUT / "bedrock.png", optimize=True)
