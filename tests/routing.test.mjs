import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAV,
  DEFAULT_ROUTE,
  routeId,
  allRoutes,
  parseRoute,
  resolveRoute,
  routeHash,
  groupForView,
  itemsForGroup
} from '../routing.js';

test('the top level stays small enough for a phone', () => {
  assert.ok(NAV.length <= 5, `expected at most 5 groups, got ${NAV.length}`);
  assert.ok(NAV.every(g => g.items.length >= 2), 'a group with one item should not be a group');
});

test('every view in the app is reachable exactly once', () => {
  const ids = allRoutes().map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, 'no destination is listed twice');
  const views = new Set(allRoutes().map(r => r.view));
  for (const view of ['overview', 'standings', 'history', 'franchises', 'trades', 'tradelab',
    'assistant', 'headtohead', 'records', 'season', 'lab', 'odds', 'players', 'pulse']) {
    assert.ok(views.has(view), `${view} is not reachable from the navigation`);
  }
});

test('a tabbed destination gets its own id', () => {
  assert.equal(routeId({ view: 'lab', tab: 'waivers' }), 'lab:waivers');
  assert.equal(routeId({ view: 'players' }), 'players');
});

test('a full hash parses into group, view and tab', () => {
  assert.deepEqual(parseRoute('#lab/lab:waivers'), { group: 'lab', view: 'lab', tab: 'waivers' });
  assert.deepEqual(parseRoute('#now/odds'), { group: 'now', view: 'odds', tab: null });
});

test('a bare view name still parses, so old links keep working', () => {
  assert.deepEqual(parseRoute('#trades'), { group: null, view: 'trades', tab: null });
  assert.deepEqual(parseRoute('#lab:report'), { group: null, view: 'lab', tab: 'report' });
});

test('an empty or missing hash parses to nothing', () => {
  assert.equal(parseRoute(''), null);
  assert.equal(parseRoute('#'), null);
  assert.equal(parseRoute(), null);
});

test('a bare view resolves to the group that owns it', () => {
  const route = resolveRoute(parseRoute('#players'));
  assert.equal(route.group, 'lab');
  assert.equal(route.view, 'players');
});

test('a tabbed route resolves to the right panel', () => {
  const route = resolveRoute(parseRoute('#lab/lab:drafts'));
  assert.equal(route.tab, 'drafts');
  assert.equal(route.label, 'Draft Room');
});

test('nonsense falls back to the default rather than a blank screen', () => {
  assert.deepEqual(resolveRoute(parseRoute('#nope/nothing')), DEFAULT_ROUTE);
  assert.deepEqual(resolveRoute(null), DEFAULT_ROUTE);
  assert.deepEqual(resolveRoute({ view: '' }), DEFAULT_ROUTE);
});

test('a right view under the wrong group still resolves to the view', () => {
  const route = resolveRoute({ group: 'now', view: 'players', tab: null });
  assert.equal(route.view, 'players');
  assert.equal(route.group, 'lab', 'corrected to its real group');
});

test('a route round-trips through its hash', () => {
  for (const route of allRoutes()) {
    assert.deepEqual(
      resolveRoute(parseRoute(routeHash(route))),
      route,
      `${route.id} did not survive the round trip`
    );
  }
});

test('group lookup finds the owner of a view', () => {
  assert.equal(groupForView('tradelab'), 'trades');
  assert.equal(groupForView('pulse'), 'now');
  assert.equal(groupForView('does-not-exist'), DEFAULT_ROUTE.group);
});

test('sub-navigation lists a group in order', () => {
  const items = itemsForGroup('lab');
  assert.equal(items[0].label, 'Efficiency & Luck');
  assert.equal(items[items.length - 1].view, 'players');
  assert.ok(items.every(i => i.group === 'lab'));
  assert.deepEqual(itemsForGroup('nope'), []);
});

test('the default route points at a real destination', () => {
  const ids = allRoutes().map(r => r.id);
  assert.ok(ids.includes(DEFAULT_ROUTE.view));
});
