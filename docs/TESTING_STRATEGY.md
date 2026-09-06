# Testing strategy: the oracle pattern

Attempt #1's single biggest lesson (per its own docs) is that *not* verifying
fidelity against the real engine early cost it the most time — the
`image::HEXED`/mask/opacity investigation happened late, under a pile of
already-written rendering code, and it stalled the whole project. It also
left behind the fix for that mistake: `wl_image_oracle.cpp`, a **native**
(non-WASM) CLI tool built from the `wesnoth` submodule via its own CMake
target, which rasterizes an image locator using the engine's own
`picture.cpp`/`image_modifications.cpp` and dumps the result. `dump-images.js`
does the same through the TS pipeline, and `compare-images.js` diffs them
(alpha exactly, color premultiplied) with a tolerance.

This pattern generalizes far beyond images, and should be the backbone of
verifying wesnothweb2's engine port from day one rather than something
added once something looks wrong:

**Build a small family of native oracle CLIs from `wesnoth/`, one per
subsystem being ported, each dumping ground truth as JSON (or PNG for
images) for a given fixed input:**

| Oracle | Wraps | Dumps | Verifies |
|---|---|---|---|
| `wl-image-oracle` | `picture.cpp`, `image_modifications.cpp` | PNG | `packages/renderer` image compositing (already exists, extend as needed) |
| `wl-wml-oracle` | `serialization/{tokenizer,preprocessor,parser}.cpp` | parsed `config` tree as JSON | `packages/engine` WML pipeline, incl. macro expansion |
| `wl-rng-oracle` | `mt_rng.cpp`/`random_deterministic.cpp` | N draws for a given seed | `packages/engine` MT19937 port — must be bit-exact |
| `wl-combat-oracle` | `actions/attack.cpp`, `attack_prediction.cpp` | damage/hit-chance/outcome distribution for fixed attacker/defender/terrain/seed | `packages/engine` combat resolution |
| `wl-pathfind-oracle` | `pathfind/astarsearch.cpp`, `pathfind.cpp` | reachable hexes + path cost for a fixed unit/map/location | `packages/engine` pathfinding |

Each oracle is a thin `main()` that loads the relevant pieces of the real
engine (most of this is already possible without SDL/display init, since
these subsystems don't require a window), takes JSON/CLI input, and prints
JSON/PNG output to stdout or a file. Wire them into a fixtures directory
(`packages/oracle-tools/fixtures/`) checked into the repo so tests don't
need the C++ toolchain at CI/dev time beyond a one-time regeneration step.

On the TS side, ordinary unit/integration tests load the same fixture
inputs, run them through the port, and assert equality (or near-equality,
with an explicit tolerance, for anything float-derived like image alpha)
against the oracle's dumped output. This turns "does our TS combat math
match the real engine" from a question answered by playtesting into a
question answered by `npm test`.

## Golden-scenario regression tests

Once a piece of engine behavior is verified correct once via an oracle, use
ordinary snapshot/regression testing to keep it correct as the codebase
grows: pick a handful of small WML scenarios (start with a hand-written
minimal one, then real mainline scenarios as they come into scope), drive
them headlessly through a fixed scripted sequence of commands, and snapshot
the resulting event log or a state hash. This catches regressions cheaply
without needing to re-run the C++ oracle on every change — the oracle is for
establishing ground truth on a new subsystem, snapshots are for not losing
it.

## What this buys us over attempt #1's approach

Attempt #1 built exactly one oracle (images), and only after the display
layer was already deep enough to be hard to debug. Standing up
`wl-wml-oracle` and `wl-rng-oracle` in Phase 0 — before a single line of the
WML parser or RNG port is written — means every subsystem in Phase 1/2 gets
its own ground truth from day one, which is exactly the discipline whose
absence is the throughline of everything attempt #1's docs flag as painful.
