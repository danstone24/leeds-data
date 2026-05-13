# Deployment

Everything deploys from this GitHub repo. Push to `main` and both the site and the Worker go live.

## One-time setup

### 1. Create the GitHub repo

```sh
# from the project root
git init
git add .
git commit -m "feat: initial scaffold"
gh repo create leeds-data --public --source=. --remote=origin --push
```

(Or create it via github.com and run `git remote add origin <url>` + `git push -u origin main`.)

### 2. Connect Cloudflare Pages

In the Cloudflare dashboard:

1. **Workers & Pages → Create application → Pages → Connect to Git**.
2. Choose the `leeds-data` repo.
3. Build settings:
   - **Build command**: (leave empty — no build step)
   - **Build output directory**: `/` (repo root)
4. Deploy. You'll get a `*.pages.dev` URL straight away.

### 3. Attach the custom domain

In the Pages project: **Custom domains → Set up a custom domain → `leedsdata.co.uk`**.

If the domain isn't on Cloudflare yet, add it as a Cloudflare site first (Cloudflare dashboard → Add a Site → `leedsdata.co.uk`) and update the nameservers at your registrar.

### 4. Deploy the Worker

```sh
cd workers/api
npx wrangler login                # one-off, opens a browser
npx wrangler kv:namespace create CACHE
# paste the printed `id` into wrangler.toml (replacing REPLACE_WITH_KV_NAMESPACE_ID)
npx wrangler deploy
```

### 5. Route the Worker at /api/*

In the Cloudflare dashboard: **Workers & Pages → leeds-data-api → Settings → Triggers → Add route**: `leedsdata.co.uk/api/*`.

(Or uncomment the `routes` block in `wrangler.toml` and redeploy.)

### 6. (Optional) Set up auto-deploy for the Worker

Two options:

**A. Workers Builds** (Cloudflare-native, like Pages):
- Workers & Pages → leeds-data-api → Settings → Builds → Connect to Git → choose the repo, root dir `workers/api`.

**B. GitHub Action** (more control):
- Create `.github/workflows/deploy-worker.yml` (see below).
- Add a `CLOUDFLARE_API_TOKEN` secret in GitHub repo settings, scoped to "Edit Workers" on your account.

```yaml
# .github/workflows/deploy-worker.yml
name: Deploy Worker
on:
  push:
    branches: [main]
    paths: ["workers/api/**"]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          workingDirectory: workers/api
```

## Day-to-day

- Edit files locally → `git push` → live within ~30s.
- Pages preview deploys: every PR / non-main branch gets its own `*.pages.dev` preview URL automatically.
- Roll back: Cloudflare Pages → Deployments → click an old deploy → "Rollback to this deployment".

## Local development

```sh
# frontend
python3 -m http.server 8000
# http://localhost:8000

# worker (in a second terminal)
cd workers/api
npx wrangler dev
# http://127.0.0.1:8787/api/health
```

To make the local frontend talk to the local Worker, change `API_BASE` in [assets/js/api.js](../assets/js/api.js) to `http://127.0.0.1:8787/api` while developing (revert before committing — or wire it up via a `?local` query string if it becomes annoying).
