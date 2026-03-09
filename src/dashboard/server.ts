import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { LoadedWorkflowContract } from '../workflow/contract.js';
import type { RuntimeStateSnapshot } from '../orchestrator/runtime.js';
import type { Logger } from '../logging/logger.js';

export interface DashboardServerOptions {
  host?: string;
  port: number;
  logger: Logger;
  getSnapshot: () => RuntimeStateSnapshot;
  getWorkflow?: () => LoadedWorkflowContract;
}

export interface DashboardServerHandle {
  stop(): Promise<void>;
}

interface DashboardPayload {
  generatedAt: string;
  summary: {
    running: number;
    claimed: number;
    retrying: number;
    completed: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    aggregateRuntimeSeconds: number;
    liveAggregateRuntimeSeconds: number;
  };
  health: {
    status: 'healthy' | 'busy';
    latestRateLimit: RuntimeStateSnapshot['latestRateLimit'];
  };
  workflow?: {
    tracker: string;
    owner: string;
    projectNumber: number;
    pollIntervalMs: number;
    maxConcurrency: number | null;
    workspaceRoot?: string;
  };
  running: RuntimeStateSnapshot['runningDetails'];
  retrying: RuntimeStateSnapshot['retryingDetails'];
  claimed: string[];
  completed: string[];
  retryAttempts: Record<string, number>;
}

