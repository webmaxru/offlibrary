Offlibrary has three entry points. Every page below is generated from the TSDoc comments in the source, so it always matches the published types.

| Entry | Runs in | Main exports |
|---|---|---|
| `offlibrary` | the page | `createOfflibrary`, `Offlibrary`, `Collection`, `OfflibraryError`, `formatBytes`, `isBackgroundFetchSupported` |
| `offlibrary/sw` | your service worker | `offlibrarySW`, `matchOfflibrary`, `isOfflibraryRequest`, `handleBackgroundFetchEvent`, `createRangeResponse`, `parseRange`, `verifyIntegrity` |
| `offlibrary/workbox` | a Workbox service worker | `OfflibraryPlugin`, `offlibraryMatch`, `offlibraryHandler`, `initOfflibrary` |

Prefer prose? See the [configuration reference](/offlibrary/reference/configuration/), [library and collection methods](/offlibrary/reference/collection/) and [Workbox overview](/offlibrary/workbox/).
