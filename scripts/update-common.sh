#!/usr/bin/env bash
# Shared POSIX update core used by the three launch-mode updater scripts
# (update-tui.sh, update-console.sh, update-daemon.sh).
#
# Behaviour
# - "dev" mode (UPDATE_MODE=dev): the target version is read from a local
#   `version` file and the archive is taken from a local path/URL supplied via
#   EDX_UPDATE_ARCHIVE (default: a file named dexcoin-wallet-<os>-<arch>.tar.gz
#   in the current directory). This mirrors the wallet's -dev flag, which reads
#   the same local version file.
# - "prod" mode (UPDATE_MODE=prod, the default): the latest release archive is
#   downloaded from the GitHub release channel.
#
# The script never touches user data: EDX_DATA/, dexcoin.conf, *.vault and
# chain.db are preserved. Only the program binary under the install directory
# is replaced.
#
# Environment:
#   UPDATE_MODE            dev | prod (default prod)
#   EDX_UPDATE_ARCHIVE     dev mode: path or URL of the local archive
#   EDX_INSTALL_DIR        override the default install directory

set -euo pipefail

# Detect OS and architecture.
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

case "$OS" in
  linux|darwin) ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

INSTALL_DIR="${EDX_INSTALL_DIR:-$HOME/.dexcoin/bin}"
MODE="${UPDATE_MODE:-prod}"

# Resolve the archive source (URL or local file) depending on the mode.
if [ "$MODE" = "dev" ]; then
  # Dev updates pair with a local `version` file; the archive itself is
  # supplied explicitly (EDX_UPDATE_ARCHIVE) and defaults to a file next to
  # the working directory.
  VERSION_FILE="version"
  if [ ! -f "$VERSION_FILE" ]; then
    echo "Error: dev update needs a local '$VERSION_FILE' file next to the working directory." >&2
    exit 1
  fi
  TARGET_ARCHIVE="${EDX_UPDATE_ARCHIVE:-./dexcoin-wallet-${OS}-${ARCH}.tar.gz}"
else
  TARGET_ARCHIVE="dexcoin-wallet-${OS}-${ARCH}.tar.gz"
fi

if [ "$MODE" = "dev" ]; then
  if [ -f "$TARGET_ARCHIVE" ]; then
    DOWNLOAD_SOURCE="$TARGET_ARCHIVE"
  elif [[ "$TARGET_ARCHIVE" == http* ]]; then
    DOWNLOAD_SOURCE="$TARGET_ARCHIVE"
  else
    echo "Error: dev archive not found at $TARGET_ARCHIVE" >&2
    exit 1
  fi
else
  DOWNLOAD_SOURCE="https://github.com/edgexNetwork/EdgeX-Network/releases/latest/download/${TARGET_ARCHIVE}"
fi

mkdir -p "$INSTALL_DIR"
# Remove only old program binaries; user data is preserved.
rm -f "$INSTALL_DIR/dexcoin" "$INSTALL_DIR"/dexcoin-wallet-"$OS"-*

# Download (or copy) and extract into a temp dir, then move just the binary.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Resolving $TARGET_ARCHIVE..."
if [[ "$DOWNLOAD_SOURCE" == http* ]]; then
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$DOWNLOAD_SOURCE" | tar -xz -C "$TMP_DIR"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$DOWNLOAD_SOURCE" | tar -xz -C "$TMP_DIR"
  else
    echo "Error: curl or wget is required." >&2
    exit 1
  fi
else
  tar -xz -C "$TMP_DIR" -f "$DOWNLOAD_SOURCE"
fi

EXTRACTED_FILE=""
for f in "$TMP_DIR"/dexcoin-wallet-"$OS"*; do
  if [ -f "$f" ]; then
    EXTRACTED_FILE="$f"
    break
  fi
done

if [ -n "$EXTRACTED_FILE" ]; then
  mv -f "$EXTRACTED_FILE" "$INSTALL_DIR/dexcoin"
  chmod +x "$INSTALL_DIR/dexcoin"
else
  echo "Error: dexcoin binary not found in the archive. Archive layout may have changed." >&2
  exit 1
fi

echo "Program installed at $INSTALL_DIR/dexcoin"
echo "Restart the wallet (edgex-wallet) to run the new version."