export async function startDashboardServer(options: DashboardServerOptions): Promise<DashboardServerHandle> {
  const server = createServer((req, res) => {
    void handleRequest(req, res, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const bind = typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : String(options.port);
  options.logger.info('dashboard.started', { bind });

  return {
    async stop(): Promise<void> {
      await closeServer(server);
      options.logger.info('dashboard.stopped');
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: DashboardServerOptions,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (method === 'GET' && url.pathname === '/') {
    sendHtml(res, renderHtml());
    return;
  }

  if (method === 'GET' && url.pathname === '/dashboard.css') {
    sendText(res, DASHBOARD_CSS, 'text/css; charset=utf-8');
    return;
  }

  if (method === 'GET' && url.pathname === '/dashboard.js') {
    sendText(res, DASHBOARD_JS, 'text/javascript; charset=utf-8');
    return;
  }

  if (method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, buildPayload(options));
    return;
  }

  sendJson(res, { error: 'not_found' }, 404);
}

function buildPayload(options: DashboardServerOptions): DashboardPayload {
  const snapshot = options.getSnapshot();
  const workflow = options.getWorkflow?.();

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      running: snapshot.running.length,
      claimed: snapshot.claimed.length,
      retrying: snapshot.retryingDetails.length,
      completed: snapshot.completed.length,
      totalTokens: snapshot.liveUsageTotals.totalTokens,
      inputTokens: snapshot.liveUsageTotals.inputTokens,
      outputTokens: snapshot.liveUsageTotals.outputTokens,
      aggregateRuntimeSeconds: snapshot.aggregateRuntimeSeconds,
      liveAggregateRuntimeSeconds: snapshot.liveAggregateRuntimeSeconds,
    },
    health: {
      status: snapshot.running.length > 0 || snapshot.retryingDetails.length > 0 ? 'busy' : 'healthy',
      latestRateLimit: snapshot.latestRateLimit,
    },
    workflow: workflow
      ? {
          tracker: workflow.tracker.kind,
          owner: workflow.tracker.github.owner,
          projectNumber: workflow.tracker.github.projectNumber,
          pollIntervalMs: workflow.polling.intervalMs,
          maxConcurrency: workflow.polling.maxConcurrency ?? null,
          workspaceRoot: workflow.workspace.root ?? workflow.workspace.baseDir,
        }
      : undefined,
    running: snapshot.runningDetails,
    retrying: snapshot.retryingDetails,
    claimed: snapshot.claimed,
    completed: snapshot.completed,
    retryAttempts: snapshot.retryAttempts,
  };
}

function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Symphony for GitHub Projects Dashboard</title>
    <link rel="stylesheet" href="/dashboard.css" />
  </head>
  <body>
    <main class="shell">
      <header class="hero-card">
        <div>
          <p class="eyebrow">Symphony for GitHub Projects</p>
          <h1>Operations Dashboard</h1>
          <p class="hero-copy">Local runtime observability for running work, retry pressure, and rate-limit state.</p>
        </div>
        <div class="hero-actions">
          <span id="health-badge" class="badge">Loading…</span>
          <button id="refresh-button" class="button" type="button">Refresh</button>
        </div>
      </header>

      <section class="metrics" id="metrics"></section>

      <section class="card grid-2">
        <div>
          <div class="section-header"><h2>Workflow</h2><span id="generated-at" class="muted"></span></div>
          <dl id="workflow-meta" class="meta-list"></dl>
        </div>
        <div>
          <div class="section-header"><h2>Rate limit / health</h2></div>
          <pre id="rate-limit" class="code-block">Loading…</pre>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>Running sessions</h2></div>
        <div id="running-table"></div>
      </section>

      <section class="card">
        <div class="section-header"><h2>Retry queue</h2></div>
        <div id="retry-table"></div>
      </section>
    </main>
    <script src="/dashboard.js" defer></script>
  </body>
</html>`;
}

function sendJson(res: ServerResponse, payload: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, payload: string, contentType: string): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.end(payload);
}

function sendHtml(res: ServerResponse, payload: string): void {
  sendText(res, payload, 'text/html; charset=utf-8');
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const DASHBOARD_CSS = `
:root {
  color-scheme: dark;
  --bg: #0b1020;
  --panel: rgba(15, 23, 42, 0.9);
  --panel-2: rgba(30, 41, 59, 0.7);
  --text: #e5eefb;
  --muted: #93a4bf;
  --accent: #7dd3fc;
  --danger: #fca5a5;
  --warn: #fde68a;
  --ok: #86efac;
  --border: rgba(148, 163, 184, 0.18);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  background: radial-gradient(circle at top, #16213d 0%, var(--bg) 55%);
  color: var(--text);
}
.shell { max-width: 1180px; margin: 0 auto; padding: 32px 20px 48px; }
.hero-card, .card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 20px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.22);
}
.hero-card {
  display: flex; justify-content: space-between; gap: 24px; padding: 28px; align-items: flex-start; margin-bottom: 20px;
}
.eyebrow { margin: 0 0 8px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.12em; font-size: 12px; }
h1 { margin: 0 0 10px; font-size: 40px; }
.hero-copy { margin: 0; color: var(--muted); max-width: 760px; }
.hero-actions { display: flex; align-items: center; gap: 12px; }
.badge, .pill {
  display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 8px 12px; font-size: 13px; background: var(--panel-2);
}
.button {
  border: 1px solid var(--border); background: transparent; color: var(--text); padding: 10px 14px; border-radius: 12px; cursor: pointer;
}
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 20px; }
.metric-card {
  background: var(--panel); border: 1px solid var(--border); border-radius: 18px; padding: 18px;
}
.metric-label { color: var(--muted); font-size: 13px; margin: 0 0 10px; }
.metric-value { margin: 0 0 8px; font-size: 32px; font-weight: 700; }
.metric-detail { margin: 0; color: var(--muted); font-size: 13px; }
.card { padding: 22px; margin-bottom: 20px; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
.section-header { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; margin-bottom: 16px; }
.section-header h2 { margin: 0; font-size: 22px; }
.meta-list { display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; margin: 0; }
.meta-list dt { color: var(--muted); }
.meta-list dd { margin: 0; }
.code-block {
  background: #020617; color: #cbd5e1; padding: 14px; border-radius: 14px; overflow: auto; min-height: 140px; border: 1px solid var(--border);
}
.table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: 14px; }
table { width: 100%; border-collapse: collapse; min-width: 680px; }
th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
tr:last-child td { border-bottom: none; }
.empty { color: var(--muted); margin: 0; }
.muted { color: var(--muted); }
.status-healthy { background: rgba(34, 197, 94, 0.16); color: var(--ok); }
.status-busy { background: rgba(250, 204, 21, 0.16); color: var(--warn); }
.pill-warning { background: rgba(250, 204, 21, 0.16); color: var(--warn); }
.pill-danger { background: rgba(248, 113, 113, 0.16); color: var(--danger); }
@media (max-width: 720px) {
  .hero-card { flex-direction: column; }
  h1 { font-size: 32px; }
}
`;

const DASHBOARD_JS = `
const metricsEl = document.getElementById('metrics');
const workflowEl = document.getElementById('workflow-meta');
const rateLimitEl = document.getElementById('rate-limit');
const runningEl = document.getElementById('running-table');
const retryEl = document.getElementById('retry-table');
const refreshButton = document.getElementById('refresh-button');
const generatedAtEl = document.getElementById('generated-at');
const healthBadgeEl = document.getElementById('health-badge');

