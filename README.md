# Leeds Data

A public dashboard for open data about Leeds — mostly Leeds City Council's own datasets from [Datamillnorth.org](https://datamillnorth.org), plus national statistics (DEFRA, MHCLG) for topics the council doesn't publish.

Live at **[leedsdata.co.uk](https://leedsdata.co.uk)**.

## What this is

Leeds publishes a lot of open data — pothole reports, council spending, traffic counts, school places, and more — on Datamillnorth, and national bodies publish the rest (air quality, recycling rates, planning statistics). It's almost all raw CSVs and spreadsheets that most people will never look at.

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

Most data is from [Datamillnorth.org](https://datamillnorth.org); air quality, recycling & waste and planning use DEFRA and MHCLG open data (with a map layer from the volunteer-run [PlanIt](https://www.planit.org.uk/)). Everything is licensed under the [Open Government Licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Each chart on the site links back to its source dataset.
