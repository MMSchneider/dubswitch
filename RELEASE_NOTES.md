# Release v0.0.1 — Self-contained builds, safer packaging, and DevTools toggle

Release date: 2025-09-20

## Highlights

- Make distributables self-contained so the UI and resources work offline.
- Fix Windows and Linux packaging so runtime files (DLLs, .pak, locales, app.asar.unpacked) are included in the distributed ZIPs.
- Add a runtime menu item to toggle DevTools.
- Harden renderer so the app works when loaded from file:// and avoids noisy network errors.
- Vendor Bootstrap locally so the UI is styled when offline/packaged.

## What’s new (summary)

- Packaging (`createRelease.sh`)
  - Detects actual packager output directories (PACK_DIR) instead of relying on fixed names.
  - Copies the entire packaged output into temporary release trees so runtime artifacts are preserved in ZIPs.
  - For macOS, copies `resources` and `public/vendor` into the .app bundle (`Contents/Resources/app`) so icons, images and CSS are included inside the `.app`.
  - After `electron-builder` runs, prefers `dist-release-<tag>/win-unpacked` as the source for the final Windows ZIP to ensure all runtime files are included.
  - Safe pruning: if the final Windows ZIP exists the script prunes only non-zip files from `dist-release-<tag>` while preserving other OS ZIPs (mac/linux).
  - Idempotent git-tagging (skips existing tag unless `FORCE_TAG=true`).
  - Generates a minimal `win-builder.json` on the fly and uses `resources/dubswitch.ico` for the Windows icon.

- Frontend / Renderer
  - `public/index.html`: local vendor fallback (`public/vendor/bootstrap.min.css`) so packaged apps don’t rely on the CDN for essential styling.
  - Robust brand logo loader: when running under `file://` the UI probes the likely `.app/Contents/Resources` path and falls back to an inline SVG to avoid DevTools 404 spam.
  - Defensive runtime checks in `app.js` (use `apiUrl('/status')`, guard window refs) to avoid renderer crashes under `file://`.

- Electron main
  - `main.js`: adds a View → Toggle DevTools menu entry (Cmd/Ctrl+Shift+I).

## Bug fixes

- Windows ZIPs previously missed top-level runtime files — fixed by creating ZIPs from `win-unpacked` or copying full packager output.
- Packaging script now detects packager output names to avoid cp failures.
- Final release pruning is safe and preserves other OS ZIPs.

## Files changed (key)

- `createRelease.sh` — packaging orchestration and cleanup logic (most changes).
- `public/index.html` — vendor CSS fallback, logo probe & inline fallback.
- `main.js` — DevTools menu entry.
- `public/vendor/bootstrap.min.css` — vendored fallback (downloaded by the script if missing).
- `resources/*` — included into bundles and used for icons/images.

## How to verify

1. Run the release script and choose platforms you want to build:

```bash
./createRelease.sh
```

2. Inspect the release directory for your version (example):

```bash
ls -la dist-release-0.0.1
```

- You should see per-OS ZIP files (e.g. `dubswitch-mac-x64-0.0.1.zip`, `dubswitch-win-x64-0.0.1.zip`).
- The script will preserve any other `.zip` files and remove non-zip artifacts for the Windows pruning step.

3. Verify Windows ZIP contains runtime files:

```bash
unzip -l dist-release-0.0.1/dubswitch-win-x64-0.0.1.zip | grep -E 'x32-router|\.dll|locales|resources|app.asar.unpacked'
```

4. On mac: expand the mac zip and verify `.app/Contents/Resources/app` contains `resources/` and `public/vendor`.

# Release v0.1.0 — First working release: matrix persistence, UI polish, packaging fixes

Release date: 2025-09-21

## Highlights

- Persist per-channel matrix (column B) to disk (`matrix.json`) and restore on startup.
- Matrix UI improvements: bulk-set for column B with Bootstrap confirmation modal, one-level Undo for bulk changes, and sticky table header while scrolling.
- Packaging improvements and vendored Bootstrap so the app is styled offline.
- DevTools toggle menu added to main Electron menu for easier debugging.

## What’s new (summary)

- Packaging (`createRelease.sh`)
  - Detects packager output directories and copies full packaged output when creating release zips to ensure runtime files are included.
  - Embeds resources inside mac `.app` Contents/Resources/app so icons and vendored CSS are available offline.
  - Safe pruning logic preserves final release ZIPs.

- Frontend / Renderer
  - `public/app.js`: loads the persisted matrix on startup (GET `/get-matrix`), saves matrix via POST `/set-channel-matrix`, and listens for `matrix_update` WebSocket broadcasts.
  - Matrix UI: compact per-channel A/B table, bulk-set for B with modal confirmation, and an Undo action shown in a toast that restores the previous B values.
  - Sticky table header so column labels remain visible while scrolling.
  - Channel numbers styled for better visibility.

