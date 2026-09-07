/**
 * Helper for shelling out to the native oracle CLIs built from the `wesnoth`
 * submodule (see ../README.md). Every oracle is a small headless C++ binary
 * that links real engine code and dumps ground truth for a fixed input, so
 * the TS side can assert its own port against it instead of a screenshot.
 *
 * This module intentionally does not know how to *build* the binaries --
 * that's scripts/build-image-oracle.sh and friends -- it only knows how to
 * run one that already exists and report clearly when it doesn't, since CI
 * and most day-to-day dev work runs off the checked-in fixtures/ output, not
 * a live rebuild.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath(import.meta.url) rather than import.meta.dirname: the latter
// is only available from Node 20.11/21.2 onward, and this repo's installed
// runtime (18.x) doesn't have it.
const HERE = dirname(fileURLToPath(import.meta.url));

/** Root of the `wesnoth` git submodule, relative to the repo root. */
export const WESNOTH_SUBMODULE_DIR = resolve(HERE, "../../../wesnoth");

/** Default out-of-tree CMake build directory for the oracle binaries. */
export const ORACLE_BUILD_DIR = resolve(WESNOTH_SUBMODULE_DIR, "build-oracle");

export interface OracleRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Path to a built oracle binary, or null if it hasn't been built.
 *
 * Binaries are gitignored build products of the wesnoth submodule (see
 * README.md for the build command) -- they are never checked in, so this
 * returns null in any environment that hasn't run the native build.
 */
export function oracleBinaryPath(name: string): string | null {
  // EXECUTABLE_OUTPUT_PATH is set to the build dir itself (see wesnoth's
  // top-level CMakeLists.txt), so binaries land directly under
  // build-oracle/, not build-oracle/src/.
  const path = resolve(ORACLE_BUILD_DIR, name);
  return existsSync(path) ? path : null;
}

/**
 * Runs a built oracle binary with the given args, throwing a descriptive
 * error (rather than a bare ENOENT) if it hasn't been built yet.
 */
export function runOracle(
  name: string,
  args: string[],
  options?: { input?: string },
): OracleRunResult {
  const bin = oracleBinaryPath(name);
  if (!bin) {
    throw new Error(
      `${name} is not built. Run the native build first -- see ` +
        `packages/oracle-tools/README.md ` +
        `(expected at ${resolve(ORACLE_BUILD_DIR, name)}).`,
    );
  }

  const result = spawnSync(bin, args, {
    input: options?.input,
    encoding: "utf-8",
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
