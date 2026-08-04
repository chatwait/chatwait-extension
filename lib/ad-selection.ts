import type { AdCreative } from '../entrypoints/content/adapters/types';

export interface AdServeHistoryEntry {
  lastServedAt: number;
  serveCount: number;
}

export type AdServeHistory = Record<string, AdServeHistoryEntry>;

// Some campaigns can become eligible again well before this device would otherwise treat them
// as "seen forever". Without an expiry, a locally-served-once campaign could never win the fast
// "unseen" path again even once the backend is willing to offer it, permanently losing priority
// to any never-before-seen ad sharing the same bundle -- observed live 2026-08-04, where a
// lower-priority ad kept winning a slot ahead of a higher-priority one purely because of this
// stale local memory. 30 minutes keeps that window short enough that a re-offered campaign
// becomes reconsiderable again on a normal timescale, without the client needing to know
// anything about why or when the backend reconsiders an ad -- this is a display-variety
// heuristic, not a correctness or security boundary.
const AD_SERVE_HISTORY_TTL_MS = 30 * 60 * 1000;

/**
 * Chooses without replacement while a bundle still contains ads this device has not seen
 * recently (never served, or served more than AD_SERVE_HISTORY_TTL_MS ago). Once the
 * available inventory is exhausted, rotates back to the least-recently-served ad.
 *
 * `ads` arrives in the server's ranked order (highest bidder first), so position is the
 * priority signal and no separate rank field is sent. Rank decides within each equally
 * eligible group: the top-ranked unseen ad leads every fresh bundle, and rank breaks ties
 * between ads sharing the same last-served time. Rotation still comes first, so a
 * high-ranked ad is never repeated while a lower-ranked one sits unseen.
 */
export function chooseAdByServeHistory(
  ads: AdCreative[],
  history: AdServeHistory,
  now = Date.now(),
): AdCreative | null {
  if (ads.length === 0) return null;

  const isStale = (ad: AdCreative) => {
    const entry = history[ad.id];
    return entry === undefined || now - entry.lastServedAt >= AD_SERVE_HISTORY_TTL_MS;
  };

  const unseen = ads.filter(isStale);
  if (unseen.length > 0) return unseen[0];

  let leastRecentlyServed = ads[0];
  for (const ad of ads) {
    // Strict `<` keeps the earlier (higher-ranked) ad when last-served times are equal.
    const servedAt = history[ad.id]?.lastServedAt ?? -Infinity;
    const bestServedAt = history[leastRecentlyServed.id]?.lastServedAt ?? -Infinity;
    if (servedAt < bestServedAt) leastRecentlyServed = ad;
  }
  return leastRecentlyServed;
}

export function isServePoolExhausted(consumedAdIds: string[], ads: AdCreative[]): boolean {
  if (ads.length === 0) return false;
  const consumed = new Set(consumedAdIds);
  return ads.every((ad) => consumed.has(ad.id));
}
