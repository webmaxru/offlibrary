---
title: Offline video course
description: Make lessons with video, subtitles and a poster available offline as single items with one progress bar.
sidebar:
  order: 2
---

A lesson is several files that only make sense together. Offlibrary stores them as **one multi-file item**: one progress bar, one status, one delete.

```js
import { createOfflibrary } from 'offlibrary';

const course = createOfflibrary({
  namespace: 'course-webperf',
  collections: {
    lessons: {
      strategy: 'background-fetch',     // big files: let the browser keep downloading with the tab closed
      maxBytes: 2 * 1024 ** 3,          // 2 GB for the whole course
      ui: { title: (lesson) => `Downloading ${lesson.title}` },
    },
  },
}).collection('lessons');

await course.download({
  id: 'lesson-03',
  title: 'Lesson 3: Core Web Vitals',
  urls: ['/media/l03-720p.mp4', '/media/l03.en.vtt', '/media/l03-poster.jpg'],
});
```

Play it with plain HTML. Each file is served from the device under its own URL, and seeking in the video is answered with `206` responses:

```html
<video controls src="/media/l03-720p.mp4" poster="/media/l03-poster.jpg">
  <track kind="subtitles" srclang="en" src="/media/l03.en.vtt" default />
</video>
```

## Show the whole course

```js
const lessons = await course.list();
const ready = lessons.filter((l) => l.status === 'completed').length;
summary.textContent = `${ready} of ${courseOutline.length} lessons available offline`;

const { bytes } = await course.usage();
```

## Tips

- **Quality choices.** Store the rendition the user picked as the item's first URL; `collection.match(id)` defaults to it.
- **Updating a lesson.** Give items a `version` (for example the encode date). Downloading the same `id` with a new version replaces the stored copy.
- **Free space first.** With `maxBytes`, the least recently watched lessons are evicted to fit a new one. Use `evict: 'none'` if you'd rather ask the user.
- **Mobile data.** Background Fetch follows the browser's own download behaviour. If you want "Wi-Fi only", check `navigator.connection` (Chromium) before calling `download()`.
