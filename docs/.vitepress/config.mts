import { defineConfig } from 'vitepress'

const REPO = 'opria123/octave'

export default defineConfig({
  title: 'OCTAVE',
  description: 'Orchestrated Chart & Track Authoring Visual Editor — a desktop chart editor for rhythm games like YARG and Clone Hero.',
  lang: 'en-US',
  base: '/octave/',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'dark',

  head: [
    ['link', { rel: 'icon', href: '/octave/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#00F2FE' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'OCTAVE — Chart Editor' }],
    ['meta', { property: 'og:description', content: 'A desktop chart editor for rhythm games like YARG and Clone Hero.' }],
    ['meta', { property: 'og:image', content: `https://${REPO.split('/')[0]}.github.io/octave/screenshots/editor-overview.png` }]
  ],

  themeConfig: {
    logo: '/octave-mark.svg',
    siteTitle: 'OCTAVE',

    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/keyboard-shortcuts', activeMatch: '/reference/' },
      { text: 'Troubleshooting', link: '/troubleshooting/auto-chart-issues', activeMatch: '/troubleshooting/' },
      { text: 'Download', link: `https://github.com/${REPO}/releases/latest` },
      { text: 'GitHub', link: `https://github.com/${REPO}` }
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Installation & First Launch', link: '/guide/getting-started' },
            { text: 'Editor Layout', link: '/guide/editor-layout' }
          ]
        },
        {
          text: 'Editing',
          items: [
            { text: 'MIDI Editor', link: '/guide/midi-editor' },
            { text: 'Chart Preview (3D Highway)', link: '/guide/chart-preview' },
            { text: 'Project Explorer', link: '/guide/project-explorer' },
            { text: 'Property Panel', link: '/guide/property-panel' }
          ]
        },
        {
          text: 'Audio',
          items: [
            { text: 'Stems Mixer', link: '/guide/stems-mixer' }
          ]
        },
        {
          text: 'Auto-Chart',
          items: [
            { text: 'Overview', link: '/guide/auto-chart' },
            { text: 'Advanced Options', link: '/guide/auto-chart-advanced' }
          ]
        },
        {
          text: 'Output',
          items: [
            { text: 'Saving & Exporting', link: '/guide/exporting' }
          ]
        }
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Keyboard Shortcuts', link: '/reference/keyboard-shortcuts' },
            { text: 'Settings', link: '/reference/settings' },
            { text: 'File Formats', link: '/reference/file-formats' }
          ]
        }
      ],
      '/troubleshooting/': [
        {
          text: 'Troubleshooting',
          items: [
            { text: 'Auto-Chart Issues', link: '/troubleshooting/auto-chart-issues' },
            { text: 'Python Runtime Setup', link: '/troubleshooting/runtime-setup' },
            { text: 'Common Issues', link: '/troubleshooting/common-issues' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: `https://github.com/${REPO}` }
    ],

    editLink: {
      pattern: `https://github.com/${REPO}/edit/master/docs/:path`,
      text: 'Edit this page on GitHub'
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: `Copyright © ${new Date().getFullYear()} opria123`
    },

    search: {
      provider: 'local'
    }
  }
})
