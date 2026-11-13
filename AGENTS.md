# Setting up release-board (instructions for AI coding agents)

When a user asks you to set up, configure or run release-board, produce `config.yml` and `.env`
for them instead of asking them to write these by hand. Both files are gitignored; never commit them.

## 1. Find the GitOps repo

Ask the user for it if it isn't obvious (e.g. `my-org/k8s`, a repo with `overlays/<env>/...`).
Look for one kustomize patch file per environment that sets container images, usually
`overlays/<env>/patches/images.yaml`:

```bash
gh api "repos/<org>/<gitops-repo>/git/trees/<branch>?recursive=1" --jq '.tree[].path' | grep -i image
```

Order `manifests.environments` by promotion (e.g. `staging` then `prod`). Skip an environment
whose file is clearly stale (old service names, far fewer services) and say that you skipped it.

## 2. Work out `promotedFrom`

Read each env file. Tags ending in a commit sha (`staging-15adc1d`, `main-15adc1d`) need nothing.
If an environment uses version tags (`3.5.6`), find the workflow that writes them
(`grep -rn "<env file path>" .github/workflows`) and set `promotedFrom` to the environment
whose image it copies. If nothing copies images between environments, omit `promotedFrom`
and tell the user version tags will show as "commit unknown".

## 3. Map each Deployment to its source repo

`services` keys are the Deployment `metadata.name` values in the patch files; values are the
`owner/repo` that builds the image. Start from the image name (`ghcr.io/<org>/<name>:tag`)
and confirm each guess:

```bash
gh api repos/<org>/<name> --jq .full_name
```

When the image name is not a repo, compare against `gh repo list <org> --limit 200` and ask the
user about anything you can't match. Don't guess silently.

## 4. Token

Write `.env` with `GITHUB_TOKEN=<token>`. The user can create a fine-grained token with
read-only **Contents** access to the GitOps repo and every service repo, or reuse `gh auth token`.
Don't print the token back to the user.

## 5. Verify

```bash
npm install && npm test && npm start
curl -s localhost:3000/api/status
```

Every service should come back without `error`. A 404 usually means a wrong repo name
or a token without access to that repo.
