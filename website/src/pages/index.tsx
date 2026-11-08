import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import CodeBlock from '@theme/CodeBlock';
import Layout from '@theme/Layout';
import ThemedImage from '@theme/ThemedImage';
import { McpInstallButton } from 'docusaurus-plugin-mcp-server/theme';
import runReport from '../../../docs/img/run-report.png';
import styles from './index.module.css';

interface Feature {
  title: string;
  body: string;
  to: string;
}

const features: Feature[] = [
  {
    title: 'Playwright tests for tools',
    body: 'The mcp fixture connects over stdio or HTTP. Call a tool, then check the result with matchers for text, schemas, snapshots and errors. Fast, deterministic, free.',
    to: '/docs/assertions',
  },
  {
    title: 'Evals on real clients',
    body: 'Run the same cases on the api client, Claude Code, the Codex CLI, Cowork, ChatGPT and the Codex app, and see which tools each one calls.',
    to: '/docs/mst-client',
  },
  {
    title: 'Judges you can trust',
    body: 'Score answers with rubric and plugin judges, label a sample yourself with mst label, and measure a judge against your labels with mst judges check.',
    to: '/docs/judges',
  },
  {
    title: 'Both protocol eras',
    body: 'Test the initialize handshake and the 2026-07-28 protocol from one config, with conformance checks for the era the server speaks.',
    to: '/docs/protocol-versions',
  },
  {
    title: 'Desktop clients in Docker',
    body: 'Run Cowork and ChatGPT evals in disposable Linux containers, one per shard, while your machine stays usable.',
    to: '/docs/cowork-docker',
  },
  {
    title: 'A report for every run',
    body: 'Every eval run writes a report that says whether each variant beat the baseline, with every case and trial behind the answer.',
    to: '/docs/ui-reporter',
  },
  {
    title: 'Plugins for the rest',
    body: 'Datasets, clients, judges, connectors, environments and result stores are all extension kinds. Your organization adds its own in a plugin.',
    to: '/docs/evaluation-framework',
  },
  {
    title: 'Agent Skills over MCP',
    body: 'Test and evaluate the skills a server serves through the MCP skills extension, and check whether the model loads them when it should.',
    to: '/docs/skills',
  },
];

const testExample = `import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('read_file returns file contents', async ({ mcp }) => {
  const result = await mcp.callTool('read_file', { path: '/tmp/test.txt' });
  expect(result).toContainToolText('Hello, world');
  expect(result).not.toBeToolError();
});`;

const evalExample = `{
  "id": "read-config",
  "input": "What version is set in the app's config file?",
  "trials": 5,
  "assertions": {
    "toolsTriggered": { "calls": [{ "name": "read_file", "required": true }] },
    "containsText": "1.0.0"
  }
}`;

function Hero(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={styles.hero}>
      <div className="container">
        <ThemedImage
          className={styles.mark}
          alt="MST logo: a check between square brackets"
          sources={{
            light: useBaseUrl('/mst-mark.svg'),
            dark: useBaseUrl('/mst-mark-dark.svg'),
          }}
        />
        <h1 className={styles.title}>MST (MCP Server Tester)</h1>
        <p className={styles.tagline}>{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--primary button--lg"
            to="/docs/quickstart"
          >
            Get started
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/docs/evals-guide"
          >
            Read the evals guide
          </Link>
        </div>
        <code className={styles.install}>
          npx @gleanwork/mcp-server-tester@rc init
        </code>
      </div>
    </header>
  );
}

function Features(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2>What's in 2.0</h2>
        <div className={styles.grid}>
          {features.map((feature) => (
            <Link key={feature.title} to={feature.to} className={styles.card}>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function TestsAndEvals(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2>Tests and evals</h2>
        <p className={styles.lead}>
          A test calls a tool directly and checks what it returns. An eval gives
          a client a task, lets its model pick the tools, and grades what it did
          over several trials. MST runs both.
        </p>
        <div className={styles.split}>
          <div>
            <h3>A tool test</h3>
            <CodeBlock language="typescript">{testExample}</CodeBlock>
          </div>
          <div>
            <h3>An eval case</h3>
            <CodeBlock language="json">{evalExample}</CodeBlock>
          </div>
        </div>
        <img
          className={styles.screenshot}
          src={runReport}
          alt="The run report: each variant compared with the baseline, and the cases behind it"
        />
      </div>
    </section>
  );
}

function ForAgents(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2>Ask your AI about MST</h2>
        <p className={styles.lead}>
          These docs are also an MCP server. Connect your coding agent and it
          can search and read every page, and load MST's skills for writing
          tests and evals.
        </p>
        <div className={styles.agentRow}>
          <McpInstallButton
            label="Install the docs MCP server"
            headerText="Connect the MST docs to:"
          />
          <span className={styles.or}>or install the skills directly:</span>
          <code>npx skills add gleanwork/mcp-server-tester</code>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout description="Playwright tests, evals on real AI clients, calibrated judges and protocol conformance for Model Context Protocol servers.">
      <Hero />
      <main>
        <Features />
        <TestsAndEvals />
        <ForAgents />
      </main>
    </Layout>
  );
}
