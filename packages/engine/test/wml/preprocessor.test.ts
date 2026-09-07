import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { preprocess, preprocessFile, type PreprocessorHost } from '../../src/wml/preprocessor';
import { parseConfig } from '../../src/wml/parser';
import { parseWml } from '../../src/wml/index';

/** In-memory filesystem host so most preprocessor tests don't touch real disk. */
function memHost(files: Record<string, string>): PreprocessorHost {
  const dirsOf = new Set<string>();
  for (const p of Object.keys(files)) {
    let d = path.posix.dirname(p);
    while (d && d !== '.' && !dirsOf.has(d)) {
      dirsOf.add(d);
      d = path.posix.dirname(d);
    }
  }
  return {
    readFile: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT (mem): ${p}`);
      return v;
    },
    readDir: (p) => {
      const prefix = p.endsWith('/') ? p : p + '/';
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          if (!rest.includes('/')) names.add(rest);
        }
      }
      return [...names];
    },
    stat: (p) => {
      const normalized = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
      if (files[normalized] !== undefined) return { isDirectory: false };
      if (dirsOf.has(normalized)) return { isDirectory: true };
      return undefined;
    },
    join: (...segs) => path.posix.join(...segs),
    dirname: (p) => path.posix.dirname(p),
  };
}

describe('preprocess', () => {
  it('expands a simple macro call with positional arguments', () => {
    const src = '#define GREET NAME\n    hello={NAME}\n#enddef\n[a]\n{GREET Bob}\n[/a]\n';
    const r = preprocess(src, { dir: '/x', host: memHost({}) });
    const cfg = parseConfig(r.text);
    expect(cfg.child('a')!.getString('hello')).toBe('Bob');
  });

  it('supports macro names built from a nested macro call ({TRAIT_{PARAM}} style, as real content does with macro arguments)', () => {
    // Mirrors how Dead_Water's 01_Invasion.cfg actually uses this pattern: TRAIT_1_NAME
    // there is not a zero-arg macro but a *parameter* of the enclosing PUT_CITIZEN macro.
    const src =
      '#define TRAIT_LOYAL\nloyal=yes\n#enddef\n' +
      '#define OUTER PARAM\n[mod]\n{TRAIT_{PARAM}}\n[/mod]\n#enddef\n' +
      '{OUTER LOYAL}\n';
    const r = preprocess(src, { dir: '/x', host: memHost({}) });
    const cfg = parseConfig(r.text);
    expect(cfg.child('mod')!.get('loyal')).toBe(true);
  });

  it('supports parenthesized macro arguments containing spaces', () => {
    const src = '#define WRAP TXT\nvalue={TXT}\n#enddef\n[a]\n{WRAP (hello world)}\n[/a]\n';
    const r = preprocess(src, { dir: '/x', host: memHost({}) });
    const cfg = parseConfig(r.text);
    expect(cfg.child('a')!.getString('value')).toBe('hello world');
  });

  it('supports optional arguments with defaults via #arg/#endarg', () => {
    const src =
      '#define M REQ\n#arg OPT\ndefault-text\n#endarg\nreq={REQ}\nopt={OPT}\n#enddef\n[a]\n{M hi}\n[/a]\n[b]\n{M hi OPT=bye}\n[/b]\n';
    const r = preprocess(src, { dir: '/x', host: memHost({}) });
    const cfg = parseConfig(r.text);
    expect(cfg.child('a')!.getString('opt')).toBe('default-text');
    expect(cfg.child('b')!.getString('opt')).toBe('bye');
  });

  it('errors when a macro is called with the wrong number of arguments', () => {
    const src = '#define M A B\nx={A}{B}\n#enddef\n{M one}\n';
    expect(() => preprocess(src, { dir: '/x', host: memHost({}) })).toThrow();
  });

  it('handles #ifdef / #else / #endif, taking only the active branch', () => {
    const withDefine = (extra: Map<string, import('../../src/wml/preprocessor').MacroDefinition>) =>
      preprocess('#ifdef FOO\n[yes]\n[/yes]\n#else\n[no]\n[/no]\n#endif\n', {
        dir: '/x',
        host: memHost({}),
        defines: extra,
      });

    const definedMap = new Map();
    definedMap.set('FOO', { name: 'FOO', params: [], optionalParams: new Map(), body: '', dir: '/x', location: 'x' });
    const r1 = withDefine(definedMap);
    expect(parseConfig(r1.text).hasChild('yes')).toBe(true);
    expect(parseConfig(r1.text).hasChild('no')).toBe(false);

    const r2 = withDefine(new Map());
    expect(parseConfig(r2.text).hasChild('yes')).toBe(false);
    expect(parseConfig(r2.text).hasChild('no')).toBe(true);
  });

  it('does not expand macros/includes inside a false #ifdef branch (so a missing macro there is not an error)', () => {
    const src = '#ifdef NOPE\n{DOES_NOT_EXIST}\n#endif\n[ok]\n[/ok]\n';
    const r = preprocess(src, { dir: '/x', host: memHost({}) });
    expect(parseConfig(r.text).hasChild('ok')).toBe(true);
  });

  it('handles #undef', () => {
    const src = '#define M\nx=1\n#enddef\n#undef M\n#ifdef M\n[bad]\n[/bad]\n#else\n[good]\n[/good]\n#endif\n';
    const r = preprocess(src, { dir: '/x', host: memHost({}) });
    expect(parseConfig(r.text).hasChild('good')).toBe(true);
  });

  it('throws on #error', () => {
    expect(() => preprocess('#error "boom"\n', { dir: '/x', host: memHost({}) })).toThrow(/boom/);
  });

  it('resolves {file.cfg} includes relative to the current directory', () => {
    const host = memHost({
      '/x/main.cfg': '[a]\n{included.cfg}\n[/a]\n',
      '/x/included.cfg': 'x=1\n',
    });
    const r = preprocessFile('/x/main.cfg', { host });
    expect(parseConfig(r.text).child('a')!.get('x')).toBe(1);
  });

  it('resolves {dir/} includes by concatenating its .cfg files in sorted order', () => {
    const host = memHost({
      '/x/main.cfg': '{stuff/}\n',
      '/x/stuff/a.cfg': '[a]\n[/a]\n',
      '/x/stuff/b.cfg': '[b]\n[/b]\n',
    });
    const r = preprocessFile('/x/main.cfg', { host });
    const cfg = parseConfig(r.text);
    expect(cfg.hasChild('a')).toBe(true);
    expect(cfg.hasChild('b')).toBe(true);
  });

  it('falls back to dataRoot when a file is not found relative to the current directory', () => {
    const host = memHost({
      '/x/main.cfg': '{core/foo.cfg}\n',
      '/data/core/foo.cfg': '[a]\n[/a]\n',
    });
    const r = preprocessFile('/x/main.cfg', { host, dataRoot: '/data' });
    expect(parseConfig(r.text).hasChild('a')).toBe(true);
  });

  it('supports CURRENT_FILE, LEFT_BRACE and RIGHT_BRACE special symbols', () => {
    const host = memHost({ '/x/main.cfg': 'file={CURRENT_FILE}\nb={LEFT_BRACE}{RIGHT_BRACE}\n' });
    const r = preprocessFile('/x/main.cfg', { host });
    const cfg = parseConfig(r.text);
    expect(cfg.getString('file')).toBe('/x/main.cfg');
    expect(cfg.getString('b')).toBe('{}');
  });
});

describe('preprocess against real files on disk', () => {
  it('preprocesses a real temp file with an include', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wml-test-'));
    fs.writeFileSync(path.join(dir, 'inc.cfg'), 'y=2\n');
    fs.writeFileSync(path.join(dir, 'main.cfg'), '[a]\n{inc.cfg}\n[/a]\n');
    const cfg = parseWml(fs.readFileSync(path.join(dir, 'main.cfg'), 'utf8'), { filePath: path.join(dir, 'main.cfg') });
    expect(cfg.child('a')!.get('y')).toBe(2);
  });
});
