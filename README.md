# Chatwait

Chatwait is a browser extension that shows sponsored text cards while ChatGPT, Claude, and Gemini are generating responses. Users earn 50% of ad revenue from qualified impressions.

The extension is open source and intentionally minimal: it does not read prompts or AI responses.

## Supported sites

- `https://chatgpt.com/*`
- `https://claude.ai/*`
- `https://gemini.google.com/*`

## Installation

Chatwait isn't in the Chrome Web Store yet, so for now you install it as an unpacked extension:

1. Download [`chatwait-extension.zip`](https://github.com/chatwait/chatwait-extension/releases/latest/download/chatwait-extension.zip) from the latest release.
2. Unzip it.
3. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge).
4. Enable **Developer mode** (toggle, top right).
5. Click **Load unpacked**.
6. Select the unzipped folder.
7. Chatwait will open a sign-in tab. Sign in with Google to link your device and start seeing ads.
8. Open ChatGPT, Claude, or Gemini and submit a prompt.

## Build from Source

```bash
pnpm install
pnpm build
```

`pnpm dev` starts WXT development mode when WXT can allocate a local dev-server port.

### Install Build

1. Run `pnpm build`.
2. Open `chrome://extensions`.
3. Enable Developer Mode.
4. Click Load unpacked.
5. Select `.output/chrome-mv3`.
6. Open ChatGPT, Claude, or Gemini and submit a prompt.

## How it works

1. The content script detects a prompt submission.
2. The site adapter waits for the new user-message element.
3. If no host ad is visible and Chatwait is enabled, the extension injects a sponsored text card after the user message.
4. A qualified impression requires at least 5 seconds of visible, focused dwell time.
5. The background worker sends qualified events to the Chatwait backend.

## Permissions

Chatwait requests:

- `storage`, for anonymous device ID, popup settings, cached ads, and queued events
- Host access for ChatGPT, Claude, Gemini, and Chatwait only

No broad browsing-history, cookies, tabs, or clipboard permissions are requested.

## Backend

The extension sends ad and event requests to:

`https://api.chatwait.com/`

See [PRIVACY.md](./PRIVACY.md) for the data collected and not collected.
