/* Gas Prices Finder — frontend.

   Loads data/stations.json (PT + ES) and renders Leaflet markers + a station
   list filtered by fuel type, brand, search/city, and radius. */

(() => {
'use strict';

// ── Config ────────────────────────────────────────────────────────────
const LISBON = [38.7223, -9.1393];
const DEFAULT_ZOOM = 13;
const MARKER_CAP = 250;
const STORAGE_KEY = 'gpf:tiles';

const TILE_LAYERS = {
  voyager: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap, © CARTO',
    maxZoom: 19,
    subdomains: 'abcd',
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap, © CARTO',
    maxZoom: 19,
    subdomains: 'abcd',
  },
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap, © CARTO',
    maxZoom: 19,
    subdomains: 'abcd',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, USGS, AeroGRID',
    maxZoom: 19,
    subdomains: '',
  },
};

// Brand → web domain lookup. We use icons.duckduckgo.com which renders the
// site's high-res favicon; works for most major fuel chains.  Unknown brands
// fall back to brand initials.
const BRAND_DOMAIN = {
  // PT
  'GALP': 'galp.pt',
  'REPSOL': 'repsol.pt',
  'BP': 'bp.com',
  'CEPSA': 'cepsa.pt',
  'PRIO': 'prio.pt',
  'INTERMARCHÉ': 'intermarche.pt',
  'INTERMARCHE': 'intermarche.pt',
  'AUCHAN': 'auchan.pt',
  'CONTINENTE': 'continente.pt',
  'PINGO DOCE': 'pingodoce.pt',
  'AVIA': 'avia.pt',
  'GULF': 'gulf.pt',
  'OZ': 'ozenergia.pt',
  'OZ ENERGIA': 'ozenergia.pt',
  'TFUEL': 'tfuel.pt',
  'ESCLATOIL': 'esclatoil.com',
  'PADRÃO': 'padrao-distribuicao.pt',
  // ES
  'SHELL': 'shell.com',
  'PETRONOR': 'petronor.es',
  'DISA': 'disagrupo.es',
  'CARREFOUR': 'carrefour.es',
  'BALLENOIL': 'ballenoil.es',
  'PLENERGY': 'plenergy.com',
  'PLENOIL': 'plenoil.es',
  'ALCAMPO': 'alcampo.es',
  'MEROIL': 'meroil.com',
  'SARAS': 'saras.com',
  'TOTAL': 'totalenergies.com',
  'TOTALENERGIES': 'totalenergies.com',
  'ENI': 'eni.com',
  'AGIP': 'eni.com',
  'Q8': 'q8.com',
  'TAMOIL': 'tamoil.com',
  'GASEXPRESS': 'gasexpres.es',
};

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ── State ─────────────────────────────────────────────────────────────
const state = {
  stations: [],
  fuelTypes: [],
  generatedAt: '',
  fuel: 'gas95',
  brand: '',
  radiusKm: 0,
  searchText: '',          // free-text fragment
  selectedCity: null,      // {name, country, lat, lng} when user picked from autocomplete
  sortBy: 'distance',
  userPos: null,
  selectedId: null,
  listOpen: false,
  tileStyle: localStorage.getItem(STORAGE_KEY) || 'voyager',
  cityIndex: [],           // [{key, name, country, lat, lng, count}]
};

// ── Map ───────────────────────────────────────────────────────────────
const map = L.map('map', { center: LISBON, zoom: DEFAULT_ZOOM, zoomControl: false });
L.control.zoom({ position: 'bottomright' }).addTo(map);

