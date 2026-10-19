# Open Property Comps

Local Arizona property-record and comparable-sales app. It lives in its own folder and does not plug into the reverse-engineering CLI or MCP server in the rest of this repository.

Search an address or parcel, read the assessment record, and list nearby sales in a table and on a map. Summary stats are the count, median dollars per square foot, and sale-price range. Results export to CSV.

The lookup-then-nearby-sales workflow is a common assessor workflow. This app does not use listing services and does not scrape commercial comps sites. Live records come from free public Arizona open-data services. The bundled Sample County file is fictional and set in Arizona.

## Run

Requires Node.js 22 or newer. There are no package dependencies.

```bash
cd property-comps
npm test
npm start
```

Open http://127.0.0.1:4317 . The server binds to `127.0.0.1` unless you pass `--host`. On a phone-width browser, use Add to Home Screen. Chrome can use the button on the page; Safari uses the Share menu. The service worker caches the app shell only. Property searches still need the server.

```bash
node src/cli.js search --source sample --query "maple"
node src/cli.js record --source sample --id sample:maple-100
node src/cli.js comps --source sample --subject sample:maple-100 \
  --radius 0.5 --type Residential --min-sqft 1400 --max-sqft 2200 \
  --sold-after 2023-01-01
node src/cli.js serve --port 4317
```

`npm run test:live` calls the public Arizona services. The default `npm test` uses the sample dataset and recorded response fixtures, so it does not need network access.

## Deploy on Vercel

The folder is its own Vercel project. `npm start` stays the local server. The same API handlers live in [`api/`](api/) for Vercel, and [`vercel.json`](vercel.json) rewrites `/api/comps.csv` to the `api/comps-csv.js` function. Static files, including the manifest, service worker, and icons, are in [`public/`](public/).

Project settings:

| Setting | Value |
| --- | --- |
| Root Directory | `property-comps` |
| Framework Preset | Other |
| Node.js Version | 22.x |
| Install Command | leave the default (`npm install`). There are no dependencies. |
| Build Command | empty. Clear any command the dashboard fills in. There is no build step. |
| Output Directory | empty. Do not set `public`. Vercel serves `public/` itself and keeps the `api/` functions. |
| Environment variables | none. |

No API keys, tokens, or other environment variables are read. Maricopa and Pinal are called from the functions over HTTPS. A home-screen install needs the deployment to be reachable by the phone. If Deployment Protection is on, the phone has to be allowed through it.

`api/**` functions are configured for 60 seconds. A plan that caps functions below that will use the plan limit. County searches are usually a few seconds; a wide Maricopa radius can be slower.

## Sources

| Id | What it is | Records |
| --- | --- | --- |
| `sample` | Fictional Sampleton, Arizona seed in [`data/sample-county.js`](data/sample-county.js) | Offline. Labeled `sample` on every record and in CSV `data_kind`. |
| `maricopa` | [Maricopa County Assessor parcel layer](https://gis.mcassessor.maricopa.gov/arcgis/rest/services/Parcels/MapServer/0) | Owner, APN, property-use code, living area, year built, current full cash value, latest sale, latitude and longitude. |
| `pinal` | [Pinal County Assessor parcels](https://rogue.casagrandeaz.gov/arcgis/rest/services/Pinal_County/Pinal_County_Parcels/FeatureServer/0), described by the service as a nightly public extract | Owner, parcel id, use, floor area, year built, current assessed value, latest sale, and a centroid. |

No API key is required. Responses are cached in memory for five minutes. The app sends a descriptive User-Agent and caps radius (0.1–5 miles), candidate counts, and an open-ended sale window (three years when dates are omitted).

Maricopa property-use codes are grouped with the Arizona Department of Revenue use-code families (for example `01` single-family, `00` vacant, `30`–`39` industrial). The raw code stays on the record.

## Add an Arizona county

Sources implement `search`, `getProperty`, and `findCandidates` as described in [`src/adapters/source.js`](src/adapters/source.js). `findCandidates` may prefilter with the bounding box it is given. Radius, property type, size, sale dates, and statistics are applied once in [`src/domain/comps.js`](src/domain/comps.js). Register the source in [`src/adapters/registry.js`](src/adapters/registry.js). [`src/adapters/arcgis.js`](src/adapters/arcgis.js) is the shared client for county ArcGIS REST query endpoints.

Prefer a public county or statewide service that already publishes parcel attributes. Keep adapters off scraped HTML.

These public services were checked and not wired up, because they do not currently support this comps workflow:

- Pima County's open [regional parcel layer](https://gisdata.pima.gov/arcgis1/rest/services/GISOpenData/LandRecords/MapServer/12) has owner, use, full cash value, and coordinates, but not sale price, living area, or year built.
- Yavapai County publishes parcel boundaries, and sells the assessor ownership, sales, and improvement tables.
- AZGeo's statewide [parcel cache](https://azgeo.az.gov/arcgis/rest/services/TerraSystems/AZParcelFeatures/FeatureServer/0) exposes APN, address, and place name only.

## Limitations

- Maricopa and Pinal each publish the latest sale on the parcel, not a multi-year deed history.
- Maricopa's assessed figure is current full cash value (`FCV_CUR`). Pinal's is the current assessed value on that layer. Neither number is the sale price.
- A dense area can hit the candidate cap (1,000 parcels). The response says when that happens. Narrow the radius or the sale dates. Maricopa sale dates are filtered after the download because the layer stores them as month/day/year text.
- Non-positive prices stay on the property history and are excluded from comps. Dollars per square foot is omitted when building area is missing or zero.
- The map uses OpenStreetMap tiles in the browser. The table, stats, and CSV do not need tiles. Sample County still resolves without calling a data API.
- Public extracts go stale and contain non-market transfers. This is not an appraisal.
