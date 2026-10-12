#!/bin/sh
# Packs streamFree.app into a drag-to-install disk image.
#   packaging/macos/make-dmg.sh <path/to/streamFree.app> <output.dmg>
set -eu
app="$1"
out="$2"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT INT TERM
cp -R "$app" "$stage/streamFree.app"
ln -s /Applications "$stage/Applications"
rm -f "$out"
hdiutil create -quiet -volname "streamFree" -srcfolder "$stage" -ov -format UDZO -fs HFS+ "$out"
echo "$out"
