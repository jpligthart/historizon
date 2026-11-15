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
