import type { AdCreative, PromptAdapter, PromptCallbacks } from './adapters/types';
import { AdCard } from './ad-card';
import { ImpressionTracker } from './impression';
import { storage } from '../../lib/storage';
import { log } from '../../lib/log';

/** Wires an already-constructed adapter up to the ad card + impression tracker. Shared by
 * the real content script (entrypoints/content/index.ts) and the mock test harness
 * (entrypoints/mock.content.ts) so both exercise the exact same injection logic. */
export function attachAdInjection(adapter: PromptAdapter) {
  const card = new AdCard();
  const tracker = new ImpressionTracker();

  // Diagnostic-only: if onSubmit fires but onAnchorReady never does, the console otherwise
  // goes silent and there's no way to tell "adapter never saw the submit" apart from "adapter
  // saw it but anchor detection never fired" from a pasted console dump alone.
  let anchorWatchdog: ReturnType<typeof setTimeout> | null = null;

  const callbacks: PromptCallbacks = {
    onSubmit() {
      log.info('prompt submitted, watching for the new message to anchor the ad on');
      if (anchorWatchdog) clearTimeout(anchorWatchdog);
      anchorWatchdog = setTimeout(() => {
        log.warn('no ad: anchor never detected 12s after submit (adapter likely lost track of the new message element)');
      }, 12000);
    },

    async onAnchorReady(userMsgEl: HTMLElement) {
      if (anchorWatchdog) {
        clearTimeout(anchorWatchdog);
        anchorWatchdog = null;
      }
      log.info('anchor detected, resolving ad');
      if (!(await storage.getEnabled())) {
        log.info('no ad: extension is toggled off in the popup');
        return;
      }
      if (adapter.hostAdVisible()) {
        log.info('no ad: host page is already showing its own sponsored result');
        return;
      }

      // Inside the pacing window after a qualified impression, a fresh creative could not be
      // tracked anyway (tracker.start() declines during the cooldown), so the user would see
      // a new ad, expect it to pay, and it never would. Re-show the ad already served on this
      // site instead — visually it reads as the card following the conversation down the
      // thread, not as a new unpaid ad.
      let ad: AdCreative | null = null;
      let repeated = false;
      if (tracker.inCooldown()) {
        ad = await storage.getLastShownAd(location.hostname);
        repeated = !!ad;
      }
      if (!ad) {
        const response = await browser.runtime.sendMessage({ type: 'GET_AD' });
        ad = (response?.ad as AdCreative | undefined) ?? null;
        if (!ad) {
          const reason = response?.reason;
          if (reason === 'not_signed_in') {
            log.info('no ad: not signed in to Chatwait (click the extension icon to sign in)');
          } else if (reason === 'no_bundle') {
            log.info('no ad: ad bundle not loaded yet (background may still be fetching, or the last fetch failed)');
          } else {
            log.info(`no ad: background returned none (reason=${reason ?? 'unknown'})`);
          }
          return;
        }
        await storage.setLastShownAd(location.hostname, ad);
      }
      if (repeated) {
        log.info(`re-showing previous ad "${ad.text}" (${ad.sponsor_name}, id=${ad.id}): impression pacing window still open`);
      } else {
        log.info(`showing ad "${ad.text}" (${ad.sponsor_name}, id=${ad.id})`);
      }

      // Non-house ads arrive from ads-bundle already rewritten to our click-redirect URL
      // (`.../click?ad=<id>`), which looks up the real (e.g. Awin) destination server-side —
      // the raw affiliate link never reaches the extension. device/site are appended here at
      // click time rather than baked into the bundle URL, since site isn't knowable at fetch
      // time. `token` is the same per-device ad_token minted alongside this ad by ads-bundle —
      // click now requires it (T-20260706-0724-click-endpoint-hardening) so the endpoint can't
      // be used as a bare campaign-id -> destination-URL oracle or attribute clicks to an
      // arbitrary device id. House ads already point straight at chatwait.com and are left as-is.
      const isMasked = !ad.is_house_ad && ad.kind !== 'onboarding';
      const clickUrl = isMasked
        ? `${ad.url}&device=${encodeURIComponent(await storage.getDeviceId())}&site=${encodeURIComponent(location.hostname)}&token=${encodeURIComponent(ad.ad_token ?? '')}`
        : ad.url;

      // Insert ad immediately after the user message element, then start impression timing —
      // in that order, not the reverse, so dwell time (and therefore billing) only ever
      // measures a card that's actually on screen.
      card.show({ ...ad, url: clickUrl }, userMsgEl, {
        onClick: (anchor) => {
          // The click redirect function records the click itself server-side, so no separate
          // RECORD_EVENT beacon here (that would double-count). Only linkable once the
          // impression has qualified (≥5s dwell) — that's when the impressions row the FK
          // points at actually exists server-side. Rewriting `href` here (synchronously, in
          // the click handler) still lands before the browser's default navigation.
          if (isMasked && tracker.isQualified()) {
            anchor.href = `${clickUrl}&impression=${encodeURIComponent(tracker.getImpressionId())}`;
          }
        },
        onDismiss: () => {
          log.info(`ad ${ad.id} dismissed by user, stopping impression timing`);
          tracker.stop();
        },
      });

      tracker.start(ad.id, () => {
        log.info(`impression qualified for ad ${ad.id} (dwell=${tracker.dwellMs()}ms)`);
        browser.runtime.sendMessage({
          type: 'RECORD_EVENT',
          payload: {
            site: location.hostname,
            ad_id: ad.id,
            // Serving grant minted by ads-bundle for this device+ad; the backend refuses to
            // bill an impression without a valid one. Absent on local fallback/onboarding
            // ads, which never bill anyway.
            ad_token: ad.ad_token,
            type: 'impression',
            impression_id: tracker.getImpressionId(),
            dwell_ms: tracker.dwellMs(),
            ts: Date.now(),
          },
        });
      });
    },

    onReanchor(newAnchorEl: HTMLElement) {
      // Host page rebuilt the DOM around the user message and discarded our original anchor.
      // Move the same card node onto the new anchor; the ad and impression timing carry over.
      card.reanchor(newAnchorEl);
    },

    onDone() {
      // Card stays on screen after the response finishes; only the user's own dismiss
      // click removes it (or a new prompt's card replacing it). Impression timing keeps
      // running for the same reason — a response faster than the dwell threshold must not
      // cut qualification short while the card is still being looked at. The tracker stops
      // on dismiss or on the next prompt's card (tracker.start() stops the previous run).
    },
  };

  adapter.start(callbacks);
}
