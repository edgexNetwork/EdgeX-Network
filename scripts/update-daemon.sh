#!/usr/bin/env bash
# Daemon-mode updater. Replaces the wallet binary for the headless daemon
# launch mode (edgex-wallet daemon).
#
# The daemon runs as a background service and holds the binary; this script
# stops it first (RPC `stop` when reachable, then a process signal), runs the
# shared update core, and reminds the caller to bring the service back up.
# User data (EDX_DATA, wallet.vault, chain.db) is preserved.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ask the daemon to shut down cleanly over RPC. A stopped or RPC-disabled
# daemon makes this fail harmlessly.
if command -v edgex-wallet >/dev/null 2>&1; then
  edgex-wallet stop >/dev/null 2>&1 || true
fi
pkill -f "edgex-wallet daemon" >/dev/null 2>&1 || true
# Give the daemon time to flush and release the binary before replacement.
sleep 2

"$SCRIPT_DIR/update-common.sh"

echo ""
echo "Daemon update complete. Restart the daemon with: edgex-wallet daemon"
echo "(If the daemon is managed by a service supervisor, start it there instead.)"
