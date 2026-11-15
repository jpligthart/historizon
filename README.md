# Historizon

Zoomable, searchable history timeline. People, empires, eras, wars, discoveries and culture — side by side.

Dutch and English UI. Data lives in SQLite; short Wikipedia extracts are cached on demand.

## Stack

- npm workspaces: `apps/api`, `apps/web`, `packages/shared`
- API: Hono + Node built-in `node:sqlite` + FTS5
- Web: Vite + React
- Docker: local build via `compose.yaml`; prod pull via `deploy/compose.prod.yaml`
- Host port **8463** (`TIME` on a phone keypad) → container `8080`

## Local (without Docker)

```powershell
copy .env.example .env
npm install
npm run build -w @historizon/shared
npm run seed
npm run dev:api
```

In another terminal:

```powershell
npm run dev:web
```

- API: http://127.0.0.1:3000/health  
- Web: http://127.0.0.1:5173 (proxies `/api` to the API)

## Docker

```powershell
copy .env.example .env
docker compose up --build
```

Open http://127.0.0.1:8463

Multi-arch image push (needs `IMAGE_REGISTRY` in `.env`):

```powershell
npm run docker:push
```

## Data

- First API start auto-seeds a small curated set if the DB is empty.
- `npm run seed` — re-apply curated seed (upsert).
- Everything else is discovered on demand from Wikidata/Wikipedia and cached in SQLite.

### Discovery while you zoom and scroll

Time is cut into **tiles**, like a map: the closer you zoom in, the smaller the tiles (10, 50 or 250 years). For each tile the API fetches the 15 most notable items per category (notability = number of Wikipedia language editions, minimum 10; 25 for empires/states and eras) whose start falls in it. People, empires and eras also look back (80 / 250 years), because they start before the viewport.

Categories (lanes): people · empires & states (historical countries, empires, dynasties; present-day countries are left out on purpose) · eras (periods, art movements) · events · wars · science & technology (inventions and discoveries) · arts & culture (paintings, sculpture, literature, music) · buildings & monuments.

- One SPARQL query per tile covers all categories; tiles are fetched once and kept for 30 days (failed tiles are retried after 10 minutes).
- `GET /api/items?…&fetch=1` queues the missing tiles for that viewport and returns `pending` (and `pausedMs` when SPARQL is backing off after a 429/5xx). The web app polls while work remains; if Wikidata is paused it shows that instead of a loading spinner. Tiles you scrolled past are dropped from the queue. Views wider than 1,500 years only show what is cached.
- Discovered items are shared for everyone on that API instance (SQLite cache).
- The timeline shows at most 6 rows per category, most notable first; a `+n` badge means more items are in range — zoom in or expand the lane to see them.
- `npm run ingest -- 1800 2026 50` warms tiles for a range ahead of time (sequential, rate-limited).

### Search

Search queries Wikipedia (in the UI language), resolves the hits to Wikidata, classifies them into categories via their classes, stores them, and caches the result for 7 days. Local full-text matches are added after the Wikipedia hits. If Wikipedia rate-limits us, search returns local results immediately instead of waiting.

### Nederland-bril (Dutch lens)

A toggle that gives items with a Dutch connection priority (×2.5 in the ranking) and also fetches Dutch-only tiles with a lower notability floor (5 language editions instead of 10/25), because Dutch topics are far less internationally linked. It is on by default in the Dutch UI and off in English until the user chooses; the choice is remembered in the browser.

"Dutch connection" (Wikidata): Dutch nationality, Dutch origin, the Netherlands took part (wars), made by a Dutch maker, born in the Netherlands, located only in the Netherlands, or one of the Dutch polities themselves (Netherlands, Dutch Republic, Batavian Republic, Kingdom of Holland, Habsburg/Burgundian Netherlands, Seventeen Provinces, United Kingdom of the Netherlands). Stored items are checked in the background, 100 per query on the Wikidata Query Service.

### Upstream services and politeness

| Service | Used for | Pace |
| --- | --- | --- |
| [QLever](https://qlever.dev) Wikidata SPARQL (Uni Freiburg) | viewport tiles | 1 query at a time, ≥ 6 s apart |
| Wikipedia Action API | search, extracts | 1 at a time, ≥ 0.5 s apart |
| Wikidata Action API | search hit details | 1 at a time, ≥ 0.2 s apart |
| Wikidata Query Service | class hierarchy (cached 90 days) | 1 at a time, ≥ 1 s apart |

All requests honour `Retry-After` and pause the whole service on 429/503. **Set `WIKI_USER_AGENT`** with real contact info before running this publicly; Wikimedia throttles anonymous-looking clients hard.

## Zoom

Default viewport: last **50 years**. Presets: 10 / 25 / 50 / 100 / 250 / 500. Drag or Shift+wheel (or horizontal trackpad scroll) to pan; Ctrl+wheel to zoom. Click an item to see what happened at the same time.

Language and about/license live in the header menu. The page itself does not scroll: the timeline lanes and the detail panel each scroll on their own.

## Docker image labels

Both images carry [OCI annotations](https://specs.opencontainers.org/image-spec/annotations/) (`title`, `description`, `source`, `licenses`, `version`, `revision`, `created`). `npm run docker:push` fills in version, git commit and build time, and adds the key annotations to the multi-arch index. Inspect with:

```powershell
docker buildx imagetools inspect <registry>/historizon-api:latest --format "{{json .Image}}"
```

## License

Historizon is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License v3.0 or later](LICENSE).

Because this is a network service, the AGPL requires that users of a modified, publicly hosted version can get its source code. The in-app **About** panel links to this repository; if you host a fork, point it at your own repo by setting `VITE_SOURCE_URL` at build time.

### Content

- Summaries fetched from **Wikipedia** are available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The app credits them with a link to the source article and the license wherever they appear.
- Data from **Wikidata** is [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
- The curated seed descriptions are part of this repository and fall under the AGPL like the code.
