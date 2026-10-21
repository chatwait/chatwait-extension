import type { PromptAdapter, PromptCallbacks } from './types';

// Verified 2026-06-12 against live chatgpt.com (classic app, signed-in threads).
// Signed-out visitors (confirmed live 2026-08-01) get a completely different, lighter-weight
// "wm-app" composer/thread UI with none of these hooks — CSS module class names there are
// build-hashed (e.g. `_wdUoQG_userMessage`) and unusable as selectors, but it exposes its own
// stable `data-*` attributes, so both surfaces are matched in parallel rather than picking one.
//
// Re-verified 2026-10-05 on signed-in chatgpt.com: the classic composer was redesigned onto the
// same bubble surface (no `#prompt-textarea`, no `data-testid="send-button"`, no
// `data-message-author-role`). The composer is a contenteditable `[data-composer-markdown]`; Send is
// `button[type=submit][aria-label="Send"]` and exists only while the composer has text; while
// generating it is replaced by `button[aria-label="Stop"]`, and once done the composer is empty so
// Send does NOT come back. Done is therefore "Stop was seen, then gone" (see watchForDone).
const SEND_BTN  = '[data-testid="send-button"], button[data-composer-submit], form button[type="submit"][aria-label="Send"]';
const COMPOSER  = '#prompt-textarea, [data-mobile-composer-prompt], [data-composer-markdown]';
export const USER_MSG  = '[data-message-author-role="user"], [data-user-message-bubble]';

// Redesigned thread: the bubble sits in a column-flex wrapper that shrink-wraps anything placed
// beside it. The turn container (parent of the search-unit div) is a `display: contents` node whose
// next sibling is the assistant reply, so inserting after it gives a full-width row between the two.
function anchorFor(el: HTMLElement): HTMLElement {
  return el.closest<HTMLElement>('[data-chatgpt-search-unit-key]')?.parentElement ?? el;
}

function stopButton(): Element | null {
  const form = document.querySelector(COMPOSER)?.closest('form');
  return form?.querySelector('button[aria-label="Stop"], button[data-testid="stop-button"]') ?? null;
}

// Long/old threads get virtualized: ChatGPT unmounts older user messages from the DOM as new
// ones are appended, so a raw count of matches can legitimately go up, down, or stay flat
// around a single new submit — and (confirmed live) the message-list rendering can also
// *recycle* an existing DOM node for a different logical message rather than creating a fresh
// one, so even comparing trailing-element identity isn't reliable on a virtualized thread: the
// "new" last element can literally be the same object as the old one, just repositioned with
// updated content. `data-message-id` is a stable per-message UUID that survives node reuse
// (confirmed present on every real user message in the classic app). The wm-app surface has no
// such attribute on the message node itself, but its ancestor `<li>` (the message "turn") carries
// the same kind of stable per-message UUID as its `id`, so fall back to that.
function lastOf(list: NodeListOf<HTMLElement>): HTMLElement | null {
  return list.length ? list[list.length - 1] : null;
}

