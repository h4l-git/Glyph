"""Capture Glyph marketing stills and a short how-to video from the demo stage."""
import os
import shutil
import subprocess
import tempfile

import imageio_ffmpeg
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "shots")
URL = "http://127.0.0.1:8765/demo-stage/index.html"
DURATION = 11.6
FPS = 12
STILLS = {
    "menu.jpg": 2.5,
    "highlight.jpg": 5.5,
    "snip.jpg": 10.9,
}


def prepare(page):
    page.goto(URL, wait_until="networkidle")
    page.frame_locator("#menu-frame").locator(".popup").wait_for()
    page.evaluate("() => document.fonts.ready")
    page.wait_for_timeout(250)


def save_still(page, name, t):
    page.evaluate("(t) => { window.SHOW_CAPTION = false; window.renderFrame(t); }", t)
    page.wait_for_timeout(40)
    raw = os.path.join(OUT, "_" + name)
    page.screenshot(path=raw, type="png")
    img = Image.open(raw).convert("RGB")
    w = 1600
    h = round(img.height * (w / img.width))
    img = img.resize((w, h), Image.Resampling.LANCZOS)
    img.save(os.path.join(OUT, name), "JPEG", quality=84, optimize=True)
    os.remove(raw)


def main():
    os.makedirs(OUT, exist_ok=True)
    frames = tempfile.mkdtemp(prefix="glyph-frames-")
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome")
            still_page = browser.new_page(
                viewport={"width": 1280, "height": 720},
                device_scale_factor=2,
                color_scheme="light",
            )
            prepare(still_page)
            for name, t in STILLS.items():
                save_still(still_page, name, t)
                print("still", name)
            still_page.close()

            video_page = browser.new_page(
                viewport={"width": 1280, "height": 720},
                device_scale_factor=1,
                color_scheme="light",
            )
            prepare(video_page)
            video_page.evaluate("() => { window.SHOW_CAPTION = true; }")
            n = int(DURATION * FPS) + 1
            for i in range(n):
                t = i / FPS
                video_page.evaluate("(t) => window.renderFrame(t)", t)
                video_page.screenshot(path=os.path.join(frames, f"f_{i:04d}.png"), type="png")
                if i % 12 == 0:
                    print("frame", i, "/", n)
            video_page.close()
            browser.close()

        ff = imageio_ffmpeg.get_ffmpeg_exe()
        out = os.path.join(OUT, "glyph-demo.mp4")
        subprocess.check_call([
            ff, "-y",
            "-framerate", str(FPS),
            "-i", os.path.join(frames, "f_%04d.png"),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-crf", "16",
            "-movflags", "+faststart",
            out,
        ])
        print("video", out, os.path.getsize(out))
    finally:
        shutil.rmtree(frames, ignore_errors=True)


def capture_store():
    """1280x800 full-bleed PNGs for the Chrome Web Store, plus a copy of the video."""
    store = os.path.join(ROOT, "chrome-store")
    os.makedirs(store, exist_ok=True)
    shots = {
        "screenshot-1-menu.png": 2.5,
        "screenshot-2-highlight.png": 5.5,
        "screenshot-3-snip.png": 10.9,
    }
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        page = browser.new_page(
            viewport={"width": 1280, "height": 800},
            device_scale_factor=1,
            color_scheme="light",
        )
        page.goto(URL + "?store=1", wait_until="load")
        page.frame_locator("#menu-frame").locator(".popup").wait_for()
        page.evaluate("() => document.fonts.ready")
        page.wait_for_timeout(300)
        for name, t in shots.items():
            page.evaluate("(t) => { window.SHOW_CAPTION = false; window.renderFrame(t); }", t)
            page.wait_for_timeout(40)
            raw = os.path.join(store, "_" + name)
            page.screenshot(path=raw, type="png")
            img = Image.open(raw).convert("RGB")
            if img.size != (1280, 800):
                img = img.resize((1280, 800), Image.Resampling.LANCZOS)
            dest = os.path.join(store, name)
            img.save(dest, "PNG", optimize=True)
            os.remove(raw)
            print(name, img.size, os.path.getsize(dest))
        browser.close()
    video_src = os.path.join(OUT, "glyph-demo.mp4")
    video_dest = os.path.join(store, "glyph-demo.mp4")
    shutil.copy2(video_src, video_dest)
    print("video", video_dest, os.path.getsize(video_dest))


if __name__ == "__main__":
    import sys
    if "--store" in sys.argv:
        capture_store()
    else:
        main()
