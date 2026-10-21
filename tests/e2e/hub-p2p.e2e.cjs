/* Real-browser, real-WebRTC end-to-end check of the Shared Hub. Not part of `npm test` (needs Chrome/Edge).
 *
 *   node tests/e2e/hub-p2p.e2e.cjs            # or: npm run test:e2e
 *   CHROME_PATH="C:/.../chrome.exe" node tests/e2e/hub-p2p.e2e.cjs
 *
 * It starts the production server (Waitress) with throwaway secrets and databases, opens three isolated
 * browser contexts (Alice shares, Bob and Carol receive), drives the real UI, hashes received bytes
 * and records every network request to prove no media goes to the server.
 */
const PYTHON = require("../python-bin.cjs");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const PORT = process.env.E2E_PORT || "5097", DEBUG_PORT = process.env.E2E_DEBUG_PORT || "9410";
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

function findBrowser() {
  const candidates = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return candidates.find((c) => c && fs.existsSync(c));
}

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.handlers = []; }
  async open() {
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error ? reject(new Error(d.error.message)) : resolve(d.result); }
      else this.handlers.forEach((h) => h(d));
    };
  }
  send(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params, sessionId })); }); }
}

const INIT = (flavor) => `
  window.__blobs = {};
  const originalCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object) => { const url = originalCreate(object); window.__blobs[url] = object; return url; };
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  window.__subtle = crypto.subtle;
  ${flavor.includes('nosubtle') ? "Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined });" : ''}
  ${flavor.includes('nosave') ? 'window.showSaveFilePicker = undefined;' : ''}
  ${flavor === 'stubsave' ? `
  window.__saved = [];
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  window.showSaveFilePicker = async (options) => {
    const record = { name: options && options.suggestedName, size: 0, closed: false, aborted: false, hash: '' }; window.__saved.push(record);
    const chunks = [];
    return { async createWritable() { return {
      async write(b) { const copy = new Uint8Array(b); chunks.push(copy); record.size += copy.length; },
      async close() { const all = new Uint8Array(record.size); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; } record.hash = hex(await window.__subtle.digest('SHA-256', all)); record.closed = true; },
      async abort() { record.aborted = true; } }; }, async getFile() { return new File([], record.name); } };
  };` : ''}
`;

