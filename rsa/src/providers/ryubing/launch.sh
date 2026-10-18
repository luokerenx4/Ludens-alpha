#!/bin/bash
set -euo pipefail
export RSA_BRIDGE_PORT="${RSA_BRIDGE_PORT:-47663}"
export DOTNET_DefaultStackSize=200000
exec /Applications/Ryubing.app/Contents/MacOS/Ryujinx "$@"
