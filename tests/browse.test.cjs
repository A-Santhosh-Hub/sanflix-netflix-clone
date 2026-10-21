/* Real template + DOM integration checks. No server, browser or network required. */
process.env.SANFLIX_DEV = process.env.SANFLIX_DEV || "1"; // Templates are rendered by importing the app.
const PYTHON = require("./python-bin.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { JSDOM, VirtualConsole } = require("jsdom");
const root = path.resolve(__dirname, "..");
const html = execFileSync(
  PYTHON,
  [
    "-c",
    "from app import app; from flask import render_template\nwith app.test_request_context('/'):\n print(render_template('index.html'))",
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  },
);
const fixtures = [
  {
    id: "movie1",
    title: "Interstellar 2014 SDR HQ Tamil + Eng",
    filename: "Interstellar (2014).mkv",
    category: "movie",
    duration_seconds: 10140,
    resolution: "3840x2160",
    thumbnail: "thumbnails/movie.jpg",
  },
  {
    id: "ep2",
    title: "Second episode",
    show: "Example Show",
    category: "series",
    season: 1,
    episode: 2,
    duration_seconds: 1200,
  },
  {
    id: "ep1",
    title: "First episode",
    show: "Example Show",
    category: "series",
    season: 1,
    episode: 1,
    duration_seconds: 1100,
  },
  {
    id: "ep3",
    title: "A new season",
    show: "Example Show",
    category: "series",
    season: 2,
    episode: 1,
    duration_seconds: 1300,
  },
  {
    id: "music1",
    title: "Evening music",
    category: "music",
    media_type: "audio",
    duration_seconds: 220,
  },
];
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function setup(t, { items = fixtures, stored = {}, fail = false } = {}) {
  const errors = [];
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: console,
  });
  t.after(() => dom.window.close());
  const { window: w } = dom;
  const d = w.document;
  await new Promise((resolve) => {
    if (d.readyState === "complete") resolve();
    else w.addEventListener("load", resolve, { once: true });
  });
  w.scrollTo = () => {};
  w.matchMedia = () => ({ matches: false });
  let shouldFail = fail;
  w.fetch = async () => ({
    ok: !shouldFail,
    status: shouldFail ? 503 : 200,
    json: async () => (shouldFail ? { error: "Offline" } : items),
  });
  for (const [key, value] of Object.entries(stored))
    w.localStorage.setItem(key, JSON.stringify(value));
  for (const file of ["common.js", "appearance.js", "script.js", "admin.js"])
    w.eval(fs.readFileSync(path.join(root, "static", file), "utf8"));
  d.dispatchEvent(new w.Event("DOMContentLoaded"));
  await flush();
  assert.deepEqual(errors, [], "UI initializes without DOM errors");
  const click = (selector) => d.querySelector(selector).click();
  const input = (value) => {
    d.getElementById("search-input").value = value;
    d.getElementById("search-input").dispatchEvent(
      new w.Event("input", { bubbles: true }),
    );
  };
  return {
    w,
    d,
    click,
    input,
    recover: () => {
      shouldFail = false;
    },
    visible: (id) => !d.getElementById(id).classList.contains("hidden"),
  };
}
test("series are grouped, episodes sort numerically, and source filenames remain intact", async (t) => {
  const { w, d, click } = await setup(t);
  assert.equal(d.querySelectorAll("#series-grid .media-card").length, 1);
  assert.equal(
    d.querySelector("#movies-grid .card-title").textContent,
    "Interstellar",
  );
  assert.equal(fixtures[0].filename, "Interstellar (2014).mkv");
  click("#series-grid .card-open");
  assert.equal(d.querySelectorAll("#season-select option").length, 2);
  assert.deepEqual(
    [...d.querySelectorAll(".episode-copy strong")].map((n) => n.textContent),
    ["First episode", "Second episode"],
  );
  d.getElementById("season-select").value = "2";
  d.getElementById("season-select").dispatchEvent(new w.Event("change"));
  assert.equal(
    d.querySelector(".episode-copy strong").textContent,
    "A new season",
  );
});
test("My List updates every shelf and removal produces a useful empty state", async (t) => {
  const { d, click, visible } = await setup(t);
  click("#movies-grid .card-fav");
  assert.equal(d.querySelectorAll("#favorites-grid .media-card").length, 1);
  assert.equal(
    d.querySelector("#movies-grid .card-fav").getAttribute("aria-pressed"),
    "true",
  );
  click('.nav-links [data-filter="favorites"]');
  assert.equal(visible("movies-section"), false);
  click("#favorites-grid .card-fav");
  assert.equal(visible("empty-state"), true);
  assert.match(d.getElementById("empty-title").textContent, /favorites/);
  assert.equal(d.querySelectorAll("#favorites-grid .media-card").length, 0);
});
test("search hides hero, groups episode matches and category navigation clears search", async (t) => {
  const { d, click, input, visible } = await setup(t);
  click("#search-toggle");
  input("episode");
  assert.equal(visible("hero"), false);
  assert.equal(visible("search-results"), true);
  assert.equal(d.querySelectorAll("#search-grid .media-card").length, 1);
  click('.nav-links [data-filter="movie"]');
  assert.equal(d.getElementById("search-input").value, "");
  assert.equal(visible("search-results"), false);
  assert.equal(visible("movies-section"), true);
  assert.equal(visible("continue-watching-section"), false);
});
test("modal locks scroll, restores focus and reflects saved series progress", async (t) => {
  const { w, d, click, visible } = await setup(t, {
    stored: {
      sanflix_progress: {
        ep2: { time: 240, duration: 1200, percent: 20, timestamp: 50 },
      },
    },
  });
  const opener = d.querySelector("#series-grid .card-open");
  opener.focus();
  opener.click();
  assert.equal(d.activeElement.id, "modal-close");
  assert.equal(d.body.classList.contains("modal-open"), true);
  assert.match(d.getElementById("modal-play").textContent, /Resume/);
  d.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(visible("detail-modal"), false);
  assert.equal(d.activeElement, opener);
  assert.equal(d.body.classList.contains("modal-open"), false);
});
test("stale progress does not leave an empty Continue Watching shelf", async (t) => {
  const { visible } = await setup(t, {
    stored: {
      sanflix_progress: { removed: { time: 20, duration: 100, percent: 20 } },
    },
  });
  assert.equal(visible("continue-watching-section"), false);
});
test("empty library, no matches and connection failures have distinct recoverable states", async (t) => {
  const empty = await setup(t, { items: [] });
  assert.match(empty.d.getElementById("empty-title").textContent, /cinema/);
  const search = await setup(t);
  search.input("nothing-matches");
  assert.match(
    search.d.getElementById("empty-title").textContent,
    /No matches/,
  );
  const error = await setup(t, { fail: true });
  assert.match(
    error.d.getElementById("empty-title").textContent,
    /couldn’t load/,
  );
  error.recover();
  error.click("#empty-action");
  await flush();
  assert.equal(error.visible("movies-section"), true);
  assert.equal(error.visible("empty-state"), false);
});
test("catalog strings render as text and title sorting changes actual card order", async (t) => {
  const items = [
    { id: "a", title: "Zebra <img src=x onerror=alert(1)>", category: "movie" },
    { id: "b", title: "Alpha", category: "movie" },
  ];
  const { d, w, click } = await setup(t, { items });
  click('.nav-links [data-filter="movie"]');
  d.getElementById("sort-select").value = "az";
  d.getElementById("sort-select").dispatchEvent(new w.Event("change"));
  assert.equal(
    d.querySelector("#movies-grid .card-title").textContent,
    "Alpha",
  );
  assert.equal(d.querySelectorAll("#movies-grid img").length, 0);
});
test("a favorite saved against a later episode can be removed from grouped show details", async (t) => {
  const { d, w, click } = await setup(t, {
    stored: {
      sanflix_favorites: ["ep2"],
      sanflix_progress: { ep1: { time: 220, duration: 1100, percent: 20 } },
    },
  });
  assert.equal(
    d
      .querySelector("#continue-watching .card-fav")
      .getAttribute("aria-pressed"),
    "true",
  );
  click("#series-grid .card-open");
  assert.equal(
    d.getElementById("modal-fav").getAttribute("aria-pressed"),
    "true",
  );
  click("#modal-fav");
  assert.deepEqual(JSON.parse(w.localStorage.getItem("sanflix_favorites")), []);
  assert.equal(
    d.querySelector("#series-grid .card-fav").getAttribute("aria-pressed"),
    "false",
  );
  assert.equal(
    d
      .querySelector("#continue-watching .card-fav")
      .getAttribute("aria-pressed"),
    "false",
  );
});
