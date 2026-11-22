import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// GitHub Pages project site: https://cikick.github.io/cikick/
const site = process.env.DOCS_SITE ?? 'https://cikick.github.io';
const base = process.env.DOCS_BASE ?? '/cikick';

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: 'cikick',
      description: 'CDK for GitHub Actions: TypeScript constructs, synthesized to pinned YAML, with migrations and a fleet control plane.',
      logo: { src: './src/assets/logo.svg', alt: 'cikick' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/cikick/cikick' }],
      customCss: ['./src/styles/tokens.css', './src/styles/starlight.css'],
      editLink: { baseUrl: 'https://github.com/cikick/cikick/edit/main/docs-site/' },
      sidebar: [
        { label: 'Start here', items: [{ label: 'Overview', slug: 'docs' }] },
        {
          label: 'Concepts',
          items: [
            'docs/concepts/constructs-and-synth',
            'docs/concepts/lockfile-and-pinning',
            'docs/concepts/customisation',
            'docs/concepts/managed-files',
            'docs/concepts/checks',
            'docs/concepts/migrations',
            'docs/concepts/secrets',
            'docs/concepts/fleet',
          ],
        },
        {
          label: 'Guides',
          items: [
            'docs/guides/quickstart',
            'docs/guides/authoring-a-package',
            'docs/guides/renovate',
            'docs/guides/ci-check',
            'docs/guides/fleet-setup',
          ],
        },
        {
          label: 'Reference',
          items: [
            'docs/reference/cikick-cli',
            'docs/reference/cikick-fleet-cli',
            'docs/reference/fleet-config',
            'docs/reference/core',
            'docs/reference/policies',
          ],
        },
      ],
    }),
  ],
});
