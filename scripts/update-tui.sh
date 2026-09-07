#!/usr/bin/env bash
# TUI-mode updater. Replaces the wallet binary for the full-screen TUI launch
# mode (edgex-wallet start).
#
# The TUI owns the terminal, so this script asks the user to close it first,
# then runs the shared update core. Run it from a separate terminal while the
# TUI is still open for a guided upgrade.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "TUI-mode update: close the wallet TUI window before continuing."
read -r -p "Press Enter when the TUI has been closed, or Ctrl+C to abort... " || exit 1

"$SCRIPT_DIR/update-common.sh"

echo ""
echo "TUI update complete. Restart with: edgex-wallet"
