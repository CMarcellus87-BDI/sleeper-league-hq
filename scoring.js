// Scoring format detection.
//
// Most of the app is already format-correct by accident: anything derived from
// Sleeper's own `players_points` is scored by Sleeper in the league's settings,
// so realized points, lineup efficiency and the whole historical archive need
// no adjustment. The places that *do* need it are the external sources, which
// publish per-format numbers and have to be asked for the right one.
//
// Pure module.

export const FORMATS = {
  STD: { key: 'STD', label: 'Standard', short: 'Standard' },
  HALF: { key: 'HALF', label: 'Half PPR', short: '0.5 PPR' },
  PPR: { key: 'PPR', label: 'Full PPR', short: 'PPR' }
};

/**
 * Read the format out of a Sleeper league's scoring settings.
 *
 * `rec` is points per reception. Anything at or above 1 is full PPR, anything
 * above 0 is half, and absent or zero is standard. Values between 0 and 1 that
 * are not exactly 0.5 still round to half rather than being rejected, because
 * some leagues use 0.4 or 0.75 and half is the closest published variant.
 */
export function detectScoringFormat(scoringSettings = {}) {
  const rec = Number(scoringSettings?.rec);
  const perReception = Number.isFinite(rec) ? rec : 0;

  let key = 'STD';
  if (perReception >= 1) key = 'PPR';
  else if (perReception > 0) key = 'HALF';

  // TE premium is common in dynasty and is a real scoring difference, but no
  // external source publishes a TE-premium variant. Detect it so the UI can say
  // so rather than silently being slightly wrong.
  const teBonus = Number(scoringSettings?.bonus_rec_te) || 0;

  return {
    key,
    perReception,
    teBonus,
    exact: perReception === 0 || perReception === 0.5 || perReception === 1,
    ...FORMATS[key]
  };
}

/** A short human label for the header, e.g. "0.5 PPR · TE premium +0.5". */
export function describeScoring(format) {
  if (!format) return '';
  const parts = [format.short];
  if (!format.exact) parts[0] = `${format.perReception} per reception`;
  if (format.teBonus) parts.push(`TE premium +${format.teBonus}`);
  return parts.join(' · ');
}

/**
 * nflverse publishes standard points and PPR points, but not half.
 *
 * Half is exactly recoverable: PPR is standard plus one point per reception, so
 * half is standard plus half a reception each. Deriving it is better than
 * silently serving PPR numbers to a half-PPR league.
 */
export function nflversePoints(row = {}, formatKey = 'PPR') {
  const std = Number(row.pointsStd);
  const ppr = Number(row.pointsPpr);
  const receptions = Number(row.receptions);

  if (formatKey === 'PPR') return Number.isFinite(ppr) ? ppr : (Number.isFinite(std) ? std : null);
  if (formatKey === 'STD') return Number.isFinite(std) ? std : (Number.isFinite(ppr) && Number.isFinite(receptions) ? ppr - receptions : null);

  if (Number.isFinite(std) && Number.isFinite(receptions)) return std + receptions * 0.5;
  if (Number.isFinite(std) && Number.isFinite(ppr)) return (std + ppr) / 2;
  if (Number.isFinite(ppr) && Number.isFinite(receptions)) return ppr - receptions * 0.5;
  return Number.isFinite(ppr) ? ppr : (Number.isFinite(std) ? std : null);
}

/**
 * Whether an external source's format matches the league's closely enough to
 * present without a caveat. TE premium and unusual reception values never do.
 */
export function formatMatchesSource(format) {
  return Boolean(format?.exact) && !format?.teBonus;
}
