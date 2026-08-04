import type { AdCreative } from '../entrypoints/content/adapters/types';
import { isServePoolExhausted, type AdServeHistory } from './ad-selection';

const KEYS = {
  deviceId: 'chatwait_device_id',
  adBundle: 'chatwait_ad_bundle',
  earnings: 'chatwait_earnings',
  enabled: 'chatwait_enabled',
  eventQueue: 'chatwait_event_queue',
  signedIn: 'chatwait_signed_in',
  profileComplete: 'chatwait_profile_complete',
  deviceToken: 'chatwait_device_token',
  installationHeartbeatAt: 'chatwait_installation_heartbeat_at',
  lastShownAd: 'chatwait_last_shown_ad',
  adServeHistory: 'chatwait_ad_serve_history',
  adBatchState: 'chatwait_ad_batch_state',
  adDedupState: 'chatwait_ad_dedup_state',
} as const;

/** How long a remembered last-shown ad stays reusable. Generous versus the 60s impression
 * pacing window it serves (see shared.ts), but a hard bound so a stale creative (or its
 * ad_token) can never be resurrected long after it was served. */
const LAST_SHOWN_AD_TTL_MS = 10 * 60 * 1000;
const MAX_AD_SERVE_HISTORY_ENTRIES = 500;
const INSTALLATION_HEARTBEAT_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** How long a qualified impression locks its ad out of local re-selection --
 * T-20260804-1411-response-gated-ad-exclusion. Deliberately a flat client-side constant
 * rather than something server-derived: matches `campaigns.freq_min_gap_minutes` for the
 * three freq-capped campaigns (083_campaign_frequency_cap.sql), which is the longest legitimate
 * re-serve gap in use, so this can never falsely block a repeat that the server would actually
 * allow. Needs to be bumped by hand if any campaign's configured gap ever exceeds it. */
const AD_EXCLUDE_TTL_MS = 30 * 60 * 1000;

type LastShownAdMap = Record<string, { ad: AdCreative; ts: number }>;
interface AdBatchState {
  generationId: string;
  consumedAdIds: string[];
  exhausted: boolean;
  /** Separate from `exhausted` above (which tracks the serve-history rotation) -- set once a
   * refresh has already been triggered because every ad in the pool was locked out by the
   * dedup state, so repeat GET_AD calls while still locked don't each kick off their own fetch. */
  dedupExhaustedRefreshTriggered: boolean;
}

/** An ad's local dedup lock. 'pending' = impression sent, server outcome not yet known;
 * 'excluded' = confirmed (or assumed, via self-heal) spent for the rest of the TTL window.
 * Both statuses block re-selection identically (see filterAvailableAds) -- the distinction
 * only matters for how resolveRecordedAds treats presence/absence in a flush response. */
interface AdDedupEntry {
  status: 'pending' | 'excluded';
  since: number;
}
type AdDedupState = Record<string, AdDedupEntry>;

