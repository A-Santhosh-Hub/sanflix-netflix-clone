/* Apply before first paint. This preference is independent of authentication/watch state. */
(function () {
  "use strict";
  const key = "sanflix_appearance";
  const root = document.documentElement;
  const system = window.matchMedia?.("(prefers-reduced-transparency: reduce)");
  let override = readPreference();
  function readPreference() {
    try {
      const value = JSON.parse(window.localStorage.getItem(key));
      return typeof value?.reduceTransparency === "boolean"
        ? value.reduceTransparency
        : null;
    } catch (_) {
      return null;
    }
  }
  function apply() {
    const reduced = override ?? Boolean(system?.matches);
    root.dataset.transparency = reduced ? "reduced" : "glass";
    document
      .querySelectorAll("[data-transparency-toggle]")
      .forEach((button) => {
        button.setAttribute("aria-pressed", String(reduced));
        button.title = reduced ? "Enable glass effects" : "Reduce transparency";
      });
  }
  apply();
  system?.addEventListener?.("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) {
      override = readPreference();
      apply();
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    document
      .querySelectorAll("[data-transparency-toggle]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          override = root.dataset.transparency !== "reduced";
          try {
            window.localStorage.setItem(
              key,
              JSON.stringify({ reduceTransparency: override }),
            );
          } catch (_) {
            /* still works for this page */
          }
          apply();
          const status = document.getElementById("appearance-status");
          if (status)
            status.textContent = override
              ? "Transparency reduced."
              : "Glass effects enabled.";
        });
      });
    apply();
  });
})();
