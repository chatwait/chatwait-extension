import type { AdCreative } from '../entrypoints/content/adapters/types';

const KEYS = {
  deviceId: 'chatwait_device_id',
  adBundle: 'chatwait_ad_bundle',
  earnings: 'chatwait_earnings',
  enabled: 'chatwait_enabled',
  eventQueue: 'chatwait_event_queue',
  signedIn: 'chatwait_signed_in',
  profileComplete: 'chatwait_profile_complete',
  deviceToken: 'chatwait_device_token',
  lastShownAd: 'chatwait_last_shown_ad',
} as const;

/** How long a remembered last-shown ad stays reusable. Generous versus the 60s impression
 * pacing window it serves (see shared.ts), but a hard bound so a stale creative (or its
 * ad_token) can never be resurrected long after it was served. */
const LAST_SHOWN_AD_TTL_MS = 10 * 60 * 1000;

type LastShownAdMap = Record<string, { ad: AdCreative; ts: number }>;

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
    await set(KEYS.adBundle, bundle);
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

const HOUSE_AD_BUNDLE: AdCreative[] = [
  {
    id: 'house-1',
    text: 'Advertise on Chatwait - reach AI power users while they wait',
    url: 'https://chatwait.com/advertise',
    sponsor_name: 'Chatwait',
    is_house_ad: true,
  },
];
