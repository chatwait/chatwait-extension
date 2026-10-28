import { storage } from '../lib/storage';
import { ApiStatusError, fetchAdBundle, fetchDeviceLinked } from '../lib/api';
import { flushQueue, startEventFlusher } from '../lib/schedule';
import { log } from '../lib/log';
import { chooseAdByServeHistory } from '../lib/ad-selection';

// The ad bundle is fetched on demand, not on a timer (T-20261027-2053-quiet-client-0.1.10):
// most signed-in browsers never prompt in a given hour, so timer and worker-wake fetches were
// ~95% of ads-bundle calls. A chat-site page load prefetches when the cache is older than
// AD_BUNDLE_MAX_AGE_MS, and GET_AD refreshes first (waiting at most AD_BUNDLE_REFRESH_WAIT_MS)
// when it still is, so an ad is never served from a bundle staler than it was under the old
// 15-min poll. Ad tokens expire 24h after minting, so a bundle older than
// AD_BUNDLE_EXPIRED_MS (a refresh kept failing) is never served at all.
const AD_BUNDLE_MAX_AGE_MS = 15 * 60 * 1000;
const AD_BUNDLE_REFRESH_WAIT_MS = 2000;
const AD_BUNDLE_EXPIRED_MS = 23 * 60 * 60 * 1000;
// Adaptive sign-in poll. The sign-in moment itself is caught instantly by the tabs.onUpdated
// listener below (any tab landing on chatwait.com/dashboard or /onboarding), the popup's
// CHECK_SIGNIN, a prompt on a chat site while signed out, and an ads-bundle 401 (see
// refreshAdBundle), so the timer is only a fallback. Signed out: 15 min, doubling per
// consecutive signed-out result up to 2h (most signed-out installs never sign in). Signed in:
// every 4h, well inside the 24h device-token TTL; an unlink or flag is caught live by
// ads-bundle (401 / flagged ad) and events, and an onboarding completion by the tab listener.
const SIGNIN_CHECK_SIGNED_OUT_MS = 15 * 60 * 1000;
const SIGNIN_CHECK_SIGNED_OUT_MAX_MS = 2 * 60 * 60 * 1000;
const SIGNIN_CHECK_SIGNED_IN_MS = 4 * 60 * 60 * 1000;
// Floor between the event-driven checks (chatwait.com page loads, signed-out prompts).
const SIGNIN_EVENT_CHECK_MIN_MS = 60 * 1000;
const SIGNIN_URL = 'https://chatwait.com/signin';
const UNINSTALL_URL = 'https://api.chatwait.com/functions/v1/uninstall';

const ONBOARDING_AD = {
  id: 'onboarding',
  text: 'Add your details for higher-paying ads',
  url: 'https://chatwait.com/onboarding',
  sponsor_name: 'Chatwait',
  kind: 'onboarding' as const,
};

