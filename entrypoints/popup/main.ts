import { storage } from '../../lib/storage';
import { fetchEarnings } from '../../lib/api';

const appEl = document.getElementById('app')!;
const earningsEl = document.getElementById('earningsAmount')!;
const statusEl = document.querySelector('.status')!;
const statusText = document.getElementById('statusText')!;
const globalToggle = document.getElementById('globalToggle') as HTMLInputElement;
const signinBtn = document.getElementById('signinBtn') as HTMLButtonElement;
const signinMessage = document.getElementById('signinMessage')!;
const dashboardBtn = document.getElementById('dashboardBtn') as HTMLButtonElement;
const buildInfoEl = document.getElementById('buildInfo')!;

buildInfoEl.textContent = browser.runtime.getManifest().version_name ?? '';

async function init() {
  // storage.getSignedIn() is a local cache kept fresh by the background worker's periodic
  // CHECK_SIGNIN refresh — reading it is near-instant, unlike CHECK_SIGNIN itself which is a
  // network round trip. Render off the cache first so the popup doesn't flash the sign-in gate
  // on every open for an already-signed-in user; CHECK_SIGNIN below then reconciles in case the
  // cache is stale (e.g. the user signed out in another tab).
  const [cachedEarnings, enabled, deviceId, deviceToken, cachedSignedIn] = await Promise.all([
    storage.getLocalEarnings(),
    storage.getEnabled(),
    storage.getDeviceId(),
    storage.getDeviceToken(),
    storage.getSignedIn(),
  ]);

  // A cached $0.00 is indistinguishable from "not fetched yet" — showing it immediately
  // just means every open flashes 0 -> real amount once the fetch resolves. Keep the
  // loading placeholder up instead until we have a number worth showing.
  if (cachedEarnings > 0) {
    renderEarnings(cachedEarnings);
  }
  globalToggle.checked = enabled;
  renderEnabled(enabled);
  renderSignedIn(cachedSignedIn);

  if (cachedSignedIn && deviceId && deviceToken) {
    await refreshEarnings(deviceId, deviceToken, cachedEarnings);
  }

  let signinResp: { signedIn?: boolean } | undefined;
  try {
    signinResp = await browser.runtime.sendMessage({ type: 'CHECK_SIGNIN' });
  } catch {
    // Live check failed (e.g. background worker unreachable) — keep showing the cached state
    // rather than forcing a signed-in user back to the sign-in gate over a transient error.
    return;
  }

  const signedIn = !!signinResp?.signedIn;
  if (signedIn === cachedSignedIn) return;

  renderSignedIn(signedIn);
  if (signedIn && deviceId && deviceToken) {
    await refreshEarnings(deviceId, deviceToken, cachedEarnings);
  }
}

async function refreshEarnings(deviceId: string, deviceToken: string, cachedEarnings: number) {
  const total = await fetchEarningsWithRetry(deviceId, deviceToken);
  if (total !== null) {
    renderEarnings(total);
    await storage.setEarnings(total);
    return;
  }

  // Couldn't confirm a live total (the fetch failed even after a retry). Only fall back to the
  // cache when it's a real nonzero number we trust — an untouched $0.00 cache is "not fetched
  // yet," not "confirmed zero," and showing it here would undo the same guard applied above for
  // the optimistic render.
  if (cachedEarnings > 0) {
    renderEarnings(cachedEarnings);
  }
}

async function fetchEarningsWithRetry(deviceId: string, deviceToken: string, attempts = 2): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchEarnings(deviceId, deviceToken);
    } catch {
      if (i === attempts - 1) return null;
    }
  }
  return null;
}

function renderEarnings(value: number) {
  earningsEl.textContent = formatCurrency(value);
  earningsEl.classList.remove('is-loading');
}

globalToggle.addEventListener('change', async () => {
  const enabled = globalToggle.checked;
  await storage.setEnabled(enabled);
  renderEnabled(enabled);
});

signinBtn.addEventListener('click', async () => {
  signinBtn.disabled = true;
  signinMessage.textContent = 'Opening sign-in…';
  await browser.runtime.sendMessage({ type: 'OPEN_SIGNIN' });
  signinBtn.disabled = false;
  signinMessage.textContent = 'Finish signing in, then reopen this popup.';
});

dashboardBtn.addEventListener('click', () => {
  browser.tabs.create({ url: 'https://chatwait.com/dashboard' });
});

function renderEnabled(enabled: boolean) {
  statusEl.classList.toggle('is-off', !enabled);
  statusText.textContent = enabled
    ? 'Sponsored cards are on'
    : 'Sponsored cards are paused';
}

function renderSignedIn(signedIn: boolean) {
  appEl.classList.toggle('not-signed-in', !signedIn);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    // Always show at least 4 decimals so small balances like $0.0080 aren't trimmed to $0.01.
    minimumFractionDigits: 4,
    // 6 decimals covers the smallest possible per-impression payout: a $0.01 CPM bid at 50%
    // revshare works out to $0.000005 per impression.
    maximumFractionDigits: 6,
  }).format(value);
}

init();
