import { createRoot } from 'react-dom/client';
import type { HistoryIndex, MCPRunReportData } from './types';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RunReport } from './components/RunReport/RunReport';
import { HistoryPage } from './components/History/HistoryPage';

/** A run's report (`mst open`): what `mst run` and the Playwright reporter write. */
function RunReportApp({ data }: { data: MCPRunReportData }) {
  return (
    <Layout>
      <ErrorBoundary>
        <div className="h-full overflow-auto">
          <RunReport data={data} />
        </div>
      </ErrorBoundary>
    </Layout>
  );
}

/** An eval's history (`mst open --history`): its runs over time. */
function HistoryApp({ data }: { data: HistoryIndex }) {
  return (
    <Layout>
      <ErrorBoundary>
        <div className="h-full overflow-auto">
          <HistoryPage data={data} />
        </div>
      </ErrorBoundary>
    </Layout>
  );
}

function NoData() {
  return (
    <p className="p-8 text-muted-foreground">
      This report has no data. Open a run with <code>mst open</code>, which
      writes the report from the run&apos;s files.
    </p>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    window.MST_HISTORY ? (
      <HistoryApp data={window.MST_HISTORY} />
    ) : window.MST_RUN_REPORT ? (
      <RunReportApp data={window.MST_RUN_REPORT} />
    ) : (
      <NoData />
    )
  );
}
