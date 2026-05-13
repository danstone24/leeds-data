# Data sources

All data on this site comes from **[Datamillnorth.org](https://datamillnorth.org)**, Leeds City Council's open-data portal. It runs **CKAN**, so the API is standard.

## The CKAN API

Base URL: `https://datamillnorth.org/api/3/action/`

The endpoints we actually use:

| Endpoint | What it does |
|---|---|
| `package_search?q=<terms>` | Search datasets by keyword |
| `package_show?id=<slug>` | Get a dataset's metadata and the list of resources (files/tables) attached to it |
| `datastore_search?resource_id=<id>&limit=1000` | Get rows from a specific resource — **only works for resources loaded into CKAN's datastore** |

Many resources on Datamillnorth are uploaded as CSVs without being loaded into the datastore. For those, `datastore_search` returns an error. We then either:
- ask the council to ingest it (sometimes they do), or
- fetch the CSV directly inside the Worker and parse it server-side.

## How to discover a dataset

1. Browse [datamillnorth.org/dataset](https://datamillnorth.org/dataset).
2. When you find one, note the slug from the URL (e.g. `pothole-defects`).
3. Hit `https://datamillnorth.org/api/3/action/package_show?id=<slug>` to see the resources. Each resource has an `id` (UUID), `format` (CSV/JSON/etc.), `datastore_active` (true means `datastore_search` works), and a `url`.
4. Add it to `DATASETS` in the Worker.

## Datasets currently wired up

_None yet — this section will grow as we add charts._

Template for new entries:

### <topic name>

- **Dataset**: [<slug>](https://datamillnorth.org/dataset/<slug>)
- **Resource id**: `<uuid>`
- **Update cadence**: <e.g. monthly>
- **Why we use it**: <one sentence>
- **Quirks**: <e.g. column renamed in 2024, gaps in covid years>
- **Worker route**: `/api/dataset/<name>`
- **Chart**: [assets/js/charts/<file>.js](../assets/js/charts/<file>.js)

## Licence

Datamillnorth data is published under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). We must attribute the source. Every chart on the site links back to the source dataset.