// A chatwait.com tab landing on /dashboard or /onboarding is the "linked now" signal: that
// redirect only happens after `/auth/callback` has already awaited the device_ids upsert, and
// onboarding completion lands on /dashboard too. Matched on any tab rather than only tabs this
// worker opened: MV3 kills the worker after ~30s idle, usually mid Google sign-in, which wiped
// the old in-memory tab-id set. The chatwait.com host permission makes the URL visible.
const SIGNED_IN_LANDING_RE = /^https:\/\/chatwait\.com\/(dashboard|onboarding)(\/|\?|#|$)/;
let adSelectionQueue: Promise<void> = Promise.resolve();
let adBundleRefreshInFlight: Promise<void> | null = null;

export default defineBackground(() => {
  log.info('build', browser.runtime.getManifest().version_name);

  // Registered before any `await` below: onInstalled/onMessage fire as soon as the
  // service worker starts, and Chrome only delivers them to listeners attached
  // synchronously during the worker's initial script evaluation. main() itself must
  // stay synchronous (WXT logs an error otherwise), so the async init is a detached call.
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      // initDeviceId (not getDeviceId): on a fresh install nothing has generated
      // an ID yet, and that only happens later in the init flow below.
      storage.initDeviceId().then((id) => {
        browser.tabs.create({ url: `${SIGNIN_URL}?device_id=${id}` });
      });
    }
  });

  browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (!changeInfo.url || !SIGNED_IN_LANDING_RE.test(changeInfo.url)) return;
    // Unthrottled while signed out: a popup check moments before a quick Google sign-in must
    // not swallow the transition. Signed in, this only refreshes profile_complete.
    storage.getSignedIn().then((signedIn) => {
      if (signedIn) refreshSignInStatusThrottled();
      else refreshSignInStatus();
    });
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_AD') {
      // `reason` rides along with a null ad so the content script can log the specific cause
      // directly in the host page's own DevTools console, instead of a tester needing to dig
      // up the background service worker's console (which MV3 aggressively suspends, so it's
      // often already gone by the time someone opens it after the fact).
      // Serialize selection across tabs. Without this, two simultaneous GET_AD requests can
      // both read the same history and choose the same unseen ad before either write lands.
      enqueueAdSelection(resolveAdRequest)
        .then(sendResponse)
        .catch((err) => {
          log.warn('GET_AD: selection failed', err);
          sendResponse({ ad: null, reason: 'no_bundle' });
        });
      return true;
    }
    if (message.type === 'REFRESH_ADS') {
      // Sent by the content script on every chat-site page load: a prefetch so the next
      // GET_AD rarely has to wait, skipped while the cached bundle is still fresh.
      refreshAdBundleIfStale().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === 'RECORD_EVENT') {
      // Mock test harness (mock.content.ts, entrypoints/mock/index.html) runs the real
      // adapters against a local page to avoid prompting live chatgpt.com/claude.ai/
      // gemini.google.com — but events must never reach the real backend from there, since
      // that would write fake impressions/earnings against whatever device_id + linked
      // account the developer's browser profile happens to have.
      if (_sender.tab?.url?.startsWith('http://localhost:5199/')) {
        sendResponse({ ok: true, mock: true });
        return true;
      }
      // Locks the ad out of local re-selection immediately, before any network activity --
      // the zero-race guard from T-20260804-1411-response-gated-ad-exclusion. Must happen
      // before enqueue/flush, not after, so a concurrent GET_AD from any tab (any site) can
      // never re-select this same ad while its outcome is still in flight.
      const payload = message.payload as { type?: string; ad_id?: string } | undefined;
      const markPending =
        payload?.type === 'impression' && typeof payload.ad_id === 'string'
          ? storage.markAdPending(payload.ad_id)
          : Promise.resolve();
      markPending
        .then(() => Promise.all([storage.getDeviceId(), storage.getDeviceToken()]))
        .then(([deviceId, deviceToken]) =>
          storage.enqueueEvent({
            ...message.payload,
            device_id: deviceId,
            device_token: deviceToken,
            extension_version: browser.runtime.getManifest().version_name ?? '',
          }),
        )
        .then(() => flushQueue())
        .then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === 'CHECK_SIGNIN') {
      refreshSignInStatus().then((signedIn) => sendResponse({ signedIn }));
      return true;
    }
    if (message.type === 'OPEN_SIGNIN') {
      storage.getDeviceId().then((id) => {
        browser.tabs.create({ url: `${SIGNIN_URL}?device_id=${id}` });
        sendResponse({ ok: true });
      });
      return true;
    }
  });

  init();
});

