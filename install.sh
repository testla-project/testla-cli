#!/bin/sh
set -e

REPO="testla-project/testla-cli"
BINARY="testla"
INSTALL_DIR="/usr/local/bin"

# ── Platform Detection ────────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    ARTIFACT="testla-linux-x64"
    ;;
  Darwin)
    case "$ARCH" in
      arm64) ARTIFACT="testla-macos-arm64" ;;
      *)     ARTIFACT="testla-macos-x64" ;;
    esac
    ;;
  *)
    echo "❌ Unsupported OS: $OS"
    echo "   Please download manually from: https://github.com/${REPO}/releases"
    exit 1
    ;;
esac

# ── Resolve Latest Version ────────────────────────────────────────────────────

VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' \
  | sed 's/.*"tag_name": *"\(.*\)".*/\1/')

if [ -z "$VERSION" ]; then
  echo "❌ Could not resolve latest release version."
  exit 1
fi

echo ""
echo "  ████████╗███████╗███████╗████████╗██╗      █████╗ "
echo "     ██╔══╝██╔════╝██╔════╝╚══██╔══╝██║     ██╔══██╗"
echo "     ██║   █████╗  ███████╗   ██║   ██║     ███████║"
echo "     ██║   ██╔══╝  ╚════██║   ██║   ██║     ██╔══██║"
echo "     ██║   ███████╗███████║   ██║   ███████╗██║  ██║"
echo "     ╚═╝   ╚══════╝╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝"
echo ""
echo "  Installing ${VERSION} for ${OS}/${ARCH}..."
echo ""

# ── Download ──────────────────────────────────────────────────────────────────

TMP="$(mktemp)"

curl -fsSL \
  "https://github.com/${REPO}/releases/download/${VERSION}/${ARTIFACT}" \
  -o "$TMP"

chmod +x "$TMP"

# ── Install ───────────────────────────────────────────────────────────────────

# Try /usr/local/bin, fall back to ~/.local/bin if no sudo
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP" "${INSTALL_DIR}/${BINARY}"
else
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
  mv "$TMP" "${INSTALL_DIR}/${BINARY}"
  echo "  ⚠️  Installed to ${INSTALL_DIR} (no write access to /usr/local/bin)"
  echo "     Make sure ${INSTALL_DIR} is in your PATH:"
  echo "     export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo ""
echo "  ✅ testla ${VERSION} installed → ${INSTALL_DIR}/${BINARY}"
echo ""
echo "  Get started:"
echo "    testla --help"
echo ""