let tileLayer = null;
function applyTileStyle(name) {
  const cfg = TILE_LAYERS[name] || TILE_LAYERS.voyager;
  if (tileLayer) tileLayer.remove();
  tileLayer = L.tileLayer(cfg.url, {
    attribution: cfg.attribution,
    maxZoom: cfg.maxZoom,
    subdomains: cfg.subdomains || 'abc',
  }).addTo(map);
  tileLayer.bringToBack();
  document.body.classList.remove('tiles-voyager', 'tiles-light', 'tiles-dark', 'tiles-satellite');
  document.body.classList.add('tiles-' + name);
  state.tileStyle = name;
  localStorage.setItem(STORAGE_KEY, name);
  $$('#map-style-switcher .ms-btn').forEach(b =>
    b.setAttribute('aria-checked', b.dataset.style === name ? 'true' : 'false'));
}
applyTileStyle(state.tileStyle);

const markerLayer = L.layerGroup().addTo(map);
const markerById = new Map();
let userMarker = null;
let activePopup = null;

// ── Helpers ───────────────────────────────────────────────────────────
function haversineKm(a, b) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function priceClass(p) {
  if (p == null) return '';
  if (p < 1.55) return 'p-cheap';
  if (p < 1.85) return 'p-mid';
  return 'p-pricey';
}

function formatPrice(p) { return p == null ? '—' : '€' + p.toFixed(3); }

function brandInitials(brand) {
  if (!brand) return '?';
  const parts = brand.split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || parts[0]?.[1] || '')).toUpperCase();
}

function brandLogoUrl(brand) {
  if (!brand) return null;
  const key = brand.toUpperCase().trim();
  const domain = BRAND_DOMAIN[key];
  if (!domain) return null;
  return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
}

