#!/usr/bin/env bash
# Configures and builds wl-image-oracle from the wesnoth submodule into
# wesnoth/build-oracle/. See ../README.md for the one-time system
# dependencies (cmake, ninja, SDL2 dev headers, etc.) and for why the list is
# deliberately short (no audio/video/text stack -- that's only needed by the
# full desktop game build, which this does not build).
#
# Usage: packages/oracle-tools/scripts/build-image-oracle.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
wesnoth_dir="$repo_root/wesnoth"
build_dir="$wesnoth_dir/build-oracle"

if [ ! -f "$wesnoth_dir/src/modules/lua/.git" ] && [ ! -d "$wesnoth_dir/src/modules/lua/.git" ]; then
  echo "Initializing wesnoth's nested lua submodule..."
  git -C "$wesnoth_dir" submodule update --init src/modules/lua
fi

cmake -S "$wesnoth_dir" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DENABLE_GAME=OFF \
  -DENABLE_SERVER=OFF \
  -DENABLE_TESTS=OFF \
  -DENABLE_NLS=OFF \
  -DENABLE_IMAGE_ORACLE=ON \
  -DENABLE_DISPLAY_REVISION=OFF

ninja -C "$build_dir" wl-image-oracle

echo
echo "Built: $build_dir/wl-image-oracle"