function lastMsgKey(list: NodeListOf<HTMLElement>): string | HTMLElement | null {
  const el = lastOf(list);
  if (!el) return null;
  return (
    el.getAttribute('data-message-id') ??
    el.closest('li[id]')?.id ??
    (el.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids') || null) ??
    el
  );
}

export class ChatGPTAdapter implements PromptAdapter {
  host = 'chatgpt.com';

  private cb: PromptCallbacks | null = null;
  private sendHandler: (() => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundBtn: HTMLElement | null = null;
  private boundComposer: HTMLElement | null = null;
  private anchorObserver: MutationObserver | null = null;
  private doneObserver: MutationObserver | null = null;
  private reattachObserver: MutationObserver | null = null;
  private reanchorObserver: MutationObserver | null = null;
  private preSubmitUserMsgKey: string | HTMLElement | null = null;

  start(cb: PromptCallbacks) {
    this.cb = cb;
    this.attach();
    // Re-attach on SPA navigation (new chat reuses the page without a full reload)
    this.reattachObserver = new MutationObserver(() => this.attach());
    this.reattachObserver.observe(document.body, { childList: true, subtree: true });
  }

  stop() {
    this.detach();
    this.reattachObserver?.disconnect();
    this.anchorObserver?.disconnect();
    this.doneObserver?.disconnect();
    this.reanchorObserver?.disconnect();
    this.reattachObserver = null;
    this.anchorObserver = null;
    this.doneObserver = null;
  }

  hostAdVisible(): boolean {
    return !!document.querySelector('[data-testid="sponsored-result"], .ad-container');
  }

  private attach() {
    const btn = document.querySelector<HTMLElement>(SEND_BTN);
    const composer = document.querySelector<HTMLElement>(COMPOSER);
    if (!btn || !composer) return;
    // ChatGPT's mobile-width composer swaps the send button for a mic button (rather than just
    // toggling `disabled`) when the composer is emptied, so it's a fresh DOM node each time text
    // is entered. Re-bind whenever the live node differs from the one we're currently attached to,
    // instead of a one-shot bind gated on `sendHandler` truthiness (which went stale forever once
    // that first node was replaced).
    if (btn === this.boundBtn && composer === this.boundComposer) return;
    this.detach();

    this.boundBtn = btn;
    this.boundComposer = composer;
    this.sendHandler = () => this.handleSubmit();
    // Capture phase, not bubble: ChatGPT's own composer has its own keydown handler directly
    // on this same element (confirmed live — real physical Enter presses reliably failed to be
    // detected while synthetic .click()/execCommand submissions worked). Our extension binds
    // this listener later than the host's own, via the MutationObserver in start(), so on the
    // bubble phase (target-phase listeners fire in attachment order) the host's handler runs
    // first and has already submitted the message — reading "what messages exist" inside our
    // own handler then sees the *new* message, not the baseline, and detection never fires.
    // Capture-phase listeners always run before any bubble-phase listener on the same node,
    // regardless of attachment order, so this guarantees we snapshot the true pre-submit state.
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
    this.reanchorObserver?.disconnect();
    this.preSubmitUserMsgKey = lastMsgKey(document.querySelectorAll<HTMLElement>(USER_MSG));
    this.watchForUserMessage();
  }

  private watchForUserMessage() {
    this.anchorObserver?.disconnect();
    this.anchorObserver = new MutationObserver(() => {
      const all = document.querySelectorAll<HTMLElement>(USER_MSG);
      const newEl = lastOf(all);
      if (!newEl || lastMsgKey(all) === this.preSubmitUserMsgKey) return;
      this.anchorObserver?.disconnect();
      this.cb?.onAnchorReady(anchorFor(newEl));
      this.watchForReanchor();
      this.watchForDone();
    });
    this.anchorObserver.observe(document.body, { childList: true, subtree: true });
  }

  // Confirmed live 2026-10-21: submitting from the new-chat page renders an optimistic user
  // bubble, then navigates to /c/<id> and rebuilds the thread, discarding that bubble (and the
  // card inserted after it). A fast reply ("hi") can finish the rebuild *before* the async ad
  // fetch inserts the card, so a one-shot "anchor disconnected" check misses it: the card lands
  // on the already-detached bubble. Instead, on every mutation, re-assert the card sits after the
  // current last user bubble (reanchor is idempotent and a no-op when no card is showing). Runs
  // until the next submit.
  private watchForReanchor() {
    this.reanchorObserver?.disconnect();
    this.reanchorObserver = new MutationObserver(() => {
      const el = lastOf(document.querySelectorAll<HTMLElement>(USER_MSG));
      if (!el) return;
      this.cb?.onReanchor?.(anchorFor(el));
    });
    this.reanchorObserver.observe(document.body, { childList: true, subtree: true });
  }

  private watchForDone() {
    this.doneObserver?.disconnect();
    // Classic app: send button disappears during generation; reappearing (not disabled) signals
    // completion. wm-app (signed-out): the button never disappears or disables during generation
    // — it stays enabled and swaps `type`/`aria-label` to a "Stop generating" control instead
    // (confirmed live: `disabled` stays false throughout streaming) — so `!btn.disabled` alone
    // would fire immediately on that surface. `data-send-label`/`data-stop-label` mirror the
    // button's two states regardless of which one is currently live, so comparing against those
    // works for wm-app without a hardcoded string, and is skipped entirely on the classic app,
    // which doesn't have the attributes.
    // Redesigned app: Send is swapped for a Stop button and does not return (empty composer), so
    // track Stop explicitly. The send-button path below stays for the other surfaces.
    let stopSeen = false;
    this.doneObserver = new MutationObserver(() => {
      if (stopButton()) {
        stopSeen = true;
        return;
      }
      if (stopSeen) {
        this.cb?.onDone();
        this.doneObserver?.disconnect();
        return;
      }
      const btn = document.querySelector<HTMLButtonElement>(SEND_BTN);
      if (!btn) return;
      const sendLabel = btn.getAttribute('data-send-label');
      const ready = sendLabel ? btn.getAttribute('aria-label') === sendLabel : !btn.disabled;
      if (ready) {
        this.cb?.onDone();
        this.doneObserver?.disconnect();
      }
    });
    this.doneObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-label'],
    });
  }
}
