#!/bin/bash
set -e

# Get version from package.json
tag=$(grep '"version"' package.json | head -1 | sed 's/[^0-9.]*\([0-9.]*\).*/\1/')
echo "Detected version: $tag"


dist_dir="$(pwd)/dist-release-$tag"
mkdir -p "$dist_dir"

# Ensure local vendor CSS is present (bootstrap) so the packaged app doesn't
# rely on the CDN at runtime. Download into public/vendor if missing.
mkdir -p public/vendor
if [ ! -f public/vendor/bootstrap.min.css ]; then
	echo "Downloading bootstrap into public/vendor/bootstrap.min.css..."
	curl -fsSL https://cdn.jsdelivr.net/npm/bootstrap@4.5.2/dist/css/bootstrap.min.css -o public/vendor/bootstrap.min.css || echo "Bootstrap download failed — continuing without vendor copy.";
fi

# Platform menu
platforms=("mac-x64" "mac-arm64" "win-x64" "linux-arm64" "linux-x64")
echo "Select architectures to build (comma-separated, e.g. 1,3,5 or 'all'):"
for i in "${!platforms[@]}"; do
	printf "  %d) %s\n" $((i+1)) "${platforms[$i]}"
done
printf "  a) all\n"
read -p "Your choice: " choice

# Parse selection
if [[ "$choice" == "a" || "$choice" == "all" ]]; then
	selected_platforms=("${platforms[@]}")
