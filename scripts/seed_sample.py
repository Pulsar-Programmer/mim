#!/usr/bin/env python3
"""Builds a fake minecraft folder at ./sample-minecraft for trying MIM safely.

    python3 scripts/seed_sample.py        # (re)creates sample-minecraft/
    bun run dev:sample                    # seeds, then runs the app against it

Everything here is generated — no real launcher data, worlds, or accounts.
"""
import gzip
import json
import os
import random
import shutil
import struct
import time
import zipfile
import zlib
import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "sample-minecraft"
NOW = time.time()
DAY = 86400
rng = random.Random(7)  # deterministic sample


def write(rel, data=b"", age_days=0.0):
    p = ROOT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data if isinstance(data, bytes) else data.encode())
    t = NOW - age_days * DAY
    os.utime(p, (t, t))
    return p


def blob(kb):
    return rng.randbytes(kb * 1024)


# ---- NBT (big-endian, gzipped) for level.dat -------------------------------

def _s(t):
    b = t.encode()
    return struct.pack(">H", len(b)) + b


def nbt(name, value):
    """value: str -> string, int -> int, ("long", n), ("byte", n), dict -> compound"""
    if isinstance(value, dict):
        body = b"".join(nbt(k, v) for k, v in value.items()) + b"\x00"
        return b"\x0a" + _s(name) + body
    if isinstance(value, str):
        return b"\x08" + _s(name) + _s(value)
    if isinstance(value, tuple) and value[0] == "long":
        return b"\x04" + _s(name) + struct.pack(">q", value[1])
    if isinstance(value, tuple) and value[0] == "byte":
        return b"\x01" + _s(name) + struct.pack(">b", value[1])
    return b"\x03" + _s(name) + struct.pack(">i", value)


def servers_dat(servers):
    """servers: [(name, ip, icon_png_bytes|None)] -> uncompressed servers.dat"""
    body = b"\x0a" + _s("") + b"\x09" + _s("servers") + b"\x0a" + struct.pack(">i", len(servers))
    for name, ip, icon in servers:
        body += b"\x08" + _s("name") + _s(name) + b"\x08" + _s("ip") + _s(ip)
        if icon:
            body += b"\x08" + _s("icon") + _s(base64.b64encode(icon).decode())
        body += b"\x00"
    return body + b"\x00"


def mod_jar(rel, meta, icon=None, toml=None, age=5):
    p = ROOT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        if toml:
            z.writestr("META-INF/mods.toml", toml)
        else:
            z.writestr("fabric.mod.json", json.dumps(meta))
        if icon:
            z.writestr(meta.get("icon", "icon.png") if meta else "logo.png", icon)
        z.writestr("filler.bin", rng.randbytes(60 * 1024))
    t = NOW - age * DAY
    os.utime(p, (t, t))


def fabric_mod(mod_id, name, version, desc, authors, colors):
    return (
        {
            "schemaVersion": 1,
            "id": mod_id,
            "name": name,
            "version": version,
            "description": desc,
            "authors": authors,
            "icon": f"assets/{mod_id}/icon.png",
        },
        png(64, 64, *colors),
    )


def level_dat(name, version, mode, days_ago, seed, hardcore=False, cheats=False):
    data = {
        "LevelName": name,
        "LastPlayed": ("long", int((NOW - days_ago * DAY) * 1000)),
        "GameType": mode,
        "hardcore": ("byte", int(hardcore)),
        "allowCommands": ("byte", int(cheats)),
        "DataVersion": 4556,
        "Version": {"Name": version, "Id": 4556, "Snapshot": ("byte", 0)},
        "WorldGenSettings": {"seed": ("long", seed)},
    }
    return gzip.compress(nbt("", {"Data": data}))


# ---- tiny PNG for world icons / screenshots --------------------------------

