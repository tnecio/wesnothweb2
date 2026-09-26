/**
 * Minimal gettext `.po`/`.pot` reader for the build scripts. Understands what
 * Wesnoth's catalogues use: `msgid`/`msgid_plural`/`msgstr`/`msgstr[n]`,
 * multi-line string continuations, `msgctxt`, `#, fuzzy`, and obsolete `#~`
 * entries (skipped). Returns `{ header, entries }` where each entry is
 * `{ msgctxt, msgid, msgidPlural, msgstr: string[], fuzzy }`.
 */
import * as fs from 'node:fs';

function unquote(s) {
  const body = s.slice(1, -1);
  return body.replace(/\\(n|t|r|"|\\)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' })[c]);
}

export function parsePo(text) {
  const entries = [];
  let cur = null;
  let field = null;
  let fuzzyPending = false;

  const flush = () => {
    if (cur && cur.msgid !== undefined) entries.push(cur);
    cur = null;
    field = null;
  };
  const start = () => {
    if (!cur) cur = { msgctxt: undefined, msgid: undefined, msgidPlural: undefined, msgstr: [], fuzzy: fuzzyPending };
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      flush();
      fuzzyPending = false;
      continue;
    }
    if (line.startsWith('#~')) continue;
    if (line.startsWith('#,')) {
      if (cur && cur.msgid !== undefined) {
        flush();
        fuzzyPending = false;
      }
      if (/\bfuzzy\b/.test(line)) fuzzyPending = true;
      continue;
    }
    if (line.startsWith('#')) {
      if (cur && cur.msgstr.length > 0) {
        flush();
        fuzzyPending = false;
      }
      continue;
    }
    let m;
    if ((m = /^msgctxt\s+(".*")$/.exec(line))) {
      if (cur && cur.msgstr.length > 0) flush();
      start();
      cur.msgctxt = unquote(m[1]);
      field = 'msgctxt';
    } else if ((m = /^msgid\s+(".*")$/.exec(line))) {
      if (cur && cur.msgstr.length > 0) flush();
      start();
      cur.msgid = unquote(m[1]);
      field = 'msgid';
    } else if ((m = /^msgid_plural\s+(".*")$/.exec(line))) {
      cur.msgidPlural = unquote(m[1]);
      field = 'msgid_plural';
    } else if ((m = /^msgstr(?:\[(\d+)\])?\s+(".*")$/.exec(line))) {
      const idx = m[1] === undefined ? 0 : Number(m[1]);
      cur.msgstr[idx] = unquote(m[2]);
      field = `msgstr${idx}`;
    } else if (line.startsWith('"') && cur) {
      const piece = unquote(line);
      if (field === 'msgctxt') cur.msgctxt += piece;
      else if (field === 'msgid') cur.msgid += piece;
      else if (field === 'msgid_plural') cur.msgidPlural += piece;
      else if (field?.startsWith('msgstr')) cur.msgstr[Number(field.slice(6))] += piece;
    }
  }
  flush();

  const headerEntry = entries.find((e) => e.msgid === '' && e.msgctxt === undefined);
  const header = {};
  if (headerEntry) {
    for (const l of (headerEntry.msgstr[0] ?? '').split('\n')) {
      const i = l.indexOf(':');
      if (i > 0) header[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
  }
  return { header, entries: entries.filter((e) => !(e.msgid === '' && e.msgctxt === undefined)) };
}

export function readPo(file) {
  return parsePo(fs.readFileSync(file, 'utf8'));
}
