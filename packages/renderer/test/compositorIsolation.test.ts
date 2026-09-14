import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Phase 28a: the image compositor must run inside a Web Worker, so neither it
 * nor anything it imports (transitively, within this package) may import
 * PixiJS or touch the DOM beyond its guarded canvas fallback.
 */
const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function localImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/^\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
}

function resolveLocal(from: string, spec: string): string {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
  return base.endsWith('.ts') ? base : `${base}.ts`;
}

describe('compositor isolation', () => {
  it('images/compositor.ts and its local imports never import pixi.js', () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of localImports(file)) {
        if (spec === 'pixi.js' || spec.startsWith('pixi.js/') || spec.startsWith('@pixi/')) offenders.push(`${file} imports ${spec}`);
        if (spec.startsWith('.')) visit(resolveLocal(file, spec));
      }
    };
    visit(resolve(srcDir, 'images/compositor.ts'));
    expect(offenders).toEqual([]);
    expect(seen.size).toBeGreaterThan(1);
  });
});
