/**
 * Minimal ambient typings for the small slice of Node's runtime this package
 * touches (file-based `{include}` resolution in preprocessor.ts, and
 * filesystem access in index.ts's `parseWmlFile`/`preloadDefinesFromDir`
 * helpers). We can't add `@types/node` as a dependency for this task (no
 * `npm install`/`package.json` edits), and the actual Node runtime provides
 * these at runtime under Vitest, so this file just describes the handful of
 * APIs actually called. Delete this once `@types/node` is added to the
 * workspace for real.
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean };
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
}

declare const process: { cwd(): string };
declare const console: { warn(...args: unknown[]): void };
