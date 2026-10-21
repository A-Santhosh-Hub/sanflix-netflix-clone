# SANFLIX glass interface

## Intent

Keep the familiar streaming workflow and make the interface feel lighter: floating
navigation, translucent surfaces, rounded controls, soft edge highlights and short,
interruptible transitions. Artwork stays sharp and the video itself is never blurred.

Research references (12 October 2026):

- [OPPO ColorOS 16](https://www.oppo.com/in/coloros16/): Luminous Design uses light,
  shadow and subtle outlines to communicate depth; motion emphasizes response.
- [vivo OriginOS 7](https://www.vivo.com/en/originos/): translucent interface materials
  and rounded, layered controls.
- [Netflix browsing and playback](https://help.netflix.com/en/node/23931): recognizable
  title shelves, search, detail views and playback controls.

These are design references, not dependencies or reused proprietary source code.
The requested glass treatment is interpreted using the current documented designs,
rather than treating the older ColorOS 7 as a current release.

## Architecture and implementation order

1. Keep `style.css` as the shared layout foundation. Add `glass.css` as the explicit
   material layer, with shared surface, border, blur, radius and shadow tokens.
2. Apply the material to home, category/search views, details, login and administration.
   Make the featured artwork an inset canvas with a readable translucent content panel.
3. Extract the player's large inline stylesheet into `player-base.css`. Keep playback
   geometry in `player.css`; scope glass controls under `.player-page`.
4. Remove admin form inline styling and share form classes. Use existing endpoints,
   CSRF handling, progress reporting and upload validation unchanged.
5. Add `appearance.js`: apply the saved transparency preference before first paint,
   honor the system preference by default, support blocked/corrupt storage, and sync tabs.
6. Verify the real-template DOM flows, preference lifecycle, original player regressions
   and backend routes. Browser/device screenshots require working UI tooling.

## Material rules

- Base: near-black graphite, cool blue/lilac ambient light, SANFLIX red for identity.
- Frosted surfaces: dark tinted fill plus a fine light border, inset edge and soft shadow.
- Blur only the navigation, featured information, dialogs and player controls. Cards
  use inexpensive translucent fills; avoid an expensive blur layer on every thumbnail.
- Cards keep image positioning explicitly anchored (`position: absolute; inset: 0`).
- Small screens use a floating bottom dock, horizontally scrollable shelves and larger
  touch controls. Search and dialogs must fit at 320px without horizontal scrolling.
- Reduced motion disables transforms/animations. Reduced transparency and unsupported
  backdrop filters use solid surfaces. Increased contrast strengthens boundaries.
- All effects are decorative; keyboard focus, labels and action state remain explicit.

## Future maintenance

Change tokens in `glass.css` to tune the treatment. Keep catalog behavior in `script.js`,
uploads in `admin.js` and streaming in `player.js`. Appearance uses its own browser-local
key, `sanflix_appearance`; it does not change progress, favorites, passwords or sessions.

Rollback source snapshot: `BackUp/before-glass-ui.zip`. No media regeneration is required.

## Verification

- 24 JavaScript tests pass, including four new preference lifecycle regressions and
  the real-template browsing flows with the appearance script enabled.
- 28 Python/FFmpeg regressions pass.
- All three templates render with unique element IDs, valid local asset paths and the
  shared glass controls. Admin form inline styles have been removed.
- Browser/device visual verification remains pending. Browser inventory is empty and
  the native Windows UI helper reports its pipe unavailable. DOM checks do not establish
  pixel layout, animation performance, or device-specific media behavior.

Before release, inspect 320/390px portrait, phone landscape, 768px tablet, 1366px laptop
and 1920px desktop. Check long titles, signed-in headers, expanded search, thumbnail fill,
season lists, uploads, player menus, reduced motion and both transparency modes.

Restart the existing Flask server for updated templates, then hard-refresh the browser.
This update does not start another server or change authentication credentials.
