/* Gas Prices Finder — frontend.
   Loads data/stations.json, renders Leaflet markers + a station list with
   filter pills (fuel type, brand, search, radius) and a "cheapest nearby"
   shortcut. Pure vanilla JS — no build step. */

(() => {
'use strict';

// ── Config ────────────────────────────────────────────────────────────
const LISBON = [38.7223, -9.1393];
const DEFAULT_ZOOM = 13;
const MARKER_CAP = 200;             // hard cap for visible price markers
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

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
  search: '',
  sortBy: 'distance',
  userPos: null,
  selectedId: null,
  listOpen: false,
};

// ── Map ───────────────────────────────────────────────────────────────
const map = L.map('map', { center: LISBON, zoom: DEFAULT_ZOOM, zoomControl: false });
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer(TILE_URL, {
  attribution: '© OpenStreetMap, © CARTO',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);

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
  if (p < 1.70) return 'p-cheap';
  if (p < 1.90) return 'p-mid';
  return 'p-pricey';
}

function formatPrice(p) { return p == null ? '—' : '€' + p.toFixed(3); }

function brandInitials(brand) {
  if (!brand) return '?';
  const parts = brand.split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || parts[0]?.[1] || '')).toUpperCase();
}

function titleCase(s) {
  return (s || '').toLowerCase().replace(/(^|\s|-|\/|\.|')([a-záàâãéêíóôõúç])/g,
    (_, p, c) => p + c.toUpperCase());
}

function fuelLabel(id) {
  const f = state.fuelTypes.find(t => t.id === id);
  return f ? f.label : id;
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
    }));
    state.fuelTypes = json.fuel_types || [];
    state.generatedAt = json.generated_at || '';
    populateFuelPills();
    populateBrands();
    hideToast();
  } catch (err) {
    showToast('Erro a carregar dados: ' + err.message);
    console.error(err);
  }
}

function populateFuelPills() {
  // Only show fuel types that actually exist in the data.
  const available = new Set();
  for (const s of state.stations) for (const k of Object.keys(s.prices)) available.add(k);
  const fuels = state.fuelTypes.filter(f => available.has(f.id));
  if (!fuels.find(f => f.id === state.fuel)) state.fuel = fuels[0]?.id || state.fuel;

  const wrap = $('#fuel-pills');
  wrap.innerHTML = '';
  for (const f of fuels) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill';
    b.textContent = f.label;
    b.dataset.fuel = f.id;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', f.id === state.fuel ? 'true' : 'false');
    b.addEventListener('click', () => {
      state.fuel = f.id;
      $$('.pill[data-fuel]').forEach(p => p.setAttribute('aria-selected', p.dataset.fuel === f.id ? 'true' : 'false'));
      render();
    });
    wrap.append(b);
  }
}

function populateBrands() {
  const sel = $('#brand-select');
  const brands = Array.from(new Set(state.stations.map(s => s.brand))).sort();
  for (const br of brands) {
    const o = document.createElement('option');
    o.value = br;
    o.textContent = titleCase(br);
    sel.append(o);
  }
}

// ── Filtering / sorting ──────────────────────────────────────────────
function visibleStations() {
  const { fuel, brand, search, radiusKm, userPos } = state;
  const center = userPos || map.getCenter();
  const centerArr = userPos || [center.lat, center.lng];
  const term = search.trim().toLowerCase();

  let list = state.stations.filter(s => s.prices[fuel] != null);

  if (brand) list = list.filter(s => s.brand === brand);

  if (term) {
    list = list.filter(s =>
      s._displayName.toLowerCase().includes(term) ||
      s.address.toLowerCase().includes(term) ||
      s.locality.toLowerCase().includes(term) ||
      s.municipality.toLowerCase().includes(term)
    );
  }

  // Distance + radius filter.
  for (const s of list) s._distance = haversineKm(centerArr, [s.lat, s.lng]);

  if (radiusKm > 0) {
    list = list.filter(s => s._distance <= radiusKm);
  } else {
    // "Mapa visível" — use current map bounds.
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

    const html = `
      <div class="${cls.join(' ')}">
        <div class="pm-brand">${escapeHtml(shortBrand(s.brand))}</div>
        <div class="pm-price">${formatPrice(price)}</div>
      </div>`;

    const icon = L.divIcon({
      className: '',
      html,
      iconSize: null,
      iconAnchor: [32, 14],
    });
    const m = L.marker([s.lat, s.lng], { icon }).addTo(markerLayer);
    m.on('click', () => selectStation(s, { pan: true }));
    markerById.set(s.id, m);
  }
}

