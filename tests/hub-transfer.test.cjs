/* Peer-to-peer transfer protocol: real bytes, real hashing, a faithful in-memory data channel with fault injection. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const T = require("../static/hub-transfer.js");

const subtle = crypto.webcrypto.subtle;
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fast = { idleMs: 400 };

class FakeChannel extends EventTarget {
  constructor(delay = 0) {
    super();
    Object.assign(this, { readyState: "open", bufferedAmount: 0, bufferedAmountLowThreshold: 0, binaryType: "blob", peer: null, delay, maxBuffered: 0, binaryFrames: 0, hook: null });
  }
  send(data) {
    if (this.readyState !== "open") throw new Error("send on a closed channel");
    let payload = data, size;
    if (typeof data === "string") size = Buffer.byteLength(data);
    else { const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data); payload = view.slice().buffer; size = view.byteLength; this.binaryFrames++; }
    if (this.hook) { payload = this.hook(payload, this); if (payload === null) return; }
    this.bufferedAmount += size;
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
    const deliver = () => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= size;
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatchEvent(new Event("bufferedamountlow"));
      if (this.peer && this.peer.readyState === "open") { const event = new Event("message"); event.data = payload; this.peer.dispatchEvent(event); }
    };
    this.delay ? setTimeout(deliver, this.delay) : setImmediate(deliver);
  }
  close() { for (const side of [this, this.peer]) if (side && side.readyState !== "closed") { side.readyState = "closed"; side.dispatchEvent(new Event("close")); } }
}
const pair = (delay) => { const a = new FakeChannel(delay), b = new FakeChannel(delay); a.peer = b; b.peer = a; return [a, b]; };

class RecordingSink {
  constructor(delay = 0) { this.parts = []; this.finished = false; this.aborted = false; this.writes = 0; this.delay = delay; this.maxWrite = 0; }
  async write(bytes) { if (this.delay) await new Promise((r) => setTimeout(r, this.delay)); this.writes++; this.maxWrite = Math.max(this.maxWrite, bytes.length); this.parts.push(Buffer.from(bytes)); }
  async finish() { this.finished = true; return { blob: new Blob(this.parts) }; }
  async abort() { this.aborted = true; this.parts = []; }
  get bytes() { return Buffer.concat(this.parts); }
}
const random = (n) => crypto.randomBytes(n);
const until = async (condition, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (condition()) return true; await new Promise((r) => setTimeout(r, 5)); } throw new Error("condition not met in time"); };
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

async function run(content, { expectedSize = content.length, senderChannel, receiverChannel, sink = new RecordingSink(), subtleImpl = subtle, limits = {}, onChannel = () => {} } = {}) {
  const [a, b] = senderChannel ? [senderChannel, receiverChannel] : pair();
  onChannel(a, b);
  const sent = [], got = [];
  const receiving = T.receiveFile({ channel: b, expected: { size: expectedSize, name: "x.bin" }, sink, limits, subtle: subtleImpl, timers: fast, onProgress: (p) => got.push(p) });
  const sending = T.sendFile({ channel: a, file: new Blob([content]), subtle: subtleImpl, timers: fast, onProgress: (p) => sent.push(p) });
  const [sender, receiver] = await Promise.all([settle(sending.promise), settle(receiving.promise)]);
  return { a, b, sink, sender, receiver, sent, got, sending, receiving };
}

test("a real multi-block file arrives byte for byte, with bounded buffering and monotonic progress", async () => {
  const content = random(3 * T.BLOCK + 12345);
  const slow = pair(1);
  const result = await run(content, { senderChannel: slow[0], receiverChannel: slow[1] });
  assert.equal(result.sender.ok, true, result.sender.error && result.sender.error.message);
  assert.equal(result.receiver.ok, true, result.receiver.error && result.receiver.error.message);
  assert.equal(sha(result.sink.bytes), sha(content));
  assert.equal(Buffer.from(await result.receiver.value.blob.arrayBuffer()).length, content.length);
  assert.equal(result.receiver.value.size, content.length);
  assert.ok(result.sink.finished && !result.sink.aborted);
  assert.ok(result.sink.maxWrite <= T.BLOCK, "the sink only ever receives one verified block at a time");
  assert.ok(result.a.maxBuffered <= T.HIGH_WATER + T.CHUNK, `sender backpressure kept the buffer at ${result.a.maxBuffered}`);
  assert.ok(result.a.binaryFrames >= Math.ceil(content.length / T.CHUNK));
  const done = result.got.map((p) => p.done);
  assert.deepEqual(done, [...done].sort((x, y) => x - y));
  assert.equal(done.at(-1), content.length);
  assert.equal(result.sent.at(-1).done, content.length);
});

test("the same transfer works with the pure JavaScript SHA-256 used on plain-HTTP connections", async () => {
  const content = random(T.BLOCK + 777);
  const result = await run(content, { subtleImpl: null });
  assert.equal(result.receiver.ok, true, result.receiver.error && result.receiver.error.message);
  assert.equal(sha(result.sink.bytes), sha(content));
});

test("edge sizes: one byte, an exact block, a block plus one byte", async () => {
  for (const size of [1, T.CHUNK, T.BLOCK, T.BLOCK + 1, 2 * T.BLOCK]) {
    const content = random(size);
    const result = await run(content);
    assert.equal(result.receiver.ok, true, `size ${size}: ${result.receiver.error && result.receiver.error.message}`);
    assert.equal(sha(result.sink.bytes), sha(content), `size ${size}`);
  }
});

test("a corrupted byte is caught before anything is committed", async () => {
  const content = random(2 * T.BLOCK + 500);
  const [a, b] = pair();
  let frame = 0;
  a.hook = (payload) => { if (typeof payload !== "string" && ++frame === 70) { const bytes = new Uint8Array(payload); bytes[100] ^= 0xff; return bytes.buffer; } return payload; };
  const result = await run(content, { senderChannel: a, receiverChannel: b });
  assert.equal(result.receiver.ok, false);
  assert.match(result.receiver.error.message, /integrity check/);
  assert.equal(result.sink.finished, false, "never completed");
  assert.equal(result.sink.aborted, true, "partial data was discarded");
  assert.equal(result.sender.ok, false, "the sender is told it failed");
});

test("a lost frame or a lying final hash is rejected", async () => {
  const content = random(T.BLOCK + 100);
  const [a, b] = pair();
  let frames = 0;
  a.hook = (payload) => (typeof payload !== "string" && ++frames === 5 ? null : payload); // One frame silently dropped.
  const dropped = await run(content, { senderChannel: a, receiverChannel: b });
  assert.equal(dropped.receiver.ok, false);
  assert.match(dropped.receiver.error.message, /wrong size|out of order/);
  assert.equal(dropped.sink.finished, false);

  const [c, d] = pair();
  c.hook = (payload) => { if (typeof payload === "string" && JSON.parse(payload).t === "end") { const m = JSON.parse(payload); m.root = "0".repeat(64); return JSON.stringify(m); } return payload; };
  const forged = await run(content, { senderChannel: c, receiverChannel: d });
  assert.equal(forged.receiver.ok, false);
  assert.match(forged.receiver.error.message, /final integrity check/);
  assert.equal(forged.sink.finished, false);
});

test("an early 'end' with missing data is not accepted as complete", async () => {
  const content = random(2 * T.BLOCK);
  const [a, b] = pair();
  a.hook = (payload) => { if (typeof payload === "string" && JSON.parse(payload).t === "end") { const m = JSON.parse(payload); m.size -= 1; return JSON.stringify(m); } return payload; };
  const result = await run(content, { senderChannel: a, receiverChannel: b });
  assert.equal(result.receiver.ok, false);
  assert.equal(result.sink.finished, false);
});

test("an interrupted connection fails both sides and discards partial data", async () => {
  const content = random(4 * T.BLOCK);
  const [a, b] = pair(1);
  let blocks = 0;
  a.hook = (payload) => { if (typeof payload === "string" && JSON.parse(payload).t === "block" && ++blocks === 2) setTimeout(() => a.close(), 0); return payload; };
  const result = await run(content, { senderChannel: a, receiverChannel: b });
  assert.equal(result.receiver.ok, false);
  assert.match(result.receiver.error.message, /connection closed/i);
  assert.equal(result.sender.ok, false);
  assert.equal(result.sink.finished, false);
  assert.equal(result.sink.aborted, true);
});

test("details that do not match the shared item are refused before any data moves", async () => {
  const content = random(T.BLOCK + 5);
  const result = await run(content, { expectedSize: content.length + 1 });
  assert.equal(result.receiver.ok, false);
  assert.match(result.receiver.error.message, /do not match/);
  assert.equal(result.sender.ok, false);
  assert.equal(result.sink.writes, 0);
  assert.equal(result.a.binaryFrames, 0);
});

test("the configured size limit is enforced and an unresponsive peer times out", async () => {
  const content = random(2 * T.BLOCK);
  const result = await run(content, { limits: { maxFileBytes: T.BLOCK } });
  assert.equal(result.receiver.ok, false);
  assert.match(result.receiver.error.message, /larger than the Hub allows/);
  assert.equal(result.sender.ok, false);
  assert.match(result.sender.error.message, /stopped responding|cancelled|closed/i);
  assert.equal(result.sink.writes, 0);
});

test("flow control: a slow receiver never has more than the window of blocks in flight", async () => {
  const content = random(14 * T.BLOCK);
  const [a, b] = pair();
  let blocksSent = 0, maxInFlight = 0;
  const sink = new RecordingSink(15);
  a.hook = (payload) => { if (typeof payload === "string" && JSON.parse(payload).t === "block") { blocksSent++; maxInFlight = Math.max(maxInFlight, blocksSent - sink.writes); } return payload; };
  const result = await run(content, { senderChannel: a, receiverChannel: b, sink });
  assert.equal(result.receiver.ok, true, result.receiver.error && result.receiver.error.message);
  assert.equal(sha(sink.bytes), sha(content));
  assert.ok(maxInFlight <= T.WINDOW + 1, `${maxInFlight} blocks were unacknowledged`);
  assert.ok(maxInFlight > 1, "blocks were pipelined");
});

test("either side can cancel and the other side stops cleanly", async () => {
  for (const who of ["receiver", "sender"]) {
    const content = random(6 * T.BLOCK);
    const [a, b] = pair(1);
    const sink = new RecordingSink(5);
    const receiving = T.receiveFile({ channel: b, expected: { size: content.length }, sink, subtle, timers: fast });
    const sending = T.sendFile({ channel: a, file: new Blob([content]), subtle, timers: fast });
    await new Promise((r) => setTimeout(r, 40));
    (who === "receiver" ? receiving : sending).cancel();
    const [s, r] = await Promise.all([settle(sending.promise), settle(receiving.promise)]);
    assert.equal(s.ok, false, who);
    assert.equal(r.ok, false, who);
    assert.equal(sink.finished, false, who);
    assert.equal(sink.aborted, true, who);
  }
});

test("garbage on the channel fails the transfer instead of hanging or crashing", async () => {
  const content = random(T.BLOCK);
  const [a, b] = pair();
  const sink = new RecordingSink();
  const receiving = T.receiveFile({ channel: b, expected: { size: content.length }, sink, subtle, timers: fast });
  const sending = T.sendFile({ channel: a, file: new Blob([content]), subtle, timers: fast });
  b.dispatchEvent(Object.assign(new Event("message"), { data: "{not json" })); // Before the transfer can finish.
  const [, r] = await Promise.all([settle(sending.promise), settle(receiving.promise)]);
  assert.equal(r.ok, false);
  assert.equal(sink.finished, false);
});

test("blob sink keeps memory bounded, honours its limit, and commits only on finish", async () => {
  const sink = new T.BlobSink({ maxBytes: 20 * 1048576, mime: "video/mp4" });
  for (let i = 0; i < 12; i++) await sink.write(new Uint8Array(T.BLOCK).fill(i));
  assert.ok(sink.pendingBytes < 8 * 1048576 + 1, "pending bytes are merged into the blob regularly");
  const { blob } = await sink.finish();
  assert.equal(blob.size, 12 * T.BLOCK);
  assert.equal(blob.type, "video/mp4");
  const small = new T.BlobSink({ maxBytes: T.BLOCK });
  await small.write(new Uint8Array(T.BLOCK));
  await assert.rejects(() => small.write(new Uint8Array(1)), /too large to receive in this browser/);
  await small.abort();
  assert.equal(small.blob.size, 0);
});

test("saving straight to disk commits only after verification and aborts on failure", async () => {
  const log = [];
  const handle = { async createWritable() { return { async write(b) { log.push("write " + b.length); }, async close() { log.push("close"); }, async abort() { log.push("abort"); } }; }, async getFile() { return { name: "saved" }; } };
  const good = random(T.BLOCK + 3);
  const ok = await run(good, { sink: new T.FileSystemSink(handle) });
  assert.equal(ok.receiver.ok, true);
  assert.deepEqual(log, [`write ${T.BLOCK}`, "write 3", "close"]);
  log.length = 0;
  const [a, b] = pair();
  let n = 0;
  a.hook = (p) => { if (typeof p !== "string" && ++n === 3) { const x = new Uint8Array(p); x[0] ^= 1; return x.buffer; } return p; };
  const bad = await run(random(T.BLOCK * 2), { senderChannel: a, receiverChannel: b, sink: new T.FileSystemSink(handle) });
  assert.equal(bad.receiver.ok, false);
  assert.ok(!log.includes("close"), "the file was never committed");
});

// ---------- WebRTC glue with a fake peer connection ----------
class FakePC {
  static registry = new Map();
  constructor() { this.candidates = []; this.iceConnectionState = "new"; this.connectionState = "new"; this.localDescription = null; this.added = []; }
  createDataChannel() { this.channel = new FakeChannel(); this.channel.readyState = "connecting"; return this.channel; }
  async createOffer() { const id = crypto.randomBytes(4).toString("hex"); FakePC.registry.set(id, this); return { type: "offer", sdp: "offer-" + id }; }
  async createAnswer() { return { type: "answer", sdp: "answer-" + this.remoteId }; }
  async setLocalDescription(description) {
    this.localDescription = description;
    setTimeout(() => { for (const n of [1, 2, 3]) this.onicecandidate({ candidate: { candidate: `candidate:${n}`, sdpMid: "0", sdpMLineIndex: 0 } }); this.onicecandidate({ candidate: null }); }, 1);
  }
  async setRemoteDescription(description) {
    this.remote = description;
    if (description.type === "offer") { this.remoteId = description.sdp.slice(6); this.owner = FakePC.registry.get(this.remoteId); }
    else if (this.channel) { // The answer arrived: the connection is up.
      const peerSide = new FakeChannel(); peerSide.peer = this.channel; this.channel.peer = peerSide;
      const peer = FakePC.registry.get(description.sdp.slice(7)).partner;
      this.connectedTo = peerSide;
      setTimeout(() => { this.channel.readyState = "open"; this.channel.dispatchEvent(new Event("open")); if (this.partner) this.partner.ondatachannel({ channel: peerSide }); setTimeout(() => peerSide.dispatchEvent(new Event("open")), 1); }, 5);
    }
  }
  async addIceCandidate(candidate) { if (!this.remote) throw new Error("candidate before remote description"); this.added.push(candidate); }
  close() { this.closed = true; }
}

test("the offer/answer/ICE exchange connects two peers, even when candidates arrive early", async () => {
  const ownerSignals = [], requesterSignals = [];
  let ownerChannel, requesterChannel;
  const ownerPc = new FakePC(), requesterPc = new FakePC();
  const owner = T.createLink({ RTC: function () { return ownerPc; }, iceServers: [], role: "owner", sendSignal: (kind, data) => requesterSignals.push({ kind, data }), onChannel: (c) => (ownerChannel = c), onFail: (e) => { throw e; }, batchMs: 2 });
  const requester = T.createLink({ RTC: function () { return requesterPc; }, iceServers: [], role: "requester", sendSignal: (kind, data) => ownerSignals.push({ kind, data }), onChannel: (c) => (requesterChannel = c), onFail: (e) => { throw e; }, batchMs: 2 });
  ownerPc.partner = requesterPc;
  await owner.start();
  await until(() => requesterSignals.some((s) => s.kind === "offer") && requesterSignals.some((s) => s.kind === "ice"));
  assert.ok(requesterSignals.some((s) => s.kind === "ice"), "candidates are batched and sent");
  for (const signal of requesterSignals.filter((s) => s.kind === "ice")) await requester.handle("ice", signal.data); // Candidates BEFORE the offer.
  await requester.handle("offer", requesterSignals.find((s) => s.kind === "offer").data);
  assert.ok(requesterPc.added.length >= 3, "early candidates were buffered, then applied");
  await owner.handle("answer", ownerSignals.find((s) => s.kind === "answer").data);
  await until(() => ownerChannel && requesterChannel);
  assert.ok(ownerChannel && requesterChannel, "both sides received an open data channel");
  owner.close(); requester.close();
  assert.ok(ownerPc.closed && requesterPc.closed);
});

test("when no direct path exists the failure is explained, and closing stops the timer", async () => {
  const failures = [];
  const link = T.createLink({ RTC: function () { return new FakePC(); }, iceServers: [], role: "owner", sendSignal: () => {}, onChannel: () => {}, onFail: (e) => failures.push(e.message), openMs: 30 });
  await link.start();
  await until(() => failures.length === 1);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /direct connection could not be made.*Nothing was uploaded/s);
  const quiet = [];
  const second = T.createLink({ RTC: function () { return new FakePC(); }, iceServers: [], role: "owner", sendSignal: () => {}, onChannel: () => {}, onFail: (e) => quiet.push(e), openMs: 30 });
  await second.start();
  second.close();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(quiet.length, 0, "a link closed on purpose never reports a failure");
  const stateFailure = [];
  const third = T.createLink({ RTC: function () { const pc = new FakePC(); setTimeout(() => { pc.iceConnectionState = "failed"; pc.oniceconnectionstatechange(); }, 5); return pc; }, iceServers: [], role: "requester", sendSignal: () => {}, onChannel: () => {}, onFail: (e) => stateFailure.push(e.message), openMs: 5000 });
  await new Promise((r) => setTimeout(r, 30));
  assert.match(stateFailure[0], /direct connection could not be made/);
  third.close();
});

test("timers are never invoked with a receiver (browsers throw 'Illegal invocation')", async () => {
  const strictTimer = function (fn, ms) { "use strict"; if (this !== undefined) throw new TypeError("Illegal invocation"); return setTimeout(fn, ms); };
  const strictClear = function (id) { "use strict"; if (this !== undefined) throw new TypeError("Illegal invocation"); return clearTimeout(id); };
  const timers = { setTimer: strictTimer, clearTimer: strictClear, idleMs: 400 };
  const content = random(T.BLOCK + 9);
  const [a, b] = pair();
  const sink = new RecordingSink();
  const receiving = T.receiveFile({ channel: b, expected: { size: content.length }, sink, subtle, timers });
  const sending = T.sendFile({ channel: a, file: new Blob([content]), subtle, timers });
  const [s, r] = await Promise.all([settle(sending.promise), settle(receiving.promise)]);
  assert.equal(r.ok, true, r.error && r.error.message);
  assert.equal(s.ok, true, s.error && s.error.message);
  const link = T.createLink({ RTC: function () { return new FakePC(); }, iceServers: [], role: "owner", sendSignal: () => {}, onChannel: () => {}, onFail: () => {},
    timers: { setTimeout: strictTimer, clearTimeout: strictClear }, openMs: 20, batchMs: 5 });
  await link.start();
  link.close();
});

test("the transfer module contains no network code other than WebRTC", () => {
  const source = require("node:fs").readFileSync(require.resolve("../static/hub-transfer.js"), "utf8");
  for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /\/api\//, /FormData/, /localStorage/, /sessionStorage/])
    assert.doesNotMatch(source, pattern, String(pattern));
});
