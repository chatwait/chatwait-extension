import { storage } from '../lib/storage';
import { ApiStatusError, fetchAdBundle, fetchDeviceLinked } from '../lib/api';
import { flushQueue, startEventFlusher } from '../lib/schedule';
import { log } from '../lib/log';

const AD_BUNDLE_INTERVAL_MS = 15 * 60 * 1000;
// Adaptive sign-in poll: a signed-out device is actively waiting for its sign-in to land,
// so it checks every minute; a signed-in one only needs to re-mint the 24h device token and
// pick up unlink/profile changes, so every 30 min is plenty (the sign-in moment itself is
// caught instantly by the tabs.onUpdated listener below, every MV3 worker wake re-polls via
// init(), and an ads-bundle 401 forces an immediate re-check — see refreshAdBundle).
const SIGNIN_CHECK_SIGNED_OUT_MS = 60 * 1000;
const SIGNIN_CHECK_SIGNED_IN_MS = 30 * 60 * 1000;
const SIGNIN_URL = 'https://chatwait.com/signin';

const ONBOARDING_AD = {
  id: 'onboarding',
  text: 'Add your details for higher-paying ads',
  url: 'https://chatwait.com/onboarding',
  sponsor_name: 'Chatwait',
  kind: 'onboarding' as const,
};

// Tab ids for open sign-in tabs, so tabs.onUpdated (below) can push an immediate
// sign-in refresh the moment one of them lands on /dashboard or /onboarding —
// that redirect only happens after `/auth/callback` has already awaited the
// device_ids upsert, so it's a reliable "linked now" signal instead of waiting
// out the 60s poll.
const signinTabIds = new Set<number>();

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
        browser.tabs.create({ url: `${SIGNIN_URL}?device_id=${id}` }).then((tab) => {
          if (tab.id !== undefined) signinTabIds.add(tab.id);
        });
      });
    }
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!signinTabIds.has(tabId) || !changeInfo.url) return;
    if (/^https:\/\/chatwait\.com\/(dashboard|onboarding)(\/|\?|$)/.test(changeInfo.url)) {
      signinTabIds.delete(tabId);
      refreshSignInStatus();
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    signinTabIds.delete(tabId);
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_AD') {
      // `reason` rides along with a null ad so the content script can log the specific cause
      // directly in the host page's own DevTools console, instead of a tester needing to dig
      // up the background service worker's console (which MV3 aggressively suspends, so it's
      // often already gone by the time someone opens it after the fact).
      storage.getSignedIn().then((signedIn) => {
        if (!signedIn) {
          log.info('GET_AD: no ad, device is not signed in');
          return sendResponse({ ad: null, reason: 'not_signed_in' });
        }
        Promise.all([storage.getAdBundle(), storage.getProfileComplete()]).then(([bundle, profileComplete]) => {
          // Pick randomly among the non-house ads (paid campaigns) so repeat viewers don't
          // always see the single highest bidder; only fall back to the house ad pool when
          // no paid campaign is in the bundle at all.
          const nonHouse = bundle.filter((ad) => !ad.is_house_ad);
          const pool = nonHouse.length > 0 ? nonHouse : bundle;
          const top = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
          if (!top) {
            log.warn('GET_AD: cached ad bundle is empty (never fetched, or last fetch failed)');
          }
          if (!profileComplete && (!top || top.is_house_ad)) {
            log.info('GET_AD: showing onboarding ad (profile incomplete)');
            return sendResponse({ ad: ONBOARDING_AD, reason: 'onboarding' });
          }
          log.info(top ? `GET_AD: serving cached ad ${top.id}` : 'GET_AD: no ad to serve');
          sendResponse({ ad: top, reason: top ? 'ok' : 'no_bundle' });
        });
      });
      return true;
    }
    if (message.type === 'REFRESH_ADS') {
      refreshAdBundle().then(() => sendResponse({ ok: true }));
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
      Promise.all([storage.getDeviceId(), storage.getDeviceToken()])
        .then(([deviceId, deviceToken]) =>
          storage.enqueueEvent({ ...message.payload, device_id: deviceId, device_token: deviceToken }),
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
        browser.tabs.create({ url: `${SIGNIN_URL}?device_id=${id}` }).then((tab) => {
          if (tab.id !== undefined) signinTabIds.add(tab.id);
        });
        sendResponse({ ok: true });
      });
      return true;
    }
  });

  init();
});

async function init() {
  await storage.initDeviceId();
  // Sign-in status first: it stores the device_token that lets refreshAdBundle fetch an
  // authenticated bundle (ads carrying the ad_tokens the events endpoint requires) instead
  // of a tokenless one that couldn't bill impressions until the next 15-min refresh.
  await refreshSignInStatus();
  await refreshAdBundle();
  startEventFlusher();

  setInterval(refreshAdBundle, AD_BUNDLE_INTERVAL_MS);
}

// One pending sign-in check at a time; every refreshSignInStatus() call reschedules it from
// scratch at the cadence matching the freshly observed state, so out-of-band refreshes (the
// sign-in tab listener, CHECK_SIGNIN from the popup, an ads-bundle 401) also reset the clock.
let signInCheckTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNextSignInCheck(signedIn: boolean) {
  if (signInCheckTimer) clearTimeout(signInCheckTimer);
  signInCheckTimer = setTimeout(
    refreshSignInStatus,
    signedIn ? SIGNIN_CHECK_SIGNED_IN_MS : SIGNIN_CHECK_SIGNED_OUT_MS,
  );
}

async function refreshAdBundle(allowAuthRetry = true) {
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
      if (linked) await refreshAdBundle(false);
      return;
    }
    // keep serving cached bundle on network error
    log.warn('ad bundle refresh failed, serving cached bundle', err);
  }
}

async function refreshSignInStatus(): Promise<boolean> {
  const signedIn = await checkSignInStatus();
  scheduleNextSignInCheck(signedIn);
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
    const { linked, profileComplete, deviceToken } = await fetchDeviceLinked(deviceId);
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
    if (!hadToken && deviceToken) {
      // First time this device gets its token (just signed in): the cached bundle was fetched
      // unauthenticated and its ads carry no ad_tokens, so impressions from it can't bill.
      // Refetch now instead of waiting out the 15-min bundle interval.
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
