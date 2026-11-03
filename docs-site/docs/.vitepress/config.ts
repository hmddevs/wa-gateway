// Developed by HMD Developments
// For HMD WA Gateway
// www.hmddevs.org

import { createRequire } from 'node:module';
import { defineConfig } from 'vitepress';

// Pages are served from the shared docs/ folder outside this package's
// node_modules tree; resolve vitepress's runtime deps explicitly so Vite's
// bundler can find them from that external root.
const require = createRequire(import.meta.url);

export default defineConfig({
  title: 'HMD WA Gateway',
  description: 'Self-hosted WhatsApp messaging gateway, source and documentation.',
  // Resolved relative to the project root (this docs/ folder, where
  // .vitepress lives), landing on the shared docs/ folder at the repo root.
  // The markdown source of truth stays there; nothing is copied here.
  srcDir: '../../docs',
  srcExclude: ['CONTRIBUTING.md', 'SMOKE.md'],
  cleanUrls: true,
  vite: {
    resolve: {
      alias: [
        { find: /^vue\/server-renderer$/, replacement: require.resolve('vue/server-renderer') },
        { find: /^vue$/, replacement: require.resolve('vue') },
      ],
    },
  },
  themeConfig: {
    search: { provider: 'local' },
    nav: [
      { text: 'Self-hosting', link: '/SELF_HOSTING' },
      { text: 'API', link: '/API' },
      { text: 'SDK', link: '/SDK' },
    ],
    sidebar: [
      {
        text: 'Get started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Integration', link: '/INTEGRATION' },
          { text: 'Self-hosting', link: '/SELF_HOSTING' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API reference', link: '/API' },
          { text: 'SDK reference', link: '/SDK' },
          { text: 'Architecture', link: '/ARCHITECTURE' },
          { text: 'Organization routing', link: '/ORGANIZATIONS' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Monitoring', link: '/MONITORING' },
          { text: 'Security', link: '/SECURITY' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/hmddevs/wa-gateway' }],
    footer: {
      message: 'Developed by HMD Developments',
    },
  },
});
