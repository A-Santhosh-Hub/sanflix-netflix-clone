/* Shared browser state and request helpers; safe with blocked/corrupt storage. */
(function (global) {
  "use strict";
  function readStore(key, fallback) {
    try {
      const value = JSON.parse(global.localStorage.getItem(key));
      if (Array.isArray(fallback)) {
        if (!Array.isArray(value)) return fallback;
        return value.filter((item) =>
          key === "sanflix_favorites"
            ? typeof item === "string"
            : item && typeof item === "object" && typeof item.id === "string",
        );
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        return fallback;
      if (key === "sanflix_progress") {
        return Object.fromEntries(
          Object.entries(value).filter(
            ([, item]) =>
              item &&
              Number.isFinite(item.time) &&
              item.time >= 0 &&
              Number.isFinite(item.duration) &&
              item.duration > 0 &&
              Number.isFinite(item.percent),
          ),
        );
      }
      return value;
    } catch (_) {
      return fallback;
    }
  }
  function writeStore(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* playback still works */
    }
  }
  function pathURL(prefix, path) {
    return prefix + String(path).split("/").map(encodeURIComponent).join("/");
  }
  function streamURL(path, start = 0, force = false, audioIndex = null) {
    const query = new URLSearchParams();
    if (Number.isFinite(start) && start > 0) query.set("start", String(start));
    if (force) query.set("force_transcode", "1");
    if (Number.isInteger(audioIndex) && audioIndex >= 0) query.set("audio", String(audioIndex));
    return (
      pathURL("/stream/", path) + (query.size ? "?" + query.toString() : "")
    );
  }
  function escapeHTML(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  }
  function csrfHeaders() {
    return {
      "X-CSRF-Token":
        document.querySelector('meta[name="csrf-token"]')?.content || "",
    };
  }
  async function requestJSON(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { ...csrfHeaders(), ...options.headers },
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && url !== "/api/admin/login")
        global.location.href = "/login";
      throw new Error(data.error || "Request failed. Please retry.");
    }
    return data;
  }
  function displayTitle(item) {
    if (item.display_title) return item.display_title;
    const raw = String(item.show || item.title || "Untitled");
    // Only strip recognizable release suffixes, never mutate the catalog or file path.
    return (
      raw
        .replace(/\s*\((?:19|20)\d{2}(?:[-–]\d{4})?\).*$/, "")
        .replace(
          /\s+(?:19|20)\d{2}\s+(?=(?:Tamil|Telugu|Hindi|English|SDR|HDR|TRUE|WEB|BluRay)\b).*$/i,
          "",
        )
        .replace(
          /\s+(?:BluRay|WEB[- ]?DL|BDRip|HDRip|(?:720|1080|2160)p)\b.*$/i,
          "",
        )
        .trim() || raw
    );
  }
  function durationLabel(item) {
    const seconds = Number(item.duration_seconds);
    if (!seconds)
      return item.duration && item.duration !== "Unknown" ? item.duration : "";
    if (seconds < 60) return Math.round(seconds) + " sec";
    const minutes = Math.floor(seconds / 60);
    return minutes >= 60
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : `${minutes} min`;
  }
  function qualityLabel(item) {
    const height = Number(String(item.resolution || "").split("x")[1]);
    return height >= 2160
      ? "4K"
      : height >= 1080
        ? "HD"
        : height >= 720
          ? "720p"
          : "";
  }
  function groupTitles(items) {
    const groups = new Map();
    const result = [];
    for (const item of items) {
      if (item.category !== "series" || !item.show) {
        result.push(item);
        continue;
      }
      const key = item.show.toLowerCase();
      if (!groups.has(key)) {
        const group = { ...item, episodes: [] };
        groups.set(key, group);
        result.push(group);
      }
      groups.get(key).episodes.push(item);
    }
    for (const group of groups.values()) {
      group.episodes.sort(
        (a, b) =>
          (a.season || 1) - (b.season || 1) ||
          (a.episode || 0) - (b.episode || 0) ||
          a.title.localeCompare(b.title),
      );
      Object.assign(group, group.episodes[0], { episodes: group.episodes });
    }
    return result;
  }
  global.Sanflix = {
    readStore,
    writeStore,
    pathURL,
    streamURL,
    escapeHTML,
    csrfHeaders,
    requestJSON,
    displayTitle,
    durationLabel,
    qualityLabel,
    groupTitles,
  };
})(window);
