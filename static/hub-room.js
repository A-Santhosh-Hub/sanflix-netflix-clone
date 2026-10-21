(function (root) {
  "use strict";
  // Shared Hub client: publishes metadata, polls for friends' items and signaling, and drives the
  // peer-to-peer transfers in hub-transfer.js. It only ever sends small JSON to this site; it never
  // reads a file and a guard throws if anything file-like is passed to a request.
  const MiB = 1048576;
  const POLL_IDLE = 3000, POLL_BUSY = 1000, KEEPALIVE = 60000;
  const KIND = { video: "Video", image: "Photo", audio: "Audio" };

  function start() {
    const doc = root.document;
    const T = root.SanflixTransfer;
    const $ = (id) => doc.getElementById(id);
    if (!$("hub-friends") || !T) return;
    const state = {
      me: null, epoch: "", limits: { max_file_bytes: 4096 * MiB, play_max_bytes: 512 * MiB }, ice: [], joining: null,
      after: 0, shares: [], people: [], filter: "all", query: "", mode: "mine", stopped: false, failures: 0, pollTimer: null,
    };
    const mine = new Map(); // share id -> { file, localId }  (the browser's own File objects)
    const byLocal = new Map(); // local item id -> share id
    const transfers = new Map(); // transfer id -> transfer
    const answering = new Set(); // requests for my shared items that are being accepted right now
    const cards = new Map(); // share id -> card element
    const lastFailure = new Map(); // share id -> { message, purpose, retry }: kept until the next attempt
    const caps = T.capabilities(root);
    const subtle = (root.crypto && root.crypto.subtle) || null;

    // ---------- tiny helpers ----------
    const el = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const size = (bytes) => {
      const n = Number(bytes) || 0;
      return n < 1024 ? n + " B" : n < MiB ? (n / 1024).toFixed(1) + " KB" : n < 1024 * MiB ? (n / MiB).toFixed(1) + " MB" : (n / (1024 * MiB)).toFixed(2) + " GB";
    };
    let noticeTimer = null;
    function say(message, sticky) {
      const box = $("room-notice");
      box.textContent = message;
      box.hidden = !message;
      root.clearTimeout(noticeTimer);
      if (message && !sticky) noticeTimer = root.setTimeout(() => { box.hidden = true; }, 9000);
    }

    // ---------- the only network path: small same-origin JSON ----------
    const csrf = () => (doc.querySelector('meta[name="csrf-token"]') || {}).content || "";
    function encode(value) {
      return JSON.stringify(value, (key, item) => {
        if ((root.Blob && item instanceof root.Blob) || item instanceof ArrayBuffer || ArrayBuffer.isView(item))
          throw new Error("Media can never be sent to the server.");
        return item;
      });
    }
    async function call(path, { method = "GET", body } = {}) {
      const headers = { Accept: "application/json" };
      if (method !== "GET") { headers["Content-Type"] = "application/json"; headers["X-CSRF-Token"] = csrf(); }
      if (state.epoch) headers["X-Hub-Epoch"] = state.epoch;
      const response = await root.fetch(path, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : encode(body) });
      let data = null;
      try { data = await response.json(); } catch (_) {}
      if (!response.ok) {
        const error = new Error((data && data.error) || "The request failed. Please try again.");
        error.status = response.status;
        throw error;
      }
      return data;
    }

    // ---------- joining and polling ----------
    function ensureJoined() {
      if (state.joining) return state.joining;
      state.joining = call("/api/hub/join", { method: "POST", body: { fresh: true } }).then((data) => {
        Object.assign(state, { me: data, epoch: data.epoch, limits: data.limits, ice: data.ice });
        $("room-name").textContent = data.name;
        $("room-tag").textContent = "#" + data.tag;
        schedule(0);
        return data;
      });
      state.joining.catch((error) => { state.joining = null; say(error.message, true); });
      return state.joining;
    }
    const busy = () => transfers.size > 0 || answering.size > 0;
    function schedule(delay) {
      root.clearTimeout(state.pollTimer);
      if (!state.stopped) state.pollTimer = root.setTimeout(poll, delay);
    }
    async function poll() {
      if (state.stopped) return;
      try {
        const data = await call("/api/hub/poll?after=" + state.after);
        state.failures = 0;
        state.people = data.participants;
        state.shares = data.shares;
        reconcileMine();
        renderFeed();
        for (const signal of data.signals) { state.after = Math.max(state.after, signal.id); await handle(signal); }
      } catch (error) {
        state.failures += 1;
        if (error.status === 409 && /another tab/i.test(error.message)) {
          state.stopped = true;
          say(error.message, true);
          return;
        }
        if (error.status === 401) { root.location.assign("/login"); return; }
        if (error.status === 409) { state.joining = null; state.epoch = ""; await ensureJoined().catch(() => {}); return; }
      }
      schedule(state.failures ? Math.min(15000, 3000 * state.failures) : busy() ? POLL_BUSY : POLL_IDLE);
    }
    doc.addEventListener("visibilitychange", () => { if (!doc.hidden && state.me) schedule(0); });

    // ---------- publishing what I choose to share ----------
    async function shareItems(items) {
      try { await ensureJoined(); } catch (_) { return; }
      const accepted = [], refused = [];
      for (const item of items) {
        if (byLocal.has(item.id)) continue;
        if (!(item.size > 0) || item.size > state.limits.max_file_bytes) refused.push(item.name);
        else accepted.push(item);
      }
      if (refused.length) say(`${refused.length} item${refused.length === 1 ? " is" : "s are"} empty or larger than the Hub limit of ${Math.round(state.limits.max_file_bytes / MiB)} MB, so ${refused.length === 1 ? "it was" : "they were"} not shared.`);
      for (let at = 0; at < accepted.length; at += 20) {
        const batch = accepted.slice(at, at + 20);
        try {
          const data = await call("/api/hub/shares", {
            method: "POST",
            body: { items: batch.map((item) => ({ name: item.name, size: item.size, mime: item.mime, kind: item.kind, ref: String(item.id) })) },
          });
          for (const created of data.shares) {
            const source = batch.find((item) => String(item.id) === created.ref);
            if (!source) continue;
            mine.set(created.id, { file: source.file, localId: source.id });
            byLocal.set(source.id, created.id);
            root.SanflixHub.markShared(source.id, true);
          }
          say(`Shared ${data.shares.length} item${data.shares.length === 1 ? "" : "s"} to the Hub. Friends see the name and size; the file stays on your device and is sent straight to a friend when they play or download it. Keep this page open.`);
        } catch (error) { say(error.message); }
      }
      schedule(0);
    }
    async function unshare(localId, quiet) {
      const shareId = byLocal.get(localId);
      if (!shareId) return;
      byLocal.delete(localId);
      mine.delete(shareId);
      if (root.SanflixHub) root.SanflixHub.markShared(localId, false);
      for (const t of [...transfers.values()]) if (t.shareId === shareId && t.role === "owner") finishTransfer(t, "cancelled", "You stopped sharing this item.");
      try { await call(`/api/hub/shares/${shareId}/remove`, { method: "POST", body: {} }); if (!quiet) say("Stopped sharing."); } catch (error) { say(error.message); }
      schedule(0);
    }
    doc.addEventListener("hub:share", (event) => shareItems(event.detail.items));
    doc.addEventListener("hub:unshare", (event) => unshare(event.detail.id));
    doc.addEventListener("hub:item-removed", (event) => { for (const id of event.detail.ids) unshare(id, true); });
    function reconcileMine() { // Shares that expired or were removed on the server are no longer shared.
      const live = new Set(state.shares.map((share) => share.id));
      for (const [shareId, entry] of [...mine]) {
        if (live.has(shareId)) continue;
        mine.delete(shareId);
        byLocal.delete(entry.localId);
        if (root.SanflixHub) root.SanflixHub.markShared(entry.localId, false);
        say("One of your shared items is no longer shared (it expired or the Hub was reset).");
      }
    }

    // ---------- signals from the server ----------
    async function handle(signal) {
      if (signal.type === "request") return incoming(signal);
      const t = transfers.get(signal.transfer);
      if (signal.type === "decision" && t) return decided(t, signal.payload.approved);
      if (signal.type === "signal" && t && t.link) return t.link.handle(signal.payload.kind, signal.payload.data).catch((error) => finishTransfer(t, "failed", error.message));
      if (signal.type === "status" && t) return remoteEnded(t, signal.payload);
    }

    // ---------- owner: sharing an item is the consent ----------
    // Friends in this room are trusted by the owner, who chose to share the item. A request for a shared item
    // therefore starts sending at once, with no prompt. A request for anything that is not (or is no longer)
    // shared, or whose file changed, is declined.
    async function incoming(signal) {
      const p = signal.payload;
      if (answering.has(signal.transfer)) return;
      answering.add(signal.transfer);
      const entry = mine.get(p.share);
      const ok = Boolean(entry) && entry.file.size === p.size;
      if (entry && !ok) say("That file changed or is no longer available, so the request was declined.");
      try { await call(`/api/hub/transfers/${signal.transfer}/decision`, { method: "POST", body: { approve: ok } }); }
      catch (error) { say(error.message); answering.delete(signal.transfer); return; }
      answering.delete(signal.transfer);
      if (ok) startSending(signal.transfer, p, entry);
      schedule(0);
    }
    function startSending(id, p, entry) {
      const t = { id, role: "owner", shareId: p.share, name: p.name, size: p.size, from: p.from_name, state: "connecting" };
      transfers.set(id, t);
      t.ui = progressRow(t, `Sending “${p.name}” to ${p.from_name}`);
      t.link = T.createLink({
        RTC: root.RTCPeerConnection, iceServers: state.ice, role: "owner",
        sendSignal: (kind, payload) => sendSignal(t, kind, payload),
        onChannel: (channel) => runSend(t, channel, entry.file),
        onFail: (error) => finishTransfer(t, "failed", error.message),
      });
      t.link.start().catch((error) => finishTransfer(t, "failed", error.message));
      schedule(0);
    }
    async function runSend(t, channel, file) {
      t.state = "transferring";
      keepAlive(t);
      post(t, "connected");
      t.job = T.sendFile({ channel, file, subtle, onProgress: (p) => progress(t, p) });
      try { await t.job.promise; finishTransfer(t, "done", ""); } catch (error) { finishTransfer(t, t.job.cancelled ? "cancelled" : "failed", error.message); }
    }

    // ---------- requester: ask, then receive ----------
    async function startTransfer(share, purpose) {
      if (!caps.webrtc) return say("This browser does not support direct device-to-device connections (WebRTC).");
      const limit = state.limits.max_file_bytes;
      if (share.size > limit) return say("That file is larger than the Hub allows.");
      let sink = null;
      if (purpose === "download" && caps.saveToDisk) {
        try { sink = await T.openSaveSink(root, share.name); } // Needs the click's user gesture, so it comes first.
        catch (error) { return say(error && error.name === "AbortError" ? "Saving was cancelled." : "Could not open the save dialog: " + error.message); }
      }
      if (!sink) {
        const cap = purpose === "play" ? state.limits.play_max_bytes : (caps.mobile ? 256 : 1024) * MiB;
        if (share.size > cap)
          return say(`This file is ${size(share.size)}. This browser can only hold ${size(cap)} in memory${purpose === "play" ? " for playback; use Download Original on a computer instead" : "; open the Hub in Chrome or Edge on a computer so it can save straight to disk"}.`);
        sink = new T.BlobSink({ maxBytes: cap, mime: share.mime });
      }
      try {
        const created = await call(`/api/hub/shares/${share.id}/request`, { method: "POST", body: { purpose } });
        const t = { id: created.transfer, role: "requester", shareId: share.id, share, purpose, name: share.name, size: share.size, state: "waiting", sink, from: share.owner_name };
        transfers.set(t.id, t);
        lastFailure.delete(share.id);
        clearPlayer(share.id); // A new attempt replaces any earlier copy shown on this card.
        t.ui = progressRow(t, "");
        refreshCard(share.id);
        setStatus(t, `Asking ${share.owner_name}’s device to send “${share.name}”…`);
        schedule(0);
      } catch (error) { try { await sink.abort(); } catch (_) {} say(error.message); }
    }
    function clearPlayer(shareId) {
      const card = cards.get(shareId);
      if (!card) return;
      if (card.dataset.url) { root.URL.revokeObjectURL(card.dataset.url); delete card.dataset.url; }
      card.querySelector(".room-player").replaceChildren();
      card.classList.remove("room-has-player");
      const bar = card.querySelector(".room-progress");
      bar.hidden = true;
      bar.value = 0;
    }
    function decided(t, approved) {
      if (!approved) return finishTransfer(t, "rejected", `${t.from} declined.`);
      t.state = "connecting";
      setStatus(t, `Connecting directly to ${t.from}…`);
      t.link = T.createLink({
        RTC: root.RTCPeerConnection, iceServers: state.ice, role: "requester",
        sendSignal: (kind, payload) => sendSignal(t, kind, payload),
        onChannel: (channel) => runReceive(t, channel),
        onFail: (error) => finishTransfer(t, "failed", error.message),
      });
    }
    async function runReceive(t, channel) {
      t.state = "transferring";
      keepAlive(t);
      post(t, "connected");
      setStatus(t, `Receiving from ${t.from}…`);
      t.job = T.receiveFile({ channel, expected: { size: t.size, name: t.name }, sink: t.sink, subtle, limits: { maxFileBytes: state.limits.max_file_bytes }, onProgress: (p) => progress(t, p) });
      try {
        const result = await t.job.promise;
        await received(t, result);
        finishTransfer(t, "done", "");
      } catch (error) { finishTransfer(t, t.job.cancelled ? "cancelled" : "failed", error.message); }
    }
    async function received(t, result) {
      const cell = cards.get(t.shareId);
      const area = cell && cell.querySelector(".room-player");
      if (result.file && t.purpose === "download") return setStatus(t, "Saved to the location you chose. Integrity verified.");
      const blob = result.blob || result.file;
      const url = root.URL.createObjectURL(blob);
      if (cell) { if (cell.dataset.url) root.URL.revokeObjectURL(cell.dataset.url); cell.dataset.url = url; }
      const save = el("a", "btn-info room-save", "Save original");
      save.href = url;
      save.download = t.name;
      if (t.purpose === "play" && area) {
        const kind = t.share.kind;
        const media = el(kind === "image" ? "img" : kind === "audio" ? "audio" : "video", "room-media");
        if (kind !== "image") { media.controls = true; media.playsInline = true; }
        media.addEventListener("error", () => { media.remove(); setStatus(t, "Received and verified, but this browser cannot play this format. You can still save the original."); }, { once: true });
        media.src = url;
        area.replaceChildren(media, save);
        cell.classList.add("room-has-player");
        setStatus(t, "Received and verified. Playing the local copy.");
      } else {
        area && area.replaceChildren(save);
        save.click();
        setStatus(t, "Received and verified. If nothing was saved, use Save original.");
      }
    }
    function remoteEnded(t, payload) {
      if (["done", "failed", "cancelled", "rejected"].includes(payload.status) && !t.finished) {
        if (t.job && !t.job.cancelled && payload.status !== "done") t.job.cancel();
        finishTransfer(t, payload.status === "done" ? "done" : payload.status, payload.reason || "The other device ended the transfer.", true);
      }
    }

    // ---------- shared transfer bookkeeping ----------
    function sendSignal(t, kind, payload) {
      return call(`/api/hub/transfers/${t.id}/signal`, { method: "POST", body: { kind, payload } }).catch((error) => finishTransfer(t, "failed", error.message));
    }
    function post(t, status, reason) {
      return call(`/api/hub/transfers/${t.id}/status`, { method: "POST", body: { status, reason: reason || "" } }).catch(() => {});
    }
    function keepAlive(t) { t.alive = root.setInterval(() => post(t, "connected"), KEEPALIVE); }
    function finishTransfer(t, status, message, fromRemote) {
      if (t.finished) return;
      t.finished = true;
      root.clearInterval(t.alive);
      if (!fromRemote && status !== "rejected") post(t, status === "done" ? "done" : status, message);
      try { if (t.job && status !== "done") t.job.cancel(); } catch (_) {}
      try { if (t.link) t.link.close(); } catch (_) {}
      if (status !== "done" && t.sink) t.sink.abort().catch(() => {});
      transfers.delete(t.id);
      const text = status === "done" ? (t.role === "owner" ? `Sent “${t.name}” to ${t.from}.` : "")
        : status === "cancelled" ? "Cancelled." : status === "rejected" ? message : `Failed: ${message}`;
      if (t.role === "owner") { setStatus(t, text); root.setTimeout(() => t.ui && t.ui.remove(), 8000); }
      else {
        if (status === "done") lastFailure.delete(t.shareId);
        else lastFailure.set(t.shareId, { message: text, purpose: t.purpose, retry: status !== "rejected" });
        const bar = cards.get(t.shareId) && cards.get(t.shareId).querySelector(".room-progress");
        if (bar) bar.hidden = true;
        refreshCard(t.shareId);
      }
      schedule(0);
    }
    function cancel(t) {
      if (t.job) t.job.cancel();
      finishTransfer(t, "cancelled", "Cancelled.");
    }
    function progressRow(t, label) {
      if (t.role === "requester") { refreshCard(t.shareId); return null; }
      const row = el("div", "room-request room-sending");
      row.append(el("span", "room-send-label", label));
      const bar = el("progress", "room-progress");
      bar.max = 100; bar.value = 0;
      const stop = el("button", "btn-info", "Cancel");
      stop.type = "button";
      stop.addEventListener("click", () => cancel(t));
      row.append(bar, stop, el("span", "room-send-status", ""));
      $("hub-requests").append(row);
      return row;
    }
    function setStatus(t, text, failed) {
      if (t.role === "owner") { const node = t.ui && t.ui.querySelector(".room-send-status"); if (node) node.textContent = text; return; }
      const card = cards.get(t.shareId);
      const node = card && card.querySelector(".room-status");
      if (node) { node.textContent = text; node.classList.toggle("room-failed", Boolean(failed)); }
    }
    function progress(t, p) {
      const percent = p.total ? Math.round((p.done / p.total) * 100) : 0;
      if (t.role === "owner") { const bar = t.ui && t.ui.querySelector("progress"); if (bar) bar.value = percent; setStatus(t, `${size(p.done)} of ${size(p.total)}`); return; }
      const card = cards.get(t.shareId);
      const bar = card && card.querySelector(".room-progress");
      if (bar) { bar.hidden = false; bar.value = percent; }
      setStatus(t, `Receiving… ${percent}% (${size(p.done)} of ${size(p.total)})`);
    }

    // ---------- the friends feed ----------
    const matches = (share) => (state.filter === "all" || share.kind === state.filter)
      && (!state.query || (share.name + " " + share.owner_name).toLowerCase().includes(state.query.toLowerCase()));
    function activeFor(shareId) { return [...transfers.values()].find((t) => t.role === "requester" && t.shareId === shareId); }
    function cardFor(share) {
      let card = cards.get(share.id);
      if (card) return card;
      card = el("article", "room-card");
      card.dataset.share = share.id;
      const head = el("header", "room-card-head");
      head.append(el("span", "room-dot"), el("strong", "room-owner"), el("span", "room-tag"), el("span", "room-you", "You"));
      const art = el("div", "room-art");
      art.append(el("span", "room-kind"));
      art.append(el("span", "room-tile-play"));
      // Clicking the box plays it, like a title on the Home page (the owner is still asked first).
      art.addEventListener("click", () => {
        const share = state.shares.find((entry) => entry.id === card.dataset.share);
        if (share && share.available && share.owner !== (state.me && state.me.pid) && !activeFor(share.id)) startTransfer(share, "play");
      });
      const info = el("div", "room-info");
      info.append(el("strong", "room-name"), el("span", "room-facts"), el("span", "room-avail"));
      const status = el("div", "room-status");
      status.setAttribute("role", "status");
      const bar = el("progress", "room-progress");
      bar.max = 100; bar.value = 0; bar.hidden = true;
      card.append(art, head, info, status, bar, el("div", "room-player"), el("div", "room-actions"));
      cards.set(share.id, card);
      return card;
    }
    function paintCard(card, share) {
      const own = share.owner === (state.me && state.me.pid);
      card.classList.toggle("room-own", own);
      card.classList.toggle("room-offline", !share.available);
      card.querySelector(".room-dot").classList.toggle("room-online", share.available);
      card.querySelector(".room-owner").textContent = share.owner_name;
      card.querySelector(".room-tag").textContent = "#" + share.owner_tag;
      card.querySelector(".room-you").hidden = !own;
      card.querySelector(".room-kind").textContent = KIND[share.kind] || "File";
      card.querySelector(".room-name").textContent = share.name;
      card.querySelector(".room-facts").textContent = [size(share.size), share.mime ? share.mime.split("/")[1].toUpperCase() : ""].filter(Boolean).join(" · ");
      card.querySelector(".room-avail").textContent = share.available ? (own ? "Shared from this device" : "Online — ask to receive") : "Unavailable: the owner is offline or closed the Hub";
      const active = activeFor(share.id);
      const failure = lastFailure.get(share.id);
      if (!active && failure) {
        const status = card.querySelector(".room-status");
        status.textContent = failure.message;
        status.classList.add("room-failed");
      }
      const actions = card.querySelector(".room-actions");
      actions.replaceChildren();
      const button = (label, handler, primary, disabled) => {
        const b = el("button", primary ? "btn-play" : "btn-info", label);
        b.type = "button";
        b.disabled = Boolean(disabled);
        b.addEventListener("click", handler);
        actions.append(b);
        return b;
      };
      if (own) button("Stop sharing", () => unshare(mine.get(share.id) ? mine.get(share.id).localId : null));
      else if (active) button("Cancel", () => cancel(active));
      else {
        button("Download Original", () => startTransfer(share, "download"), true, !share.available);
        button("Play", () => startTransfer(share, "play"), false, !share.available);
        if (failure && failure.retry) button("Retry", () => startTransfer(share, failure.purpose), false, !share.available);
      }
    }
    function refreshCard(shareId) {
      const share = state.shares.find((s) => s.id === shareId);
      const card = cards.get(shareId);
      if (share && card) paintCard(card, share);
    }
    function renderFeed() {
      const list = state.shares.filter(matches);
      const others = state.shares.filter((s) => s.owner !== (state.me && state.me.pid) && s.available).length;
      $("hub-friends-count").textContent = String(others);
      $("room-online").textContent = state.people.length ? `${state.people.length} online` : "";
      $("room-empty").hidden = list.length > 0;
      $("room-feed").hidden = state.mode !== "friends" || list.length === 0;
      doc.body.classList.toggle("hub-room-has-cards", list.length > 0);
      const feed = $("room-feed");
      const wanted = new Set(list.map((s) => s.id));
      for (const [id, card] of [...cards]) {
        if (wanted.has(id)) continue;
        const t = [...transfers.values()].find((x) => x.shareId === id && x.role === "requester");
        if (t) finishTransfer(t, "failed", "This item is no longer shared.");
        if (card.dataset.url) root.URL.revokeObjectURL(card.dataset.url);
        card.remove();
        cards.delete(id);
      }
      let previous = null;
      for (const share of list) {
        const card = cardFor(share);
        paintCard(card, share);
        if (card.parentNode !== feed || card.previousElementSibling !== previous) feed.insertBefore(card, previous ? previous.nextSibling : feed.firstChild);
        previous = card;
      }
    }

    // ---------- tabs, filters, name ----------
    function setMode(mode) {
      state.mode = mode;
      $("hub-local").hidden = mode !== "mine";
      $("hub-friends").hidden = mode !== "friends";
      doc.body.classList.toggle("hub-mode-friends", mode === "friends");
      for (const button of doc.querySelectorAll(".hub-modes [role=tab]")) button.setAttribute("aria-selected", String(button.dataset.mode === mode));
      if (mode === "friends") { ensureJoined().then(renderFeed).catch(() => {}); renderFeed(); }
    }
    for (const button of doc.querySelectorAll(".hub-modes [role=tab]")) button.addEventListener("click", () => setMode(button.dataset.mode));
    for (const button of doc.querySelectorAll(".room-filter")) button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      for (const other of doc.querySelectorAll(".room-filter")) { other.classList.toggle("active", other === button); other.setAttribute("aria-pressed", String(other === button)); }
      renderFeed();
    });
    $("room-search").addEventListener("input", (event) => { state.query = event.target.value; renderFeed(); });
    $("room-rename").addEventListener("click", () => { $("room-rename-box").hidden = false; $("room-name-input").value = state.me ? state.me.name : ""; $("room-name-input").focus(); });
    const saveName = async () => {
      try {
        const data = await call("/api/hub/name", { method: "POST", body: { name: $("room-name-input").value } });
        state.me.name = data.name;
        $("room-name").textContent = data.name;
        $("room-rename-box").hidden = true;
      } catch (error) { say(error.message); }
    };
    $("room-name-save").addEventListener("click", saveName);
    $("room-name-input").addEventListener("keydown", (event) => { if (event.key === "Enter") saveName(); });
    root.addEventListener("pagehide", () => {
      state.stopped = true;
      for (const t of transfers.values()) { try { if (t.job) t.job.cancel(); if (t.link) t.link.close(); } catch (_) {} }
      for (const card of cards.values()) if (card.dataset.url) root.URL.revokeObjectURL(card.dataset.url);
    });
    setMode("mine");
    root.SanflixRoom = {
      state, mine, transfers, joined: () => Boolean(state.me), ensureJoined, shareItems, setMode, poll: () => poll(), render: () => renderFeed(),
      stop: () => { state.stopped = true; root.clearTimeout(state.pollTimer); },
    };
  }

  if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : globalThis);
