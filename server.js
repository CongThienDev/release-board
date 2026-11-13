import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

const API = process.env.GITHUB_API || 'https://api.github.com';
const TTL_MS = 60_000;
const HISTORY_DEPTH = 100; // commits per env file scanned to find when an image landed (one API page)
const pinned = new Map(); // `${repo}:${path}@${sha}` -> images; a file at a commit never changes

// GitHub answers 304 for an unchanged ETag and does not count it against the rate limit.
const etags = new Map(); // url -> { etag, body }

async function gh(path, token, raw = false) {
  const headers = { Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'User-Agent': 'release-board' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const hit = etags.get(path);
  if (hit) headers['If-None-Match'] = hit.etag;
  const r = await fetch(API + path, { headers });
  if (r.status === 304 && hit) return hit.body;
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  const body = raw ? await r.text() : await r.json();
  if (r.headers.get('etag')) etags.set(path, { etag: r.headers.get('etag'), body });
  return body;
}

const COMMIT_LIST = 30; // commits listed per comparison (oldest first, like GitHub's compare page)

// Commits in `head` that are not in `base`, plus how long the oldest one has been waiting.
async function compare(repo, base, head, token) {
  const c = await gh(`/repos/${repo}/compare/${base}...${head}?per_page=${COMMIT_LIST}`, token);
  const commits = c.commits.map((x) => {
    const title = x.commit.message.split('\n')[0];
    return {
      sha: x.sha,
      title,
      author: x.author?.login ?? x.commit.author?.name,
      date: x.commit.committer?.date,
      // squash merges end in "(#123)", merge commits start with "Merge pull request #123"
      pr: title.match(/\(#(\d+)\)$|^Merge pull request #(\d+)/)?.slice(1).find(Boolean) ?? null,
    };
  });
  return { count: c.ahead_by, waitingSince: commits[0]?.date ?? null, commits };
}

// "success" | "failure" | "pending" | null for the head of a branch, from GitHub Actions check runs.
async function ciState(repo, ref, token) {
  const { check_runs: runs } = await gh(`/repos/${repo}/commits/${ref}/check-runs?per_page=100`, token);
  if (!runs.length) return null;
  if (runs.some((r) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion))) return 'failure';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  return 'success';
}

// Deployment name -> image, from a multi-document kustomize patch file.
export function parseImages(text) {
  const out = {};
  for (const doc of parseAllDocuments(text)) {
    const d = doc.toJS();
    const image = d?.spec?.template?.spec?.containers?.[0]?.image;
    if (d?.metadata?.name && image) out[d.metadata.name] = image;
  }
  return out;
}

// "ghcr.io/x/api:staging-15adc1d" -> "15adc1d"; version tags like "3.5.6" -> null.
export const shaOf = (image) => image?.match(/:(?:[\w.]+-)?([0-9a-f]{7,40})$/)?.[1] ?? null;
const tagOf = (image) => image?.split(':').pop() ?? null;

export async function getStatus(config, token) {
  const { repo, branch = 'main', environments, promotedFrom } = config.manifests;
  const files = new Map(); // branch-head reads for this request only
  const imagesAt = (path, ref) => {
    const cache = ref === branch ? files : pinned;
    const key = `${repo}:${path}@${ref}`;
    if (!cache.has(key)) {
      const p = gh(`/repos/${repo}/contents/${path}?ref=${ref}`, token, true).then(parseImages);
      p.catch(() => cache.delete(key)); // never keep a failed fetch
      cache.set(key, p);
    }
    return cache.get(key);
  };

  const envKeys = Object.keys(environments);
  const current = Object.fromEntries(
    await Promise.all(envKeys.map(async (k) => [k, await imagesAt(environments[k], branch)])),
  );

  // Commits that touched each env file, newest first.
  const historyCache = {};
  const history = (k) =>
    (historyCache[k] ??= gh(`/repos/${repo}/commits?sha=${branch}&path=${environments[k]}&per_page=${HISTORY_DEPTH}`, token));

  // The commit that put today's image in the env file: the oldest consecutive commit that still has it.
  // Gives the deploy time, and for version tags (prod "3.5.6") the source sha: the promote workflow
  // copies the `promotedFrom` image, so that file at the same commit names the real commit.
  async function deployInfo(envKey, svc, image) {
    const commits = await history(envKey);
    let landed = null, found = false;
    // Fetch the whole window in parallel; files are shared by all services and pinned forever.
    const snapshots = await Promise.all(commits.map((c) => imagesAt(environments[envKey], c.sha)));
    for (const [i, c] of commits.entries()) {
      if (snapshots[i][svc] !== image) { found = true; break; }
      landed = c;
    }
    // Unchanged across the whole scanned window: the real commit is older than we looked.
    if (!landed || (!found && commits.length === HISTORY_DEPTH)) return { at: null, sha: null };
    const sha = promotedFrom && envKey !== promotedFrom
      ? shaOf((await imagesAt(environments[promotedFrom], landed.sha))[svc])
      : null;
    return { at: landed.commit.committer.date, sha };
  }

  const services = await Promise.all(
    Object.entries(config.services).map(async ([svc, svcRepo]) => {
      try {
        const { default_branch } = await gh(`/repos/${svcRepo}`, token);
        const ci = ciState(svcRepo, default_branch, token).catch(() => null);
        const envs = Object.fromEntries(
          await Promise.all(
            envKeys.map(async (k) => {
              const image = current[k][svc];
              if (!image) return [k, null];
              const info = await deployInfo(k, svc, image);
              const sha = shaOf(image) ?? info.sha;
              const behind = sha ? await compare(svcRepo, sha, default_branch, token) : null;
              return [k, { tag: tagOf(image), sha, deployedAt: info.at, behind }];
            }),
          ),
        );
        // shortcut: "unpromoted" only compares the last two environments in config order.
        const [prev, last] = envKeys.slice(-2).map((k) => envs[k]);
        const unpromoted = prev?.sha && last?.sha ? await compare(svcRepo, last.sha, prev.sha, token) : null;
        return { service: svc, repo: svcRepo, branch: default_branch, ci: await ci, envs, unpromoted };
      } catch (e) {
        return { service: svc, repo: svcRepo, error: e.message };
      }
    }),
  );
  return { envs: envKeys, staleDays: config.staleDays ?? 3, services, updated: new Date().toISOString() };
}

function start() {
  const file = process.env.CONFIG || 'config.yml';
  const config = parse(readFileSync(file, 'utf8'));
  if (!config?.manifests?.repo || !config.manifests.environments || !config.services)
    throw new Error(`${file}: needs manifests.repo, manifests.environments and services (see config.example.yml)`);
  const token = process.env.GITHUB_TOKEN;
  const html = readFileSync(new URL('./public/index.html', import.meta.url));
  // One shared in-flight load: auto-refresh and extra tabs never trigger parallel GitHub scans.
  let cache = { at: 0, data: null };

  createServer(async (req, res) => {
    if (req.url === '/api/status') {
      try {
        if (Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), data: getStatus(config, token) };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(await cache.data));
      } catch (e) {
        cache.at = 0; // retry on the next request instead of serving the failure for a minute
        res.writeHead(500).end(e.message);
      }
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    } else {
      res.writeHead(404).end();
    }
    // Default 127.0.0.1: the server holds your token, don't expose it to the LAN.
  }).listen(Number(process.env.PORT) || 3000, process.env.HOST || '127.0.0.1', () =>
    console.log(`release-board: http://localhost:${process.env.PORT || 3000}`),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
