import type { AdCreative } from '../entrypoints/content/adapters/types';

const BASE_URL = 'https://api.chatwait.com/functions/v1';

// Sent as ?extension_version= on every request so the backend can correlate
// impressions/errors with a specific build (manifest version_name, e.g. "0.1.1+a1b2c3d").
// Lazy: WXT imports this module during its pre-render step, before a real extension
// runtime exists, where browser.runtime.getManifest() throws (fake-browser mock).
function extensionVersion(): string {
  try {
    return browser.runtime.getManifest().version_name ?? '';
  } catch {
    return '';
  }
}

/** Non-2xx API response. Carries the HTTP status so callers can react to specific codes
 * (the background treats a 401 from ads-bundle as "re-check sign-in now") instead of
 * pattern-matching error message strings. */
export class ApiStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function fetchAdBundle(deviceId: string, deviceToken: string): Promise<AdCreative[]> {
  // Device credentials are mandatory: ads-bundle 401s without them. The bundle comes back
  // with per-ad ad_tokens, which the events endpoint requires before billing an impression.
  const params = `?device_id=${encodeURIComponent(deviceId)}&device_token=${encodeURIComponent(deviceToken)}&extension_version=${encodeURIComponent(extensionVersion())}`;
  const res = await fetch(`${BASE_URL}/ads-bundle${params}`);
  if (!res.ok) throw new ApiStatusError(res.status, `fetchAdBundle: ${res.status}`);
  const data = await res.json();
  return data.ads ?? [];
}

export async function sendEvents(events: object[]): Promise<void> {
  if (events.length === 0) return;
  const res = await fetch(`${BASE_URL}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) throw new Error(`sendEvents: ${res.status}`);
}

export async function fetchDeviceLinked(
  deviceId: string,
): Promise<{ linked: boolean; profileComplete: boolean; deviceToken?: string }> {
  const res = await fetch(
    `${BASE_URL}/device-status?device_id=${deviceId}&extension_version=${encodeURIComponent(extensionVersion())}`,
  );
  if (!res.ok) throw new Error(`fetchDeviceLinked: ${res.status}`);
  const data = await res.json();
  return { linked: !!data.linked, profileComplete: !!data.profile_complete, deviceToken: data.device_token };
}

export async function fetchEarnings(deviceId: string, deviceToken: string): Promise<number> {
  // user-earnings requires proof of live sign-in now: a bare device_id is a bearer credential
  // that leaks by design (Awin clickref, the ?device= click-URL param), so reading someone's
  // earnings total needs the same device_token every other money-path endpoint already checks.
  const params = `?device_id=${encodeURIComponent(deviceId)}&device_token=${encodeURIComponent(deviceToken)}&extension_version=${encodeURIComponent(extensionVersion())}`;
  const res = await fetch(`${BASE_URL}/user-earnings${params}`);
  if (!res.ok) throw new ApiStatusError(res.status, `fetchEarnings: ${res.status}`);
  const data = await res.json();
  return Number(data.total_usd) || 0;
}
