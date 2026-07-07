import { ChatGPTAdapter } from './adapters/chatgpt';
import { ClaudeAdapter } from './adapters/claude';
import { GeminiAdapter } from './adapters/gemini';
import type { PromptAdapter } from './adapters/types';
import { attachAdInjection } from './shared';
import { log } from '../../lib/log';
import { storage } from '../../lib/storage';

export default defineContentScript({
  matches: [
    'https://chatgpt.com/*',
    'https://claude.ai/*',
    'https://gemini.google.com/*',
  ],
  async main() {
    if (document.readyState === 'loading') {
      await new Promise<void>(r => document.addEventListener('DOMContentLoaded', () => r(), { once: true }));
    }

    const adapter = resolveAdapter();
    if (!adapter) {
      log.warn(`content script loaded on unrecognized host ${location.hostname}, no adapter attached`);
      return;
    }

    log.info(`adapter attached for ${adapter.host}`);

    // Fire-and-forget: refetch the ad bundle the moment the user lands on a host site, so a
    // freshly won auction shows up here instead of waiting out the 15-minute background poll.
    browser.runtime.sendMessage({ type: 'REFRESH_ADS' }).catch(() => {});

    try {
      const [enabled, signedIn, hasBundle, bundle] = await Promise.all([
        storage.getEnabled(),
        storage.getSignedIn(),
        storage.hasFetchedAdBundle(),
        storage.getAdBundle(),
      ]);
      if (!enabled) {
        log.info('not ready: extension is toggled off in the popup');
      } else if (!signedIn) {
        log.info('not ready: not signed in to Chatwait (click the extension icon to sign in)');
      } else if (!hasBundle) {
        log.info('not ready: ad bundle not loaded yet (background may still be fetching, or the last fetch failed)');
      } else {
        log.info(`ready: signed in and enabled, ${bundle.length} ad(s) cached`);
      }
    } catch (err) {
      // browser.storage.* throws "Extension context invalidated" when this tab was already
      // open before the extension was reinstalled/updated — the old content script instance
      // is orphaned and every extension API call from here on will fail the same way.
      log.warn('not ready: extension context invalidated (reload this tab — it was open before the extension was last installed/updated)', err);
      return;
    }

    attachAdInjection(adapter);
  },
});

function resolveAdapter(): PromptAdapter | null {
  const host = location.hostname;
  if (host === 'chatgpt.com') return new ChatGPTAdapter();
  if (host === 'claude.ai') return new ClaudeAdapter();
  if (host === 'gemini.google.com') return new GeminiAdapter();
  return null;
}
