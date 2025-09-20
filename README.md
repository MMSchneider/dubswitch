# X32 Channel & User-Patch Router

DubSwitch is a lightweight cross-platform Electron application for routing inputs and user-patches on Behringer X32 / M32 consoles. It provides an easy-to-use web UI and OSC interface to map channels, switch patches, and manage routing rules from your desktop. The packaging ensures the app works offline (vendored CSS, embedded resources), and includes tools for creating distributable ZIPs / installers for macOS, Windows and Linux.

First release for Mac (M2) — by Mike Schneider ([dubmajor.de](https://dubmajor.de))

## Features
- Electron/Node.js app for X32 input routing and OSC command panel
- Editable channel names, color feedback, collapsible panels
- Versioning and release info displayed in footer
- Connection and routing state dialogs for user guidance

-## Installation & Build Instructions

If you want to compile the project yourself:

1. **Clone the repository:**
	```sh
	git clone https://github.com/MMSchneider/x32-router.git
	cd x32-router
	```
2. **Install dependencies:**
	```sh
	npm install
	```
3. **Run the app in development mode:**
	```sh
	npm start
	```
4. **Build a standalone app (macOS example):**
	```sh
	npm run package-mac
	```
	The packaged app will be in the `x32-router-darwin-x64/` folder.

For other platforms, adjust the packaging command as needed (see package.json scripts).

## Versioning
- Version is managed in `package.json` and displayed in the app footer
- Tag releases in git for each published version (e.g. `v1.0.0`)
- Work on new features in separate branches (e.g. `next-version`)

## Development Workflow
1. Commit changes to `main` for stable releases
2. Create feature branches for new work: `git checkout -b next-version`
3. Use `.gitignore` and `.vscode/settings.json` to keep repo clean
4. Tag releases: `git tag v1.0.0 && git push --tags`

## Publishing
- Push to your GitHub repo (e.g. `github.com/dubmajor/x32-router`)
- Update README and version for each release

---
© 2025 Mike Schneider. All rights reserved.