function titleCase(s) {
  return (s || '').toLowerCase().replace(/(^|\s|-|\/|\.|')([a-záàâãéêíóôõúçñ])/gi,
    (_, p, c) => p + c.toUpperCase());
}

function fuelLabel(id) {
  const f = state.fuelTypes.find(t => t.id === id);
  return f ? f.label : id;
}

function flagFor(country) {
  return country === 'ES' ? '🇪🇸' : country === 'PT' ? '🇵🇹' : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

function shortBrand(b) {
  if (!b) return '';
  const t = titleCase(b);
  if (t.length <= 9) return t;
  return t.split(' ')[0].slice(0, 9);
}

function showToast(text, withSpinner = false) {
  const el = $('#toast');
  el.innerHTML = '';
  if (withSpinner) {
    const sp = document.createElement('span');
    sp.className = 'spinner';
    el.append(sp);
  }
  const t = document.createElement('span');
  t.textContent = text;
  el.append(t);
  el.hidden = false;
}
function hideToast() { $('#toast').hidden = true; }

// Build a "tile" element (logo if known, initials otherwise).
function brandTile(brand, cls = 'brand-tile') {
  const el = document.createElement('div');
  el.className = cls;
  const url = brandLogoUrl(brand);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { el.removeChild(img); el.textContent = brandInitials(brand); };
    el.append(img);
  } else {
    el.textContent = brandInitials(brand);
  }
  return el;
}

// ── Data load ─────────────────────────────────────────────────────────
async function loadStations() {
  showToast('A carregar postos…', true);
  try {
    const r = await fetch('data/stations.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const json = await r.json();
    state.stations = (json.stations || []).map(s => ({
      ...s,
      _displayName: titleCase(s.name),
      _displayBrand: titleCase(s.brand),
      _searchHaystack: [
        s.name, s.brand, s.address, s.locality, s.municipality, s.district,
      ].join(' ').toLowerCase(),
    }));
    state.fuelTypes = json.fuel_types || [];
    state.generatedAt = json.generated_at || '';
    state.cityIndex = buildCityIndex(state.stations);
    populateFuelSelect();
    populateBrands();
    hideToast();
  } catch (err) {
    showToast('Erro a carregar dados: ' + err.message);
    console.error(err);
  }
}

// City index: unique (locality | municipality, country) with avg lat/lng
// across all stations in that city.
function buildCityIndex(stations) {
  const buckets = new Map();
  for (const s of stations) {
    const cityName = (s.municipality || s.locality || '').trim();
    if (!cityName) continue;
    const key = (cityName.toLowerCase() + '|' + s.country);
    let b = buckets.get(key);
    if (!b) {
      b = { name: titleCase(cityName), country: s.country, lat: 0, lng: 0, count: 0 };
      buckets.set(key, b);
    }
    b.lat += s.lat;
    b.lng += s.lng;
    b.count += 1;
  }
  const idx = [];
  for (const b of buckets.values()) {
    if (b.count < 1) continue;
    idx.push({
      key: b.name.toLowerCase() + '|' + b.country,
      name: b.name,
      country: b.country,
      lat: b.lat / b.count,
      lng: b.lng / b.count,
      count: b.count,
    });
  }
  return idx;
}

function populateFuelSelect() {
  const available = new Set();
  for (const s of state.stations) for (const k of Object.keys(s.prices)) available.add(k);
  const fuels = state.fuelTypes.filter(f => available.has(f.id));
  if (!fuels.find(f => f.id === state.fuel)) state.fuel = fuels[0]?.id || state.fuel;

  const sel = $('#fuel-select');
  sel.innerHTML = '';
  for (const f of fuels) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.label;
    sel.append(o);
  }
  sel.value = state.fuel;
}

function populateBrands() {
  const sel = $('#brand-select');
  // Keep "Todas as marcas" then list every distinct brand alphabetically.
  const brands = Array.from(new Set(state.stations.map(s => s.brand))).sort();
  for (const br of brands) {
    const o = document.createElement('option');
    o.value = br;
    o.textContent = titleCase(br);
    sel.append(o);
  }
  if (typeof window.__sizeBrand === 'function') window.__sizeBrand();
}

// ── Filtering / sorting ──────────────────────────────────────────────
function visibleStations() {
  const { fuel, brand, searchText, selectedCity, radiusKm, userPos } = state;

  let list = state.stations.filter(s => s.prices[fuel] != null);

  if (brand) list = list.filter(s => s.brand === brand);

  // Free-text search filter (only when no city is locked in).
  if (!selectedCity && searchText.trim()) {
    const term = searchText.trim().toLowerCase();
    list = list.filter(s => s._searchHaystack.includes(term));
  }

  // Distance from a reference point.  Priority: locked city → user → map center.
  let centerArr;
  if (selectedCity) centerArr = [selectedCity.lat, selectedCity.lng];
  else if (userPos)  centerArr = userPos;
  else {
    const c = map.getCenter();
    centerArr = [c.lat, c.lng];
  }
  for (const s of list) s._distance = haversineKm(centerArr, [s.lat, s.lng]);

  if (radiusKm > 0) {
    list = list.filter(s => s._distance <= radiusKm);
  } else {
    const b = map.getBounds();
    list = list.filter(s => b.contains([s.lat, s.lng]));
  }

  list.sort((a, b) =>
    state.sortBy === 'price'
      ? (a.prices[fuel] - b.prices[fuel]) || (a._distance - b._distance)
      : (a._distance - b._distance)
  );
  return list;
}

// ── Markers ──────────────────────────────────────────────────────────
function renderMarkers(list) {
  markerLayer.clearLayers();
  markerById.clear();

  const cheapestId = list.length ? list.slice().sort((a, b) =>
    a.prices[state.fuel] - b.prices[state.fuel])[0].id : null;

  const visible = list.slice(0, MARKER_CAP);

  for (const s of visible) {
    const price = s.prices[state.fuel];
    const isSel = s.id === state.selectedId;
    const isCheap = s.id === cheapestId;
    const cls = ['price-marker'];
    if (isSel) cls.push('is-selected');
    if (isCheap && !isSel) cls.push('is-cheapest');

    const logo = brandLogoUrl(s.brand);
    const logoImg = logo ? `<img class="pm-logo" src="${escapeHtml(logo)}" alt="" onerror="this.remove()" />` : '';
    const html = `
      <div class="${cls.join(' ')}">
        ${logoImg}
        <div class="pm-brand">${escapeHtml(shortBrand(s.brand))}</div>
        <div class="pm-price">${formatPrice(price)}</div>
      </div>`;

    const icon = L.divIcon({
      className: '',
      html,
      iconSize: null,
      iconAnchor: [32, 18],
    });
    const m = L.marker([s.lat, s.lng], { icon }).addTo(markerLayer);
    m.on('click', () => selectStation(s, { pan: true }));
    markerById.set(s.id, m);
  }
}

// ── Popup ────────────────────────────────────────────────────────────
function popupNode(s) {
  const root = document.createElement('div');
  root.className = 'popup';

  // Head (logo above brand name + station name)
  const head = document.createElement('div');
  head.className = 'popup-head';
  const stack = document.createElement('div');
  stack.className = 'pop-brand-stack';
  stack.append(brandTile(s.brand, 'pop-brand-tile'));
  const bn = document.createElement('div');
  bn.className = 'pop-brand-name';
  bn.textContent = s._displayBrand;
  stack.append(bn);
  head.append(stack);

  const name = document.createElement('div');
  name.className = 'pop-name';
  name.textContent = s._displayName || titleCase(s.locality);
  head.append(name);

  const meta = document.createElement('div');
  meta.className = 'pop-meta';
  const dist = state.userPos || state.selectedCity ? `${s._distance.toFixed(1)} km` : '';
  meta.textContent = [titleCase(s.address), titleCase(s.locality), dist].filter(Boolean).join(' · ') +
    (s.country === 'ES' ? '   🇪🇸 Espanha' : '');
  head.append(meta);
  root.append(head);

  // Prices
  const prices = document.createElement('div');
  prices.className = 'popup-prices';
  for (const f of state.fuelTypes) {
    const p = s.prices[f.id];
    if (p == null) continue;
    const row = document.createElement('div');
    row.className = 'popup-price-row' + (f.id === state.fuel ? ' is-active' : '');
    const lbl = document.createElement('span'); lbl.className = 'pp-label'; lbl.textContent = f.label;
    const pri = document.createElement('span');
    pri.className = 'pp-price ' + priceClass(p);
    pri.textContent = formatPrice(p);
    row.append(lbl, pri);
    prices.append(row);
  }
  root.append(prices);

  // Foot
  const foot = document.createElement('div');
  foot.className = 'popup-foot';
  const a = document.createElement('a');
  a.className = 'popup-directions';
  a.href = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'Direções';
  foot.append(a);
  if (s.updated) {
    const u = document.createElement('div');
    u.className = 'popup-updated';
    u.textContent = 'Actualizado: ' + s.updated;
    foot.append(u);
  }
  root.append(foot);
  return root;
}

function selectStation(s, { pan = false } = {}) {
  state.selectedId = s.id;
  if (pan) map.panTo([s.lat, s.lng], { animate: true, duration: 0.4 });

  if (activePopup) activePopup.remove();
  activePopup = L.popup({ closeButton: true, offset: [0, -14], autoPan: true })
    .setLatLng([s.lat, s.lng])
    .setContent(popupNode(s))
    .openOn(map);
  activePopup.on('remove', () => {
    if (state.selectedId === s.id) {
      state.selectedId = null;
      render();
    }
  });
  render();
}

// ── List ─────────────────────────────────────────────────────────────
function renderList(list) {
  const ul = $('#station-list');
  ul.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'station-list-empty';
    li.textContent = 'Nenhum posto encontrado para os filtros actuais.';
    ul.append(li);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const s of list.slice(0, 80)) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'station-row' + (s.id === state.selectedId ? ' is-selected' : '');

    btn.append(brandTile(s.brand));

    const info = document.createElement('div');
    info.className = 'station-info';
    const name = document.createElement('div');
    name.className = 'station-name';
    if (s.country === 'ES') {
      const flag = document.createElement('span');
      flag.className = 'country-flag';
      flag.textContent = '🇪🇸';
      name.append(flag);
    }
    name.append(document.createTextNode(s._displayName || titleCase(s.locality)));
    const meta = document.createElement('div');
    meta.className = 'station-meta';
    const distStr = (state.userPos || state.selectedCity) ? ` · ${s._distance.toFixed(1)} km` : '';
    meta.textContent = `${titleCase(s.address) || titleCase(s.locality)}${distStr}`;
    info.append(name, meta);

    const pb = document.createElement('div');
    pb.className = 'station-price-block';
    const price = document.createElement('div');
    const p = s.prices[state.fuel];
    price.className = 'station-price ' + priceClass(p);
    price.textContent = formatPrice(p);
    const sub = document.createElement('div');
    sub.className = 'station-price-fuel';
    sub.textContent = fuelLabel(state.fuel);
    pb.append(price, sub);

    btn.append(info, pb);
    btn.addEventListener('click', () => selectStation(s, { pan: true }));
    li.append(btn);
    frag.append(li);
  }
  ul.append(frag);
}