def png(w, h, top, bottom):
    rows = b""
    for y in range(h):
        f = y / (h - 1)
        px = bytes(int(top[i] + (bottom[i] - top[i]) * f) for i in range(3))
        rows += b"\x00" + px * w

    def chunk(kind, data):
        c = kind + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def scene(w, h, sky, horizon, ground, seed):
    """A blocky little landscape: sky, sun, hills, water — so the gallery has something to show."""
    import math
    r = random.Random(seed)
    block = max(4, w // 60)
    phase = [r.uniform(0, 6.3) for _ in range(3)]
    sun = (r.uniform(0.2, 0.8) * w, r.uniform(0.12, 0.35) * h, h * 0.07)
    sea = int(h * 0.72)
    cols = []
    for bx in range(0, w, block):
        f = bx / w
        y = h * (0.58 + 0.10 * math.sin(f * 5 + phase[0]) + 0.06 * math.sin(f * 13 + phase[1])
                 + 0.03 * math.sin(f * 29 + phase[2]))
        cols.append(int(y) // block * block)
    lerp = lambda a, b, t: tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        sky_px = lerp(sky, horizon, min(1, y / (h * 0.65)))
        for x in range(w):
            top = cols[x // block]
            if y >= top:
                d = (y - top) // block
                px = ground if d == 0 else lerp(ground, (90, 64, 44), min(1, 0.5 + d * 0.12))
                if (x // block + y // block) % 7 == 0:
                    px = lerp(px, (0, 0, 0), 0.12)
            elif y >= sea:
                px = lerp((60, 110, 190), sky_px, 0.35 if (y // 3) % 4 else 0.6)
            elif (x - sun[0]) ** 2 + (y - sun[1]) ** 2 < sun[2] ** 2:
                px = (255, 244, 214)
            else:
                px = sky_px
            rows += bytes(px)

    def chunk(kind, data):
        c = kind + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(rows))) + chunk(b"IEND", b""))


# ---- options.txt -----------------------------------------------------------

BASE_OPTIONS = {
    "version": "4556",
    "autoJump": "false",
    "enableVsync": "true",
    "entityShadows": "true",
    "fullscreen": "false",
    "fov": "0.0",
    "gamma": "0.5",
    "graphicsMode": "1",
    "guiScale": "2",
    "maxFps": "120",
    "renderDistance": "12",
    "simulationDistance": "10",
    "particles": "0",
    "renderClouds": '"true"',
    "ao": "true",
    "bobView": "true",
    "biomeBlendRadius": "2",
    "mipmapLevels": "4",
    "entityDistanceScaling": "1.0",
    "mouseSensitivity": "0.5",
    "invertYMouse": "false",
    "rawMouseInput": "true",
    "toggleCrouch": "false",
    "toggleSprint": "false",
    "chatVisibility": "0",
    "chatOpacity": "1.0",
    "chatScale": "1.0",
    "chatColors": "true",
    "narrator": "0",
    "lang": "en_us",
    "resourcePacks": '["vanilla","file/Faithful 32x.zip"]',
    "incompatibleResourcePacks": "[]",
    "key_key.attack": "key.mouse.left",
    "key_key.use": "key.mouse.right",
    "key_key.forward": "key.keyboard.w",
    "key_key.left": "key.keyboard.a",
    "key_key.back": "key.keyboard.s",
    "key_key.right": "key.keyboard.d",
    "key_key.jump": "key.keyboard.space",
    "key_key.sneak": "key.keyboard.left.shift",
    "key_key.sprint": "key.keyboard.left.control",
    "key_key.drop": "key.keyboard.q",
    "key_key.inventory": "key.keyboard.e",
    "key_key.chat": "key.keyboard.t",
    "key_key.playerlist": "key.keyboard.tab",
    "key_key.command": "key.keyboard.slash",
    "key_key.screenshot": "key.keyboard.f2",
    "key_key.togglePerspective": "key.keyboard.f5",
    "key_key.hotbar.1": "key.keyboard.1",
    "key_key.hotbar.2": "key.keyboard.2",
    "key_key.hotbar.3": "key.keyboard.3",
    "soundCategory_master": "1.0",
    "soundCategory_music": "0.35",
    "soundCategory_record": "1.0",
    "soundCategory_weather": "1.0",
    "soundCategory_block": "1.0",
    "soundCategory_hostile": "1.0",
    "soundCategory_neutral": "1.0",
    "soundCategory_player": "1.0",
    "soundCategory_ambient": "1.0",
    "soundCategory_voice": "1.0",
    "modelPart_cape": "true",
    "modelPart_jacket": "true",
    "modelPart_left_sleeve": "true",
    "modelPart_right_sleeve": "true",
    "modelPart_hat": "true",
    "mainHand": '"right"',
}


def options(**changes):
    o = dict(BASE_OPTIONS)
    o.update(changes)
    return "".join(f"{k}:{v}\n" for k, v in o.items())


# ---- logs ------------------------------------------------------------------

def game_log(days_ago, version):
    t = time.strftime("%H:%M:%S", time.localtime(NOW - days_ago * DAY))
    lines = [
        f"[{t}] [main/INFO]: Loading Minecraft {version} with Fabric Loader 0.17.2",
        f"[{t}] [Render thread/INFO]: Setting user: SamplePlayer",
        f"[{t}] [Render thread/INFO]: Backend library: LWJGL version 3.3.3",
        f"[{t}] [Render thread/INFO]: Reloading ResourceManager: vanilla, fabric, file/Faithful 32x.zip",
        f"[{t}] [Render thread/WARN]: Missing sound for event: minecraft:item.goat_horn.play",
        f"[{t}] [Server thread/INFO]: Preparing spawn area: 84%",
        f"[{t}] [Render thread/INFO]: [CHAT] Welcome back!",
        f"[{t}] [Render thread/INFO]: Stopping!",
    ]
    return "\n".join(lines * 20) + "\n"


def seed():
    if ROOT.exists():
        assert ROOT.name == "sample-minecraft"
        shutil.rmtree(ROOT)

    # options: base game vs per-installation
    write("options.txt", options(), 1)
    write("optionsof.txt", "ofFogType:1\nofSmoothFps:false\n", 30)
    write(
        "servers.dat",
        servers_dat(
            [
                ("Hypixel", "mc.hypixel.net", png(64, 64, (250, 200, 60), (200, 120, 20))),
                ("CubeCraft", "play.cubecraft.net", png(64, 64, (80, 160, 240), (30, 70, 160))),
                ("Friends SMP", "smp.example.org:25566", None),
                ("Local test", "localhost", None),
            ]
        ),
        3,
    )
    write(
        "servers.dat_old",
        servers_dat(
            [
                ("Hypixel", "mc.hypixel.net", None),
                ("Old Realm Server", "old.example.net", None),
                ("Local test", "localhost", None),
            ]
        ),
        9,
    )
    write("hotbar.nbt", b"\x0a\x00\x00\x00", 40)
    write("command_history.txt", "/gamemode creative\n/time set day\n", 2)

    # launcher bits (fake)
    write("launcher_settings.json", json.dumps({"locale": "en-us"}), 1)
    write("launcher_accounts.json", json.dumps({"accounts": {}}), 1)
    write("launcher_ui_state.json", "{}", 1)
    write("clientId_v2.txt", "sample-client-id", 90)
    write("treatment_tags.json", "{}", 10)
    write("launcher/launcher.bundle", blob(300), 20)

    # stray logs at the root (what Sort Logs tidies)
    write("launcher_log.txt", "[launcher] started\n" * 400, 0.2)
    write("launcher_log1.txt", "[launcher] started\n" * 300, 3)
    write("launcher_log2.txt", "[launcher] started\n" * 300, 6)
    write("launcher_cef_log.txt", "[cef] gpu process launched\n" * 200, 0.2)
    write("nativeUpdaterLog.txt", "[updater] up to date\n" * 50, 0.2)
    write("nativeUpdaterLog3.txt", "[updater] downloading patch\n" * 50, 12)
    write(
        "hs_err_pid48213.log",
        "# A fatal error has been detected by the Java Runtime Environment:\n"
        "#  SIGSEGV (0xb) at pc=0x000000018d2c1f40, pid=48213\n" * 20,
        9,
    )

    # logs/, crash-reports/, debug/
    write("logs/latest.log", game_log(0.1, "1.21.10"), 0.1)
    for i, d in enumerate([0.1, 1, 1, 2, 4, 5, 9, 14, 21, 33]):
        day = time.strftime("%Y-%m-%d", time.localtime(NOW - d * DAY))
        write(f"logs/{day}-{i % 3 + 1}.log.gz", gzip.compress(game_log(d, "1.21.10").encode()), d)
    write("logs/debug.log", game_log(0.1, "1.21.10"), 0.1)
    write(
        "crash-reports/crash-sample-client.txt",
        "---- Minecraft Crash Report ----\n// Shall we play a game?\n\n"
        "Description: Rendering overlay\n\njava.lang.NullPointerException\n",
        9,
    )
    write("debug/disconnect-sample-client.txt", "Disconnected: Timed out\n", 16)

    # caches
    for i in range(6):
        write(f"webcache2/Default/Cache/f_{i:06x}", blob(rng.randint(40, 300)), 2)
    write("downloads/log.json", "{}", 5)
    for i in range(3):
        write(f"downloads/{rng.randbytes(16).hex()}/pack.zip", blob(500), 5)
    write("server-resource-packs/8f3a91c2", blob(900), 6)
    write(".fabric/remappedJars/minecraft-1.21.10/client-intermediary.jar", blob(1200), 1)
    write("updateSourceCache.json", "{}", 1)
    write("usercache.json", json.dumps([{"name": "SamplePlayer"}]), 1)

    # game files
    write("assets/indexes/27.json", "{}", 30)
    for i in range(8):
        write(f"assets/objects/{i:02x}/{rng.randbytes(20).hex()}", blob(400), 30)
    write("libraries/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar", blob(700), 30)
    write("versions/1.21.10/1.21.10.jar", blob(2500), 30)
    write("versions/1.21.10/1.21.10.json", "{}", 30)
    write("versions/fabric-loader-0.17.2-1.21.10/fabric-loader-0.17.2-1.21.10.json", "{}", 30)
    write("runtime/java-runtime-delta/mac-os-arm64/jre.bundle", blob(1500), 60)

    # your stuff
    def pack_zip(rel, fmt, desc, colors, age):
        p = ROOT / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("pack.mcmeta", json.dumps({"pack": {"pack_format": fmt, "description": desc}}))
            z.writestr("pack.png", png(64, 64, *colors))
            z.writestr("assets/minecraft/textures/filler.bin", rng.randbytes(300 * 1024))
        os.utime(p, (NOW - age * DAY, NOW - age * DAY))

    pack_zip("resourcepacks/Faithful 32x.zip", 64, "§7The classic look, doubled.",
             ((120, 170, 90), (70, 110, 50)), 50)
    pack_zip("resourcepacks/Fresh Animations.zip", 64, {"text": "Brings mobs to life"},
             ((230, 160, 90), (150, 80, 40)), 12)
    pack_zip("resourcepacks/Low Fire.zip", 34, "Fire doesn't cover half the screen",
             ((250, 120, 40), (120, 30, 10)), 80)
    write("resourcepacks/My Tweaks/pack.mcmeta",
          '{"pack":{"pack_format":46,"description":"My own little fixes"}}', 20)
    write("resourcepacks/My Tweaks/pack.png", png(64, 64, (150, 110, 200), (70, 40, 120)), 20)
    write("shaderpacks/Complementary Reimagined.zip", blob(600), 40)
    shots = [  # sky, horizon, ground, size
        ((110, 165, 235), (235, 225, 200), (95, 160, 70), (480, 270)),
        ((40, 60, 110), (240, 140, 90), (70, 110, 60), (480, 270)),
        ((15, 15, 45), (110, 60, 140), (40, 60, 70), (560, 240)),
        ((150, 200, 240), (250, 250, 240), (235, 240, 245), (480, 270)),
        ((250, 190, 120), (250, 120, 80), (200, 170, 110), (400, 300)),
        ((30, 45, 60), (110, 150, 140), (60, 90, 60), (480, 300)),
        ((120, 190, 250), (200, 235, 255), (110, 180, 80), (480, 270)),
        ((70, 30, 30), (220, 90, 40), (90, 40, 40), (480, 270)),
        ((90, 140, 200), (240, 210, 170), (130, 160, 80), (270, 400)),
        ((20, 30, 60), (60, 90, 150), (50, 70, 90), (480, 270)),
    ]
    for i, (a, b, g, (w, h)) in enumerate(shots):
        write(f"screenshots/2026-{10 + i % 2}-{10 + i:02d}_18.22.0{i}.png",
              scene(w, h, a, b, g, i), 4 + i * 9)
    write("config/fabric/indigo-renderer.properties", "ambient-occlusion-mode=hybrid\n", 20)

    # worlds in the shared saves folder
    worlds = [
        ("New World", "Survival Base", "1.21.10", 0, 0.1, 8231987234123, False, False,
         ((90, 160, 80), (40, 90, 50)), 2400),
        ("Creative Flat", "Build Plot", "1.21.10", 1, 4, -1234567890123456789, False, True,
         ((140, 200, 240), (220, 230, 240)), 600),
        ("Hardcore Run", "HARDCORE ATTEMPT 3", "1.21.4", 0, 26, 42, True, False,
         ((120, 20, 20), (40, 10, 10)), 1500),
    ]
    for folder, name, ver, mode, days, seed_, hc, cheats, colors, kb in worlds:
        w = f"saves/{folder}"
        write(f"{w}/level.dat", level_dat(name, ver, mode, days, seed_, hc, cheats), days)
        write(f"{w}/icon.png", png(64, 64, *colors), days)
        write(f"{w}/region/r.0.0.mca", blob(kb), days)
        write(f"{w}/region/r.-1.0.mca", blob(kb // 2), days)
        write(f"{w}/DIM-1/region/r.0.0.mca", blob(kb // 4), days)
        write(f"{w}/playerdata/{rng.randbytes(16).hex()}.dat", blob(4), days)
        write(f"{w}/advancements/sample.json", "{}", days)
        write(f"{w}/stats/sample.json", "{}", days)
        write(f"{w}/session.lock", "", days)
    write("saves/Creative Flat/datapacks/terralith.zip", blob(200), 4)
    write("saves/Creative Flat/datapacks/vanilla-tweaks", b"", 4)

    # installations
    inst = ROOT / "installations"
    profiles = {}

    def install(name, version, loader, days, opts=None, own_saves=False, mods=(),
                own_screenshots=False):
        d = inst / name
        d.mkdir(parents=True, exist_ok=True)
        shared = ["resourcepacks"]
        if not own_saves:
            shared.append("saves")
        if not own_screenshots:
            shared.append("screenshots")
        for sh in shared:
            os.symlink(ROOT / sh, d / sh)
        if opts is not None:
            write(f"installations/{name}/options.txt", opts, days)
        for m in mods:
            if isinstance(m, tuple):
                file, meta, icon, toml = m
                mod_jar(f"installations/{name}/mods/{file}", meta, icon, toml, days)
            else:
                write(f"installations/{name}/mods/{m}", blob(150), days)
        write(f"installations/{name}/logs/latest.log", game_log(days, version), days)
        vid = f"fabric-loader-0.17.2-{version}" if loader == "fabric" else version
        profiles[rng.randbytes(16).hex()] = {
            "created": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(NOW - 60 * DAY)),
            "gameDir": str(d),
            "icon": "Grass",
            "lastUsed": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(NOW - days * DAY)),
            "lastVersionId": vid,
            "name": name,
            "type": "custom",
        }
        return d

    install(
        "Hypixel 1.21.10", "1.21.10", "fabric", 0.1,
        options(fov="0.25", renderDistance="8", maxFps="260", guiScale="3",
                resourcePacks='["vanilla","fabric","file/Low Fire.zip","file/Faithful 32x.zip"]',
                **{"key_key.sprint": "key.keyboard.r", "soundCategory_music": "0.0"}),
        mods=(
            ("sodium-fabric-0.6.0.jar",
             *fabric_mod("sodium", "Sodium", "0.6.0+mc1.21.10",
                         "A modern rendering engine for Minecraft which greatly improves performance.",
                         ["JellySquid", "IMS"], ((60, 190, 120), (20, 90, 60))), None),
            ("lithium-fabric-0.15.0.jar",
             *fabric_mod("lithium", "Lithium", "0.15.0",
                         "No-compromises game logic optimization mod.",
                         ["2No2Name", {"name": "JellySquid"}], ((240, 210, 90), (180, 140, 30))), None),
            ("modmenu-12.0.0.jar",
             *fabric_mod("modmenu", "Mod Menu", "12.0.0",
                         "Adds a mod menu to view the list of mods you have installed.",
                         ["Prospector"], ((140, 140, 160), (60, 60, 80))), None),
            ("fabric-api-0.130.0.jar",
             {**fabric_mod("fabric-api", "Fabric API", "0.130.0+1.21.10",
                           "Lightweight and modular API providing common hooks.",
                           ["FabricMC"], ((220, 200, 160), (150, 120, 80)))[0],
              "custom": {"modmenu": {"badges": ["library"]}}},
             png(64, 64, (220, 200, 160), (150, 120, 80)), None),
            ("zoomify-2.14.jar.disabled",
             *fabric_mod("zoomify", "Zoomify", "2.14.0",
                         "A zoom mod with infinite customizability.",
                         ["isXander"], ((90, 120, 230), (40, 50, 140))), None),
        ),
    )
    write("installations/Hypixel 1.21.10/servers.dat",
          servers_dat([("Hypixel", "mc.hypixel.net", png(64, 64, (250, 200, 60), (200, 120, 20)))]), 0.1)
    write("installations/Hypixel 1.21.10/logs/2026-11-19-1.log.gz",
          gzip.compress(game_log(2, "1.21.10").encode()), 2)
    write("installations/Hypixel 1.21.10/hs_err_pid51234.log",
          "# A fatal error has been detected by the Java Runtime Environment:\n" * 10, 2)
    h = "installations/Hypixel 1.21.10"
    write(f"{h}/config/sodium-options.json",
          json.dumps({"quality": {"weather_quality": "FAST"}, "performance": {"chunk_builder_threads": 0}}, indent=2), 1)
    write(f"{h}/config/sodium-mixins.properties", "# overrides\n", 1)
    write(f"{h}/config/modmenu.json", json.dumps({"sorting": "ascending", "count_libraries": True}, indent=2), 4)
    write(f"{h}/config/zoomify.json", json.dumps({"initialZoom": 4}, indent=2), 9)
    write(f"{h}/config/fabric/indigo-renderer.properties", "ambient-occlusion-mode=hybrid\n", 20)
    write(f"{h}/config/old-hud-mod.toml", "[hud]\nenabled = true\n", 70)
    write(f"{h}/journeymap/data/mp/Hypixel/waypoints/home.json", '{"name":"Home"}', 2)
    write(f"{h}/XaeroWaypoints/Multiplayer_mc.hypixel.net/waypoints.txt", "waypoint:Lobby:L:0:64:0\n", 2)
    survival = install("Survival 1.21.4", "1.21.4", "vanilla", 26, None, own_saves=True)
    w = "installations/Survival 1.21.4/saves/Old Survival"
    write(f"{w}/level.dat", level_dat("Old Survival", "1.21.4", 0, 26, 99887766), 26)
    write(f"{w}/icon.png", png(64, 64, (200, 170, 110), (120, 90, 60)), 26)
    write(f"{w}/region/r.0.0.mca", blob(800), 26)
    write(f"{w}/playerdata/{rng.randbytes(16).hex()}.dat", blob(4), 26)
    install(
        "Create Modpack", "1.21.1", "fabric", 3,
        options(renderDistance="16", graphicsMode="2", gamma="1.0", autoJump="true",
                **{"key_key.create.rotate_menu": "key.keyboard.left.alt"}),
        mods=(
            ("create-fabric-6.0.6.jar",
             *fabric_mod("create", "Create", "6.0.6",
                         "Aesthetic technology that empowers the player.",
                         ["simibubi"], ((200, 150, 90), (110, 80, 40))), None),
            ("jei-1.21.1-forge-19.21.jar", None, png(64, 64, (230, 230, 230), (120, 120, 120)),
             'modLoader="javafml"\n[[mods]]\nmodId="jei"\nversion="19.21.0"\n'
             'displayName="Just Enough Items"\nlogoFile="logo.png"\nauthors="mezz"\n'
             'description="View items and recipes"\n'),
            "jade-15.0.jar",
        ),
        own_screenshots=True,
    )
    write("installations/Create Modpack/screenshots/2026-11-18_21.04.11.png",
          scene(480, 270, (200, 160, 110), (250, 210, 150), (150, 110, 70), 42), 3)
    write("installations/Create Modpack/crash-reports/crash-2026-11-18-client.txt",
          "---- Minecraft Crash Report ----\n// Who set us up the TNT?\n\n"
          "Description: Ticking block entity\n\njava.lang.IllegalStateException: Create contraption\n", 3)
    write("installations/Create Modpack/logs/debug.log", game_log(3, "1.21.1"), 3)
    write("launcher_profiles.json", json.dumps({"profiles": profiles, "version": 3}, indent=2), 0.1)

    # standards
    write("standards/Everyday/options.txt", options(renderDistance="10"), 30)
    write("standards/Everyday/1.21.10/config/sodium-options.json", "{}", 30)
    write("standards/PvP/options.txt", options(renderDistance="6"), 30)
    write("standards/PvP/icon.png", png(64, 64, (200, 70, 60), (60, 20, 30)), 30)
    write("standards/Everyday/icon.png", png(64, 64, (120, 190, 90), (40, 90, 50)), 30)

    print(f"seeded {ROOT}  (installations dir: {survival.parent})")


if __name__ == "__main__":
    seed()
