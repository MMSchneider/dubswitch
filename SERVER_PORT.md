Changing the local HTTP server port

If port 3000 is already in use on your machine you can start the app on a different port in two simple ways:

1) Persistent project file (recommended)

Create or edit `server.port` in the project root and put the desired port number as plain text, for example:

```bash
echo "4000" > server.port
```

When `server.js` starts it will prefer the port in this file. The dev supervisor (`scripts/supervise-server.js`) also watches this file and will restart the server when it changes.

2) One-off environment variable

Start the server with the `PORT` environment variable to override the default for that run only:

```bash
PORT=4000 node server.js
```

Developer convenience

- Start the dev supervisor (restarts server.js on changes to `server.port`):

```bash
./scripts/start-supervisor.sh
```

- Stop the dev supervisor:

```bash
./scripts/stop-supervisor.sh
```

If you prefer, I can add a `.env` loader or additional npm scripts to make changing the port even easier.
