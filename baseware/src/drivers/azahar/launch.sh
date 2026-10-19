#!/bin/bash
set -euo pipefail
app="${RSA_AZAHAR_APP:-/Applications/Azahar.app}"
export RSA_BRIDGE_PORT="${RSA_BRIDGE_PORT:-47673}"
exec "$app/Contents/MacOS/azahar" "$@"
