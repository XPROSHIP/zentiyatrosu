import os
import re
import json
import time
import shutil
import hashlib
import tempfile
import subprocess
import urllib.request
from urllib.parse import unquote, quote
from concurrent.futures import ThreadPoolExecutor

from flask import Flask, jsonify, request, Response, send_file, render_template, stream_with_context
import yt_dlp
import imageio_ffmpeg

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_YT_DIR = os.path.join(BASE_DIR, "cache", "yt")
os.makedirs(CACHE_YT_DIR, exist_ok=True)
FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()

app = Flask(__name__, template_folder=os.path.join(BASE_DIR, "templates"), static_folder=os.path.join(BASE_DIR, "static"))

# Simple in-memory cache for resolved YouTube audio URLs: vid -> (expires_at, direct_url, mime_type)
YT_URL_CACHE = {}
CACHE_TTL_SEC = 3600


def load_json(name):
    with open(os.path.join(BASE_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def sanitize_filename(name):
    s = re.sub(r'[\\/*?:"<>|]+', "", name).strip()
    return s[:80] or "zen_tiyatrosu"


def resolve_yt_audio(vid):
    now = time.time()
    cached = YT_URL_CACHE.get(vid)
    if cached and cached[0] > now:
        return cached[1], cached[2]

    ydl_opts = {
        "format": "worstaudio[ext=m4a]/bestaudio[abr<=96][ext=m4a]/bestaudio[ext=m4a]/bestaudio",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extract_flat": False,
    }
    url = f"https://www.youtube.com/watch?v={vid}"
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        direct_url = info.get("url")
        ext = info.get("ext", "m4a")
        mime = "audio/mp4" if ext == "m4a" else ("audio/webm" if ext == "webm" else "audio/mpeg")
        if not direct_url:
            raise RuntimeError("Direct audio URL not found")
        YT_URL_CACHE[vid] = (now + CACHE_TTL_SEC, direct_url, mime)
        return direct_url, mime


def proxy_stream(target_url, default_mime="audio/mpeg", download_name=None):
    headers = {"User-Agent": "Mozilla/5.0"}
    rng = request.headers.get("Range")
    if rng:
        headers["Range"] = rng

    req = urllib.request.Request(target_url, headers=headers)
    upstream = urllib.request.urlopen(req, timeout=25)
    status = upstream.status
    resp_headers = {
        "Content-Type": upstream.headers.get("Content-Type", default_mime),
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
    }
    for h in ("Content-Length", "Content-Range"):
        val = upstream.headers.get(h)
        if val:
            resp_headers[h] = val
    if download_name:
        resp_headers["Content-Disposition"] = f'attachment; filename="{download_name}"'

    def generate():
        try:
            while True:
                chunk = upstream.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            upstream.close()

    return Response(stream_with_context(generate()), status=status, headers=resp_headers)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/catalog")
def api_catalog():
    rt = load_json("radyo_tiyatrosu.json")
    ay = load_json("arkasi_yarin.json")
    cc = load_json("cocuklar_icin_radyo_tiyatrolari.json")

    def tag_items(cat_key, data):
        items = []
        for x in data.get("audio", []):
            st = "youtube" if x.get("youtube_id") else "audio"
            items.append({**x, "source_type": st, "category_key": cat_key})
        for x in data.get("youtube", []):
            items.append({**x, "source_type": "youtube", "category_key": cat_key})
        return items

    rt_items = tag_items("radyo_tiyatrosu", rt)
    cc_items = tag_items("cocuklar", cc)

    # Group Arkasi Yarin by series title
    series_map = {}
    for x in tag_items("arkasi_yarin", ay):
        t = x["title"]
        if t not in series_map:
            series_map[t] = {
                "id": "series_" + hashlib.md5(t.encode("utf-8")).hexdigest()[:10],
                "title": t,
                "cover": x.get("cover"),
                "rating": x.get("rating"),
                "genre": x.get("genre"),
                "episodes": [],
            }
        series_map[t]["episodes"].append(x)

    ay_series = []
    for s in series_map.values():
        eps = s["episodes"]
        # Sort episodes numerically if possible
        def ep_sort_key(ep):
            val = str(ep.get("episode") or "")
            m = re.search(r"\d+", val)
            return (0, int(m.group(0)), val) if m else (1, 0, val)

        eps.sort(key=ep_sort_key)
        s["episode_count"] = len(eps)
        s["available_count"] = sum(1 for e in eps if e.get("available"))
        s["total_duration_seconds"] = sum((e.get("duration_seconds") or 0) for e in eps)
        s["has_audio"] = any(e["source_type"] == "audio" for e in eps)
        s["has_youtube"] = any(e["source_type"] == "youtube" for e in eps)
        ay_series.append(s)

    return jsonify({
        "radyo_tiyatrosu": rt_items,
        "arkasi_yarin_series": ay_series,
        "cocuklar": cc_items,
    })


@app.route("/api/proxy/image")
def api_proxy_image():
    url = request.args.get("url", "").strip()
    if not url.startswith("http"):
        return jsonify({"error": "Invalid URL"}), 400
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        upstream = urllib.request.urlopen(req, timeout=15)
        data = upstream.read()
        mime = upstream.headers.get("Content-Type", "image/jpeg")
        return Response(data, headers={"Content-Type": mime, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400"})
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/proxy/audio")
def api_proxy_audio():
    url = request.args.get("url", "").strip()
    if not url.startswith("http"):
        return jsonify({"error": "Invalid URL"}), 400
    dl_name = request.args.get("download")
    try:
        return proxy_stream(url, default_mime="audio/mpeg", download_name=dl_name)
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/stream/yt/<vid>")
def api_stream_yt(vid):
    if not re.match(r"^[A-Za-z0-9_-]{11}$", vid):
        return jsonify({"error": "Invalid YouTube ID"}), 400
    try:
        # Check disk cache first so seeking (Range requests) is 100% instant and never freezes
        existing = None
        for ext in ("m4a", "webm", "mp3", "opus"):
            p = os.path.join(CACHE_YT_DIR, f"{vid}.{ext}")
            if os.path.exists(p) and os.path.getsize(p) > 4096:
                existing = p
                break

        if not existing:
            out_tmpl = os.path.join(CACHE_YT_DIR, f"{vid}.%(ext)s")
            ydl_opts = {
                "format": "worstaudio[ext=m4a]/bestaudio[abr<=96][ext=m4a]/bestaudio[ext=m4a]/bestaudio",
                "outtmpl": out_tmpl,
                "quiet": True,
                "no_warnings": True,
                "noplaylist": True,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=True)
                ext = info.get("ext", "m4a")
                candidate = os.path.join(CACHE_YT_DIR, f"{vid}.{ext}")
                if os.path.exists(candidate) and os.path.getsize(candidate) > 0:
                    existing = candidate

        if not existing:
            raise RuntimeError("Audio cache failed")

        dl = request.args.get("download")
        dl_name = f"{sanitize_filename(dl)}{os.path.splitext(existing)[1]}" if dl else None
        return send_file(
            existing,
            conditional=True,
            as_attachment=bool(dl),
            download_name=dl_name,
        )
    except Exception as e:
        return jsonify({"fallback": "embed", "error": str(e)}), 502


@app.route("/api/merge", methods=["POST"])
def api_merge():
    """
    Merges multiple episodes (archive.org MP3s and/or YouTube audio) into a single MP3 file using ffmpeg.
    Body: { "title": "Monte Kristo", "items": [ {"source_type": "audio"|"youtube", "url": "...", "youtube_id": "..."}, ... ] }
    """
    payload = request.get_json(silent=True) or {}
    title = sanitize_filename(payload.get("title", "ZEN_Tiyatrosu_Birlesik"))
    items = payload.get("items", [])
    if not items:
        return jsonify({"error": "No items provided"}), 400

    tmpdir = tempfile.mkdtemp(prefix="zen_merge_")
    try:
        def fetch_part(idx, item):
            src_type = item.get("source_type")
            out_raw = os.path.join(tmpdir, f"part_{idx:03d}")
            if src_type == "audio":
                url = item.get("url")
                if not url:
                    return None
                ext = ".m4a" if ".m4a" in url.lower() else ".mp3"
                out_file = out_raw + ext
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=45) as resp, open(out_file, "wb") as f:
                    shutil.copyfileobj(resp, f)
                return out_file
            elif src_type == "youtube":
                vid = item.get("youtube_id")
                if not vid:
                    return None
                direct_url, _ = resolve_yt_audio(vid)
                out_file = out_raw + ".m4a"
                req = urllib.request.Request(direct_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=45) as resp, open(out_file, "wb") as f:
                    shutil.copyfileobj(resp, f)
                return out_file
            return None

        part_files = [None] * len(items)
        with ThreadPoolExecutor(max_workers=4) as ex:
            futs = {ex.submit(fetch_part, i, it): i for i, it in enumerate(items)}
            for fut, idx in futs.items():
                try:
                    part_files[idx] = fut.result()
                except Exception:
                    part_files[idx] = None

        valid_parts = [p for p in part_files if p and os.path.exists(p) and os.path.getsize(p) > 0]
        if not valid_parts:
            return jsonify({"error": "Hiçbir bölüm indirilemedi."}), 502

        # Normalize/concat into single MP3 using ffmpeg concat filter
        # Using concat demuxer if all are mp3, otherwise filter_complex concat
        all_mp3 = all(p.endswith(".mp3") for p in valid_parts)
        merged_path = os.path.join(tmpdir, f"{title}.mp3")

        if all_mp3:
            list_txt = os.path.join(tmpdir, "list.txt")
            with open(list_txt, "w", encoding="utf-8") as f:
                for p in valid_parts:
                    safe_p = p.replace("\\", "/")
                    f.write(f"file '{safe_p}'\n")
            cmd = [FFMPEG_EXE, "-y", "-f", "concat", "-safe", "0", "-i", list_txt, "-c", "copy", merged_path]
            res = subprocess.run(cmd, capture_output=True)
            if res.returncode != 0:
                all_mp3 = False  # fallback to re-encode

        if not all_mp3:
            cmd = [FFMPEG_EXE, "-y"]
            for p in valid_parts:
                cmd.extend(["-i", p])
            filter_inputs = "".join(f"[{i}:a]" for i in range(len(valid_parts)))
            cmd.extend([
                "-filter_complex", f"{filter_inputs}concat=n={len(valid_parts)}:v=0:a=1[outa]",
                "-map", "[outa]", "-codec:a", "libmp3lame", "-b:a", "96k", merged_path
            ])
            res = subprocess.run(cmd, capture_output=True)
            if res.returncode != 0:
                return jsonify({"error": "FFmpeg birleştirme hatası"}), 500

        # Stream file and clean up after
        file_size = os.path.getsize(merged_path)
        def stream_and_cleanup():
            try:
                with open(merged_path, "rb") as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        yield chunk
            finally:
                shutil.rmtree(tmpdir, ignore_errors=True)

        headers = {
            "Content-Type": "audio/mpeg",
            "Content-Length": str(file_size),
            "Content-Disposition": f'attachment; filename="{title}.mp3"',
        }
        return Response(stream_with_context(stream_and_cleanup()), headers=headers)
    except Exception as e:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