// ── Stat row ─────────────────────────────────────────────────────────
function renderStats(list) {
  $('#count-label').textContent = `${list.length} posto${list.length === 1 ? '' : 's'}`;

  const cheapest = list.length
    ? list.slice().sort((a, b) => a.prices[state.fuel] - b.prices[state.fuel])[0]
    : null;

  const chip = $('#cheapest-chip');
  if (cheapest) {
    chip.hidden = false;
    $('#cheapest-price').textContent = formatPrice(cheapest.prices[state.fuel]);
  } else {
    chip.hidden = true;
  }
}

// ── Render orchestrator ──────────────────────────────────────────────
function render() {
  const list = visibleStations();
  renderMarkers(list);
  renderStats(list);
  renderList(list);
}

// ── User location ────────────────────────────────────────────────────
function setUserMarker(lat, lng) {
  if (userMarker) userMarker.remove();
  const icon = L.divIcon({
    className: '',
    html: '<div class="loc-dot"><div class="loc-dot-ring"></div><div class="loc-dot-core"></div></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  userMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
}

function locate({ silent = false } = {}) {
  if (!navigator.geolocation) {
    if (!silent) showToast('Geolocalização não disponível neste browser.');
    return;
  }
  $('#locate-btn')?.classList.add('is-locating');
  if (!silent) showToast('A localizar…', true);
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      state.userPos = [lat, lng];
      setUserMarker(lat, lng);
      map.setView([lat, lng], DEFAULT_ZOOM, { animate: true });
      const radSel = $('#radius-select');
      state.radiusKm = 5;
      if (radSel) { radSel.value = '5'; radSel.classList.toggle('has-value', false); }
      $('#locate-btn')?.classList.remove('is-locating');
      hideToast();
      render();
    },
    err => {
      $('#locate-btn')?.classList.remove('is-locating');
      const msg = err.code === 1
        ? 'Permissão de localização negada.'
        : 'Não foi possível obter a localização.';
      if (!silent) {
        showToast(msg);
        setTimeout(hideToast, 2200);
      } else {
        hideToast();
      }
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }
  );
}

