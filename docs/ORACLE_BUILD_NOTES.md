# Oracle build notes

Notes on getting the native oracle tooling (see `docs/TESTING_STRATEGY.md`
and `packages/oracle-tools/README.md`) building on this machine. Written
while doing that work so the dependency-installation reasoning and the one
source patch aren't lost.

## What already existed in the `wesnoth` submodule

The `wesnothlite` branch checkout already had, before any of this work:

- `src/wesnothlite/wl_image_oracle.cpp` — the actual oracle `main()`.
- `source_lists/wesnoth_headless`, `wesnoth_headless_stubs` — the source
  lists the headless (no-SDL) `wesnothlite` engine build already uses.
- The mock-SDL headless stub tree (`src/wesnothlite/stubs/`,
  `src/wesnothlite/headless/SDL2/`) used to build `wesnothlite`/`wl-cli`
  without linking real SDL2 at all.

What did **not** exist yet: any CMake wiring for `wl-image-oracle` itself
(no `ENABLE_IMAGE_ORACLE` option, no target in `src/CMakeLists.txt`, no
`source_lists/wesnoth_oracle_stubs`), and `src/wesnothlite/stubs/picture.cpp`
was still the old two-line stub (the image/surface stub implementations
that needed splitting out of `misc_stubs.cpp` were still inline there).

A previous, separate project attempt (`/home/tom/wesnothweb`, not part of
this repo, sibling directory only) had already solved exactly this on what
turned out to be a byte-for-byte identical version of every file this touches
(confirmed by diffing before making any change). Rather than re-deriving the
CMake wiring from scratch, I copied that solution's already-working version
of the following files over verbatim:

- `CMakeLists.txt` (top level) — adds `option(ENABLE_IMAGE_ORACLE ... OFF)`.
- `src/CMakeLists.txt` — adds the `wl-image-oracle` target, gated on
  `NOT EMSCRIPTEN AND ENABLE_IMAGE_ORACLE`.
- `source_lists/wesnoth_headless_stubs` — adds
  `wesnothlite/stubs/sdl_surface.cpp` to the headless stub list.
- `source_lists/wesnoth_oracle_stubs` (new) — same as
  `wesnoth_headless_stubs` minus `picture.cpp` and `sdl_surface.cpp`, since
  the oracle links the *real* `picture.cpp`/`sdl/surface.cpp` instead.
- `src/wesnothlite/stubs/picture.cpp` — now the full image:: stub
  implementation (moved out of `misc_stubs.cpp`), so a build wanting the real
  image pipeline can simply swap this one file out via the source list above
  instead of colliding on duplicate symbols in a shared translation unit.
- `src/wesnothlite/stubs/sdl_surface.cpp` (new) — same idea, for the
  `surface` stub methods that collide with the real `sdl/surface.cpp`.
- `src/wesnothlite/stubs/misc_stubs.cpp` — the above two stub
  implementations removed (relocated to the files above); also picked up an
  unrelated but harmless `new_animation_frame()` no-op stub that the other
  checkout had added since divergence.
- `src/wesnothlite/wl_image_oracle.cpp` — the more complete version: sets up
  `[binary_path] path=data/core` and `game_config::images::terrain_mask` (both
  needed for image lookups/`HEXED` masking to work without a full WML parse),
  shims `wl_hook_*`/`video::get_renderer`/two `draw::` overloads referenced by
  shared sources but unreachable from a tool that only calls the surface path,
  and drops `SDL_Init(SDL_INIT_VIDEO)` (aborts on a headless host, and is not
  needed to decode into surfaces).

This is the full list of source changes — no other files in `wesnoth/` were
touched, and no other build system besides CMake was touched.

## New stub files (item 4, lower priority)

Also added, at the task's request, as clearly-marked non-functional
scaffolding for two more `docs/TESTING_STRATEGY.md` oracles:

- `src/wesnothlite/wl_wml_oracle.cpp`
- `src/wesnothlite/wl_rng_oracle.cpp`