else
	IFS=',' read -ra nums <<< "$choice"
	selected_platforms=()
	for n in "${nums[@]}"; do
		n=$(echo "$n" | xargs) # trim
		if [[ "$n" =~ ^[0-9]+$ ]] && (( n >= 1 && n <= ${#platforms[@]} )); then
			selected_platforms+=("${platforms[$((n-1))]}")
		fi
	done
fi

if [[ ${#selected_platforms[@]} -eq 0 ]]; then
	echo "No valid architectures selected. Exiting."
	exit 1
fi

for platform in "${selected_platforms[@]}"; do
		echo "Cleaning $(pwd)/dist before packaging for $platform..."
		rm -rf "$(pwd)/dist"/*
		case $platform in
		mac-x64)
			   npx electron-packager . dubswitch --platform=darwin --arch=x64 --out="$(pwd)/dist/" \
			   --icon=resources/dubswitch.icns \
			   --ignore="dist|dist-release-|.git|.DS_Store|.*\\.zip|.*\\.log|createRelease.*|x32-router-.*" --overwrite
			# Ensure required files are present in the packaged app
			   cp package.json "$(pwd)/dist/dubswitch-darwin-x64/"
			   cp main.js "$(pwd)/dist/dubswitch-darwin-x64/"
			   [ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-darwin-x64/"
			   [ -f package-lock.json ] && cp package-lock.json "$(pwd)/dist/dubswitch-darwin-x64/"
			   mkdir -p "$(pwd)/dist/dubswitch-mac-x64-tmp/Dubswitch"
			   cp -R "$(pwd)/dist/dubswitch-darwin-x64/Dubswitch.app" "$(pwd)/dist/dubswitch-mac-x64-tmp/Dubswitch/"
			   # Include resources inside the .app bundle for mac distribution
			   APP_RES_DIR="$(pwd)/dist/dubswitch-mac-x64-tmp/Dubswitch/Dubswitch.app/Contents/Resources/app"
			   mkdir -p "$APP_RES_DIR"
			   [ -d resources ] && cp -R resources "$APP_RES_DIR/resources" || true
			   [ -d public/vendor ] && mkdir -p "$APP_RES_DIR/public" && cp -R public/vendor "$APP_RES_DIR/public/" || true
			   [ -f LICENSE ] && cp LICENSE "$(pwd)/dist/dubswitch-mac-x64-tmp/Dubswitch/"
			   [ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-mac-x64-tmp/Dubswitch/"
			   (cd "$(pwd)/dist/dubswitch-mac-x64-tmp" && zip -r "$dist_dir/dubswitch-mac-x64-$tag.zip" Dubswitch)
			   rm -rf "$(pwd)/dist/dubswitch-mac-x64-tmp"
			;;
		mac-arm64)
			   npx electron-packager . dubswitch --platform=darwin --arch=arm64 --out="$(pwd)/dist/" \
			   --icon=resources/dubswitch.icns \
			   --ignore="dist|dist-release-|.git|.DS_Store|.*\\.zip|.*\\.log|createRelease.*|x32-router-.*" --overwrite
			# Ensure required files are present in the packaged app
			   cp package.json "$(pwd)/dist/dubswitch-darwin-arm64/"
			   cp main.js "$(pwd)/dist/dubswitch-darwin-arm64/"
			   [ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-darwin-arm64/"
			   [ -f package-lock.json ] && cp package-lock.json "$(pwd)/dist/dubswitch-darwin-arm64/"
			   mkdir -p "$(pwd)/dist/dubswitch-mac-arm64-tmp/Dubswitch"
			   cp -R "$(pwd)/dist/dubswitch-darwin-arm64/Dubswitch.app" "$(pwd)/dist/dubswitch-mac-arm64-tmp/Dubswitch/"
			   APP_RES_DIR="$(pwd)/dist/dubswitch-mac-arm64-tmp/Dubswitch/Dubswitch.app/Contents/Resources/app"
			   mkdir -p "$APP_RES_DIR"
			   [ -d resources ] && cp -R resources "$APP_RES_DIR/resources" || true
			   [ -d public/vendor ] && mkdir -p "$APP_RES_DIR/public" && cp -R public/vendor "$APP_RES_DIR/public/" || true
			   [ -f LICENSE ] && cp LICENSE "$(pwd)/dist/dubswitch-mac-arm64-tmp/Dubswitch/"
			   [ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-mac-arm64-tmp/Dubswitch/"
			   (cd "$(pwd)/dist/dubswitch-mac-arm64-tmp" && zip -r "$dist_dir/dubswitch-mac-arm64-$tag.zip" Dubswitch)
			   rm -rf "$(pwd)/dist/dubswitch-mac-arm64-tmp"
			;;
			win-x64)
				npx electron-packager . x32-router --platform=win32 --arch=x64 --out="$(pwd)/dist/" \
				--ignore="dist|dist-release-|.git|.DS_Store|.*\\.zip|.*\\.log|createRelease.*|x32-router-.*" --overwrite
				# Find the actual packaged directory under dist (electron-packager may name it differently)
				OUTDIR="$(pwd)/dist"
				PACK_DIR=""
				# Try common patterns first
				PACK_DIR=$(ls -d "$OUTDIR"/*win32-x64 2>/dev/null | head -n1 || true)
				if [ -z "$PACK_DIR" ]; then
					PACK_DIR=$(ls -d "$OUTDIR"/*win32* 2>/dev/null | head -n1 || true)
				fi
				# Fallback: first directory in dist
				if [ -z "$PACK_DIR" ]; then
					PACK_DIR=$(ls -d "$OUTDIR"/* 2>/dev/null | head -n1 || true)
				fi
				if [ -z "$PACK_DIR" ]; then
					echo "Could not find packaged output directory under $OUTDIR" >&2
					exit 1
				fi
				# Ensure required files are present in the packaged app (best-effort)
				cp package.json "$PACK_DIR/" || true
				cp main.js "$PACK_DIR/" || true
				[ -f README.md ] && cp README.md "$PACK_DIR/"
				[ -f package-lock.json ] && cp package-lock.json "$PACK_DIR/"
				mkdir -p "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch"
				# Copy the full packaged output into the temp Dubswitch folder so
				# runtime files (DLLs, .pak, resources, locales, etc.) are included
				# in the final zip. This is more robust than copying a single .exe.
				mkdir -p "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch"
				# Use a dot to copy all files (including dotfiles) from PACK_DIR into the dest
				cp -R "$PACK_DIR"/. "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch/" || true
				[ -d resources ] && cp -R resources "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch/Resources/" || true
				[ -d public/vendor ] && mkdir -p "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch/Resources/public" && cp -R public/vendor "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch/Resources/public/" || true
				[ -f LICENSE ] && cp LICENSE "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch/"
				[ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch/"
				# NOTE: don't create the final ZIP yet -- electron-builder may
				# produce additional runtime files (win-unpacked) that need to be
				# included. We'll create the ZIP after electron-builder completes.
				# Keep the temp tree for now; we'll reuse/create it after builder runs.
                
				# Create Windows installer using electron-builder
				if ! command -v electron-builder >/dev/null 2>&1; then
					echo "electron-builder not found, installing..."
					npm install -g electron-builder
				fi
					# electron-builder expects a config, so create a minimal one on the fly
					cat > win-builder.json <<EOF
{
  "appId": "de.dubmajor.x32router",
  "productName": "x32-router",
	"icon": "resources/dubswitch.ico",
	"directories": {
		"app": "$PACK_DIR",
		"output": "$dist_dir"
	},
  "win": {
		"icon": "resources/dubswitch.ico",
    "target": ["nsis", "portable"]
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true,
    "license": "LICENSE"
  },
  "extraMetadata": {
    "version": "$tag",
    "description": "X32/M32 Input & User-Patch Router with OSC and Web UI. Control and route X32/M32 mixer channels from your desktop.",
    "author": "Mike Schneider <info@dubmajor.de>"
  }
}
EOF
				electron-builder --config win-builder.json --win --x64
				rm -f win-builder.json

				# After electron-builder runs it typically produces a 'win-unpacked'
				# directory inside the release output. Prefer zipping that so the
				# produced ZIP contains top-level runtime files (DLLs, .pak, locales).
				WIN_UNPACKED_DIR="$dist_dir/win-unpacked"
				# If the win-unpacked directory exists, create the ZIP from it,
				# otherwise fall back to the previously prepared temp tree.
				if [ -d "$WIN_UNPACKED_DIR" ]; then
					echo "Creating final ZIP from $WIN_UNPACKED_DIR"
					mkdir -p "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch"
					cp -R "$WIN_UNPACKED_DIR"/. "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch/" || true
				else
					echo "win-unpacked not found; using detected PACK_DIR contents for ZIP"
				fi

				(cd "$(pwd)/dist/dubswitch-win-x64-tmp" && zip -r "$dist_dir/dubswitch-win-x64-$tag.zip" Dubswitch)
				rm -rf "$(pwd)/dist/dubswitch-win-x64-tmp"

				# Remove transient packager output produced in ./dist by electron-packager
				if [ -d "$(pwd)/dist" ]; then
					# Only remove contents (safer than deleting the folder itself)
					rm -rf "$(pwd)/dist"/* || true
					echo "Removed transient packager output from ./dist"
				fi

				# If the final ZIP was created, prune the release directory but preserve
				# other .zip archives (e.g. mac/linux zips). This removes installers,
				# directories like win-unpacked, and other non-zip artefacts while
				# keeping any existing .zip files for other OS targets.
				ZIP_KEEP_NAME="dubswitch-win-x64-$tag.zip"
				if [ -f "$dist_dir/$ZIP_KEEP_NAME" ]; then
					echo "Pruning $dist_dir: keeping .zip files (including $ZIP_KEEP_NAME), removing non-zip artefacts"
					for f in "$dist_dir"/*; do
						bn=$(basename "$f")
						# Keep the main Windows zip and any other zip files (mac/linux zips)
						case "$bn" in
							"$ZIP_KEEP_NAME")
								echo "Keeping $bn"
								continue
								;;
							*.zip)
								echo "Keeping other zip $bn"
								continue
								;;
							*)
								echo "Removing $bn"
								rm -rf "$f" || true
								;;
						esac
					done
					# Ensure win-unpacked is removed if present
					rm -rf "$dist_dir/win-unpacked" || true
				else
					echo "Expected zip $dist_dir/$ZIP_KEEP_NAME not found — leaving release dir untouched for debugging"
				fi
				;;
		linux-arm64)
			npx electron-packager . x32-router --platform=linux --arch=arm64 --out="$(pwd)/dist/" \
			--ignore="dist|dist-release-|.git|.DS_Store|.*\\.zip|.*\\.log|createRelease.*|x32-router-.*" --overwrite
			# Detect actual packaged output directory under dist (electron-packager may name it differently)
			OUTDIR="$(pwd)/dist"
			PACK_DIR=""
			PACK_DIR=$(ls -d "$OUTDIR"/*linux-arm64* 2>/dev/null | head -n1 || true)
			if [ -z "$PACK_DIR" ]; then
				PACK_DIR=$(ls -d "$OUTDIR"/*linux* 2>/dev/null | head -n1 || true)
			fi
			if [ -z "$PACK_DIR" ]; then
				PACK_DIR=$(ls -d "$OUTDIR"/* 2>/dev/null | head -n1 || true)
			fi
			if [ -z "$PACK_DIR" ]; then
				echo "Could not find packaged output directory under $OUTDIR" >&2
				exit 1
			fi
			# Ensure required files are present in the packaged app (best-effort)
			cp package.json "$PACK_DIR/" || true
			cp main.js "$PACK_DIR/" || true
			[ -f README.md ] && cp README.md "$PACK_DIR/"
			[ -f package-lock.json ] && cp package-lock.json "$PACK_DIR/"
			mkdir -p "$(pwd)/dist/dubswitch-linux-arm64-tmp/Dubswitch"
			# Copy entire packaged output into the temp Dubswitch folder so runtime
			# files are included in the final zip.
			cp -R "$PACK_DIR"/. "$(pwd)/dist/dubswitch-linux-arm64-tmp/Dubswitch/" || true
			[ -d resources ] && cp -R resources "$(pwd)/dist/dubswitch-linux-arm64-tmp/Dubswitch/Resources/" || true
			[ -d public/vendor ] && mkdir -p "$(pwd)/dist/dubswitch-linux-arm64-tmp/Dubswitch/Resources/public" && cp -R public/vendor "$(pwd)/dist/dubswitch-linux-arm64-tmp/Dubswitch/Resources/public/" || true
			[ -f LICENSE ] && cp LICENSE "$(pwd)/dist/dubswitch-linux-arm64-tmp/Dubswitch/"
			[ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-linux-arm64-tmp/Dubswitch/"
			(cd "$(pwd)/dist/dubswitch-linux-arm64-tmp" && zip -r "$dist_dir/dubswitch-linux-arm64-$tag.zip" Dubswitch)
			rm -rf "$(pwd)/dist/dubswitch-linux-arm64-tmp"
			;;
		linux-x64)
					 npx electron-packager . x32-router --platform=linux --arch=x64 --out="$(pwd)/dist/" \
					 --ignore="dist|dist-release-|.git|.DS_Store|.*\\.zip|.*\\.log|createRelease.*|x32-router-.*" --overwrite
					# Detect actual packaged output directory under dist (electron-packager may name it differently)
					OUTDIR="$(pwd)/dist"
					PACK_DIR=""
					PACK_DIR=$(ls -d "$OUTDIR"/*linux-x64* 2>/dev/null | head -n1 || true)
					if [ -z "$PACK_DIR" ]; then
						PACK_DIR=$(ls -d "$OUTDIR"/*linux* 2>/dev/null | head -n1 || true)
					fi
					if [ -z "$PACK_DIR" ]; then
						PACK_DIR=$(ls -d "$OUTDIR"/* 2>/dev/null | head -n1 || true)
					fi
					if [ -z "$PACK_DIR" ]; then
						echo "Could not find packaged output directory under $OUTDIR" >&2
						exit 1
					fi
					# Ensure required files are present in the packaged app (best-effort)
					cp package.json "$PACK_DIR/" || true
					cp main.js "$PACK_DIR/" || true
					[ -f README.md ] && cp README.md "$PACK_DIR/"
					[ -f package-lock.json ] && cp package-lock.json "$PACK_DIR/"
					mkdir -p "$(pwd)/dist/dubswitch-linux-x64-tmp/Dubswitch"
					# Copy entire packaged output into the temp Dubswitch folder so runtime
					# files are included in the final zip.
					cp -R "$PACK_DIR"/. "$(pwd)/dist/dubswitch-linux-x64-tmp/Dubswitch/" || true
					[ -d resources ] && cp -R resources "$(pwd)/dist/dubswitch-linux-x64-tmp/Dubswitch/Resources/" || true
					[ -d public/vendor ] && mkdir -p "$(pwd)/dist/dubswitch-linux-x64-tmp/Dubswitch/Resources/public" && cp -R public/vendor "$(pwd)/dist/dubswitch-linux-x64-tmp/Dubswitch/Resources/public/" || true
					[ -f LICENSE ] && cp LICENSE "$(pwd)/dist/dubswitch-linux-x64-tmp/Dubswitch/"
					[ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-linux-x64-tmp/Dubswitch/"
					(cd "$(pwd)/dist/dubswitch-linux-x64-tmp" && zip -r "$dist_dir/dubswitch-linux-x64-$tag.zip" Dubswitch)
					rm -rf "$(pwd)/dist/dubswitch-linux-x64-tmp"
					 # Create .deb package for Linux Mint/Ubuntu/Debian
					 if ! command -v electron-installer-debian >/dev/null 2>&1; then
						 echo "electron-installer-debian not found, installing..."
						 npm install -g electron-installer-debian
					 fi
					 mkdir -p "$(pwd)/deb-tmp"
											   electron-installer-debian \
												   --src "$(pwd)/dist/dubswitch-linux-x64/" \
													 --dest "$(pwd)/deb-tmp" \
													 --arch amd64 \
													 --options.version=$tag \
													 --options.name=x32-router \
													 --options.maintainer="Mike Schneider <info@dubmajor.de>" \
													 --options.description="X32/M32 Input & User-Patch Router with OSC and Web UI. Control and route X32/M32 mixer channels from your desktop."
					 # Move .deb to release folder and clean up temp
					 mv "$(pwd)/deb-tmp"/*.deb "$dist_dir/"
					 rm -rf "$(pwd)/deb-tmp"
			;;
	esac
done

# Optionally create and push git tag for the release (idempotent)
echo "Tagging release v$tag..."
if git rev-parse -q --verify "refs/tags/v$tag" >/dev/null; then
	if [ "$FORCE_TAG" = "true" ]; then
		echo "Tag v$tag already exists — FORCE_TAG=true, forcing update..."
		git tag -f v$tag
		git push -f origin v$tag
	else
		echo "Tag v$tag already exists. Skipping tag creation (set FORCE_TAG=true to force)."
	fi
else
	git tag v$tag
	git push origin v$tag
fi

echo "Release packaging complete. Files in $dist_dir/"

# Clean up only intermediate build artefacts from project folder to keep git clean.
# IMPORTANT: keep the dist-release-* artifacts (final release bundles) intact.
echo "Cleaning up intermediate build artefacts from project folder..."
# remove the intermediate 'dist' folder and common packager temp outputs, but DO NOT remove dist-release-*
rm -rf dist x32-router-darwin-* x32-router-win32-* x32-router-linux-* deb-tmp
echo "Intermediate build artefacts removed. Final release bundles are in $dist_dir/"
