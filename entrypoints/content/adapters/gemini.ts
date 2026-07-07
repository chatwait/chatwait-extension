import type { PromptAdapter, PromptCallbacks } from './types';

// Verified 2026-06-12 against live gemini.google.com
// Gemini uses Angular web components — tag names are stable across CSS/style updates
const SEND_BTN      = 'button[aria-label="Send message"]';
const COMPOSER_INNER = 'rich-textarea [contenteditable]';
export const USER_MSG      = 'user-query';
// Gemini first renders the turn inside a transient <pending-request> wrapper (siblings:
// user-query + pending-response); once the real response arrives, that whole wrapper is
// torn down and replaced with a permanent container holding a freshly-created user-query +
// model-response. We anchor to the transient user-query right away so the ad fills the dead
// wait immediately, then re-anchor the same card node onto the rebuilt permanent user-query
// (which only exists once model-response appears) so it survives the teardown.
const MODEL_RESPONSE = 'model-response';

// Long/old threads get virtualized: the host unmounts older turns from the DOM as new ones
// are appended, so a raw count of matches can legitimately go up, down, or stay flat around a
// single new submit. Track the trailing element's identity instead of a count so pruning
// elsewhere in the list can never mask (or fake) a real new message/response.
function lastOf(list: NodeListOf<HTMLElement>): HTMLElement | null {
  return list.length ? list[list.length - 1] : null;
}

export class GeminiAdapter implements PromptAdapter {
  host = 'gemini.google.com';

  private cb: PromptCallbacks | null = null;
  private sendHandler: (() => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundBtn: HTMLElement | null = null;
  private boundComposer: HTMLElement | null = null;
  private anchorObserver: MutationObserver | null = null;
  private reanchorObserver: MutationObserver | null = null;
  private doneObserver: MutationObserver | null = null;
  private reattachObserver: MutationObserver | null = null;
  private preSubmitUserMsg: HTMLElement | null = null;
  private preSubmitResponse: HTMLElement | null = null;
  private currentAnchorUserMsg: HTMLElement | null = null;

  start(cb: PromptCallbacks) {
    this.cb = cb;
    this.attach();
    this.reattachObserver = new MutationObserver(() => this.attach());
    this.reattachObserver.observe(document.body, { childList: true, subtree: true });
  }

  stop() {
    this.detach();
    this.reattachObserver?.disconnect();
    this.anchorObserver?.disconnect();
    this.reanchorObserver?.disconnect();
    this.doneObserver?.disconnect();
    this.reattachObserver = null;
    this.anchorObserver = null;
    this.reanchorObserver = null;
    this.doneObserver = null;
  }

  hostAdVisible(): boolean {
    return !!document.querySelector('shopping-list, [data-ad-slot]');
  }

  private attach() {
    const btn = document.querySelector<HTMLElement>(SEND_BTN);
    const composer = document.querySelector<HTMLElement>(COMPOSER_INNER);
    if (!btn || !composer) return;
    // Re-bind whenever the live node differs from the one we're attached to, instead of a
    // one-shot bind gated on `sendHandler` truthiness (see chatgpt.ts for why that goes stale).
    if (btn === this.boundBtn && composer === this.boundComposer) return;
    this.detach();

    this.boundBtn = btn;
    this.boundComposer = composer;
    this.sendHandler = () => this.handleSubmit();
    // Capture phase, not bubble: the host's own composer likely has its own keydown handler
    // directly on this element too (see chatgpt.ts for the confirmed live repro of this exact
    // race — real Enter presses reliably beat our bubble-phase listener since ours attaches
    // later, via MutationObserver, so the host's same-node listener runs first in attachment
    // order and has already submitted by the time we read "what messages exist"). Capture-phase
    // listeners always run before bubble-phase ones on the same node regardless of attach order.
    btn.addEventListener('click', this.sendHandler, true);

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) this.handleSubmit();
    };
    composer.addEventListener('keydown', this.keyHandler, true);
  }

  private detach() {
    if (this.sendHandler && this.boundBtn) this.boundBtn.removeEventListener('click', this.sendHandler, true);
    if (this.keyHandler && this.boundComposer) this.boundComposer.removeEventListener('keydown', this.keyHandler, true);
    this.sendHandler = null;
    this.keyHandler = null;
    this.boundBtn = null;
    this.boundComposer = null;
  }

  private handleSubmit() {
    this.cb?.onSubmit();
    this.preSubmitUserMsg = lastOf(document.querySelectorAll<HTMLElement>(USER_MSG));
    this.preSubmitResponse = lastOf(document.querySelectorAll<HTMLElement>(MODEL_RESPONSE));
    this.watchForUserMessage();
  }

  private watchForUserMessage() {
    this.anchorObserver?.disconnect();
    this.anchorObserver = new MutationObserver(() => {
      // Show the ad the instant the (transient) user-query renders, so it fills the dead wait
      // right away instead of waiting for the response structure to settle.
      const newEl = lastOf(document.querySelectorAll<HTMLElement>(USER_MSG));
      if (!newEl || newEl === this.preSubmitUserMsg) return;
      this.anchorObserver?.disconnect();
      this.currentAnchorUserMsg = newEl;
      this.cb?.onAnchorReady(newEl);
      // The transient wrapper (and our anchor) gets torn down once the real response arrives;
      // re-anchor the card onto the rebuilt permanent user-query so it survives the redraw.
      this.watchForReanchor();
    });
    this.anchorObserver.observe(document.body, { childList: true, subtree: true });
  }

  private watchForReanchor() {
    this.reanchorObserver?.disconnect();
    this.reanchorObserver = new MutationObserver(() => {
      // model-response only exists once Angular has swapped the transient pending-request
      // wrapper out for the permanent structure. At that point the last user-query is the
      // rebuilt, stable one; move the card onto it. Left connected (idempotent reanchor) until
      // done so it also covers the race where onAnchorReady's async ad fetch hasn't inserted
      // the card yet by the time the rebuild happens.
      const newResponse = lastOf(document.querySelectorAll<HTMLElement>(MODEL_RESPONSE));
      if (!newResponse || newResponse === this.preSubmitResponse) return;
      const newUserMsg = lastOf(document.querySelectorAll<HTMLElement>(USER_MSG));
      if (!newUserMsg || newUserMsg === this.currentAnchorUserMsg) return;
      this.cb?.onReanchor?.(newUserMsg);
      this.watchForDone();
    });
    // childList catches the rebuild and (on real Gemini) the streaming tokens, which keep
    // re-firing until the async ad card is finally in place; the attribute filter adds the
    // send-button enable/disable toggle as a fallback fire for responses that don't stream
    // (e.g. the mock harness), so the card still lands even if its async fetch resolves after
    // the one-shot rebuild mutation.
    this.reanchorObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'disabled'],
    });
  }

  private watchForDone() {
    // watchForReanchor stays connected and calls this on every mutation while the response
    // streams; only wire the done observer up once.
    if (this.doneObserver) return;
    // Send button reappears (replacing stop button) when generation is complete
    this.doneObserver = new MutationObserver(() => {
      const btn = document.querySelector<HTMLButtonElement>(SEND_BTN);
      if (btn && !btn.disabled) {
        this.cb?.onDone();
        this.doneObserver?.disconnect();
        this.doneObserver = null;
        // Card is anchored to the permanent user-query now; stop the reanchor watcher so it
        // doesn't keep firing for the rest of the page's life.
        this.reanchorObserver?.disconnect();
        this.reanchorObserver = null;
      }
    });
    this.doneObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'disabled'] });
  }
}
