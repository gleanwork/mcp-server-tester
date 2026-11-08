import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import type { McpServerPluginOptions } from 'docusaurus-plugin-mcp-server';
import { themes as prismThemes } from 'prism-react-renderer';
import repoLinks, { type RepoLinksOptions } from './src/remark/repoLinks.mts';

const siteDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(siteDir, '..');

/** The package this site documents, so the site shows the version it was built from. */
const pkg = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
) as { version: string };

const repoUrl = 'https://github.com/gleanwork/mcp-server-tester';
const npmUrl = 'https://www.npmjs.com/package/@gleanwork/mcp-server-tester';

// The production URL. The MCP server builds every page URL it returns from
// this, so it must match the Vercel project's production domain; change it
// here if that domain changes. Preview builds use it too, so their links point
// at production. Override with SITE_URL, for example when serving the build
// locally.
const siteUrl =
  process.env.SITE_URL ?? 'https://mcp-server-tester-docs.vercel.app';

const repoLinkOptions: RepoLinksOptions = {
  repoRoot,
  docsDir: path.join(repoRoot, 'docs'),
  repoUrl,
  branch: 'main',
};

const config: Config = {
  title: 'MST',
  tagline: 'Testing, evals, and conformance for MCP servers',
  favicon: 'favicon.svg',

  url: siteUrl,
  baseUrl: '/',
  trailingSlash: false,

  organizationName: 'gleanwork',
  projectName: 'mcp-server-tester',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  customFields: {
    packageVersion: pkg.version,
    repoUrl,
    npmUrl,
  },

  markdown: {
    // The pages in docs/ are GitHub Markdown, not MDX: `{`, `<` and HTML
    // comments in them mean what they mean on GitHub. A page that needs a
    // component becomes .mdx.
    format: 'detect',
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  future: {
    v4: true,
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  // The brand files in assets/brand/ are served from the site root, so the
  // site uses the same files as the README.
  staticDirectories: ['../assets/brand'],

  themes: ['@docusaurus/theme-mermaid'],

  presets: [
    [
      'classic',
      {
        docs: {
          // The docs stay in the repo's docs/ directory, one copy that reads
          // the same on GitHub and here. Their snippets are checked by
          // `npm run docs:check` at the repo root.
          path: '../docs',
          routeBasePath: 'docs',
          sidebarPath: './sidebars.ts',
          editUrl: ({ docPath }) => `${repoUrl}/edit/main/docs/${docPath}`,
          // Keep URLs the same as file names: ADRs are 0001-name.md, and
          // migrations are named for versions.
          numberPrefixParser: false,
          beforeDefaultRemarkPlugins: [[repoLinks, repoLinkOptions]],
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    // The build writes build/mcp/bundle.json, and api/mcp.mjs serves it at
    // /mcp: docs_search, docs_fetch, and the skills in the repo's skills/
    // directory, the same ones `npx skills add gleanwork/mcp-server-tester`
    // installs.
    [
      'docusaurus-plugin-mcp-server',
      {
        server: {
          name: 'mcp-server-tester',
          version: pkg.version,
        },
        skills: { dir: '../skills' },
      } satisfies McpServerPluginOptions,
    ],
  ],

  themeConfig: {
    image: 'mst-mark.svg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    docs: {
      sidebar: {
        hideable: true,
      },
    },
    navbar: {
      title: 'MST',
      logo: {
        alt: 'MST logo: a check between square brackets',
        src: 'mst-mark.svg',
        srcDark: 'mst-mark-dark.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'guides',
          position: 'left',
          label: 'Guides',
        },
        {
          type: 'docSidebar',
          sidebarId: 'reference',
          position: 'left',
          label: 'Reference',
        },
        {
          type: 'docSidebar',
          sidebarId: 'internals',
          position: 'left',
          label: 'Internals',
        },
        {
          href: `${repoUrl}/blob/main/CHANGELOG.md`,
          label: `v${pkg.version}`,
          position: 'right',
        },
        {
          type: 'custom-mcpInstall',
          position: 'right',
        },
        {
          href: repoUrl,
          position: 'right',
          className: 'header-github-link',
          'aria-label': 'GitHub repository',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Quick start', to: '/docs/quickstart' },
            { label: 'Evals guide', to: '/docs/evals-guide' },
            { label: 'CLI', to: '/docs/cli' },
            {
              label: 'Migrating to 2.0',
              to: '/docs/migrations/migration-2.0',
            },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'GitHub', href: repoUrl },
            { label: 'npm', href: npmUrl },
            { label: 'Changelog', href: `${repoUrl}/blob/main/CHANGELOG.md` },
            { label: 'Issues', href: `${repoUrl}/issues` },
          ],
        },
        {
          title: 'Related',
          items: [
            {
              label: 'Model Context Protocol',
              href: 'https://modelcontextprotocol.io',
            },
            { label: 'Playwright', href: 'https://playwright.dev' },
            { label: 'Agent Skills', href: 'https://agentskills.io' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Glean Contributors. MIT licensed.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'yaml', 'docker', 'diff'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
