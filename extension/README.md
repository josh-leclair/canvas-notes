# Canvas Notes Web Clipper

A Firefox 140+ desktop and Firefox 142+ Android extension that sends explicitly chosen pages, selections,
simplified articles, links, and images to a self-hosted Canvas Notes inbox.

## Features

- Toolbar popup for page, rich selection, article, and video-page captures
- Optional note attached above the clipped content
- Right-click capture for pages, selected text, links, and images
- `Ctrl+Shift+Y` page capture shortcut
- Configurable self-hosted Canvas Notes URL and revocable API token
- YouTube URLs use Canvas Notes' existing video-card classifier
- No analytics, remote code, passive browsing collection, or private-window use

## Local development

Requirements: Node.js 20+, Firefox 140+ on desktop, or Firefox 142+ on Android.

```sh
npm install
npm test
npm run lint
npx web-ext run
```

The first-run setup page asks for the Canvas Notes deployment URL and a token
created under **Canvas Notes → Settings → API tokens**. Remote deployments must
use HTTPS; plain HTTP is accepted only for loopback development.

Temporary installation without `web-ext`: open `about:debugging`, choose
**This Firefox → Load Temporary Add-on**, and select `manifest.json`.

## Build

```sh
npm ci
npm test
npm run lint
npm run build
```

The review/upload ZIP is written to `artifacts/`. It is intentionally unsigned;
release installation in standard Firefox requires Mozilla signing. See
`docs/SUBMISSION.md` for listed and unlisted signing steps.

No compilation, bundling, minification, or generated code is used. The ZIP
contains the same human-readable JavaScript, HTML, and CSS as this directory.
