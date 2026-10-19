// Copies ../CHANGELOG.md into the docs as src/content/docs/changelog.md (generated, git-ignored).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
const body = src.replace(/^# Changelog\s*\n/, '');
const out = `---
title: Changelog
description: Every Offlibrary release and what changed. Generated from CHANGELOG.md in the repository.
editUrl: https://github.com/webmaxru/offlibrary/edit/main/CHANGELOG.md
tableOfContents:
  maxHeadingLevel: 2
---

${body}`;
mkdirSync(new URL('../src/content/docs/', import.meta.url), { recursive: true });
writeFileSync(new URL('../src/content/docs/changelog.md', import.meta.url), out);
console.log('changelog.md synced from CHANGELOG.md');
