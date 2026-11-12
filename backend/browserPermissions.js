const ROLE_LABELS = Object.freeze({
  administrator: 'Administrator',
  'event-coordinator': 'Event Coordinator',
  'judging-coordinator': 'Judging Coordinator',
  'tournament-operator': 'Tournament Operator',
  viewer: 'Viewer'
});
const EVENT = ['administrator', 'event-coordinator'];
const JUDGING = [...EVENT, 'judging-coordinator'];
const DAY = [...EVENT, 'tournament-operator'];
const AUDIENCE = [...DAY, 'viewer'];
const VIEW_ROLES = {
  'event-setup': EVENT, competitors: EVENT, import: EVENT, groups: EVENT, results: EVENT,
  'team-management': EVENT, 'team-settings': EVENT,
  'competition-types': EVENT, 'grand-champion-categories': EVENT, 'medal-points': EVENT,
  volunteers: JUDGING, 'volunteer-types': JUDGING, 'ring-judges': JUDGING, 'judge-assignments': JUDGING,
  'judge-management': ['administrator', 'judging-coordinator'],
  'judge-testing': ['administrator', 'judging-coordinator'],
  'judge-eligibility': ['administrator', 'judging-coordinator'],
  'judge-experience': ['administrator', 'judging-coordinator'],
  'judge-csv-settings': ['administrator', 'judging-coordinator'],
  'clinic-management': EVENT, 'tablet-pairing': DAY, 'division-qr': DAY, 'ring-assignment': DAY, 'head-table': DAY, 'audience-viewer': AUDIENCE,
  printing: EVENT, 'csv-settings': EVENT, 'event-history': EVENT,
  schools: ['administrator'], ranks: ['administrator'], 'visual-definitions': ['administrator'],
  users: ['administrator'], 'user-account-settings': ['administrator'],
  'server-maintenance': ['administrator'], simulator: ['administrator'], 'your-account': Object.keys(ROLE_LABELS)
};
function hasRole(roles, allowed) {
  return roles.some((role) => allowed.includes(role));
}
function allowedViews(roles) {
  return Object.keys(VIEW_ROLES).filter((view) => hasRole(roles, VIEW_ROLES[view]));
}
function homePath(roles) {
  if (roles.length === 1 && roles[0] === 'viewer') return '/audience-monitor/';
  const views = allowedViews(roles);
  const view = ['event-setup', 'ring-judges', 'ring-assignment', 'audience-viewer']
    .find((candidate) => views.includes(candidate));
  return view === 'audience-viewer' ? '/audience-monitor/' : `/tournament-management/?view=${view}`;
}
const segment = '[^/]+';
const rules = [];
function rule(methods, pattern, roles) { rules.push({ methods: methods.split(' '), pattern, roles }); }
rule('GET', /^\/api\/events\/(list|active|config)$/, JUDGING.concat('tournament-operator'));
rule('POST', /^\/api\/events\/(activate|import-csv|create|modify|delete|reset|reset-run)$/, EVENT);
rule('GET', /^\/api\/(competitors(?:\/table)?|tournament-results|results(?:\/group\/[^/]+|\/[^/]+)?)$/, EVENT);
rule('GET', /^\/search$/, EVENT);
rule('GET', /^\/api\/groups(?:\/[^/]+)?$/, DAY);
rule('POST', /^\/api\/divisions\/(build|save)$/, EVENT);
rule('POST', /^\/api\/divisions\/qr-codes$/, DAY);
rule('GET POST PUT DELETE', /^\/api\/teams(?:\/(?:settings|[^/]+))?$/, EVENT);
rule('GET', /^\/api\/visual-definitions$/, Object.keys(ROLE_LABELS));
rule('GET', /^\/api\/(schools|ranks)$/, Object.keys(ROLE_LABELS).filter((role) => role !== 'viewer'));
rule('POST PUT', /^\/api\/(visual-definitions|schools|ranks)(?:\/[^/]+)?$/, ['administrator']);
rule('GET POST PUT', /^\/api\/competition-settings\/[^/]+(?:\/[^/]+)?$/, EVENT);
rule('GET POST PUT', /^\/api\/(ring-judges|volunteers|volunteer-types)(?:\/[^/]+)?$/, JUDGING);
rule('GET PUT', /^\/api\/judge-assignments$/, JUDGING);
rule('POST', /^\/api\/judge-assignments\/auto$/, JUDGING);
rule('GET POST PUT', /^\/api\/judge-management(?:\/[^/]+(?:\/award)?|-settings|-import)?$/, ['administrator', 'judging-coordinator']);
rule('GET', /^\/api\/judge-management\/service-packets$/, ['administrator', 'judging-coordinator']);
rule('POST', /^\/api\/judge-management\/service-packets\/usb$/, ['administrator', 'judging-coordinator']);
rule('PUT', /^\/api\/judge-management\/service-packets\/[a-f0-9-]{36}\/replacement-reviews$/, ['administrator', 'judging-coordinator']);
rule('POST', /^\/api\/judge-management\/service-packets\/[a-f0-9-]{36}\/import$/, ['administrator', 'judging-coordinator']);
rule('PUT DELETE', /^\/api\/judge-management\/experience\/[1-9]\d*$/, ['administrator', 'judging-coordinator']);
rule('GET', /^\/api\/rings\/monitor$/, AUDIENCE);
rule('POST', /^\/api\/tablet\/codes$/, DAY);
rule('GET', /^\/(?:status|api\/rings(?:\/(?:config|estimates))?)$/, DAY);
rule('POST', /^\/api\/rings\/config$/, EVENT);
rule('POST', /^\/api\/rings\/schedule\/day2$/, DAY);
rule('POST DELETE', new RegExp(`^/api/rings/${segment}/(?:reset|queue(?:/${segment})?|assistance/clear)$`), DAY);
rule('GET', new RegExp(`^/api/rings/${segment}/(?:current|division-package|judge-plan)$`), DAY);
rule('POST', new RegExp(`^/api/rings/${segment}/(?:request-group|heartbeat|complete|service-packets|assistance)$`), DAY);
rule('POST', /^\/api\/reset$/, ['administrator']);
rule('GET', /^\/api\/simulator\/runs$/, AUDIENCE);
rule('GET', /^\/api\/simulator\/runs\/[^/]+\/audience$/, AUDIENCE);
rule('GET', /^\/api\/simulator\/runs\/[^/]+\/(head-table|ring-assignment)$/, DAY);
rule('GET', /^\/api\/simulator\/runs\/[^/]+\/results$/, EVENT);
rule('GET POST DELETE', /^\/api\/simulator\/runs(?:\/[^/]+(?:\/(?:log|step|start|pause|resume|speed|stop|run|reset|schedule\/day2))?)?$/, ['administrator']);
rule('GET POST', /^\/api\/server-control\/(status|restart)$/, ['administrator']);
rule('GET', /^\/(?:api\/version|download-app)$/, Object.keys(ROLE_LABELS).filter((role) => role !== 'viewer'));

