// ZEN Tiyatrosu — Frontend Engine
(() => {
  const PLAY_SVG = '<path d="M8 5v14l11-7z"/>';
  const PAUSE_SVG = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';

  // --- Tactile Click Sound Effects (Web Audio API) ---
  const sfx = {
    enabled: localStorage.getItem("zen_sfx") !== "0",
    ctx: null,
    click(freq = 640, dur = 0.028) {
      if (!this.enabled) return;
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === "suspended") this.ctx.resume();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(180, this.ctx.currentTime + dur);
        gain.gain.setValueAtTime(0.06, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + dur);
      } catch (_) {}
    },
    chime() {
      if (!this.enabled) return;
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === "suspended") this.ctx.resume();
        [523.25, 659.25, 783.99].forEach((freq, idx) => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          const t0 = this.ctx.currentTime + idx * 0.09;
          osc.type = "triangle";
          osc.frequency.setValueAtTime(freq, t0);
          gain.gain.setValueAtTime(0.08, t0);
          gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(t0);
          osc.stop(t0 + 0.26);
        });
      } catch (_) {}
    }
  };

  // --- IndexedDB for Offline Audio Blobs ---
  const offlineDB = {
    db: null,
    async open() {
      if (this.db) return this.db;
      return new Promise((resolve, reject) => {
        const req = indexedDB.open("ZenTiyatrosuOffline", 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains("tracks")) {
            db.createObjectStore("tracks", { keyPath: "id" });
          }
        };
        req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
        req.onerror = (e) => reject(e);
      });
    },
    async put(record) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("tracks", "readwrite");
        tx.objectStore("tracks").put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e);
      });
    },
    async get(id) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("tracks", "readonly");
        const req = tx.objectStore("tracks").get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (e) => reject(e);
      });
    },
    async listKeys() {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction("tracks", "readonly");
        const req = tx.objectStore("tracks").getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
      });
    },
    async listAllMeta() {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction("tracks", "readonly");
        const req = tx.objectStore("tracks").getAll();
        req.onsuccess = () => resolve((req.result || []).map(({ blob, ...meta }) => meta));
      });
    },
    async remove(id) {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction("tracks", "readwrite");
        tx.objectStore("tracks").delete(id);
        tx.oncomplete = () => resolve();
      });
    }
  };

  // --- State ---
  const state = {
    catalog: { radyo_tiyatrosu: [], arkasi_yarin_series: [], cocuklar: [] },
    offlineKeys: new Set(),
    offlineMeta: [],
    category: "radyo_tiyatrosu",
    filter: "available",
    sort: "title_asc",
    search: "",
    theme: localStorage.getItem("zen_theme") || "obsidian",
    favorites: new Set(JSON.parse(localStorage.getItem("zen_favs") || "[]")),
    progress: JSON.parse(localStorage.getItem("zen_progress") || "{}"),
    queue: [],
    queueIndex: -1,
    currentItem: null,
    isPlaying: false,
    speed: parseFloat(localStorage.getItem("zen_speed") || "1"),
    speeds: [0.75, 1, 1.25, 1.5, 2],
    sleepMinutes: 0,
    sleepTimerId: null,
    mode: "audio", // "audio" | "yt_embed"
    ytPlayer: null,
    ytTicker: null,
    activeSeries: null,
  };

  const els = {
    grid: document.getElementById("library-grid"),
    search: document.getElementById("search-input"),
    sort: document.getElementById("sort-select"),
    count: document.getElementById("result-count"),
    audio: document.getElementById("audio-el"),
    mini: document.getElementById("mini-player"),
    full: document.getElementById("full-player"),
    seriesModal: document.getElementById("series-modal"),
    toast: document.getElementById("toast"),
  };

  // --- Helpers ---
  function fmtTime(sec) {
    if (!sec || isNaN(sec)) return "00:00";
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2800);
  }

  function showJobPopup(title, sub) {
    document.getElementById("job-dot").classList.remove("done");
    document.getElementById("job-title").textContent = title;
    document.getElementById("job-sub").textContent = sub;
    document.getElementById("job-popup").classList.remove("hidden");
  }

  function finishJobPopup(title, sub) {
    document.getElementById("job-dot").classList.add("done");
    document.getElementById("job-title").textContent = title;
    document.getElementById("job-sub").textContent = sub;
    sfx.chime();
    setTimeout(() => document.getElementById("job-popup").classList.add("hidden"), 4500);
  }
  document.getElementById("job-close").onclick = () => document.getElementById("job-popup").classList.add("hidden");

  function applyTheme(t) {
    state.theme = t;
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("zen_theme", t);
  }

  // --- Dominant Color Extraction ---
  function applyCoverColor(imgUrl) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 24;
        canvas.height = 24;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 24, 24);
        const data = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          const pr = data[i], pg = data[i + 1], pb = data[i + 2];
          const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
          const lum = (max + min) / 2;
          if (lum > 35 && lum < 225) {
            const weight = (max - min) + 25;
            r += pr * weight; g += pg * weight; b += pb * weight;
            count += weight;
          }
        }
        if (count > 0) {
          r = Math.min(245, Math.max(80, Math.round(r / count)));
          g = Math.min(245, Math.max(80, Math.round(g / count)));
          b = Math.min(245, Math.max(80, Math.round(b / count)));
          document.documentElement.style.setProperty("--dyn-r", r);
          document.documentElement.style.setProperty("--dyn-g", g);
          document.documentElement.style.setProperty("--dyn-b", b);
        }
      } catch (_) {}
    };
    img.src = imgUrl.startsWith("http") ? `/api/proxy/image?url=${encodeURIComponent(imgUrl)}` : imgUrl;
  }

  // --- Progress & Favorites ---
  function saveProgress(id, cur, dur) {
    if (!id || !cur || cur < 2) return;
    state.progress[id] = { t: Math.floor(cur), d: Math.floor(dur || 0), ts: Date.now() };
    localStorage.setItem("zen_progress", JSON.stringify(state.progress));
  }

  function toggleFav(id) {
    sfx.click(780);
    if (state.favorites.has(id)) {
      state.favorites.delete(id);
      showToast("Favorilerden çıkarıldı");
    } else {
      state.favorites.add(id);
      showToast("Favorilere eklendi");
    }
    localStorage.setItem("zen_favs", JSON.stringify([...state.favorites]));
    updateFavIcon();
    if (state.category === "favorites") renderGrid();
  }

  function updateFavIcon() {
    const btn = document.getElementById("fp-fav");
    if (!state.currentItem) return;
    const isFav = state.favorites.has(state.currentItem.id);
    btn.classList.toggle("active", isFav);
    btn.querySelector("svg").setAttribute("fill", isFav ? "currentColor" : "none");
  }

  // --- Playback Engine ---
  function stopYTTicker() {
    if (state.ytTicker) { clearInterval(state.ytTicker); state.ytTicker = null; }
  }

  function destroyYTEmbed() {
    stopYTTicker();
    document.getElementById("yt-embed-box").classList.add("hidden");
    if (state.ytPlayer && typeof state.ytPlayer.stopVideo === "function") {
      try { state.ytPlayer.stopVideo(); } catch (_) {}
    }
  }

  async function playItem(item, queue = [item], qIdx = 0) {
    if (!item.available && !state.offlineKeys.has(item.id)) {
      showToast("Bu yayın kaynağına şu an erişilemiyor.");
      return;
    }
    sfx.click(540);
    state.queue = queue;
    state.queueIndex = qIdx;
    state.currentItem = item;

    const cover = item.cover || "/static/covers/ai/classic_01.jpg";
    document.getElementById("fp-cover").src = cover;
    document.getElementById("mp-cover").src = cover;
    document.getElementById("fp-title").textContent = item.title;
    document.getElementById("fp-subtitle").textContent = item.episode ? `Bölüm ${item.episode}` : (item.category_key === "cocuklar" ? "Çocuklar İçin" : "Radyo Tiyatrosu");
    document.getElementById("mp-title").textContent = item.title;
    document.getElementById("mp-sub").textContent = item.episode ? `Bölüm ${item.episode}` : "Radyo Tiyatrosu";
    document.getElementById("fp-source-badge").textContent = state.offlineKeys.has(item.id) ? "ÇEVRİMDIŞI" : (item.source_type === "youtube" ? "YOUTUBE SES" : "SES");

    applyCoverColor(cover);
    updateFavIcon();
    els.mini.classList.remove("hidden");

    const saved = state.progress[item.id]?.t || 0;
    els.audio.pause();
    destroyYTEmbed();

    // 1. Check IndexedDB offline blob first
    const offRec = await offlineDB.get(item.id);
    if (offRec && offRec.blob) {
      state.mode = "audio";
      els.audio.src = URL.createObjectURL(offRec.blob);
      els.audio.playbackRate = state.speed;
      if (saved > 3) els.audio.currentTime = saved;
      els.audio.play().catch(() => {});
      setPlayingUI(true);
      showToast("Çevrimdışı yerel kayıttan oynatılıyor");
      return;
    }

    // 2. Direct Audio or YouTube Audio Stream
    if (item.source_type === "audio") {
      state.mode = "audio";
      els.audio.src = `/api/proxy/audio?url=${encodeURIComponent(item.url)}`;
      els.audio.playbackRate = state.speed;
      els.audio.onloadedmetadata = () => {
        if (saved > 3 && saved < (els.audio.duration || Infinity) - 5) {
          els.audio.currentTime = saved;
        }
      };
      els.audio.play().catch(() => showToast("Ses yüklenirken hata oluştu"));
      setPlayingUI(true);
    } else {
      // Try yt-dlp audio stream first
      state.mode = "audio";
      els.audio.src = `/api/stream/yt/${item.youtube_id}`;
      els.audio.playbackRate = state.speed;
      els.audio.onloadedmetadata = () => {
        if (saved > 3 && saved < (els.audio.duration || Infinity) - 5) {
          els.audio.currentTime = saved;
        }
      };
      els.audio.onerror = () => {
        if (state.currentItem?.id === item.id && state.mode === "audio") {
          fallbackToYTEmbed(item, saved);
        }
      };
      els.audio.play().catch(() => {});
      setPlayingUI(true);
    }
  }

  function fallbackToYTEmbed(item, startSec = 0) {
    state.mode = "yt_embed";
    document.getElementById("fp-source-badge").textContent = "YT EMBED";
    const box = document.getElementById("yt-embed-box");
    box.classList.remove("hidden");

    const initYT = () => {
      if (state.ytPlayer && typeof state.ytPlayer.loadVideoById === "function") {
        state.ytPlayer.loadVideoById({ videoId: item.youtube_id, startSeconds: startSec, suggestedQuality: "small" });
        state.ytPlayer.setPlaybackRate(state.speed);
      } else {
        state.ytPlayer = new YT.Player("yt-iframe-target", {
          videoId: item.youtube_id,
          playerVars: { autoplay: 1, controls: 0, modestbranding: 1, rel: 0, start: Math.floor(startSec) },
          events: {
            onReady: (e) => {
              e.target.setPlaybackQuality("small");
              e.target.setPlaybackRate(state.speed);
              e.target.playVideo();
            },
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.ENDED) playNextInQueue();
              setPlayingUI(e.data === YT.PlayerState.PLAYING);
            }
          }
        });
      }
      stopYTTicker();
      state.ytTicker = setInterval(() => {
        if (!state.ytPlayer || typeof state.ytPlayer.getCurrentTime !== "function") return;
        const cur = state.ytPlayer.getCurrentTime() || 0;
        const dur = state.ytPlayer.getDuration() || item.duration_seconds || 0;
        updateProgressUI(cur, dur);
        if (Math.floor(cur) % 3 === 0) saveProgress(item.id, cur, dur);
      }, 1000);
    };

    if (window.YT && window.YT.Player) {
      initYT();
    } else {
      window.onYouTubeIframeAPIReady = initYT;
      if (!document.getElementById("yt-api-script")) {
        const s = document.createElement("script");
        s.id = "yt-api-script";
        s.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(s);
      }
      showToast("YouTube oynatıcı yükleniyor...");
    }
  }

  function setPlayingUI(playing) {
    state.isPlaying = playing;
    document.getElementById("fp-play-icon").innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    document.getElementById("mp-play-icon").innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
  }

  function togglePlay() {
    sfx.click(620);
    if (!state.currentItem) return;
    if (state.mode === "audio") {
      if (els.audio.paused) { els.audio.play(); setPlayingUI(true); }
      else { els.audio.pause(); setPlayingUI(false); }
    } else if (state.ytPlayer) {
      if (state.isPlaying) { state.ytPlayer.pauseVideo(); setPlayingUI(false); }
      else { state.ytPlayer.playVideo(); setPlayingUI(true); }
    }
  }

  function seekBy(delta) {
    sfx.click(500);
    if (state.mode === "audio") {
      els.audio.currentTime = Math.max(0, Math.min(els.audio.duration || 0, els.audio.currentTime + delta));
    } else if (state.ytPlayer && typeof state.ytPlayer.getCurrentTime === "function") {
      const t = Math.max(0, state.ytPlayer.getCurrentTime() + delta);
      state.ytPlayer.seekTo(t, true);
    }
  }

  function playNextInQueue() {
    if (state.queueIndex + 1 < state.queue.length) {
      const nextIdx = state.queueIndex + 1;
      const next = state.queue[nextIdx];
      if (next.available || state.offlineKeys.has(next.id)) playItem(next, state.queue, nextIdx);
    }
  }

  function playPrevInQueue() {
    if (state.queueIndex > 0) {
      const prevIdx = state.queueIndex - 1;
      playItem(state.queue[prevIdx], state.queue, prevIdx);
    }
  }

  function updateProgressUI(cur, dur) {
    const seek = document.getElementById("fp-seek");
    seek.max = dur || 100;
    seek.value = cur || 0;
    document.getElementById("fp-current").textContent = fmtTime(cur);
    document.getElementById("fp-duration").textContent = fmtTime(dur);
    const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
    document.getElementById("mp-progress-fill").style.width = `${pct}%`;
  }

  // Audio Element Events
  els.audio.addEventListener("timeupdate", () => {
    const cur = els.audio.currentTime;
    const dur = els.audio.duration || state.currentItem?.duration_seconds || 0;
    updateProgressUI(cur, dur);
    if (state.currentItem && Math.floor(cur) % 3 === 0) saveProgress(state.currentItem.id, cur, dur);
  });
  els.audio.addEventListener("ended", () => {
    setPlayingUI(false);
    playNextInQueue();
  });
  els.audio.addEventListener("play", () => setPlayingUI(true));
  els.audio.addEventListener("pause", () => setPlayingUI(false));

  // --- Offline & Merge Functions ---
  async function saveSingleOffline(item) {
    sfx.click(700);
    if (!item) return;
    showJobPopup(item.title, "Çevrimdışı kütüphaneye kaydediliyor...");
    const url = item.source_type === "audio"
      ? `/api/proxy/audio?url=${encodeURIComponent(item.url)}`
      : `/api/stream/yt/${item.youtube_id}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("İndirme başarısız");
      const blob = await res.blob();
      await offlineDB.put({
        id: item.id,
        title: item.title,
        episode: item.episode,
        cover: item.cover,
        duration_seconds: item.duration_seconds,
        source_type: "audio",
        available: true,
        blob,
        savedAt: Date.now(),
      });
      await refreshOfflineList();
      finishJobPopup(item.title, "Çevrimdışı kütüphaneye kaydedildi!");
    } catch (e) {
      document.getElementById("job-popup").classList.add("hidden");
      showToast("Çevrimdışı kaydetme başarısız: " + e.message);
    }
  }

  function downloadSingleFile(item) {
    sfx.click(700);
    if (!item) return;
    const url = item.source_type === "audio"
      ? `/api/proxy/audio?url=${encodeURIComponent(item.url)}&download=${encodeURIComponent(item.title + ".mp3")}`
      : `/api/stream/yt/${item.youtube_id}?download=${encodeURIComponent(item.title)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast("Cihaza indirme başlatıldı...");
  }

  async function mergeSeries(series, saveToOffline = false) {
    sfx.click(720);
    const availEps = series.episodes.filter((e) => e.available);
    if (!availEps.length) { showToast("Erişilebilir bölüm yok."); return; }
    const prog = document.getElementById("merge-progress");
    prog.textContent = `${availEps.length} bölüm birleştiriliyor... (Köşeden takip edebilirsiniz)`;
    prog.classList.remove("hidden");
    showJobPopup(series.title, `${availEps.length} bölüm birleştiriliyor...`);
    try {
      let blob = null;
      const res = await fetch("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: series.title, items: availEps }),
      });
      if (res.ok) {
        blob = await res.blob();
      } else {
        // Client-side fallback merge for direct audio episodes (e.g. on Cloudflare Pages)
        const directEps = availEps.filter((e) => e.source_type === "audio");
        if (!directEps.length) throw new Error("YouTube bölümlerini birleştirmek için yerel sunucu gerekir.");
        const parts = [];
        for (let i = 0; i < directEps.length; i++) {
          showJobPopup(series.title, `Bölüm ${i + 1}/${directEps.length} indiriliyor...`);
          const r = await fetch(`/api/proxy/audio?url=${encodeURIComponent(directEps[i].url)}`);
          if (r.ok) parts.push(await r.arrayBuffer());
        }
        if (!parts.length) throw new Error("Bölümler indirilemedi");
        blob = new Blob(parts, { type: "audio/mpeg" });
      }
      if (saveToOffline) {
        await offlineDB.put({
          id: series.id,
          title: `${series.title} (Tüm Bölümler)`,
          episode: `${availEps.length} Bölüm Birleşik`,
          cover: series.cover,
          duration_seconds: series.total_duration_seconds,
          source_type: "audio",
          available: true,
          blob,
          savedAt: Date.now(),
        });
        await refreshOfflineList();
        finishJobPopup(series.title, "Tek dosya olarak çevrimdışı kaydedildi!");
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${series.title}.mp3`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        finishJobPopup(series.title, "Birleştirilmiş MP3 cihaza indirildi!");
      }
    } catch (e) {
      document.getElementById("job-popup").classList.add("hidden");
      showToast("Birleştirme başarısız: " + e.message);
    } finally {
      prog.classList.add("hidden");
    }
  }

  async function refreshOfflineList() {
    state.offlineMeta = await offlineDB.listAllMeta();
    state.offlineKeys = new Set(state.offlineMeta.map((x) => x.id));
    if (state.category === "offline") renderGrid();
  }

  // --- Series Modal ---
  function openSeriesModal(series) {
    sfx.click(580);
    state.activeSeries = series;
    document.getElementById("series-cover").src = series.cover;
    document.getElementById("series-title").textContent = series.title;
    const durStr = fmtTime(series.total_duration_seconds);
    document.getElementById("series-meta").textContent =
      `${series.available_count}/${series.episode_count} erişilebilir bölüm • Toplam ${durStr}` +
      (series.rating ? ` • ★ ${series.rating}` : "");
    applyCoverColor(series.cover);

    const list = document.getElementById("series-episodes");
    list.innerHTML = "";
    series.episodes.forEach((ep, idx) => {
      const row = document.createElement("div");
      row.className = `ep-row ${ep.available ? "" : "unavail"}`;
      row.innerHTML = `
        <span class="ep-num">${ep.episode || idx + 1}</span>
        <span class="ep-title">${ep.title} — Bölüm ${ep.episode || idx + 1}</span>
        <span class="ep-dur">${ep.duration || "--:--"}</span>
      `;
      row.onclick = () => playItem(ep, series.episodes, idx);
      list.appendChild(row);
    });

    document.getElementById("btn-series-play").onclick = () => {
      const firstIdx = series.episodes.findIndex((e) => e.available);
      if (firstIdx >= 0) playItem(series.episodes[firstIdx], series.episodes, firstIdx);
    };
    document.getElementById("btn-series-offline").onclick = () => mergeSeries(series, true);
    document.getElementById("btn-series-download").onclick = () => mergeSeries(series, false);
    els.seriesModal.classList.remove("hidden");
  }

  // --- Render Grid ---
  function renderGrid() {
    const q = state.search.trim().toLocaleLowerCase("tr");
    let items = [];

    if (state.category === "radyo_tiyatrosu") items = state.catalog.radyo_tiyatrosu;
    else if (state.category === "cocuklar") items = state.catalog.cocuklar;
    else if (state.category === "arkasi_yarin") items = state.catalog.arkasi_yarin_series;
    else if (state.category === "offline") items = state.offlineMeta;
    else if (state.category === "favorites") {
      const allSingles = [...state.catalog.radyo_tiyatrosu, ...state.catalog.cocuklar];
      const favSingles = allSingles.filter((x) => state.favorites.has(x.id) || state.progress[x.id]);
      items = favSingles;
    }

    const isSeries = state.category === "arkasi_yarin";

    // Filter
    items = items.filter((item) => {
      if (q && !item.title.toLocaleLowerCase("tr").includes(q)) return false;
      if (isSeries) {
        if (state.filter === "available" && item.available_count === 0) return false;
        if (state.filter === "audio" && !item.has_audio) return false;
        if (state.filter === "youtube" && !item.has_youtube) return false;
        return true;
      } else {
        if (state.filter === "available" && !item.available) return false;
        if (state.filter === "audio" && item.source_type !== "audio") return false;
        if (state.filter === "youtube" && item.source_type !== "youtube") return false;
        return true;
      }
    });

    // Sort
    items = [...items].sort((a, b) => {
      if (state.sort === "title_asc") return a.title.localeCompare(b.title, "tr");
      if (state.sort === "title_desc") return b.title.localeCompare(a.title, "tr");
      if (state.sort === "duration_desc") {
        return (b.total_duration_seconds || b.duration_seconds || 0) - (a.total_duration_seconds || a.duration_seconds || 0);
      }
      if (state.sort === "duration_asc") {
        return (a.total_duration_seconds || a.duration_seconds || 999999) - (b.total_duration_seconds || b.duration_seconds || 999999);
      }
      if (state.sort === "rating_desc") return (b.rating || 0) - (a.rating || 0);
      return 0;
    });

    els.count.textContent = `${items.length} kayıt`;
    els.grid.innerHTML = "";

    if (!items.length) {
      els.grid.innerHTML = `<div class="loading-state">Eşleşen kayıt bulunamadı.</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach((item, idx) => {
      const card = document.createElement("article");
      const avail = isSeries ? item.available_count > 0 : item.available;
      card.className = `card ${avail ? "" : "unavailable"}`;

      const prog = state.progress[item.id];
      const progPct = prog && prog.d > 0 ? Math.min(100, (prog.t / prog.d) * 100) : 0;
      const isOff = state.offlineKeys.has(item.id);
      const badgeHtml = isOff
        ? `<span class="badge off">Çevrimdışı</span>`
        : (!isSeries && item.source_type === "youtube" ? `<span class="badge yt">YT SES</span>` : "");

      const durText = isSeries
        ? `${item.available_count}/${item.episode_count} blm`
        : (item.duration || "--:--");

      card.innerHTML = `
        <div class="card-art">
          <img src="${item.cover}" data-fb="${item.cover_url || ""}" onerror="if(this.dataset.fb && this.src!==this.dataset.fb)this.src=this.dataset.fb" alt="${item.title}" loading="lazy" />
          <div class="card-badges">
            ${badgeHtml}
            ${item.rating ? `<span class="badge">★ ${item.rating}</span>` : ""}
          </div>
          <div class="card-play-overlay"><svg viewBox="0 0 24 24" fill="currentColor">${PLAY_SVG}</svg></div>
        </div>
        ${progPct > 0 ? `<div class="card-prog"><div class="card-prog-fill" style="width:${progPct}%"></div></div>` : ""}
        <div class="card-body">
          <div class="card-title">${item.title}</div>
          <div class="card-meta">
            <span>${durText}</span>
            <span>${isSeries ? fmtTime(item.total_duration_seconds) : (avail ? "Hazır" : "Kırık")}</span>
          </div>
        </div>
      `;

      card.onclick = () => {
        if (isSeries) openSeriesModal(item);
        else playItem(item, items, idx);
      };
      frag.appendChild(card);
    });
    els.grid.appendChild(frag);
  }

  // --- Wire UI Events ---
  document.querySelectorAll(".cat-tab").forEach((btn) => {
    btn.onclick = () => {
      sfx.click(660);
      document.querySelectorAll(".cat-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.category = btn.dataset.cat;
      renderGrid();
    };
  });

  document.querySelectorAll(".pill").forEach((btn) => {
    btn.onclick = () => {
      sfx.click(580);
      document.querySelectorAll(".pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.filter = btn.dataset.filter;
      renderGrid();
    };
  });

  els.search.addEventListener("input", (e) => { state.search = e.target.value; renderGrid(); });
  els.sort.addEventListener("change", (e) => { sfx.click(560); state.sort = e.target.value; renderGrid(); });

  // Theme & SFX toggles
  const themes = ["obsidian", "sepia", "indigo"];
  document.getElementById("btn-theme").onclick = () => {
    sfx.click(720);
    const next = themes[(themes.indexOf(state.theme) + 1) % themes.length];
    applyTheme(next);
    showToast(`Tema: ${next === "obsidian" ? "Obsidyen" : next === "sepia" ? "Sepya Kitap" : "Gece Mavisi"}`);
  };
  const sfxBtn = document.getElementById("btn-sfx");
  sfxBtn.classList.toggle("active", sfx.enabled);
  sfxBtn.onclick = () => {
    sfx.enabled = !sfx.enabled;
    localStorage.setItem("zen_sfx", sfx.enabled ? "1" : "0");
    sfxBtn.classList.toggle("active", sfx.enabled);
    if (sfx.enabled) sfx.click(740);
    showToast(sfx.enabled ? "Tıklama sesleri açık" : "Tıklama sesleri kapalı");
  };

  // Player UI controls
  document.getElementById("mp-open-full").onclick = () => { sfx.click(600); els.full.classList.remove("hidden"); };
  document.getElementById("fp-minimize").onclick = () => { sfx.click(520); els.full.classList.add("hidden"); };
  document.getElementById("close-series-modal").onclick = () => { sfx.click(520); els.seriesModal.classList.add("hidden"); };
  els.seriesModal.onclick = (e) => { if (e.target === els.seriesModal) els.seriesModal.classList.add("hidden"); };

  document.getElementById("fp-play").onclick = togglePlay;
  document.getElementById("mp-play").onclick = togglePlay;
  document.getElementById("fp-back15").onclick = () => seekBy(-15);
  document.getElementById("mp-back15").onclick = () => seekBy(-15);
  document.getElementById("fp-fwd30").onclick = () => seekBy(30);
  document.getElementById("fp-prev").onclick = () => { sfx.click(560); playPrevInQueue(); };
  document.getElementById("fp-next").onclick = () => { sfx.click(560); playNextInQueue(); };
  document.getElementById("fp-fav").onclick = () => state.currentItem && toggleFav(state.currentItem.id);
  document.getElementById("fp-offline-save").onclick = () => saveSingleOffline(state.currentItem);
  document.getElementById("fp-download").onclick = () => downloadSingleFile(state.currentItem);

  document.getElementById("fp-seek").addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    if (state.mode === "audio") els.audio.currentTime = val;
    else if (state.ytPlayer) state.ytPlayer.seekTo(val, true);
  });

  const speedBtn = document.getElementById("fp-speed");
  speedBtn.textContent = `${state.speed}x`;
  speedBtn.onclick = () => {
    sfx.click(660);
    state.speed = state.speeds[(state.speeds.indexOf(state.speed) + 1) % state.speeds.length];
    localStorage.setItem("zen_speed", state.speed);
    speedBtn.textContent = `${state.speed}x`;
    els.audio.playbackRate = state.speed;
    if (state.ytPlayer && typeof state.ytPlayer.setPlaybackRate === "function") state.ytPlayer.setPlaybackRate(state.speed);
  };

  const sleepOptions = [0, 15, 30, 45, 60];
  document.getElementById("fp-sleep").onclick = () => {
    sfx.click(660);
    state.sleepMinutes = sleepOptions[(sleepOptions.indexOf(state.sleepMinutes) + 1) % sleepOptions.length];
    clearInterval(state.sleepTimerId);
    const lbl = document.getElementById("fp-sleep-label");
    if (state.sleepMinutes > 0) {
      lbl.textContent = `${state.sleepMinutes} dk`;
      state.sleepTimerId = setInterval(() => {
        state.sleepMinutes -= 1;
        if (state.sleepMinutes <= 0) {
          clearInterval(state.sleepTimerId);
          if (state.isPlaying) togglePlay();
          lbl.textContent = "";
          showToast("Uyku zamanlayıcısı: Oynatma durduruldu");
        } else {
          lbl.textContent = `${state.sleepMinutes} dk`;
        }
      }, 60000);
      showToast(`Uyku zamanlayıcı: ${state.sleepMinutes} dakika`);
    } else {
      lbl.textContent = "";
      showToast("Uyku zamanlayıcı kapatıldı");
    }
  };

  window.app = {
    navigate(cat) {
      document.querySelector(`.cat-tab[data-cat="${cat}"]`)?.click();
    }
  };

  // --- Boot ---
  async function init() {
    applyTheme(state.theme);
    await refreshOfflineList();
    try {
      const res = await fetch("/api/catalog");
      state.catalog = await res.json();
      const totalPubs =
        (state.catalog.radyo_tiyatrosu?.length || 0) +
        (state.catalog.arkasi_yarin_series?.length || 0) +
        (state.catalog.cocuklar?.length || 0);
      document.getElementById("brand-total").textContent = `Toplam: ${totalPubs} Yayın`;
      renderGrid();
    } catch (e) {
      els.grid.innerHTML = `<div class="loading-state">Katalog yüklenemedi. Sunucunun çalıştığından emin olun.</div>`;
    }
  }
  init();
})();
