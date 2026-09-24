import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Run by .github/workflows/scheduled.yml every 15 minutes. Answers one question: did an entry
 * become due (its date or go-live time passed) after the live site was built? No dependencies,
 * so the check needs no npm install.
 */
const root = path.resolve(import.meta.dirname, '..');
const site = process.env.SITE_ORIGIN ?? 'https://gwenlium.dev';

async function files(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(target));
    else if (entry.name.endsWith('.md')) found.push(target);
  }
  return found;
}

/** The editor writes plain `key: value` frontmatter lines; read just the three that matter. */
function field(frontmatter, key) {
  const match = new RegExp(`^${key}:[ \\t]*['"]?([^'"\\r\\n]*?)['"]?[ \\t]*$`, 'm').exec(frontmatter);
  return match?.[1].trim() ?? '';
}

export async function dueEntries(builtAt, now = new Date()) {
  const due = [];
  for (const file of await files(path.join(root, 'src/content/posts'))) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await fs.readFile(file, 'utf8'))?.[1];
    if (!frontmatter || field(frontmatter, 'draft') !== 'false') continue;
    const day = Date.parse(`${field(frontmatter, 'date')}T00:00:00Z`);
    const time = field(frontmatter, 'publishAt') ? Date.parse(field(frontmatter, 'publishAt')) : -Infinity;
    const liveAt = Math.max(day, time);
    if (Number.isFinite(liveAt) && liveAt > builtAt.getTime() && liveAt <= now.getTime()) due.push(path.relative(root, file));
  }
  return due;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  let builtAt;
  try {
    const build = await (await fetch(`${site}/build.json?t=${Date.now()}`, { cache: 'no-store' })).json();
    builtAt = new Date(build.builtAt);
    if (!Number.isFinite(builtAt.getTime())) throw new Error('No build time');
  } catch {
    // Without knowing the live build, rebuilding is the safe answer.
    builtAt = new Date(0);
  }
  const due = await dueEntries(builtAt);
  console.log(due.length ? `Due since the build of ${builtAt.toISOString()}: ${due.join(', ')}` : `Nothing due since the build of ${builtAt.toISOString()}.`);
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `build=${due.length ? 'true' : 'false'}\n`);
}
