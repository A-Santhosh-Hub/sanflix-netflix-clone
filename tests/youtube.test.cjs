const PYTHON = require("./python-bin.cjs");
const test = require("node:test");
process.env.SANFLIX_DEV = process.env.SANFLIX_DEV || "1"; // Templates are rendered by importing the app.
const assert = require("node:assert");
const { parseYouTube, embedURL } = require("../static/youtube.js");

test("recognises video and playlist links", () => {
  const id = "dQw4w9WgXcQ";
  const cases = [
    [`https://www.youtube.com/watch?v=${id}`, { kind: "video", id, list: null }],
    [`https://youtu.be/${id}?t=10`, { kind: "video", id, list: null }],
    [`youtube.com/shorts/${id}`, { kind: "video", id, list: null }],
    [`https://m.youtube.com/watch?v=${id}&list=PLabcdefghij1`, { kind: "video", id, list: "PLabcdefghij1" }],
    ["https://www.youtube.com/playlist?list=PLabcdefghij1", { kind: "playlist", id: "PLabcdefghij1" }],
  ];
  for (const [text, expected] of cases) assert.deepStrictEqual(parseYouTube(text), expected, text);
});

test("search words and unsafe input are not treated as links", () => {
  for (const text of ["programming", "python tutorial", "", "https://evil.example/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=x\"onload=alert(1)",
    "javascript:alert(1)"])
    assert.strictEqual(parseYouTube(text), null, text);
});

test("embed URLs use the privacy-friendly player and validated ids only", () => {
  assert.strictEqual(
    embedURL({ kind: "video", id: "dQw4w9WgXcQ", list: null }),
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1",
  );
  assert.ok(embedURL({ kind: "playlist", id: "PLabcdefghij1" }).includes("videoseries?list=PLabcdefghij1"));
});

test("video links do not silently carry a playlist into playback", () => {
  assert.ok(!embedURL({kind: "video", id: "dQw4w9WgXcQ", list: "PLabcdefghij1"}).includes("list="));
  assert.throws(() => embedURL({kind: "video", id: "invalid"}));
});

test("shared links and saved lessons load no player or thumbnails until requested", async (t) => {
  const {JSDOM} = require("jsdom");
  const fs = require("node:fs");
  const path = require("node:path");
  const {execFileSync} = require("node:child_process");
  const root = path.resolve(__dirname, "..");
  const html = execFileSync(PYTHON, ["-c",
    "from app import app; from flask import render_template\nwith app.test_request_context('/'):\n print(render_template('youtube.html',search_enabled=False))"],
    {cwd: root, encoding: "utf8", env: {...process.env, PYTHONIOENCODING: "utf-8"}});
  const dom = new JSDOM(html, {url: "http://localhost/youtube#v=dQw4w9WgXcQ", runScripts: "outside-only"});
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLMediaElement.prototype.play = () => Promise.resolve();
  w.HTMLMediaElement.prototype.pause = () => {};
  w.HTMLMediaElement.prototype.load = () => {};
  let requests = 0;
  w.fetch = async () => { requests++; return {ok: true, json: async () => ({
    title: 'Lesson', duration: 120, height: 360, stream: '/youtube-stream/dQw4w9WgXcQ?quality=360'
  })}; };
  w.localStorage.setItem("sanflix_youtube", JSON.stringify([{id: "dQw4w9WgXcQ", title: "Lesson"}]));
  for (const name of ["common.js", "youtube.js"]) w.eval(fs.readFileSync(path.join(root, "static", name), "utf8"));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(d.querySelectorAll("iframe, #yt-saved img").length, 0);
  assert.strictEqual(requests, 0);
  assert.strictEqual(d.getElementById("yt-player").classList.contains("hidden"), false);
  d.getElementById("yt-load").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(d.querySelectorAll("iframe").length, 0);
  assert.strictEqual(d.querySelectorAll("video").length, 1);
  assert.strictEqual(requests, 1);
  assert.ok(d.querySelector("video").src.includes('/youtube-stream/'));
  d.getElementById('yt-seek').value = '45';
  d.getElementById('yt-seek').dispatchEvent(new w.Event('change'));
  assert.ok(d.querySelector('video').src.includes('start=45'));
  d.getElementById("yt-stop").click();
  assert.strictEqual(d.querySelectorAll("iframe, video").length, 0);
  d.getElementById('yt-official').click();
  assert.strictEqual(d.querySelectorAll('iframe').length, 1);
  d.getElementById('yt-stop').click();
  const previews = d.getElementById("yt-previews");
  previews.checked = true;
  previews.dispatchEvent(new w.Event("change"));
  assert.strictEqual(d.querySelectorAll("#yt-saved img").length, 1);
  previews.checked = false;
  previews.dispatchEvent(new w.Event("change"));
  assert.strictEqual(d.querySelectorAll("#yt-saved img").length, 0);
  let complete;
  w.fetch = () => new Promise(resolve => { complete = resolve; });
  d.getElementById('yt-load').click();
  d.getElementById('yt-stop').click();
  complete({ok: true, json: async () => ({title: 'Late result', duration: 120, height: 360, stream: '/unused'})});
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(d.querySelectorAll('video, iframe').length, 0);
});

