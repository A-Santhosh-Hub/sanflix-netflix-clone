const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(
  path.join(__dirname, "../static/appearance.js"),
  "utf8",
);

async function setup(
  t,
  { systemReduced = false, stored, blocked = false } = {},
) {
  const dom = new JSDOM(
    '<!doctype html><html><body><button data-transparency-toggle aria-label="Reduce transparency"></button><span id="appearance-status" role="status"></span></body></html>',
    { url: "http://localhost", runScripts: "outside-only" },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    d = w.document;
  await new Promise((resolve) => {
    if (d.readyState === "complete") resolve();
    else w.addEventListener("load", resolve, { once: true });
  });
  const changes = [];
  const media = {
    matches: systemReduced,
    addEventListener: (_, fn) => changes.push(fn),
  };
  w.matchMedia = () => media;
  if (stored !== undefined)
    w.localStorage.setItem("sanflix_appearance", stored);
  if (blocked)
    Object.defineProperty(w, "localStorage", {
      get() {
        throw new Error("Blocked storage");
      },
    });
  w.eval(source);
  // State must already be applied before the DOM-ready callback.
  const initial = d.documentElement.dataset.transparency;
  d.dispatchEvent(new w.Event("DOMContentLoaded"));
  return {
    w,
    d,
    initial,
    button: d.querySelector("button"),
    changeSystem(value) {
      media.matches = value;
      changes.forEach((fn) => fn());
    },
  };
}

test("appearance follows system before first paint and reacts to system changes", async (t) => {
  const e = await setup(t, { systemReduced: true });
  assert.equal(e.initial, "reduced");
  assert.equal(e.button.getAttribute("aria-pressed"), "true");
  e.changeSystem(false);
  assert.equal(e.d.documentElement.dataset.transparency, "glass");
  assert.equal(e.button.getAttribute("aria-pressed"), "false");
});
test("explicit preference survives reload and overrides later system changes", async (t) => {
  const e = await setup(t);
  e.button.click();
  assert.equal(
    e.d.getElementById("appearance-status").textContent,
    "Transparency reduced.",
  );
  const stored = e.w.localStorage.getItem("sanflix_appearance");
  const reloaded = await setup(t, { stored });
  assert.equal(reloaded.initial, "reduced");
  reloaded.changeSystem(false);
  assert.equal(reloaded.d.documentElement.dataset.transparency, "reduced");
  reloaded.button.click();
  assert.equal(reloaded.button.getAttribute("aria-pressed"), "false");
});
test("corrupt or unavailable storage leaves the preference control usable", async (t) => {
  for (const options of [
    { stored: "{broken", systemReduced: true },
    { blocked: true, systemReduced: true },
  ]) {
    const e = await setup(t, options);
    assert.equal(e.initial, "reduced");
    e.button.click();
    assert.equal(e.d.documentElement.dataset.transparency, "glass");
  }
});
test("cross-tab changes synchronize and clearing storage restores the system default", async (t) => {
  const e = await setup(t);
  e.w.localStorage.setItem(
    "sanflix_appearance",
    JSON.stringify({ reduceTransparency: true }),
  );
  e.w.dispatchEvent(
    new e.w.StorageEvent("storage", { key: "sanflix_appearance" }),
  );
  assert.equal(e.button.getAttribute("aria-pressed"), "true");
  e.w.localStorage.clear();
  e.w.dispatchEvent(new e.w.StorageEvent("storage", { key: null }));
  assert.equal(e.button.getAttribute("aria-pressed"), "false");
});
