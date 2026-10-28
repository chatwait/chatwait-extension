import type { PromptAdapter, PromptCallbacks } from './types';

// Verified 2026-10-16 against live meta.ai
// Meta AI (meta.ai / www.meta.ai) uses React with dynamic class names.
// Rather than anchoring inside bubble pills in the message stream (which get clipped or
// shifted by virtualized lists and chat styling), we dock the ad card directly above the
// composer card and Thinking section at the bottom.
const SEND_BTN = 'button[aria-label="Send prompt"], button[aria-label="Send"], button[type="submit"]';
const COMPOSER_TEXTBOX = 'div[role="textbox"], textarea';
const STOP_BTN = 'button[aria-label="Stop"]';

export class MetaAIAdapter implements PromptAdapter {
  host = 'meta.ai';

  private cb: PromptCallbacks | null = null;
  private sendHandler: (() => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundBtn: HTMLElement | null = null;
  private boundComposer: HTMLElement | null = null;
  private anchorObserver: MutationObserver | null = null;
  private reanchorObserver: MutationObserver | null = null;
  private doneObserver: MutationObserver | null = null;
  private reattachObserver: MutationObserver | null = null;
  private currentAnchor: HTMLElement | null = null;
  private lastSubmitAt = 0;
  private isSubmitting = false;
  private globalListenersAttached = false;

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
    this.isSubmitting = false;
  }

  hostAdVisible(): boolean {
    return !!document.querySelector('[data-ad-slot], [data-testid="sponsored-result"]');
  }

  /** Resolves the composer card container enclosing the textbox, toolbar, and Thinking pill */
  private getMetaComposerCard(): HTMLElement | null {
    const textbox = document.querySelector<HTMLElement>(COMPOSER_TEXTBOX);
    if (!textbox) return null;

    const sendBtn = document.querySelector<HTMLElement>(SEND_BTN);
    let el: HTMLElement | null = textbox;

    while (el && el !== document.body) {
      if (el.classList && Array.from(el.classList).some((c) => c.includes('rounded'))) {
        if (!sendBtn || el.contains(sendBtn)) {
          (el as any)._chatwaitPlacement = 'before';
          el.dataset.chatwaitPlacement = 'before';
          return el;
        }
      }
      el = el.parentElement;
    }

    if (sendBtn) {
      let p: HTMLElement | null = textbox.parentElement;
      while (p && p !== document.body) {
        if (p.contains(sendBtn)) {
          (p as any)._chatwaitPlacement = 'before';
          p.dataset.chatwaitPlacement = 'before';
          return p;
        }
        p = p.parentElement;
      }
    }

    const card =
      (textbox.closest('div[class*="rounded"]') as HTMLElement | null) ||
      (textbox.parentElement?.parentElement as HTMLElement | null) ||
      textbox;
    if (card) {
      (card as any)._chatwaitPlacement = 'before';
      card.dataset.chatwaitPlacement = 'before';
    }
    return card;
  }

  private attach() {
    if (!this.globalListenersAttached) {
      this.globalListenersAttached = true;
      document.addEventListener(
        'keydown',
        (e: KeyboardEvent) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            const target = e.target as HTMLElement | null;
            if (
              target &&
              (target.closest?.(COMPOSER_TEXTBOX) || target.getAttribute?.('role') === 'textbox')
            ) {
              this.handleSubmit();
            }
          }
        },
        true,
      );

      document.addEventListener(
        'click',
        (e: MouseEvent) => {
          const target = e.target as HTMLElement | null;
          if (target && target.closest?.(SEND_BTN)) {
            this.handleSubmit();
          }
        },
        true,
      );
    }

    const textbox = document.querySelector<HTMLElement>(COMPOSER_TEXTBOX);
    const sendBtn = document.querySelector<HTMLElement>(SEND_BTN);

    if (textbox && textbox !== this.boundComposer) {
      if (this.keyHandler && this.boundComposer) {
        this.boundComposer.removeEventListener('keydown', this.keyHandler, true);
      }
      this.boundComposer = textbox;
      this.keyHandler = (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          this.handleSubmit();
        }
      };
      textbox.addEventListener('keydown', this.keyHandler, true);
    }

    if (sendBtn && sendBtn !== this.boundBtn) {
      if (this.sendHandler && this.boundBtn) {
        this.boundBtn.removeEventListener('click', this.sendHandler, true);
      }
      this.boundBtn = sendBtn;
      this.sendHandler = () => this.handleSubmit();
      sendBtn.addEventListener('click', this.sendHandler, true);
    }
  }

  private detach() {
    if (this.sendHandler && this.boundBtn) {
      this.boundBtn.removeEventListener('click', this.sendHandler, true);
    }
    if (this.keyHandler && this.boundComposer) {
      this.boundComposer.removeEventListener('keydown', this.keyHandler, true);
    }
    this.sendHandler = null;
    this.keyHandler = null;
    this.boundBtn = null;
    this.boundComposer = null;
  }

  private handleSubmit() {
    const now = Date.now();
    if (now - this.lastSubmitAt < 600) return;
    this.lastSubmitAt = now;
    this.isSubmitting = true;
    this.cb?.onSubmit();
    this.watchForAnchor();
  }

  private watchForAnchor() {
    this.anchorObserver?.disconnect();
    const tryAnchor = (): boolean => {
      const card = this.getMetaComposerCard();
      if (card) {
        this.anchorObserver?.disconnect();
        this.anchorObserver = null;
        this.currentAnchor = card;
        this.cb?.onAnchorReady(card);
        this.watchForReanchor(card);
        this.watchForDone();
        return true;
      }
      return false;
    };

    if (tryAnchor()) return;
    this.anchorObserver = new MutationObserver(() => tryAnchor());
    this.anchorObserver.observe(document.body, { childList: true, subtree: true });
  }

  private watchForReanchor(card: HTMLElement) {
    this.reanchorObserver?.disconnect();
    this.reanchorObserver = new MutationObserver(() => {
      const newCard = this.getMetaComposerCard();
      if (newCard && newCard !== this.currentAnchor) {
        this.currentAnchor = newCard;
        this.cb?.onReanchor?.(newCard);
      }
    });
    this.reanchorObserver.observe(card.parentElement || document.body, { childList: true });
  }

  private watchForDone() {
    this.doneObserver?.disconnect();
    let wasStreaming = !!document.querySelector(STOP_BTN);

    this.doneObserver = new MutationObserver(() => {
      const stopBtn = document.querySelector(STOP_BTN);
      if (stopBtn) {
        wasStreaming = true;
        return;
      }

      if (wasStreaming && !stopBtn) {
        this.isSubmitting = false;
        this.cb?.onDone();
        this.cleanupAfterDone();
        return;
      }

      const copyBtn = document.querySelector('button[aria-label="Copy response"], button[aria-label="Copy"]');
      if (copyBtn && Date.now() - this.lastSubmitAt > 1500) {
        this.isSubmitting = false;
        this.cb?.onDone();
        this.cleanupAfterDone();
      }
    });

    this.doneObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'disabled'],
    });
  }

  private cleanupAfterDone() {
    this.doneObserver?.disconnect();
    this.doneObserver = null;
    this.reanchorObserver?.disconnect();
    this.reanchorObserver = null;
  }
}
