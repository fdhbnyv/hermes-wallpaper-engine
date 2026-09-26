"""
Wallpaper Engine dashboard plugin backend.

Mounted at /api/plugins/wallpaper-engine/ by the Hermes dashboard / desktop
backend. Serves the current Wallpaper Engine wallpaper (title, path, actual
media file, preview image) to the desktop plugin's frontend.

Media detection — what the desktop plugin can actually PLAY, in priority:
  1. web   -> index.html             (embedded as an <iframe>)
  2. video -> video.mp4/webm/mov     (looped <video> background)
  3. gif   -> the SELECTED file itself, when it is a .gif wallpaper
  4. image -> preview.jpg/jpeg/png   (static cover <img>)
  5. render.* -> scene captures made by scene_to_media.py (real desktop
     frames of WE scenes, as jpg / gif / mp4)

preview.gif — animated or not — is ALWAYS just a cover (preview), never a
media file. Scene wallpapers (scene.pkg) cannot be rendered outside Wallpaper
Engine; run scene_to_media.py to capture the live scene into render.* so the
plugin can play it, otherwise the plugin switches to live-through (Clear)
mode instead of painting the cover.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from fastapi import APIRouter
except Exception:  # Allows local unit tests without dashboard dependencies.
    class APIRouter:  # type: ignore
        def get(self, *_args, **_kwargs):
            return lambda fn: fn

        def post(self, *_args, **_kwargs):
            return lambda fn: fn


router = APIRouter()

# ---------------------------------------------------------------------------
# Wallpaper Engine paths
# ---------------------------------------------------------------------------
STEAM_BASE = Path(r"D:\Program Files (x86)\Steam")
WE_CONFIG = STEAM_BASE / "steamapps" / "common" / "wallpaper_engine" / "config.json"
WORKSHOP_BASE = STEAM_BASE / "steamapps" / "workshop" / "content" / "431960"

# Extensions the desktop plugin can actually play as a background video.
VIDEO_EXTS = (".mp4", ".webm", ".mov", ".m4v")
# Filenames Wallpaper Engine uses for video wallpapers (fallback check).
VIDEO_NAMES = ("video.mp4", "video.webm", "video.mov", "background.mp4", "background.webm")


def _load_we_config() -> Optional[Dict[str, Any]]:
    """Read WE's config.json (may hold several user profiles)."""
    try:
        return json.loads(WE_CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return None


def _detect_media(dir_path: Path, file_path: str) -> Optional[Dict[str, str]]:
    """Return the best actually-playable media for a wallpaper folder.

    Returns {"type": ..., "media": <abs path>} or None when the folder only
    has a preview (e.g. scene wallpapers).

    Detection order:
      1. index.html                -> web wallpaper (iframe)
      2. the selected file itself, when it is a video (workshop video items
         keep their original filename, e.g. "Kuroha Moment[4K].mp4") or a gif
      3. a standard video.mp4/webm inside the folder

    preview.gif is deliberately NOT treated as media — it is only a cover,
    whether animated or not.
    """
    web = dir_path / "index.html"
    if web.exists():
        return {"type": "web", "media": str(web)}

    try:
        file_ext = Path(file_path).suffix.lower()
    except Exception:
        file_ext = ""

    if file_ext in VIDEO_EXTS:
        return {"type": "video", "media": file_path}
    if file_ext == ".gif":
        return {"type": "gif", "media": file_path}

    for name in VIDEO_NAMES:
        video = dir_path / name
        if video.exists():
            return {"type": "video", "media": str(video)}

    # Captured scene media produced by scene_to_media.py: real frames grabbed
    # from the desktop where WE renders the scene (NOT the preview cover).
    for name in ("render.mp4", "render.webm", "render.mov", "render.m4v"):
        video = dir_path / name
        if video.exists():
            return {"type": "video", "media": str(video)}
    render_gif = dir_path / "render.gif"
    if render_gif.exists():
        return {"type": "gif", "media": str(render_gif)}
    for ext in ("jpg", "jpeg", "png"):
        render_img = dir_path / f"render.{ext}"
        if render_img.exists():
            return {"type": "image", "media": str(render_img)}

    return None


def _scan_wallpapers() -> List[Dict[str, Any]]:
    """Return every wallpaper found across WE user profiles.

    Each entry: id, title, path, preview, media, type, has_media, user.
    """
    config = _load_we_config()
    if not config:
        return []

    out: List[Dict[str, Any]] = []
    for user_key, user_config in config.items():
        if not isinstance(user_config, dict):
            continue
        general = user_config.get("general", {})
        wp_config = general.get("wallpaperconfig", {})
        selected = wp_config.get("selectedwallpapers", {})
        for _monitor, wp_info in selected.items():
            file_path = wp_info.get("file", "")
            if not file_path:
                continue
            try:
                dir_path = Path(file_path).parent
            except Exception:
                continue

            # Try common preview extensions (jpg, png, gif, jpeg)
            preview_path: Optional[Path] = None
            for ext in ("jpg", "jpeg", "png", "gif"):
                candidate = dir_path / f"preview.{ext}"
                if candidate.exists():
                    preview_path = candidate
                    break

            title = None
            project_json = dir_path / "project.json"
            if project_json.exists():
                try:
                    project = json.loads(project_json.read_text(encoding="utf-8"))
                    title = project.get("title")
                except Exception:
                    pass

            media = _detect_media(dir_path, file_path)

            out.append(
                {
                    "id": dir_path.name,
                    "title": title or dir_path.name,
                    "path": file_path,
                    "preview": str(preview_path) if preview_path else None,
                    "media": media["media"] if media else None,
                    "type": media["type"] if media else None,
                    "has_media": media is not None,
                    "has_preview": preview_path is not None,
                    "user": user_key,
                }
            )
    return out


@router.get("/we-status")
def we_status() -> Dict[str, Any]:
    """Return the current wallpaper, preferring one with playable media."""
    wallpapers = _scan_wallpapers()
    if not wallpapers:
        return {"success": False, "error": "no wallpaper configured"}

    # Prefer playable media (video/web/gif), then any wallpaper with a preview.
    current = next((w for w in wallpapers if w["has_media"]), None)
    if current is None:
        current = next((w for w in wallpapers if w["has_preview"]), wallpapers[0])
    return {
        "success": True,
        "wallpaper": {
            "id": current["id"],
            "title": current["title"],
            "path": current["path"],
            "preview": current["preview"],
            "media": current["media"],
            "type": current["type"],
            "user": current["user"],
        },
    }


@router.get("/we-list")
def we_list() -> Dict[str, Any]:
    """Return all known wallpapers (for a picker)."""
    return {"success": True, "wallpapers": _scan_wallpapers()}
