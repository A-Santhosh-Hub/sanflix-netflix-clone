(function () {
  "use strict";
  // The token lives only in the page address; this page never copies it into the HTML.
  const base = location.pathname.replace(/\/+$/, "");
  const $ = (id) => document.getElementById(id);

  const expiry = $("share-expiry");
  if (expiry && Number(expiry.dataset.epoch))
    expiry.textContent = "on " + new Date(Number(expiry.dataset.epoch) * 1000).toLocaleString();

  const art = $("share-art");
  if (art) {
    art.addEventListener("error", () => art.remove());
    art.src = base + "/thumbnail";
  }
  const download = $("share-download");
  if (download) download.href = base + "/download";

  const video = $("share-video");
  if (!video) return;
  const note = $("share-note");

  function playHls(url) {
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      return true;
    }
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ enableWorker: false });
      hls.loadSource(url);
      hls.attachMedia(video);
      return true;
    }
    return false;
  }

  async function start() {
    try {
      const response = await fetch(base + "/info", { headers: { Accept: "application/json" } });
      const info = await response.json();
      if (!response.ok) throw new Error(info.error || "Playback is not available.");
      if (info.strategy === "direct") {
        video.src = base + "/stream";
      } else if (info.hls_playlist && playHls(base + "/hls/" + info.hls_playlist)) {
        return;
      } else {
        video.src = base + "/stream";
        note.textContent = "This video is converted while it plays, so skipping ahead may be limited.";
      }
    } catch (error) {
      note.textContent = error.message || "Playback is not available.";
    }
  }

  video.addEventListener("error", () => {
    note.textContent = download
      ? "This video cannot play in your browser. Use the download button instead."
      : "This video cannot play in your browser.";
  });
  start();
})();
