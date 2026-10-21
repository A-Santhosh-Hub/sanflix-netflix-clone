// Runs inside the YouTube page. Removes ad instructions from the player data before the player
// reads them. Effectiveness depends on YouTube's implementation; no data savings are guaranteed.
(() => {
  "use strict";
  const AD_KEYS = ["adPlacements", "playerAds", "adSlots"];
  const looksLikePlayerResponse = (o) =>
    "streamingData" in o || "playabilityStatus" in o || "videoDetails" in o;

  function prune(data) {
    if (!data || typeof data !== "object") return data;
    if (looksLikePlayerResponse(data)) {
      for (const key of AD_KEYS) if (key in data) delete data[key];
    }
    if (data.playerResponse) prune(data.playerResponse);
    if (data.response && data.response.playerResponse) prune(data.response.playerResponse);
    if (Array.isArray(data)) data.forEach((item) => item && item.playerResponse && prune(item.playerResponse));
    return data;
  }

  const nativeParse = JSON.parse;
  JSON.parse = function (...args) {
    return prune(nativeParse.apply(this, args));
  };

  if (typeof Response !== "undefined") {
    const nativeJson = Response.prototype.json;
    Response.prototype.json = function (...args) {
      return nativeJson.apply(this, args).then(prune);
    };
  }

  let initial = prune(window.ytInitialPlayerResponse);
  try {
    Object.defineProperty(window, "ytInitialPlayerResponse", {
      configurable: true,
      get: () => initial,
      set: (value) => {
        initial = prune(value);
      },
    });
  } catch (_) {}
})();