function apiRoles(method, pathname) {
  const normalizedMethod = method === 'HEAD' ? 'GET' : method;
  const matches = rules.filter((entry) => entry.methods.includes(normalizedMethod) && entry.pattern.test(pathname));
  return matches.length ? [...new Set(matches.flatMap((entry) => entry.roles))] : null;
}
function isTabletEndpoint(method, pathname) {
  if (method === 'GET') return /^\/(?:api\/(?:health|version|events\/active|rings\/config)|download-app)$/.test(pathname) ||
    /^\/api\/rings\/[^/]+\/(?:current|division-package|judge-plan)$/.test(pathname);
  return method === 'POST' && /^\/api\/rings\/[^/]+\/(?:request-group|heartbeat|complete|service-packets|assistance(?:\/clear)?)$/.test(pathname);
}
function pageView(pathname) {
  const name = pathname.replace(/\/index\.html$/i, '').replace(/\/+$/, '').replace(/\.html$/i, '').toLowerCase();
  if (['', '/tournament-management'].includes(name)) return 'shell';
  if (['/audience-monitor'].includes(name)) return 'audience-viewer';
  if (['/head-table', '/dashboard', '/control-board', '/event-progress', '/administration-progress', '/ring-progress', '/ring-status', '/rings'].includes(name)) return 'head-table';
  if (name === '/ring-assignment') return 'ring-assignment';
  if (name === '/tablet-pairing') return 'tablet-pairing';
  if (name === '/division-qr') return 'division-qr';
  if (name === '/competitors') return 'competitors';
  if (name === '/head-table/search' || name === '/dashboard/search') return 'competitors';
  if (name === '/simulator') return 'simulator';
  if (name === '/admin') return 'server-maintenance';
  if (name === '/group-builder' || /^\/tournament-setup\/(?:build-groups|review-save)$/.test(name)) return 'groups';
  if (name === '/tournament-setup/import') return 'import';
  if (['/tournament-setup', '/tournament-mgmt', '/setup', '/event-administration', '/tournament-setup/event-definition'].includes(name)) return 'event-setup';
  return null;
}
module.exports = { ROLE_LABELS, VIEW_ROLES, hasRole, allowedViews, homePath, apiRoles, isTabletEndpoint, pageView };
