/* Charge Compare — Tesla Model 3 LR AWD 2024
 * Vanilla JS, no build step. State lives in localStorage on the device.
 */
(() => {
'use strict';

// ---------- constants ----------
const LS = { settings: 'tcc.settings.v1', favs: 'tcc.favs.v1', state: 'tcc.state.v1' };

const DEFAULTS = {
  apiKey: '',
  usableKwh: 75,      // 2024 M3 LR AWD: ~78 kWh gross, ~75 usable
  whPerKm: 155,       // real-world mixed driving in Malaysia
  acLoss: 10,         // % of billed kWh lost on AC
  dcLoss: 5,          // % of billed kWh lost on DC
  onboardAc: 11,      // kW, Tesla onboard charger limit
  wearPerKm: 0.08,    // RM per km (tyres, brakes, depreciation share)
  gentariPay: 5,
  gentariCredit: 30,
};

// Approximate DC charging curve for 2024 Model 3 LR AWD: [SoC %, max kW]
const DC_CURVE = [
  [0, 250], [10, 250], [20, 200], [30, 165], [40, 135], [50, 110],
  [60, 85], [70, 65], [80, 45], [90, 30], [100, 15],
];

const MANUAL_AVG_KMH = 45; // used when km given but minutes blank

// ---------- state ----------
let settings = load(LS.settings, {});
settings = { ...DEFAULTS, ...settings };
let favs = load(LS.favs, []);
let state = load(LS.state, {
  socNow: 30, socTarget: 80,
  origin: null,                     // {lat,lng,label}
  slots: [ emptySlot(), emptySlot() ],
});
if (!Array.isArray(state.slots) || state.slots.length < 2) state.slots = [emptySlot(), emptySlot()];

let mapsReady = false;
let mapsLoading = null;
let lastError = '';
const routeCache = new Map();     // key -> {km, min}

function emptySlot() {
  return { favId: '', name: '', address: '', lat: null, lng: null, rate: '', type: 'DC', kw: '', gentari: false, parking: '', parkingUnit: 'flat', manualKm: '', manualMin: '' };
}
function load(k, fallback) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch { return fallback; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function persist() { save(LS.state, state); }
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const rm = (v) => 'RM ' + (Math.round(v * 100) / 100).toFixed(2);
const num = (v, d = 1) => Number(v).toFixed(d);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const ICON = (n) => `<svg><use href="#i-${n}"/></svg>`;
const LOCATE_HTML = ICON('locate') + '<span>Use my location</span>';

// ---------- physics ----------
function dcMaxKw(soc) {
  if (soc <= DC_CURVE[0][0]) return DC_CURVE[0][1];
  for (let i = 1; i < DC_CURVE.length; i++) {
    const [s1, k1] = DC_CURVE[i];
    if (soc <= s1) {
      const [s0, k0] = DC_CURVE[i - 1];
      return k0 + (k1 - k0) * (soc - s0) / (s1 - s0);
    }
  }
  return DC_CURVE[DC_CURVE.length - 1][1];
}

/** Minutes to charge from socA to socB at a charger. Power is what the charger delivers; losses reduce what lands in the pack. */
function chargeMinutes(socA, socB, type, chargerKw) {
  if (socB <= socA) return 0;
  const loss = (type === 'AC' ? settings.acLoss : settings.dcLoss) / 100;
  const stepPct = 0.5;
  const stepKwh = settings.usableKwh * stepPct / 100;
  let hours = 0;
  for (let s = socA; s < socB; s += stepPct) {
    const cap = type === 'AC' ? Math.min(chargerKw, settings.onboardAc) : Math.min(chargerKw, dcMaxKw(s));
    const intoPack = Math.max(cap * (1 - loss), 0.5);
    hours += stepKwh / intoPack;
  }
  return hours * 60;
}

/** Full cost model for one station. */
function evaluate(st, km, driveMin) {
  const driveKwh = km * settings.whPerKm / 1000;
  const socArrive = state.socNow - driveKwh / settings.usableKwh * 100;
  const loss = (st.type === 'AC' ? settings.acLoss : settings.dcLoss) / 100;
  const packKwh = Math.max(0, (state.socTarget - socArrive) / 100 * settings.usableKwh);
  const billedKwh = packKwh / (1 - loss);
  const rate = Number(st.rate) || 0;
  const gFactor = st.gentari ? (settings.gentariPay / settings.gentariCredit) : 1;
  const effRate = rate * gFactor;
  const listedCost = billedKwh * rate;
  const chargeCost = billedKwh * effRate;
  const detourKwhBilled = driveKwh / (1 - loss);
  const detourEnergyCost = detourKwhBilled * effRate;
  const chargeMin = chargeMinutes(Math.max(socArrive, 0), state.socTarget, st.type, Number(st.kw) || 1);
  const parkingRate = Number(st.parking) || 0;
  const parkingCost = st.parkingUnit === 'hour' ? Math.ceil(chargeMin / 60) * parkingRate : parkingRate;
  const wearCost = km * settings.wearPerKm;
  const totalMin = driveMin + chargeMin;
  const total = chargeCost + parkingCost + wearCost;
  return { km, driveMin, driveKwh, socArrive, packKwh, billedKwh, rate, effRate, gFactor, listedCost, chargeCost,
           detourEnergyCost, chargeMin, parkingCost, parkingRate, wearCost, totalMin, total };
}

// ---------- Google Maps ----------
function loadMaps() {
  if (mapsReady) return Promise.resolve();
  if (mapsLoading) return mapsLoading;
  if (!settings.apiKey) return Promise.reject(new Error('No API key'));
  mapsLoading = new Promise((resolve, reject) => {
    window.__gmapsReady = () => { mapsReady = true; resolve(); };
    window.gm_authFailure = () => { mapsReady = false; mapsLoading = null; lastError = 'Maps JavaScript API rejected the key (gm_authFailure). Check key, referrer restriction and that Maps JavaScript API is enabled.'; reject(new Error('Google rejected the API key')); showToast('Google rejected the API key. Check it in Settings.'); };
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(settings.apiKey) + '&libraries=places&v=weekly&loading=async&callback=__gmapsReady';
    s.async = true;
    s.onerror = () => { mapsLoading = null; reject(new Error('Could not load Google Maps')); };
    document.head.appendChild(s);
  });
  return mapsLoading;
}

/** Mount a Places autocomplete into container; onPick({name,address,lat,lng}). */
async function mountAutocomplete(container, onPick, placeholder) {
  container.innerHTML = '';
  try {
    await loadMaps();
    await google.maps.importLibrary('places');
  } catch (e) { return false; }
  let el;
  try {
    el = new google.maps.places.PlaceAutocompleteElement({ includedRegionCodes: ['my'] });
  } catch { try { el = new google.maps.places.PlaceAutocompleteElement({ componentRestrictions: { country: ['my'] } }); } catch { return false; } }
  if (placeholder) el.setAttribute('placeholder', placeholder);
  el.addEventListener('gmp-error', (ev) => { const e = ev.error || ev.detail || {}; lastError = 'Places: ' + (e.name || '') + ' ' + (e.message || JSON.stringify(e)); showToast(lastError); });
  el.addEventListener('gmp-requesterror', (ev) => { const e = ev.error || ev.detail || {}; lastError = 'Places: ' + (e.name || '') + ' ' + (e.message || JSON.stringify(e)); showToast(lastError); });
  const handle = async (place) => {
    try {
      await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
      const loc = place.location;
      onPick({
        name: place.displayName || '',
        address: place.formattedAddress || '',
        lat: typeof loc.lat === 'function' ? loc.lat() : loc.lat,
        lng: typeof loc.lng === 'function' ? loc.lng() : loc.lng,
      });
    } catch (e) { showToast('Could not read that place: ' + e.message); }
  };
  el.addEventListener('gmp-select', (ev) => { if (ev.placePrediction) handle(ev.placePrediction.toPlace()); });
  el.addEventListener('gmp-placeselect', (ev) => { if (ev.place) handle(ev.place); });
  container.appendChild(el);
  return true;
}

/** Route matrix: origin -> stations[]. Returns array of {km,min}|null. */
async function routeMatrix(origin, stations) {
  const need = [];
  const out = stations.map((st, i) => {
    if (st.lat == null || st.lng == null) return null;
    const key = [origin.lat.toFixed(4), origin.lng.toFixed(4), st.lat.toFixed(5), st.lng.toFixed(5)].join('|');
    if (routeCache.has(key)) return routeCache.get(key);
    need.push({ i, key, st });
    return undefined;
  });
  if (need.length && settings.apiKey) {
    const body = {
      origins: [{ waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } }],
      destinations: need.map(n => ({ waypoint: { location: { latLng: { latitude: n.st.lat, longitude: n.st.lng } } } })),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
    };
    const res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': settings.apiKey,
                 'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = 'Routes API error ' + res.status;
      try { const j = await res.json(); msg += ': ' + (j.error?.message || j[0]?.error?.message || ''); } catch {}
      throw new Error(msg);
    }
    const rows = await res.json();
    for (const r of rows) {
      const n = need[r.destinationIndex];
      if (!n) continue;
      if (r.condition && r.condition !== 'ROUTE_EXISTS') { out[n.i] = null; continue; }
      const v = { km: (r.distanceMeters || 0) / 1000, min: parseFloat(r.duration || '0') / 60 };
      routeCache.set(n.key, v);
      out[n.i] = v;
    }
  }
  return out.map(v => v === undefined ? null : v);
}

// ---------- UI: battery ----------
function bindSoc() {
  const pairs = [['socNow', 'socNowRange'], ['socTarget', 'socTargetRange']];
  for (const [n, r] of pairs) {
    const ni = $('#' + n), ri = $('#' + r);
    ni.value = ri.value = state[n];
    const set = (v) => { v = Math.max(0, Math.min(100, Math.round(Number(v) || 0))); state[n] = v; ni.value = ri.value = v; persist(); renderBatteryHint(); };
    ni.addEventListener('input', () => set(ni.value));
    ri.addEventListener('input', () => set(ri.value));
  }
  renderBatteryHint();
}
function renderBatteryHint() {
  const kwh = Math.max(0, (state.socTarget - state.socNow) / 100 * settings.usableKwh);
  const rangeNow = state.socNow / 100 * settings.usableKwh / (settings.whPerKm / 1000);
  $('#batteryHint').textContent = state.socTarget <= state.socNow
    ? 'Target is not above current charge.'
    : `About ${num(kwh, 1)} kWh into the pack, plus whatever you burn getting there. Roughly ${Math.round(rangeNow)} km of range right now.`;
}

// ---------- UI: origin ----------
function renderOrigin() {
  const h = $('#originHint');
  if (state.origin) h.innerHTML = `Starting at <b>${esc(state.origin.label)}</b> <button class="link-btn" id="clearOrigin">clear</button>`;
  else h.textContent = 'No starting point set.';
  $('#clearOrigin')?.addEventListener('click', () => { state.origin = null; persist(); renderOrigin(); });
}
function bindOrigin() {
  $('#btnLocate').addEventListener('click', () => {
    const btn = $('#btnLocate');
    if (!navigator.geolocation) return showToast('Geolocation not available in this browser.');
    btn.disabled = true; btn.innerHTML = ICON('locate') + '<span>Locating…</span>';
    navigator.geolocation.getCurrentPosition(pos => {
      state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: `Current location (±${Math.round(pos.coords.accuracy)} m)` };
      persist(); renderOrigin();
      btn.disabled = false; btn.innerHTML = LOCATE_HTML;
    }, err => {
      showToast('Location failed: ' + err.message + (location.protocol === 'http:' && location.hostname !== 'localhost' ? ' (needs HTTPS)' : ''));
      btn.disabled = false; btn.innerHTML = LOCATE_HTML;
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
  renderOrigin();
  mountAutocomplete($('#originAuto'), p => { state.origin = { lat: p.lat, lng: p.lng, label: p.name || p.address }; persist(); renderOrigin(); }, 'or search a starting place')
    .then(ok => { if (!ok) $('#originAuto').innerHTML = '<div class="hint">Add a Google API key in Settings to search places.</div>'; });
}

// ---------- UI: slots ----------
function renderSlots() {
  const host = $('#slots');
  host.innerHTML = '';
  state.slots.forEach((slot, idx) => {
    const node = $('#slotTpl').content.firstElementChild.cloneNode(true);
    node.dataset.idx = idx;
    const pick = $('.slot-pick', node);
    pick.innerHTML = `<option value="">Custom charger…</option>` + favs.map(f => `<option value="${esc(f.id)}">${esc(f.name)}${f.gentari ? ' ★' : ''}</option>`).join('');
    pick.value = favs.some(f => f.id === slot.favId) ? slot.favId : '';
    if (pick.value === '' && slot.favId) { slot.favId = ''; }
    const custom = $('.slot-custom', node);
    custom.classList.toggle('hidden', !!slot.favId);
    $('.slot-name', node).value = slot.name;
    $('.slot-address', node).value = slot.address;
    $('.slot-rate', node).value = slot.rate;
    $('.slot-type', node).value = slot.type;
    $('.slot-kw', node).value = slot.kw;
    $('.slot-gentari', node).checked = !!slot.gentari;
    $('.slot-parking', node).value = slot.parking ?? '';
    $('.slot-parking-unit', node).value = slot.parkingUnit || 'flat';
    $('.slot-km', node).value = slot.manualKm;
    $('.slot-min', node).value = slot.manualMin;
    $('.slot-remove', node).classList.toggle('hidden', state.slots.length <= 2);
    renderSlotSummary(node, slot);

    pick.addEventListener('change', () => {
      slot.favId = pick.value;
      if (slot.favId) {
        const f = favs.find(x => x.id === slot.favId);
        Object.assign(slot, { name: f.name, address: f.address, lat: f.lat, lng: f.lng, rate: f.rate, type: f.type, kw: f.kw, gentari: !!f.gentari, parking: f.parking ?? '', parkingUnit: f.parkingUnit || 'flat' });
      }
      persist(); renderSlots();
    });
    const bind = (sel, key, transform = v => v) => $(sel, node).addEventListener('input', e => { slot[key] = transform(e.target.type === 'checkbox' ? e.target.checked : e.target.value); persist(); renderSlotSummary(node, slot); });
    bind('.slot-name', 'name'); bind('.slot-address', 'address'); bind('.slot-rate', 'rate'); bind('.slot-type', 'type'); bind('.slot-kw', 'kw'); bind('.slot-gentari', 'gentari');
    bind('.slot-km', 'manualKm'); bind('.slot-min', 'manualMin'); bind('.slot-parking', 'parking'); bind('.slot-parking-unit', 'parkingUnit');
    $('.slot-address', node).addEventListener('input', () => { slot.lat = null; slot.lng = null; });
    $('.slot-remove', node).addEventListener('click', () => { state.slots.splice(idx, 1); persist(); renderSlots(); });
    if (slot.manualKm !== '' && slot.manualKm != null) $('.manual', node).open = true;
    host.appendChild(node);

    if (!slot.favId) {
      mountAutocomplete($('.slot-auto', node), p => {
        Object.assign(slot, { name: slot.name || p.name, address: p.address, lat: p.lat, lng: p.lng });
        $('.slot-name', node).value = slot.name; $('.slot-address', node).value = slot.address;
        persist(); renderSlotSummary(node, slot);
      }, 'Search the charger location').then(ok => { if (!ok) $('.slot-auto', node).remove(); });
    }
  });
  $('#btnAddSlot').disabled = state.slots.length >= 4;
}
function renderSlotSummary(node, slot) {
  const s = $('.slot-summary', node);
  const parts = [];
  if (slot.favId) {
    parts.push(esc(slot.address || ''));
    parts.push(`<b>RM ${num(slot.rate, 2)}/kWh</b> · ${esc(slot.type)} ${esc(slot.kw)} kW${Number(slot.parking) ? ` · parking RM ${num(slot.parking, 2)}${slot.parkingUnit === 'hour' ? '/h' : ''}` : ''}${slot.gentari ? ' · <span class="tag">Gentari deal</span>' : ''}`);
  }
  if (slot.lat != null) parts.push(`<span>Location pinned</span>`); else if (slot.address && !slot.favId) parts.push(`<span class="hint">No coordinates. Pick from search or enter manual km.</span>`);
  s.innerHTML = parts.filter(Boolean).join('<br>');
}

// ---------- UI: favourites ----------
function renderFavs() {
  $('#favCount').textContent = favs.length || '';
  const list = $('#favList');
  list.innerHTML = favs.length ? '' : '<div class="hint">No saved chargers yet. Add your regulars below so you can pick them with one tap.</div>';
  for (const f of favs) {
    const d = document.createElement('div');
    d.className = 'fav-item';
    d.innerHTML = `<div class="meta"><div class="name"><span>${esc(f.name)}</span>${f.gentari ? '<span class="tag">Gentari</span>' : ''}<span class="tag type">${esc(f.type)} ${esc(f.kw)} kW</span></div>
      <div class="detail">RM ${num(f.rate, 2)}/kWh${Number(f.parking) ? ` · parking RM ${num(f.parking, 2)}${f.parkingUnit === 'hour' ? '/h' : ''}` : ''} · ${esc(f.address || (f.lat != null ? `${num(f.lat, 4)}, ${num(f.lng, 4)}` : 'no location'))}</div></div>
      <button class="icon-btn" data-act="edit" aria-label="Edit">${ICON('edit')}</button><button class="icon-btn" data-act="del" aria-label="Delete">${ICON('trash')}</button>`;
    $('[data-act=edit]', d).addEventListener('click', () => editFav(f));
    $('[data-act=del]', d).addEventListener('click', () => { if (confirm(`Delete "${f.name}"?`)) { favs = favs.filter(x => x.id !== f.id); save(LS.favs, favs); renderFavs(); renderSlots(); } });
    list.appendChild(d);
  }
}
function editFav(f) {
  $('#favDetails').open = true;
  $('#favFormTitle').textContent = 'Edit charger';
  $('#favId').value = f.id; $('#favName').value = f.name; $('#favAddress').value = f.address || '';
  $('#favLat').value = f.lat ?? ''; $('#favLng').value = f.lng ?? '';
  $('#favRate').value = f.rate; $('#favType').value = f.type; $('#favKw').value = f.kw; $('#favGentari').checked = !!f.gentari;
  $('#favParking').value = f.parking ?? ''; $('#favParkingUnit').value = f.parkingUnit || 'flat';
  $('#favCancel').classList.remove('hidden');
  $('#favForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function resetFavForm() {
  $('#favForm').reset(); $('#favId').value = ''; $('#favFormTitle').textContent = 'Add a charger'; $('#favCancel').classList.add('hidden');
}
function bindFavs() {
  $('#favForm').addEventListener('submit', e => {
    e.preventDefault();
    const id = $('#favId').value || uid();
    const lat = $('#favLat').value === '' ? null : Number($('#favLat').value);
    const lng = $('#favLng').value === '' ? null : Number($('#favLng').value);
    const f = { id, name: $('#favName').value.trim(), address: $('#favAddress').value.trim(), lat, lng,
      rate: Number($('#favRate').value), type: $('#favType').value, kw: Number($('#favKw').value), gentari: $('#favGentari').checked,
      parking: $('#favParking').value === '' ? '' : Number($('#favParking').value), parkingUnit: $('#favParkingUnit').value };
    const i = favs.findIndex(x => x.id === id);
    if (i >= 0) favs[i] = f; else favs.push(f);
    save(LS.favs, favs);
    // refresh any slot using this favourite
    for (const s of state.slots) if (s.favId === id) Object.assign(s, { name: f.name, address: f.address, lat: f.lat, lng: f.lng, rate: f.rate, type: f.type, kw: f.kw, gentari: f.gentari, parking: f.parking, parkingUnit: f.parkingUnit });
    persist(); resetFavForm(); renderFavs(); renderSlots();
    showToast('Saved ' + f.name);
  });
  $('#favCancel').addEventListener('click', resetFavForm);
  renderFavs();
  mountAutocomplete($('#favAuto'), p => {
    if (!$('#favName').value) $('#favName').value = p.name;
    $('#favAddress').value = p.address; $('#favLat').value = p.lat; $('#favLng').value = p.lng;
  }, 'Search for the charger').then(ok => { if (!ok) $('#favAuto').remove(); });
}

// ---------- UI: settings ----------
const SETTING_FIELDS = { apiKey: 'setApiKey', usableKwh: 'setUsableKwh', whPerKm: 'setWhPerKm', acLoss: 'setAcLoss', dcLoss: 'setDcLoss', onboardAc: 'setOnboardAc',
  wearPerKm: 'setWearPerKm', gentariPay: 'setGentariPay', gentariCredit: 'setGentariCredit' };
function fillSettings() { for (const [k, id] of Object.entries(SETTING_FIELDS)) $('#' + id).value = settings[k]; }
function bindSettings() {
  const dlg = $('#settingsDlg');
  const open = () => { fillSettings(); dlg.showModal(); };
  $('#btnSettings').addEventListener('click', open);
  $('#bannerSettings').addEventListener('click', open);
  $('#settingsClose').addEventListener('click', () => dlg.close());
  $('#btnDiag').addEventListener('click', runDiagnostics);
  $('#btnPasteKey').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      const k = cleanKey(t);
      if (!k) return showToast('Clipboard has no key in it. Copy the key first.');
      $('#setApiKey').value = k;
      showToast(k.length === 39 && k.startsWith('AIza') ? 'Key pasted. Tap Test, then Save.' : `Pasted ${k.length} characters. Check it and tap Test.`);
    } catch (e) { showToast('Could not read clipboard. Long-press the field and paste instead.'); }
  });
  $('#settingsReset').addEventListener('click', () => { const key = settings.apiKey; settings = { ...DEFAULTS, apiKey: key }; fillSettings(); });
  $('#settingsForm').addEventListener('submit', () => {
    const oldKey = settings.apiKey;
    for (const [k, id] of Object.entries(SETTING_FIELDS)) {
      const v = $('#' + id).value;
      settings[k] = k === 'apiKey' ? cleanKey(v) : (v === '' ? DEFAULTS[k] : Number(v));
    }
    if (settings.gentariCredit <= 0) settings.gentariCredit = DEFAULTS.gentariCredit;
    save(LS.settings, settings);
    renderBatteryHint(); renderKeyBanner();
    if (settings.apiKey !== oldKey) { routeCache.clear(); if (settings.apiKey && !mapsReady) location.reload(); }
  });
  renderKeyBanner();
}
function cleanKey(v) { return String(v || '').replace(/[^A-Za-z0-9_-]/g, ''); }
function oddChars(v) { return [...String(v || '')].filter(c => !/[A-Za-z0-9_-]/.test(c)).map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')); }

async function runDiagnostics() {
  const out = $('#diagOut');
  const raw = $('#setApiKey').value;
  const key = cleanKey(raw);
  const odd = oddChars(raw);
  const line = (label, ok, msg) => `<div class="diag ${ok ? 'ok' : 'bad'}"><b>${ok ? '✓' : '✕'} ${esc(label)}</b><span>${esc(msg)}</span></div>`;
  if (!key) { out.innerHTML = line('API key', false, 'No key entered.'); return; }
  out.innerHTML = '<div class="hint">Testing…</div>';
  const rows = [];
  rows.push(line('Key format', /^AIza[0-9A-Za-z_-]{35}$/.test(key) && !odd.length, odd.length ? `${raw.length} characters, ${odd.length} stray (${odd.join(' ')}). Removed for this test. Save to store the cleaned key.` : `${key.length} characters, starts ${key.slice(0, 4)}`));
  rows.push(line('This page', true, location.origin + location.pathname));
  // Places API (New) autocomplete via REST
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key }, body: JSON.stringify({ input: 'Gentari', includedRegionCodes: ['my'] }) });
    const j = await r.json().catch(() => ({}));
    rows.push(line('Places API (New)', r.ok, r.ok ? `${(j.suggestions || []).length} suggestions for “Gentari”` : `HTTP ${r.status}: ${j.error?.message || 'unknown error'}`));
  } catch (e) { rows.push(line('Places API (New)', false, 'Request could not be sent: ' + e.message)); }
  // Routes API
  try {
    const wp = (lat, lng) => ({ waypoint: { location: { latLng: { latitude: lat, longitude: lng } } } });
    const r = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition' }, body: JSON.stringify({ origins: [wp(3.1390, 101.6869)], destinations: [wp(3.0738, 101.6079)], travelMode: 'DRIVE' }) });
    const j = await r.json().catch(() => ({}));
    const first = Array.isArray(j) ? j[0] : null;
    rows.push(line('Routes API', r.ok && first, r.ok && first ? `KLCC → Sunway: ${((first.distanceMeters || 0) / 1000).toFixed(1)} km` : `HTTP ${r.status}: ${(Array.isArray(j) ? j[0]?.error?.message : j.error?.message) || 'unknown error'}`));
  } catch (e) { rows.push(line('Routes API', false, 'Request could not be sent: ' + e.message)); }
  rows.push(line('Maps JavaScript API', mapsReady, mapsReady ? 'loaded' : (lastError || 'not loaded yet (save the key, then reopen Settings)')));
  if (lastError && mapsReady) rows.push(line('Last widget error', false, lastError));
  out.innerHTML = rows.join('');
}

