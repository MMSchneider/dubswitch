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
