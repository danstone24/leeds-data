# Leeds Data

A public dashboard for open data from Leeds City Council, sourced from [Datamillnorth.org](https://datamillnorth.org).

Live at **[leedsdata.co.uk](https://leedsdata.co.uk)**.

## What this is

Leeds publishes a lot of open data — pothole reports, council spending, traffic counts, planning applications, recycling rates, and more. It's all on Datamillnorth, but it's published as raw CSVs and JSON that most people will never look at.

This site turns that data into charts and maps anyone can understand, with plain-English summaries of what's actually happening.

## Stack

- **Frontend**: plain HTML/CSS/JS, hosted on Cloudflare Pages
- **Backend**: Cloudflare Workers that fetch + cache Datamillnorth's CKAN API
- **Cache**: Workers KV, refreshed on a cron schedule
- **Charts**: Chart.js (and Leaflet for maps)

No build step, no framework, no servers. Push to `main`, both Pages and Workers redeploy automatically.

## Local development

```sh
# serve the static site
python3 -m http.server 8000
# open http://localhost:8000

# run the Worker locally (from workers/api/)
cd workers/api
npx wrangler dev
```

## Contributing

See [claude.md](claude.md) for architecture, conventions, and how to add a new dataset/chart.

## Data

All data is from [Datamillnorth.org](https://datamillnorth.org) and licensed under the [Open Government Licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Each chart on the site links back to its source dataset.
