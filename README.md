# Gas Prices Finder

Static web app that shows current fuel prices at every petrol station in mainland
Portugal, on a Leaflet map. Data is scraped daily from DGEG's public
`PesquisarPostos` endpoint and committed as JSON.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Refresh data

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/fetch_prices.py
```

Output: `data/stations.json` (one snapshot, ~1 MB).

A GitHub Actions workflow runs the same script daily at 06:30 UTC and commits
the result if it changed.

## Layout

- `index.html`, `styles.css`, `app.js` — frontend (vanilla JS + Leaflet).
- `scripts/fetch_prices.py` — DGEG scraper.
- `data/stations.json` — committed snapshot the frontend reads.
- `design/` — original design prototypes (React + Tailwind sketches).
- `.github/workflows/fetch-prices.yml` — daily refresh cron.

## Data source

DGEG (Direção-Geral de Energia e Geologia) — `precoscombustiveis.dgeg.gov.pt`.
The `PesquisarPostos` endpoint returns every (station × fuel) row with
coordinates, price and update timestamp; ~14 000 rows / ~3 100 stations.
