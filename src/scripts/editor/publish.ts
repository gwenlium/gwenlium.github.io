import type { EditorConflict, EditorDraftFile } from '../../lib/editor-types';
import { writerUrl } from './session';
import { bindingDocument, isPostPath, markdownParts, type SiteEditorStore } from './store';
import { button, errorText, node, openDialog, toast } from './ui';

const liveKey = 'gwenlium:owner:live';
const pageNames: Record<string, string> = {
  about: 'About page', devlog: 'Devlog page', life: 'Life page', gallery: 'Gallery page', music: 'Music page',
  subscribe: 'Subscribe page', 'not-found': 'Page not found',
};

type Change = { file: EditorDraftFile; label: string; detail: string; problems: string[]; fix?: string };

function missingPictureDescriptions(markdown: string): number {
  return [...markdown.matchAll(/!\[([^\]]*)\]\(/g)].filter(match => !match[1].trim()).length;
}

function describe(file: EditorDraftFile): Change {
  const problems: string[] = [];
  if (isPostPath(file.path)) {
    let data: Record<string, unknown> = {};
    let body = '';
    try {
      data = bindingDocument(file.deleted ? file.baseContent ?? '' : file.content, true).value as Record<string, unknown>;
      body = markdownParts(file.deleted ? file.baseContent ?? '' : file.content).body;
    } catch { problems.push('This entry could not be read.'); }
    const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Untitled entry';
    const journal = data.section === 'life' ? 'Life' : 'Devlog';
    let wasPublic = false;
    try { wasPublic = file.baseContent !== null && (bindingDocument(file.baseContent, true).value as Record<string, unknown>).draft === false; } catch { /* Unknown. */ }
    const isPublic = data.draft === false;
    if (file.deleted) return { file, label: `Delete “${title}”`, detail: `${journal} entry${wasPublic ? ', removed from the website' : ''}`, problems: [] };
    const detail = [
      `${journal}`,
      file.baseContent === null ? (isPublic ? 'new, public' : 'new, hidden draft') : isPublic && !wasPublic ? 'now public' : !isPublic && wasPublic ? 'now hidden' : isPublic ? 'public' : 'hidden draft',
    ].join(', ');
    if (isPublic && !String(data.title ?? '').trim()) problems.push('Give it a title.');
    const missing = missingPictureDescriptions(body);
    if (missing) problems.push(missing === 1 ? 'A picture in the text needs a description.' : `${missing} pictures in the text need descriptions.`);
    if (typeof data.cover === 'string' && data.cover && !String(data.coverAlt ?? '').trim()) problems.push('The cover picture needs a description.');
    return { file, label: `${file.baseContent === null ? 'New entry' : 'Entry'} “${title}”`, detail, problems, fix: writerUrl({ entry: file.path }) };
  }
  const page = /^src\/content\/pages\/([^/]+)\.json$/.exec(file.path)?.[1];
  const label = page ? pageNames[page] ?? `${page} page` : ({
    'src/content/site.json': 'Home page and site settings',
    'src/content/windows.json': 'Windows',
    'src/content/gallery.json': 'Gallery',
    'src/content/music.json': 'Music',
  } as Record<string, string>)[file.path] ?? file.path;
  let missing = 0;
  try {
    const visit = (value: unknown): void => {
      if (typeof value === 'string') missing += missingPictureDescriptions(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(JSON.parse(file.content));
  } catch { problems.push('This file could not be read.'); }
  if (missing) problems.push(missing === 1 ? 'A picture in the text needs a description.' : `${missing} pictures in the text need descriptions.`);
  return { file, label, detail: file.baseContent === null ? 'new' : 'changed', problems };
}

/** Review what will go live, choose what to include, and publish it in one step. */
export async function openPublish(store: SiteEditorStore, onPublished: () => Promise<void> | void, only?: string[]): Promise<void> {
  const changes = store.draftFiles.map(describe);
  const { dialog, body, footer, status } = openDialog(store.local ? 'Save changes to your files' : 'Publish changes', { wide: true });
  if (!changes.length) {
    body.append(node('p', 'There is nothing new to publish.'));
    footer.append(button('Close', () => dialog.close()));
    return;
  }
  body.append(node('p', store.local
    ? 'These changes are written into this project’s files. Commit them with Git when you are happy.'
    : 'Everything checked goes live together. Unchecked changes stay saved on this browser for later.', 'owner-hint'));
  const list = node('ul', undefined, 'owner-changes');
  const boxes = new Map<string, HTMLInputElement>();
  for (const change of changes) {
    const item = node('li', undefined, `owner-change${change.problems.length ? ' has-problem' : ''}`);
    const label = node('label', undefined, 'owner-check');
    const box = node('input');
    box.type = 'checkbox';
    box.checked = !change.problems.length && (!only || only.includes(change.file.path));
    box.disabled = change.problems.length > 0;
    boxes.set(change.file.path, box);
    const text = node('span');
    text.append(node('strong', change.label), node('small', change.detail));
    label.append(box, text);
    item.append(label);
    if (change.problems.length) {
      const problem = node('p', change.problems.join(' '), 'owner-change__problem');
      if (change.fix && !location.search.includes(encodeURIComponent(change.file.path)) && location.pathname !== '/write/') {
        const fix = node('a', 'Fix it', 'owner-change__fix');
        fix.href = change.fix;
        problem.append(' ', fix);
      }
      item.append(problem);
    }
    list.append(item);
  }
  body.append(list);
  const exact = node('details', undefined, 'owner-exact');
  exact.append(node('summary', 'Show the exact file changes'));
  for (const change of changes) {
    exact.append(node('h3', change.file.path));
    const columns = node('div', undefined, 'owner-exact__columns');
    columns.append(node('pre', change.file.baseContent ?? '(new file)'), node('pre', change.file.deleted ? '(deleted)' : change.file.content));
    exact.append(columns);
  }
  body.append(exact);
  const publish = button('', () => void run(), 'owner-button owner-button--primary');
  const count = () => {
    const selected = [...boxes.values()].filter(box => box.checked).length;
    publish.textContent = store.local ? `Save ${selected} to files` : selected === changes.length ? 'Publish everything' : `Publish ${selected} of ${changes.length}`;
    publish.disabled = !selected;
  };
  boxes.forEach(box => box.addEventListener('change', count));
  count();
  footer.append(button('Cancel', () => dialog.close()), publish);

  async function run() {
    const paths = [...boxes].filter(([, box]) => box.checked).map(([path]) => path);
    footer.querySelectorAll('button').forEach(item => { item.disabled = true; });
    boxes.forEach(box => { box.disabled = true; });
    status.textContent = store.local ? 'Saving…' : 'Publishing… keep this page open for a moment.';
    try {
      const result = await store.publish(paths);
      await onPublished();
      body.replaceChildren();
      footer.replaceChildren(button('Done', () => dialog.close(), 'owner-button owner-button--primary'));
      status.textContent = '';
      if (store.local) {
        body.append(node('p', 'Saved to your local files. The dev server shows the change right away.'));
        return;
      }
      body.append(node('p', 'Published. The website rebuilds itself, which usually takes 3 to 4 minutes. You will get a note here when it is live.'));
      const commit = node('a', 'See the change on GitHub', 'owner-link');
      commit.href = result.htmlUrl; commit.target = '_blank'; commit.rel = 'noopener noreferrer';
      body.append(commit);
      startLiveCheck(result.commit, store.snapshot?.repository);
    } catch (error) {
      status.textContent = errorText(error);
      footer.replaceChildren(button('Close', () => dialog.close()));
      if ((error as { status?: number }).status === 409) {
        status.textContent = 'The website changed since you started (maybe from another device). Update to the latest version, then publish again.';
        footer.append(button('Update and review', () => { dialog.close(); void resolveConflicts(store, onPublished); }, 'owner-button owner-button--primary'));
      }
    }
  }
}

/** Move drafts onto the latest version; ask only about files changed on both sides. */
export async function resolveConflicts(store: SiteEditorStore, onDone: () => Promise<void> | void): Promise<void> {
  let conflicts: EditorConflict[];
  try { conflicts = await store.refresh(); }
  catch (error) { toast(errorText(error)); return; }
  if (!conflicts.length) { await onDone(); toast('Updated to the latest version. Your changes are kept.'); return; }
  const { dialog, body, footer, status } = openDialog('Choose which version to keep', { wide: true });
  body.append(node('p', 'These were changed both here and somewhere else. Pick one version for each.'));
  const choices: Record<string, 'draft' | 'remote'> = {};
  for (const conflict of conflicts) {
    const section = node('section', undefined, 'owner-conflict');
    section.append(node('h3', describe({ path: conflict.path, baseContent: conflict.base, content: conflict.draft }).label));
    const columns = node('div', undefined, 'owner-exact__columns');
    for (const [value, label, content] of [['draft', 'Keep my version', conflict.draft], ['remote', 'Keep the other version', conflict.remote ?? '(deleted)']] as const) {
      const option = node('label', undefined, 'owner-conflict__option');
      const radio = node('input'); radio.type = 'radio'; radio.name = conflict.path;
      radio.addEventListener('change', () => { choices[conflict.path] = value; });
      option.append(radio, node('strong', label), node('pre', content));
      columns.append(option);
    }
    section.append(columns);
    body.append(section);
  }
  footer.append(button('Later', () => dialog.close()), button('Use these choices', () => void (async () => {
    if (conflicts.some(conflict => !choices[conflict.path])) { status.textContent = 'Pick a version for each one.'; return; }
    try {
      const remaining = await store.refresh(choices);
      if (remaining.length) { status.textContent = 'Something changed again. Close this and try once more.'; return; }
      dialog.close();
      await onDone();
      toast('Done. Review and publish when ready.');
    } catch (error) { status.textContent = errorText(error); }
  })(), 'owner-button owner-button--primary'));
}

let polling: number | undefined;

function startLiveCheck(commit: string, repository?: string): void {
  try { localStorage.setItem(liveKey, JSON.stringify({ commit, at: Date.now(), repository })); } catch { /* Checked in this tab only. */ }
  poll();
}

/** After a reload or navigation, keep waiting for a recent publish to appear on the live site. */
export function resumeLiveCheck(store: SiteEditorStore): void {
  if (store.local) return;
  poll();
}

function poll(): void {
  clearTimeout(polling);
  let pending: { commit: string; at: number; repository?: string } | undefined;
  try { pending = JSON.parse(localStorage.getItem(liveKey) ?? 'null') ?? undefined; } catch { pending = undefined; }
  if (!pending || typeof pending.commit !== 'string') return;
  const clear = () => { try { localStorage.removeItem(liveKey); } catch { /* Nothing saved. */ } };
  if (Date.now() - pending.at > 20 * 60 * 1000) {
    clear();
    toast('Your last publish has not appeared on the website after 20 minutes. The site build may have failed.', {
      sticky: true, action: { label: 'Check the build', href: `https://github.com/${pending.repository ?? 'gwenlium/gwenlium.github.io'}/actions` },
    });
    return;
  }
  polling = window.setTimeout(async () => {
    try {
      const response = await fetch(`/build.json?t=${Date.now()}`, { cache: 'no-store' });
      const build = await response.json() as { commit?: string; builtAt?: string };
      const builtAfter = build.builtAt ? Date.parse(build.builtAt) > pending!.at + 60_000 : false;
      if (build.commit === pending!.commit || builtAfter) {
        clear();
        toast('Your changes are live.', { action: { label: 'Reload', run: () => location.reload() } });
        return;
      }
    } catch { /* Offline or mid-deploy; try again. */ }
    poll();
  }, 15_000);
}
