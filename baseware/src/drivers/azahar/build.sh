#!/bin/bash
set -euo pipefail
driver_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$driver_dir/../../../.." && pwd)
artifact_dir="$repo_dir/../artifacts/3ds"
source_dir="${RSA_AZAHAR_SOURCE:-$artifact_dir/azahar-source}"
build_dir="$artifact_dir/azahar-build"
revision=219d743a1e698101fe1ab8bef43e6563126c3c27

mkdir -p "$artifact_dir"
if [ ! -d "$source_dir/.git" ]; then
  git clone --depth 1 --branch 2126.2 https://github.com/azahar-emu/azahar.git "$source_dir"
fi
test "$(git -C "$source_dir" rev-parse HEAD)" = "$revision"
git -C "$source_dir" submodule update --init --recursive --jobs 4
if git -C "$source_dir" apply --check "$driver_dir/azahar.patch" 2>/dev/null; then
  git -C "$source_dir" apply "$driver_dir/azahar.patch"
else
  git -C "$source_dir" apply --reverse --check "$driver_dir/azahar.patch"
fi
cp "$driver_dir/rsa_touch_bridge.cpp" "$driver_dir/rsa_touch_bridge.h" "$source_dir/src/core/frontend/"
cmake -S "$source_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DENABLE_LTO=OFF -DENABLE_TESTS=OFF \
  -DENABLE_ROOM_STANDALONE=OFF -DENABLE_DISCORD_RPC=OFF -DENABLE_QT_UPDATE_CHECKER=OFF
cmake --build "$build_dir" --target bundle --parallel "${RSA_BUILD_JOBS:-4}"
echo "Built $build_dir/bundle/azahar.app"
