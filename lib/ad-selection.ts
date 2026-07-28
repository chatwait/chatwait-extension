import type { AdCreative } from '../entrypoints/content/adapters/types';

export interface AdServeHistoryEntry {
  lastServedAt: number;
  serveCount: number;
}

export type AdServeHistory = Record<string, AdServeHistoryEntry>;

/**
 * Chooses without replacement while a bundle still contains ads this device has not seen.
 * Once the available inventory is exhausted, rotates back to the least-recently-served ad.
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
): AdCreative | null {
  if (ads.length === 0) return null;

  const unseen = ads.filter((ad) => history[ad.id] === undefined);
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
