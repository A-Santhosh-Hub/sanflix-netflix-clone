# SANFLIX browsing and playback design

The current visual layer is documented in [Glass design](GLASS-DESIGN.md).
The original browsing/streaming architecture below remains in use. `glass.css` supplies
the current materials, `appearance.js` manages transparency preferences, and
`player-base.css` now holds the player styles previously embedded in its template.

## Direction (12 October 2026)

Keep the existing Flask media API, streaming strategies, authentication and browser-local
watch state. Build a responsive presentation layer around real catalog data. No framework
migration, invented popularity rankings, fake synopses or external catalog dependency.

Netflix references: [mobile discovery](https://about.netflix.com/en/news/introducing-exciting-new-ways-to-find-and-enjoy-your-next-favorite-on-mobile),
[Windows browsing and playback](https://help.netflix.com/en/node/23931),
[My List](https://help.netflix.com/en/node/10523).
Adapt the cinematic imagery, readable metadata, title rows, clear play action and mobile
navigation to this personal library. Clips, recommendations and profiles require additional
data/services and are outside this UI change.

## Implementation plan

1. Shared display helpers: readable titles, durations, resolution labels and grouped series.
   Display cleanup must never change source filenames or media identifiers.
2. Browse shell: restrained black/red palette, stable featured title with manual navigation,
   responsive horizontal shelves, category grids with sorting, persistent mobile navigation.
3. Discovery: dedicated search state, result counts, explicit clear action, empty states,
   retryable loading errors, synchronized My List and Continue Watching.
4. Details: accessible modal with scroll locking/focus restoration, grouped episodes,
   season selector, resume action and honest metadata. Download remains in details.
5. Player: preserve streaming/resume, fix overlay hit testing, touch and keyboard seeking,
   responsive controls, accessible names and unobstructed exit during errors.
6. Verify existing backend/frontend regressions and add behavioral coverage for grouping,
   list/filter state, series resume and keyboard seeking. Review desktop/mobile visually
   where browser tooling permits. Record any verification limits.

## Maintenance boundaries

- `common.js`: pure display helpers plus storage/network utilities.
- `script.js`: catalog state, derived browse views, card and modal rendering.
- `admin.js`: existing authenticated upload flow, independent of catalog loading.
- `style.css`: shared tokens and browse components; mobile/tablet/desktop breakpoints.
- `player.js`: media lifecycle; `player.css`: responsive player refinements.
- Templates: semantic structure and server-provided CSRF/configuration only.
- `generate_thumbnails.py`: versioned 1280×720 artwork, using a frame 15% into the
  video (capped at 15 minutes), with short-video fallbacks. Old artwork is retained.

For future metadata enrichment, add explicit `display_title`, `description` and artwork
fields to the catalog. Keep original file metadata available in details. Saved state currently
belongs to a browser, not an account. Do not present account syncing or downloads as offline
app caching. Honor reduced motion and keep all primary interactions usable without hover.

## Verification and handoff

- 28 Python regressions passed, including actual FFmpeg fixtures, streaming, authentication,
  uploads and the new 1280×720 artwork dimensions.
- 20 JavaScript checks passed: eight real-template jsdom integration checks plus twelve
  player/storage checks. These cover search/category transitions, grouped seasons, saved
  episodes, list synchronization, empty/error states, safe text rendering, modal focus,
  keyboard seeking, double-tap seeking and cancelling the next episode.
- Refreshed the 54-entry local catalog; all video entries have artwork. Original files and
  earlier thumbnails remain untouched.
- Live HTTP checks cover the home/player templates, catalog, styles/scripts and artwork.
- Visual verification is pending: no browser is exposed by the browser connector, and the
  native Windows helper reports its pipe unavailable. jsdom does not perform layout or
  real media decoding. Do not interpret passing DOM tests as screenshot/device validation.

Manual follow-up: inspect 360/390px portrait, phone landscape, 768px tablet, 1366px laptop
and 1920px desktop; check horizontal overflow, hero text, scrollable shelves, modal focus,
touch seeking, fullscreen and a complete episode transition on actual devices.

Rollback snapshots: `BackUp/ui-before-20261012.zip` contains the prior templates,
browser scripts/styles and tests; `BackUp/artwork-before-20261012.zip` contains the prior
scanner, generator and catalog. The redesign adds `admin.js`, `player.css`, `favicon.svg`,
optional Node test dependencies and these docs. Runtime still requires only Flask/FFmpeg.
