/**
 * Local configuration. Copy this file to `config.local.js` and edit it.
 *
 * `config.local.js` is gitignored and is NOT included in release archives, so
 * your settings survive upgrades and never reach the repository. If the file is
 * absent the app runs normally with expert rankings and projections disabled.
 */
export default {
  // Deployed FantasyPros proxy. Empty disables ECR and projections cleanly.
  proxyBase: '',

  // Override the league this build points at. Leave null to use the default in
  // app.js, which the ?league= URL parameter also overrides.
  primaryLeagueId: null
};