function shortBrand(b) {
  if (!b) return '';
  const t = titleCase(b);
  if (t.length <= 9) return t;
  return t.split(' ')[0].slice(0, 9);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

// ── Popup ────────────────────────────────────────────────────────────
function popupHtml(s) {
  const rows = state.fuelTypes
    .filter(f => s.prices[f.id] != null)
    .map(f => {
      const active = f.id === state.fuel ? ' is-active' : '';
      const p = s.prices[f.id];
      return `<div class="popup-price-row${active}">
        <span class="pp-label">${escapeHtml(f.label)}</span>
        <span class="pp-price ${priceClass(p)}">${formatPrice(p)}</span>
      </div>`;
    }).join('');

  const lat = s.lat, lng = s.lng;
  const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  const dist = state.userPos ? `${s._distance.toFixed(1)} km` : '';
  const meta = [s.address, s.locality, dist].filter(Boolean).join(' · ');

  return `
    <div class="popup">
      <div class="popup-head">
        <div class="pop-brand-row">
          <div class="pop-brand-tile">${escapeHtml(brandInitials(s.brand))}</div>
          <div class="pop-name">${escapeHtml(s._displayName)}</div>
        </div>
        <div class="pop-meta">${escapeHtml(meta)}</div>
      </div>
      <div class="popup-prices">${rows}</div>
      <div class="popup-foot">
        <a class="popup-directions" href="${dirUrl}" target="_blank" rel="noopener">Direções</a>
        ${s.updated ? `<div class="popup-updated">Actualizado: ${escapeHtml(s.updated)}</div>` : ''}
      </div>
    </div>`;
}

function selectStation(s, { pan = false } = {}) {
  state.selectedId = s.id;
  if (pan) map.panTo([s.lat, s.lng], { animate: true, duration: 0.4 });

  if (activePopup) activePopup.remove();
  activePopup = L.popup({ closeButton: true, offset: [0, -12], autoPan: true })
    .setLatLng([s.lat, s.lng])
    .setContent(popupHtml(s))
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

    const tile = document.createElement('div');
    tile.className = 'brand-tile';
    tile.textContent = brandInitials(s.brand);

    const info = document.createElement('div');
    info.className = 'station-info';
    const name = document.createElement('div');
    name.className = 'station-name';
    name.textContent = s._displayName;
    const meta = document.createElement('div');
    meta.className = 'station-meta';
    const distStr = state.userPos ? ` · ${s._distance.toFixed(1)} km` : '';
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

    btn.append(tile, info, pb);
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
      // Switch to a 5 km radius once we know where the user is.
      const radSel = $('#radius-select');
      state.radiusKm = 5;
      if (radSel) radSel.value = '5';
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

// ── Wire-up ──────────────────────────────────────────────────────────
function wireUp() {
  // Search
  const searchEl = $('#search');
  const clearEl  = $('#search-clear');
  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    clearEl.hidden = !searchEl.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = searchEl.value;
      render();
    }, 120);
  });
  clearEl.addEventListener('click', () => {
    searchEl.value = '';
    clearEl.hidden = true;
    state.search = '';
    render();
    searchEl.focus();
  });

  // Locate
  $('#locate-btn').addEventListener('click', () => locate());

  // Brand select
  const brandSel = $('#brand-select');
  brandSel.addEventListener('change', () => {
    state.brand = brandSel.value;
    brandSel.classList.toggle('has-value', !!brandSel.value);
    render();
  });

  // Radius select
  const radSel = $('#radius-select');
  radSel.addEventListener('change', () => {
    state.radiusKm = Number(radSel.value);
    render();
  });

  // List toggle
  const listToggle = $('#list-toggle');
  const listEl = $('#station-list');
  listToggle.addEventListener('click', e => {
    if (e.target.closest('.sort-tab')) return;
    state.listOpen = !state.listOpen;
    listEl.hidden = !state.listOpen;
    listToggle.setAttribute('aria-expanded', state.listOpen ? 'true' : 'false');
  });

  // Sort tabs
  $$('.sort-tab').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
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

// ── Boot ─────────────────────────────────────────────────────────────
async function boot() {
  wireUp();
  await loadStations();
  render();
  // Try to locate on load — silently, since it's nice-to-have on first visit.
  locate({ silent: true });
}

// Expose for debugging.
window.__app = { state, map, render, visibleStations };

boot();

})();
