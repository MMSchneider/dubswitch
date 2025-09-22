# DubSwitch — Usage & Developer Guide

This document explains how to run and use DubSwitch (development and packaged), how to change the local HTTP server port, supervisor/dev workflow, and where to find logs / diagnostics.

> Location: `docs/USAGE.md`

## Table of contents

- Overview
- Requirements
- Running in development
- Changing the server port
  - Persistent (recommended)
  - One-off (environment variable)
  - Using the Settings UI (Save Port)
- Dev supervisor (how it works and helper scripts)
- Logs & diagnostics
- Packaged app notes
- Troubleshooting
- Contributing / next steps

---

## Overview

DubSwitch is an Electron + Node.js application that provides a web UI and OSC interface for routing and patch management on Behringer X32 / M32 consoles. The repo contains both the server (`server.js`) and the front-end UI (`public/`).

There are two typical run modes:
- Development: run `server.js` (or use the dev supervisor) and open `http://localhost:3000` in a browser.
- Packaged: an Electron main process (packaged binary) supervises the server and renders the UI from `file://` origins.

This guide focuses on how to run the project, change the HTTP port if 3000 is occupied, and developer conveniences for supervision and logs.

## Requirements

- Node.js (v16+ recommended; repository has been developed with modern Node/Electron — check `package.json` for exact engines)
- npm
- On macOS, note that ports < 1024 require elevated privileges.

## Running in development

1. Install dependencies:

```bash
npm install
```

2. Start the server directly (quick test):

```bash
node server.js
```

3. Or use the development supervisor (recommended while actively developing):

```bash
./scripts/start-supervisor.sh
```

The dev supervisor will spawn `server.js`, capture the server's stdout/stderr in `server_child.log`, and restart the child if it exits. It also watches the `server.port` file for changes and restarts immediately when that file is updated.

Open the UI at:

```
http://localhost:3000
```

> If you are developing the renderer you may also open `public/index.html` in the browser during development, but the app expects the server endpoints to be accessible for full functionality.

## Changing the server port

If port 3000 is unavailable on your machine you can choose a different port in one of two convenient ways.

### 1) Persistent project file (recommended)

Create or edit a plain text file named `server.port` located in the repo root (same directory as `server.js`) containing the desired port number, e.g.:

```bash
# from project root
echo "4000" > server.port
```

When `server.js` starts it will read `server.port` and use that port. The dev supervisor (`scripts/supervise-server.js`) watches this file and will restart `server.js` when the file changes so the new port takes effect automatically.

This is convenient because it's a project-local, persistent setting that survives restarts and is easy to share with teammates.

### 2) One-off environment variable

You can override the port for a single run using the `PORT` environment variable:

```bash
PORT=4000 node server.js
```

This approach is useful for quick tests or CI without creating a persistent file.

### 3) Changing the port from the UI

In a supervised environment (packaged Electron app or when using the dev supervisor) the Settings modal provides a Local Server tab where you can enter a port and click `Save Port`. That action performs a POST to `/set-port` on the running server which:

- atomically writes the requested port to `server.port`, and
- exits the running server process so the supervisor (or Electron main) can restart it on the new port.

If the server cannot bind to the requested port after restart (EADDRINUSE), you'll need to pick a different port or free the occupying process.

## Dev supervisor — how it works & helper scripts

`./scripts/supervise-server.js` is a small Node-based supervisor intended for development. Key behaviors:

- Spawns `server.js` as a child and attaches to its stdout/stderr, writing output to `server_child.log` (rotates at ~5MB).
- Watches `server.port` with `fs.watch` and triggers an immediate restart on change (debounced).
- Restarts the child with an exponential backoff when it crashes.

Helper scripts in `scripts/`:

- `./scripts/start-supervisor.sh` — starts the supervisor in the background and writes a PID to `scripts/supervisor.pid`. stdout/stderr of the supervisor go to `scripts/supervisor.out.log`.
- `./scripts/stop-supervisor.sh` — stops the supervisor using the PID file and removes the PID file.
- `scripts/SUPERVISOR_README.md` — a short local doc (also in the repo) describing these helpers.

Dev-only HTTP endpoints (exposed by `server.js`):

- `POST /supervisor-restart` — a loopback-only, dev-friendly endpoint that touches/writes `server.port` so the dev supervisor will restart the server. This endpoint is restricted to requests from the local machine by default; you can opt into broader access by setting `DUBSWITCH_DEV_ALLOW_SUPERVISOR=1` in the environment (not recommended on shared systems).
- `GET /supervisor-status` — dev-only status endpoint returning PID file info and a small tail of the supervised child log useful for the UI to show recent supervisor state. Also protected by the same loopback default.

## Logs & diagnostics

- `server_child.log` — stdout/stderr from the supervised `server.js` child (rotated to `.old` when it exceeds ~5MB).
- `scripts/supervisor.out.log` — supervisor process stdout/stderr when started via `./scripts/start-supervisor.sh` (supervisor logs itself here).
- The app exposes `/status` and `/troubleshoot/matrix-file` endpoints which the UI populates into the Diagnostics modal.

You can also view logs on the command line:

```bash
# tail the server child log
tail -f server_child.log

# view supervisor log
tail -f scripts/supervisor.out.log
```

## Packaged app notes

- The packaged Electron main process acts as a supervisor in production. The renderer runs from `file://` and the app persists the chosen API origin (HTTP base URL) in localStorage as `dubswitch_api_origin` so the UI knows which HTTP origin to call.
- In packaged mode the UI prefers Electron IPCs (exposed via `preload.js`) to ask the main process to restart the server, fetch logs or get status; the dev HTTP endpoints are primarily for browser/dev convenience.

## Troubleshooting

- EADDRINUSE on startup: port is already in use. Either kill the conflicting process or change the port using `server.port` or `PORT=` (see above).

- Supervisor not restarting after `/set-port`: ensure the supervisor is running (`./scripts/start-supervisor.sh`) — `server.js` intentionally exits after writing `server.port` and relies on an external supervisor to restart it.

- Endpoint inaccessible from browser: dev-only endpoints restrict remote access by default. If you're testing from a remote host, you can set `DUBSWITCH_DEV_ALLOW_SUPERVISOR=1` but be cautious.

## Contributing / next steps

If you'd like me to add any of the following I can implement them:

- Add a `.env` loader and an example `.env.example` to make per-user configuration simpler.
- Add npm scripts for common ports (e.g. `npm run start:4000`) or a CLI flag to `server.js` to set port.
- Wire a live supervisor log tail into the Settings UI modal for easier debugging.
- Add unit / integration tests around the supervisor restart flow.

---

If you want I can also create a shorter `USAGE.md` at the project root or update the main `README.md` with these sections — tell me which you prefer and I'll add it.