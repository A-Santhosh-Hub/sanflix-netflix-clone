# SANFLIX Ad Skipper for YouTube

A small, experimental browser extension that attempts to skip YouTube ads in the browser where it is installed, including SANFLIX's embedded YouTube player. It is optional and is not installed automatically. Ad-free playback and data savings are not guaranteed; live effectiveness has not been verified.

**How it works**
1. `page.js` attempts to remove known ad fields from player responses. This does not prove that ad network requests are prevented.
2. `content.js` is the backup: if an ad still plays, it mutes it, runs it at top speed, jumps to the end and presses Skip.
3. `hide.css` hides ad boxes on the home page, search results and beside the video.

## Install

**Chrome, Edge, Brave (computer)**
1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `youtube-adblock` folder.
4. Reload YouTube.

**Firefox (computer)**: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**
and choose `manifest.json`. Firefox forgets it when closed. For a permanent install, the
extension must be signed at addons.mozilla.org (free, "unlisted").

**Phones**: Chrome on Android does not run extensions. Use Brave (ads blocked by default) or
Firefox for Android with the uBlock Origin add-on.

## Limits

- YouTube changes its page often. Its current response format, selectors, or server-side
  ads may bypass these scripts. Skipping an ad after it loads may already have consumed data.
- If YouTube shows a "turn off your ad blocker" message, this extension cannot get past it.
- It only affects the browser it is installed in.
