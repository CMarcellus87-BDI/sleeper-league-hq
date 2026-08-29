// Navigation structure and hash routing.
//
// Views are grouped by *when you would open the app*, not by what kind of data
// they hold. "I want to know where I stand" and "I want to dig through history"
// are different sessions, and grouping by that is what makes fourteen views
// findable instead of a scrolling list.
//
// Pure: no DOM. app.js renders from this and asks it to resolve routes.

export const NAV = [
  {
    key: 'now',
    label: 'Now',
    icon: '◈',
    items: [
      { view: 'overview', label: 'Overview' },
      { view: 'pulse', label: 'Power Rankings' },
      { view: 'odds', label: 'Playoff Odds' },
      { view: 'standings', label: 'Standings' }
    ]
  },
  {
    key: 'team',
    label: 'Team',
    icon: '★',
    items: [
      { view: 'assistant', label: 'Assistant' },
      { view: 'franchises', label: 'Franchises' }
    ]
  },
  {
    key: 'trades',
    label: 'Trades',
    icon: '⇄',
    items: [
      { view: 'trades', label: 'Archive' },
      { view: 'tradelab', label: 'Trade Lab' }
    ]
  },
  {
    key: 'history',
    label: 'History',
    icon: '♛',
    items: [
      { view: 'history', label: 'Champions' },
      { view: 'headtohead', label: 'Head to Head' },
      { view: 'records', label: 'Records' },
      { view: 'season', label: 'Season Explorer' }
    ]
  },
  {
    key: 'lab',
    label: 'Lab',
    icon: '🔬',
    items: [
      // Manager Lab panels are promoted to real destinations here rather than
      // hiding behind a second row of tabs inside one view.
      { view: 'lab', tab: 'efficiency', label: 'Efficiency & Luck' },
      { view: 'lab', tab: 'waivers', label: 'Waiver Returns' },
      { view: 'lab', tab: 'drafts', label: 'Draft Room' },
      { view: 'lab', tab: 'report', label: 'Report Card' },
      { view: 'players', label: 'Player Dossiers' }
    ]
  }
];

export const DEFAULT_ROUTE = { group: 'now', view: 'overview', tab: null };

/** Stable id for a destination, used in the hash and for active state. */
export function routeId(item) {
  return item?.tab ? `${item.view}:${item.tab}` : item?.view || '';
}

/** Every destination flattened, each carrying its group. */
export function allRoutes() {
  const routes = [];
  for (const group of NAV) {
    for (const item of group.items) {
      routes.push({ group: group.key, view: item.view, tab: item.tab || null, label: item.label, id: routeId(item) });
    }
  }
  return routes;
}

/**
 * Parse a location hash into a route.
 * Accepts `#group/view`, `#group/view:tab`, or a bare `#view` so older links
 * and internal jumps that only know a view name still resolve.
 */
export function parseRoute(hash = '') {
  const clean = String(hash).replace(/^#\/?/, '').trim();
  if (!clean) return null;
  const [first, second] = clean.split('/');
  if (second) {
    const [view, tab] = second.split(':');
    return { group: first, view, tab: tab || null };
  }
  const [view, tab] = first.split(':');
  return { group: null, view, tab: tab || null };
}

/**
 * Resolve a parsed route to a real destination, falling back to the default
 * rather than leaving the app on a blank screen. A view named without its group
 * resolves to the first group that contains it.
 */
export function resolveRoute(parsed) {
  if (!parsed?.view) return DEFAULT_ROUTE;
  const routes = allRoutes();

  if (parsed.group) {
    const exact = routes.find(r => r.group === parsed.group && r.view === parsed.view && r.tab === (parsed.tab || null));
    if (exact) return exact;
    const sameView = routes.find(r => r.group === parsed.group && r.view === parsed.view);
    if (sameView) return sameView;
  }

  const withTab = parsed.tab && routes.find(r => r.view === parsed.view && r.tab === parsed.tab);
  if (withTab) return withTab;

  const byView = routes.find(r => r.view === parsed.view);
  return byView || DEFAULT_ROUTE;
}

/** The hash string for a route, so links can be shared. */
export function routeHash(route) {
  if (!route?.view) return '#now/overview';
  const suffix = route.tab ? `${route.view}:${route.tab}` : route.view;
  return `#${route.group || groupForView(route.view)}/${suffix}`;
}

/** Which group owns a view. */
export function groupForView(view) {
  const found = allRoutes().find(r => r.view === view);
  return found ? found.group : DEFAULT_ROUTE.group;
}

/** Destinations belonging to one group, for the sub-navigation row. */
export function itemsForGroup(groupKey) {
  const group = NAV.find(g => g.key === groupKey);
  return group ? group.items.map(item => ({ ...item, id: routeId(item), group: groupKey })) : [];
}
