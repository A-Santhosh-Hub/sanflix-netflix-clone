/* Shared Hub UI against the REAL server (production Waitress, throwaway secrets and databases).
 * Only WebRTC and file bytes are faked; signaling, approval, limits and presence are the server's own. */
process.env.SANFLIX_DEV = process.env.SANFLIX_DEV || "1";
const PYTHON = require("./python-bin.cjs");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, "static", file), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
let base, server, tmp, hubDb;

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-room-test-"));
  const envFile = path.join(tmp, "sanflix.env");
  spawnSync(PYTHON, ["make_secrets.py"], { cwd: root, env: { ...process.env, SANFLIX_ENV_FILE: envFile }, stdio: "ignore" });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  hubDb = path.join(tmp, "hub.sqlite3");
  server = spawn(PYTHON, ["serve.py"], { cwd: root, stdio: "ignore", env: { ...process.env, SANFLIX_ENV_FILE: envFile, SANFLIX_PORT: String(port), SANFLIX_HOST: "127.0.0.1",
    SANFLIX_SHARE_DB: path.join(tmp, "share.sqlite3"), SANFLIX_HUB_DB: hubDb, SANFLIX_HUB_STUN: "" } });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/login")).ok) return; } catch (_) {} await sleep(250); }
  throw new Error("the test server did not start");
});
after(() => { try { server.kill(); } catch (_) {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

// Each scenario starts with an empty room, so earlier scenarios' still-online shares never leak into it.
function resetRoom() {
  const { DatabaseSync } = require("node:sqlite");
  if (!fs.existsSync(hubDb)) return;
  const db = new DatabaseSync(hubDb);
  try { db.exec("PRAGMA busy_timeout=5000; DELETE FROM signals; DELETE FROM transfers; DELETE FROM shares; DELETE FROM participants;"); } finally { db.close(); }
}
const scenario = (name, fn) => test(name, async (context) => { resetRoom(); await fn(context); });

function newBrowser() {
  const jar = new Map(), log = [];
  let inflight = 0;
  async function live(url, options = {}) {
    inflight++;
    try {
      const headers = { ...(options.headers || {}) };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const response = await fetch(base + url, { method: options.method || "GET", headers, body: options.body, redirect: "manual" });
      for (const line of response.headers.getSetCookie()) { const [pair] = line.split(";"); const i = pair.indexOf("="); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      log.push({ method: options.method || "GET", url, body: options.body, headers, status: response.status });
      return response;
    } finally { inflight--; }
  }
  return { jar, log, live, idle: async () => { for (let i = 0; i < 300 && inflight; i++) await sleep(5); await flush(); } };
}

function makeHooks() {
  const hooks = { hold: new Set(), waiting: new Map(), saves: [], closed: [], jobs: [], clicks: [], sendStarted: 0, receiveStarted: 0, receiveError: null, events: [] };
  hooks.gate = (name) => hooks.hold.has(name) ? new Promise((resolve) => hooks.waiting.set(name, resolve)) : Promise.resolve();
  hooks.release = (name) => { hooks.hold.delete(name); const resolve = hooks.waiting.get(name); if (resolve) { hooks.waiting.delete(name); resolve(); } };
  return hooks;
}

async function openPage({ browser = newBrowser(), hooks = makeHooks(), mobile = false, picker = null } = {}) {
  const live = await browser.live("/hub");
  const html = await live.text();
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(html, { url: base + "/hub", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document;
  if (mobile) Object.defineProperty(w.navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36" });
  await new Promise((resolve) => { if (d.readyState === "complete") resolve(); else w.addEventListener("load", resolve, { once: true }); });
  const timers = new Map();
  let timerId = 0;
  w.setTimeout = (fn) => { timers.set(++timerId, fn); return timerId; };
  w.clearTimeout = (id) => timers.delete(id);
  w.setInterval = (fn) => { timers.set(++timerId, () => {}); return timerId; };
  w.clearInterval = (id) => timers.delete(id);
  w.scrollTo = () => {};
  w.matchMedia = () => ({ matches: false });
  w.fetch = (url, options) => { hooks.events.push("fetch " + (options && options.method || "GET") + " " + url); return browser.live(url, options); };
  w.URL.createObjectURL = (object) => "blob:test/" + Math.random().toString(16).slice(2);
  w.URL.revokeObjectURL = () => {};
  Object.defineProperty(w.HTMLMediaElement.prototype, "play", { configurable: true, value() { return Promise.resolve(); } });
  Object.defineProperty(w.HTMLMediaElement.prototype, "pause", { configurable: true, value() {} });
  Object.defineProperty(w.HTMLMediaElement.prototype, "load", { configurable: true, value() {} });
  w.HTMLAnchorElement.prototype.click = function () { hooks.clicks.push(this.download); };
  Object.defineProperty(w, "isSecureContext", { value: Boolean(picker) });
  w.RTCPeerConnection = class {}; // jsdom has no WebRTC; createLink is replaced below, so this only signals support.
  if (picker) w.showSaveFilePicker = async (options) => { hooks.events.push("picker " + options.suggestedName); return picker(options); };
  for (const file of ["hub.js", "hub-transfer.js"]) w.eval(read(file));
  const T = w.SanflixTransfer;
  T.createLink = ({ role, sendSignal, onChannel }) => ({
    async start() { sendSignal("offer", { type: "offer", sdp: "fake-offer" }); },
    async handle(kind) {
      if (kind === "offer" && role === "requester") { sendSignal("answer", { type: "answer", sdp: "fake-answer" }); onChannel({ fake: true }); }
      else if (kind === "answer" && role === "owner") onChannel({ fake: true });
    },
    close() { hooks.closed.push(role); },
  });
  T.sendFile = ({ file, onProgress }) => {
    let cancelled = false;
    hooks.sendStarted++;
    const job = { cancelled: false, cancel() { cancelled = true; job.cancelled = true; } };
    job.promise = (async () => { await hooks.gate("send"); if (cancelled) throw new Error("Cancelled."); onProgress({ done: file.size, total: file.size }); return { size: file.size }; })();
    hooks.jobs.push(job);
    return job;
  };
  T.receiveFile = ({ expected, sink, onProgress }) => {
    let cancelled = false;
    hooks.receiveStarted++;
    const job = { cancelled: false, cancel() { cancelled = true; job.cancelled = true; } };
    job.promise = (async () => {
      await hooks.gate("receive");
      if (cancelled) throw new Error("Cancelled.");
      if (hooks.receiveError) throw hooks.receiveError;
      onProgress({ done: expected.size, total: expected.size });
      return sink && sink.maxBytes ? { size: expected.size, blob: new w.Blob(["x".repeat(Math.min(expected.size, 64))]) } : { size: expected.size, file: {} };
    })();
    hooks.jobs.push(job);
    return job;
  };
  w.eval(read("hub-room.js"));
  const page = {
    w, d, browser, hooks, errors, $: (id) => d.getElementById(id), log: browser.log,
    async tick(times = 1) { for (let i = 0; i < times; i++) { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); await browser.idle(); await flush(); } },
    file(name, { type = "", size = 1000, content = "x" } = {}) { const f = new w.File([content], name, { type, lastModified: 1700000000000 }); Object.defineProperty(f, "size", { value: size }); return f; },
    choose(files) { const input = d.getElementById("hub-input-files"); Object.defineProperty(input, "files", { configurable: true, value: files }); input.dispatchEvent(new w.Event("change", { bubbles: true })); },
    share(items) { d.dispatchEvent(new w.CustomEvent("hub:share", { detail: { items } })); },
    openFriends() { d.getElementById("hub-mode-friends").click(); },
    cards: () => [...d.querySelectorAll(".room-card")],
    cardFor: (name) => [...d.querySelectorAll(".room-card")].find((c) => c.querySelector(".room-name").textContent === name),
    press: (name, label) => { const card = page.cardFor(name); [...card.querySelectorAll(".room-actions button")].find((b) => b.textContent.trim() === label).click(); },
    status: (name) => page.cardFor(name).querySelector(".room-status").textContent,
    prompts: () => [...d.querySelectorAll("#hub-requests .room-request:not(.room-sending)")],
    posts: (suffix) => browser.log.filter((r) => r.method === "POST" && r.url.endsWith(suffix)),
    hub: () => browser.log.filter((r) => r.url.includes("/api/hub")),
  };
  return page;
}

async function converge(pages, condition, rounds = 80) { // Rounds, not time; a loaded machine just needs more of them.
  for (let i = 0; i < rounds; i++) { for (const page of pages) await page.tick(); if (await condition()) return true; }
  const describe = (page) => JSON.stringify({ joined: page.w.SanflixRoom.joined(), shares: page.w.SanflixRoom.state.shares.length, cards: page.cards().length,
    mode: page.w.SanflixRoom.state.mode, stopped: page.w.SanflixRoom.state.stopped, failures: page.w.SanflixRoom.state.failures,
    notice: page.d.getElementById("room-notice").textContent.slice(0, 120), calls: page.hub().filter((r) => !r.url.includes("/poll")).slice(-8).map((r) => `${r.method} ${r.url.replace("/api/hub/", "")} ${r.status}`), transfers: [...page.w.SanflixRoom.transfers.values()].map((t) => `${t.role}:${t.state}:${t.finished ? "finished" : "live"}`), statuses: [...page.d.querySelectorAll(".room-status")].map((n) => n.textContent.slice(0, 80)), sendStarted: page.hooks.sendStarted, receiveStarted: page.hooks.receiveStarted });
  throw new Error("did not converge: " + condition + "\n" + pages.map(describe).join("\n"));
}
const item = (id, name, size = 1000, kind = "video", file) => ({ id, name, size, kind, mime: "", file });

scenario("nothing is sent to the server until the friends area is opened or something is shared", async () => {
  const page = await openPage();
  page.choose([page.file("a.mp4", { type: "video/mp4" }), page.file("b.jpg")]);
  await page.tick(2);
  assert.equal(page.hub().length, 0, "local-only use makes no Hub requests");
  page.openFriends();
  await converge([page], () => page.w.SanflixRoom.joined());
  assert.equal(page.posts("/api/hub/join").length, 1);
  assert.deepEqual(page.errors, []);
});

scenario("sharing sends metadata only, never contents, and unshared files stay private", async () => {
  const owner = await openPage(), friend = await openPage();
  const secret = owner.file("holiday film.mp4", { type: "video/mp4", size: 1234, content: "SENTINEL-FILE-CONTENT-9f2" });
  owner.choose([secret, owner.file("private diary.mp4", { type: "video/mp4", size: 77, content: "SENTINEL-PRIVATE-BYTES" })]);
  owner.d.querySelectorAll("#hub-library .hub-tile .hub-share")[0].click();
  await converge([owner], () => owner.posts("/api/hub/shares").length === 1);
  const sent = owner.posts("/api/hub/shares")[0];
  assert.deepEqual(JSON.parse(sent.body), { items: [{ name: "holiday film.mp4", size: 1234, mime: "video/mp4", kind: "video", ref: "1" }] });
  assert.equal(typeof sent.body, "string");
  assert.ok(owner.hub().every((r) => !String(r.body || "").includes("SENTINEL")), "no file content in any request");
  assert.equal(sent.headers["Content-Type"], "application/json");
  assert.ok(sent.headers["X-CSRF-Token"] && sent.headers["X-Hub-Epoch"]);
  assert.match(owner.d.querySelectorAll("#hub-library .hub-tile .hub-share")[0].textContent, /Stop sharing/);
  assert.match(owner.d.querySelectorAll("#hub-library .hub-tile .hub-share")[1].textContent, /Share to Hub/);
  friend.openFriends();
  await converge([owner, friend], () => friend.cards().length === 1);
  assert.equal(friend.cards()[0].querySelector(".room-name").textContent, "holiday film.mp4");
  assert.ok(![...friend.d.querySelectorAll(".room-name")].some((n) => /diary/.test(n.textContent)));
  assert.ok(friend.hub().every((r) => !String(r.body || "").includes("SENTINEL")));
});

scenario("every shared item gets a card (including the first), updates in place, and text is never HTML", async () => {
  const owner = await openPage(), friend = await openPage();
  owner.openFriends();
  await converge([owner], () => owner.w.SanflixRoom.joined());
  const names = ["one.mp4", "two.jpg", "<img src=x onerror=alert(1)>.mp3", "four.mp4", "five.mp4"];
  owner.share(names.map((name, i) => item(100 + i, name, 500 + i, name.endsWith(".jpg") ? "image" : name.endsWith(".mp3") ? "audio" : "video", owner.file(name))));
  friend.openFriends();
  await converge([owner, friend], () => friend.cards().length === 5 && owner.d.querySelectorAll(".room-card.room-own").length === 5);
  assert.deepEqual(friend.cards().map((c) => c.querySelector(".room-name").textContent).sort(), [...names].sort());
  assert.equal(friend.d.querySelectorAll(".room-name img").length, 0, "markup in a file name stays text");
  const before = friend.cards();
  await friend.tick(2);
  assert.ok(friend.cards().every((c, i) => c === before[i]), "polling updates cards in place instead of rebuilding them");
  friend.d.querySelector('.room-filter[data-filter="image"]').click();
  assert.equal(friend.cards().filter((c) => !c.isConnected).length, 0);
  assert.deepEqual(friend.cards().map((c) => c.querySelector(".room-name").textContent), ["two.jpg"]);
  friend.d.querySelector('.room-filter[data-filter="all"]').click();
  friend.d.getElementById("room-search").value = "FIVE";
  friend.d.getElementById("room-search").dispatchEvent(new friend.w.Event("input", { bubbles: true }));
  assert.deepEqual(friend.cards().map((c) => c.querySelector(".room-name").textContent), ["five.mp4"]);
  friend.d.getElementById("room-search").value = "";
  friend.d.getElementById("room-search").dispatchEvent(new friend.w.Event("input", { bubbles: true }));
  assert.equal(friend.d.getElementById("hub-friends-count").textContent, "5");
  assert.equal(owner.d.querySelectorAll(".room-card.room-own").length, 5, "the owner sees their own items marked as theirs");
  assert.ok([...owner.d.querySelectorAll(".room-card.room-own .room-actions button")].every((b) => b.textContent === "Stop sharing"));
});

scenario("a request for a shared item starts sending at once, with no prompt, and the file is received, verified and offered for saving", async () => {
  const owner = await openPage(), friend = await openPage();
  friend.openFriends();
  owner.openFriends();
  owner.share([item(1, "clip.mp4", 2000, "video", owner.file("clip.mp4", { size: 2000 }))]);
  await converge([owner, friend], () => friend.cards().length === 1);
  friend.press("clip.mp4", "Download Original");
  assert.equal(owner.prompts().length, 0, "the owner is never asked: sharing the item was the permission");
  await converge([owner, friend], () => /Received and verified/.test(friend.status("clip.mp4"))); // The fake receiver does not need the sender, so only the friend's side is awaited.
  assert.equal(friend.hooks.receiveStarted, 1);
  const save = friend.cardFor("clip.mp4").querySelector("a.room-save");
  assert.equal(save.download, "clip.mp4");
  assert.match(save.href, /^blob:/);
  assert.deepEqual(friend.hooks.clicks, ["clip.mp4"], "the browser's save is triggered once");
  await converge([owner, friend], () => owner.w.SanflixRoom.transfers.size === 0 && friend.w.SanflixRoom.transfers.size === 0);
  friend.press("clip.mp4", "Download Original");
  await converge([owner, friend], () => friend.posts("/request").length === 2); // The second ask went through (the first one freed its slot).
  assert.equal(friend.hub().filter((r) => r.url.endsWith("/request")).every((r) => r.status === 201), true, "the finished transfer freed its slot");
  assert.deepEqual([...owner.errors, ...friend.errors], []);
});

scenario("friends' media are boxes: clicking a box plays it straight away, and the playing box takes the whole row", async () => {
  const owner = await openPage(), friend = await openPage();
  friend.openFriends();
  owner.openFriends();
  owner.share([item(1, "clip.mp4", 2000, "video", owner.file("clip.mp4", { size: 2000 }))]);
  await converge([owner, friend], () => friend.cards().length === 1 && owner.cards().length === 1);
  const requests = (page) => page.hub().filter((r) => r.url.endsWith("/request")).length;
  owner.cardFor("clip.mp4").querySelector(".room-art").click();
  await owner.w.SanflixRoom.poll();
  assert.equal(requests(owner), 0, "clicking your own box requests nothing");
  assert.equal(friend.cardFor("clip.mp4").classList.contains("room-has-player"), false);
  friend.cardFor("clip.mp4").querySelector(".room-art").click();
  await converge([owner, friend], () => /Received and verified/.test(friend.status("clip.mp4")));
  assert.equal(friend.cardFor("clip.mp4").classList.contains("room-has-player"), true);
  assert.ok(friend.cardFor("clip.mp4").querySelector(".room-player video"));
  assert.equal(requests(friend), 1, "one request, for playing");
  assert.deepEqual([...owner.errors, ...friend.errors], []);
});

scenario("a request is declined, with an explanation, if the shared file no longer matches what was announced", async () => {
  const owner = await openPage(), friend = await openPage();
  owner.openFriends(); friend.openFriends();
  owner.share([item(1, "song.mp3", 900, "audio", owner.file("song.mp3", { size: 901 }))]); // The file changed after it was announced.
  await converge([owner, friend], () => friend.cards().length === 1);
  friend.press("song.mp3", "Download Original");
  await converge([owner, friend], () => /declined/.test(friend.status("song.mp3")));
  assert.equal(owner.hooks.sendStarted + friend.hooks.receiveStarted, 0);
  assert.match(owner.d.getElementById("room-notice").textContent, /changed or is no longer available/);
  assert.ok(!friend.cardFor("song.mp3").querySelector(".room-actions button").disabled);
});

scenario("a failed transfer says why, discards partial data and offers Retry", async () => {
  const owner = await openPage(), friend = await openPage();
  friend.hooks.receiveError = new Error("The connection closed before the transfer finished.");
  owner.openFriends(); friend.openFriends();
  owner.share([item(1, "movie.mp4", 3000, "video", owner.file("movie.mp4", { size: 3000 }))]);
  await converge([owner, friend], () => friend.cards().length === 1);
  friend.press("movie.mp4", "Download Original");
  await converge([owner, friend], () => /Failed:/.test(friend.status("movie.mp4")));
  assert.match(friend.status("movie.mp4"), /Failed: The connection closed before the transfer finished\./);
  assert.ok(friend.cardFor("movie.mp4").querySelector(".room-status").classList.contains("room-failed"));
  assert.equal(friend.cardFor("movie.mp4").querySelector("a.room-save"), null, "nothing is offered for saving");
  await converge([owner, friend], () => owner.w.SanflixRoom.transfers.size === 0);
  friend.hooks.receiveError = null;
  friend.press("movie.mp4", "Retry");
  await converge([owner, friend], () => /Received and verified/.test(friend.status("movie.mp4")));
});

scenario("cancelling mid-transfer stops both sides and frees the slot", async () => {
  const owner = await openPage(), friend = await openPage();
  friend.hooks.hold.add("receive"); owner.hooks.hold.add("send");
  owner.openFriends(); friend.openFriends();
  owner.share([item(1, "big.mp4", 5000, "video", owner.file("big.mp4", { size: 5000 }))]);
  await converge([owner, friend], () => friend.cards().length === 1);
  friend.press("big.mp4", "Download Original");
  await converge([owner, friend], () => friend.hooks.receiveStarted === 1 && owner.hooks.sendStarted === 1);
  friend.press("big.mp4", "Cancel");
  assert.equal(friend.hooks.jobs[0].cancelled, true);
  await converge([owner, friend], () => owner.w.SanflixRoom.transfers.size === 0);
  assert.equal(owner.hooks.jobs[0].cancelled, true, "the sender is told to stop");
  assert.match(friend.status("big.mp4"), /Cancelled/);
  assert.ok(friend.posts("/status").some((r) => JSON.parse(r.body).status === "cancelled"));
  owner.hooks.release("send"); friend.hooks.release("receive");
  friend.press("big.mp4", "Download Original");
  await converge([owner, friend], () => friend.posts("/request").length === 2); // The second ask went through (the first one freed its slot).
});

scenario("saving to disk asks for the file location first, and a cancelled dialog sends no request", async () => {
  const owner = await openPage();
  const handle = { createWritable: async () => ({}), getFile: async () => ({}) };
  const friend = await openPage({ picker: async () => handle });
  owner.openFriends(); friend.openFriends();
  owner.share([item(1, "keep.mp4", 800, "video", owner.file("keep.mp4", { size: 800 }))]);
  await converge([owner, friend], () => friend.cards().length === 1);
  friend.press("keep.mp4", "Download Original");
  await converge([owner, friend], () => friend.hooks.events.some((e) => e.includes("/request")));
  const order = friend.hooks.events.filter((e) => e.startsWith("picker") || e.includes("/request"));
  assert.match(order[0], /^picker keep\.mp4$/, "the save dialog opens first, inside the click");
  assert.match(order[1], /\/request$/);
  const refuser = await openPage({ picker: async () => { const e = new Error("cancelled"); e.name = "AbortError"; throw e; } });
  refuser.openFriends();
  await converge([owner, refuser], () => refuser.cards().length === 1);
  refuser.press("keep.mp4", "Download Original");
  await refuser.tick(3);
  assert.equal(refuser.posts("/request").length, 0);
  assert.match(refuser.d.getElementById("room-notice").textContent, /Saving was cancelled/);
});

scenario("files too large for this browser's memory are refused before any request, with advice", async () => {
  const owner = await openPage();
  const phone = await openPage({ mobile: true });
  owner.openFriends(); phone.openFriends();
  owner.share([item(1, "long film.mp4", 300 * 1048576, "video", owner.file("long film.mp4", { size: 300 * 1048576 })),
    item(2, "huge.mp4", 700 * 1048576, "video", owner.file("huge.mp4", { size: 700 * 1048576 }))]);
  await converge([owner, phone], () => phone.cards().length === 2);
  phone.press("long film.mp4", "Download Original");
  await phone.tick(2);
  assert.match(phone.d.getElementById("room-notice").textContent, /can only hold 256\.0 MB in memory.*Chrome or Edge on a computer/);
  phone.press("huge.mp4", "Play");
  await phone.tick(2);
  assert.match(phone.d.getElementById("room-notice").textContent, /512\.0 MB in memory for playback/);
  assert.equal(phone.posts("/request").length, 0, "no request was made for either file");
});

scenario("stopping sharing, or removing the local item, removes it for friends", async () => {
  const owner = await openPage(), friend = await openPage();
  owner.choose([owner.file("a.mp4", { type: "video/mp4" }), owner.file("b.mp4", { type: "video/mp4" })]);
  owner.d.querySelectorAll("#hub-library .hub-tile .hub-share").forEach((b) => b.click());
  await converge([owner], () => owner.w.SanflixRoom.state.shares.length === 2 || owner.posts("/api/hub/shares").length === 2);
  friend.openFriends();
  await converge([owner, friend], () => friend.cards().length === 2);
  owner.d.querySelectorAll("#hub-library .hub-tile .hub-share")[0].click();
  await converge([owner, friend], () => friend.cards().length === 1);
  assert.match(owner.d.querySelectorAll("#hub-library .hub-tile .hub-share")[0].textContent, /Share to Hub/);
  assert.equal(friend.cards()[0].querySelector(".room-name").textContent, "b.mp4");
  const second = [...owner.d.querySelectorAll("#hub-library .hub-tile")].find((reel) => reel.querySelector(".hub-name").textContent === "b.mp4");
  second.querySelector(".hub-remove").click(); // Removing the still-shared local item stops sharing it too.
  await converge([owner, friend], () => friend.cards().length === 0);
  assert.equal(owner.w.SanflixRoom.mine.size, 0);
  assert.equal(friend.d.getElementById("room-empty").hidden, false);
});

scenario("a second tab takes over and the first one stops instead of fighting for the room", async () => {
  const browser = newBrowser();
  const first = await openPage({ browser });
  first.openFriends();
  await converge([first], () => first.w.SanflixRoom.joined());
  const second = await openPage({ browser });
  second.openFriends();
  await converge([second], () => second.w.SanflixRoom.joined());
  await converge([first], () => first.w.SanflixRoom.state.stopped);
  assert.match(first.d.getElementById("room-notice").textContent, /open in another tab/);
  assert.equal(second.w.SanflixRoom.state.stopped, false);
});

scenario("renaming is shown to friends as plain text with a short id tag", async () => {
  const a = await openPage(), b = await openPage();
  a.openFriends(); b.openFriends();
  await converge([a, b], () => a.w.SanflixRoom.joined() && b.w.SanflixRoom.joined());
  a.d.getElementById("room-rename").click();
  a.d.getElementById("room-name-input").value = "<b>Zed</b>";
  a.d.getElementById("room-name-save").click();
  await converge([a, b], () => b.w.SanflixRoom.state.people.some((p) => p.name === "<b>Zed</b>"));
  assert.equal(a.d.getElementById("room-name").textContent, "<b>Zed</b>");
  assert.equal(a.d.querySelectorAll("#room-name b").length, 0);
  assert.match(a.d.getElementById("room-tag").textContent, /^#[a-f0-9]{4}$/);
});

scenario("a request can never carry media: file-like values are refused before any network call", async () => {
  const page = await openPage();
  page.openFriends();
  await converge([page], () => page.w.SanflixRoom.joined());
  const before = page.hub().length;
  page.share([{ id: 1, name: new page.w.Blob(["bytes"]), size: 10, kind: "video", mime: "", file: page.file("x.mp4") }]);
  await page.tick(2);
  assert.equal(page.hub().filter((r) => r.url.endsWith("/api/hub/shares") && r.method === "POST").length, 0);
  assert.match(page.d.getElementById("room-notice").textContent, /Media can never be sent to the server/);
  assert.ok(page.hub().length >= before);
});

test("room and transfer scripts contain no uploads, no content reads outside the transfer module, and only Hub API calls", () => {
  const room = read("hub-room.js"), hub = read("hub.js"), transfer = read("hub-transfer.js");
  for (const pattern of [/XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /FormData/, /FileReader/, /\.arrayBuffer\s*\(/, /\bfile\.slice\s*\(/, /localStorage/, /sessionStorage/, /createObjectURL\s*\(\s*item\.file/])
    assert.doesNotMatch(room, pattern, "hub-room.js " + pattern);
  for (const match of room.matchAll(/call\(\s*[`"']([^`"']+)/g)) assert.match(match[1], /^\/api\/hub\//, match[1]);
  assert.doesNotMatch(hub, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|\.arrayBuffer\s*\(|FileReader/, "hub.js stays free of network and content reads");
  assert.match(transfer, /file\.slice\(offset/, "the transfer module is the only place that reads a file");
  assert.doesNotMatch(transfer, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/);
});
