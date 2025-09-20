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

5. Launch a packaged app and check:
- UI is styled without network (Bootstrap fallback).
- Brand logo appears or inline SVG fallback is shown.
- View → Toggle DevTools opens Developer Tools and console shows no noisy file:// asset errors.

## Known limitations & notes

- Building requires local tools: `electron-packager`, `electron-builder` (script will attempt to npm-install `electron-builder` if missing), and `electron-installer-debian` for .deb packaging when building Linux `.deb`.
- Code signing for macOS/Windows installers is not covered here — unsigned installers may show security warnings on user systems.
- The pruning step is conservative: it only removes non-zip items when the expected Windows ZIP exists. If the ZIP is missing, the script will leave `dist-release-<tag>` untouched for debugging.

## Suggested short GitHub Release text

- Title: `v0.0.1 — Self-contained builds, safer packaging, and DevTools toggle`
- Body (short):

  This release makes Dubswitch self-contained (vendored CSS, embedded resources in mac .app), fixes Windows and Linux packaging so runtime files are included in distributed ZIPs, and adds a Toggle DevTools menu entry for easier debugging. See full notes in `RELEASE_NOTES.md`.

---

If you want this file formatted differently (longer form changelog, or machine-readable JSON changelog), tell me which format you prefer and I will update it.
