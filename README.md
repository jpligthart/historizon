# Historizon

Zoomable, searchable history timeline. Overlapping people, periods, wars, inventions — what happened at the same time.

English UI first, Dutch strings ready. Data lives in SQLite; short Wikipedia extracts are cached on demand.

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

## Data

- First API start auto-seeds a curated set if the DB is empty.
- `npm run seed` — re-apply curated seed (upsert).
- `npm run ingest -- 40` — polite Wikidata SPARQL sample (wars). Prefer dumps for large backfills.

Set `WIKI_USER_AGENT` in `.env` to a real contact string before heavy Wikipedia use.

## Zoom

Default viewport: last **50 years**. Presets: 10 / 25 / 50 / 100 / 250 / 500. Drag or Shift+wheel (or horizontal trackpad scroll) to pan; Ctrl+wheel to zoom. Click an item to see what happened at the same time.

## Docker image labels

Both images carry [OCI annotations](https://specs.opencontainers.org/image-spec/annotations/) (`title`, `description`, `source`, `licenses`, `version`, `revision`, `created`). `npm run docker:push` fills in version, git commit and build time, and adds the key annotations to the multi-arch index. Inspect with:

```powershell
docker buildx imagetools inspect <registry>/historizon-api:latest --format "{{json .Image}}"
```

## License

Historizon is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License v3.0 or later](LICENSE).

Because this is a network service, the AGPL requires that users of a modified, publicly hosted version can get its source code. The app footer links to this repository; if you host a fork, point it at your own repo by setting `VITE_SOURCE_URL` at build time.

### Content

- Summaries fetched from **Wikipedia** are available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The app credits them with a link to the source article and the license wherever they appear.
- Data from **Wikidata** is [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
- The curated seed descriptions are part of this repository and fall under the AGPL like the code.
