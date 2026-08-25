#!/usr/bin/env bash
set -euo pipefail

# 1. Detect OS and architecture
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

# Archive naming: "win" for Windows, "darwin" for macOS
case "$OS" in
  linux|darwin) ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

# 2. Build archive name and download URL
TARGET_ARCHIVE="dexcoin-wallet-${OS}-${ARCH}.tar.gz"
DOWNLOAD_URL="https://github.com/edgexNetwork/EdgeX-Network/releases/latest/download/${TARGET_ARCHIVE}"
INSTALL_DIR="$HOME/.dexcoin/bin"

mkdir -p "$INSTALL_DIR"
# Remove stale binaries from previous installs
rm -f "$INSTALL_DIR/dexcoin" "$INSTALL_DIR"/dexcoin-wallet-"$OS"-*

# 3. Download and extract in one step
echo "Downloading and extracting $TARGET_ARCHIVE..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" | tar -xz -C "$INSTALL_DIR"
elif command -v wget >/dev/null 2>&1; then
  wget -qO- "$DOWNLOAD_URL" | tar -xz -C "$INSTALL_DIR"
else
  echo "Error: curl or wget is required."
  exit 1
fi

# 4. Rename platform binary (e.g. dexcoin-wallet-linux-x64) to "dexcoin"
EXTRACTED_FILE=""
for f in "$INSTALL_DIR"/dexcoin-wallet-"$OS"*; do
  if [ -f "$f" ]; then
    EXTRACTED_FILE="$f"
    break
  fi
done

if [ -n "$EXTRACTED_FILE" ]; then
  mv -f "$EXTRACTED_FILE" "$INSTALL_DIR/dexcoin"
  chmod +x "$INSTALL_DIR/dexcoin"
else
  echo "Error: dexcoin binary not found in $TARGET_ARCHIVE. Archive layout may have changed." >&2
  exit 1
fi

# 5. Add install dir to PATH
PATH_CMD="export PATH=\"$INSTALL_DIR:\$PATH\""
CURRENT_SHELL="$(basename "${SHELL:-}")"

add_to_profile() {
  local profile_file="$1"
    # Create profile file if missing; skip if path already present
  if [ ! -f "$profile_file" ] || ! grep -qF "$INSTALL_DIR" "$profile_file"; then
    {
      echo ""
      echo "# dexcoin wallet"
      echo "$PATH_CMD"
    } >> "$profile_file"
    echo "Added to $profile_file"
  fi
}

case "$CURRENT_SHELL" in
  zsh)  add_to_profile "$HOME/.zshrc" ;;
  bash)
    # macOS login shells read .bash_profile; Linux interactive shells read .bashrc
    if [ "$OS" = "darwin" ]; then
      add_to_profile "$HOME/.bash_profile"
    else
      add_to_profile "$HOME/.bashrc"
    fi
    ;;
  *)    add_to_profile "$HOME/.profile" ;;
esac

echo ""
echo "Successfully installed! Run 'export PATH=\"$INSTALL_DIR:\$PATH\"' or restart your terminal."
echo "Then, you can start the wallet by running: dexcoin"