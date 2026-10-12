#!/bin/sh
# Builds streamFree.app around a compiled binary.
#   packaging/macos/make-app.sh <path/to/streamfree> <output-dir> <version>
set -eu
bin="$1"
out="$2"
version="$3"
here=$(cd "$(dirname "$0")" && pwd)
app="$out/streamFree.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/streamfree"
chmod +x "$app/Contents/MacOS/streamfree"
sed "s/__VERSION__/$version/g" "$here/Info.plist" > "$app/Contents/Info.plist"
cp "$here/../icons/streamFree.icns" "$app/Contents/Resources/streamFree.icns"
printf 'APPL????' > "$app/Contents/PkgInfo"
# Ad-hoc signature: Apple silicon refuses to run unsigned code, and a
# consistent bundle signature avoids "damaged app" errors.
codesign --force --deep --sign - "$app" 2>/dev/null || true
echo "$app"