// ── Autocomplete (cities) ────────────────────────────────────────────
let acIndex = -1;
function searchCities(q, max = 8) {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  // Prefer prefix matches, then substring matches; rank by station count.
  const pref = [], sub = [];
  for (const c of state.cityIndex) {
    const lc = c.name.toLowerCase();
    if (lc.startsWith(term)) pref.push(c);
    else if (lc.includes(term)) sub.push(c);
  }
  pref.sort((a, b) => b.count - a.count);
  sub.sort((a, b) => b.count - a.count);
  return pref.concat(sub).slice(0, max);
}

function renderAutocomplete(items) {
  const ac = $('#autocomplete');
  ac.innerHTML = '';
  if (!items.length) { ac.hidden = true; return; }
  items.forEach((c, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ac-item' + (i === acIndex ? ' is-active' : '');
    btn.dataset.idx = String(i);
    btn.innerHTML = `
      <span class="ac-flag">${flagFor(c.country)}</span>
      <span class="ac-name">${escapeHtml(c.name)}</span>
      <span class="ac-meta">${c.count} posto${c.count===1?'':'s'}</span>`;
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => pickCity(c));
    li.append(btn);
    ac.append(li);
  });
  ac.hidden = false;
}

function pickCity(c) {
  state.selectedCity = c;
  state.searchText = c.name;
  $('#search').value = c.name;
  $('#search-clear').hidden = false;
  $('#autocomplete').hidden = true;
  acIndex = -1;
  // Pan map and let radius do its thing.  If radius is "Mapa visível",
  // zoom to a reasonable city level.
  map.setView([c.lat, c.lng], 13, { animate: true });
  render();
}

