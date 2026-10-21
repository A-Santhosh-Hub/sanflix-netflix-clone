(function (root) {
  "use strict";
  // Peer-to-peer file transfer for the Shared Hub. This is the ONLY code that reads a shared file's
  // bytes, and it has no network code except WebRTC: bytes go straight to the other browser's
  // data channel, never to SANFLIX. (Signaling lives in hub-room.js and only ever sees JSON.)
  const CHUNK = 16384; // Per message: safe for every browser's SCTP limit.
  const BLOCK = 1048576; // Integrity unit (64 chunks).
  const WINDOW = 8; // Blocks the sender may have unacknowledged: bounds receiver memory to ~8 MiB.
  const HIGH_WATER = 1048576;
  const LOW_WATER = 262144;
  const MERGE_BYTES = 8 * 1048576;
  const IDLE_MS = 30000;
  const VERSION = 1;

  // ---------- SHA-256 (incremental; used when crypto.subtle is unavailable, e.g. plain-HTTP LAN) ----------
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  class Sha256 {
    constructor() {
      this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
      this.buffer = new Uint8Array(64);
      this.fill = 0;
      this.total = 0;
      this.w = new Uint32Array(64);
    }
    block(data, offset) {
      const w = this.w, h = this.h;
      for (let i = 0; i < 16; i++) {
        const j = offset + i * 4;
        w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    update(data) {
      this.total += data.length;
      let position = 0;
      if (this.fill) {
        const take = Math.min(64 - this.fill, data.length);
        this.buffer.set(data.subarray(0, take), this.fill);
        this.fill += take;
        position = take;
        if (this.fill === 64) { this.block(this.buffer, 0); this.fill = 0; }
      }
      while (position + 64 <= data.length) { this.block(data, position); position += 64; }
      if (position < data.length) { this.buffer.set(data.subarray(position), 0); this.fill = data.length - position; }
      return this;
    }
    digest() {
      const bits = this.total * 8;
      this.buffer[this.fill++] = 0x80;
      if (this.fill > 56) { this.buffer.fill(0, this.fill); this.block(this.buffer, 0); this.fill = 0; }
      this.buffer.fill(0, this.fill, 56);
      const view = new DataView(this.buffer.buffer);
      view.setUint32(56, Math.floor(bits / 0x100000000));
      view.setUint32(60, bits >>> 0);
      this.block(this.buffer, 0);
      const out = new Uint8Array(32), outView = new DataView(out.buffer);
      for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.h[i]);
      return out;
    }
  }
  async function sha256(bytes, subtle) {
    if (subtle) return new Uint8Array(await subtle.digest("SHA-256", bytes));
    return new Sha256().update(bytes).digest();
  }
  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  async function rootOf(blockHashes, subtle) {
    const joined = new Uint8Array(blockHashes.length * 32);
    blockHashes.forEach((hash, index) => joined.set(hash, index * 32));
    return toHex(await sha256(joined, subtle));
  }

  const QUEUED = new Set(["ready", "meta", "start", "reject", "ok", "fail"]);
  // ---------- message router with timeouts and close detection ----------
  class Router {
    constructor(channel, { setTimer = root.setTimeout, clearTimer = root.clearTimeout, idleMs = IDLE_MS } = {}) {
      this.channel = channel;
      // Browser timers throw "Illegal invocation" when called as a method of another object.
      this.setTimer = (fn, ms) => setTimer(fn, ms);
      this.clearTimer = (id) => clearTimer(id);
      this.idleMs = idleMs;
      this.queue = [];
      this.waiters = [];
      this.failure = null;
      this.handlers = new Set();
      channel.binaryType = "arraybuffer";
      this.onMessage = (event) => this.deliver(event.data);
      this.onClose = () => this.fail(new Error("The connection closed before the transfer finished."));
      channel.addEventListener("message", this.onMessage);
      channel.addEventListener("close", this.onClose);
      channel.addEventListener("error", this.onClose);
      if (channel.readyState === "closed") this.onClose();
    }
    deliver(data) {
      if (this.failure) return;
      if (typeof data === "string") {
        let message;
        try { message = JSON.parse(data); } catch (_) { return this.fail(new Error("The other device sent an invalid message.")); }
        if (!message || typeof message.t !== "string") return this.fail(new Error("The other device sent an invalid message."));
        if (message.t === "cancel") return this.fail(new Error("The transfer was cancelled by the other device."));
        this.dispatch({ kind: "json", message });
      } else {
        this.dispatch({ kind: "binary", data: data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
      }
    }
    dispatch(item) {
      for (const handler of this.handlers) handler(item);
      const index = this.waiters.findIndex((w) => w.match(item));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        this.clearTimer(waiter.timer);
        waiter.resolve(item.message);
      } else if (item.kind === "json" && QUEUED.has(item.message.t)) this.queue.push(item.message);
    }
    take(types, label) {
      const wanted = [].concat(types);
      const queued = this.queue.findIndex((m) => wanted.includes(m.t));
      if (queued >= 0) return Promise.resolve(this.queue.splice(queued, 1)[0]);
      if (this.failure) return Promise.reject(this.failure);
      return new Promise((resolve, reject) => {
        const waiter = { match: (item) => item.kind === "json" && wanted.includes(item.message.t), resolve, reject };
        waiter.timer = this.setTimer(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error("The other device stopped responding" + (label ? " (" + label + ")" : "") + "."));
        }, this.idleMs);
        this.waiters.push(waiter);
      });
    }
    fail(error) {
      if (this.failure) return;
      this.failure = error;
      for (const waiter of this.waiters.splice(0)) { this.clearTimer(waiter.timer); waiter.reject(error); }
      for (const handler of this.handlers) handler({ kind: "error", error });
    }
    send(message) { this.channel.send(JSON.stringify(message)); }
    dispose() {
      this.channel.removeEventListener("message", this.onMessage);
      this.channel.removeEventListener("close", this.onClose);
      this.channel.removeEventListener("error", this.onClose);
      for (const waiter of this.waiters.splice(0)) this.clearTimer(waiter.timer);
    }
  }

  async function waitForDrain(channel, router) {
    channel.bufferedAmountLowThreshold = LOW_WATER;
    while (channel.bufferedAmount > HIGH_WATER) {
      if (router.failure) throw router.failure;
      await new Promise((resolve) => {
        const done = () => { channel.removeEventListener("bufferedamountlow", done); channel.removeEventListener("close", done); resolve(); };
        channel.addEventListener("bufferedamountlow", done);
        channel.addEventListener("close", done);
      });
    }
  }

  // ---------- sender ----------
  function sendFile({ channel, file, onProgress = () => {}, subtle = null, timers = {} }) {
    const router = new Router(channel, timers);
    let cancelled = false;
    const run = async () => {
      try {
        await router.take("ready", "waiting for the receiver");
        const size = file.size, blocks = Math.ceil(size / BLOCK);
        router.send({ t: "meta", v: VERSION, size, chunk: CHUNK, block: BLOCK, blocks });
        const answer = await router.take(["start", "reject"], "waiting for the receiver to accept");
        if (answer.t === "reject") throw new Error("The receiver declined the file: " + String(answer.reason || "not accepted").slice(0, 120));
        let acked = -1;
        const wake = [];
        router.handlers.add((item) => {
          if (item.kind === "json" && item.message.t === "ack" && Number.isInteger(item.message.i)) {
            acked = Math.max(acked, item.message.i);
            wake.splice(0).forEach((resolve) => resolve());
          } else if (item.kind === "error") wake.splice(0).forEach((resolve) => resolve());
        });
        const hashes = [];
        for (let index = 0; index < blocks; index++) {
          while (index - acked > WINDOW) {
            if (router.failure) throw router.failure;
            await new Promise((resolve) => wake.push(resolve)); // Flow control: wait for the receiver to catch up.
          }
          if (router.failure) throw router.failure;
          if (cancelled) throw new Error("Cancelled.");
          const offset = index * BLOCK, length = Math.min(BLOCK, size - offset);
          const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
          if (bytes.length !== length) throw new Error("The file changed while it was being shared.");
          const hash = await sha256(bytes, subtle);
          for (let position = 0; position < length; position += CHUNK) {
            await waitForDrain(channel, router); // Backpressure: never queue more than HIGH_WATER in the browser.
            channel.send(bytes.subarray(position, Math.min(position + CHUNK, length)));
          }
          router.send({ t: "block", i: index, n: length, h: toHex(hash) });
          hashes.push(hash);
          onProgress({ done: offset + length, total: size });
        }
        router.send({ t: "end", size, blocks, root: await rootOf(hashes, subtle) });
        const verdict = await router.take(["ok", "fail"], "waiting for verification");
        if (verdict.t === "fail") throw new Error("The receiver could not verify the file: " + String(verdict.reason || "unknown").slice(0, 120));
        return { size, blocks };
      } catch (error) {
        if (!router.failure) { try { router.send({ t: "cancel" }); } catch (_) {} }
        throw error;
      } finally {
        router.dispose();
      }
    };
    return {
      promise: run(),
      cancel() { cancelled = true; try { router.send({ t: "cancel" }); } catch (_) {} router.fail(new Error("Cancelled.")); },
    };
  }

  // ---------- sinks (bounded memory) ----------
  class BlobSink {
    constructor({ maxBytes, mime = "", BlobClass = root.Blob }) {
      this.maxBytes = maxBytes;
      this.mime = mime;
      this.Blob = BlobClass;
      this.blob = new BlobClass([], { type: mime });
      this.pending = [];
      this.pendingBytes = 0;
      this.total = 0;
    }
    merge() {
      if (!this.pending.length) return;
      this.blob = new this.Blob([this.blob, ...this.pending], { type: this.mime });
      this.pending = [];
      this.pendingBytes = 0;
    }
    async write(bytes) {
      this.total += bytes.length;
      if (this.total > this.maxBytes) throw new Error("This file is too large to receive in this browser. Use a desktop browser that can save straight to disk.");
      this.pending.push(bytes);
      this.pendingBytes += bytes.length;
      if (this.pendingBytes >= MERGE_BYTES) this.merge(); // Keeps JavaScript memory small; the browser manages the Blob.
    }
    async finish() { this.merge(); return { blob: this.blob }; }
    async abort() { this.pending = []; this.blob = new this.Blob([]); }
  }
  class FileSystemSink {
    constructor(handle) { this.handle = handle; this.writable = null; }
    async write(bytes) { this.writable = this.writable || (await this.handle.createWritable()); await this.writable.write(bytes); }
    async finish() { this.writable = this.writable || (await this.handle.createWritable()); await this.writable.close(); return { file: await this.handle.getFile() }; }
    async abort() { if (this.writable) { try { await this.writable.abort(); } catch (_) {} } }
  }
  // Must be called directly from a click: browsers only allow the save dialog after a user gesture.
  async function openSaveSink(win, name) {
    if (!win.showSaveFilePicker || !win.isSecureContext) return null;
    return new FileSystemSink(await win.showSaveFilePicker({ suggestedName: name }));
  }

  // ---------- receiver ----------
  function receiveFile({ channel, expected, sink, onProgress = () => {}, limits = {}, subtle = null, timers = {} }) {
    const router = new Router(channel, timers);
    const maxBytes = limits.maxFileBytes || Infinity;
    let cancelled = false, finished = false, resolveOutcome, rejectOutcome;
    const outcome = new Promise((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; });
    outcome.catch(() => {});
    const run = async () => {
      try {
        if (!Number.isInteger(expected.size) || expected.size <= 0 || expected.size > maxBytes)
          throw new Error("This file is larger than the Hub allows.");
        router.send({ t: "ready", v: VERSION });
        const meta = await router.take("meta", "waiting for the file details");
        const blocks = Math.ceil(expected.size / BLOCK);
        if (meta.v !== VERSION || meta.size !== expected.size || meta.chunk !== CHUNK || meta.block !== BLOCK || meta.blocks !== blocks) {
          router.send({ t: "reject", reason: "details do not match the shared item" });
          throw new Error("The sender's file details do not match what was shared, so the transfer was refused.");
        }
        let frames = [], frameBytes = 0, next = 0, received = 0, chain = Promise.resolve();
        const hashes = [];
        const abortTransfer = (error) => { router.fail(error); rejectOutcome(error); };
        router.handlers.add((item) => {
          if (item.kind === "error") return rejectOutcome(item.error);
          if (item.kind === "binary") {
            frames.push(item.data);
            frameBytes += item.data.length;
            if (frameBytes > BLOCK) abortTransfer(new Error("The sender sent more data than expected."));
            return;
          }
          const message = item.message;
          if (message.t === "block") {
            const taken = frames, bytesTaken = frameBytes;
            frames = []; frameBytes = 0;
            chain = chain.then(async () => {
              if (router.failure) return;
              const length = Math.min(BLOCK, expected.size - next * BLOCK);
              if (message.i !== next || message.n !== length || bytesTaken !== length)
                throw new Error("A block arrived out of order or with the wrong size.");
              const bytes = new Uint8Array(length);
              let position = 0;
              for (const frame of taken) { bytes.set(frame, position); position += frame.length; }
              const hash = await sha256(bytes, subtle);
              if (toHex(hash) !== message.h) throw new Error("A block failed its integrity check; the file may be corrupted.");
              await sink.write(bytes);
              hashes.push(hash);
              next += 1;
              received += length;
              router.send({ t: "ack", i: message.i });
              onProgress({ done: received, total: expected.size });
            }).catch(abortTransfer);
          } else if (message.t === "end") {
            chain = chain.then(async () => {
              if (router.failure) return;
              if (message.size !== expected.size || received !== expected.size || message.blocks !== blocks || hashes.length !== blocks)
                throw new Error("The transfer ended early or with the wrong size.");
              if ((await rootOf(hashes, subtle)) !== message.root) throw new Error("The final integrity check failed; the file may be corrupted.");
              const result = await sink.finish(); // Only now is anything committed.
              finished = true;
              router.send({ t: "ok" });
              resolveOutcome({ size: expected.size, blocks, ...result });
            }).catch(abortTransfer);
          }
        });
        router.send({ t: "start" });
        return await outcome;
      } catch (error) {
        if (!finished) {
          try { router.send({ t: "fail", reason: String(error.message).slice(0, 120) }); } catch (_) {}
          try { await sink.abort(); } catch (_) {}
        }
        throw error;
      } finally {
        router.dispose();
      }
    };
    return {
      promise: run(),
      cancel() { cancelled = true; try { router.send({ t: "cancel" }); } catch (_) {} router.fail(new Error("Cancelled.")); },
      get cancelled() { return cancelled; },
    };
  }

  // ---------- WebRTC glue ----------
  function describeFailure(error) {
    const text = String((error && error.message) || error || "");
    return /direct connection/i.test(text)
      ? text
      : text || "The transfer failed.";
  }
  const NO_DIRECT = "A direct connection could not be made. Your network, or your friend's, may block peer-to-peer connections, and no relay server is set up. Nothing was uploaded.";

  function createLink({ RTC, iceServers, role, sendSignal, onChannel, onFail, timers = {}, openMs = 40000, batchMs = 80 }) {
    const setTimer = (fn, ms) => (timers.setTimeout || root.setTimeout)(fn, ms);
    const clearTimer = (id) => (timers.clearTimeout || root.clearTimeout)(id);
    const pc = new RTC({ iceServers });
    let closed = false, remoteReady = false, pendingRemote = [], outgoing = [], flushTimer = null, opened = false;
    const fail = (message) => { if (!closed && !opened) { onFail(new Error(message)); } };
    const openTimer = setTimer(() => fail(NO_DIRECT), openMs);
    const flush = () => {
      flushTimer = null;
      if (outgoing.length && !closed) sendSignal("ice", { candidates: outgoing.splice(0, 20) });
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const c = event.candidate;
      outgoing.push({ candidate: c.candidate, sdpMid: c.sdpMid == null ? null : c.sdpMid, sdpMLineIndex: c.sdpMLineIndex == null ? null : c.sdpMLineIndex });
      if (!flushTimer) flushTimer = setTimer(flush, batchMs);
    };
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === "failed") fail(NO_DIRECT); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") fail(NO_DIRECT); };
    const attach = (channel) => {
      channel.binaryType = "arraybuffer";
      const open = () => { opened = true; clearTimer(openTimer); onChannel(channel); };
      if (channel.readyState === "open") open();
      else channel.addEventListener("open", open, { once: true });
    };
    const applyRemoteCandidates = async () => {
      remoteReady = true;
      for (const candidate of pendingRemote.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    };
    const link = {
      async start() { // Owner side: create the channel and the offer.
        attach(pc.createDataChannel("file", { ordered: true }));
        await pc.setLocalDescription(await pc.createOffer());
        sendSignal("offer", { type: "offer", sdp: pc.localDescription.sdp });
      },
      async handle(kind, data) {
        if (closed) return;
        if (kind === "offer" && role === "requester") {
          pc.ondatachannel = (event) => attach(event.channel);
          await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
          await applyRemoteCandidates();
          await pc.setLocalDescription(await pc.createAnswer());
          sendSignal("answer", { type: "answer", sdp: pc.localDescription.sdp });
        } else if (kind === "answer" && role === "owner") {
          await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
          await applyRemoteCandidates();
        } else if (kind === "ice") {
          for (const candidate of data.candidates || []) {
            if (remoteReady) await pc.addIceCandidate(candidate).catch(() => {});
            else pendingRemote.push(candidate);
          }
        }
      },
      close() {
        if (closed) return;
        closed = true;
        clearTimer(openTimer);
        if (flushTimer) clearTimer(flushTimer);
        try { pc.close(); } catch (_) {}
      },
    };
    return link;
  }

  function capabilities(win) {
    const nav = win.navigator || {};
    return {
      webrtc: typeof win.RTCPeerConnection === "function",
      subtle: Boolean(win.crypto && win.crypto.subtle),
      saveToDisk: typeof win.showSaveFilePicker === "function" && Boolean(win.isSecureContext),
      mobile: /Android|iPhone|iPad|iPod/i.test(nav.userAgent || ""),
    };
  }

  const api = {
    CHUNK, BLOCK, WINDOW, HIGH_WATER, LOW_WATER, NO_DIRECT,
    Sha256, sha256, toHex, rootOf, Router, BlobSink, FileSystemSink, openSaveSink,
    sendFile, receiveFile, createLink, capabilities, describeFailure,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SanflixTransfer = api;
})(typeof window !== "undefined" ? window : globalThis);