- Electron
  - `main.js`: adds View → Toggle DevTools (Cmd/Ctrl+Shift+I).

## Files changed (key)

- `package.json` — version bumped to 0.1.0
- `server.js` — persists `matrix.json`, exposes GET `/get-matrix` and POST `/set-channel-matrix` (existing but now used by client startup flow)
- `public/app.js` — matrix rendering, modal confirmation, undo snapshot for bulk changes, and persisted-matrix load at startup
- `public/index.html` — vendored CSS fallback, modal markup, matrix sticky header CSS, and channel-number color styling
- `createRelease.sh` — packaging fixes (detect packager output, copy full packaged output, safe pruning)

## How to verify

1. Start the server:

```bash
node server.js
```

2. Open the UI at http://localhost:3000 (or launch the packaged app).
3. Settings → Matrix: verify column B values reflect `matrix.json` (if present).
4. Use the Quick set for column B → Apply to all B; confirm in the modal, then click "Undo" in the toast to restore previous values.
5. Restart the app and confirm B values persist.

## Suggested commit message

"chore(release): v0.1.0 — persist matrix B, bulk-set modal + undo, sticky header, packaging and UI fixes\n\n- load persisted matrix on startup (GET /get-matrix) and save via POST /set-channel-matrix\n- bulk-set for B column with Bootstrap modal + one-level undo (toast)\n- make matrix table header sticky and color channel numbers for visibility\n- bump package.json to 0.1.0 and update release notes"

<!-- appended v0.1.1 release notes -->

# Release v0.1.1 — Connection/UI fixes and real IP in header

Release date: 2025-09-23

## Highlights

- Reliable WebSocket init even if app.js loads after DOMContentLoaded.
- Settings and Diagnostics buttons wired robustly with non-Bootstrap modal fallbacks and copy/refresh actions.
- Matrix table renders on late load and on Matrix tab activation; persists B and preselects A from enumerate.
- Header shows the actual local IPv4 address with port instead of localhost.

## Changes

- public/app.js
  - Boot fallback to establish WS and render Matrix.
  - Fallback modal open/close logic and [data-dismiss="modal"] support.
  - Matrix render triggers on DOM-ready, late load, and tab activation.
  - Header now prefers non-loopback IPv4 from /status.ifaces and shows ip:port.
- package.json
  - Version bumped to 0.1.1.

## Verify

1. Run `node server.js`.
2. Load the UI with `?debug=1`.
3. Confirm:
   - WS connects and UI updates flow.
   - Settings and Diagnostics modals open/close; Diagnostics auto-refreshes while open.
   - Matrix tab shows per-channel table and persists changes.
   - Header shows `Local: <ip>:<port>`.

## Suggested commit message

"chore(release): v0.1.1 — WS init + UI wiring fixes, matrix render reliability, real IP in header\n\n- add late-load WS and modal fallbacks; wire Diagnostics actions\n- render Matrix on tab activation and late load; persist and preselect\n- show machine IP:port in header; bump version to 0.1.1"

<!-- appended v0.1.2 release notes -->

# Release v0.1.2 — All A/B bulk apply, Undo, and footer version

Release date: 2025-09-23

## Highlights

- Rename “Local” / “Card” to “All A” / “All B” and make them apply the A/B mapping from the Matrix to all channels.
- One-click Undo for both bulk actions (restores previous per-channel values and resends CLP).
- Footer shows the running app version inline before “Made …”; header version populated too.

## Changes

- public/index.html
  - Button labels updated to “All A” and “All B” with clearer titles/tooltips.
  - Footer now includes a span for the app version.
- public/app.js
  - setAllUserPatchesLocal(): apply A mapping to all channels using persisted matrix when available, else compute from channelMatrix; batch CLP sends; Undo supported.
  - setAllUserPatchesCard(): same for B mapping; Undo supported.
  - setupVersionLabels(): populates header/footer version from /version using apiUrl() with a retry.

## Verify

1. Start the server and open the app.
2. Click “All A” — all channels switch to their A mapping; click Undo in the toast to revert.
3. Click “All B” — all channels switch to their B mapping; click Undo to revert.
4. Footer shows “vX.Y.Z — Made …”; header shows the same version.

## Suggested commit message

"chore(release): v0.1.2 — All A/B bulk apply with Undo, footer version\n\n- rename bulk buttons and wire to matrix A/B mapping (persisted or computed)\n- add undo snapshot for both bulk actions; resend CLP to restore\n- display app version in header and inline in footer"
