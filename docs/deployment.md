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

### 4. Deploy the Worker (one-off)

```sh
cd workers/api
npx wrangler login                       # opens a browser
npx wrangler kv namespace create CACHE   # paste the id into wrangler.toml
npx wrangler deploy
```

### 5. Route the Worker at /api/*

In the Cloudflare dashboard: **Workers & Pages → leeds-data-api → Settings → Domains & Routes → Add → Route**: `leedsdata.co.uk/api/*`.

### 6. Auto-deploy the Worker from GitHub (Workers Builds)

In the Cloudflare dashboard: **Workers & Pages → leeds-data-api → Settings → Builds → Connect**. Pick the `danstone24/leeds-data` repo.

Build settings:
- **Branch**: `main`
- **Root directory**: `workers/api`
- **Build command**: leave empty
- **Deploy command**: `npx wrangler deploy` (pre-filled by Cloudflare)

After this, every push to `main` triggers a Worker build. Watch progress at **Workers & Pages → leeds-data-api → Deployments**.

**Manual re-run**: same Deployments page → click the latest build → **Retry deployment**, or just push an empty commit (`git commit --allow-empty -m "redeploy"`).

### 7. Wire up the data-refresh GitHub Action

The Worker is a KV reader only — heavy aggregation happens in **GitHub Actions** (see `.github/workflows/refresh-data.yml`). Runs daily at 04:00 UTC + on demand from the Actions tab.

Needs three GitHub repo secrets:

**a. Cloudflare API token** — scoped narrowly to KV writes:

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token**.
2. Permissions: **Account → Workers KV Storage → Edit**.
3. Account Resources: include your account only.
4. Create, copy the token.

(If you already created an "Edit Cloudflare Workers" token for Workers deploys, it'll work — it's just broader than needed.)

**b. Account ID** — visible in the Cloudflare dashboard sidebar on any Worker page.

**c. Datamillnorth API token** — same value you set on the Worker as `DATAMILLNORTH_TOKEN`.

Add all three to the GitHub repo:

```sh
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set DATAMILLNORTH_TOKEN
```

(Or web UI: GitHub repo → Settings → Secrets and variables → Actions.)

**Fire it off**: GitHub repo → **Actions → Refresh data → Run workflow**. First run backfills all 24 months (1-3 mins). Subsequent runs skip months whose source CSV hasn't changed.

### 8. (Optional) Clean up obsolete Worker secrets

Two secrets on the Worker are no longer used now that refresh happens in GitHub Actions:

```sh
cd workers/api
npx wrangler secret delete DATAMILLNORTH_TOKEN   # Worker no longer fetches Datamillnorth
npx wrangler secret delete ADMIN_TOKEN           # /api/admin/refresh route removed
```

Skipping this step is harmless — unused secrets cost nothing.

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