function clearSearch() {
  state.selectedCity = null;
  state.searchText = '';
  $('#search').value = '';
  $('#search-clear').hidden = true;
  $('#autocomplete').hidden = true;
  acIndex = -1;
  render();
}

// ── Wire-up ──────────────────────────────────────────────────────────
function wireUp() {
  // Map style switcher — desktop: clicks just apply.  Mobile: when
  // collapsed, only the active dot is visible; tapping it opens a vertical
  // popover with the three others.  Tapping any dot then applies + closes.
  const switcher = $('#map-style-switcher');
  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
  $$('.ms-dot', switcher).forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (isMobile() && !switcher.classList.contains('is-open') && btn.getAttribute('aria-checked') === 'true') {
        switcher.classList.add('is-open');
        return;
      }
      applyTileStyle(btn.dataset.style);
      switcher.classList.remove('is-open');
    });
  });
  document.addEventListener('click', e => {
    if (!switcher.contains(e.target)) switcher.classList.remove('is-open');
  });

  // Search
  const searchEl = $('#search');
  const clearEl  = $('#search-clear');
  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    const v = searchEl.value;
    clearEl.hidden = !v;
    state.selectedCity = null;
    state.searchText = v;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      acIndex = -1;
      renderAutocomplete(searchCities(v));
      render();
    }, 90);
  });
  searchEl.addEventListener('focus', () => {
    if (searchEl.value && !state.selectedCity) {
      renderAutocomplete(searchCities(searchEl.value));
    }
  });
  searchEl.addEventListener('keydown', e => {
    const ac = $('#autocomplete');
    const items = $$('.ac-item', ac);
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      acIndex = (acIndex + 1) % items.length;
      items.forEach((b, i) => b.classList.toggle('is-active', i === acIndex));
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      acIndex = (acIndex - 1 + items.length) % items.length;
      items.forEach((b, i) => b.classList.toggle('is-active', i === acIndex));
    } else if (e.key === 'Enter' && acIndex >= 0 && items[acIndex]) {
      e.preventDefault();
      items[acIndex].click();
    } else if (e.key === 'Escape') {
      ac.hidden = true; acIndex = -1;
    }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#search-wrap')) $('#autocomplete').hidden = true;
  });
  clearEl.addEventListener('click', () => { clearSearch(); searchEl.focus(); });

  // Locate
  $('#locate-btn').addEventListener('click', () => locate());

  // Fuel select
  const fuelSel = $('#fuel-select');
  fuelSel.addEventListener('change', () => {
    state.fuel = fuelSel.value;
    fuelSel.classList.toggle('has-value', fuelSel.value !== 'gas95');
    render();
  });

  // Brand select — dynamic width on desktop so the pill is only as wide
  // as the selected option text.  Mobile uses a fixed max-width via CSS.
  const brandSel = $('#brand-select');
  const sizeBrand = () => {
    if (window.matchMedia('(max-width: 760px)').matches) {
      brandSel.style.width = '';
      return;
    }
    const opt = brandSel.options[brandSel.selectedIndex];
    if (!opt) return;
    const probe = document.createElement('span');
    const cs = getComputedStyle(brandSel);
    probe.style.cssText = `
      visibility:hidden; position:absolute; white-space:pre;
      font: ${cs.font};
      letter-spacing: ${cs.letterSpacing};
    `;
    probe.textContent = opt.textContent;
    document.body.append(probe);
    const w = probe.offsetWidth;
    document.body.removeChild(probe);
    brandSel.style.width = (w + 44) + 'px'; // padding (16+26) + buffer
  };
  brandSel.addEventListener('change', () => {
    state.brand = brandSel.value;
    brandSel.classList.toggle('has-value', !!brandSel.value);
    sizeBrand();
    render();
  });
  // Resize on viewport changes (covers DevTools toggle / orientation).
  window.addEventListener('resize', sizeBrand);
  // Initial sizing — also re-run after brands populate.
  setTimeout(sizeBrand, 0);
  window.__sizeBrand = sizeBrand;

  // Radius select
  const radSel = $('#radius-select');
  radSel.addEventListener('change', () => {
    state.radiusKm = Number(radSel.value);
    radSel.classList.toggle('has-value', radSel.value !== '0');
    render();
  });

  // List toggle
  const listToggle = $('#list-toggle');
  const listBody = $('#list-body');
  listToggle.addEventListener('click', () => {
    state.listOpen = !state.listOpen;
    listBody.hidden = !state.listOpen;
    listToggle.setAttribute('aria-expanded', state.listOpen ? 'true' : 'false');
  });

  // Sort tabs (now inside the expanded panel)
  $$('.sort-tab').forEach(b => {
    b.addEventListener('click', () => {
      state.sortBy = b.dataset.sort;
      $$('.sort-tab').forEach(t => t.setAttribute('aria-selected', t === b ? 'true' : 'false'));
      render();
    });
  });

  // Cheapest chip — pan to and open the cheapest station.
  $('#cheapest-chip').addEventListener('click', () => {
    const list = visibleStations();
    const cheapest = list.length
      ? list.slice().sort((a, b) => a.prices[state.fuel] - b.prices[state.fuel])[0]
      : null;
    if (cheapest) selectStation(cheapest, { pan: true });
  });

  // Re-render on map move when "Mapa visível" radius is selected.
  map.on('moveend', () => {
    if (state.radiusKm === 0) render();
  });
}

