const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const dir = path.join(__dirname, "..", "extensions", "youtube-adblock");
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");

test("manifest is valid MV3 and every referenced file exists", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.strictEqual(manifest.manifest_version, 3);
  for (const script of manifest.content_scripts)
    for (const file of [...(script.js || []), ...(script.css || [])])
      assert.ok(fs.existsSync(path.join(dir, file)), file);
});

test("page script strips ad data from player responses only", async () => {
  const window = { JSON };
  const context = vm.createContext({ window, JSON, Object, Array, Response: undefined, globalThis: window });
  vm.runInContext(read("page.js"), context);
  const player = context.JSON.parse(
    JSON.stringify({ videoDetails: { videoId: "x" }, adPlacements: [1], playerAds: [2], adSlots: [3] }),
  );
  assert.deepStrictEqual(Object.keys(player), ["videoDetails"]);
  const next = context.JSON.parse(JSON.stringify({ playerResponse: { streamingData: {}, adPlacements: [1] } }));
  assert.ok(!("adPlacements" in next.playerResponse));
  const unrelated = context.JSON.parse(JSON.stringify({ adSlots: ["keep me"], title: "not a player" }));
  assert.deepStrictEqual(unrelated.adSlots, ["keep me"]);
  window.ytInitialPlayerResponse = { streamingData: {}, playerAds: [1] };
  assert.ok(!("playerAds" in window.ytInitialPlayerResponse));
});

test("content script skips a playing ad and restores the viewer's settings", () => {
  const dom = new JSDOM(
    `<div class="html5-video-player ad-showing"><video></video>
     <button class="ytp-skip-ad-button"></button></div>`,
    { runScripts: "outside-only", pretendToBeVisual: true },
  );
  const { window } = dom;
  const video = window.document.querySelector("video");
  Object.defineProperty(video, "duration", { value: 20, configurable: true });
  let seekedTo = null;
  Object.defineProperty(video, "currentTime", { set: (v) => (seekedTo = v), get: () => 0, configurable: true });
  let clicked = 0;
  window.document.querySelector(".ytp-skip-ad-button").addEventListener("click", () => clicked++);
  video.playbackRate = 1.5;
  let timer;
  window.setInterval = (fn) => ((timer = fn), 1);
  window.eval(read("content.js"));
  timer();
  assert.strictEqual(video.muted, true);
  assert.strictEqual(video.playbackRate, 16);
  assert.strictEqual(seekedTo, 20);
  assert.strictEqual(clicked, 1);
  window.document.querySelector(".html5-video-player").classList.remove("ad-showing");
  timer();
  assert.strictEqual(video.muted, false);
  assert.strictEqual(video.playbackRate, 1.5);
  window.document.querySelector(".html5-video-player").classList.add("ad-showing");
  timer();
  const replacement = window.document.createElement("video");
  replacement.playbackRate = 1.25;
  video.replaceWith(replacement);
  window.document.querySelector(".html5-video-player").classList.remove("ad-showing");
  timer();
  assert.strictEqual(video.muted, false);
  assert.strictEqual(video.playbackRate, 1.5);
  assert.strictEqual(replacement.playbackRate, 1.25);
  dom.window.close();
});