Both just print a "STUB, not implemented yet" message and exit 1. **Neither
is wired into CMake** — no target, no source list entry — so they don't
affect the `wl-image-oracle` build and aren't compiled by anything. Each
file's header comment describes what's actually needed (see the files
themselves; summarized in `packages/oracle-tools/README.md`'s oracle table).

## Dependency installation

`cmake` was not installed on this machine. Also not installed: `ninja`,
`libboost-all-dev`, `libssl-dev`, `libicu-dev`, `libsdl2-dev`,
`libsdl2-image-dev` — all installed via `apt-get` (see
`packages/oracle-tools/README.md` for the exact command).

**Judgment call**: the previous project's CI/devcontainer install list for
this same submodule (`libsdl2-mixer-dev`, `libcairo2-dev`, `libpango1.0-dev`,
`libfontconfig1-dev`, `libvorbis-dev`, `libcurl4-openssl-dev`, `scons`) was
*not* installed here, on purpose. Reading `CMakeLists.txt` showed all of
those are only pulled in by `find_package`/`pkg_check_modules` calls gated on
`if(ENABLE_GAME OR ENABLE_TESTS)` (lines ~551-570) — i.e. only needed to
build the full desktop game or its test suite, neither of which the oracle
needs. `wl-image-oracle`'s own CMake block calls
`find_package(SDL2 REQUIRED)` / `find_package(SDL2_image REQUIRED)`
independently of `ENABLE_GAME`, so `libsdl2-dev`/`libsdl2-image-dev` genuinely
are required (SDL2_image decodes the PNGs; no window or renderer is created)
— but audio (`SDL2_mixer`) and text shaping (`cairo`/`pango`/`fontconfig`)
are not, since the oracle never touches sound or rendered text. Configuring
with `-DENABLE_GAME=OFF -DENABLE_TESTS=OFF` confirmed this: CMake configure
succeeded without any of those six packages installed, and the build never
asked for them.

Also note: `libboost-all-dev` itself pulls in a large transitive tree via
apt (MPI, X11/GL dev headers, Python bindings, etc.) because that package
means "every Boost component," most of which this build doesn't use (only
`iostreams program_options regex thread random locale filesystem graph
coroutine` are actually linked). This was installed anyway for expediency
rather than hand-picking the ~9 needed `libboost-*-dev` packages — it's
still just dev headers/static-ish libs, not a GUI/audio runtime, so it
doesn't violate the "avoid the full desktop stack" constraint in spirit, but
a tighter install would only pull the specific Boost component packages.

## Two configure-time issues hit, and how they were resolved

1. **Missing `src/modules/lua` nested submodule.** `wesnoth`'s top-level
   `CMakeLists.txt` hard-fails configure if
   `src/modules/lua/.git` doesn't exist (it's a nested git submodule of the
   `wesnoth` submodule, not a directory that ships pre-populated). Fixed with
   `git -C wesnoth submodule update --init src/modules/lua`. This is a
   normal, tiny, non-shallow submodule clone (the Lua source, a few hundred
   KB) — it does not touch or deepen the shallow `wesnoth` submodule itself.
   The other nested submodule, `src/modules/mariadbpp`, was left
   uninitialized: it's only referenced when `ENABLE_MYSQL` is on (default
   off, and irrelevant to an oracle build).

2. **Missing generated `revision.h`.** Building `wl-image-oracle` failed on
   `game_version.cpp:24:10: fatal error: revision.h: No such file or
   directory`. Upstream generates this via a `wesnoth-revision` custom
   target (`utils/autorevision.sh`), but `src/CMakeLists.txt` only adds that
   as a dependency of the `wesnoth-common` target — `wl-image-oracle` also
   compiles `game_version.cpp` (via the shared `wesnoth_headless_sources`
   list) but has no such dependency edge, so nothing generates the header
   before it's needed. Rather than patch the CMake dependency graph (out of
   scope — `ENABLE_DISPLAY_REVISION` only controls a version-string display
   feature, irrelevant to a rasterizing CLI), configured with
   `-DENABLE_DISPLAY_REVISION=OFF`, which skips `LOAD_REVISION` entirely.
   Documented here rather than as a source patch since it's a configure flag,
   not a file change.

No source-level patches were needed beyond the file replacements listed
above (all of which came from a previously-solved, verified-identical
version of the same files, not from new reverse-engineering).

## Build reproduction

See `packages/oracle-tools/README.md` for the exact commands
(`packages/oracle-tools/scripts/build-image-oracle.sh` runs all of them).
Build directory: `wesnoth/build-oracle/` (gitignored territory inside the
submodule; not committed, and the submodule's own git state was not
committed to either).

Verified working: built `wl-image-oracle` successfully (RelWithDebInfo,
`ninja -j8`, ~260 translation units, a few minutes on this machine) and ran
it against three locators including
`terrain/water/waves-concave-A01.png~MASK(terrain/masks/7hex-r.png)`,
producing valid 72x72 RGBA PNGs and a well-formed `manifest.tsv` for all
three. Fixtures from that run are checked into
`packages/oracle-tools/fixtures/image-oracle/`.

## No open blockers

Unlike the time-box-and-stop contingency this task allowed for, the
dependency list never ballooned — `ENABLE_GAME=OFF` genuinely keeps the
audio/video/text stack out, confirming wesnothlite's headless design does
what it's supposed to. Nothing here needs revisiting unless upstream's
CMakeLists.txt changes what's gated behind `ENABLE_GAME`.
