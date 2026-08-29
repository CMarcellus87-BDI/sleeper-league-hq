// Whole-app regression checks.
//
// The pure modules are unit tested. This file covers the seams between them and
// the DOM, which is where this app has actually broken: a renamed element id, a
// view with no section, an import that no longer exists, a stale hardcoded
// value. None of that shows up in a unit test, and all of it breaks the page.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { NAV, allRoutes } from '../routing.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const html = read('index.html');
const app = read('app.js');
const css = read('styles.css');

const MODULES = ['analytics', 'efficiency', 'fantasypros', 'simulation', 'insights', 'usage', 'pulse', 'routing', 'league', 'scoring'];

const htmlIds = () => new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

test('no merge conflict markers survived anywhere', () => {
  const files = ['index.html', 'app.js', 'styles.css', ...MODULES.map(m => `${m}.js`), 'worker/fantasypros-proxy.js'];
  for (const file of files) {
    const body = read(file);
    assert.ok(!/^<{7} |^={7}$|^>{7} /m.test(body), `${file} contains conflict markers`);
  }
});

test('every element the app looks up exists in the markup', () => {
  const ids = htmlIds();
  const used = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
  const missing = [...used].filter(id => !ids.has(id) && !/^[.#[]/.test(id));
  assert.deepEqual(missing, [], `app.js references ids that do not exist: ${missing.join(', ')}`);
});

test('no element id is declared twice', () => {
  const all = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const seen = new Set();
  const dupes = all.filter(id => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

test('every navigable view has a section to render into', () => {
  const ids = htmlIds();
  for (const route of allRoutes()) {
    assert.ok(ids.has(`${route.view}-view`), `${route.view} has no <section id="${route.view}-view">`);
  }
});

test('every view section is reachable from the navigation', () => {
  const sections = [...html.matchAll(/id="([a-z0-9-]+)-view"/g)].map(m => m[1]);
  const reachable = new Set(allRoutes().map(r => r.view));
  const orphans = sections.filter(view => !reachable.has(view));
  assert.deepEqual(orphans, [], `views with no way to reach them: ${orphans.join(', ')}`);
});

test('the navigation loader handles every view', () => {
  // navigate() dispatches on view name; a view with no branch renders empty.
  const needsLoader = ['trades', 'tradelab', 'assistant', 'lab', 'odds', 'pulse', 'players', 'leagues'];
  for (const view of needsLoader) {
    assert.ok(app.includes(`name==='${view}'`), `navigate() has no branch for ${view}`);
  }
});

test('every import resolves to a real export', () => {
  for (const name of MODULES) {
    const source = read(`${name}.js`);
    const exported = new Set([
      ...[...source.matchAll(/export function (\w+)/g)].map(m => m[1]),
      ...[...source.matchAll(/export const (\w+)/g)].map(m => m[1])
    ]);
    const block = app.match(new RegExp(`import \\{([^}]+)\\} from '\\./${name}\\.js`));
    if (!block) continue;
    // `import { a as b }` exports a and binds b locally.
    const imported = block[1].split(',').map(s => s.trim()).filter(Boolean)
      .map(entry => {
        const [source, alias] = entry.split(/\s+as\s+/).map(s => s.trim());
        return { source, local: alias || source };
      });
    for (const { source } of imported) {
      assert.ok(exported.has(source), `app.js imports ${source} from ${name}.js, which does not export it`);
    }
  }
});

test('no module imports something it never uses', () => {
  for (const name of MODULES) {
    const block = app.match(new RegExp(`import \\{([^}]+)\\} from '\\./${name}\\.js`));
    if (!block) continue;
    for (const entry of block[1].split(',').map(s => s.trim()).filter(Boolean)) {
      const [source, alias] = entry.split(/\s+as\s+/).map(s => s.trim());
      const local = alias || source;
      // An aliased import mentions the source name once in the import line and
      // the local name there too, so the threshold differs.
      const uses = [...app.matchAll(new RegExp(`\\b${local}\\b`, 'g'))].length;
      assert.ok(uses > 1, `${local} is imported from ${name}.js but never used`);
    }
  }
});

test('asset versions are consistent across markup and imports', () => {
  const cssVersion = html.match(/styles\.css\?v=([\d.]+)/)?.[1];
  const appVersion = html.match(/app\.js\?v=([\d.]+)/)?.[1];
  assert.equal(cssVersion, appVersion, 'stale cache buster: styles and app disagree');

  const importVersions = new Set([...app.matchAll(/\.js\?v=([\d.]+)'/g)].map(m => m[1]));
  assert.equal(importVersions.size, 1, `module imports use mixed versions: ${[...importVersions].join(', ')}`);
  assert.equal([...importVersions][0], appVersion, 'module imports disagree with the script tag');
});

test('the package version matches the shipped assets', () => {
  const pkg = JSON.parse(read('package.json'));
  const appVersion = html.match(/app\.js\?v=([\d.]+)/)?.[1];
  assert.equal(pkg.version, appVersion);
});

test('no league id is hardcoded into the markup', () => {
  // The live card used to print one league id forever, which multi-league broke.
  assert.ok(!/\b\d{16,20}\b/.test(html), 'index.html contains a hardcoded Sleeper id');
});

test('every test module is actually discovered by the test script', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.test, /tests\/\*\.test\.mjs/, 'test glob would miss files');
  const files = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.mjs'));
  assert.ok(files.length >= MODULES.length, `expected a test file per module, found ${files.length}`);
});

test('every class the app toggles exists in the stylesheet', () => {
  // A class name typo silently does nothing, which is the worst kind of bug.
  for (const cls of ['hidden', 'active-view', 'nav-item', 'subnav-item', 'view', 'inline-status']) {
    assert.ok(css.includes(`.${cls}`) || html.includes(`class="${cls}`), `.${cls} is used but never styled`);
  }
});

test('every league can be removed, including the one currently open', () => {
  // The forget button used to be suppressed on the active league, which left
  // the most likely mistake unfixable.
  assert.ok(!/current\?''/.test(app.match(/function leagueCardHtml[\s\S]*?\n}/)[0]),
    'leagueCardHtml suppresses a control for the current league');
  assert.ok(app.includes('data-forget-league'), 'no forget control rendered');
  assert.ok(app.includes('function forgetLeague'), 'forgetting is not implemented');
  assert.ok(app.includes('cacheDropLeague'), 'forgetting leaves cached league data behind');
});

test('the header selector is refreshed whenever the league list changes', () => {
  const render = app.match(/function renderLeagues\(\)[\s\S]*?\n}/)[0];
  assert.ok(render.includes('renderLeagueSwitcher'), 'the dropdown would keep showing removed leagues');
});

test('interactive controls carry accessible labels', () => {
  const selects = [...html.matchAll(/<select[^>]*>/g)].map(m => m[0]);
  for (const tag of selects) {
    assert.ok(/aria-label=|id="/.test(tag), `select without a label: ${tag}`);
  }
});

test('the navigation stays small enough to use on a phone', () => {
  assert.ok(NAV.length <= 5);
  for (const group of NAV) {
    assert.ok(group.items.length <= 6, `${group.key} has too many sub-items to scan`);
  }
});
