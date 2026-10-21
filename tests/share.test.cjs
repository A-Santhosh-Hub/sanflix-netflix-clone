/* Share dialog, link management and the recipient page, in jsdom against the real templates. */
process.env.SANFLIX_DEV = process.env.SANFLIX_DEV || "1"; // Templates are rendered by importing the app.
const PYTHON = require("./python-bin.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.resolve(__dirname, "..");
const render = (code) =>
  execFileSync(PYTHON, ["-c", code], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
const indexHtml = render(
  "from app import app; from flask import render_template\nwith app.test_request_context('/'):\n print(render_template('index.html'))",
);
const sharePageHtml = render(
  "from app import app; from flask import render_template\nwith app.test_request_context('/'):\n print(render_template('share.html', available=True, title='Movie', duration='00:00:01', size='10 KB', expires_at=1999999999, expires_text='on 2033-05-18 03:33 UTC', allow_stream=True, allow_download=True, has_art=True))",
);
const TOKEN = "T".repeat(43);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const read = (file) => fs.readFileSync(path.join(root, "static", file), "utf8");
const movie = { id: "aaaaaaaaaaaa", title: "Interstellar", filename: "Interstellar.mkv", category: "movie", duration_seconds: 600 };

function makeFetch(routes, calls) {
  return async (url, options = {}) => {
    calls.push({ url, options });
    const handler = routes[`${options.method || "GET"} ${url}`] || routes[url];
    if (!handler) return { ok: false, status: 404, json: async () => ({ error: "No route " + url }) };
    const { status = 200, body } = typeof handler === "function" ? handler(options) : handler;
    return { ok: status < 400, status, json: async () => body };
  };
}

async function library(t, routes, { origin = "https://friends.example/" } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(indexHtml, { url: origin, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  t.after(() => dom.window.close());
  const { window: w } = dom;
  const d = w.document;
  await new Promise((resolve) => {
    if (d.readyState === "complete") resolve();
    else w.addEventListener("load", resolve, { once: true });
  });
  w.scrollTo = () => {};
  w.matchMedia = () => ({ matches: false });
  const calls = [];
  w.fetch = makeFetch({ "/api/media": { body: [movie] }, ...routes }, calls);
  const copied = [];
  Object.defineProperty(w, "isSecureContext", { value: true });
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (text) => copied.push(text) }, configurable: true });
  for (const file of ["common.js", "script.js", "share-dialog.js"]) w.eval(read(file));
  d.dispatchEvent(new w.Event("DOMContentLoaded"));
  await flush();
  assert.deepEqual(errors, []);
  return { w, d, calls, copied, hidden: (id) => d.getElementById(id).classList.contains("hidden") };
}

const policy = (can_create = true) => ({ body: { can_create, admin: can_create, default: "24h", durations: [{ key: "1h", label: "1 hour" }, { key: "24h", label: "24 hours" }, { key: "7d", label: "7 days" }] } });

test("Share on a title opens the dialog for the same item the Download button uses", async (t) => {
  const { d, hidden, calls } = await library(t, { "/api/shares/me": policy() });
  d.querySelector("#movies-grid .card-open").click();
  d.getElementById("modal-share").click();
  await flush();
  assert.equal(hidden("share-modal"), false);
  assert.equal(d.getElementById("share-target").textContent, "Interstellar");
  assert.deepEqual([...d.querySelectorAll("#share-duration option")].map((o) => o.value), ["1h", "24h", "7d"]);
  assert.equal(d.getElementById("share-duration").value, "24h");
  assert.equal(d.getElementById("share-stream").checked, true);
  assert.equal(d.getElementById("share-download").checked, false, "download is opt-in");
  assert.ok(calls.some((call) => call.url === "/api/shares/me"));
});

test("creating a link sends exactly the chosen options and shows a copyable absolute URL", async (t) => {
  const created = { id: "b".repeat(16), path: "/s/" + TOKEN, allow_stream: false, allow_download: true, expires_at: 2000000000 };
  const { w, d, calls, copied, hidden } = await library(t, { "/api/shares/me": policy(), "POST /api/shares": { status: 201, body: created } });
  w.SanflixShare.open(movie);
  await flush();
  d.getElementById("share-duration").value = "7d";
  d.getElementById("share-stream").checked = false;
  d.getElementById("share-download").checked = true;
  d.getElementById("share-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await flush();
  const post = calls.find((call) => call.options.method === "POST");
  assert.deepEqual(JSON.parse(post.options.body), { media_id: movie.id, duration: "7d", allow_stream: false, allow_download: true });
  assert.equal(post.options.headers["Content-Type"], "application/json");
  assert.ok("X-CSRF-Token" in post.options.headers);
  assert.equal(hidden("share-result"), false);
  assert.equal(d.getElementById("share-url").value, "https://friends.example/s/" + TOKEN);
  assert.match(d.getElementById("share-result-note").textContent, /download this title until/);
  assert.doesNotMatch(d.getElementById("share-result-note").textContent, /watch/);
  d.getElementById("share-copy").click();
  await flush();
  assert.deepEqual(copied, ["https://friends.example/s/" + TOKEN]);
  assert.equal(d.getElementById("share-copy-status").textContent, "Link copied.");
});

test("a failed copy is reported instead of pretending to succeed", async (t) => {
  const { w, d, hidden } = await library(t, { "/api/shares/me": policy(), "POST /api/shares": { status: 201, body: { id: "c".repeat(16), path: "/s/" + TOKEN, allow_stream: true, allow_download: false, expires_at: 2000000000 } } });
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async () => { throw new Error("denied"); } }, configurable: true });
  w.SanflixShare.open(movie);
  await flush();
  d.getElementById("share-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await flush();
  assert.equal(hidden("share-result"), false);
  d.getElementById("share-copy").click();
  await flush();
  assert.match(d.getElementById("share-copy-status").textContent, /Copy failed/);
});

