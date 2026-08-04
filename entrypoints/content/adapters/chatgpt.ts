import type { PromptAdapter, PromptCallbacks } from './types';

// Verified 2026-06-12 against live chatgpt.com (classic app, signed-in threads).
// Signed-out visitors (confirmed live 2026-08-01) get a completely different, lighter-weight
// "wm-app" composer/thread UI with none of these hooks — CSS module class names there are
// build-hashed (e.g. `_wdUoQG_userMessage`) and unusable as selectors, but it exposes its own
// stable `data-*` attributes, so both surfaces are matched in parallel rather than picking one.
const SEND_BTN  = '[data-testid="send-button"], button[data-composer-submit]';
const COMPOSER  = '#prompt-textarea, [data-mobile-composer-prompt]';
export const USER_MSG  = '[data-message-author-role="user"], [data-user-message-bubble]';

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
  return el.getAttribute('data-message-id') ?? el.closest('li[id]')?.id ?? el;
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
      this.cb?.onAnchorReady(newEl);
      this.watchForDone();
    });
    this.anchorObserver.observe(document.body, { childList: true, subtree: true });
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
    this.doneObserver = new MutationObserver(() => {
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
