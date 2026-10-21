/* Hub: real template + real hub.js in jsdom. No server or browser needed. */
process.env.SANFLIX_DEV = process.env.SANFLIX_DEV || "1"; // Templates are rendered by importing the app.
const PYTHON = require("./python-bin.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.resolve(__dirname, "..");
const renderPage = (name) =>
  execFileSync(PYTHON, ["-c", `from app import app; from flask import render_template\nwith app.test_request_context('/'):\n print(render_template('${name}'))`], {
    cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
const hubHtml = renderPage("hub.html");
const hubSource = fs.readFileSync(path.join(root, "static", "hub.js"), "utf8");
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

async function openHub(t, { folderSupport = true, observer = true, stored = {}, phone = null } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(hubHtml, { url: "https://friends.example/hub", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  t.after(() => dom.window.close());
  const { window: w } = dom;
  const d = w.document;
  await new Promise((resolve) => { if (d.readyState === "complete") resolve(); else w.addEventListener("load", resolve, { once: true }); });
  for (const [key, value] of Object.entries(stored)) w.sessionStorage.setItem(key, value);

  const log = [], network = [], reads = [], created = [], revoked = [];
  let counter = 0;
  w.URL.createObjectURL = (object) => { const url = "blob:hub/" + ++counter; created.push({ url, object }); return url; };
  w.URL.revokeObjectURL = (url) => { revoked.push(url); log.push("revoke " + url); };
  const media = w.HTMLMediaElement.prototype;
  Object.defineProperty(media, "play", { configurable: true, value() { log.push("play"); return Promise.resolve(); } });
  Object.defineProperty(media, "pause", { configurable: true, value() { log.push("pause"); } });
  Object.defineProperty(media, "load", { configurable: true, value() { log.push("load"); } });
  w.fetch = (...args) => { network.push(["fetch", args[0]]); return Promise.reject(new Error("network")); };
  w.XMLHttpRequest = class { constructor() { network.push(["xhr"]); } };
  w.WebSocket = class { constructor() { network.push(["websocket"]); } };
  w.navigator.sendBeacon = (...args) => { network.push(["beacon", args[0]]); return false; };
  for (const method of ["arrayBuffer", "text", "stream", "slice"]) {
    if (w.File.prototype[method]) w.File.prototype[method] = function () { reads.push(method); throw new Error("content read"); };
  }
  w.FileReader = class { constructor() { reads.push("FileReader"); } };
  if (folderSupport)
    Object.defineProperty(w.HTMLInputElement.prototype, "webkitdirectory", { configurable: true, get() { return this.hasAttribute("webkitdirectory"); } });

  const observers = [];
  if (observer)
    w.IntersectionObserver = class { constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); } observe(node) { this.targets.add(node); } unobserve() {} disconnect() { this.targets.clear(); } };
  if (phone !== null) w.matchMedia = (query) => ({ matches: phone && /max-width:\s*640px/.test(query), addEventListener() {}, removeEventListener() {} });
  w.eval(hubSource);
  await flush();

  const $ = (id) => d.getElementById(id);
  const hub = {
    w, d, $, log, network, reads, created, revoked, errors,
    file(name, { type = "", size = 1024, rel = "" } = {}) {
      const file = new w.File(["x".repeat(Math.min(size, 16))], name, { type, lastModified: 1700000000000 });
      Object.defineProperty(file, "size", { value: size });
      if (rel) Object.defineProperty(file, "webkitRelativePath", { value: rel });
      return file;
    },
    choose(inputId, files) {
      const input = $(inputId);
      Object.defineProperty(input, "files", { configurable: true, value: files });
      input.dispatchEvent(new w.Event("change", { bubbles: true }));
    },
    thumbObserver: () => observers.find((o) => o.options && o.options.rootMargin),
    open(index) { d.querySelectorAll("#hub-library .hub-tile-open")[index].click(); },
    tiles: () => [...d.querySelectorAll("#hub-library .hub-tile")],
    names: () => [...d.querySelectorAll("#hub-library .hub-tile:not([hidden]) .hub-name")].map((n) => n.textContent),
    liveMedia: () => d.querySelectorAll("#hub-viewer-stage video, #hub-viewer-stage audio, #hub-viewer-stage img.hub-media"),
    viewerOpen: () => !$("hub-viewer").hidden,
    notice: () => $("hub-notice").textContent,
    click: (selector) => d.querySelector(selector).click(),
  };
  t.after(() => assert.deepEqual(errors, [], "no DOM errors"));
  return hub;
}

test("the Hub appears in every navigation and is marked active on its own page", async () => {
  for (const name of ["index.html", "youtube.html", "hub.html"]) {
    const dom = new JSDOM(renderPage(name));
    const d = dom.window.document;
    const desktop = [...d.querySelectorAll(".nav-links a")].find((a) => a.textContent.trim() === "Hub");
    const mobile = [...d.querySelectorAll(".mobile-nav a")].find((a) => a.textContent.trim() === "Hub");
    assert.equal(desktop?.getAttribute("href"), "/hub", name);
    assert.equal(mobile?.getAttribute("href"), "/hub", name);
    assert.equal(desktop.getAttribute("aria-current"), name === "hub.html" ? "page" : null);
  }
});

test("empty state offers Add Media, which opens two clear choices", async (t) => {
  const hub = await openHub(t);
  assert.equal(hub.$("hub-empty").hidden, false);
  assert.equal(hub.$("hub-browser").hidden, true);
  assert.equal(hub.$("hub-fab").hidden, true);
  assert.equal(hub.$("hub-dialog").hidden, true);
  hub.click(".hub-add-big");
  assert.equal(hub.$("hub-dialog").hidden, false);
  assert.match(hub.$("hub-pick-files").textContent, /Select Files/);
  assert.match(hub.$("hub-pick-folder").textContent, /Select Folder/);
  let files = 0, folders = 0;
  hub.$("hub-input-files").click = () => files++;
  hub.$("hub-input-folder").click = () => folders++;
  hub.click("#hub-pick-files");
  hub.click("#hub-pick-folder");
  assert.deepEqual([files, folders], [1, 1]);
  assert.equal(hub.$("hub-input-files").multiple, true);
  assert.equal(hub.$("hub-input-folder").hasAttribute("webkitdirectory"), true);
  hub.d.dispatchEvent(new hub.w.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(hub.$("hub-dialog").hidden, true);
});

test("cancelled selections and empty folders leave the Hub working", async (t) => {
  const hub = await openHub(t);
  hub.choose("hub-input-files", []);
  assert.match(hub.notice(), /No files were selected/);
  hub.choose("hub-input-folder", []);
  assert.match(hub.notice(), /empty|did not return/);
  hub.choose("hub-input-files", [hub.file("notes.txt"), hub.file("doc.pdf")]);
  assert.match(hub.notice(), /No supported media found/);
  assert.equal(hub.w.SanflixHub.count(), 0);
  assert.equal(hub.$("hub-empty").hidden, false);
  hub.choose("hub-input-files", [hub.file("ok.mp4", { type: "video/mp4" })]);
  assert.equal(hub.w.SanflixHub.count(), 1);
});

test("multiple files are classified, summarised and shown with name, size and type", async (t) => {
  const hub = await openHub(t);
  hub.choose("hub-input-files", [
    hub.file("Funny clip.mp4", { type: "video/mp4", size: 5 * 1024 * 1024 }),
    hub.file("Goa.JPG", { size: 2048 }),
    hub.file("Song.mp3", { type: "audio/mpeg", size: 3000 }),
    hub.file("readme.txt"),
    hub.file(".hidden.mp4", { type: "video/mp4" }),
  ]);
  assert.equal(hub.w.SanflixHub.count(), 3);
  assert.match(hub.notice(), /Added 3 items \(1 video, 1 photo, 1 audio\)\. 2 unsupported files skipped\./);
  assert.equal(hub.$("hub-empty").hidden, true);
  assert.equal(hub.$("hub-fab").hidden, false);
  assert.deepEqual(hub.names(), ["Funny clip.mp4", "Goa.JPG", "Song.mp3"]);
  const facts = [...hub.d.querySelectorAll("#hub-library .hub-tile .hub-facts")].map((n) => n.textContent);
  assert.deepEqual(facts, ["5.0 MB · Video · MP4", "2.0 KB · Photo · JPG", "2.9 KB · Audio · MP3"]);
  hub.choose("hub-input-files", [hub.file("Goa.JPG", { size: 2048 })]);
  assert.match(hub.notice(), /1 already added/);
  assert.equal(hub.w.SanflixHub.count(), 3, "duplicates are ignored");
});

test("folders keep their relative names, skip hidden files, and are searchable by folder", async (t) => {
  const hub = await openHub(t);
  hub.choose("hub-input-folder", [
    hub.file("a.mp4", { type: "video/mp4", rel: "Trip/a.mp4" }),
    hub.file("b.jpg", { rel: "Trip/Goa/b.jpg" }),
    hub.file(".DS_Store", { rel: "Trip/.DS_Store" }),
    hub.file("c.mp4", { type: "video/mp4", rel: "Trip/.cache/c.mp4" }),
    hub.file("notes.txt", { rel: "Trip/notes.txt" }),
    hub.file("party.mp3", { rel: "Other/party.mp3" }),
  ]);
  assert.equal(hub.w.SanflixHub.count(), 3);
  assert.deepEqual([...hub.d.querySelectorAll(".hub-folder")].map((n) => n.textContent).sort(), ["Folder: Other", "Folder: Trip", "Folder: Trip/Goa"]);
  const search = (text) => { hub.$("hub-search").value = text; hub.$("hub-search").dispatchEvent(new hub.w.Event("input", { bubbles: true })); return hub.names(); };
  assert.deepEqual(search("goa"), ["b.jpg"]);
  assert.deepEqual(search("TRIP").sort(), ["a.mp4", "b.jpg"]);
  assert.deepEqual(search("party"), ["party.mp3"]);
  assert.deepEqual(search("trip a.mp4"), ["a.mp4"]);
  assert.deepEqual(search("zzz"), []);
  assert.equal(hub.$("hub-noresults").hidden, false);
  search("");
  assert.equal(hub.$("hub-noresults").hidden, true);
});

test("browsers without folder selection get an explanation and the Select Files fallback", async (t) => {
  const none = await openHub(t, { folderSupport: false });
  none.click(".hub-add-big");
  assert.equal(none.$("hub-pick-folder").disabled, true);
  assert.match(none.$("hub-folder-help").textContent, /cannot select a whole folder.*Select Files/);
  assert.equal(none.$("hub-pick-files").disabled, false);
  const partial = await openHub(t);
  partial.choose("hub-input-folder", [partial.file("a.mp4", { type: "video/mp4" }), partial.file("b.jpg")]); // No relative paths.
  assert.match(partial.notice(), /selected individual files, not a whole folder/);
  assert.equal(partial.w.SanflixHub.count(), 2, "the files are still added");
});

test("playback uses local object URLs created only when needed, without reading file contents", async (t) => {
  const hub = await openHub(t);
  const video = hub.file("clip.mp4", { type: "video/mp4" }), photo = hub.file("pic.png", { type: "image/png" }), song = hub.file("tune.mp3", { type: "audio/mpeg" });
  hub.choose("hub-input-files", [video, photo, song]);
  assert.equal(hub.created.length, 0, "importing creates no URLs and loads nothing");
  assert.equal(hub.liveMedia().length, 0);
  hub.open(0);
  assert.equal(hub.created.length, 1);
  assert.equal(hub.created[0].object, video, "the File itself is the source");
  const player = hub.d.querySelector("#hub-viewer-stage video");
  assert.equal(player.getAttribute("src"), hub.created[0].url);
  assert.equal(player.controls, true);
  assert.ok(hub.log.includes("play"));
  hub.click("#hub-viewer-next");
  const image = hub.d.querySelector("#hub-viewer-stage img.hub-media");
  assert.equal(image.getAttribute("src"), hub.created[1].url);
  assert.equal(hub.created[1].object, photo);
  hub.click("#hub-viewer-next");
  const audio = hub.d.querySelector("#hub-viewer-stage audio");
  assert.equal(audio.getAttribute("src"), hub.created[2].url);
  assert.equal(audio.controls, true);
  assert.deepEqual(hub.reads, [], "no arrayBuffer/text/stream/slice/FileReader on any file");
});

test("only one real player exists at a time and closing the player releases it", async (t) => {
  const hub = await openHub(t);
  hub.choose("hub-input-files", Array.from({ length: 300 }, (_, i) => hub.file(`v${i}.mp4`, { type: "video/mp4" })));
  assert.equal(hub.created.length, 0, "300 boxes, no URLs and no players");
  assert.equal(hub.liveMedia().length, 0);
  hub.open(0);
  const first = hub.created[0].url;
  hub.click("#hub-viewer-next");
  assert.equal(hub.liveMedia().length, 1, "never more than one player");
  assert.deepEqual(hub.revoked, [first], "the previous URL is released");
  hub.click("#hub-viewer-close");
  assert.equal(hub.liveMedia().length, 0);
  assert.equal(hub.created.length, 2);
  assert.equal(hub.revoked.length, 2);
  assert.equal(hub.w.SanflixHub.leaseCount(), 0);
});

test("removing an item stops its player before revoking its URL and updates every list", async (t) => {
  const hub = await openHub(t);
  hub.choose("hub-input-files", [hub.file("a.mp4", { type: "video/mp4" }), hub.file("b.jpg"), hub.file("c.mp3")]);
  hub.open(0);
  const url = hub.created[0].url;
  hub.log.length = 0;
  hub.click("#hub-viewer .hub-remove");
  assert.deepEqual(hub.log.filter((e) => e !== "play"), ["pause", "load", "revoke " + url]);
  assert.deepEqual(hub.names(), ["b.jpg", "c.mp3"]);
  assert.equal(hub.w.SanflixHub.count(), 2);
  assert.equal(hub.liveMedia().length, 0);
  assert.equal(hub.$("hub-filters")?.textContent ?? "", "");
  assert.equal(hub.d.querySelector('[data-count="all"]').textContent, "2");
  const before = hub.revoked.length;
  hub.click(".hub-tile .hub-remove"); // An item that was never opened has nothing to revoke.
  assert.equal(hub.revoked.length, before);
  hub.click("#hub-clear");
  assert.equal(hub.w.SanflixHub.count(), 0);
  assert.equal(hub.$("hub-empty").hidden, false);
  assert.match(hub.notice(), /Nothing was stored/);
});

test("filters, counts and search work together, and only show or hide the boxes", async (t) => {
  const hub = await openHub(t);
  hub.choose("hub-input-files", [hub.file("a.mp4", { type: "video/mp4" }), hub.file("b.mkv"), hub.file("c.jpg"), hub.file("d.mp3")]);
  const counts = () => ["all", "video", "image", "audio"].map((k) => hub.d.querySelector(`[data-count="${k}"]`).textContent);
  assert.deepEqual(counts(), ["4", "2", "1", "1"]);
  const before = hub.tiles();
  hub.click('[data-filter="video"]');
  assert.deepEqual(hub.names(), ["a.mp4", "b.mkv"]);
  hub.click('[data-filter="image"]');
  assert.deepEqual(hub.names(), ["c.jpg"]);
  hub.click('[data-filter="audio"]');
  assert.deepEqual(hub.names(), ["d.mp3"]);
  hub.click('[data-filter="all"]');
  assert.deepEqual(hub.names(), ["a.mp4", "b.mkv", "c.jpg", "d.mp3"]);
  assert.deepEqual(hub.tiles(), before, "the same boxes are reused, not rebuilt, so filtering stays instant");
  hub.click(".hub-tile .hub-remove");
  assert.equal(hub.tiles().length, 3);
  assert.equal(hub.viewerOpen(), false);
  hub.click(".hub-tile-open"); // Clicking a box opens the player and plays it.
  assert.equal(hub.viewerOpen(), true);
  assert.ok(hub.w.SanflixHub.activeName());
});

test("the Hub is a grid of boxes like Home: no reels, no feed, no view tabs", async (t) => {
  const hub = await openHub(t);
  assert.equal(hub.$("hub-feed"), null);
  assert.equal(hub.d.querySelector(".hub-tabs"), null);
  hub.choose("hub-input-files", [hub.file("tall.mp4", { type: "video/mp4" }), hub.file("wide.mp4", { type: "video/mp4" }), hub.file("pic.jpg")]);
  assert.equal(hub.d.querySelectorAll(".hub-reel").length, 0);
  assert.equal(hub.tiles().length, 3);
  assert.equal(hub.$("hub-library").hidden, false);
  assert.equal(hub.viewerOpen(), false, "nothing plays until a box is clicked");
  assert.equal(hub.liveMedia().length, 0);
  assert.equal(hub.created.length, 0);
  const opener = hub.d.querySelector(".hub-tile-open");
  opener.focus();
  opener.click();
  assert.equal(hub.viewerOpen(), true);
  assert.equal(hub.liveMedia().length, 1);
  assert.match(hub.$("hub-viewer-info").textContent, /tall\.mp4/);
  hub.click("#hub-viewer-prev");
  assert.match(hub.$("hub-viewer-info").textContent, /pic\.jpg/, "Prev wraps around");
  hub.click("#hub-viewer-next");
  assert.match(hub.$("hub-viewer-info").textContent, /tall\.mp4/, "Next wraps around");
  hub.d.dispatchEvent(new hub.w.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(hub.viewerOpen(), false, "Escape closes the player");
  assert.equal(hub.liveMedia().length, 0);
  assert.equal(hub.w.SanflixHub.leaseCount(), 0);
  assert.equal(hub.d.activeElement, opener, "focus returns to the box that was clicked");
  opener.click();
  hub.$("hub-viewer").click(); // The dark area around the player closes it too.
  assert.equal(hub.viewerOpen(), false);
});

test("the browser's Back button closes the player instead of leaving the Hub", async (t) => {
  const hub = await openHub(t);
  hub.choose("hub-input-files", [hub.file("a.mp4", { type: "video/mp4" })]);
  const depth = hub.w.history.length;
  hub.open(0);
  assert.equal(hub.w.history.length, depth + 1);
  hub.w.history.back();
  await new Promise((resolve) => hub.w.addEventListener("popstate", () => setTimeout(resolve, 0), { once: true }));
  assert.equal(hub.viewerOpen(), false);
  assert.equal(hub.liveMedia().length, 0);
  assert.equal(hub.w.location.pathname, "/hub");
});

test("an unsupported file shows a clear message with the original name and a save option", async (t) => {
  const hub = await openHub(t);
  hub.choose("hub-input-files", [hub.file("Movie.mkv", { size: 3 * 1024 ** 3 })]);
  hub.open(0);
  const url = hub.created[0].url;
  hub.d.querySelector("#hub-viewer-stage video").dispatchEvent(new hub.w.Event("error"));
  const panel = hub.d.querySelector(".hub-unsupported");
  assert.ok(panel);
  assert.equal(hub.d.querySelectorAll("#hub-viewer-stage video").length, 0, "no broken player left behind");
  assert.match(panel.textContent, /can't play this file/);
  assert.match(panel.textContent, /Movie\.mkv · 3\.00 GB · \.mkv/);
  assert.match(panel.textContent, /does not convert files/);
  const save = panel.querySelector("a[download]");
  assert.equal(save.getAttribute("download"), "Movie.mkv");
  assert.equal(save.getAttribute("href"), url);
  assert.equal(hub.revoked.length, 0, "the URL stays valid while the Save link is on screen");
  hub.click("#hub-viewer .hub-remove");
  assert.deepEqual(hub.revoked, [url]);
});

test("playback speed applies to the player and is remembered", async (t) => {
  const hub = await openHub(t);
  hub.choose("hub-input-files", [hub.file("a.mp4", { type: "video/mp4" }), hub.file("b.mp3", { type: "audio/mpeg" })]);
  hub.open(0);
  const speed = hub.d.querySelector("#hub-viewer .hub-speed");
  speed.value = "1.5";
  speed.dispatchEvent(new hub.w.Event("change"));
  assert.equal(hub.d.querySelector("#hub-viewer-stage video").playbackRate, 1.5);
  hub.click("#hub-viewer-next");
  hub.click("#hub-viewer-prev");
  assert.equal(hub.d.querySelector("#hub-viewer-stage video").playbackRate, 1.5, "reopening keeps the chosen speed");
});

test("thumbnails are made lazily from a small bitmap and released with the item", async (t) => {
  const hub = await openHub(t);
  hub.w.createImageBitmap = async () => ({ width: 800, height: 600, close() { hub.log.push("bitmap closed"); } });
  hub.w.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  hub.w.HTMLCanvasElement.prototype.toBlob = function (callback) { callback(new hub.w.Blob(["thumb"])); };
  hub.choose("hub-input-files", [hub.file("pic.jpg")]);
  assert.equal(hub.d.querySelectorAll("img.hub-thumb").length, 0);
  const node = hub.d.querySelector(".hub-tile");
  hub.thumbObserver().callback([{ target: node, isIntersecting: true }]);
  await flush();
  const thumb = hub.d.querySelector("img.hub-thumb");
  assert.ok(thumb, "a thumbnail appears");
  assert.ok(hub.log.includes("bitmap closed"));
  const thumbUrl = thumb.getAttribute("src");
  assert.equal(hub.created.some((c) => c.object === hub.created.at(-1).object && c.url === thumbUrl), true);
  hub.click(".hub-tile .hub-remove");
  assert.ok(hub.revoked.includes(thumbUrl), "thumbnail URL revoked on removal");
});

test("nothing is ever sent over the network and nothing is stored but a count", async (t) => {
  const hub = await openHub(t);
  hub.choose("hub-input-files", [hub.file("a.mp4", { type: "video/mp4" }), hub.file("b.jpg"), hub.file("c.mp3")]);
  hub.choose("hub-input-folder", [hub.file("d.mp4", { type: "video/mp4", rel: "Trip/d.mp4" })]);
  hub.open(0);
  hub.d.querySelector("#hub-viewer-stage video").dispatchEvent(new hub.w.Event("error"));
  hub.click("#hub-viewer-close");
  hub.click(".hub-tile .hub-remove");
  hub.click("#hub-clear");
  assert.deepEqual(hub.network, [], "no fetch, XMLHttpRequest, WebSocket or beacon calls");
  hub.choose("hub-input-files", [hub.file("secret-holiday.mp4", { type: "video/mp4" })]);
  hub.w.dispatchEvent(new hub.w.Event("pagehide"));
  const keys = Object.keys(hub.w.sessionStorage);
  assert.deepEqual(keys, ["sanflix_hub_previous_count"]);
  assert.match(hub.w.sessionStorage.getItem(keys[0]), /^\d+$/, "a number, never a filename");
  assert.equal(hub.w.localStorage.length, 0);
});

test("the source and page contain no network, upload or content-reading code", () => {
  const forbidden = [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /FormData/, /WebSocket/, /EventSource/, /RTCPeerConnection/,
    /serviceWorker/, /localStorage/, /FileReader/, /readAs(?:Text|DataURL|ArrayBuffer)/, /\.arrayBuffer\s*\(/, /\.text\s*\(/, /btoa\s*\(/, /\/api\//, /upload/i, /\.stream\s*\(/];
  for (const pattern of forbidden) assert.doesNotMatch(hubSource, pattern, String(pattern));
  assert.doesNotMatch(hubHtml, /<form[^>]*>[\s\S]*type="file"/);
  assert.doesNotMatch(hubHtml, /<input[^>]*type="file"[^>]*\bname=/);
  assert.doesNotMatch(hubHtml, /\/api\//i);
  assert.doesNotMatch(hubHtml, /(?:href|src|action|formaction)="[^"]*upload/i, "no upload link, script or form action");
  assert.doesNotMatch(hubHtml, /admin\.js|common\.js/);
  assert.doesNotMatch(hubHtml, /\sstyle=/, "no inline styles (the page's security policy forbids them)");
  assert.doesNotMatch(hubHtml, /<script(?![^>]*\ssrc=)[^>]*>/, "no inline scripts");
});

test("two visitors keep completely separate Hubs and a reload explains the empty page", async (t) => {
  const friendA = await openHub(t), friendB = await openHub(t);
  friendA.choose("hub-input-files", [friendA.file("funny1.mp4", { type: "video/mp4" }), friendA.file("funny2.mp4", { type: "video/mp4" })]);
  friendB.choose("hub-input-folder", [friendB.file("college.jpg", { rel: "College/college.jpg" })]);
  assert.deepEqual(friendA.names(), ["funny1.mp4", "funny2.mp4"]);
  assert.deepEqual(friendB.names(), ["college.jpg"]);
  friendA.w.dispatchEvent(new friendA.w.Event("pagehide"));
  assert.equal(friendB.w.sessionStorage.length, 0, "another visitor's browser is untouched");
  const reloaded = await openHub(t, { stored: { sanflix_hub_previous_count: "2" } });
  assert.equal(reloaded.w.SanflixHub.count(), 0);
  assert.match(reloaded.notice(), /previous selection \(2 items\) is not kept after a reload.*select the files or folder again/);
  assert.equal(reloaded.w.sessionStorage.length, 0);
});

test("without IntersectionObserver the grid still works and a click still plays", async (t) => {
  const hub = await openHub(t, { observer: false });
  hub.choose("hub-input-files", [hub.file("a.mp4", { type: "video/mp4" }), hub.file("b.mp4", { type: "video/mp4" })]);
  assert.equal(hub.tiles().length, 2);
  assert.equal(hub.liveMedia().length, 0);
  hub.open(1);
  assert.equal(hub.liveMedia().length, 1);
  assert.equal(hub.w.SanflixHub.activeName(), "b.mp4");
});

test("removing a box leaves every other box in place", async (t) => {
  const hub = await openHub(t);
  hub.choose("hub-input-files", [hub.file("a.mp4", { type: "video/mp4" }), hub.file("b.mp4", { type: "video/mp4" }), hub.file("c.mp4", { type: "video/mp4" })]);
  const [a, , c] = hub.tiles();
  hub.d.querySelectorAll("#hub-library .hub-remove")[1].click();
  assert.deepEqual(hub.names(), ["a.mp4", "c.mp4"]);
  assert.deepEqual(hub.tiles(), [a, c], "the other boxes are the same elements, so nothing flickers or jumps");
});

test("layout contract: equal boxes whatever the file's shape, floating messages, no scroll-snap anywhere", () => {
  const css = fs.readFileSync(path.join(root, "static", "hub.css"), "utf8").replace(/\r\n/g, "\n");
  const rule = (selector) => { const start = css.lastIndexOf("\n" + selector + " {"); return start < 0 ? "" : css.slice(start, css.indexOf("}", start)); };
  assert.match(rule(".hub-grid"), /display:\s*grid/);
  assert.match(rule(".hub-tile .hub-art,\n.room-art"), /aspect-ratio:\s*16\s*\/\s*10/, "every box has the same shape, portrait or landscape");
  assert.match(rule(".hub-thumb"), /object-fit:\s*cover/);
  assert.match(rule(".hub-notice"), /position:\s*fixed/, "a notice must not push the page around when it appears or hides");
  assert.match(rule(".hub-notice"), /pointer-events:\s*none/);
  assert.match(rule(".hub-media"), /position:\s*absolute/, "a tall or wide video cannot resize or overflow the player frame");
  assert.match(rule(".hub-viewer"), /position:\s*fixed/);
  assert.doesNotMatch(css, /scroll-snap/, "no snapping scroll boxes (they trap and bounce a finger)");
  assert.doesNotMatch(css, /overflow-y:\s*auto/, "no scroller nested inside the page");
});