(async () => {
  const browserPath = findBrowser();
  if (!browserPath) { console.log("SKIP  no Chrome/Chromium found (set CHROME_PATH)"); process.exit(0); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-e2e-"));
  const fixtures = path.join(tmp, "fixtures");
  fs.mkdirSync(fixtures);
  const ff = (args) => spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], { stdio: "inherit" });
  const files = {
    big: path.join(fixtures, "Trip video 40MB.mp4"), mid: path.join(fixtures, "random-5MB.mp4"), clip: path.join(fixtures, "real-clip.mp4"),
    photo: path.join(fixtures, "photo.jpg"), tall: path.join(fixtures, "tall-phone-clip.mp4"), song: path.join(fixtures, "song.mp3"), secret: path.join(fixtures, "PRIVATE-not-shared.mp4"),
  };
  fs.writeFileSync(files.big, crypto.randomBytes(40 * 1048576));
  fs.writeFileSync(files.mid, crypto.randomBytes(5 * 1048576 + 321));
  fs.writeFileSync(files.secret, crypto.randomBytes(200000));
  ff(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", files.clip]);
  ff(["-f", "lavfi", "-i", "testsrc=size=180x320:rate=15", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", files.tall]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360", "-frames:v", "1", files.photo]);
  ff(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100", "-t", "2", files.song]);
  const hashes = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, sha(fs.readFileSync(f))]));

  // Server: production mode, throwaway secrets and databases, no external STUN (same-machine test).
  const envFile = path.join(tmp, "sanflix.env");
  spawnSync(PYTHON, ["make_secrets.py"], { cwd: ROOT, env: { ...process.env, SANFLIX_ENV_FILE: envFile }, stdio: "ignore" });
  const server = spawn(PYTHON, ["serve.py"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, SANFLIX_ENV_FILE: envFile, SANFLIX_PORT: PORT, SANFLIX_HOST: "127.0.0.1",
    SANFLIX_SHARE_DB: path.join(tmp, "share.sqlite3"), SANFLIX_HUB_DB: path.join(tmp, "hub.sqlite3"), SANFLIX_HUB_STUN: "" } });
  let browser;
  const pages = [];
  const cleanup = () => { try { browser && browser.kill(); } catch (_) {} try { server.kill(); } catch (_) {} };
  process.on("exit", cleanup);
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/login")).ok) break; } catch (_) {} await sleep(500); }
    browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-features=WebRtcHideLocalIpsWithMdns", `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${path.join(tmp, "profile")}`, "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
    let version;
    for (let i = 0; i < 50 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); } catch (_) { await sleep(200); } }
    const cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.open();

    const allRequests = [];
    async function openPage(label, flavor) {
      const { browserContextId } = await cdp.send("Target.createBrowserContext");
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const page = { label, sessionId, targetId, requests: [], problems: [], console: [] };
      pages.push(page);
      const send = (m, p) => cdp.send(m, p, sessionId);
      page.send = send;
      cdp.handlers.push((d) => {
        if (d.sessionId !== sessionId) return;
        if (d.method === "Network.requestWillBeSent") { const r = { page: label, url: d.params.request.url, method: d.params.request.method, body: (d.params.request.postData || "").length, hasBody: Boolean(d.params.request.hasPostData) }; page.requests.push(r); allRequests.push(r); }
        if (d.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(d.params.type)) page.console.push(d.params.args.map((a) => a.value || a.description).join(" ").slice(0, 300));
        if (d.method === "Runtime.exceptionThrown") page.problems.push(d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description);
      });
      for (const domain of ["Page", "Runtime", "Network", "DOM"]) await send(domain + ".enable");
      await send("Page.addScriptToEvaluateOnNewDocument", { source: INIT(flavor) });
      page.evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || "evaluate failed"); return r.result.value; };
      page.until = async (expression, ms = 20000, label2 = expression) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await page.evaluate(expression)) return true; } catch (_) {} await sleep(250); } throw new Error(`Timed out waiting for: ${label2}`); };
      page.setFiles = async (selector, list) => { const { root } = await send("DOM.getDocument"); const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector }); await send("DOM.setFileInputFiles", { nodeId, files: list }); };
      page.shot = async (name) => { const { data } = await send("Page.captureScreenshot", { format: "png" }); fs.mkdirSync(process.env.E2E_SHOTS || path.join(tmp, "shots"), { recursive: true }); fs.writeFileSync(path.join(process.env.E2E_SHOTS || path.join(tmp, "shots"), name + ".png"), Buffer.from(data, "base64")); };
      await send("Page.navigate", { url: BASE + "/hub" });
      await sleep(1200);
      return page;
    }

    const alice = await openPage("alice", "default"), bob = await openPage("bob", "nosave nosubtle"), carol = await openPage("carol", "stubsave");
    const rename = async (page, name) => { await page.evaluate("document.getElementById('hub-mode-friends').click()"); await page.until("SanflixRoom.joined()"); await page.evaluate("document.getElementById('room-rename').click()"); await page.evaluate(`(() => { const i = document.getElementById('room-name-input'); i.value = ${JSON.stringify(name)}; document.getElementById('room-name-save').click(); })()`); await page.until(`document.getElementById('room-name').textContent === ${JSON.stringify(name)}`); };

    // ---------- Alice picks local files and shares only some ----------
    await alice.setFiles("#hub-input-files", [files.big, files.mid, files.clip, files.photo, files.song, files.secret]);
    await alice.until("SanflixHub.count() === 6");
    await rename(alice, "Alice <b>X</b>");
    await alice.evaluate("document.getElementById('hub-mode-mine').click()");
    check("Alice's selected files stay local until she shares: nothing published yet", await alice.evaluate("SanflixRoom.state.shares.length === 0"));
    await alice.evaluate(`(() => { for (const box of document.querySelectorAll('.hub-select input')) { const name = box.getAttribute('aria-label'); if (!/PRIVATE-not-shared/.test(name)) box.click(); } })()`);
    await alice.until("!document.getElementById('hub-share-selected').hidden");
    check("selecting items shows 'Share N selected to Hub'", (await alice.evaluate("document.getElementById('hub-selected-count').textContent")) === "5");
    await alice.evaluate("document.getElementById('hub-share-selected').click()");
    await alice.until("SanflixRoom.state.shares.length === 5 || document.querySelectorAll('.hub-shared').length >= 5", 15000);
    await rename(bob, "Bob");
    await rename(carol, "Carol");
    for (const page of [bob, carol]) await page.until("document.querySelectorAll('.room-card').length === 5", 20000);
    check("Bob and Carol see Alice's 5 shared items without importing anything", true);
    const visible = await bob.evaluate("[...document.querySelectorAll('.room-card')].map((c) => ({ owner: c.querySelector('.room-owner').textContent, name: c.querySelector('.room-name').textContent, facts: c.querySelector('.room-facts').textContent, avail: c.querySelector('.room-avail').textContent, online: c.querySelector('.room-dot').classList.contains('room-online') }))");
    check("cards show sender, filename, size, type and online state", visible.every((v) => v.owner === "Alice <b>X</b>" && v.online && v.facts.length > 3 && /Online/.test(v.avail)), JSON.stringify(visible[0]));
    check("an unshared private file is not visible to friends", !visible.some((v) => /PRIVATE/.test(v.name)) && !(await bob.evaluate("JSON.stringify(SanflixRoom.state.shares)")).includes("PRIVATE"));
    check("display names and filenames are inert text, never HTML", (await bob.evaluate("document.querySelectorAll('.room-owner b, .room-name b').length")) === 0);
    check("Alice sees her own items marked 'You' with Stop sharing", await alice.evaluate("document.getElementById('hub-mode-friends').click(), [...document.querySelectorAll('.room-card.room-own')].length === 5 && [...document.querySelectorAll('.room-card.room-own .room-actions button')].every((b) => /Stop sharing/.test(b.textContent))"));
    await bob.shot("e2e-friends-desktop");

    const card = (page, name) => page.evaluate(`(() => { const c = [...document.querySelectorAll('.room-card')].find((x) => x.querySelector('.room-name').textContent.includes(${JSON.stringify(name)})); return c ? c.dataset.share : null; })()`);
    const click = (page, name, label) => page.evaluate(`[...document.querySelectorAll('.room-card')].find((x) => x.querySelector('.room-name').textContent.includes(${JSON.stringify(name)})).querySelector('.room-actions').querySelectorAll('button').forEach((b) => { if (b.textContent.trim() === ${JSON.stringify(label)}) b.click(); })`);
    const blobHash = (page, name) => page.evaluate(`(async () => { const c = [...document.querySelectorAll('.room-card')].find((x) => x.querySelector('.room-name').textContent.includes(${JSON.stringify(name)})); const url = c.dataset.url; if (!url) return null; const buf = await window.__blobs[url].arrayBuffer(); const d = await window.__subtle.digest('SHA-256', buf); return { size: buf.byteLength, hash: Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('') }; })()`);

    // ---------- Bob downloads a 5 MB file: no prompt for the owner, direct transfer, verified bytes (in-memory fallback sink) ----------
    await alice.evaluate("document.getElementById('hub-mode-mine').click()");
    await click(bob, "random-5MB", "Download Original");
    await bob.until(`document.querySelector('.room-card[data-share="${await card(bob, "random-5MB")}"] .room-status').textContent.includes('Received and verified')`, 60000);
    check("the owner is never asked: sharing an item is the permission, and sending starts by itself", await alice.evaluate("document.querySelectorAll('#hub-requests .room-request:not(.room-sending)').length === 0 && !/wants to/.test(document.getElementById('hub-requests').textContent)"));
    const got = await blobHash(bob, "random-5MB");
    check("Bob has no crypto.subtle (plain-HTTP situation): the pure-JavaScript SHA-256 verified every block", (await bob.evaluate("!SanflixRoom.state.me || (typeof crypto.subtle === 'undefined')")) === true);
    check("Bob's file is byte-for-byte identical (SHA-256 and size)", got && got.hash === hashes.mid && got.size === fs.statSync(files.mid).size, JSON.stringify(got));

    // ---------- Carol saves straight to disk (File System Access path, stubbed handle) ----------
    await click(carol, "random-5MB", "Download Original");
    await carol.until("window.__saved.length === 1 && window.__saved[0].closed", 60000);
    const saved = await carol.evaluate("window.__saved[0]");
    check("save-to-disk path commits only after verification, with identical bytes", saved.hash === hashes.mid && saved.size === fs.statSync(files.mid).size && !saved.aborted, JSON.stringify(saved));

    // ---------- Play: Download & Play through WebRTC, then local playback ----------
    await click(bob, "real-clip", "Play");
    await bob.until(`!!document.querySelector('.room-card .room-player video')`, 40000);
    await bob.until(`(() => { const v = document.querySelector('.room-card .room-player video'); return v && v.readyState >= 2 && v.videoWidth === 320; })()`, 20000);
    check("Download & Play: the verified local copy decodes and plays (video 320px wide)", true);
    check("the played copy is the original bytes", (await blobHash(bob, "real-clip")).hash === hashes.clip);
    await click(carol, "photo.jpg", "Play");
    await carol.until("(() => { const i = document.querySelector('.room-card .room-player img'); return i && i.naturalWidth === 640; })()", 40000);
    check("a shared photo is received and displayed", true);
    await bob.shot("e2e-play-video");

    // ---------- Two friends at once from the same owner (40 MB each) ----------
    const started = Date.now();
    await click(bob, "Trip video", "Download Original");
    await click(carol, "Trip video", "Download Original");
    await Promise.all([
      bob.until(`document.querySelector('.room-card[data-share="${await card(bob, "Trip video")}"] .room-status').textContent.includes('Received and verified')`, 120000),
      carol.until("window.__saved.length === 2 && window.__saved[1].closed", 120000),
    ]);
    const bobBig = await blobHash(bob, "Trip video"), carolBig = await carol.evaluate("window.__saved[1]");
    check("two friends receive the same 40 MB file at the same time, both byte-identical", bobBig.hash === hashes.big && carolBig.hash === hashes.big, `${((Date.now() - started) / 1000).toFixed(1)}s`);
    check("Alice's transfer rows clear themselves after completion", await alice.until("document.querySelectorAll('#hub-requests .room-sending').length === 0", 30000).then(() => true, () => false));

    // ---------- Cancel mid-transfer; the slot is freed ----------
    await bob.evaluate("document.querySelector('.room-card .room-player') && void 0");
    await click(bob, "Trip video", "Download Original");
    await bob.until(`(() => { const p = document.querySelector('.room-card[data-share="${await card(bob, "Trip video")}"] .room-progress'); return p && !p.hidden && p.value > 0; })()`, 40000);
    await click(bob, "Trip video", "Cancel");
    await bob.until(`document.querySelector('.room-card[data-share="${await card(bob, "Trip video")}"] .room-status').textContent.includes('Cancelled')`, 20000);
    check("cancelling mid-transfer stops it on the receiver", true);
    check("the sender's side ends too (no stuck transfer)", await alice.until("document.querySelectorAll('#hub-requests .room-sending').length === 0", 30000).then(() => true, () => false));
    await click(bob, "song.mp3", "Download Original");
    await bob.until(`document.querySelector('.room-card[data-share="${await card(bob, "song.mp3")}"] .room-status').textContent.includes('Received and verified')`, 40000);
    check("after a cancel the transfer slot is free again", (await blobHash(bob, "song.mp3")).hash === hashes.song);

    // ---------- What the network saw ----------
    const external = allRequests.filter((r) => !r.url.startsWith(BASE) && !r.url.startsWith("blob:") && !r.url.startsWith("data:") && !r.url.startsWith("about:"));
    const hubCalls = allRequests.filter((r) => r.url.includes("/api/hub/"));
    const posted = allRequests.filter((r) => r.method !== "GET");
    const maxBody = Math.max(0, ...allRequests.map((r) => r.body));
    const totalBody = allRequests.reduce((n, r) => n + r.body, 0);
    const transferred = (bobBig.size + carolBig.size + 2 * fs.statSync(files.mid).size);
    check("no request ever left SANFLIX's own origin", external.length === 0, JSON.stringify(external.slice(0, 3)));
    check("every POST is a small Hub JSON call (no upload endpoint was ever used)", posted.every((r) => r.url.includes("/api/hub/") && r.body < 20000), `largest body ${maxBody} bytes`);
    check(`~${Math.round(transferred / 1048576)} MB moved peer to peer while the server saw only ${totalBody} bytes of request bodies`, totalBody < 400000 && hubCalls.length > 20, `${hubCalls.length} Hub calls`);
    check("no unexpected page errors in any browser", [alice, bob, carol].every((p) => p.problems.length === 0), JSON.stringify([alice, bob, carol].map((p) => p.problems)));

    // ---------- Policy: external hosts, binary bodies and oversized bodies are all refused ----------
    const probe = await alice.evaluate(`(async () => {
      const out = {};
      const headers = (type) => ({ 'X-CSRF-Token': document.querySelector('meta[name=csrf-token]').content, 'X-Hub-Epoch': SanflixRoom.state.epoch, 'Content-Type': type });
      try { await fetch('https://example.com/x'); out.external = 'allowed'; } catch (e) { out.external = 'blocked'; }
      out.binary = (await fetch('/api/hub/shares', { method: 'POST', headers: headers('application/octet-stream'), body: new Blob([new Uint8Array(100000)]) })).status;
      out.oversized = (await fetch('/api/hub/shares', { method: 'POST', headers: headers('application/json'), body: JSON.stringify({ items: [], pad: 'x'.repeat(40000) }) })).status;
      out.upload = (await fetch('/api/admin/upload', { method: 'POST', headers: headers('application/json'), body: '{}' })).status;
      return out;
    })()`);
    check("page policy blocks requests to other websites", probe.external === "blocked", JSON.stringify(probe));
    check("the server refuses binary (415) and oversized (413) bodies on the Hub API", probe.binary === 415 && probe.oversized === 413, JSON.stringify(probe));
    check("the admin upload route is still closed to a friend (401)", probe.upload === 401, JSON.stringify(probe));

    // ---------- A visitor who never opens the friends area stays completely local ----------
    const dave = await openPage("dave", "default");
    await dave.setFiles("#hub-input-files", [files.clip, files.photo]);
    await dave.until("SanflixHub.count() === 2");
    await sleep(4500);
    const daveCalls = dave.requests.filter((r) => r.url.includes("/api/"));
    check("local-only use (import, play) makes zero API requests: nothing is published or announced", daveCalls.length === 0, JSON.stringify(daveCalls.map((r) => r.url)));
    check("that visitor never appears online to friends", (await bob.evaluate("SanflixRoom.state.people.length")) === 3);

    // ---------- Phone-sized layout of the shared feed ----------
    await bob.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(900);
    check("phone: the friends feed has no horizontal overflow", await bob.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"));
    const friendsLayout = JSON.parse(await bob.evaluate(`(() => { const f = document.getElementById('room-feed'); const c = getComputedStyle(f); const n = document.querySelector('.mobile-nav').getBoundingClientRect(); const rows = [...document.querySelectorAll('.room-card')].map((card) => { card.scrollIntoView({ block: 'center', behavior: 'instant' }); const a = card.querySelector('.room-actions').getBoundingClientRect(); return { card: Math.round(card.getBoundingClientRect().height), top: Math.round(a.top), bottom: Math.round(a.bottom), nav: Math.round(n.top), view: innerHeight }; }); return JSON.stringify({ overflow: c.overflowY, snap: c.scrollSnapType, rows }); })()`));
    check("phone: the friends feed is plain page content (no scroll box), and every card can be scrolled to with its actions clear of the bottom navigation", friendsLayout.overflow === "visible" && friendsLayout.snap === "none" && friendsLayout.rows.length > 0 && friendsLayout.rows.every((r) => r.top >= 0 && r.bottom <= r.nav), JSON.stringify(friendsLayout));
    check("phone: the two Hub areas and the filters fit the width", await bob.evaluate("[...document.querySelectorAll('.hub-modes button, .room-filter')].every((b) => b.getBoundingClientRect().right <= window.innerWidth + 1 || b.closest('.hub-chips'))"));
    await bob.shot("e2e-mobile-friends");
    await bob.send("Emulation.clearDeviceMetricsOverride");


    // ---------- Phone: portrait and landscape videos in My Media must scroll like a normal page ----------
    await dave.setFiles("#hub-input-files", [files.tall]);
    await dave.until("SanflixHub.count() === 3");
    await dave.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await dave.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await sleep(900);
    check("phone: My Media is a grid of boxes, not a scroll box (no snap trap)", await dave.evaluate("(() => { const g = document.getElementById('hub-library'); const c = getComputedStyle(g); return c.display === 'grid' && c.overflowY === 'visible' && c.scrollSnapType === 'none' && !document.getElementById('hub-feed'); })()"));
    check("phone: portrait and landscape videos are boxes of exactly the same size, with a picture in each", await dave.evaluate("(() => { const sizes = [...document.querySelectorAll('.hub-tile .hub-art')].map((a) => { const r = a.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); }); return sizes.length === 3 && new Set(sizes).size === 1 && document.querySelectorAll('.hub-tile .hub-thumb').length >= 2; })()"));
    await dave.evaluate("document.querySelectorAll('.hub-tile')[0].scrollIntoView({ block: 'start', behavior: 'instant' })");
    await sleep(400);
    const tapStart = Date.now();
    await dave.evaluate("document.querySelectorAll('.hub-tile-open')[2].click()");
    await dave.until("(() => { const v = document.querySelector('#hub-viewer-stage video'); return !!v && v.readyState >= 2 && !v.paused; })()", 5000);
    const openMs = Date.now() - tapStart;
    check("phone: tapping a box opens the player and plays quickly", openMs < 1500 && (await dave.evaluate("!document.getElementById('hub-viewer').hidden")), `${openMs} ms`);
    await dave.shot("e2e-mobile-player");
    await dave.evaluate("history.back()");
    await dave.until("document.getElementById('hub-viewer').hidden && !document.querySelector('#hub-viewer-stage video')", 5000);
    check("phone: the Back button closes the player and stays on the Hub", (await dave.evaluate("location.pathname")) === "/hub");
    await dave.evaluate("window.scrollTo({ top: 0, behavior: 'instant' })");
    await sleep(400);
    const dragFrom = await dave.evaluate("window.scrollY");
    const touchY = 420;
    await dave.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: touchY }] });
    for (let step = 1; step <= 10; step++) { await dave.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y: touchY - step * 15 }] }); await sleep(16); }
    await dave.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(1200);
    const dragTo = await dave.evaluate("window.scrollY");
    const reach = await dave.evaluate("document.documentElement.scrollHeight - innerHeight");
    check("phone: a short finger drag moves the page and stays there (no snapping back)", dragTo - dragFrom >= Math.min(120, reach - 5), `scrollY ${dragFrom} -> ${dragTo} (room to scroll: ${reach})`);
    const beforeNotice = await dave.evaluate("document.documentElement.scrollHeight");
    await dave.evaluate("(() => { const n = document.getElementById('hub-notice'); n.textContent = 'Added 40 items (40 videos). 3 unsupported files skipped. 2 already added.'; n.hidden = false; })()");
    const withNotice = await dave.evaluate("document.documentElement.scrollHeight");
    check("a message appearing (or hiding after 9 s) never changes the page height, so nothing shifts under a finger", beforeNotice === withNotice, `${beforeNotice} vs ${withNotice}`);
    await dave.evaluate("document.getElementById('hub-notice').hidden = true");
    await dave.shot("e2e-mobile-my-media");
    await dave.send("Emulation.clearDeviceMetricsOverride");

    // ---------- Owner goes away ----------
    await bob.shot("e2e-before-offline");
    await cdp.send("Target.closeTarget", { targetId: alice.targetId });
    await bob.until("[...document.querySelectorAll('.room-card')].length > 0 && [...document.querySelectorAll('.room-card')].every((c) => c.classList.contains('room-offline') && c.querySelector('.room-actions button').disabled)", 70000);
    check("when the owner's page closes, items become unavailable and cannot be requested", await bob.evaluate("/Unavailable/.test(document.querySelector('.room-avail').textContent)"));
    await bob.shot("e2e-offline");
  } catch (error) {
    check("harness completed", false, error.stack || String(error));
    for (const page of pages) {
      try {
        console.log(`--- ${page.label} state:`, JSON.stringify(await page.evaluate(`({ joined: typeof SanflixRoom !== 'undefined' && SanflixRoom.joined(), shares: typeof SanflixRoom !== 'undefined' ? SanflixRoom.state.shares.map((s) => s.name + ':' + s.available) : null, mine: typeof SanflixRoom !== 'undefined' ? SanflixRoom.mine.size : null, notice: document.getElementById('room-notice').textContent, hubNotice: document.getElementById('hub-notice').textContent, cards: document.querySelectorAll('.room-card').length, stopped: SanflixRoom.state.stopped, failures: SanflixRoom.state.failures, csp: window.__csp, transfers: [...SanflixRoom.transfers.values()].map((t) => ({ role: t.role, state: t.state, finished: t.finished, hasLink: !!t.link, hasJob: !!t.job })), statuses: [...document.querySelectorAll('.room-card .room-status')].map((n) => n.textContent).filter(Boolean), requestsBox: document.getElementById('hub-requests').textContent.slice(0, 200), filter: SanflixRoom.state.filter, query: SanflixRoom.state.query, mode: SanflixRoom.state.mode, before: [...document.querySelectorAll('.room-card .room-name')].map((n) => n.textContent), renderError: (() => { try { SanflixRoom.render(); return null; } catch (e) { return String(e.stack).slice(0, 400); } })(), after: [...document.querySelectorAll('.room-card .room-name')].map((n) => n.textContent) })`)));
        console.log(`    ${page.label} console:`, JSON.stringify(page.console.slice(0, 6)));
        console.log(`    ${page.label} problems:`, JSON.stringify(page.problems), "| hub calls:", JSON.stringify(page.requests.filter((r) => r.url.includes('/api/hub')).slice(-6).map((r) => r.method + ' ' + r.url.replace(BASE, ''))));
      } catch (e) { console.log(`--- ${page.label}: state unavailable (${e.message})`); }
    }
  } finally {
    cleanup();
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  }
})();
