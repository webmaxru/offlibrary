# Offlibrary Radio (demo)

A small podcast PWA that shows the library at work:

- **9 episodes** of public-domain short stories ([LibriVox Short Story Collection 006](https://librivox.org/short-story-collection-006/)), streamed and downloaded straight from the [Internet Archive](https://archive.org/details/stories_006_librivox). That host sends CORS and `Range` headers, and that's all Offlibrary needs.
- **Two transports side by side.** With the default `auto` strategy, episodes of 5 MB or more use Background Fetch and smaller ones use streaming fetch. The *Transport* switch can force fetch only, which is what Safari and Firefox users get.
- **Live progress, pause/resume (fetch), cancel, retry, delete**, plus a **storage meter** with persistent-storage status.
- **Offline playback with seeking.** The service worker answers the `<audio>` element's range requests from the stored copy.
- **Installable** (manifest, icons, maskable icon). The app shell is cached, so the UI opens offline too.

## Run locally

```bash
npm install
npm run demo        # builds the library + demo and serves demo/dist on http://127.0.0.1:5173
```

Service workers need `localhost`/`127.0.0.1` or HTTPS.

## Files

| File | What it does |
|---|---|
| `src/app.js` | UI. Everything goes through `createOfflibrary()` and `library.collection('episodes')` |
| `src/sw.js` | `offlibrarySW()` plus a small app-shell cache |
| `public/episodes.json` | The feed: titles, sizes, durations, archive.org URLs, and the license note |
| `../scripts/build-demo.mjs` | Bundles to `demo/dist` (deployed to GitHub Pages by `.github/workflows/pages.yml`) |

## License of the content

LibriVox recordings are in the public domain, and so are the texts. See the [LibriVox public-domain policy](https://librivox.org/pages/public-domain/). The icons were drawn for this demo and are MIT-licensed like the rest of the repo.
