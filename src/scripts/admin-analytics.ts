import { editorBackend } from './admin-github';
import configuration from '../content/analytics.json';

interface AnalyticsSummary {
  start: string;
  end: string;
  pageViews: number;
  visits: number;
  daily: { label: string; views: number }[];
  pages: { label: string; views: number }[];
  referrers: { label: string; views: number }[];
}

const dialog = document.querySelector<HTMLDialogElement>('[data-analytics-dialog]');
if (dialog) {
  const form = dialog.querySelector<HTMLFormElement>('[data-analytics-form]')!;
  const period = form.querySelector<HTMLSelectElement>('select')!;
  const refresh = form.querySelector<HTMLButtonElement>('button')!;
  const status = dialog.querySelector<HTMLElement>('[data-analytics-status]')!;
  const results = dialog.querySelector<HTMLElement>('[data-analytics-results]')!;
  const number = new Intl.NumberFormat('en');
  let request: AbortController | undefined;

  function rows(selector: string, values: { label: string; views: number }[]) {
    const body = dialog!.querySelector(selector)!;
    body.replaceChildren();
    if (!values.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 2;
      cell.textContent = 'No recorded activity in this period.';
      row.append(cell);
      body.append(row);
    }
    for (const value of values) {
      const row = document.createElement('tr');
      const label = document.createElement('td');
      label.textContent = value.label;
      const views = document.createElement('td');
      views.textContent = number.format(value.views);
      row.append(label, views);
      body.append(row);
    }
  }

  async function refreshAnalytics() {
    request?.abort();
    request = new AbortController();
    const controller = request;
    results.hidden = true;
    if (!configuration.cloudflareBeaconToken) {
      status.textContent = 'Analytics is not connected yet. Visitor counting will begin after setup; no earlier visits can be recovered.';
      return;
    }
    refresh.disabled = true;
    status.textContent = 'Loading analytics…';
    try {
      const token = editorBackend().token;
      const response = await fetch(`https://gwenlium-cms-auth.gwenlium.workers.dev/analytics?days=${period.value}`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      });
      if (response.status === 401 || response.status === 403) throw new Error('Sign in to the site editor with your GitHub account, then refresh analytics.');
      if (response.status === 404 || response.status === 503) throw new Error('Analytics is not connected yet. Finish connecting the data source before refreshing.');
      if (!response.ok) throw new Error('Analytics could not be loaded. Please try again shortly.');
      const data: AnalyticsSummary = await response.json();
      if (controller.signal.aborted || !dialog!.open) return;
      // Clear results if the editor signed out or changed accounts while loading.
      if (editorBackend().token !== token) throw new Error('Your sign-in changed. Refresh analytics again.');
      dialog!.querySelector('[data-analytics-views]')!.textContent = number.format(data.pageViews);
      dialog!.querySelector('[data-analytics-visits]')!.textContent = number.format(data.visits);
      rows('[data-analytics-daily]', data.daily);
      rows('[data-analytics-pages]', data.pages);
      rows('[data-analytics-referrers]', data.referrers);
      results.hidden = false;
      status.textContent = data.pageViews === 0 ? 'Connected. No page views recorded in this period yet.' : 'Updated from Cloudflare Web Analytics.';
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = error instanceof Error ? error.message.replace('before managing media', 'to view analytics') : 'Analytics could not be loaded.';
    } finally {
      if (request === controller) refresh.disabled = false;
    }
  }
  document.querySelector('[data-open-analytics]')?.addEventListener('click', () => {
    dialog.showModal();
    void refreshAnalytics();
  });
  dialog.querySelector('[data-close-analytics]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { request?.abort(); results.hidden = true; refresh.disabled = false; });
  form.addEventListener('submit', event => { event.preventDefault(); void refreshAnalytics(); });
  period.addEventListener('change', () => void refreshAnalytics());
}
