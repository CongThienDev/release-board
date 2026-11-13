import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const patch = (images) =>
  Object.entries(images)
    .map(([name, image]) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\nspec:\n  template:\n    spec:\n      containers:\n      - name: ${name}\n        image: ${image}\n`)
    .join('---\n');

const STG = 'overlays/staging/patches/images.yaml';
const PRD = 'overlays/prod/patches/images.yaml';
// k8s history (newest first): c3 promoted api 1.1 (from staging-bbbbbbb), c2 changed only web, c1 had api 1.0.
const files = {
  [`${STG}@main`]: patch({ api: 'r/api:staging-ccccccc' }),
  [`${PRD}@main`]: patch({ api: 'r/api:1.1', web: 'r/web:1.0' }),
  [`${PRD}@c3`]: patch({ api: 'r/api:1.1', web: 'r/web:1.0' }),
  [`${PRD}@c2`]: patch({ api: 'r/api:1.1', web: 'r/web:0.9' }),
  [`${PRD}@c1`]: patch({ api: 'r/api:1.0', web: 'r/web:0.9' }),
  [`${STG}@c2`]: patch({ api: 'r/api:staging-bbbbbbb' }),
};
const at = (sha, date) => ({ sha, commit: { committer: { date } } });
const commit = (sha, message, date) => ({ sha, author: { login: 'dev' }, commit: { message, committer: { date } } });
files[`${STG}@s1`] = files[`${STG}@main`];
const json = {
  [`/repos/o/k8s/commits?sha=main&path=${PRD}&per_page=100`]: [at('c3', 'T3'), at('c2', 'T2'), at('c1', 'T1')],
  [`/repos/o/k8s/commits?sha=main&path=${STG}&per_page=100`]: [at('s1', 'S1')],
  '/repos/o/api': { default_branch: 'main' },
  '/repos/o/api/commits/main/check-runs?per_page=100': { check_runs: [{ status: 'completed', conclusion: 'failure' }] },
  '/repos/o/api/compare/ccccccc...main?per_page=30': { ahead_by: 1, commits: [commit('d1', 'Fix login (#42)', 'D1')] },
  '/repos/o/api/compare/bbbbbbb...main?per_page=30': { ahead_by: 4, commits: [commit('d0', 'Old', 'D0')] },
  '/repos/o/api/compare/bbbbbbb...ccccccc?per_page=30': { ahead_by: 3, commits: [commit('d0', 'Merge pull request #7 from o/x', 'D0')] },
};

test('reads k8s manifests, resolves prod version tag to its promoted commit, isolates errors', async () => {
  const srv = createServer((req, res) => {
    const m = req.url.match(/^\/repos\/o\/k8s\/contents\/(.+)\?ref=(.+)$/);
    const body = m ? files[`${m[1]}@${m[2]}`] : json[req.url] && JSON.stringify(json[req.url]);
    res.writeHead(body ? 200 : 404).end(body ?? '{}');
  });
  await new Promise((r) => srv.listen(0, r));
  process.env.GITHUB_API = `http://127.0.0.1:${srv.address().port}`;
  const { getStatus, shaOf } = await import('./server.js');

  assert.equal(shaOf('ghcr.io/x/api:staging-15adc1d'), '15adc1d');
  assert.equal(shaOf('ghcr.io/x/api:3.5.6'), null);

  const data = await getStatus(
    {
      manifests: { repo: 'o/k8s', environments: { staging: STG, prod: PRD }, promotedFrom: 'staging' },
      services: { api: 'o/api', missing: 'o/missing' },
    },
    '',
  );
  srv.close();

  const [api, missing] = data.services;
  assert.equal(api.envs.staging.sha, 'ccccccc');
  assert.equal(api.envs.staging.deployedAt, 'S1');
  assert.deepEqual(api.envs.staging.behind.commits[0], { sha: 'd1', title: 'Fix login (#42)', author: 'dev', date: 'D1', pr: '42' });
  assert.equal(api.envs.staging.behind.count, 1);
  assert.equal(api.envs.prod.tag, '1.1');
  assert.equal(api.envs.prod.sha, 'bbbbbbb');
  assert.equal(api.envs.prod.deployedAt, 'T2'); // promote commit c2, not c3 which only touched web
  assert.equal(api.envs.prod.behind.count, 4);
  assert.equal(api.unpromoted.count, 3);
  assert.equal(api.unpromoted.waitingSince, 'D0');
  assert.equal(api.unpromoted.commits[0].pr, '7');
  assert.equal(api.ci, 'failure');
  assert.match(missing.error, /404/);
});