// On mobile the map sits below the white top panel. Expose header /
// top-controls heights as CSS vars so the layout can react to viewport
// changes without hard-coding numbers.
function syncTopHeights() {
  const header = document.querySelector('.app-header');
  const top = document.querySelector('.top-controls');
  const bottom = document.querySelector('.bottom-panel');
  const root = document.documentElement;
  if (header) root.style.setProperty('--header-h', header.offsetHeight + 'px');
  if (top) root.style.setProperty('--top-controls-h', top.offsetHeight + 'px');
  if (bottom) root.style.setProperty('--bottom-panel-h', bottom.offsetHeight + 'px');
  if (typeof map !== 'undefined' && map.invalidateSize) map.invalidateSize();
}

function watchTopHeights() {
  syncTopHeights();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(syncTopHeights);
    ['.app-header', '.top-controls', '.bottom-panel']
      .forEach(sel => { const el = document.querySelector(sel); if (el) ro.observe(el); });
  }
  window.addEventListener('resize', syncTopHeights);
  window.addEventListener('orientationchange', syncTopHeights);
}

// ── Boot ─────────────────────────────────────────────────────────────
async function boot() {
  wireUp();
  watchTopHeights();
  await loadStations();
  render();
  locate({ silent: true });
}

window.__app = { state, map, render, visibleStations, applyTileStyle };

boot();

})();