const {chooseNext} = require('../static/tv-navigation.js');
test('TV focus follows rows and columns instead of jumping diagonally', () => {
  const rect = (left, top) => ({left, top, width: 100, height: 60});
  const candidates = [{element: 'right', rect: rect(120, 0)}, {element: 'below', rect: rect(0, 100)}, {element: 'diagonal', rect: rect(120, 100)}];
  assert.strictEqual(chooseNext(rect(0, 0), candidates, 'ArrowRight'), 'right');
  assert.strictEqual(chooseNext(rect(0, 0), candidates, 'ArrowDown'), 'below');
  assert.strictEqual(chooseNext(rect(0, 0), candidates, 'ArrowLeft'), null);
});

test('TV users browse courses, play consecutive lessons, return, and load more without links', async t => {
  const {JSDOM} = require('jsdom');
  const fs = require('node:fs');
  const {execFileSync} = require('node:child_process');
  const html = execFileSync('python', ['-c', "from app import app; from flask import render_template\nwith app.test_request_context('/'):\n print(render_template('youtube.html',search_enabled=True))"], {encoding: 'utf8', env: {...process.env, PYTHONIOENCODING: 'utf-8'}});
  const dom = new JSDOM(html, {url: 'http://localhost/youtube', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, tick = () => new Promise(resolve => setImmediate(resolve));
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLMediaElement.prototype.play = () => Promise.resolve();
  w.HTMLMediaElement.prototype.pause = w.HTMLMediaElement.prototype.load = () => {};
  const calls = [];
  w.Sanflix = {requestJSON: async url => {
    calls.push(url);
    if (url.includes('/resolve/')) return {title: 'Playing lesson', duration: 100, height: 360, stream: '/youtube-stream/test?quality=360'};
    const params = new URL(url, w.location).searchParams;
    if (params.get('mode') === 'playlists') return {results: [{id: 'PLabcdefghij1', kind: 'playlist', title: '<b>Python course</b>'}], has_more: false};
    if (params.get('mode') === 'channels') return {results: [{id: 'UC' + 'a'.repeat(22), kind: 'channel', title: 'Teacher'}], has_more: false};
    return {results: (params.get('page') === '2' ? ['abcdefghij2', 'abcdefghij3'] : ['abcdefghij1', 'abcdefghij2']).map(id => ({id, kind: 'video', title: id})), has_more: params.get('page') !== '2'};
  }};
  w.eval(fs.readFileSync('static/youtube.js', 'utf8'));
  await tick();
  assert.strictEqual(calls.length, 0);
  d.querySelector('[data-mode="playlists"]').click();
  d.querySelector('[data-query="Python programming tutorial"]').click();
  await tick();
  assert.ok(calls[0].includes('mode=playlists'));
  assert.strictEqual(d.querySelector('#yt-results strong').textContent, '<b>Python course</b>');
  assert.strictEqual(d.querySelector('#yt-results b'), null);
  d.querySelector('#yt-results button').click(); await tick();
  assert.ok(calls[1].includes('mode=playlist'));
  assert.strictEqual(d.querySelectorAll('#yt-results button').length, 2);
  d.querySelector('#yt-results button').click(); await tick();
  assert.ok(d.querySelector('video'));
  assert.strictEqual(d.querySelector('#yt-autonext').checked, false);
  d.querySelector('video').dispatchEvent(new w.Event('ended')); await tick();
  assert.strictEqual(calls.length, 3);
  d.querySelector('#yt-next').click(); await tick();
  assert.ok(calls[3].includes('abcdefghij2'));
  d.querySelector('#yt-player-back').click();
  assert.strictEqual(d.querySelector('video'), null);
  d.querySelector('#yt-more').click(); await tick();
  assert.strictEqual(d.querySelectorAll('#yt-results button').length, 3);
  d.querySelector('#yt-back').click();
  assert.strictEqual(d.querySelector('#yt-results strong').textContent, '<b>Python course</b>');
  assert.ok(d.querySelector('#yt-recent button'));
  d.querySelector('[data-mode="channels"]').click(); await tick();
  d.querySelector('#yt-results button').click(); await tick();
  assert.ok(calls.at(-1).includes('mode=channel'));
  assert.strictEqual(d.querySelectorAll('iframe, img').length, 0);
});
