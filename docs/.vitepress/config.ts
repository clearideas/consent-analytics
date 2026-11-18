import { defineConfig } from 'vitepress'

const repository = 'https://github.com/clearideas/consent-analytics'

export default defineConfig({
  title: 'Clear Ideas Consent Analytics',
  description:
    'Privacy-first analytics with a consent banner for any website, and the collector that stores what it sends: standalone or inside your own API.',
  cleanUrls: true,
  sitemap: { hostname: 'https://content-analytics.clearideas.com' },
  lastUpdated: true,
  appearance: true,
  // README.md explains the docs folder on GitHub; design notes are project history.
  srcExclude: ['README.md', 'design/**'],
  head: [
    ['meta', { name: 'theme-color', content: '#ffffff' }],
    ['meta', { name: 'color-scheme', content: 'light dark' }],
    ['link', { rel: 'icon', type: 'image/x-icon', href: '/icons/favicon.ico' }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/icons/apple-touch-icon.png' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/icons/favicon-32x32.png' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/icons/favicon-16x16.png' }],
    // Inter is served from this site (no third-party font requests).
    [
      'link',
      {
        rel: 'preload',
        href: '/fonts/inter-roman-latin.woff2',
        as: 'font',
        type: 'font/woff2',
        crossorigin: '',
      },
    ],
  ],
  markdown: {
    lineNumbers: false,
  },
  themeConfig: {
    siteTitle: 'Consent Analytics',
    logo: { src: '/clearideas-logo.svg', alt: 'Clear Ideas' },
    socialLinks: [{ icon: 'github', link: repository }],
    editLink: {
      pattern: `${repository}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Browser', link: '/browser/' },
      { text: 'Server', link: '/server/' },
      {
        text: 'Reference',
        items: [
          { text: 'Browser configuration', link: '/browser/configuration' },
          { text: 'Browser API', link: '/browser/api' },
          { text: 'Collector options', link: '/server/configuration' },
          { text: 'Data policy', link: '/server/data-policy' },
          { text: 'Stored data', link: '/server/stored-data' },
          { text: 'Standalone collector', link: '/server/collector' },
          { text: 'Collector API (v1)', link: '/api-contract' },
        ],
      },
    ],
    sidebar: [
      {
        text: 'Get started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Quick start', link: '/getting-started' },
          { text: 'Core concepts', link: '/concepts' },
          { text: 'Playground', link: '/playground' },
        ],
      },
      {
        text: 'Browser library',
        items: [
          { text: 'Overview', link: '/browser/' },
          { text: 'Add it to your site', link: '/browser/frameworks' },
          { text: 'Consent and the banner', link: '/browser/consent' },
          { text: 'Events and delivery', link: '/browser/events' },
          { text: 'Attribution and conversions', link: '/browser/attribution' },
          { text: 'Third-party tools', link: '/browser/third-party' },
          { text: 'Signed-in visitors', link: '/browser/identity' },
          { text: 'Privacy and security', link: '/browser/privacy-security' },
          { text: 'Troubleshooting', link: '/browser/troubleshooting' },
        ],
      },
      {
        text: 'Collector (server)',
        items: [
          { text: 'Overview', link: '/server/' },
          { text: 'Quick start', link: '/server/quickstart' },
          { text: 'How the collector works', link: '/server/concepts' },
          { text: 'Express', link: '/server/express' },
          { text: 'node:http and Fetch platforms', link: '/server/node-and-fetch' },
          { text: 'Sites, origins and location', link: '/server/sites-and-geo' },
          { text: 'Data policies', link: '/server/data-policy' },
          { text: 'Event rules', link: '/server/rules' },
          { text: 'Signed-in visitors', link: '/server/identity' },
          { text: 'Delivery and queues', link: '/server/delivery' },
          { text: 'Stores', link: '/server/storage' },
          { text: 'Redis and rate limits', link: '/server/redis' },
          { text: 'Retention and data requests', link: '/server/retention-and-privacy' },
          { text: 'Standalone collector', link: '/server/collector' },
          { text: 'Production guide', link: '/server/production' },
          { text: 'Custom adapters', link: '/server/custom-adapters' },
          { text: 'Troubleshooting', link: '/server/troubleshooting' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Browser configuration', link: '/browser/configuration' },
          { text: 'Browser API', link: '/browser/api' },
          { text: 'Collector options', link: '/server/configuration' },
          { text: 'Stored data', link: '/server/stored-data' },
          { text: 'Collector API (v1)', link: '/api-contract' },
        ],
      },
    ],
    search: { provider: 'local', options: { detailedView: true } },
    outline: { level: [2, 3], label: 'On this page' },
    docFooter: { prev: 'Previous', next: 'Next' },
    lastUpdated: {
      text: 'Last updated',
      formatOptions: { dateStyle: 'medium', timeStyle: 'short' },
    },
  },
})