function renderKeyBanner() { $('#keyBanner').classList.toggle('hidden', !!settings.apiKey); }

// ---------- compare ----------
async function compare() {
  const btn = $('#btnCompare');
  const out = $('#results');
  const problems = [];
  if (state.socTarget <= state.socNow) problems.push('Target charge must be above current charge.');
  state.slots.forEach((s, i) => {
    const label = s.name || `Charger ${i + 1}`;
    if (!(Number(s.rate) >= 0) || s.rate === '') problems.push(`${label}: enter RM/kWh.`);
    if (!(Number(s.kw) > 0)) problems.push(`${label}: enter charger kW.`);
    const hasManual = s.manualKm !== '' && s.manualKm != null && Number(s.manualKm) >= 0;
    const hasPin = s.lat != null && s.lng != null;
    if (!hasManual && !hasPin) problems.push(`${label}: pick its location from search or enter manual km.`);
    if (!hasManual && hasPin && !state.origin) problems.push(`Set a starting point (or enter manual km for ${label}).`);
  });
  if (problems.length) { out.classList.remove('hidden'); out.innerHTML = `<div class="verdict warn"><div class="eyebrow">Before comparing</div><div class="headline">A few things missing</div><ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`; scrollToResults(); return; }

  btn.disabled = true; btn.textContent = 'Working…';
  try {
    const needRoute = state.slots.map(s => !(s.manualKm !== '' && s.manualKm != null) && s.lat != null);
    let routed = state.slots.map(() => null);
    if (needRoute.some(Boolean)) {
      if (!settings.apiKey) throw new Error('No Google API key. Add one in Settings or use manual km.');
      const idx = needRoute.map((v, i) => v ? i : -1).filter(i => i >= 0);
      const res = await routeMatrix(state.origin, idx.map(i => state.slots[i]));
      idx.forEach((i, j) => routed[i] = res[j]);
    }
    const rows = state.slots.map((s, i) => {
      let km, min, src;
      if (!needRoute[i]) {
        km = Number(s.manualKm) || 0;
        min = s.manualMin !== '' && s.manualMin != null ? Number(s.manualMin) : km / MANUAL_AVG_KMH * 60;
        src = 'manual distance';
      } else if (routed[i]) { km = routed[i].km; min = routed[i].min; src = 'Google routing, live traffic'; }
      else { return { slot: s, error: 'No driving route found.' }; }
      return { slot: s, src, ev: evaluate(s, km, min) };
    });
    renderResults(rows);
  } catch (e) {
    out.classList.remove('hidden');
    out.innerHTML = `<div class="verdict bad"><div class="eyebrow">Error</div><div class="headline">Could not compare</div><div class="sub">${esc(e.message)}</div></div>`;
  } finally { btn.disabled = false; btn.textContent = 'Compare'; }
  scrollToResults();
}