function enqueueAdSelection<T>(select: () => Promise<T>): Promise<T> {
  const result = adSelectionQueue.then(select, select);
  adSelectionQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function resolveAdRequest() {
  // If another tab, a page-load prefetch, or batch exhaustion already started a refresh,
  // wait for that single shared request before selecting. On failure refreshAdBundle keeps
  // the old cache, so this naturally falls back to the exhausted bundle rather than hiding
  // the ad or retry-looping.
  if (adBundleRefreshInFlight) await adBundleRefreshInFlight;

  if (!(await storage.getSignedIn())) {
    // The user is prompting right now, so this is the moment a sign-in done elsewhere is worth
    // noticing; the next prompt then gets an ad instead of waiting out the backed-off poll.
    refreshSignInStatusThrottled();
    log.info('GET_AD: no ad, device is not signed in');
    return { ad: null, reason: 'not_signed_in' };
  }

  // No timer keeps the bundle warm, so refresh it here when stale. Bounded: past the wait the
  // ad comes from the cache (the refresh keeps running and the next GET_AD awaits it above).
  if ((await storage.msSinceAdBundleFetch()) >= AD_BUNDLE_MAX_AGE_MS) {
    await Promise.race([
      refreshAdBundle(),
      new Promise((resolve) => setTimeout(resolve, AD_BUNDLE_REFRESH_WAIT_MS)),
    ]);
    // A 401 during that refresh re-checks sign-in; if the device turned out to be unlinked,
    // stop here rather than serve an ad that could no longer bill.
    if (!(await storage.getSignedIn())) {
      log.info('GET_AD: no ad, device was unlinked');
      return { ad: null, reason: 'not_signed_in' };
    }
  }

  const [batch, profileComplete, history, bundleAge] = await Promise.all([
    storage.getAdBatch(),
    storage.getProfileComplete(),
    storage.getAdServeHistory(),
    storage.msSinceAdBundleFetch(),
  ]);
  const { state } = batch;
  let { bundle } = batch;
  if (bundleAge >= AD_BUNDLE_EXPIRED_MS && (await storage.hasFetchedAdBundle())) {
    // Every ad_token in it is (nearly) past its 24h TTL, so impressions on these ads could
    // never bill. Keep only house ads, which carry no token.
    log.warn('GET_AD: cached ad bundle is too old to bill and could not be refreshed');
    bundle = bundle.filter((ad) => ad.is_house_ad);
  }

  // Paid campaigns retain priority over house inventory. Within that pool, exhaust unseen
  // campaigns before rotating to the least-recently-served one, taking them in the server's
  // ranked bundle order (highest bidder first) rather than at random.
  const nonHouse = bundle.filter((ad) => !ad.is_house_ad);
  const rawPool = nonHouse.length > 0 ? nonHouse : bundle;
  // Excludes ads currently locked by the dedup state (pending an event outcome, or already
  // confirmed spent) -- see T-20260804-1411-response-gated-ad-exclusion. This is what
  // actually prevents re-tracking a duplicate; markAdBatchConsumed's exhaustion signal below
  // is unchanged and still just a serve-history rotation hint.
  const pool = await storage.filterAvailableAds(rawPool);
  let selected = chooseAdByServeHistory(pool, history);
  let dedupLocked = false;

  if (!selected && rawPool.length > 0) {
    // Every ad in the fetched bundle is currently dedup-locked -- fall back to the house ad
    // (from the full bundle, not the filtered pool, since filterAvailableAds never excludes
    // house ads) rather than either repeating a guaranteed-duplicate ad or showing nothing.
    dedupLocked = true;
    selected = bundle.find((ad) => ad.is_house_ad) ?? null;
  }

  if (!selected) {
    log.warn('GET_AD: cached ad bundle is empty (never fetched, or last fetch failed)');
  }
  if (!profileComplete && (!selected || selected.is_house_ad)) {
    log.info('GET_AD: showing onboarding ad (profile incomplete)');
    return { ad: ONBOARDING_AD, reason: 'onboarding' };
  }
  if (selected) {
    await storage.recordAdServed(selected.id);
    const shouldRefresh = dedupLocked
      ? await storage.markDedupExhaustionRefreshTriggered(state?.generationId)
      : await storage.markAdBatchConsumed(state?.generationId, selected.id, rawPool);
    log.info(`GET_AD: serving cached ad ${selected.id}`);
    if (shouldRefresh) {
      log.info(
        `GET_AD: refreshing bundle (${dedupLocked ? 'dedup-locked' : `all ${rawPool.length} selectable cached ad(s) used`})`,
      );
      // Do not hold the final ad back while the network request runs. A subsequent GET_AD
      // waits on this guarded promise above; failures leave the old bundle safely reusable.
      void refreshAdBundle();
    }
  } else {
    log.info('GET_AD: no ad to serve');
  }
  return { ad: selected, reason: selected ? 'ok' : 'no_bundle' };
}

async function init() {
  await storage.initDeviceId();
  // MV3 kills the worker after ~30s idle and any registered event (including tabs.onUpdated,
  // which fires for every tab in the browser) wakes it and re-runs init(). So on wake, only
  // hit the backend when the last successful check is older than its normal interval;
  // otherwise just re-arm the timer for the remainder. The ad bundle is not fetched here at
  // all (see AD_BUNDLE_MAX_AGE_MS); the sign-in transition still fetches one immediately.
  const signedIn = await storage.getSignedIn();
  const signInInterval = await signInCheckIntervalMs(signedIn);
  const sinceSignInCheck = await storage.msSinceSignInCheck();
  if (sinceSignInCheck >= signInInterval) await refreshSignInStatus();
  else scheduleNextSignInCheck(signInInterval - sinceSignInCheck);
  startEventFlusher();
}

// One pending sign-in check at a time; every refreshSignInStatus() call reschedules it from
// scratch at the cadence matching the freshly observed state, so out-of-band refreshes (the
// chatwait.com tab listener, CHECK_SIGNIN from the popup, an ads-bundle 401) also reset the clock.
let signInCheckTimer: ReturnType<typeof setTimeout> | null = null;

async function signInCheckIntervalMs(signedIn: boolean): Promise<number> {
  if (signedIn) return SIGNIN_CHECK_SIGNED_IN_MS;
  const streak = await storage.getSignedOutCheckStreak();
  return Math.min(
    SIGNIN_CHECK_SIGNED_OUT_MS * 2 ** Math.max(0, streak - 1),
    SIGNIN_CHECK_SIGNED_OUT_MAX_MS,
  );
}

function scheduleNextSignInCheck(delayMs: number) {
  if (signInCheckTimer) clearTimeout(signInCheckTimer);
  signInCheckTimer = setTimeout(refreshSignInStatus, delayMs);
}

/** For the event-driven checks, which can fire repeatedly (every chatwait.com navigation,
 * every signed-out prompt): skip when a check succeeded within SIGNIN_EVENT_CHECK_MIN_MS. */
async function refreshSignInStatusThrottled(): Promise<void> {
  if ((await storage.msSinceSignInCheck()) < SIGNIN_EVENT_CHECK_MIN_MS) return;
  await refreshSignInStatus();
}

function refreshAdBundleIfStale(): Promise<void> {
  return storage.msSinceAdBundleFetch().then((age) => {
    if (age >= AD_BUNDLE_MAX_AGE_MS) return refreshAdBundle();
  });
}

function refreshAdBundle(allowAuthRetry = true): Promise<void> {
  if (adBundleRefreshInFlight) return adBundleRefreshInFlight;

  const refresh = refreshAdBundleOnce(allowAuthRetry).finally(() => {
    if (adBundleRefreshInFlight === refresh) adBundleRefreshInFlight = null;
  });
  adBundleRefreshInFlight = refresh;
  return refresh;
}

async function refreshAdBundleOnce(allowAuthRetry = true) {
  try {
    const [deviceId, deviceToken] = await Promise.all([storage.getDeviceId(), storage.getDeviceToken()]);
    if (!deviceId || !deviceToken) {
      // ads-bundle requires device auth now; before sign-in a fetch is a guaranteed 401.
      // GET_AD won't serve ads to a signed-out device anyway, and the sign-in transition
      // in refreshSignInStatus triggers an immediate refresh once the token arrives.
      log.info('ad bundle refresh skipped: no device token yet (not signed in)');
      return;
    }
    const bundle = await fetchAdBundle(deviceId, deviceToken);
    await storage.setAdBundle(bundle);
    log.info(`ad bundle refreshed: ${bundle.length} ad(s)`);
  } catch (err) {
    // 401 means the stored device token no longer satisfies the backend (device unlinked, or
    // the token somehow outlived its TTL): re-check sign-in immediately rather than waiting
    // out the poll, and retry the bundle once if the device turns out to still be linked.
    // Single retry only — if the device is genuinely unlinked, refreshSignInStatus comes back
    // false and GET_AD stops serving ads.
    if (allowAuthRetry && err instanceof ApiStatusError && err.status === 401) {
      log.warn('ad bundle fetch unauthorized (401): re-checking sign-in status now');
      const linked = await refreshSignInStatus();
      if (linked) await refreshAdBundleOnce(false);
      return;
    }
    // keep serving cached bundle on network error
    log.warn('ad bundle refresh failed, serving cached bundle', err);
  }
}

async function refreshSignInStatus(): Promise<boolean> {
  const signedIn = await checkSignInStatus();
  scheduleNextSignInCheck(await signInCheckIntervalMs(signedIn));
  return signedIn;
}

async function checkSignInStatus(): Promise<boolean> {
  // Re-read the device id fresh on every call instead of trusting a value closed over once
  // at service-worker startup: MV3 workers can briefly double-run during wake/reload
  // transitions, and a stale closure from an earlier (e.g. pre-signin, now-superseded)
  // device id would otherwise keep overwriting a correct later status with a stale one.
  const deviceId = await storage.getDeviceId();
  if (!deviceId) return false;
  try {
    const heartbeatDue = await storage.isInstallationHeartbeatDue();
    const {
      linked,
      profileComplete,
      deviceToken,
      uninstallToken,
      installationTracked,
    } = await fetchDeviceLinked(deviceId, heartbeatDue);
    // The device id may have changed again while this request was in flight; don't let a
    // slow response for an old id stomp a newer, more current status.
    if ((await storage.getDeviceId()) !== deviceId) return storage.getSignedIn();
    const hadToken = !!(await storage.getDeviceToken());
    // Token before the signed-in flag: the popup gates its earnings fetch on seeing both, so
    // a reader must never observe signedIn=true while the freshly minted token isn't stored
    // yet. (On unlink the same order clears the token first, which fails safe: signedIn=true
    // with no token just skips the fetch until the flag flips.)
    await storage.setDeviceToken(deviceToken);
    await storage.setSignedIn(linked);
    await storage.setProfileComplete(profileComplete);
    await storage.markSignInChecked();
    await storage.setSignedOutCheckStreak(
      linked ? 0 : (await storage.getSignedOutCheckStreak()) + 1,
    );
    if (uninstallToken) {
      // setUninstallURL needs no manifest permission. The endpoint records first and then
      // redirects to the optional survey, so closing that tab cannot lose the event.
      try {
        await browser.runtime.setUninstallURL(
          `${UNINSTALL_URL}?token=${encodeURIComponent(uninstallToken)}`,
        );
      } catch (err) {
        // Analytics must never make sign-in or ad serving fail on an unsupported browser.
        log.warn('could not set uninstall URL', err);
      }
    }
    if (heartbeatDue && installationTracked) await storage.markInstallationHeartbeat();
    if (!hadToken && deviceToken) {
      // First time this device gets its token (just signed in): the cached bundle was fetched
      // unauthenticated and its ads carry no ad_tokens, so impressions from it can't bill.
      // Refetch now instead of waiting for the next GET_AD to find it stale.
      await refreshAdBundle();
    }
    log.info(`sign-in status refreshed: signedIn=${linked} profileComplete=${profileComplete}`);
    return linked;
  } catch (err) {
    // network error — keep last known status rather than locking the user out
    log.warn('sign-in status refresh failed, keeping last known status', err);
    return storage.getSignedIn();
  }
}
