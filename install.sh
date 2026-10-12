#!/bin/sh
# Installs the latest streamFree release for macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/iamvinbas/streamFree/main/install.sh | sh
#
# Installs the streamfree command into ~/.local/bin (override with
# STREAMFREE_INSTALL_DIR) and the desktop app: streamFree.app in
# ~/Applications on macOS, a menu entry on Linux. No sudo, no other software
# is installed. The download is checked against the release's SHA-256
# checksum.
set -eu

REPO="iamvinbas/streamFree"
DIR="${STREAMFREE_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${STREAMFREE_VERSION:-latest}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os_part="apple-darwin" ;;
  Linux) os_part="unknown-linux-gnu" ;;
  *) echo "streamFree: unsupported system $os. On Windows, use install.ps1 or download the .zip from GitHub Releases." >&2; exit 1 ;;
esac
case "$arch" in
  arm64 | aarch64) arch_part="aarch64" ;;
  x86_64 | amd64) arch_part="x86_64" ;;
  *) echo "streamFree: unsupported CPU $arch" >&2; exit 1 ;;
esac
target="$arch_part-$os_part"
asset="streamfree-$target.tar.gz"
if [ -n "${STREAMFREE_BASE_URL:-}" ]; then
  base="$STREAMFREE_BASE_URL"
elif [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "Downloading $asset ..."
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256"

expected=$(cut -d ' ' -f 1 < "$tmp/$asset.sha256")
if command -v sha256sum > /dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$tmp/$asset" | cut -d ' ' -f 1)
fi
if [ "$expected" != "$actual" ]; then
  echo "streamFree: checksum mismatch, aborting (expected $expected, got $actual)" >&2
  exit 1
fi

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$DIR"
mv "$tmp/streamfree" "$DIR/streamfree"
chmod +x "$DIR/streamfree"

echo "Installed the streamfree command to $DIR/streamfree"

if [ -d "$tmp/streamFree.app" ]; then
  apps="${STREAMFREE_APPS_DIR:-$HOME/Applications}"
  mkdir -p "$apps"
  rm -rf "$apps/streamFree.app"
  mv "$tmp/streamFree.app" "$apps/streamFree.app"
  echo "Installed the app to $apps/streamFree.app"
  echo "Open it from Launchpad or Spotlight (search \"streamFree\")."
elif [ "$os" = "Linux" ]; then
  share="${XDG_DATA_HOME:-$HOME/.local/share}"
  if [ -f "$tmp/streamfree.png" ]; then
    mkdir -p "$share/icons/hicolor/256x256/apps"
    mv "$tmp/streamfree.png" "$share/icons/hicolor/256x256/apps/streamfree.png"
  fi
  mkdir -p "$share/applications"
  cat > "$share/applications/streamfree.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=streamFree
Comment=Local live-streaming studio
Exec="$DIR/streamfree" --app
Icon=streamfree
Terminal=false
Categories=AudioVideo;Video;
StartupWMClass=streamFree
DESKTOP
  echo "Added streamFree to your applications menu."
fi

case ":$PATH:" in
  *":$DIR:"*) echo "From a terminal, run: streamfree" ;;
  *) echo "From a terminal, run: $DIR/streamfree   (or add $DIR to your PATH)" ;;
esac
