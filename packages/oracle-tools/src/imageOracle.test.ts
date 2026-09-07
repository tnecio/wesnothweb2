/**
 * Proves the oracle pipeline end to end: native build -> CLI runs -> TS can
 * invoke it and read its output. Not a fidelity test of the frontend's image
 * pipeline (packages/renderer) yet -- that comes once that pipeline exists
 * and can be diffed against these fixtures pixel-for-pixel.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { oracleBinaryPath, runOracle } from "./runOracle.js";

// See runOracle.ts for why fileURLToPath(import.meta.url) is used instead of
// import.meta.dirname (Node 18 compatibility).
const HERE = dirname(fileURLToPath(import.meta.url));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(path: string): boolean {
  const header = readFileSync(path).subarray(0, 8);
  return header.equals(PNG_MAGIC);
}

interface ManifestRow {
  index: string;
  status: string;
  width: string;
  height: string;
  file: string;
  locator: string;
}

function parseManifest(tsv: string): ManifestRow[] {
  const lines = tsv.trim().split("\n");
  const [header, ...rows] = lines;
  const columns = (header ?? "").split("\t");
  return rows.map((row) => {
    const cells = row.split("\t");
    return Object.fromEntries(
      columns.map((col, i) => [col, cells[i] ?? ""]),
    ) as unknown as ManifestRow;
  });
}

describe("wl-image-oracle fixtures (checked in, no toolchain required)", () => {
  const fixtureDir = join(HERE, "../fixtures/image-oracle");
  const manifest = parseManifest(
    readFileSync(join(fixtureDir, "manifest.tsv"), "utf-8"),
  );

  it("has at least one fixture case", () => {
    expect(manifest.length).toBeGreaterThan(0);
  });

  it("every OK row points at a real 72x72 PNG (hex-sized, per image::HEXED)", () => {
    for (const row of manifest) {
      expect(row.status).toBe("OK");
      const path = join(fixtureDir, row.file);
      expect(isPng(path)).toBe(true);
      expect(row.width).toBe("72");
      expect(row.height).toBe("72");
    }
  });
});

describe.skipIf(!oracleBinaryPath("wl-image-oracle"))(
  "wl-image-oracle (live run -- requires native build, see README.md)",
  () => {
    it("rasterises a locator and writes a real PNG", () => {
      const outDir = mkdtempSync(join(tmpdir(), "wl-image-oracle-test-"));
      try {
        const result = runOracle("wl-image-oracle", [
          "--data",
          join(HERE, "../../../wesnoth/data"),
          "--out",
          outDir,
          "units/saurians/oracle/oracle.png",
        ]);

        expect(result.status).toBe(0);

        const manifest = parseManifest(
          readFileSync(join(outDir, "manifest.tsv"), "utf-8"),
        );
        expect(manifest).toHaveLength(1);
        expect(manifest[0]?.status).toBe("OK");
        expect(isPng(join(outDir, manifest[0]!.file))).toBe(true);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    });
  },
);