test("at least one permission is required and server errors are shown", async (t) => {
  const { w, d, calls } = await library(t, { "/api/shares/me": policy(), "POST /api/shares": { status: 429, body: { error: "Too many links created. Wait a few minutes." } } });
  w.SanflixShare.open(movie);
  await flush();
  d.getElementById("share-stream").checked = false;
  d.getElementById("share-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await flush();
  assert.match(d.getElementById("share-status").textContent, /streaming, downloading, or both/);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 0);
  d.getElementById("share-stream").checked = true;
  d.getElementById("share-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await flush();
  assert.equal(d.getElementById("share-status").textContent, "Too many links created. Wait a few minutes.");
});

test("without admin sign-in the dialog explains and offers the sign-in path", async (t) => {
  const { w, d, hidden } = await library(t, { "/api/shares/me": policy(false) });
  let opened = 0;
  d.getElementById("admin-login-link").addEventListener("click", (event) => { event.preventDefault(); opened++; });
  w.SanflixShare.open(movie);
  await flush();
  assert.equal(hidden("share-form"), true);
  assert.equal(hidden("share-blocked"), false);
  assert.match(d.getElementById("share-blocked-text").textContent, /admin sign-in/);
  d.getElementById("share-signin").click();
  assert.equal(opened, 1);
  assert.equal(hidden("share-modal"), true);
});

test("the management list renders titles as text, offers Revoke only on active links, and revokes", async (t) => {
  const rows = (revoked) => ({ body: { admin: false, shares: [
    { id: "1".repeat(16), title: "<img src=x onerror=alert(1)>", status: revoked ? "revoked" : "active", allow_stream: true, allow_download: true, created_at: 1, expires_at: 2000000000, access_count: 1, mine: true },
    { id: "2".repeat(16), title: "Old one", status: "expired", allow_stream: true, allow_download: false, created_at: 1, expires_at: 5, access_count: 0, mine: true },
  ] } });
  let revoked = false;
  const { w, d, calls } = await library(t, { "/api/shares": () => rows(revoked), ["POST /api/shares/" + "1".repeat(16) + "/revoke"]: () => { revoked = true; return { body: { status: "revoked" } }; } });
  d.getElementById("shares-link").click();
  await flush();
  assert.equal(d.querySelectorAll("#shares-list img").length, 0, "no markup injection");
  assert.ok(d.getElementById("shares-list").textContent.includes("<img src=x onerror=alert(1)>"));
  assert.equal(d.querySelectorAll("#shares-list button").length, 1);
  assert.match(d.querySelector("#shares-list").textContent, /Stream \+ Download/);
  d.querySelector("#shares-list button").click();
  await flush();
  assert.ok(calls.some((call) => call.options.method === "POST" && call.url === "/api/shares/" + "1".repeat(16) + "/revoke"));
  assert.equal(d.querySelectorAll("#shares-list button").length, 0);
  assert.match(d.getElementById("shares-list").textContent, /Revoked/);
});

async function sharePage(t, info, { hls = false } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(sharePageHtml, { url: `https://friends.example/s/${TOKEN}`, runScripts: "outside-only", virtualConsole });
  t.after(() => dom.window.close());
  const { window: w } = dom;
  const calls = [];
  w.fetch = makeFetch({ [`/s/${TOKEN}/info`]: info }, calls);
  const hlsCalls = [];
  if (hls)
    w.Hls = class { static isSupported() { return true; } constructor(options) { hlsCalls.push({ options }); } loadSource(url) { hlsCalls.push({ url }); } attachMedia() { hlsCalls.push({ attached: true }); } };
  w.eval(read("share-page.js"));
  await flush();
  return { w, d: w.document, calls, hlsCalls, errors };
}

test("the recipient page derives every link from its own address and never contains the token", async (t) => {
  assert.ok(!sharePageHtml.includes(TOKEN));
  assert.ok(!/<script[^>]*>[^<]/.test(sharePageHtml), "no inline scripts (strict CSP)");
  const { d, calls } = await sharePage(t, { body: { strategy: "direct", allow_stream: true, allow_download: true } });
  assert.equal(d.getElementById("share-download").href, `https://friends.example/s/${TOKEN}/download`);
  assert.equal(d.getElementById("share-art").src, `https://friends.example/s/${TOKEN}/thumbnail`);
  assert.equal(d.getElementById("share-video").src, `https://friends.example/s/${TOKEN}/stream`);
  assert.ok(calls.some((call) => call.url === `/s/${TOKEN}/info`) || calls.some((call) => call.url.endsWith("/info")));
  assert.match(d.getElementById("share-expiry").textContent, /^on /);
});

test("prepared HLS is played through hls.js without a worker, scoped to the share", async (t) => {
  const { hlsCalls, d } = await sharePage(t, { body: { strategy: "remux", hls_playlist: "playlist.m3u8", allow_stream: true, allow_download: false } }, { hls: true });
  assert.equal(JSON.stringify(hlsCalls[0].options), JSON.stringify({ enableWorker: false }));
  assert.ok(hlsCalls.some((call) => call.url === `/s/${TOKEN}/hls/playlist.m3u8`));
  assert.equal(d.getElementById("share-video").getAttribute("src"), null);
});

test("unconvertible video falls back to the live stream with an honest note, and errors are shown", async (t) => {
  const live = await sharePage(t, { body: { strategy: "transcode", hls_playlist: null, allow_stream: true, allow_download: true } });
  assert.equal(live.d.getElementById("share-video").src, `https://friends.example/s/${TOKEN}/stream`);
  assert.match(live.d.getElementById("share-note").textContent, /skipping ahead may be limited/);
  const failed = await sharePage(t, { status: 503, body: { error: "Cannot inspect this file." } });
  assert.equal(failed.d.getElementById("share-note").textContent, "Cannot inspect this file.");
});
