// `fengari`/`fengari-interop` ship no TypeScript declarations. Both are
// small, stable, already-installed dependencies (see package.json) whose
// full API surface this package only uses a slice of -- rather than hand-
// write a partial `.d.ts` that would drift from the real API, declare them
// as untyped ambient modules and rely on call-site checks/tests for
// correctness. See src/luaEnv.ts for the thin typed wrapper this package
// actually programs against.
declare module 'fengari';
declare module 'fengari-interop';
