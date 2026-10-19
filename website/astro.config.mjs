// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';

// Project Pages: https://webmaxru.github.io/offlibrary/ (served at https://salnikov.no/offlibrary/ while the
// owner's user site has that custom domain). The Pages workflow passes the real origin and base path.
const site = process.env.SITE_ORIGIN || 'https://salnikov.no';
const base = process.env.SITE_BASE || '/offlibrary';
const repo = 'https://github.com/webmaxru/offlibrary';

const [apiTypeDoc, apiTypeDocSidebar] = createStarlightTypeDocPlugin();

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Offlibrary',
      description:
        'Declarative offline asset management for the web: Background Fetch when available, a resumable streaming fallback when not, with quota, eviction and offline seeking built in.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      social: [
        { icon: 'github', label: 'GitHub', href: repo },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/offlibrary' },
      ],
      editLink: { baseUrl: `${repo}/edit/main/website/` },
      lastUpdated: true,
      customCss: ['./src/styles/custom.css'],
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: `${site}${base}/og.png` } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
      components: {
        Footer: './src/components/Footer.astro',
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Introduction', slug: 'introduction' },
            { label: 'Getting started', slug: 'getting-started' },
            { label: 'Browser support', slug: 'browser-support' },
            { label: 'Live demo', link: '/demo/', attrs: { target: '_blank' }, badge: { text: 'PWA', variant: 'tip' } },
          ],
        },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        {
          label: 'Workbox',
          items: [
            { label: 'Overview', slug: 'workbox' },
            { label: 'Setup', slug: 'workbox/setup' },
            { label: 'The route', slug: 'workbox/route' },
            { label: 'OfflibraryPlugin', slug: 'workbox/plugin' },
            { label: 'Background Fetch', slug: 'workbox/background-fetch' },
            { label: 'Precaching and RangeRequestsPlugin', slug: 'workbox/precaching-and-ranges' },
            { label: 'Migrating from offlibrarySW()', slug: 'workbox/migration' },
            { label: 'Troubleshooting', slug: 'workbox/troubleshooting' },
          ],
        },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration', slug: 'reference/configuration' },
            { label: 'Library and collection', slug: 'reference/collection' },
            { label: 'Service worker exports', slug: 'reference/service-worker' },
            { label: 'Errors', slug: 'reference/errors' },
            apiTypeDocSidebar,
          ],
        },
        {
          label: 'Project',
          items: [
            { label: 'FAQ', slug: 'faq' },
            { label: 'Changelog', slug: 'changelog' },
            { label: 'Contributing', slug: 'contributing' },
          ],
        },
      ],
      plugins: [
        apiTypeDoc({
          entryPoints: ['../src/index.ts', '../src/sw.ts', '../src/workbox.ts'],
          tsconfig: '../tsconfig.json',
          output: 'api',
          sidebar: { label: 'API (generated)', collapsed: true },
          typeDoc: {
            readme: './typedoc-readme.md',
            name: 'API reference',
            excludeInternal: true,
            excludePrivate: true,
            excludeExternals: true,
            disableGit: true,
            gitRevision: 'main',
            basePath: '..',
            sourceLinkTemplate: `${repo}/blob/{gitRevision}/src/{path}#L{line}`,
            parametersFormat: 'table',
            enumMembersFormat: 'table',
            useCodeBlocks: true,
          },
        }),
        starlightLinksValidator({ errorOnLocalLinks: false, exclude: ['/offlibrary/demo/', '/offlibrary/demo/**'] }),
      ],
    }),
  ],
});
