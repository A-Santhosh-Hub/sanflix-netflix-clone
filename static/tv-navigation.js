(function (root) {
  "use strict";
  function chooseNext(origin, candidates, key) {
    const horizontal = key === "ArrowLeft" || key === "ArrowRight";
    const sign = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
    const center = rect => ({x: rect.left + rect.width / 2, y: rect.top + rect.height / 2});
    const start = center(origin);
    let best = null, score = Infinity;
    for (const candidate of candidates) {
      const end = center(candidate.rect);
      const ahead = (horizontal ? end.x - start.x : end.y - start.y) * sign;
      const sideways = Math.abs(horizontal ? end.y - start.y : end.x - start.x);
      if (ahead <= 1) continue;
      const value = ahead + sideways * 4;
      if (value < score) { best = candidate.element; score = value; }
    }
    return best;
  }
  if (typeof module === "object" && module.exports) { module.exports = {chooseNext}; return; }
  document.addEventListener("keydown", event => {
    const active = document.activeElement;
    const editing = active && (active.matches("input, textarea, select") || active.isContentEditable);
    if (["Escape", "BrowserBack", "GoBack"].includes(event.key) || (event.key === "Backspace" && !editing)) {
      const back = new CustomEvent("sanflix-tv-back", {cancelable: true});
      if (!root.dispatchEvent(back)) event.preventDefault();
      return;
    }
    if (!event.key.startsWith("Arrow") || event.altKey || event.ctrlKey || event.metaKey) return;
    // Preserve text editing, range sliders, select menus, and native media controls.
    const leavingText = active && active.matches("input[type='text'], input[type='search']") && ["ArrowUp", "ArrowDown"].includes(event.key);
    if ((editing && !leavingText) || active && active.matches("video, iframe")) return;
    const candidates = [...document.querySelectorAll("a[href], button, input, select, summary, [tabindex='0']")]
      .filter(element => element !== active && !element.disabled && !element.closest(".hidden, [hidden], [inert]") && element.getClientRects().length)
      .map(element => ({element, rect: element.getBoundingClientRect()}));
    const next = active && active !== document.body ? chooseNext(active.getBoundingClientRect(), candidates, event.key) : candidates[0]?.element;
    if (next) { event.preventDefault(); next.focus(); next.scrollIntoView({block: "nearest", inline: "nearest"}); }
  });
})(typeof window !== "undefined" ? window : globalThis);