const numberFmt = new Intl.NumberFormat('en-US');

function formatSeconds(total) {
  const seconds = Math.max(0, Number(total || 0));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins + 'm ' + secs + 's';
}

function metricCard(label, value, detail) {
  return '<article class="metric-card">' +
    '<p class="metric-label">' + label + '</p>' +
    '<p class="metric-value">' + value + '</p>' +
    '<p class="metric-detail">' + detail + '</p>' +
  '</article>';
}

function renderMeta(payload) {
  const rows = [];
  if (payload.workflow) {
    rows.push(['Tracker', payload.workflow.tracker]);
    rows.push(['Owner', payload.workflow.owner]);
    rows.push(['Project', '#' + payload.workflow.projectNumber]);
    rows.push(['Poll interval', numberFmt.format(payload.workflow.pollIntervalMs) + ' ms']);
    rows.push(['Max concurrency', payload.workflow.maxConcurrency == null ? 'n/a' : String(payload.workflow.maxConcurrency)]);
    rows.push(['Workspace root', payload.workflow.workspaceRoot || 'n/a']);
  } else {
    rows.push(['Workflow', 'Unavailable']);
  }
  workflowEl.innerHTML = rows.map(([k, v]) => '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(v) + '</dd>').join('');
}

function renderTable(container, columns, rows) {
  if (!rows.length) {
    container.innerHTML = '<p class="empty">Nothing here right now.</p>';
    return;
  }
  const thead = '<thead><tr>' + columns.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead>';
  const tbody = '<tbody>' + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</tbody>';
  container.innerHTML = '<div class="table-wrap"><table>' + thead + tbody + '</table></div>';
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function refresh() {
  const response = await fetch('/api/state', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Failed to load dashboard state: ' + response.status);
  }
  const payload = await response.json();
  metricsEl.innerHTML = [
    metricCard('Running', numberFmt.format(payload.summary.running), 'Active runtime entries'),
    metricCard('Retrying', numberFmt.format(payload.summary.retrying), 'Queued for continuation or failure retry'),
    metricCard('Claimed', numberFmt.format(payload.summary.claimed), 'Reserved dispatch slots'),
    metricCard('Completed', numberFmt.format(payload.summary.completed), 'Completed during this process lifetime'),
    metricCard('Total tokens', numberFmt.format(payload.summary.totalTokens), 'Input ' + numberFmt.format(payload.summary.inputTokens) + ' / Output ' + numberFmt.format(payload.summary.outputTokens)),
    metricCard('Runtime', formatSeconds(payload.summary.liveAggregateRuntimeSeconds), 'Live aggregate worker runtime'),
    metricCard('Completed runtime', formatSeconds(payload.summary.aggregateRuntimeSeconds), 'Completed worker runtime only')
  ].join('');

  generatedAtEl.textContent = new Date(payload.generatedAt).toLocaleString();
  healthBadgeEl.textContent = payload.health.status === 'busy' ? 'Busy' : 'Healthy';
  healthBadgeEl.className = 'badge ' + (payload.health.status === 'busy' ? 'status-busy' : 'status-healthy');
  rateLimitEl.textContent = JSON.stringify(payload.health.latestRateLimit ?? { status: payload.health.status }, null, 2);
  renderMeta(payload);

  renderTable(
    runningEl,
    ['Issue', 'Session', 'Runtime', 'Item ID'],
    payload.running.map((entry) => [
      escapeHtml(entry.issueIdentifier),
      escapeHtml(entry.sessionId || 'n/a'),
      escapeHtml(formatSeconds(entry.runtimeSeconds)),
      escapeHtml(entry.itemId)
    ])
  );

  renderTable(
    retryEl,
    ['Issue', 'Attempt', 'Kind', 'Due at', 'Item ID'],
    payload.retrying.map((entry) => [
      escapeHtml(entry.issueIdentifier),
      escapeHtml(entry.attempt),
      '<span class="pill ' + (entry.kind === 'failure' ? 'pill-danger' : 'pill-warning') + '">' + escapeHtml(entry.kind) + '</span>',
      escapeHtml(entry.dueAt),
      escapeHtml(entry.itemId)
    ])
  );
}

async function runRefresh() {
  try {
    await refresh();
  } catch (error) {
    rateLimitEl.textContent = String(error);
  }
}

refreshButton.addEventListener('click', () => { void runRefresh(); });
void runRefresh();
setInterval(() => { void runRefresh(); }, 5000);
`;
