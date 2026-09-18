#!/usr/bin/env python3
"""Generate Advarr brand assets: app icon + social card. Reproducible, no deps beyond Pillow."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_ICON = os.path.join(ROOT, "assets", "brand", "advarr-512.png")
OUT_SOCIAL = os.path.join(ROOT, "assets", "brand", "social-1280x640.png")
OUT_OG = os.path.join(ROOT, "public", "og.png")

BG = (18, 18, 22, 255)
VIOLET = (124, 92, 255)
VIOLET_DIM = (86, 60, 180)
GREEN = (47, 191, 113)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def rounded_bg(size, radius):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)
    return img


def radar(img, cx, cy, r, sweep_deg=320, rings=4):
    d = ImageDraw.Draw(img, "RGBA")
    # rings
    for i in range(1, rings + 1):
        rr = r * i / rings
        alpha = 90 if i % 2 == 0 else 55
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                  outline=VIOLET + (alpha,), width=max(2, int(r * 0.03)))
    # sweep sector (anti-alias via supersampling layer)
    s = 4
    big = Image.new("RGBA", (img.width * s, img.height * s), (0, 0, 0, 0))
    db = ImageDraw.Draw(big)
    for i in range(28):
        a0 = -90 - sweep_deg + i * (sweep_deg / 28.0)
        alpha = int(150 * (i / 28.0))
        db.pieslice([cx * s - r * s, cy * s - r * s, cx * s + r * s, cy * s + r * s],
                    a0 - sweep_deg / 28.0, a0, fill=VIOLET + (alpha,))
    big = big.resize(img.size, Image.LANCZOS)
    img.alpha_composite(big)
    # blips
    for ang, br in [(20, 0.55), (-40, 0.8), (-70, 0.38)]:
        bx = cx + math.cos(math.radians(ang)) * r * br
        by = cy + math.sin(math.radians(ang)) * r * br
        d.ellipse([bx - 7, by - 7, bx + 7, by + 7], fill=GREEN + (255,))
    # needle
    nx = cx + math.cos(math.radians(-90)) * r
    ny = cy + math.sin(math.radians(-90)) * r
    d.line([cx, cy, nx, ny], fill=VIOLET + (230,), width=5)


def make_icon():
    size = 512
    img = rounded_bg(size, 96)
    radar(img, size // 2, size // 2, 170)
    d = ImageDraw.Draw(img, "RGBA")
    # play triangle at center
    cx, cy, w, h = size // 2, size // 2, 52, 64
    d.polygon([(cx - w // 3, cy - h // 2), (cx - w // 3, cy + h // 2), (cx + 2 * w // 3, cy)],
              fill=(235, 235, 245, 255))
    img.save(OUT_ICON)
    print("icon →", OUT_ICON)


def make_social():
    W, H = 1280, 640
    img = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(img, "RGBA")
    # subtle grid
    for x in range(0, W, 64):
        d.line([(x, 0), (x, H)], fill=(255, 255, 255, 6))
    for y in range(0, H, 64):
        d.line([(0, y), (W, y)], fill=(255, 255, 255, 6))
    # icon
    icon = Image.open(OUT_ICON).resize((360, 360), Image.LANCZOS)
    img.alpha_composite(icon, (80, 140))
    # wordmark
    f_big = ImageFont.truetype(FONT, 150)
    f_small = ImageFont.truetype(FONT, 40)
    f_tiny = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 30)
    d.text((520, 190), "ADVARR", font=f_big, fill=(240, 240, 248))
    d.rounded_rectangle([524, 360, 890, 410], radius=25, fill=VIOLET + (40,), outline=VIOLET + (120,), width=2)
    d.text((548, 215 + 210), "radar for your *arr stack", font=f_small, fill=(168, 160, 200))
    d.text((524, 470),
           "TMDB тренды → фильтры → автозапросы в Jellyseerr / Overseerr",
           font=f_tiny, fill=(150, 145, 170))
    d.text((524, 515), "docker • zero-deps • MIT", font=f_tiny, fill=(110, 105, 135))
    img.convert("RGB").save(OUT_SOCIAL)
    img.convert("RGB").save(OUT_OG)
    print("social →", OUT_SOCIAL, "| og →", OUT_OG)


os.makedirs(os.path.dirname(OUT_ICON), exist_ok=True)
os.makedirs(os.path.dirname(OUT_OG), exist_ok=True)
make_icon()
make_social()
