#!/bin/bash
set -e

# Get version from package.json
tag=$(grep '"version"' package.json | head -1 | sed 's/[^0-9.]*\([0-9.]*\).*/\1/')
echo "Detected version: $tag"


dist_dir="$(pwd)/dist-release-$tag"
mkdir -p "$dist_dir"

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
			   [ -f LICENSE ] && cp LICENSE "$(pwd)/dist/dubswitch-mac-arm64-tmp/Dubswitch/"
			   [ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-mac-arm64-tmp/Dubswitch/"
			   (cd "$(pwd)/dist/dubswitch-mac-arm64-tmp" && zip -r "$dist_dir/dubswitch-mac-arm64-$tag.zip" Dubswitch)
			   rm -rf "$(pwd)/dist/dubswitch-mac-arm64-tmp"
			;;
				win-x64)
						npx electron-packager . x32-router --platform=win32 --arch=x64 --out="$(pwd)/dist/" \
						--ignore="dist|dist-release-|.git|.DS_Store|.*\\.zip|.*\\.log|createRelease.*|x32-router-.*" --overwrite
						# Ensure required files are present in the packaged app
						   cp package.json "$(pwd)/dist/dubswitch-win32-x64/"
						   cp main.js "$(pwd)/dist/dubswitch-win32-x64/"
						   [ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-win32-x64/"
						   [ -f package-lock.json ] && cp package-lock.json "$(pwd)/dist/dubswitch-win32-x64/"
						   mkdir -p "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch"
						   cp "$(pwd)/dist/dubswitch-win32-x64/Dubswitch.exe" "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch/"
						   [ -f LICENSE ] && cp LICENSE "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch/"
						   [ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-win-x64-tmp/Dubswitch/"
						   (cd "$(pwd)/dist/dubswitch-win-x64-tmp" && zip -r "$dist_dir/dubswitch-win-x64-$tag.zip" Dubswitch)
						   rm -rf "$(pwd)/dist/dubswitch-win-x64-tmp"
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
		"directories": {
								   "app": "$(pwd)/dist/dubswitch-win32-x64",
			"output": "$dist_dir"
		},
		"win": {
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
						;;
		linux-arm64)
			npx electron-packager . x32-router --platform=linux --arch=arm64 --out="$(pwd)/dist/" \
			--ignore="dist|dist-release-|.git|.DS_Store|.*\\.zip|.*\\.log|createRelease.*|x32-router-.*" --overwrite
			# Ensure required files are present in the packaged app
			   cp package.json "$(pwd)/dist/dubswitch-linux-arm64/"
			   cp main.js "$(pwd)/dist/dubswitch-linux-arm64/"
			   [ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-linux-arm64/"
			   [ -f package-lock.json ] && cp package-lock.json "$(pwd)/dist/dubswitch-linux-arm64/"
			   mkdir -p "$(pwd)/dist/dubswitch-linux-arm64-tmp/Dubswitch"
			   cp "$(pwd)/dist/dubswitch-linux-arm64/dubswitch" "$(pwd)/dist/dubswitch-linux-arm64-tmp/Dubswitch/"
			   [ -f LICENSE ] && cp LICENSE "$(pwd)/dist/dubswitch-linux-arm64-tmp/Dubswitch/"
			   [ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-linux-arm64-tmp/Dubswitch/"
			   (cd "$(pwd)/dist/dubswitch-linux-arm64-tmp" && zip -r "$dist_dir/dubswitch-linux-arm64-$tag.zip" Dubswitch)
			   rm -rf "$(pwd)/dist/dubswitch-linux-arm64-tmp"
			;;
		linux-x64)
					 npx electron-packager . x32-router --platform=linux --arch=x64 --out="$(pwd)/dist/" \
					 --ignore="dist|dist-release-|.git|.DS_Store|.*\\.zip|.*\\.log|createRelease.*|x32-router-.*" --overwrite
					 # Ensure required files are present in the packaged app
					   cp package.json "$(pwd)/dist/dubswitch-linux-x64/"
					   cp main.js "$(pwd)/dist/dubswitch-linux-x64/"
					   [ -f README.md ] && cp README.md "$(pwd)/dist/dubswitch-linux-x64/"
					   [ -f package-lock.json ] && cp package-lock.json "$(pwd)/dist/dubswitch-linux-x64/"
					   mkdir -p "$(pwd)/dist/dubswitch-linux-x64-tmp/Dubswitch"
					   cp "$(pwd)/dist/dubswitch-linux-x64/dubswitch" "$(pwd)/dist/dubswitch-linux-x64-tmp/Dubswitch/"
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

# Optionally create and push git tag for the release
echo "Tagging release v$tag..."
git tag v$tag
git push origin v$tag

echo "Release packaging complete. Files in $dist_dir/"

# Clean up build artefacts from project folder to keep git clean
echo "Cleaning up local build artefacts from project folder..."
rm -rf dist dist-release-* x32-router-darwin-* x32-router-win32-* x32-router-linux-* *.zip
echo "Project folder cleaned. Safe to push to git."
