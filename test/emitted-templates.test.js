/**
 * No stray backtick inside an emitted template.
 *
 * `map-view.mjs` and `stats-board.mjs` export their markup, styles and script as
 * template literals, so a backtick anywhere inside one CLOSES IT. The rest of
 * the template then parses as code, and the error you get points at whatever
 * word happened to follow — "Unexpected identifier 'opacity'" for a backtick in
 * a CSS comment forty lines earlier.
 *
 * Importing the module does catch it, which is how it was found both times it
 * happened while the statistics board was being written: once in a comment
 * inside mapScript explaining a temporal dead zone, once in a comment inside
 * mapStyles explaining an opacity. What importing does NOT do is say what is
 * wrong. This does.
 *
 * CLAUDE.md states the rule; this enforces it and names the line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.dirname(url.fileURLToPath(import.meta.url));
const FILES = ['map-view.mjs', 'stats-board.mjs'];

/**
 * Every `export const NAME = [String.raw]` template in a file, as
 * { name, body, startLine }. Walks from each opening delimiter to the first
 * backtick after it — which is the closing one if, and only if, the template
 * is well formed.
 */
function templatesIn(src) {
  const out = [];
  const open = /export const (\w+) = (?:String\.raw)?`/g;
  let m;
  while ((m = open.exec(src)) !== null) {
    const from = open.lastIndex;
    const end = src.indexOf('`', from);
    assert.notEqual(end, -1, `${m[1]} is never closed`);
    out.push({
      name: m[1],
      body: src.slice(from, end),
      startLine: src.slice(0, from).split('\n').length,
      after: src.slice(end + 1, end + 2),
    });
    open.lastIndex = end + 1;
  }
  return out;
}

for (const file of FILES) {
  test(`${file}: every emitted template closes where it means to`, () => {
    const src = fs.readFileSync(path.join(root, '..', file), 'utf8');
    const tpls = templatesIn(src);
    assert.ok(tpls.length >= 3, `${file} should export markup, styles and script`);

    for (const t of tpls) {
      // A well-formed template is followed immediately by its semicolon. A stray
      // backtick inside closes it early and leaves something else there.
      assert.equal(t.after, ';',
        `${t.name} does not end at a semicolon — a backtick inside it closed it early. ` +
        `It opens at ${file}:${t.startLine}.`);

      // And say which line, since that is the whole point of this test.
      const lines = t.body.split('\n');
      const hit = lines.findIndex(l => l.includes('`'));
      assert.equal(hit, -1,
        `backtick inside ${t.name} at ${file}:${t.startLine + hit}: ${lines[hit]}`);
    }
  });
}

test('the templates are actually the ones the pages use', () => {
  // A guard that guards nothing is worse than none: if these exports are ever
  // renamed, the regex above finds nothing and every assertion passes vacuously.
  const src = fs.readFileSync(path.join(root, '..', 'map-view.mjs'), 'utf8');
  const names = templatesIn(src).map(t => t.name);
  for (const want of ['mapStyles', 'mapMarkup', 'mapScript']) {
    assert.ok(names.includes(want), `${want} is missing — has it been renamed?`);
  }
  const sb = fs.readFileSync(path.join(root, '..', 'stats-board.mjs'), 'utf8');
  const sbNames = templatesIn(sb).map(t => t.name);
  for (const want of ['statsMarkup', 'statsStyles', 'statsScript']) {
    assert.ok(sbNames.includes(want), `${want} is missing — has it been renamed?`);
  }
});
