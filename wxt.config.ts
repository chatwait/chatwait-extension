import { defineConfig } from 'wxt';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Build identifier for `manifest.version_name` (display-only field, unlike the dotted-integer
// `version` field the Web Store enforces). Format: <version>+<sha>, with a build timestamp
// appended only when the tree is dirty (a clean build's timestamp is redundant — the commit's
// own date already pins it, and the timestamp's presence itself signals "dirty"). e.g.
// "0.1.1+a1b2c3d" or "0.1.1+a1b2c3d+2026-07-04T14:32Z". Lets `pnpm agent console`/the popup
// footer answer "is this the build I just saved?" without diffing manifest.json by hand.
function buildIdentifier(): string {
  const { version } = JSON.parse(readFileSync(path.resolve('package.json'), 'utf-8'));
  let sha = 'nogit';
  let dirty = false;
  try {
    sha = execSync('git rev-parse --short HEAD').toString().trim();
    dirty = execSync('git status --porcelain').toString().trim().length > 0;
  } catch {
    // Not in a git checkout (e.g. a packaged release tarball) — ship without a SHA.
  }
  if (!dirty) return `${version}+${sha}`;
  const builtAt = new Date().toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
  return `${version}+${sha}+${builtAt}`;
}

// Agent dev mode (WXT_AGENT=1): launch a dedicated Chrome for Testing with the
// extension pre-loaded, a persistent profile (Google sign-in survives restarts),
// and a CDP port so scripts/agent.mjs can reload/screenshot/inspect it.
// Branded Chrome ignores --load-extension since v137, so a Chrome for Testing
// build must be present — install with: pnpm agent:install-chrome
function findChromeForTesting(): string | undefined {
  const root = path.resolve('.chrome/chrome');
  if (!existsSync(root)) return undefined;
  for (const build of readdirSync(root)) {
    for (const platform of ['chrome-mac-arm64', 'chrome-mac-x64']) {
      const bin = path.join(
        root,
        build,
        platform,
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      );
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

const agentMode = process.env.WXT_AGENT === '1';
const agentChrome = agentMode ? findChromeForTesting() : undefined;
if (agentMode && !agentChrome) {
  throw new Error(
    'WXT_AGENT=1 but no Chrome for Testing found in .chrome/ — run: pnpm agent:install-chrome',
  );
}

export default defineConfig({
  zip: {
    name: 'chatwait-extension',
    artifactTemplate: '{{name}}.zip',
  },
  suppressWarnings: {
    firefoxDataCollection: true,
  },
  webExt: agentMode
    ? {
        binaries: { chrome: agentChrome! },
        chromiumArgs: [
          `--user-data-dir=${path.resolve('.chrome/profile')}`,
          // WXT_CDP=0 disables the debug port (Google blocks sign-in while a
          // debugger port is open — sign in once with WXT_CDP=0, cookies persist).
          ...(process.env.WXT_CDP === '0'
            ? []
            : [`--remote-debugging-port=${process.env.WXT_CDP_PORT || '9222'}`]),
        ],
        startUrls: [
          process.env.WXT_START_URL ||
            (process.env.WXT_MOCK === '1' ? 'http://localhost:5199' : 'https://chatgpt.com'),
        ],
      }
    : { disabled: true },
  hooks: {
    // entrypoints/mock.content.ts only exists to run the real adapters against the local
    // mock chat page (mock/index.html) for dev QA and automated testing. Strip it out unless
    // explicitly requested via WXT_MOCK=1 (see package.json's "dev:mock" script), so
    // `pnpm build`/`pnpm zip` — what actually ships to the Chrome Web Store — never
    // requests the localhost:5199 host.
    'entrypoints:found'(_wxt, infos) {
      if (process.env.WXT_MOCK !== '1') {
        const i = infos.findIndex((info) => info.name === 'mock');
        if (i !== -1) infos.splice(i, 1);
      }
      // entrypoints/preview.content.ts force-shows the ad card on real, already-open threads
      // so the design can be reviewed without submitting a fresh prompt. Dev-only, same
      // strip-unless-opted-in pattern as the mock entrypoint above (see WXT_PREVIEW=1 /
      // "dev:preview" in package.json) — never present in `pnpm build`/`pnpm zip`.
      if (process.env.WXT_PREVIEW !== '1') {
        const i = infos.findIndex((info) => info.name === 'preview');
        if (i !== -1) infos.splice(i, 1);
      }
    },
  },
  manifest: {
    name: 'Chatwait: Get paid while AI thinks',
    description:
      'Earn while ChatGPT, Claude, and Gemini thinks. We cannot read your chats.',
    version_name: buildIdentifier(),
    permissions: ['storage'],
    host_permissions: [
      'https://chatgpt.com/*',
      'https://claude.ai/*',
      'https://gemini.google.com/*',
      // Not for a content script (chatwait.com has none) — lets background.ts's
      // tabs.onUpdated listener read the signin tab's url so it can push an
      // immediate refreshSignInStatus() the moment /auth/callback redirects to
      // /dashboard or /onboarding, instead of waiting up to 60s for the next poll.
      'https://chatwait.com/*',
    ],
    // Bundled house/onboarding ad icon (public/chatwait-icon-round.svg), loaded via
    // browser.runtime.getURL() into an <img> the content script injects on the chat hosts.
    // Without this, the host page's CSP could block the chrome-extension:// resource load.
    web_accessible_resources: [
      {
        resources: ['chatwait-icon-round.svg'],
        matches: ['https://chatgpt.com/*', 'https://claude.ai/*', 'https://gemini.google.com/*'],
      },
    ],
  },
});
