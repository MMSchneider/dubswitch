Dev supervisor for server.js

This repository includes a small development supervisor used to run
`server.js` during local development. The supervisor watches the
`server.port` file and restarts the server when the file is updated.

Files
- `scripts/supervise-server.js` — Node-based supervisor. It starts
  `server.js`, captures stdout/stderr into `server_child.log`, rotates
  the log at 5MB, and watches `server.port` (via fs.watch) to trigger
  immediate restarts.
- `scripts/start-supervisor.sh` — Convenience script to start the
  supervisor in the background and record its PID to
  `scripts/supervisor.pid`.
- `scripts/stop-supervisor.sh` — Stops the supervisor using the PID
  file and performs cleanup.

Developer notes
- To allow the HTTP endpoint `POST /supervisor-restart` to trigger the
  supervisor from a browser or dev tooling, either run the supervisor
  locally (recommended) or set the environment variable
  `DUBSWITCH_DEV_ALLOW_SUPERVISOR=1` to bypass the local-only check.
- The endpoint will atomically touch/update `server.port` so the
  supervisor notices the change and restarts `server.js`.

Usage
1. Start the supervisor:
   ./scripts/start-supervisor.sh
2. Open the app in a browser (http://localhost:3000) and use the
   Settings -> Server -> Restart now button. In dev the renderer will
   POST `/supervisor-restart` to trigger a restart.
3. To stop the supervisor:
   ./scripts/stop-supervisor.sh
