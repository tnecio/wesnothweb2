# oracle-tools

TypeScript-side home for the "oracle" testing pattern described in
[docs/TESTING_STRATEGY.md](../../docs/TESTING_STRATEGY.md): small **native**
(non-WASM) CLIs built from the `wesnoth` submodule that link the real C++
engine subsystems and dump ground-truth output for fixed inputs, so the
TypeScript port can be asserted against the actual engine instead of judged
by eye.

This package does not reimplement anything from the engine. It only:

- documents how to build the native oracle binaries (below),
- defines the `fixtures/` convention for checking their output into the repo,
- provides a small helper (`src/runOracle.ts`) for shelling out to a built
  oracle from a Vitest test or a one-off script.

The oracle binaries themselves are **not** committed (they're native
executables, built from a gitignored `wesnoth/build-oracle/` directory) --
only their `fixtures/` output is. Regenerating fixtures requires the C++
toolchain; ordinary `npm test` runs do not.

## Building the oracles

All oracles are built from the `wesnoth` git submodule via its existing CMake
project, using a dedicated out-of-tree build directory
(`wesnoth/build-oracle/`) and an `ENABLE_IMAGE_ORACLE` option that is off by
default so a normal build of the project doesn't pick up SDL2/SDL2_image as
dependencies.

### One-time system dependencies (Debian/Ubuntu)

```sh
sudo apt-get install -y cmake ninja-build build-essential pkg-config \
  libboost-all-dev libssl-dev libicu-dev \
  libsdl2-dev libsdl2-image-dev
```

Deliberately **not** installed: `libsdl2-mixer-dev`, `libcairo2-dev`,
`libpango1.0-dev`, `libfontconfig1-dev`, `libvorbis-dev`,
`libcurl4-openssl-dev`. Those are only pulled in by upstream's CMakeLists.txt
when `ENABLE_GAME` or `ENABLE_TESTS` is on (the full desktop game / test
suite) -- the oracle build sets both off, so none of that audio/video/text
stack is needed. `wl-image-oracle` links real `SDL2`/`SDL2_image` for surface
decoding only (no window, no renderer, no audio).

Also needs the `lua` nested submodule initialized once (small, pure-source,
not the shallow `wesnoth` submodule itself):

```sh
cd wesnoth && git submodule update --init src/modules/lua
```

### Configure + build

```sh
cd wesnoth
cmake -S . -B build-oracle -G Ninja \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DENABLE_GAME=OFF \
  -DENABLE_SERVER=OFF \
  -DENABLE_TESTS=OFF \
  -DENABLE_NLS=OFF \
  -DENABLE_IMAGE_ORACLE=ON \
  -DENABLE_DISPLAY_REVISION=OFF
ninja -C build-oracle wl-image-oracle
```

(`ENABLE_DISPLAY_REVISION=OFF` skips upstream's `revision.h` codegen step,
which isn't wired up as a dependency of `wl-image-oracle` and would otherwise
fail the build with a missing-header error the first time this target is
built standalone -- see `docs/ORACLE_BUILD_NOTES.md`.)

The binary lands at `wesnoth/build-oracle/wl-image-oracle`.

### Running it

```sh
./wesnoth/build-oracle/wl-image-oracle \
  --data wesnoth/data --out /tmp/oracle-out \
  'terrain/water/waves-concave-A01.png~MASK(terrain/masks/7hex-r.png)'
```

Writes one PNG per locator into `--out`, plus a `manifest.tsv` mapping
index -> status -> dimensions -> filename -> locator. Locators can also be
piped in one-per-line on stdin instead of given as arguments.

## What already existed vs. what this package adds

`wl-image-oracle` (`wesnoth/src/wesnothlite/wl_image_oracle.cpp`) and its
CMake wiring already existed in the `wesnothlite` branch of the submodule
before this package did -- see `docs/ORACLE_BUILD_NOTES.md` for exactly what
had to change to get it building and running on this machine (mostly:
installing `cmake` and the trimmed dependency list above, initializing the
`lua` nested submodule, and disabling `ENABLE_DISPLAY_REVISION`; no engine
source changes were needed). This package is the new TypeScript-side
scaffolding around it.

## fixtures/ convention

```
fixtures/
  <oracle-name>/
    manifest.tsv        # or manifest.json, whatever the oracle emits
    <case>.png / .json  # one file per input case
```

Fixtures are checked into git so that ordinary `npm test` runs never need the
C++ toolchain -- only regenerating them does. Regenerate by re-running the
relevant oracle binary with `--out fixtures/<oracle-name>` (or piping its
stdout into a fixture file, for the JSON-dumping oracles).

`fixtures/image-oracle/` holds `wl-image-oracle` output for a small, fixed
set of locators chosen to exercise the cases the frontend's image pipeline
needs to match exactly (team-color remap, hex masking, scaling). See
`src/imageOracle.test.ts` for the list and how it's checked.

## Oracles

| Oracle | Status |
|---|---|
| `wl-image-oracle` | Working -- see above. |
| `wl-wml-oracle` | Stubbed only (`wesnoth/src/wesnothlite/wl_wml_oracle.cpp`) -- parses CLI args and prints a TODO; does not yet link the tokenizer/preprocessor/parser or emit JSON. Not wired into CMake. |
| `wl-rng-oracle` | Stubbed only (`wesnoth/src/wesnothlite/wl_rng_oracle.cpp`) -- same state as above, for `mt_rng.cpp`/`random_deterministic.cpp`. Not wired into CMake. |

The remaining oracles from `docs/TESTING_STRATEGY.md`
(`wl-combat-oracle`, `wl-pathfind-oracle`, `wl-animation-oracle`) have no
scaffolding yet.
