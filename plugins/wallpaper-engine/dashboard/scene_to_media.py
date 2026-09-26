# -*- coding: utf-8 -*-
"""Convert Wallpaper Engine SCENE wallpapers into media the Hermes plugin can play.

Why: scene.pkg is a closed format only WE's own engine can render. No browser /
plugin can decode it. Instead, this tool captures what WE is ACTUALLY painting
on the desktop right now (the real, full-quality scene — not the low-res
preview cover) and saves it beside the wallpaper:

  - static scene   -> render.jpg   (sharp full-screen frame)
  - animated scene -> render.gif   (short looped capture)

The backend (_detect_media) recognises render.* as real media, so the Hermes
plugin then plays the actual scene.

Usage:
  python scene_to_media.py                  # convert the currently selected scene wallpaper
  python scene_to_media.py --all            # convert every scene wallpaper
  python scene_to_media.py --width 1280     # cap output width (default 1920 static / 1280 gif)
  python scene_to_media.py --seconds 3      # animated capture length (default 2.5 s)
  python scene_to_media.py --dry-run        # only print what would be converted
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import plugin_api as api

try:
    from PIL import Image, ImageChops, ImageGrab
except ImportError:
    print("PIL/Pillow is required: pip install pillow")
    sys.exit(1)


def _frame_diff(a: Image.Image, b: Image.Image) -> float:
    """Mean absolute pixel difference between two equal-sized frames (0-255)."""
    if a.size != b.size:
        b = b.resize(a.size)
    diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    hist = diff.histogram()
    total = sum(hist)
    return sum(i * n for i, n in enumerate(hist)) / total if total else 0.0


def _capture(width_cap: int) -> Image.Image:
    """Grab the full virtual desktop and downscale to width_cap (keep aspect)."""
    im = ImageGrab.grab()
    if im.width > width_cap:
        h = max(1, round(im.height * width_cap / im.width))
        im = im.resize((width_cap, h), Image.LANCZOS)
    return im.convert("RGB")


def _is_animated(seconds: float = 1.0) -> bool:
    """Sample two frames apart; a visible difference means the scene animates."""
    a = _capture(960)
    time.sleep(seconds)
    b = _capture(960)
    diff = _frame_diff(a, b)
    print(f"  motion sample: mean pixel diff = {diff:.1f}")
    return diff > 2.0


def convert_wallpaper(wp: dict, width: int, seconds: float, dry_run: bool) -> bool:
    """Capture the real scene for one wallpaper folder. Returns True on success."""
    folder = Path(wp["path"]).parent
    title = wp.get("title") or wp.get("id")
    print(f"\n[{wp.get('id')}] {title}")
    print(f"  folder: {folder}")

    if not folder.exists():
        print("  SKIP: folder missing")
        return False
    if not folder.is_dir():
        print("  SKIP: not a directory")
        return False

    if dry_run:
        print("  dry-run: would capture here")
        return True

    animated = _is_animated()
    if not animated:
        print("  static scene -> render.jpg")
        frame = _capture(width)
        out = folder / "render.jpg"
        frame.save(out, "JPEG", quality=88)
        print(f"  saved {out.name} ({frame.size[0]}x{frame.size[1]}, {out.stat().st_size/1024:.0f} KB)")
        return True

    print(f"  animated scene -> render.gif ({seconds}s loop)")
    gif_width = min(width, 1280)
    n = max(8, min(40, round(seconds * 10)))
    interval = seconds / n
    frames = []
    for i in range(n):
        frames.append(_capture(gif_width))
        time.sleep(interval)
    out = folder / "render.gif"
    frames[0].save(
        out,
        "GIF",
        save_all=True,
        append_images=frames[1:],
        duration=max(40, round(interval * 1000)),
        loop=0,
        optimize=True,
    )
    print(f"  saved {out.name} ({gif_width}px, {n} frames, {out.stat().st_size/1024:.0f} KB)")
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--all", action="store_true", help="convert every scene wallpaper")
    ap.add_argument("--width", type=int, default=1920, help="static capture width (default 1920)")
    ap.add_argument("--seconds", type=float, default=2.5, help="animated capture length (default 2.5)")
    ap.add_argument("--dry-run", action="store_true", help="print plans only")
    args = ap.parse_args()

    wallpapers = api._scan_wallpapers()
    if not wallpapers:
        print("No wallpapers found in WE config.")
        return

    # Scene wallpapers = no playable media (no video/web/gif/image of their own)
    scenes = [w for w in wallpapers if not w["has_media"] and Path(w["path"]).suffix.lower() in (".pkg", ".scn")]
    if not scenes:
        # Fall back: anything without media is scene-like
        scenes = [w for w in wallpapers if not w["has_media"]]

    if args.all:
        targets = scenes
    else:
        status = api.we_status()
        cur = (status.get("wallpaper") or {}).get("id")
        targets = [w for w in scenes if w["id"] == cur] or scenes[:1]

    if not targets:
        print("No scene wallpapers to convert.")
        return

    ok = 0
    for w in targets:
        if convert_wallpaper(w, args.width, args.seconds, args.dry_run):
            ok += 1
    print(f"\nDone: {ok}/{len(targets)} converted. Restart Hermes Desktop to pick up the new media.")


if __name__ == "__main__":
    main()
