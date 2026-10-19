---
title: Contributing
description: How to build, test and change Offlibrary and this documentation site.
---

Issues and pull requests are welcome at [github.com/webmaxru/offlibrary](https://github.com/webmaxru/offlibrary). Please add tests for behaviour changes and keep the size budget green.

## The library

```sh
git clone https://github.com/webmaxru/offlibrary && cd offlibrary
npm install
npm test                 # unit tests (Vitest)
npx playwright-core install chromium
npm run test:e2e         # real Background Fetch, the fallback and a Workbox SW in Chromium
npm run typecheck && npm run build && npm run size
npm run check:package    # pack, install and type-check as a consumer would
npm run demo             # the demo app at http://127.0.0.1:5173
```

- The e2e suite needs **full Chromium** in new headless mode; `chrome-headless-shell` exposes Background Fetch but never completes one. Set `CHROMIUM_PATH` to use a specific binary.
- Size budgets (gzip): `offlibrary` 11 KB, `offlibrary/sw` 4.5 KB, `offlibrary/workbox` 4.5 KB, and 2 KB for the Workbox route alone. `npm run size` enforces them in CI.
- Public API changes need TSDoc comments: the [API reference](/offlibrary/api/readme/) is generated from them.

## This site

The site lives in [`website/`](https://github.com/webmaxru/offlibrary/tree/main/website) and is built with [Astro](https://astro.build/) and [Starlight](https://starlight.astro.build/). The API pages are generated from the library's source with [TypeDoc](https://typedoc.org/) through `starlight-typedoc`.

```sh
npm run demo:build       # in the repo root: builds demo/dist, copied into the site under /demo/
cd website
npm install
npm run dev              # http://localhost:4321/offlibrary/
npm run build            # dist/, with the demo under dist/demo/
npm run check:links      # every internal link and asset in dist/ resolves
```

Every page has an **Edit page** link at the bottom. The site and the demo deploy to GitHub Pages from `main` with the *Docs site + demo → GitHub Pages* workflow.

## Design notes

- [docs/ANALYSIS.md](https://github.com/webmaxru/offlibrary/blob/main/docs/ANALYSIS.md): the analysis behind the design.
- [docs/ROADMAP.md](https://github.com/webmaxru/offlibrary/blob/main/docs/ROADMAP.md): what's shipped and what's next.
- [RELEASING.md](https://github.com/webmaxru/offlibrary/blob/main/RELEASING.md): how releases are published.

## License

[MIT](https://github.com/webmaxru/offlibrary/blob/main/LICENSE) © Maxim Salnikov. The range-request handling was inspired by [workbox-range-requests](https://developer.chrome.com/docs/workbox/modules/workbox-range-requests) (MIT); no code was copied. Demo audio: LibriVox, public domain.