function renderResults(rows) {
  const out = $('#results');
  const nameOf = (r) => r.slot.name || 'Charger ' + (state.slots.indexOf(r.slot) + 1);
  const ok = rows.filter(r => r.ev && r.ev.socArrive >= 0);
  const best = ok.length ? ok.reduce((a, b) => a.ev.total <= b.ev.total ? a : b) : null;
  const sorted = [...rows].sort((a, b) => (a.ev?.total ?? Infinity) - (b.ev?.total ?? Infinity));
  let html = '';

  // ---- verdict ----
  const fmtMin = (m) => Math.round(Math.abs(m)) + ' min';
  if (best) {
    const others = ok.filter(r => r !== best);
    const runner = others.length ? others.reduce((a, b) => a.ev.total <= b.ev.total ? a : b) : null;
    const diff = runner ? runner.ev.total - best.ev.total : 0;
    const dt = runner ? best.ev.totalMin - runner.ev.totalMin : 0; // + means best takes longer
    const fastest = ok.reduce((a, b) => a.ev.totalMin <= b.ev.totalMin ? a : b);
    let timeLine = '';
    if (runner) {
      if (Math.abs(dt) < 2) timeLine = `About the same time as ${esc(nameOf(runner))}.`;
      else if (dt > 0) timeLine = `But it takes <b>${fmtMin(dt)} longer</b> than ${esc(nameOf(runner))} (${Math.round(best.ev.totalMin)} vs ${Math.round(runner.ev.totalMin)} min driving + charging). That is about RM ${(diff / (dt / 60)).toFixed(0)} saved per extra hour.`;
      else timeLine = `And it is <b>${fmtMin(dt)} quicker</b> too (${Math.round(best.ev.totalMin)} vs ${Math.round(runner.ev.totalMin)} min driving + charging).`;
    }
    html += `<div class="verdict">
      <div class="eyebrow">Cheapest</div>
      <div class="headline">${esc(nameOf(best))}</div>
      ${runner ? `<div class="saving"><span class="amt">${rm(diff)}</span><span class="vs">cheaper than ${esc(nameOf(runner))}, charging + parking + wear</span></div>` : ''}
      <div class="sub">${timeLine} Arrive at about ${Math.round(best.ev.socArrive)}%, charge about ${Math.round(best.ev.chargeMin)} min to ${state.socTarget}%.${fastest !== best && runner ? ` Quickest option: ${esc(nameOf(fastest))}.` : ''}</div>
    </div>`;
  } else {
    html += `<div class="verdict bad"><div class="eyebrow">Cheapest</div><div class="headline">None reachable</div><div class="sub">You would not make it to any of these on the current charge.</div></div>`;
  }

  // ---- side-by-side table ----
  const fastestOk = ok.length ? ok.reduce((a, b) => a.ev.totalMin <= b.ev.totalMin ? a : b) : null;
  const cell = (r, fn, cls = '') => {
    if (!r.ev) return `<td class="dead">—</td>`;
    const dead = r.ev.socArrive < 0;
    return `<td class="${cls}${dead ? ' dead' : ''}${r === best ? ' best' : ''}">${fn(r.ev, r)}</td>`;
  };
  const rowsHtml = [
    ['Drive', (e) => `${num(e.km, 1)} km<span class="sub">${Math.round(e.driveMin)} min · ${num(e.driveKwh, 1)} kWh</span>`],
    ['Arrive at', (e) => e.socArrive < 0 ? `Out of charge<span class="sub">short by ${Math.round(-e.socArrive)}%</span>` : `${Math.round(e.socArrive)}%${e.socArrive < 8 ? '<span class="sub">tight</span>' : ''}`],
    ['Charge', (e, r) => `${num(e.billedKwh, 1)} kWh<span class="sub">${Math.round(e.chargeMin)} min · ${esc(r.slot.type)} ${esc(r.slot.kw)} kW</span>`],
    ['Charging cost', (e, r) => `${rm(e.chargeCost)}<span class="sub">${r.slot.gentari ? `RM ${num(e.effRate, 3)}/kWh after credit` : `RM ${num(e.rate, 2)}/kWh`}</span>`],
    ['Parking', (e, r) => `${rm(e.parkingCost)}<span class="sub">${e.parkingRate ? (r.slot.parkingUnit === 'hour' ? `RM ${num(e.parkingRate, 2)}/h × ${Math.ceil(e.chargeMin / 60)} h` : 'flat') : 'none'}</span>`],
    ['Wear', (e) => `${rm(e.wearCost)}<span class="sub">RM ${settings.wearPerKm}/km</span>`],
  ];
  html += `<div class="compare"><h2>Side by side</h2><div class="cmp-scroll"><table class="cmp ${sorted.length <= 2 ? 'fit' : 'wide'}">
    <thead><tr><th></th>${sorted.map(r => `<th class="${r === best ? 'best' : ''}"><span class="name">${esc(nameOf(r))}</span><span class="tags">${r.slot.gentari ? '<span class="tag">Gentari</span>' : ''}<span class="tag type">${esc(r.slot.type)}</span></span></th>`).join('')}</tr></thead>
    <tbody>
      ${rowsHtml.map(([label, fn]) => `<tr><td>${label}</td>${sorted.map(r => cell(r, fn)).join('')}</tr>`).join('')}
      <tr class="total"><td>All-in</td>${sorted.map(r => cell(r, (e) => e.socArrive < 0 ? '—' : rm(e.total))).join('')}</tr>
      <tr class="time"><td>Your time</td>${sorted.map(r => r.ev && r.ev.socArrive >= 0 ? `<td class="${r === fastestOk ? 'fast' : ''}">${Math.round(r.ev.totalMin)} min<span class="sub">${Math.round(r.ev.driveMin)} + ${Math.round(r.ev.chargeMin)} min</span></td>` : '<td class="dead">—</td>').join('')}</tr>
    </tbody></table></div>
    ${sorted.some(r => r.error) ? `<div class="hint" style="padding:0 18px 10px">${sorted.filter(r => r.error).map(r => esc(nameOf(r)) + ': ' + esc(r.error)).join(' ')}</div>` : ''}
    <div class="hint" style="padding:0 18px 10px">Distance: ${esc([...new Set(rows.filter(r => r.src).map(r => r.src))].join(' / ') || 'n/a')}.</div>
  </div>`;

  // ---- stacked bars ----
  const maxTotal = Math.max(...ok.map(r => r.ev.total), 0.01);
  html += `<div class="bars"><h2>Where the money goes</h2>
    ${sorted.filter(r => r.ev && r.ev.socArrive >= 0).map(r => {
      const e = r.ev; const pct = (v) => (v / maxTotal * 100).toFixed(1) + '%';
      return `<div class="bar-row ${r === best ? 'best' : ''}">
        <div class="bar-head"><span class="n ${r === best ? 'best' : ''}">${esc(nameOf(r))}</span><span class="t">${rm(e.total)}</span></div>
        <div class="bar"><div class="bar-seg c" data-w="${pct(e.chargeCost)}" title="Charging ${rm(e.chargeCost)}"></div><div class="bar-seg t" data-w="${pct(e.parkingCost)}" title="Parking ${rm(e.parkingCost)}"></div><div class="bar-seg w" data-w="${pct(e.wearCost)}" title="Wear ${rm(e.wearCost)}"></div></div>
      </div>`;
    }).join('')}
    <div class="legend"><span><i style="background:#f5f5f7"></i>Charging</span><span><i style="background:#7d7d85"></i>Parking</span><span><i style="background:#3c3c42"></i>Wear</span></div>
  </div>`;

  out.innerHTML = html;
  out.classList.remove('hidden');
  // grow bars after paint
  $$('.bar-seg', out).forEach(el => el.style.width = '0%');
  requestAnimationFrame(() => requestAnimationFrame(() => $$('.bar-seg', out).forEach(el => el.style.width = el.dataset.w)));
}

function scrollToResults() {
  const out = $('#results');
  const top = out.getBoundingClientRect().top + window.scrollY - ($('.topbar').offsetHeight + 12);
  window.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

// ---------- misc ----------
let toastTimer;
function showToast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.display = 'none', 5000);
}

// ---------- boot ----------
function init() {
  bindSoc();
  bindSettings();
  bindOrigin();
  bindFavs();
  renderSlots();
  $('#btnAddSlot').addEventListener('click', () => { if (state.slots.length < 4) { state.slots.push(emptySlot()); persist(); renderSlots(); } });
  $('#btnCompare').addEventListener('click', compare);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);

// expose for debugging in console
window.tcc = { evaluate: (st, km, min) => evaluate(st, km, min), chargeMinutes, dcMaxKw, get settings() { return settings; }, get state() { return state; } };
})();
