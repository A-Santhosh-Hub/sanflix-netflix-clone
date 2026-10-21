(function (root) {
  "use strict";
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const LIST_ID = /^[A-Za-z0-9_-]{10,80}$/;
  const HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com"];
  const STORE = "sanflix_youtube";

  function parseYouTube(text) {
    const value = String(text || "").trim();
    if (!value || /\s/.test(value)) return null;
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
    } catch (_) {
      return null;
    }
    const host = url.hostname.replace(/^(?:www|m|music)\./, "");
    if (!HOSTS.includes(host)) return null;
    const list = url.searchParams.get("list");
    const validList = list && LIST_ID.test(list) ? list : null;
    let id = null;
    if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
    else if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?]+)/);
      id = match && match[1];
    }
    if (id && VIDEO_ID.test(id)) return { kind: "video", id, list: validList };
    if (validList) return { kind: "playlist", id: validList };
    return null;
  }

  function embedURL(item) {
    if (!item || (item.kind === "playlist" ? !LIST_ID.test(item.id) : !VIDEO_ID.test(item.id)))
      throw new Error("Invalid YouTube video or playlist");
    const base = "https://www.youtube-nocookie.com/embed/";
    const options = "autoplay=1&rel=0&playsinline=1";
    if (item.kind === "playlist")
      return `${base}videoseries?list=${item.id}&${options}`;
    // A shared watch link often includes a playlist. Only play that one video
    // unless the student explicitly opens a playlist link.
    return `${base}${item.id}?${options}`;
  }

  const api = { parseYouTube, embedURL };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }
  root.SanflixYouTube = api;

  document.addEventListener("DOMContentLoaded", () => {
    const { requestJSON } = root.Sanflix;
    const $ = (id) => document.getElementById(id);
    const form = $("yt-form"),
      input = $("yt-input"),
      status = $("yt-status");
    let mode = "videos", browseState = null, hasMore = false;
    const browseStack = [];
    let returnFocus = null, queue = [];
    const recentKey = STORE + "_searches";
    function readRecent() {
      try { const list = JSON.parse(localStorage.getItem(recentKey) || "[]"); return Array.isArray(list) ? list.filter(x => x && typeof x.query === "string" && ["videos", "channels", "playlists"].includes(x.mode)).slice(0, 8) : []; }
      catch (_) { return []; }
    }
    function renderRecent() {
      $("yt-recent").replaceChildren(...readRecent().map(item => {
        const button = document.createElement("button"); button.type = "button";
        button.textContent = item.query; button.setAttribute("aria-label", "Search again: " + item.query);
        button.onclick = () => { input.value = item.query; setMode(item.mode); search(item.query, false); };
        return button;
      }));
    }
    function setMode(value) {
      mode = value;
      $("yt-modes").querySelectorAll("[data-mode]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.mode === mode)));
    }
    let current = null;
    let results = [];
    let searchGeneration = 0;
    let playbackGeneration = 0;
    let nativeMedia = null;
    let streamOffset = 0;

    const readSaved = () => {
      try {
        const list = JSON.parse(localStorage.getItem(STORE) || "[]");
        return Array.isArray(list)
          ? list.filter((x) => x && VIDEO_ID.test(x.id))
          : [];
      } catch (_) {
        return [];
      }
    };
    const writeSaved = (list) => {
      try {
        localStorage.setItem(STORE, JSON.stringify(list.slice(0, 50)));
      } catch (_) {}
    };
    const thumb = (item) => {
      try { const url = new URL(item.thumbnail); if (url.protocol === "https:" && ["i.ytimg.com", "yt3.ggpht.com", "yt3.googleusercontent.com"].includes(url.hostname)) return url.href; } catch (_) {}
      return (!item.kind || item.kind === "video") && VIDEO_ID.test(item.id) ? `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg` : "";
    };

    function card(item, onRemove) {
      const article = document.createElement("article");
      article.className = "yt-card";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "yt-card-open";
      const image = document.createElement($("yt-previews").checked && thumb(item) ? "img" : "span");
      if ($("yt-previews").checked && thumb(item)) {
        image.src = thumb(item);
        image.alt = "";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
      } else {
        image.className = "yt-preview-placeholder";
        image.textContent = item.kind === "channel" ? "Channel" : item.kind === "playlist" ? "Course / playlist" : "Play lesson";
        image.setAttribute("aria-hidden", "true");
      }
      const title = document.createElement("strong");
      title.textContent = item.title || "YouTube video";
      const channel = document.createElement("span");
      channel.textContent = (item.channel || "") + (item.duration ? " ? " + clock(item.duration) : "");
      open.append(image, title, channel);
      open.addEventListener("click", () => {
        returnFocus = open;
        if (item.kind === "channel" || item.kind === "playlist") openCollection(item);
        else { queue = results.filter(x => !x.kind || x.kind === "video"); play({ ...item, kind: "video" }); }
      });
      article.append(open);
      if (onRemove) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "yt-card-remove";
        remove.setAttribute("aria-label", "Remove " + (item.title || "video"));
        remove.textContent = "×";
        remove.addEventListener("click", onRemove);
        article.append(remove);
      }
      return article;
    }

    function renderSaved() {
      const saved = readSaved();
      $("yt-saved").replaceChildren(
        ...saved.map((item) =>
          card(item, () => {
            writeSaved(readSaved().filter((x) => x.id !== item.id));
            renderSaved();
            updateSaveButton();
          }),
        ),
      );
      $("yt-saved-empty").classList.toggle("hidden", saved.length > 0);
    }

    function updateSaveButton() {
      const button = $("yt-save");
      const isVideo = current && current.kind === "video";
      button.classList.toggle("hidden", !isVideo);
      if (!isVideo) return;
      button.textContent = readSaved().some((x) => x.id === current.id)
        ? "✓ Saved"
        : "+ Save";
    }

    function stopLoading() {
      ++playbackGeneration;
      const video = $("yt-frame").querySelector("video");
      if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
      $("yt-frame").replaceChildren();
      nativeMedia = null;
      $("yt-timeline").classList.add("hidden");
      $("yt-load").classList.remove("hidden");
      $("yt-stop").classList.add("hidden");
    }

    function play(item, load = true, official = false) {
      ++searchGeneration;
      $("yt-more").disabled = false;
      $("yt-results-section").removeAttribute("aria-busy");
      stopLoading();
      current = item;
      updateNext();
      if (load && official) {
      const frame = document.createElement("iframe");
      frame.src = embedURL(item);
      frame.title = item.title || "YouTube video";
      frame.allow =
        "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen";
      frame.allowFullscreen = true;
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      $("yt-frame").replaceChildren(frame);
      $("yt-load").classList.add("hidden");
      $("yt-stop").classList.remove("hidden");
      }
      $("yt-player-title").textContent =
        item.title ||
        (item.kind === "playlist" ? "YouTube playlist" : "YouTube video");
      $("yt-player").classList.remove("hidden");
      $("yt-original").href = item.kind === "playlist"
        ? "https://www.youtube.com/playlist?list=" + item.id
        : "https://www.youtube.com/watch?v=" + item.id;
      status.textContent = item.kind === "playlist"
        ? "Playlists may continue to the next lesson automatically. Use Stop loading when finished."
        : load ? "Preparing the lesson…"
          : "Video ready. No player loaded yet. Press Load video when you want to connect.";
      updateSaveButton();
      if (load) $("yt-player").scrollIntoView({ behavior: "smooth", block: "start" });
      try {
        history.replaceState(
          null,
          "",
          "#" + (item.kind === "playlist" ? "list=" : "v=") + item.id,
        );
      } catch (_) {}
      if (load && !official) { if (item.kind === "playlist") { $("yt-player").classList.add("hidden"); openCollection(item); } else loadNative(item); }
      if (official) status.textContent = "YouTube's official player is active. It may show ads and uses internet data.";
    }

    async function loadNative(item, start = 0, autoplay = true) {
      stopLoading();
      const generation = playbackGeneration;
      if (item.kind !== "video") {
        status.textContent = "Paste one lesson's video link for TV playback. Whole playlists use the optional YouTube player.";
        return;
      }
      $("yt-stop").classList.remove("hidden");
      $("yt-load").classList.add("hidden");
      status.textContent = "Preparing the TV stream…";
      try {
        const media = await requestJSON(`/api/youtube/resolve/${item.id}?quality=${$("yt-quality").value}`);
        if (generation !== playbackGeneration) return;
        nativeMedia = media;
        current = {...item, title: media.title};
        $("yt-player-title").textContent = media.title;
        const video = document.createElement("video");
        video.controls = true;
        video.setAttribute("controlsList", "nodownload");
        video.playsInline = true;
        video.preload = "none";
        video.setAttribute("aria-label", media.title);
        $("yt-frame").replaceChildren(video);
        $("yt-timeline").classList.remove("hidden");
        $("yt-seek").max = String(media.duration);
        video.addEventListener("timeupdate", () => {
          const position = Math.min(media.duration, streamOffset + (video.currentTime || 0));
          $("yt-seek").value = position;
          $("yt-time").textContent = `${clock(position)} / ${clock(media.duration)} · ${media.height}p`;
          $("yt-seek").setAttribute("aria-valuetext", `${clock(position)} of ${clock(media.duration)}`);
        });
        video.addEventListener("error", () => {
          if (generation !== playbackGeneration) return;
          stopLoading();
          status.textContent = "This stream could not play. Retry, choose a different quality, or select another lesson. The YouTube player is an optional alternative.";
        });
        video.addEventListener("ended", () => {
          status.textContent = "Lesson finished. Choose another lesson when ready.";
          if ($("yt-autonext").checked) playNext();
        });
        startNative(start, autoplay);
        status.textContent = `TV player · ${media.height}p · Internet required. No extension or extra TV app needed.`;
        video.focus();
      } catch (error) {
        if (generation !== playbackGeneration) return;
        stopLoading();
        status.textContent = error.message;
      }
    }

    function clock(seconds) {
      const value = Math.max(0, Math.floor(seconds));
      return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
    }

    function startNative(position, autoplay = true) {
      const video = $("yt-frame").querySelector("video");
      if (!video || !nativeMedia) return;
      streamOffset = Math.max(0, Math.min(position, nativeMedia.duration - 0.1));
      video.src = nativeMedia.stream + '&start=' + streamOffset;
      $("yt-seek").value = streamOffset;
      $("yt-time").textContent = `${clock(streamOffset)} / ${clock(nativeMedia.duration)} · ${nativeMedia.height}p`;
      if (autoplay) video.play().catch(() => { status.textContent = "Press Play on the video to start the lesson."; });
    }

    $("yt-seek").addEventListener("change", () => {
      const video = $("yt-frame").querySelector("video");
      startNative(Number($("yt-seek").value), video ? !video.paused : true);
    });
    $("yt-quality").addEventListener("change", () => {
      const video = $("yt-frame").querySelector("video");
      if (video && current) loadNative(current, streamOffset + (video.currentTime || 0), !video.paused);
    });
    $("yt-official").addEventListener("click", () => { if (current) play(current, true, true); });

    $("yt-stop").addEventListener("click", () => {
      stopLoading();
      status.textContent = "Player unloaded. Press Load video to reopen it from the beginning.";
    });
    $("yt-load").addEventListener("click", () => { if (current) play(current); });
    $("yt-previews").addEventListener("change", () => {
      renderSaved();
      $("yt-results").replaceChildren(...results.map((item) => card(item)));
    });
    root.addEventListener("pagehide", stopLoading);

    $("yt-save").addEventListener("click", () => {
      if (!current || current.kind !== "video") return;
      const saved = readSaved();
      const exists = saved.some((x) => x.id === current.id);
      writeSaved(
        exists
          ? saved.filter((x) => x.id !== current.id)
          : [
              {
                id: current.id,
                title: current.title || $("yt-player-title").textContent,
                channel: current.channel || "",
                thumbnail: current.thumbnail || "",
              },
              ...saved,
            ],
      );
      renderSaved();
      updateSaveButton();
    });

    function renderResults() {
      $("yt-results").replaceChildren(...results.map(item => card(item)));
      $("yt-results-section").classList.remove("hidden");
      $("yt-results-title").textContent = browseState ? browseState.title : "Results";
      $("yt-back").classList.toggle("hidden", !browseStack.length);
      $("yt-more").classList.toggle("hidden", !hasMore);
    }
    async function browse(state, append = false) {
      const generation = ++searchGeneration;
      stopLoading(); $("yt-player").classList.add("hidden");
      status.textContent = "Loading " + state.title + "...";
      $("yt-more").disabled = true;
      $("yt-results-section").setAttribute("aria-busy", "true");
      try {
        const params = new URLSearchParams({mode: state.mode, q: state.query || "", id: state.id || "", page: String(state.page)});
        const response = await requestJSON("/api/youtube/browse?" + params);
        if (generation !== searchGeneration) return;
        const previousCount = append ? results.length : 0;
        const combined = append ? [...results, ...response.results] : response.results;
        results = combined.filter((item, index) => combined.findIndex(x => x.id === item.id && x.kind === item.kind) === index);
        browseState = state; hasMore = !!response.has_more;
        renderResults();
        status.textContent = results.length ? "Choose a result. Use Show more to keep browsing." : "No results found. Try another topic.";
        const cards = $("yt-results").querySelectorAll(".yt-card-open");
        if (cards.length) cards[Math.min(previousCount, cards.length - 1)].focus();
      } catch (error) {
        if (generation === searchGeneration) status.textContent = error.message;
      } finally {
        if (generation === searchGeneration) { $("yt-more").disabled = false; $("yt-results-section").removeAttribute("aria-busy"); }
      }
    }
    function openCollection(item) {
      if (browseState) browseStack.push({state: browseState, results: results.slice(), hasMore});
      if (browseStack.length > 20) browseStack.shift();
      browse({mode: item.kind, id: item.id, title: item.title || "Playlist", page: 1});
    }
    function search(query, addLanguage = true) {
      const language = $("yt-language").value;
      const actualQuery = (query + (addLanguage && language ? " " + language : "")).trim();
      try { localStorage.setItem(recentKey, JSON.stringify([{query: actualQuery, mode}, ...readRecent().filter(x => x.query !== actualQuery || x.mode !== mode)].slice(0, 8))); } catch (_) {}
      renderRecent(); browseStack.length = 0;
      browse({mode, query: actualQuery, title: actualQuery, page: 1});
    }
    function goBack() {
      if (!$("yt-player").classList.contains("hidden")) {
        stopLoading(); $("yt-player").classList.add("hidden");
        try { history.replaceState(null, "", location.pathname); } catch (_) {}
        if (returnFocus && returnFocus.isConnected) returnFocus.focus(); else input.focus();
        return true;
      }
      if (browseStack.length) {
        ++searchGeneration;
        const previous = browseStack.pop(); browseState = previous.state; results = previous.results; hasMore = previous.hasMore;
        renderResults(); $("yt-results-section").removeAttribute("aria-busy"); $("yt-more").disabled = false;
        status.textContent = "";
        const first = $("yt-results").querySelector("button"); if (first) first.focus();
        return true;
      }
      return false;
    }
    function nextItem() { const index = queue.findIndex(x => current && x.id === current.id); return index >= 0 ? queue[index + 1] : null; }
    function updateNext() { $("yt-next").classList.toggle("hidden", !nextItem()); }
    function playNext() { const item = nextItem(); if (item) play({...item, kind: "video"}); }
    $("yt-next").onclick = playNext;
    $("yt-player-back").onclick = goBack;
    $("yt-back").onclick = goBack;
    root.addEventListener("sanflix-tv-back", event => { if (goBack()) event.preventDefault(); });
    $("yt-more").onclick = () => { if (browseState && hasMore) browse({...browseState, page: browseState.page + 1}, true); };
    $("yt-modes").querySelectorAll("[data-mode]").forEach(button => button.onclick = () => { setMode(button.dataset.mode); if (input.value.trim()) search(input.value.trim()); });
    $("yt-topics").querySelectorAll("[data-query]").forEach(button => button.onclick = () => { input.value = button.dataset.query; search(input.value); });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const parsed = parseYouTube(text);
      if (parsed) {
        status.textContent = "";
        play(parsed);
      } else search(text);
    });

    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get("v") && VIDEO_ID.test(hash.get("v")))
      play({ kind: "video", id: hash.get("v") }, false);
    else if (hash.get("list") && LIST_ID.test(hash.get("list")))
      play({ kind: "playlist", id: hash.get("list") }, false);
    renderSaved();
    renderRecent();
  });
})(typeof window !== "undefined" ? window : globalThis);
