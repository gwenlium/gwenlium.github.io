import configuration from '../../content/analytics.json';
import { editorConfig } from '../../lib/editor-config';
import { node, openDialog } from './ui';

interface AnalyticsSummary {
  pageViews: number;
  visits: number;
  daily: { label: string; views: number }[];
  pages: { label: string; views: number }[];
  referrers: { label: string; views: number }[];
}

const number = new Intl.NumberFormat('en');

function table(title: string, heading: string, values: { label: string; views: number }[]): HTMLElement {
  const section = node('section');
  section.append(node('h3', title));
  const element = node('table', undefined, 'owner-table');
  const head = node('thead');
  const row = node('tr');
  row.append(Object.assign(node('th', heading), { scope: 'col' }), Object.assign(node('th', 'Views'), { scope: 'col' }));
  head.append(row);
  const body = node('tbody');
  if (!values.length) {
    const empty = node('tr');
    const cell = node('td', 'No visits in this period.');
    cell.colSpan = 2;
    empty.append(cell);
    body.append(empty);
  }
  for (const value of values) {
    const line = node('tr');
    line.append(node('td', value.label), node('td', number.format(value.views)));
    body.append(line);
  }
  element.append(head, body);
  section.append(element);
  return section;
}

/** Visits and popular pages from Cloudflare Web Analytics, for the owner only. */
export function openAnalytics(token: () => Promise<string>): void {
  const { dialog, body, footer, status } = openDialog('Site analytics', { wide: true });
  const period = node('select', undefined, 'owner-field owner-field--inline');
  for (const [value, label] of [['1', 'Today (UTC)'], ['7', 'Last 7 days'], ['30', 'Last 30 days']]) {
    const option = node('option', label); option.value = value; period.append(option);
  }
  period.value = '30';
  period.setAttribute('aria-label', 'Period');
  const results = node('div', undefined, 'owner-analytics');
  body.append(period, results);
  footer.append(Object.assign(node('button', 'Close', 'owner-button'), { type: 'button', onclick: () => dialog.close() }));
  let request: AbortController | undefined;
  const refresh = async () => {
    request?.abort();
    const controller = request = new AbortController();
    results.replaceChildren();
    if (!configuration.cloudflareBeaconToken) { status.textContent = 'Analytics is not connected yet.'; return; }
    status.textContent = 'Loading…';
    try {
      const response = await fetch(`${editorConfig.authOrigin}/analytics?days=${period.value}`, {
        headers: { Authorization: `Bearer ${await token()}` },
        credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      });
      if (response.status === 401 || response.status === 403) throw new Error('Sign in again to view analytics.');
      if (response.status === 404 || response.status === 503) throw new Error('Analytics is not connected yet.');
      if (!response.ok) throw new Error('Analytics could not be loaded. Try again shortly.');
      const data = await response.json() as AnalyticsSummary;
      if (controller.signal.aborted) return;
      const totals = node('dl', undefined, 'owner-totals');
      for (const [label, value] of [['Page views', data.pageViews], ['Visits', data.visits]] as const) {
        const item = node('div');
        item.append(node('dt', label), node('dd', number.format(value)));
        totals.append(item);
      }
      results.append(totals, node('p', 'Visits are arrivals from another site or a direct link, not unique people. Counts can be sampled or delayed. Dates are UTC.', 'owner-hint'),
        table('Daily page views', 'Date', data.daily), table('Popular pages', 'Page', data.pages), table('Where visitors came from', 'Source', data.referrers));
      status.textContent = '';
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = error instanceof Error ? error.message : 'Analytics could not be loaded.';
    }
  };
  period.addEventListener('change', () => void refresh());
  dialog.addEventListener('close', () => request?.abort());
  void refresh();
}
