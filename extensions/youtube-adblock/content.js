// Fallback: if an ad still plays, mute it, run it at top speed, jump to its end and press Skip.
(() => {
  "use strict";
  const SKIP_BUTTONS =
    ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-container button";
  const CLOSE_BUTTONS = ".ytp-ad-overlay-close-button, .ytp-ad-overlay-close-container";
  let saved = null;
  function restore() {
    if (!saved) return;
    try { saved.video.muted = saved.muted; saved.video.playbackRate = saved.rate; } catch (_) {}
    saved = null;
  }

  function tick() {
    const player = document.querySelector(".html5-video-player");
    const video = player && player.querySelector("video");
    if (saved && saved.video !== video) restore();
    if (!player || !video) return;
    const adShowing = player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");
    if (adShowing) {
      if (!saved) saved = { video, muted: video.muted, rate: video.playbackRate };
      video.muted = true;
      try { video.playbackRate = 16; } catch (_) {}
      try {
        if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
      } catch (_) {}
      document.querySelectorAll(SKIP_BUTTONS).forEach((button) => button.click());
    } else if (saved) {
      restore();
    }
    document.querySelectorAll(CLOSE_BUTTONS).forEach((button) => button.click());
  }

  setInterval(tick, 250);
})();