export const storage = {
  async initDeviceId(): Promise<string> {
    const existing = await get<string>(KEYS.deviceId);
    if (existing) return existing;
    const id = crypto.randomUUID();
    await set(KEYS.deviceId, id);
    return id;
  },

  async getDeviceId(): Promise<string> {
    return (await get<string>(KEYS.deviceId)) ?? '';
  },

  async setAdBundle(bundle: AdCreative[]): Promise<void> {
    const state: AdBatchState = {
      generationId: crypto.randomUUID(),
      consumedAdIds: [],
      exhausted: false,
      dedupExhaustedRefreshTriggered: false,
    };
    // One storage write keeps the new bundle and its fresh consumption state in sync for
    // readers across every supported-site tab.
    await browser.storage.local.set({
      [KEYS.adBundle]: bundle,
      [KEYS.adBatchState]: state,
    });
  },

  async getAdBundle(): Promise<AdCreative[]> {
    return (await get<AdCreative[]>(KEYS.adBundle)) ?? HOUSE_AD_BUNDLE;
  },

  /** True once a real bundle has come back from `/ads-bundle` at least once — false means
   * `getAdBundle()` is still serving the local `HOUSE_AD_BUNDLE` fallback (no fetch yet, or
   * every attempt so far has failed), which is worth telling a tester apart from a real bundle. */
  async hasFetchedAdBundle(): Promise<boolean> {
    return (await get<AdCreative[]>(KEYS.adBundle)) !== null;
  },

  async getAdBatch(): Promise<{ bundle: AdCreative[]; state: AdBatchState | null }> {
    const result = await browser.storage.local.get([KEYS.adBundle, KEYS.adBatchState]);
    const storedBundle = (result[KEYS.adBundle] as AdCreative[] | undefined) ?? null;
    return {
      bundle: storedBundle ?? HOUSE_AD_BUNDLE,
      // A missing state means this is either the built-in fallback or a cache written by an
      // older extension version. Both remain serveable; the next successful refresh creates
      // a tracked generation.
      state: (result[KEYS.adBatchState] as AdBatchState | undefined) ?? null,
    };
  },

  /** Marks one ad used in the current fetched generation. Returns true exactly once, when
   * this serve consumes the final ad in the selectable pool and should trigger a refresh. */
  async markAdBatchConsumed(
    generationId: string | undefined,
    adId: string,
    selectableAds: AdCreative[],
  ): Promise<boolean> {
    if (!generationId) return false;
    const state = await get<AdBatchState>(KEYS.adBatchState);
    if (!state || state.generationId !== generationId) return false;

    const wasExhausted = state.exhausted;
    if (!state.consumedAdIds.includes(adId)) state.consumedAdIds.push(adId);
    state.exhausted = isServePoolExhausted(state.consumedAdIds, selectableAds);
    await set(KEYS.adBatchState, state);
    return !wasExhausted && state.exhausted;
  },

  /** Same one-shot-per-generation shape as markAdBatchConsumed above, for the other reason a
   * refresh might be worth triggering: every ad in the pool is currently dedup-locked (see
   * filterAvailableAds), independent of whether the serve-history rotation considers it
   * exhausted. Returns true only the first time this is observed for a given generation. */
  async markDedupExhaustionRefreshTriggered(generationId: string | undefined): Promise<boolean> {
    if (!generationId) return false;
    const state = await get<AdBatchState>(KEYS.adBatchState);
    if (!state || state.generationId !== generationId) return false;
    if (state.dedupExhaustedRefreshTriggered) return false;
    state.dedupExhaustedRefreshTriggered = true;
    await set(KEYS.adBatchState, state);
    return true;
  },

  /** Locks an ad out of local re-selection the instant its impression qualifies (before any
   * network activity) -- the zero-race guard in T-20260804-1411-response-gated-ad-exclusion.
   * Extension-global (browser.storage, not page localStorage) so it's visible to every tab
   * across every site, not just the one that qualified it. */
  async markAdPending(adId: string, now = Date.now()): Promise<void> {
    const state = pruneAdDedupState((await get<AdDedupState>(KEYS.adDedupState)) ?? {}, now);
    state[adId] = { status: 'pending', since: now };
    await set(KEYS.adDedupState, state);
  },

  /** Resolves the outcome of a flush: any ad_id present here got an impressions row written
   * server-side (billable or a recorded non-billable duplicate/cap/race -- see
   * events/index.ts), so it's locked out for the rest of the TTL window regardless of which.
   * ad_ids absent from a successful flush are left alone deliberately -- see markAdPending's
   * self-heal note in filterAvailableAds for why absence isn't treated as "safe to retry now". */
  async resolveRecordedAds(adIds: string[], now = Date.now()): Promise<void> {
    if (adIds.length === 0) return;
    const state = pruneAdDedupState((await get<AdDedupState>(KEYS.adDedupState)) ?? {}, now);
    for (const id of adIds) {
      if (state[id]?.status === 'pending') state[id] = { status: 'excluded', since: now };
    }
    await set(KEYS.adDedupState, state);
  },

  /** Filters out ads currently locked by the dedup state: still 'pending' (outcome unknown --
   * conservatively treated the same as excluded) or 'excluded' and within the TTL window.
   * Self-heals a pending entry whose flush response never correlated (event lost, or the
   * server rejected it for a reason unrelated to this ad) by expiring it at the same TTL as a
   * confirmed exclusion, rather than leaving it locked forever on an unknown outcome. House
   * ads are never filtered -- select_ad_bundle's house fallback has no dedup condition, and
   * repeating one is the intended filler behavior, not something worth a local lock. */
  async filterAvailableAds(ads: AdCreative[], now = Date.now()): Promise<AdCreative[]> {
    const state = (await get<AdDedupState>(KEYS.adDedupState)) ?? {};
    return ads.filter((ad) => {
      if (ad.is_house_ad) return true;
      const entry = state[ad.id];
      return !entry || now - entry.since > AD_EXCLUDE_TTL_MS;
    });
  },

  /** Last fetched server-side earnings total — cached for offline display, not accumulated locally. */
  async getLocalEarnings(): Promise<number> {
    return (await get<number>(KEYS.earnings)) ?? 0;
  },

  async setEarnings(total: number): Promise<void> {
    await set(KEYS.earnings, total);
  },

  async getEnabled(): Promise<boolean> {
    const v = await get<boolean>(KEYS.enabled);
    return v ?? true;
  },

  async setEnabled(value: boolean): Promise<void> {
    await set(KEYS.enabled, value);
  },

  async enqueueEvent(event: object): Promise<void> {
    const queue = (await get<object[]>(KEYS.eventQueue)) ?? [];
    queue.push(event);
    if (queue.length > 500) queue.splice(0, queue.length - 500); // cap
    await set(KEYS.eventQueue, queue);
  },

  async flushEventQueue(): Promise<object[]> {
    const queue = (await get<object[]>(KEYS.eventQueue)) ?? [];
    await set(KEYS.eventQueue, []);
    return queue;
  },

  async getSignedIn(): Promise<boolean> {
    return (await get<boolean>(KEYS.signedIn)) ?? false;
  },

  async setSignedIn(value: boolean): Promise<void> {
    await set(KEYS.signedIn, value);
  },

  async getProfileComplete(): Promise<boolean> {
    return (await get<boolean>(KEYS.profileComplete)) ?? false;
  },

  async setProfileComplete(value: boolean): Promise<void> {
    await set(KEYS.profileComplete, value);
  },

  /** Remembers the ad most recently served on a site so a prompt landing inside the
   * impression pacing window can re-show it instead of rotating to a fresh creative that
   * could not be tracked anyway (see onAnchorReady in entrypoints/content/shared.ts).
   * Lives in extension storage rather than page localStorage so ad tokens never sit in
   * site-readable storage, and so all tabs of a site agree on "the last ad shown here". */
  async setLastShownAd(site: string, ad: AdCreative): Promise<void> {
    const map = (await get<LastShownAdMap>(KEYS.lastShownAd)) ?? {};
    map[site] = { ad, ts: Date.now() };
    await set(KEYS.lastShownAd, map);
  },

  async getLastShownAd(site: string): Promise<AdCreative | null> {
    const entry = ((await get<LastShownAdMap>(KEYS.lastShownAd)) ?? {})[site];
    if (!entry || Date.now() - entry.ts > LAST_SHOWN_AD_TTL_MS) return null;
    return entry.ad;
  },

  /** Device-local selection history. This records cards served, not only qualified/billable
   * impressions, because visual repetition is what the rotation is meant to reduce. */
  async getAdServeHistory(): Promise<AdServeHistory> {
    return (await get<AdServeHistory>(KEYS.adServeHistory)) ?? {};
  },

  async recordAdServed(adId: string, servedAt = Date.now()): Promise<void> {
    const history = await storage.getAdServeHistory();
    const previous = history[adId];
    history[adId] = {
      lastServedAt: servedAt,
      serveCount: (previous?.serveCount ?? 0) + 1,
    };

    const ids = Object.keys(history);
    if (ids.length > MAX_AD_SERVE_HISTORY_ENTRIES) {
      ids
        .sort((a, b) => history[b].lastServedAt - history[a].lastServedAt)
        .slice(MAX_AD_SERVE_HISTORY_ENTRIES)
        .forEach((id) => delete history[id]);
    }
    await set(KEYS.adServeHistory, history);
  },

  /** Signed proof the device_id was linked via real Google sign-in; attached to every event. */
  async getDeviceToken(): Promise<string | null> {
    return get<string>(KEYS.deviceToken);
  },

  async setDeviceToken(token: string | undefined): Promise<void> {
    // A falsy token means device-status reported the device unlinked (mintDeviceToken only
    // runs while linked) — clear the old one instead of leaving a stale credential in storage.
    if (token) await set(KEYS.deviceToken, token);
    else await remove(KEYS.deviceToken);
  },

  /** Limits installation last-seen writes while still giving uninstall-rate analysis a
   * useful active/inactive signal. A missing value makes the first startup immediately due. */
  async isInstallationHeartbeatDue(now = Date.now()): Promise<boolean> {
    const last = await get<number>(KEYS.installationHeartbeatAt);
    return !last || now - last >= INSTALLATION_HEARTBEAT_INTERVAL_MS;
  },

  async markInstallationHeartbeat(now = Date.now()): Promise<void> {
    await set(KEYS.installationHeartbeatAt, now);
  },
};

async function get<T>(key: string): Promise<T | null> {
  const result = await browser.storage.local.get(key);
  return (result[key] as T) ?? null;
}

async function set(key: string, value: unknown): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

async function remove(key: string): Promise<void> {
  await browser.storage.local.remove(key);
}

/** Drops entries past the TTL on every write so chatwait_ad_dedup_state doesn't grow
 * unbounded across a long-running install -- unlike adBatchState this isn't reset on every
 * bundle refresh (it has to survive across refreshes to actually cover the 30-minute window). */
function pruneAdDedupState(state: AdDedupState, now: number): AdDedupState {
  const pruned: AdDedupState = {};
  for (const [id, entry] of Object.entries(state)) {
    if (now - entry.since <= AD_EXCLUDE_TTL_MS) pruned[id] = entry;
  }
  return pruned;
}

const HOUSE_AD_BUNDLE: AdCreative[] = [
  {
    id: 'house-1',
    text: 'Advertise on Chatwait - reach AI power users while they wait',
    url: 'https://chatwait.com/advertise',
    sponsor_name: 'Chatwait',
    is_house_ad: true,
  },
];
