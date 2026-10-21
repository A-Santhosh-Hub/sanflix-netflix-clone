(function (root) {
  "use strict";
  // SANFLIX Hub: media chosen on THIS device is played from local object URLs.
  // This file contains no network code on purpose; the page also forbids network access.

  const VIDEO_EXT = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "flv", "3gp", "3g2", "mpg", "mpeg", "ogv", "ts", "mts", "m2ts"]);
  const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff", "svg"]);
  const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma", "amr", "aif", "aiff"]);
  const KIND_LABEL = { video: "Video", image: "Photo", audio: "Audio" };
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const MAX_ITEMS = 1000;
  const THUMB_WIDTH = 360;
  const THUMB_TIMEOUT = 4000;
  const THUMB_WORKERS = 3;
  const PREVIOUS_KEY = "sanflix_hub_previous_count";

  // ---------- pure helpers (also used by the tests) ----------
  function extensionOf(name) {
    const dot = String(name).lastIndexOf(".");
    return dot > 0 ? String(name).slice(dot + 1).toLowerCase() : "";
  }
  function folderOf(file) {
    const relative = String(file.webkitRelativePath || "");
    const slash = relative.lastIndexOf("/");
    return slash > 0 ? relative.slice(0, slash) : "";
  }
  function isHiddenOrSystem(file) {
    const parts = String(file.webkitRelativePath || file.name).split("/");
    return (
      parts.some((part) => part.startsWith(".") || part === "__MACOSX") ||
      /^(thumbs\.db|desktop\.ini)$/i.test(file.name)
    );
  }
  function classify(file) {
    if (!file || isHiddenOrSystem(file)) return null;
    const mime = String(file.type || "").toLowerCase();
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    const ext = extensionOf(file.name);
    if (VIDEO_EXT.has(ext)) return "video";
    if (IMAGE_EXT.has(ext)) return "image";
    if (AUDIO_EXT.has(ext)) return "audio";
    return null;
  }
  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 ** 2) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + " MB";
    return (n / 1024 ** 3).toFixed(2) + " GB";
  }
  function matches(item, filter, query) {
    if (filter !== "all" && item.kind !== filter) return false;
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = (item.folder + "/" + item.name).toLowerCase();
    return words.every((word) => haystack.includes(word));
  }

  const api = { classify, formatSize, matches, folderOf, extensionOf, isHiddenOrSystem };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }
  root.SanflixHubHelpers = api;

  // ---------- the Hub ----------
  function start() {
    const doc = root.document;
    const $ = (id) => doc.getElementById(id);
    const library = $("hub-library"),
      notice = $("hub-notice");
    if (!library) return;
    const state = { items: [], filter: "all", query: "", activeId: null, muted: true };
    let nextId = 1,
      mounted = null,
      thumbObserver = null,
      thumbActive = 0;
    const tiles = new Map(),
      thumbQueue = [],
      leases = new Map();
    const viewer = $("hub-viewer"),
      stage = $("hub-viewer-stage");
    if (root.IntersectionObserver) {
      thumbObserver = new root.IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = state.items.find((candidate) => String(candidate.id) === entry.target.dataset.id);
          if (item) requestThumb(item);
          thumbObserver.unobserve(entry.target);
        }
      }, { rootMargin: "300px" });
    }

    // Object URLs are reference counted so one is never revoked while a player or a
    // thumbnail job still depends on it.
    function acquire(item) {
      let lease = leases.get(item.id);
      if (!lease) {
        lease = { url: root.URL.createObjectURL(item.file), count: 0 };
        leases.set(item.id, lease);
      }
      lease.count += 1;
      return lease.url;
    }
    function release(item) {
      const lease = leases.get(item.id);
      if (!lease) return;
      lease.count -= 1;
      if (lease.count <= 0) {
        leases.delete(item.id);
        root.URL.revokeObjectURL(lease.url);
      }
    }

    function el(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function icon(kind) {
      const ns = "http://www.w3.org/2000/svg";
      const svg = doc.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("class", "hub-icon");
      const path = doc.createElementNS(ns, "path");
      path.setAttribute("d", kind === "video" ? "m8 5 11 7-11 7Z" : kind === "audio" ? "M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3Zm10-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z" : "M4 5h16v14H4ZM4 16l5-5 4 4 3-3 4 4");
      svg.append(path);
      return svg;
    }
    let noticeTimer = null;
    function say(message) {
      notice.textContent = message;
      notice.hidden = !message;
      root.clearTimeout(noticeTimer);
      if (message) noticeTimer = root.setTimeout(() => { notice.hidden = true; }, 9000);
    }
    // Sharing is announced with DOM events. The Shared Hub script handles them; this file never
    // sends anything anywhere and never reads a file's contents.
    const announce = (name, detail) => doc.dispatchEvent(new root.CustomEvent(name, { detail }));
    const shareDetail = (item) => ({ id: item.id, name: item.name, size: item.size, kind: item.kind, mime: item.file.type || "", file: item.file });
    const sharedButtons = new Map();
    function paintShareButton(button, item) {
      button.textContent = item.shared ? "Stop sharing" : "Share to Hub";
      button.setAttribute("aria-pressed", String(item.shared));
      button.setAttribute("aria-label", (item.shared ? "Stop sharing " : "Share to Hub: ") + item.name);
      button.classList.toggle("hub-shared", item.shared);
    }
    function shareButton(item) {
      const button = el("button", "hub-share");
      button.type = "button";
      paintShareButton(button, item);
      if (!sharedButtons.has(item.id)) sharedButtons.set(item.id, new Set());
      sharedButtons.get(item.id).add(button);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (item.shared) announce("hub:unshare", { id: item.id });
        else announce("hub:share", { items: [shareDetail(item)] });
      });
      return button;
    }
    function markShared(id, value) {
      const item = state.items.find((entry) => entry.id === id);
      if (!item) return;
      item.shared = Boolean(value);
      for (const button of sharedButtons.get(id) || []) paintShareButton(button, item);
      const tile = tiles.get(id);
      if (tile) tile.classList.toggle("hub-is-shared", item.shared);
    }
    function updateSelection() {
      const chosen = state.items.filter((item) => item.selected && !item.shared);
      const bar = $("hub-share-selected");
      bar.hidden = chosen.length === 0;
      $("hub-selected-count").textContent = String(chosen.length);
    }
    const typeLabel = (item) => KIND_LABEL[item.kind] + (item.ext ? " · " + item.ext.toUpperCase() : "");
    const visible = () => state.items.filter((item) => matches(item, state.filter, state.query));

    // ---------- importing ----------
    function importFiles(files, fromFolder) {
      const list = Array.from(files || []);
      if (!list.length) {
        say(fromFolder
          ? "That folder is empty, or this browser did not return its files. Try Select Files instead."
          : "No files were selected.");
        return;
      }
      const known = new Set(state.items.map((item) => item.key));
      let added = 0, skipped = 0, duplicates = 0, truncated = false;
      const counts = { video: 0, image: 0, audio: 0 };
      for (const file of list) {
        const kind = classify(file);
        if (!kind) { skipped += 1; continue; }
        const folder = folderOf(file);
        const key = [folder, file.name, file.size, file.lastModified].join("|");
        if (known.has(key)) { duplicates += 1; continue; }
        if (state.items.length >= MAX_ITEMS) { truncated = true; continue; }
        known.add(key);
        state.items.push({
          id: nextId++, key, file, kind, folder, name: file.name, size: file.size,
          ext: extensionOf(file.name), speed: 1, thumb: null, thumbState: "idle", removed: false, shared: false, selected: false,
        });
        counts[kind] += 1;
        added += 1;
      }
      const parts = [];
      if (fromFolder && list.every((file) => !file.webkitRelativePath))
        parts.push("This browser selected individual files, not a whole folder, so it could not read the folder structure.");
      if (added) {
        const detail = ["video", "image", "audio"].filter((k) => counts[k]).map((k) => counts[k] + " " + KIND_LABEL[k].toLowerCase() + (counts[k] === 1 ? "" : "s"));
        parts.push("Added " + added + " item" + (added === 1 ? "" : "s") + " (" + detail.join(", ") + ").");
      } else {
        parts.push("No supported media found. Hub plays video, photo and audio files.");
      }
      if (skipped) parts.push(skipped + " unsupported file" + (skipped === 1 ? "" : "s") + " skipped.");
      if (duplicates) parts.push(duplicates + " already added.");
      if (truncated) parts.push("Limit of " + MAX_ITEMS + " items reached.");
      say(parts.join(" "));
      closeDialog();
      render();
    }

    // ---------- removing ----------
    function dropTile(id) {
      const tile = tiles.get(id);
      if (tile) { if (thumbObserver) thumbObserver.unobserve(tile); tile.remove(); tiles.delete(id); }
      sharedButtons.delete(id);
    }
    function removeItem(id) {
      const index = state.items.findIndex((item) => item.id === id);
      if (index < 0) return;
      const item = state.items[index];
      if (state.activeId === id) closeViewer();
      item.removed = true;
      if (item.thumb) { root.URL.revokeObjectURL(item.thumb); item.thumb = null; }
      state.items.splice(index, 1);
      dropTile(id);
      announce("hub:item-removed", { ids: [id] });
      render();
      updateSelection();
    }
    function clearAll() {
      closeViewer();
      announce("hub:item-removed", { ids: state.items.map((item) => item.id) });
      for (const item of state.items) {
        item.removed = true;
        if (item.thumb) root.URL.revokeObjectURL(item.thumb);
        item.thumb = null;
      }
      for (const id of [...tiles.keys()]) dropTile(id);
      state.items = [];
      say("Cleared. Nothing was stored.");
      render();
      updateSelection();
    }

    // ---------- playback (one real media element at a time) ----------
    function applySpeed(media, item) {
      media.defaultPlaybackRate = item.speed;
      media.playbackRate = item.speed;
    }
    function mount(item) {
      if (viewer.hidden || (mounted && mounted.item.id === item.id)) return;
      unmount();
      const url = acquire(item);
      let media;
      if (item.kind === "image") {
        media = el("img", "hub-media");
        media.alt = item.name;
      } else {
        media = el(item.kind === "video" ? "video" : "audio", "hub-media hub-" + item.kind);
        media.controls = true;
        media.preload = "metadata";
        if (item.kind === "video") {
          media.playsInline = true;
          media.loop = true;
          media.muted = state.muted;
        }
        media.addEventListener("volumechange", () => { if (item.kind === "video") state.muted = media.muted; });
        media.addEventListener("loadedmetadata", () => applySpeed(media, item));
      }
      media.addEventListener("error", () => showUnsupported(item, stage), { once: true });
      mounted = { item, media, stage, url, panel: null };
      stage.classList.add("hub-live");
      stage.append(media);
      media.src = url;
      if (item.kind !== "image") applySpeed(media, item);
      if (item.kind === "video") {
        const attempt = media.play && media.play();
        if (attempt && attempt.catch) attempt.catch(() => { media.muted = true; state.muted = true; const retry = media.play && media.play(); if (retry && retry.catch) retry.catch(() => {}); });
      }
    }
    function showUnsupported(item, stage) {
      if (!mounted || mounted.item.id !== item.id) return;
      if (mounted.media) { stopMedia(mounted.media); mounted.media.remove(); mounted.media = null; }
      const panel = el("div", "hub-unsupported");
      panel.setAttribute("role", "alert");
      panel.append(icon(item.kind), el("strong", "", "This browser can't play this file"));
      panel.append(el("p", "", item.name + " · " + formatSize(item.size) + (item.ext ? " · ." + item.ext : "")));
      panel.append(el("p", "hub-unsupported-hint", item.kind === "image"
        ? "Some photo formats (such as HEIC) only open in certain browsers or apps."
        : "Formats like MKV, AVI and HEVC are not supported by every browser, and Hub does not convert files. Try another browser, or open the file in a media app."));
      const actions = el("div", "hub-unsupported-actions");
      const save = el("a", "btn-play", "Save original");
      save.href = mounted.url;
      save.download = item.name;
      const open = el("a", "btn-info", "Open file");
      open.href = mounted.url;
      open.target = "_blank";
      open.rel = "noopener";
      actions.append(save, open);
      panel.append(actions);
      mounted.panel = panel;
      stage.append(panel);
    }
    function stopMedia(media) {
      if (media.pause) media.pause();
      media.removeAttribute("src");
      if (media.load) media.load();
    }
    function unmount() {
      const current = mounted;
      if (!current) return;
      mounted = null;
      if (current.media) { stopMedia(current.media); current.media.remove(); }
      if (current.panel) current.panel.remove();
      current.stage.classList.remove("hub-live");
      release(current.item); // Only after the player has let go of the URL.
    }

    // ---------- the player: opens when a box is clicked ----------
    let viewerReturn = null,
      viewerShare = null,
      historyEntry = false;
    function paintViewer(item) {
      const info = $("hub-viewer-info"),
        actions = $("hub-viewer-actions");
      info.replaceChildren(details(item));
      if (viewerShare) { const set = sharedButtons.get(viewerShare.item.id); if (set) set.delete(viewerShare.button); viewerShare = null; }
      actions.replaceChildren();
      if (item.kind !== "image") actions.append(buildSpeed(item, "hub-speed"));
      const share = shareButton(item);
      viewerShare = { item, button: share };
      actions.append(share, removeButton(item));
    }
    function openViewer(id) {
      const item = state.items.find((entry) => entry.id === id);
      if (!item) return;
      if (viewer.hidden) {
        viewerReturn = doc.activeElement;
        try { root.history.pushState({ hubViewer: true }, ""); historyEntry = true; } catch (_) { historyEntry = false; }
      }
      viewer.hidden = false;
      doc.body.classList.add("hub-viewing");
      state.activeId = id;
      paintViewer(item);
      mount(item);
      $("hub-viewer-close").focus();
    }
    function closeViewer(fromHistory) {
      if (viewer.hidden) return;
      unmount();
      viewer.hidden = true;
      doc.body.classList.remove("hub-viewing");
      state.activeId = null;
      if (viewerShare) { const set = sharedButtons.get(viewerShare.item.id); if (set) set.delete(viewerShare.button); viewerShare = null; }
      if (historyEntry && !fromHistory) { historyEntry = false; try { root.history.back(); } catch (_) {} }
      historyEntry = false;
      if (viewerReturn && viewerReturn.isConnected && viewerReturn.focus) viewerReturn.focus();
      viewerReturn = null;
    }
    function step(delta) {
      const list = visible();
      const at = list.findIndex((entry) => entry.id === state.activeId);
      if (at < 0 || list.length < 2) return;
      openViewer(list[(at + delta + list.length) % list.length].id);
    }

    // ---------- thumbnails (generated lazily, one at a time, never the whole file) ----------
    function requestThumb(item) {
      if (item.thumbState !== "idle" || item.kind === "audio" || item.removed) return;
      item.thumbState = "queued";
      thumbQueue.push(item);
      pumpThumbs();
    }
    // A few at a time, newest request first, so what has just scrolled into view is made first.
    function pumpThumbs() {
      while (thumbActive < THUMB_WORKERS && thumbQueue.length) {
        const item = thumbQueue.pop();
        if (item.removed) continue;
        thumbActive += 1;
        makeThumb(item).then(() => { thumbActive -= 1; pumpThumbs(); });
      }
    }
    async function makeThumb(item) {
      let blob = null;
      try { blob = item.kind === "image" ? await photoThumb(item) : await videoThumb(item); } catch (_) {}
      if (item.removed || !blob) { item.thumbState = "done"; return; }
      item.thumb = root.URL.createObjectURL(blob);
      item.thumbState = "done";
      const tile = tiles.get(item.id);
      if (tile) setThumb(tile, item);
    }
    function drawToBlob(source, width, height) {
      return new Promise((resolve) => {
        const scale = Math.min(1, THUMB_WIDTH / (width || THUMB_WIDTH));
        const canvas = doc.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext && canvas.getContext("2d");
        if (!context) return resolve(null);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.7);
      });
    }
    async function photoThumb(item) {
      if (typeof root.createImageBitmap !== "function") return null;
      const bitmap = await root.createImageBitmap(item.file, { resizeWidth: THUMB_WIDTH, resizeQuality: "low" });
      try { return await drawToBlob(bitmap, bitmap.width, bitmap.height); } finally { if (bitmap.close) bitmap.close(); }
    }
    function videoThumb(item) {
      return new Promise((resolve) => {
        const url = acquire(item);
        const video = doc.createElement("video");
        let finished = false;
        const finish = (blob) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          stopMedia(video);
          release(item);
          resolve(blob);
        };
        const timer = setTimeout(() => finish(null), THUMB_TIMEOUT);
        video.muted = true;
        video.preload = "metadata";
        video.playsInline = true;
        video.addEventListener("error", () => finish(null), { once: true });
        video.addEventListener("loadeddata", () => { video.currentTime = Math.min(1, (video.duration || 2) / 10); }, { once: true });
        video.addEventListener("seeked", () => drawToBlob(video, video.videoWidth, video.videoHeight).then(finish, () => finish(null)), { once: true });
        video.src = url;
      });
    }
    function setThumb(node, item) {
      const art = node.querySelector(".hub-art");
      if (!art || !item.thumb || art.querySelector("img.hub-thumb")) return;
      const image = el("img", "hub-thumb");
      image.alt = "";
      image.src = item.thumb;
      art.prepend(image);
    }

    // ---------- rendering ----------
    function buildSpeed(item, className) {
      const select = el("select", className);
      select.setAttribute("aria-label", "Playback speed for " + item.name);
      for (const speed of SPEEDS) {
        const option = el("option", "", speed + "×");
        option.value = String(speed);
        select.append(option);
      }
      select.value = String(item.speed);
      select.addEventListener("change", () => {
        item.speed = Number(select.value);
        if (mounted && mounted.item.id === item.id && mounted.media) applySpeed(mounted.media, item);
      });
      return select;
    }
    function removeButton(item) {
      const button = el("button", "hub-remove");
      button.type = "button";
      button.textContent = "Remove";
      button.setAttribute("aria-label", "Remove " + item.name + " from Hub");
      button.addEventListener("click", (event) => { event.stopPropagation(); removeItem(item.id); });
      return button;
    }
    function details(item) {
      const box = el("div", "hub-details");
      box.append(el("strong", "hub-name", item.name));
      box.append(el("span", "hub-facts", [formatSize(item.size), typeLabel(item)].join(" · ")));
      if (item.folder) box.append(el("span", "hub-folder", "Folder: " + item.folder));
      return box;
    }
    function buildTile(item) {
      const tile = el("div", "hub-tile");
      tile.dataset.id = String(item.id);
      const open = el("button", "hub-tile-open");
      open.type = "button";
      open.setAttribute("aria-label", (item.kind === "image" ? "Open " : "Play ") + item.name);
      const art = el("div", "hub-art");
      art.append(icon(item.kind));
      art.append(el("span", "hub-badge", KIND_LABEL[item.kind]));
      if (item.kind !== "image") art.append(el("span", "hub-tile-play"));
      open.append(art);
      open.addEventListener("click", () => openViewer(item.id));
      const choose = el("label", "hub-select");
      const box = el("input");
      box.type = "checkbox";
      box.checked = item.selected;
      box.setAttribute("aria-label", "Select " + item.name + " to share");
      box.addEventListener("change", () => { item.selected = box.checked; updateSelection(); });
      choose.append(box);
      const actions = el("div", "hub-tile-actions");
      actions.append(shareButton(item), removeButton(item));
      tile.append(open, choose, details(item), actions);
      tile.classList.toggle("hub-is-shared", item.shared);
      return tile;
    }
    // Boxes are built once. Searching and filtering only show or hide them, so large folders stay instant.
    function render() {
      const empty = state.items.length === 0;
      $("hub-empty").hidden = !empty;
      $("hub-browser").hidden = empty;
      $("hub-fab").hidden = empty;
      doc.body.classList.toggle("hub-has-items", !empty);
      updateTitle(empty);
      for (const kind of ["all", "video", "image", "audio"]) {
        const node = doc.querySelector('[data-count="' + kind + '"]');
        if (node) node.textContent = String(kind === "all" ? state.items.length : state.items.filter((item) => item.kind === kind).length);
      }
      doc.querySelectorAll(".hub-filter").forEach((button) => {
        const on = button.dataset.filter === state.filter;
        button.classList.toggle("active", on);
        button.setAttribute("aria-pressed", String(on));
      });
      let shown = 0;
      for (const item of state.items) {
        let tile = tiles.get(item.id);
        if (!tile) {
          tile = buildTile(item);
          tiles.set(item.id, tile);
          library.append(tile);
          if (item.thumb) setThumb(tile, item);
          if (thumbObserver) thumbObserver.observe(tile);
        }
        const show = matches(item, state.filter, state.query);
        tile.hidden = !show;
        if (show) shown += 1;
      }
      $("hub-noresults").hidden = empty || shown > 0;
      library.hidden = shown === 0;
    }
    function updateTitle(empty) {
      doc.title = (empty ? "Hub" : "Hub (" + state.items.length + ")") + " — SANFLIX";
    }

    // ---------- dialog and file inputs ----------
    const dialog = $("hub-dialog"),
      inputFiles = $("hub-input-files"),
      inputFolder = $("hub-input-folder");
    const folderPickerPresent = "webkitdirectory" in inputFolder;
    let returnFocus = null;
    function openDialog() {
      returnFocus = doc.activeElement;
      const help = $("hub-folder-help");
      const android = /Android/i.test(root.navigator.userAgent || "");
      help.textContent = !folderPickerPresent
        ? "This browser cannot select a whole folder. Use Select Files and pick several files instead."
        : android
          ? "Some Android browsers cannot pick folders. If nothing happens, use Select Files."
          : "If your browser opens a normal file picker instead of a folder picker, use Select Files.";
      $("hub-pick-folder").disabled = !folderPickerPresent;
      dialog.hidden = false;
      $("hub-pick-files").focus();
    }
    function closeDialog() {
      if (dialog.hidden) return;
      dialog.hidden = true;
      if (returnFocus && returnFocus.isConnected && returnFocus.focus) returnFocus.focus();
    }
    doc.querySelectorAll(".hub-add-trigger").forEach((button) => button.addEventListener("click", openDialog));
    $("hub-dialog-close").addEventListener("click", closeDialog);
    dialog.addEventListener("click", (event) => { if (event.target === dialog) closeDialog(); });
    doc.addEventListener("keydown", (event) => { if (event.key === "Escape") { if (!viewer.hidden) closeViewer(); else closeDialog(); } });
    $("hub-pick-files").addEventListener("click", () => { inputFiles.value = ""; inputFiles.click(); });
    $("hub-pick-folder").addEventListener("click", () => { inputFolder.value = ""; inputFolder.click(); });
    inputFiles.addEventListener("change", () => importFiles(inputFiles.files, false));
    inputFolder.addEventListener("change", () => importFiles(inputFolder.files, true));

    // ---------- controls ----------
    doc.querySelectorAll(".hub-filter").forEach((button) => button.addEventListener("click", () => { state.filter = button.dataset.filter; render(); }));
    $("hub-viewer-close").addEventListener("click", () => closeViewer());
    $("hub-viewer-prev").addEventListener("click", () => step(-1));
    $("hub-viewer-next").addEventListener("click", () => step(1));
    viewer.addEventListener("click", (event) => { if (event.target === viewer) closeViewer(); });
    root.addEventListener("popstate", () => { if (!viewer.hidden) closeViewer(true); });
    $("hub-search").addEventListener("input", (event) => { state.query = event.target.value; render(); });
    $("hub-clear").addEventListener("click", clearAll);
    $("hub-share-selected").addEventListener("click", () => {
      const chosen = state.items.filter((item) => item.selected && !item.shared);
      if (!chosen.length) return;
      for (const item of chosen) item.selected = false;
      doc.querySelectorAll(".hub-select input").forEach((box) => { box.checked = false; });
      updateSelection();
      announce("hub:share", { items: chosen.map(shareDetail) });
    });

    // Nothing is kept across a reload; only a count is remembered, to explain the empty page.
    root.addEventListener("pagehide", () => {
      try { if (state.items.length) root.sessionStorage.setItem(PREVIOUS_KEY, String(state.items.length)); } catch (_) {}
      closeViewer(true);
      for (const item of state.items) if (item.thumb) root.URL.revokeObjectURL(item.thumb);
    });
    try {
      const previous = Number(root.sessionStorage.getItem(PREVIOUS_KEY));
      root.sessionStorage.removeItem(PREVIOUS_KEY);
      if (previous > 0)
        say("Your previous selection (" + previous + " item" + (previous === 1 ? "" : "s") + ") is not kept after a reload. Use Add Media to select the files or folder again.");
    } catch (_) {}

    render();
    root.SanflixHub = {
      count: () => state.items.length,
      names: () => state.items.map((item) => item.name),
      activeName: () => (mounted ? mounted.item.name : null),
      leaseCount: () => leases.size,
      markShared,
    };
  }

  if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : globalThis);
