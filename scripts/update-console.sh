#!/usr/bin/env bash
# Console-mode updater. Replaces the wallet binary for the interactive line
# console launch mode (edgex-wallet console / cli).
#
# A running console session holds the binary on some platforms, so the script
# stops the edgex-wallet console process first (RPC `stop` is preferred when a
# wallet is running and reachable; a process signal is the fallback), then
# runs the shared update core. User data is preserved.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Try a clean stop over RPC first (the console exposes the same RPC port as
# the daemon when dexcoin.conf configures one). Ignore failures: the wallet
# may not be running or RPC may be disabled.
if command -v edgex-wallet >/dev/null 2>&1; then
  edgex-wallet stop >/dev/null 2>&1 || true
fi
pkill -f "edgex-wallet (console|cli)" >/dev/null 2>&1 || true
sleep 1

"$SCRIPT_DIR/update-common.sh"

echo ""
echo "Console update complete. Restart with: edgex-wallet console"
