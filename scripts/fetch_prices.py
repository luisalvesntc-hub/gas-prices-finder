"""Fetch every Portuguese fuel station + current prices from DGEG.

Single source: DGEG's PesquisarPostos endpoint (CORS open, no auth).
One call returns every (station, fuel) row with coordinates, brand, district,
municipality, address, price and last-update timestamp.

  https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb/PesquisarPostos?qtdPorPagina=N&pagina=1

Writes a single snapshot to data/stations.json. The frontend reads this file.
"""

import json
import re
import sys
import time
from pathlib import Path

import httpx

PESQUISAR = "https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb/PesquisarPostos"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
HEADERS = {"User-Agent": UA, "Accept": "application/json, */*"}

# Map DGEG fuel labels → stable IDs the frontend uses, plus a display label
# and an ordering hint. Fuels not listed here are dropped (heating oil etc).
FUEL_TYPE_MAP = {
    "Gasolina simples 95":  ("gas95",  "Gasolina 95",  1),
    "Gasolina especial 95": ("gas95p", "Gasolina 95+", 2),
    "Gasolina 98":          ("gas98",  "Gasolina 98",  3),
    "Gasolina especial 98": ("gas98p", "Gasolina 98+", 4),
    "Gasóleo simples":      ("diesel",  "Gasóleo",      5),
    "Gasóleo especial":     ("dieselp", "Gasóleo+",     6),
    "GPL Auto":             ("gpl",     "GPL Auto",     7),
}


def parse_price(s: str) -> float | None:
    """'1,889 €/litro' or '0,800 €' → 1.889 / 0.800"""
    if not s:
        return None
    m = re.search(r"(\d+[.,]\d+)", s)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", "."))
    except ValueError:
        return None


def fetch_all(client: httpx.Client) -> list[dict]:
    """One big page. Quantidade tells us the total; we ask for that many."""
    # Probe to learn the total count, then re-fetch in one shot.
    r = client.get(PESQUISAR, params={"qtdPorPagina": 1, "pagina": 1}, timeout=30)
    r.raise_for_status()
    total = (r.json().get("resultado") or [{}])[0].get("Quantidade", 20000)

    r = client.get(
        PESQUISAR,
        params={"qtdPorPagina": max(total, 20000), "pagina": 1},
        timeout=120,
    )
    r.raise_for_status()
    return r.json().get("resultado") or []


def latest_timestamp(rows: list[dict]) -> str:
    """Most recent DataAtualizacao across all rows for a station."""
    ts = [r.get("DataAtualizacao") for r in rows if r.get("DataAtualizacao")]
    return max(ts) if ts else ""


def build_stations(rows: list[dict]) -> list[dict]:
    by_id: dict[int, dict] = {}
    for row in rows:
        sid = row.get("Id")
        if sid is None:
            continue
        lat = row.get("Latitude")
        lng = row.get("Longitude")
        if lat in (None, 0) or lng in (None, 0):
            continue
        fuel_label = (row.get("Combustivel") or "").strip()
        mapped = FUEL_TYPE_MAP.get(fuel_label)
        if not mapped:
            continue
        fid, _disp, _ord = mapped
        price = parse_price(row.get("Preco"))
        if price is None:
            continue

        st = by_id.get(sid)
        if st is None:
            st = by_id[sid] = {
                "id": int(sid),
                "name": (row.get("Nome") or "").strip(),
                "brand": (row.get("Marca") or "").strip() or "Outro",
                "type": (row.get("TipoPosto") or "").strip(),
                "district": (row.get("Distrito") or "").strip(),
                "municipality": (row.get("Municipio") or "").strip(),
                "address": (row.get("Morada") or "").strip(),
                "locality": (row.get("Localidade") or "").strip(),
                "postcode": (row.get("CodPostal") or "").strip(),
                "lat": float(lat),
                "lng": float(lng),
                "prices": {},
                "updated": "",
                "_rows": [],
            }
        # Cheaper price wins if multiple rows map to same fuel id (rare).
        if fid not in st["prices"] or price < st["prices"][fid]:
            st["prices"][fid] = price
        st["_rows"].append(row)

    out = []
    for st in by_id.values():
        st["updated"] = latest_timestamp(st.pop("_rows"))
        if st["prices"]:
            out.append(st)
    out.sort(key=lambda s: s["id"])
    return out


def main() -> int:
    out_path = Path(__file__).resolve().parent.parent / "data" / "stations.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    with httpx.Client(headers=HEADERS, http2=True) as client:
        print("Fetching DGEG PesquisarPostos…", file=sys.stderr)
        rows = fetch_all(client)
        print(f"Got {len(rows)} (station × fuel) rows.", file=sys.stderr)

    stations = build_stations(rows)

    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(stations),
        "fuel_types": [
            {"id": fid, "label": label, "order": order}
            for fid, label, order in sorted(
                ((v[0], v[1], v[2]) for v in FUEL_TYPE_MAP.values()),
                key=lambda t: t[2],
            )
        ],
        "stations": stations,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(
        f"Wrote {len(stations)} stations to {out_path} in {time.time()-t0:.1f}s",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
