"""Fetch every Portuguese + Spanish fuel station and current prices.

Sources (both public, no auth, CORS open):
  - DGEG (PT): https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb/PesquisarPostos
  - Ministerio de Industria (ES):
      https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/

Writes a single snapshot to data/stations.json. The frontend reads this file.
"""

import json
import re
import sys
import time
from pathlib import Path

import httpx
from curl_cffi import requests as curl_requests

PT_URL = "https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb/PesquisarPostos"
ES_URL = (
    "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/"
    "PreciosCarburantes/EstacionesTerrestres/"
)

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
HEADERS = {"User-Agent": UA, "Accept": "application/json, */*"}

# Stable IDs the frontend uses, with a display label and an ordering hint.
FUEL_ORDER = [
    ("gas95",   "Gasolina 95",  1),
    ("gas95p",  "Gasolina 95+", 2),
    ("gas98",   "Gasolina 98",  3),
    ("gas98p",  "Gasolina 98+", 4),
    ("diesel",  "Gasóleo",      5),
    ("dieselp", "Gasóleo+",     6),
    ("gpl",     "GPL Auto",     7),
]

PT_FUEL_MAP = {
    "Gasolina simples 95":  "gas95",
    "Gasolina especial 95": "gas95p",
    "Gasolina 98":          "gas98",
    "Gasolina especial 98": "gas98p",
    "Gasóleo simples":      "diesel",
    "Gasóleo especial":     "dieselp",
    "GPL Auto":             "gpl",
}

# Spanish fields → fuel id (cheapest variant wins where multiple).
ES_FUEL_FIELDS = {
    "Precio Gasolina 95 E5":         "gas95",
    "Precio Gasolina 95 E5 Premium": "gas95p",
    "Precio Gasolina 98 E5":         "gas98",
    "Precio Gasoleo A":              "diesel",
    "Precio Gasoleo Premium":        "dieselp",
    "Precio Gases licuados del petróleo": "gpl",
}


def parse_price(s: str) -> float | None:
    """'1,889 €/litro' / '0,800 €' / '1,449' → 1.889 / 0.800 / 1.449"""
    if not s:
        return None
    m = re.search(r"(\d+[.,]\d+)", s)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", "."))
    except ValueError:
        return None


def parse_coord(s) -> float | None:
    if s is None or s == "":
        return None
    if isinstance(s, (int, float)):
        return float(s)
    try:
        return float(str(s).replace(",", "."))
    except ValueError:
        return None


# ── PT ──────────────────────────────────────────────────────────────────
def fetch_pt(client: httpx.Client) -> list[dict]:
    """Single bulk page from DGEG → one entry per station."""
    r = client.get(PT_URL, params={"qtdPorPagina": 1, "pagina": 1}, timeout=30)
    r.raise_for_status()
    total = (r.json().get("resultado") or [{}])[0].get("Quantidade", 20000)

    r = client.get(
        PT_URL,
        params={"qtdPorPagina": max(total, 20000), "pagina": 1},
        timeout=120,
    )
    r.raise_for_status()
    rows = r.json().get("resultado") or []

    by_id: dict[int, dict] = {}
    for row in rows:
        sid = row.get("Id")
        if sid is None:
            continue
        lat = parse_coord(row.get("Latitude"))
        lng = parse_coord(row.get("Longitude"))
        if lat is None or lng is None or (lat == 0 and lng == 0):
            continue
        fuel_label = (row.get("Combustivel") or "").strip()
        fid = PT_FUEL_MAP.get(fuel_label)
        if not fid:
            continue
        price = parse_price(row.get("Preco"))
        if price is None:
            continue

        st = by_id.get(sid)
        if st is None:
            st = by_id[sid] = {
                "id": f"pt-{sid}",
                "country": "PT",
                "name": (row.get("Nome") or "").strip(),
                "brand": (row.get("Marca") or "").strip() or "Outro",
                "type": (row.get("TipoPosto") or "").strip(),
                "district": (row.get("Distrito") or "").strip(),
                "municipality": (row.get("Municipio") or "").strip(),
                "address": (row.get("Morada") or "").strip(),
                "locality": (row.get("Localidade") or "").strip(),
                "postcode": (row.get("CodPostal") or "").strip(),
                "lat": lat,
                "lng": lng,
                "prices": {},
                "updated": "",
                "_ts": [],
            }
        if fid not in st["prices"] or price < st["prices"][fid]:
            st["prices"][fid] = price
        if row.get("DataAtualizacao"):
            st["_ts"].append(row["DataAtualizacao"])
    for st in by_id.values():
        st["updated"] = max(st.pop("_ts")) if st["_ts"] else ""
    return list(by_id.values())


# ── ES ──────────────────────────────────────────────────────────────────
def fetch_es(_unused: httpx.Client) -> list[dict]:
    """One JSON dump from the Ministry of Industry. The endpoint resets
    plain Python TLS handshakes — curl_cffi impersonates a real browser."""
    r = curl_requests.get(
        ES_URL,
        impersonate="chrome",
        timeout=120,
        headers={"Accept": "application/json"},
    )
    r.raise_for_status()
    data = r.json()
    timestamp = (data.get("Fecha") or "").strip()
    rows = data.get("ListaEESSPrecio") or []
    out = []
    for row in rows:
        lat = parse_coord(row.get("Latitud"))
        lng = parse_coord(row.get("Longitud (WGS84)"))
        if lat is None or lng is None:
            continue
        prices: dict[str, float] = {}
        for field, fid in ES_FUEL_FIELDS.items():
            p = parse_price(row.get(field))
            if p is None:
                continue
            if fid not in prices or p < prices[fid]:
                prices[fid] = p
        if not prices:
            continue
        ideess = row.get("IDEESS") or ""
        rotulo = (row.get("Rótulo") or "").strip()
        # Ministry entries with no real brand name use "Nº 12345" — flatten those.
        if not rotulo or rotulo.lower().startswith("nº"):
            rotulo = "Sin marca"
        out.append({
            "id": f"es-{ideess}",
            "country": "ES",
            "name": (row.get("Municipio") or row.get("Localidad") or "").strip(),
            "brand": rotulo.upper(),
            "type": "",
            "district": (row.get("Provincia") or "").strip(),
            "municipality": (row.get("Municipio") or "").strip(),
            "address": (row.get("Dirección") or "").strip(),
            "locality": (row.get("Localidad") or "").strip(),
            "postcode": (row.get("C.P.") or "").strip(),
            "lat": lat,
            "lng": lng,
            "prices": prices,
            "updated": timestamp,
        })
    return out


# ── Main ────────────────────────────────────────────────────────────────
def main() -> int:
    out_path = Path(__file__).resolve().parent.parent / "data" / "stations.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    with httpx.Client(headers=HEADERS, http2=True) as client:
        print("Fetching DGEG (PT)…", file=sys.stderr)
        pt = fetch_pt(client)
        print(f"  PT: {len(pt)} stations", file=sys.stderr)

        print("Fetching Ministerio de Industria (ES)…", file=sys.stderr)
        try:
            es = fetch_es(client)
            print(f"  ES: {len(es)} stations", file=sys.stderr)
        except Exception as e:
            print(f"  ES fetch failed ({e}); continuing without Spain.", file=sys.stderr)
            es = []

    stations = pt + es
    stations.sort(key=lambda s: (s["country"], s["id"]))

    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(stations),
        "fuel_types": [
            {"id": fid, "label": label, "order": order}
            for fid, label, order in FUEL_ORDER
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
