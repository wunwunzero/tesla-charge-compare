/* Charge Compare — Tesla Model 3 LR AWD 2024
 * Vanilla JS, no build step. State lives in localStorage on the device.
 */
(() => {
'use strict';

// ---------- constants ----------
const LS = { settings: 'tcc.settings.v1', favs: 'tcc.favs.v1', state: 'tcc.state.v1', routes: 'tcc.routes.v1', history: 'tcc.history.v1' };
const ROUTE_TTL_MS = 10 * 60 * 1000;

const DEFAULTS = {
  apiKey: '',
  usableKwh: 75,      // 2024 M3 LR AWD: ~78 kWh gross, ~75 usable
  whPerKm: 140,       // city driving, ~40 km/h average
  whHighway: 170,     // highway, ~90 km/h+ average
  minArrive: 10,      // never recommend arriving below this %
  navApp: 'google',   // google | waze | apple
  acLoss: 10,         // % of billed kWh lost on AC
  dcLoss: 5,          // % of billed kWh lost on DC
  onboardAc: 11,      // kW, Tesla onboard charger limit
  wearPerKm: 0.08,    // RM per km (tyres, brakes, depreciation share)
  gentariPay: 5,
  gentariCredit: 30,
  nearbyRadiusKm: 5,
  operatorPrices: null, // filled from OPERATORS below
};

// Operators found by Google nearby search: [name, name matcher, default RM/kWh, Gentari credit applies]
const OPERATORS = [
  ['Gentari', /gentari/i, { DC: 1.60, AC: 0.90 }, true],
  ['Tesla Supercharger', /tesla|supercharger/i, { DC: 1.02, AC: 0.88 }, false],
  ['chargEV', /chargev|charge ev|yinson/i, { DC: 1.60, AC: 0.90 }, false],
  ['JomCharge', /jomcharge|jom charge/i, { DC: 1.60, AC: 0.90 }, false],
  ['ChargeSini', /chargesini|charge sini/i, { DC: 1.60, AC: 0.90 }, false],
  ['DC Handal', /handal/i, { DC: 1.60, AC: 0.90 }, false],
  ['TNB Electron', /tnb|electron/i, { DC: 1.60, AC: 0.90 }, false],
  ['Shell Recharge', /shell/i, { DC: 1.60, AC: 0.90 }, false],
  ['Charge N Go', /charge ?n ?go/i, { DC: 1.60, AC: 0.90 }, false],
  ['Other', /.*/, { DC: 1.60, AC: 0.90 }, false],
];
const OP_PRICES_VERSION = 2; // bump when defaults change so stored copies are refreshed
DEFAULTS.operatorPrices = Object.fromEntries(OPERATORS.map(o => [o[0], { ...o[2] }]));

// Approximate DC charging curve for 2024 Model 3 LR AWD: [SoC %, max kW]
const DC_CURVE = [
  [0, 250], [10, 250], [20, 200], [30, 165], [40, 135], [50, 110],
  [60, 85], [70, 65], [80, 45], [90, 30], [100, 15],
];

const MANUAL_AVG_KMH = 45; // used when km given but minutes blank

// ---------- state ----------
let settings = load(LS.settings, {});
settings = { ...DEFAULTS, ...settings, operatorPrices: { ...DEFAULTS.operatorPrices, ...(settings.operatorPrices || {}) } };
if (settings.opVersion !== OP_PRICES_VERSION) { settings.operatorPrices = { ...DEFAULTS.operatorPrices }; settings.opVersion = OP_PRICES_VERSION; save(LS.settings, settings); }
if (settings.whHighway == null || settings.whHighway === DEFAULTS.whHighway && settings.whPerKm === 155) { if (settings.whPerKm === 155) settings.whPerKm = DEFAULTS.whPerKm; settings.whHighway = settings.whHighway ?? DEFAULTS.whHighway; save(LS.settings, settings); }
let favs = load(LS.favs, []);
let state = load(LS.state, {
  socNow: 30, socTarget: 80,
  origin: null,                     // {lat,lng,label}
  destination: null,                // {lat,lng,label} for detour mode
  tripMode: 'oneway',               // oneway | round | detour
  lateMin: 0,                       // minutes you stay plugged in after charging stops
  dayType: 'auto',                  // auto | weekday | weekend (parking rates)
  slots: [ emptySlot(), emptySlot() ],
});
if (!['oneway', 'round', 'detour'].includes(state.tripMode)) state.tripMode = 'oneway';
let history = load(LS.history, []);
if (!Array.isArray(state.slots) || state.slots.length < 2) state.slots = [emptySlot(), emptySlot()];

let mapsReady = false;
let mapsLoading = null;
let lastError = '';

// Optional per-charger fields beyond the basics (parking tiers, weekend rates, idle fee)
const EXTRA_KEYS = ['parkingNext', 'parkingGrace', 'parkingCap', 'wkDiff', 'wkParking', 'wkUnit', 'wkNext', 'idleFee', 'idleGrace'];
const pickExtras = (f) => Object.fromEntries(EXTRA_KEYS.map(k => [k, f[k] ?? (k === 'wkDiff' ? false : k === 'wkUnit' ? 'flat' : '')]));
function emptySlot() {
  return { favId: '', name: '', address: '', lat: null, lng: null, rate: '', type: 'DC', kw: '', gentari: false, parking: '', parkingUnit: 'flat', manualKm: '', manualMin: '', manualToKm: '' };
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

/** Wh/km for a leg, blended between city and highway by average speed. */
function whFor(km, min) {
  const city = Number(settings.whPerKm) || DEFAULTS.whPerKm, hwy = Number(settings.whHighway) || DEFAULTS.whHighway;
  if (!(km > 0) || !(min > 0)) return city;
  const t = Math.min(1, Math.max(0, (km / (min / 60) - 40) / 50));
  return city + t * (hwy - city);
}
function isWeekendNow() {
  if (state.dayType === 'weekday') return false;
  if (state.dayType === 'weekend') return true;
  const d = new Date().getDay(); return d === 0 || d === 6;
}
/** Parking for `minutes` parked: grace, first hour, later hours, daily cap, optional weekend rates. */
function parkingFor(st, minutes) {
  const wk = !!st.wkDiff && isWeekendNow();
  const first = Number(wk ? st.wkParking : st.parking) || 0;
  const unit = (wk ? st.wkUnit : st.parkingUnit) || 'flat';
  const nextRaw = wk ? st.wkNext : st.parkingNext;
  const next = nextRaw === '' || nextRaw == null ? first : Number(nextRaw) || 0;
  const grace = Number(st.parkingGrace) || 0, cap = Number(st.parkingCap) || 0;
  let cost = 0, hours = 0;
  if ((first > 0 || next > 0) && minutes > grace) {
    if (unit === 'flat') cost = first;
    else { hours = Math.max(1, Math.ceil(minutes / 60)); cost = first + (hours - 1) * next; }
  }
  const capped = cap > 0 && cost > cap;
  if (capped) cost = cap;
  return { cost, hours, weekend: wk, first, next, unit, grace, capped, free: first === 0 && next === 0 };
}
/** Idle fee for staying plugged in after charging stops. Blank fields fall back to Gentari's RM0.40/min after 15 min. */
function idleFor(st) {
  const blank = (v) => v === '' || v == null;
  const rate = blank(st.idleFee) ? (st.gentari ? 0.40 : 0) : Number(st.idleFee) || 0;
  const grace = blank(st.idleGrace) ? (st.gentari ? 15 : 0) : Number(st.idleGrace) || 0;
  const late = Number(state.lateMin) || 0;
  return { rate, grace, late, cost: Math.max(0, late - grace) * rate };
}

/** Full cost model for one station. */
/** If any charger in the comparison is Gentari, the session is one RM30 credit: RM30 worth of kWh at the first Gentari's rate.
 *  Every charger is then compared on putting that same energy into the pack. Otherwise charge to the target %. */
function sessionPlan(slots) {
  // Reference energy = what one credit buys at the cheapest Gentari in the comparison.
  // Every charger, including pricier Gentari sites, is compared on putting that same energy into the pack.
  const gs = slots.filter(s => s.gentari && Number(s.rate) > 0);
  if (!gs.length) return { mode: 'target' };
  const g = gs.reduce((a, b) => Number(a.rate) <= Number(b.rate) ? a : b);
  const loss = (g.type === 'AC' ? settings.acLoss : settings.dcLoss) / 100;
  const billedKwh = settings.gentariCredit / Number(g.rate);
  return { mode: 'credit', gentari: g, billedKwh, packKwh: billedKwh * (1 - loss), mixed: new Set(gs.map(x => Number(x.rate))).size > 1 };
}

function evaluate(st, legs, plan = { mode: 'target' }) {
  const km = legs.extraKm, driveMin = legs.extraMin;
  const whTo = whFor(legs.toKm, legs.toMin);
  const driveKwh = legs.toKm * whTo / 1000;
  const socArrive = state.socNow - driveKwh / settings.usableKwh * 100;
  const loss = (st.type === 'AC' ? settings.acLoss : settings.dcLoss) / 100;
  const roomKwh = Math.max(0, (100 - socArrive) / 100 * settings.usableKwh);
  const packKwh = plan.mode === 'credit'
    ? Math.min(plan.packKwh, roomKwh)
    : Math.max(0, (state.socTarget - socArrive) / 100 * settings.usableKwh);
  const socEnd = socArrive + packKwh / settings.usableKwh * 100;
  const billedKwh = packKwh / (1 - loss);
  const rate = Number(st.rate) || 0;
  const creditSession = plan.mode === 'credit' && st.gentari;
  const listedCost = billedKwh * rate;
  // Gentari in a credit session: one top-up buys credit / rate kWh at THIS site. If that falls short of the
  // reference energy (a pricier Gentari), the shortfall is priced at this site's normal rate so energy stays equal.
  const creditKwh = creditSession && rate > 0 ? settings.gentariCredit / rate : 0;
  const topUpKwh = creditSession ? Math.max(0, billedKwh - creditKwh) : 0;
  const chargeCost = creditSession ? settings.gentariPay + topUpKwh * rate : billedKwh * rate;
  const effRate = billedKwh > 0 ? chargeCost / billedKwh : 0;
  const gFactor = creditSession ? settings.gentariPay / settings.gentariCredit : 1;
  const detourKwhBilled = driveKwh / (1 - loss);
  const detourEnergyCost = detourKwhBilled * effRate;
  const chargeMin = chargeMinutes(Math.max(socArrive, 0), socEnd, st.type, Number(st.kw) || 1);
  const idle = idleFor(st);
  const park = parkingFor(st, chargeMin + idle.late);
  const parkingCost = park.cost, parkingRate = park.first, idleCost = idle.cost;
  const wearCost = km * settings.wearPerKm;
  const totalMin = driveMin + chargeMin;
  const total = chargeCost + parkingCost + idleCost + wearCost;
  const socAfter = socEnd - legs.afterKm * whFor(legs.afterKm, legs.afterMin) / 1000 / settings.usableKwh * 100; // at destination / back home
  return { km, driveMin, driveKwh, socArrive, socEnd, socAfter, packKwh, billedKwh, rate, effRate, gFactor, listedCost, chargeCost, creditSession, creditKwh, topUpKwh,
           detourEnergyCost, chargeMin, parkingCost, parkingRate, park, idle, idleCost, wearCost, totalMin, total, legs, whTo, loss };
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

/** Generic route matrix with a 10-minute cache persisted in localStorage.
 *  origins/destinations: [{lat,lng}]. Returns rows[o][d] = {km,min} | null. */
const routeCache = new Map(Object.entries(load(LS.routes, {})).filter(([, v]) => Date.now() - v.t < ROUTE_TTL_MS));
function saveRouteCache() { try { const o = {}; for (const [k, v] of routeCache) if (Date.now() - v.t < ROUTE_TTL_MS) o[k] = v; save(LS.routes, o); } catch {} }
const rkey = (a, b) => [a.lat.toFixed(4), a.lng.toFixed(4), b.lat.toFixed(4), b.lng.toFixed(4)].join('|');
async function matrix(origins, destinations) {
  const out = origins.map(() => destinations.map(() => undefined));
  const needO = new Set(), needD = new Set();
  origins.forEach((o, i) => destinations.forEach((d, j) => {
    if (o.lat == null || d.lat == null) { out[i][j] = null; return; }
    const hit = routeCache.get(rkey(o, d));
    if (hit && Date.now() - hit.t < ROUTE_TTL_MS) out[i][j] = hit.v; else { needO.add(i); needD.add(j); }
  }));
  if (needO.size && settings.apiKey) {
    const oi = [...needO], dj = [...needD];
    const wp = (p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
    const res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': settings.apiKey,
                 'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition' },
      body: JSON.stringify({ origins: oi.map(i => wp(origins[i])), destinations: dj.map(j => wp(destinations[j])), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE' }),
    });
    if (!res.ok) {
      let msg = 'Routes API error ' + res.status;
      try { const j = await res.json(); msg += ': ' + (j.error?.message || j[0]?.error?.message || ''); } catch {}
      throw new Error(msg);
    }
    for (const r of await res.json()) {
      const i = oi[r.originIndex], j = dj[r.destinationIndex];
      if (i == null || j == null) continue;
      const v = (r.condition && r.condition !== 'ROUTE_EXISTS') ? null : { km: (r.distanceMeters || 0) / 1000, min: parseFloat(r.duration || '0') / 60 };
      out[i][j] = v;
      if (v) routeCache.set(rkey(origins[i], destinations[j]), { v, t: Date.now() });
    }
    saveRouteCache();
  }
  return out.map(row => row.map(v => v === undefined ? null : v));
}

/** Driving legs for each station under the current trip mode.
 *  Returns per station: { toKm, toMin (origin -> charger), extraKm, extraMin (what the trip costs you), afterKm (charger -> destination), routed } */
async function legsFor(stations, opts = {}) {
  const mode = opts.mode || state.tripMode, origin = state.origin, dest = state.destination;
  const est = (a, b) => { const km = haversineKm(a, b) * 1.3; return { km, min: km / 40 * 60 }; };
  const pinned = stations.filter(st => st.lat != null);
  let oc = stations.map(() => null), co = stations.map(() => null), cd = stations.map(() => null), od = null;
  const live = opts.live !== false && !!settings.apiKey && !!origin;
  if (live && pinned.length) {
    const rows = await matrix([origin], pinned);
    pinned.forEach((st, k) => { oc[stations.indexOf(st)] = rows[0][k]; });
    if (mode === 'round') { const back = await matrix(pinned, [origin]); pinned.forEach((st, k) => { co[stations.indexOf(st)] = back[k][0]; }); }
    if (mode === 'detour' && dest) {
      const [toDest, direct] = await Promise.all([matrix(pinned, [dest]), matrix([origin], [dest])]);
      pinned.forEach((st, k) => { cd[stations.indexOf(st)] = toDest[k][0]; }); od = direct[0][0];
    }
  }
  return stations.map((st, i) => {
    const manual = st.manualKm !== '' && st.manualKm != null;
    let routed = !!oc[i];
    let to = oc[i] || (manual ? { km: Number(st.manualKm) || 0, min: st.manualMin !== '' && st.manualMin != null ? Number(st.manualMin) : (Number(st.manualKm) || 0) / MANUAL_AVG_KMH * 60 }
                               : (origin && st.lat != null ? est(origin, st) : null));
    if (!to) return null;
    if (mode === 'oneway') return { toKm: to.km, toMin: to.min, extraKm: to.km, extraMin: to.min, afterKm: 0, afterMin: 0, routed, src: routed ? 'Google routing' : manual ? 'manual' : 'estimated' };
    if (mode === 'round') {
      const back = co[i] || to;
      return { toKm: to.km, toMin: to.min, extraKm: to.km + back.km, extraMin: to.min + back.min, afterKm: back.km, afterMin: back.min, routed: routed && !!co[i], src: routed ? 'Google routing' : manual ? 'manual (doubled)' : 'estimated' };
    }
    // detour: origin -> charger -> destination, minus going direct
    if (manual && !oc[i]) {
      // Manual value is the EXTRA distance. Arrival battery needs the distance TO the charger:
      // use the typed value, else a straight-line estimate, else fall back to the extra km and say so.
      const typedTo = st.manualToKm !== '' && st.manualToKm != null ? Number(st.manualToKm) : null;
      const estTo = origin && st.lat != null ? est(origin, st).km : null;
      const toKm = typedTo ?? estTo ?? to.km;
      const toSrc = typedTo != null ? '' : estTo != null ? ', km to charger estimated' : ', km to charger unknown (using extra km)';
      return { toKm, toMin: to.min, extraKm: to.km, extraMin: to.min, afterKm: 0, afterMin: 0, routed: false, src: 'manual extra km' + toSrc };
    }
    if (!dest) return null;
    const toDest = cd[i] || (st.lat != null ? est(st, dest) : null);
    const direct = od || (origin ? est(origin, dest) : null);
    if (!toDest || !direct) return null;
    return { toKm: to.km, toMin: to.min, extraKm: Math.max(0, to.km + toDest.km - direct.km), extraMin: Math.max(0, to.min + toDest.min - direct.min), afterKm: toDest.km, afterMin: toDest.min,
             routed: routed && !!cd[i] && !!od, src: (routed && cd[i] && od) ? 'Google routing' : 'estimated', directKm: direct.km };
  });
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
  const rangeNow = state.socNow / 100 * settings.usableKwh / (whFor(60, 60) / 1000);
  const plan = sessionPlan(state.slots);
  if (plan.mode === 'credit') {
    const endSoc = Math.min(100, state.socNow + plan.packKwh / settings.usableKwh * 100);
    $('#batteryHint').textContent = `A Gentari charger is in the comparison, so the session is one RM ${num(settings.gentariCredit, 0)} credit: about ${num(plan.billedKwh, 1)} kWh, taking you to roughly ${Math.round(endSoc)}%. The target % is ignored. Roughly ${Math.round(rangeNow)} km of range right now.`;
    return;
  }
  const kwh = Math.max(0, (state.socTarget - state.socNow) / 100 * settings.usableKwh);
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
function renderDayHint() {
  const auto = new Date().getDay(); const wk = auto === 0 || auto === 6;
  const o = $('#dayType option[value=auto]'); if (o) o.textContent = `Today (${wk ? 'weekend' : 'weekday'})`;
}
const TRIP_HINTS = {
  oneway: 'Cost of driving from here to the charger. Use when charging is the errand.',
  round: 'Drive to the charger and back to where you are now. Both legs count.',
  detour: 'You are heading somewhere. Only the extra kilometres and minutes of going via the charger count, compared with driving straight there.',
};
function renderTrip() {
  $$('#tripMode button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.tripMode));
  $('#tripHint').textContent = TRIP_HINTS[state.tripMode];
  $('#destWrap').classList.toggle('hidden', state.tripMode !== 'detour');
  const d = $('#destHint');
  if (state.destination) d.innerHTML = `Going to <b>${esc(state.destination.label)}</b> <button class="link-btn" id="clearDest">clear</button>`; else d.textContent = 'No destination set.';
  $('#clearDest')?.addEventListener('click', () => { state.destination = null; persist(); renderTrip(); });
  const L = { oneway: ['Driving km', 'Driving min'], round: ['Km to charger (one way)', 'Min (one way)'], detour: ['Extra km via charger', 'Extra min'] }[state.tripMode];
  $$('.slot .slot-km').forEach(i => { i.closest('label').firstChild.textContent = L[0] + ' '; });
  $$('.slot .slot-min').forEach(i => { i.closest('label').firstChild.textContent = L[1] + ' '; });
  $$('.slot .tokm-row').forEach(r => r.classList.toggle('hidden', state.tripMode !== 'detour'));
}
function bindTrip() {
  $('#lateMin').value = String(state.lateMin || 0);
  $('#dayType').value = state.dayType || 'auto';
  $('#lateMin').addEventListener('change', e => { state.lateMin = Number(e.target.value); persist(); });
  $('#dayType').addEventListener('change', e => { state.dayType = e.target.value; persist(); renderDayHint(); });
  renderDayHint();
  $$('#tripMode button').forEach(b => b.addEventListener('click', () => { state.tripMode = b.dataset.mode; persist(); renderTrip(); renderBatteryHint(); }));
  renderTrip();
  mountAutocomplete($('#destAuto'), p => { state.destination = { lat: p.lat, lng: p.lng, label: p.name || p.address }; persist(); renderTrip(); }, 'Search your destination')
    .then(ok => { if (!ok) $('#destAuto').innerHTML = '<div class="hint">Add a Google API key in Settings to search places.</div>'; });
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
    $('.slot-tokm', node).value = slot.manualToKm ?? '';
    $$('[data-k]', node).forEach(i => {
      const k = i.dataset.k, v = slot[k];
      if (i.type === 'checkbox') i.checked = !!v; else i.value = v ?? (k === 'wkUnit' ? 'flat' : '');
      const onChange = () => { slot[k] = i.type === 'checkbox' ? i.checked : i.value; persist(); renderSlotSummary(node, slot); syncWk(node); };
      i.addEventListener('input', onChange); i.addEventListener('change', onChange);
    });
    syncWk(node);
    $('.slot-remove', node).classList.toggle('hidden', state.slots.length <= 2);
    renderSlotSummary(node, slot);

    pick.addEventListener('change', () => {
      slot.favId = pick.value;
      if (slot.favId) {
        const f = favs.find(x => x.id === slot.favId);
        Object.assign(slot, { name: f.name, address: f.address, lat: f.lat, lng: f.lng, rate: f.rate, type: f.type, kw: f.kw, gentari: !!f.gentari, parking: f.parking ?? '', parkingUnit: f.parkingUnit || 'flat', ...pickExtras(f) });
      }
      persist(); renderSlots();
    });
    const bind = (sel, key, transform = v => v) => $(sel, node).addEventListener('input', e => { slot[key] = transform(e.target.type === 'checkbox' ? e.target.checked : e.target.value); persist(); renderSlotSummary(node, slot); renderBatteryHint(); });
    bind('.slot-name', 'name'); bind('.slot-address', 'address'); bind('.slot-rate', 'rate'); bind('.slot-type', 'type'); bind('.slot-kw', 'kw'); bind('.slot-gentari', 'gentari');
    bind('.slot-km', 'manualKm'); bind('.slot-min', 'manualMin'); bind('.slot-tokm', 'manualToKm'); bind('.slot-parking', 'parking'); bind('.slot-parking-unit', 'parkingUnit');
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
  renderBatteryHint();
  if ($('#tripMode')) renderTrip();
}
function syncWk(root) { $$('.wk-fields', root).forEach(w => { const c = $('[data-k=wkDiff]', w.parentElement); w.classList.toggle('hidden', !(c && c.checked)); }); }
function parkingText(st) {
  const p = Number(st.parking) || 0, next = st.parkingNext === '' || st.parkingNext == null ? null : Number(st.parkingNext);
  if (!p && !next) return st.wkDiff && Number(st.wkParking) ? `free weekdays, RM ${num(st.wkParking, 2)}${st.wkUnit === 'hour' ? '/h' : ''} weekends` : '';
  let t = st.parkingUnit === 'hour' ? (next != null && next !== p ? `RM ${num(p, 2)} first hour, then RM ${num(next, 2)}/h` : `RM ${num(p, 2)}/h`) : `RM ${num(p, 2)} flat`;
  if (st.wkDiff) t += `; weekends RM ${num(st.wkParking || 0, 2)}${st.wkUnit === 'hour' ? '/h' : ' flat'}`;
  return 'parking ' + t;
}
function renderSlotSummary(node, slot) {
  const s = $('.slot-summary', node);
  const parts = [];
  if (slot.favId) {
    parts.push(esc(slot.address || ''));
    const pt = parkingText(slot);
    parts.push(`<b>RM ${num(slot.rate, 2)}/kWh</b> · ${esc(slot.type)} ${esc(slot.kw)} kW${pt ? ' · ' + esc(pt) : ''}${slot.gentari ? ' · <span class="tag">Gentari deal</span>' : ''}`);
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
      <div class="detail">RM ${num(f.rate, 2)}/kWh${parkingText(f) ? ' · ' + esc(parkingText(f)) : ''} · ${esc(f.address || (f.lat != null ? `${num(f.lat, 4)}, ${num(f.lng, 4)}` : 'no location'))}</div></div>
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
  $$('#favForm [data-k]').forEach(i => { const v = f[i.dataset.k]; if (i.type === 'checkbox') i.checked = !!v; else i.value = v ?? (i.dataset.k === 'wkUnit' ? 'flat' : ''); });
  syncWk($('#favForm'));
  $('#favCancel').classList.remove('hidden');
  $('#favForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function resetFavForm() {
  $('#favForm').reset(); setTimeout(() => syncWk($('#favForm')), 0); $('#favId').value = ''; $('#favFormTitle').textContent = 'Add a charger'; $('#favCancel').classList.add('hidden');
}
function bindFavs() {
  $('#favForm').addEventListener('submit', e => {
    e.preventDefault();
    const id = $('#favId').value || uid();
    const lat = $('#favLat').value === '' ? null : Number($('#favLat').value);
    const lng = $('#favLng').value === '' ? null : Number($('#favLng').value);
    const f = { id, name: $('#favName').value.trim(), address: $('#favAddress').value.trim(), lat, lng,
      rate: Number($('#favRate').value), type: $('#favType').value, kw: Number($('#favKw').value), gentari: $('#favGentari').checked,
      parking: $('#favParking').value === '' ? '' : Number($('#favParking').value), parkingUnit: $('#favParkingUnit').value,
      ...Object.fromEntries($$('#favForm [data-k]').map(i => [i.dataset.k, i.type === 'checkbox' ? i.checked : i.value])) };
    const i = favs.findIndex(x => x.id === id);
    if (i >= 0) favs[i] = f; else favs.push(f);
    save(LS.favs, favs);
    // refresh any slot using this favourite
    for (const s of state.slots) if (s.favId === id) Object.assign(s, { name: f.name, address: f.address, lat: f.lat, lng: f.lng, rate: f.rate, type: f.type, kw: f.kw, gentari: f.gentari, parking: f.parking, parkingUnit: f.parkingUnit, ...pickExtras(f) });
    persist(); resetFavForm(); renderFavs(); renderSlots();
    showToast('Saved ' + f.name);
  });
  $('#favCancel').addEventListener('click', resetFavForm);
  $$('#favForm [data-k=wkDiff]').forEach(c => c.addEventListener('change', () => syncWk($('#favForm'))));
  syncWk($('#favForm'));
  renderFavs();
  mountAutocomplete($('#favAuto'), p => {
    if (!$('#favName').value) $('#favName').value = p.name;
    $('#favAddress').value = p.address; $('#favLat').value = p.lat; $('#favLng').value = p.lng;
  }, 'Search for the charger').then(ok => { if (!ok) $('#favAuto').remove(); });
}

// ---------- UI: settings ----------
const SETTING_FIELDS = { apiKey: 'setApiKey', usableKwh: 'setUsableKwh', whPerKm: 'setWhPerKm', acLoss: 'setAcLoss', dcLoss: 'setDcLoss', onboardAc: 'setOnboardAc',
  wearPerKm: 'setWearPerKm', whHighway: 'setWhHighway', minArrive: 'setMinArrive', navApp: 'setNavApp', gentariPay: 'setGentariPay', gentariCredit: 'setGentariCredit' };
function fillSettings() { for (const [k, id] of Object.entries(SETTING_FIELDS)) $('#' + id).value = settings[k]; renderOpTable(); }
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
  $('#settingsReset').addEventListener('click', () => { const key = settings.apiKey; settings = { ...DEFAULTS, apiKey: key, operatorPrices: { ...DEFAULTS.operatorPrices } }; fillSettings(); });
  $('#settingsForm').addEventListener('submit', () => {
    const oldKey = settings.apiKey;
    for (const [k, id] of Object.entries(SETTING_FIELDS)) {
      const v = $('#' + id).value;
      settings[k] = k === 'apiKey' ? cleanKey(v) : k === 'navApp' ? (v || DEFAULTS.navApp) : (v === '' ? DEFAULTS[k] : Number(v));
    }
    if (settings.gentariCredit <= 0) settings.gentariCredit = DEFAULTS.gentariCredit;
    settings.operatorPrices = readOpTable();
    save(LS.settings, settings);
    renderBatteryHint(); renderKeyBanner();
    if (settings.apiKey !== oldKey) { routeCache.clear(); saveRouteCache(); if (settings.apiKey && !mapsReady) location.reload(); }
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
  const plan = sessionPlan(state.slots);
  if (plan.mode === 'target' && state.socTarget <= state.socNow) problems.push('Target charge must be above current charge.');
  if (plan.mode === 'credit' && state.socNow >= 99) problems.push('Battery is already full.');
  if (state.tripMode === 'detour' && !state.destination && !state.slots.every(s => s.manualKm !== '' && s.manualKm != null)) problems.push('Set a destination for the via-charger trip, or enter extra km manually.');
  state.slots.forEach((s, i) => {
    const label = s.name || `Charger ${i + 1}`;
    if (!(Number(s.rate) >= 0) || s.rate === '') problems.push(`${label}: enter RM/kWh.`);
    if (!(Number(s.kw) > 0)) problems.push(`${label}: enter charger kW.`);
    const hasManual = s.manualKm !== '' && s.manualKm != null && Number(s.manualKm) >= 0;
    const hasPin = s.lat != null && s.lng != null;
    if (!hasManual && !hasPin) problems.push(`${label}: pick its location from search or enter manual km.`);
    if (!hasManual && hasPin && !state.origin) problems.push(`Set a starting point (or enter manual km for ${label}).`);
    if (!hasManual && hasPin && !settings.apiKey) problems.push(`${label}: no Google key, so enter manual km.`);
  });
  if (problems.length) { out.classList.remove('hidden'); out.innerHTML = `<div class="verdict warn"><div class="eyebrow">Before comparing</div><div class="headline">A few things missing</div><ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`; scrollToResults(); return; }

  btn.disabled = true; btn.textContent = 'Working…';
  try {
    const legs = await legsFor(state.slots);
    const rows = state.slots.map((s, i) => legs[i] ? { slot: s, src: legs[i].src, ev: evaluate(s, legs[i], plan) } : { slot: s, error: 'No driving route found.' });
    renderResults(rows, plan);
  } catch (e) {
    out.classList.remove('hidden');
    out.innerHTML = `<div class="verdict bad"><div class="eyebrow">Error</div><div class="headline">Could not compare</div><div class="sub">${esc(e.message)}</div></div>`;
  } finally { btn.disabled = false; btn.textContent = 'Compare'; }
  scrollToResults();
}

function renderResults(rows, plan = { mode: 'target' }) {
  const out = $('#results');
  const nameOf = (r) => r.slot.name || 'Charger ' + (state.slots.indexOf(r.slot) + 1);
  const minA = Number(settings.minArrive) || 0;
  const reach = rows.filter(r => r.ev && r.ev.socArrive >= 0);
  const ok = reach.filter(r => r.ev.socArrive >= minA);
  const pool = ok.length ? ok : reach;
  const best = pool.length ? pool.reduce((a, b) => a.ev.total <= b.ev.total ? a : b) : null;
  const cat = (r) => !r.ev ? 3 : r.ev.socArrive < 0 ? 2 : r.ev.socArrive < minA ? 1 : 0;
  const sorted = [...rows].sort((a, b) => cat(a) - cat(b) || (a.ev?.total ?? 0) - (b.ev?.total ?? 0));
  const mins = (m) => `${Math.round(m)} min`;
  const afterWord = state.tripMode === 'round' ? 'home' : state.tripMode === 'detour' ? 'at your destination' : '';
  const logBtn = (r, cls = 'secondary') => `<button type="button" class="btn ${cls} small" data-log="${state.slots.indexOf(r.slot)}">Log this charge</button>`;
  const navBtn = (r, cls = 'secondary') => `<a class="btn ${cls} small" href="${esc(navUrl(r.slot))}" target="_blank" rel="noopener">${ICON('nav')}<span>Navigate</span></a>`;
  let html = '';

  // ---- the answer ----
  if (best) {
    const others = pool.filter(r => r !== best);
    const runner = others.length ? others.reduce((a, b) => a.ev.total <= b.ev.total ? a : b) : null;
    const save = runner ? runner.ev.total - best.ev.total : 0;
    const dt = runner ? best.ev.totalMin - runner.ev.totalMin : 0;
    const e = best.ev;
    let chips = '', line = '', advice = '';
    if (runner) {
      chips = `<span class="chip good">${save < 0.5 ? 'Same cost' : rm(save) + ' cheaper'}</span>` +
        (dt >= 2 ? `<span class="chip">${mins(dt)} longer</span>` : dt <= -2 ? `<span class="chip good">${mins(-dt)} quicker</span>` : `<span class="chip">Same time</span>`);
      line = `You pay <b>${rm(e.total)}</b> instead of ${rm(runner.ev.total)} at ${esc(nameOf(runner))}, and spend <b>${mins(e.totalMin)}</b> instead of ${mins(runner.ev.totalMin)}.`;
      advice = save < 1 ? 'Practically the same cost. Pick whichever is more convenient.'
        : dt >= 2 ? `Worth it if ${mins(dt)} of your time is worth less than ${rm(save)}.`
        : 'Cheaper and no slower. Easy choice.';
    } else line = `Only one charger to compare. It comes to <b>${rm(e.total)}</b> and <b>${mins(e.totalMin)}</b>.`;
    const battery = `Arrive with ${Math.round(e.socArrive)}%, leave with ${Math.round(e.socEnd)}%${afterWord ? `, ${Math.round(e.socAfter)}% ${afterWord}` : ''}.`;
    html += `<div class="verdict">
      <div class="eyebrow">Go to</div>
      <div class="headline">${esc(nameOf(best))}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      <div class="sub">${line}</div>
      ${advice ? `<div class="sub strong">${advice}</div>` : ''}
      <div class="sub">${battery}</div>
      ${!ok.length ? `<div class="sub warn-t">Every option arrives below your ${minA}% minimum. This is the cheapest you can reach.</div>` : ''}
      <div class="v-act">${navBtn(best, 'primary')}${logBtn(best)}</div>
      ${plan.mode === 'credit' ? `<div class="sub plan">Compared on the same ${num(plan.packKwh, 1)} kWh that one RM ${num(settings.gentariPay, 0)} → RM ${num(settings.gentariCredit, 0)} Gentari top-up buys.</div>` : ''}
    </div>`;
  } else {
    html += `<div class="verdict bad"><div class="eyebrow">Go to</div><div class="headline">None reachable</div><div class="sub">You would not make it to any of these on the current charge.</div></div>`;
  }

  // ---- every option, ranked ----
  const maxTotal = Math.max(...pool.map(r => r.ev.total), 0.01);
  const lines = (e, r) => {
    const st = r.slot, p = e.park, L = [];
    L.push(['Charging', rm(e.chargeCost), e.creditSession
      ? (e.topUpKwh > 0.05 ? `RM ${num(settings.gentariCredit, 0)} credit covers ${num(e.creditKwh, 1)} kWh here, plus ${num(e.topUpKwh, 1)} kWh at RM ${num(e.rate, 2)}` : `${num(e.billedKwh, 1)} kWh on one RM ${num(settings.gentariCredit, 0)} credit`)
      : `${num(e.billedKwh, 1)} kWh at RM ${num(e.rate, 2)}`]);
    L.push(['Parking', p.free ? 'Free' : rm(e.parkingCost), p.free ? '' : `${p.weekend ? 'weekend rate, ' : ''}${p.unit === 'hour' ? `${p.hours} h` : 'flat'}${p.capped ? ', capped' : ''}${p.grace ? `, first ${p.grace} min free` : ''}`]);
    if (e.idle.rate > 0) L.push(['Idle fee', rm(e.idleCost), e.idle.late ? `${e.idle.late} min plugged in after charging, ${e.idle.grace} free` : `none if you unplug within ${e.idle.grace} min`]);
    L.push(['Wear', rm(e.wearCost), `${num(e.km, 1)} km`]);
    return L.map(([k, v, d]) => `<div class="o-line"><span>${k}</span><b>${v}</b>${d ? `<small>${esc(d)}</small>` : ''}</div>`).join('') +
      `<div class="o-line time"><span>Time</span><b>${mins(e.totalMin)}</b><small>${mins(e.driveMin)} ${state.tripMode === 'detour' ? 'extra ' : ''}driving + ${mins(e.chargeMin)} charging on ${esc(st.type)} ${esc(st.kw)} kW</small></div>`;
  };
  html += `<div class="opts"><h2>All options</h2>${sorted.map(r => {
    if (!r.ev) return `<div class="opt dim"><div class="o-top"><span class="o-n">${esc(nameOf(r))}</span><span class="o-rm">—</span></div><div class="o-flag">${esc(r.error)}</div></div>`;
    const e = r.ev, dead = e.socArrive < 0, tight = !dead && e.socArrive < minA;
    const flag = dead ? `Can't reach it: you'd run out ${Math.round(-e.socArrive)}% short.` : tight ? `Arrives at ${Math.round(e.socArrive)}%, below your ${minA}% minimum.` : '';
    return `<div class="opt ${r === best ? 'best' : ''} ${dead || tight ? 'dim' : ''}">
      <div class="o-top"><span class="o-n">${esc(nameOf(r))}${r.slot.gentari ? ' <span class="tag">Gentari</span>' : ''}</span><span class="o-rm">${dead ? '—' : rm(e.total)}</span></div>
      <div class="o-sub"><span>${mins(e.totalMin)}</span><span>${Math.round(e.socArrive)}% → ${Math.round(e.socEnd)}%${afterWord ? ` · ${Math.round(e.socAfter)}% ${afterWord}` : ''}</span></div>
      ${dead ? '' : `<div class="o-bar"><i style="width:${(e.total / maxTotal * 100).toFixed(1)}%"></i></div>`}
      ${flag ? `<div class="o-flag">${flag}</div>` : ''}
      <details class="o-more"><summary>What makes up ${dead ? 'the cost' : rm(e.total)}</summary>${lines(e, r)}</details>
      ${dead ? '' : `<div class="o-act">${navBtn(r)}${r === best ? '' : logBtn(r)}</div>`}
    </div>`;
  }).join('')}
    <div class="hint">All-in = charging + parking${rows.some(r => r.ev && r.ev.idle.rate > 0) ? ' + idle fee' : ''} + wear. Distance: ${esc([...new Set(rows.filter(r => r.src).map(r => r.src))].join(' / ') || 'n/a')}. Navigation opens in ${navLabel()}.</div>
  </div>`;

  out.innerHTML = html;
  out.classList.remove('hidden');
  $$('[data-log]', out).forEach(b => b.addEventListener('click', () => {
    const r = rows.find(x => state.slots.indexOf(x.slot) === Number(b.dataset.log));
    if (r && r.ev) { logHistory(r, plan); $$(`[data-log="${b.dataset.log}"]`, out).forEach(x => { x.textContent = 'Logged ✓'; x.disabled = true; }); }
  }));
}

function navUrl(st) {
  const has = st.lat != null && st.lng != null;
  const ll = has ? `${st.lat},${st.lng}` : '';
  const q = encodeURIComponent([st.name, st.address].filter(Boolean).join(' '));
  const app = settings.navApp || 'google';
  if (app === 'waze') return has ? `https://waze.com/ul?ll=${ll}&navigate=yes` : `https://waze.com/ul?q=${q}&navigate=yes`;
  if (app === 'apple') return `https://maps.apple.com/?daddr=${has ? ll : q}&dirflg=d`;
  // Google Maps: in via-charger mode, route to the destination with the charger as a stop
  const d = state.destination;
  if (state.tripMode === 'detour' && d && has) return `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}&waypoints=${ll}&travelmode=driving`;
  return `https://www.google.com/maps/dir/?api=1&destination=${has ? ll : q}&travelmode=driving`;
}
const navLabel = () => ({ google: 'Google Maps', waze: 'Waze', apple: 'Apple Maps' }[settings.navApp] || 'Google Maps');

function scrollToResults() {
  const out = $('#results');
  const top = out.getBoundingClientRect().top + window.scrollY - ($('.topbar').offsetHeight + 12);
  window.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}


// ---------- nearby ----------
function haversineKm(a, b) {
  const R = 6371, toR = (d) => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function operatorFor(name) { return OPERATORS.find(o => o[1].test(name || '')) || OPERATORS[OPERATORS.length - 1]; }

/** Google Places (New) nearby EV chargers -> candidate objects shaped like slots. */
async function googleNearby(origin, radiusKm) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': settings.apiKey,
               'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,places.evChargeOptions' },
    body: JSON.stringify({ includedTypes: ['electric_vehicle_charging_station'], maxResultCount: 20, rankPreference: 'DISTANCE',
      locationRestriction: { circle: { center: { latitude: origin.lat, longitude: origin.lng }, radius: Math.min(50000, radiusKm * 1000) } } }),
  });
  if (!res.ok) { let m = 'Places nearby search failed (' + res.status + ')'; try { m += ': ' + (await res.json()).error?.message; } catch {} throw new Error(m); }
  const j = await res.json();
  return (j.places || []).filter(p => !p.businessStatus || p.businessStatus === 'OPERATIONAL').map(p => {
    const name = p.displayName?.text || 'EV charger';
    const op = operatorFor(name);
    const agg = p.evChargeOptions?.connectorAggregation || [];
    const dcTypes = /CCS|CHADEMO|TESLA/i;
    const dc = agg.filter(a => dcTypes.test(a.type || '') && (a.maxChargeRateKw || 0) >= 20);
    const ac = agg.filter(a => !dc.includes(a));
    let type, kw, assumedPower = false;
    if (dc.length) { type = 'DC'; kw = Math.max(...dc.map(a => a.maxChargeRateKw || 50)); }
    else if (ac.length) { type = 'AC'; kw = Math.max(...ac.map(a => a.maxChargeRateKw || 7)); }
    else { type = 'DC'; kw = 50; assumedPower = true; }
    const price = (settings.operatorPrices[op[0]] || DEFAULTS.operatorPrices.Other)[type];
    return { name, address: p.formattedAddress || '', lat: p.location.latitude, lng: p.location.longitude,
      rate: price, type, kw: Math.round(kw), gentari: op[3], parking: '', parkingUnit: 'flat', manualKm: '', manualMin: '',
      source: 'google', operator: op[0], assumedPower, placeId: p.id };
  });
}

async function findNearby() {
  const out = $('#nearOut'); const btn = $('#btnNear');
  if (!state.origin) { out.innerHTML = '<div class="verdict warn"><div class="headline">Set a starting point first</div><div class="sub">Tap “Use my location” above.</div></div>'; return; }
  btn.disabled = true; btn.textContent = 'Searching…';
  try {
    const radius = Number(settings.nearbyRadiusKm) || 5;
    let cands = favs.filter(f => f.lat != null && f.lng != null && Number(f.rate) > 0).map(f => ({ ...f, favId: f.id, source: 'saved', manualKm: '', manualMin: '' }));
    const notes = [];
    if (settings.apiKey) {
      try {
        const g = await googleNearby(state.origin, radius);
        for (const c of g) if (!cands.some(f => haversineKm(f, c) < 0.15)) cands.push(c);
      } catch (e) { notes.push(e.message); }
    } else notes.push('No Google key: showing saved chargers only, with straight-line distance estimates.');
    cands = cands.map(c => ({ ...c, airKm: haversineKm(state.origin, c) })).filter(c => c.source === 'saved' ? c.airKm <= radius * 1.5 : true)
      .sort((a, b) => a.airKm - b.airKm).slice(0, 15);
    if (!cands.length) { out.innerHTML = `<div class="hint" style="margin-top:10px">Nothing within ${radius} km. Widen the radius or save a charger with a pinned location.</div>`; return; }
    let legs;
    try { legs = await legsFor(cands); } catch (e) { notes.push(e.message + ' Showing straight-line estimates instead.'); legs = await legsFor(cands, { live: false }); }
    if (state.tripMode === 'detour' && !state.destination) notes.push('No destination set, so extra driving is measured one way to the charger.');
    const plan = sessionPlan(cands);
    const rows = cands.map((c, i) => legs[i] ? { cand: c, ev: evaluate(c, legs[i], plan), routed: legs[i].routed } : null)
      .filter(r => r && r.ev.socArrive >= 0).sort((a, b) => a.ev.total - b.ev.total);
    renderNearby(rows, plan, notes, radius);
  } catch (e) { out.innerHTML = `<div class="verdict bad"><div class="headline">Search failed</div><div class="sub">${esc(e.message)}</div></div>`; }
  finally { btn.disabled = false; btn.textContent = 'Find the cheapest charger nearby'; }
}

function renderNearby(rows, plan, notes, radius) {
  const out = $('#nearOut');
  if (!rows.length) { out.innerHTML = '<div class="hint" style="margin-top:10px">No reachable charger found.</div>'; return; }
  const minA = Number(settings.minArrive) || 0;
  rows = [...rows].sort((a, b) => (a.ev.socArrive < minA) - (b.ev.socArrive < minA) || a.ev.total - b.ev.total);
  const fastest = rows.reduce((a, b) => a.ev.totalMin <= b.ev.totalMin ? a : b);
  out.innerHTML = `
    ${plan.mode === 'credit' ? `<div class="hint" style="margin-top:10px">Gentari is nearby, so everything is compared on one RM ${num(settings.gentariCredit, 0)} credit: ${num(plan.packKwh, 1)} kWh into the pack.</div>` : `<div class="hint" style="margin-top:10px">Charging to ${state.socTarget}% at each.</div>`}
    <div class="near-list">${rows.map((r, i) => {
      const c = r.cand, e = r.ev;
      const flags = [];
      if (c.source === 'google') flags.push(`price assumed for ${c.operator}${c.assumedPower ? ', power unknown (50 kW DC assumed)' : ''}, parking not included`);
      if (!r.routed) flags.push('distance estimated');
      if (e.socArrive < minA) flags.push(`arrives at ${Math.round(e.socArrive)}%, below your ${minA}% minimum`);
      return `<div class="near ${i === 0 && e.socArrive >= minA ? 'best' : ''} ${e.socArrive < minA ? 'dim' : ''}" data-i="${i}">
        <div class="n"><span>${esc(c.name)}</span>${c.gentari ? '<span class="tag">Gentari</span>' : ''}<span class="tag type">${esc(c.type)} ${esc(c.kw)} kW</span>${c.source === 'saved' ? '<span class="tag src">saved</span>' : ''}</div>
        <div class="d">${num(e.km, 1)} km · ${Math.round(e.driveMin)} min drive · ${Math.round(e.chargeMin)} min charge · to ${Math.round(e.socEnd)}%</div>
        <div class="p"><div class="rm">${rm(e.total)}</div><div class="t">${Math.round(e.totalMin)} min${r === fastest ? ' · quickest' : ''}</div></div>
        ${flags.length ? `<div class="flag">${esc(flags.join(' · '))}</div>` : ''}
        <a class="near-nav" href="${esc(navUrl(c))}" target="_blank" rel="noopener">${ICON('nav')}<span>Navigate</span></a>
      </div>`;
    }).join('')}</div>
    <div class="near-actions"><button class="btn primary" id="nearCompare">Compare top ${Math.min(2, rows.length)} in detail</button></div>
    ${notes.length ? `<div class="hint">${notes.map(esc).join(' ')}</div>` : ''}
    <div class="hint">Within ${radius} km of ${esc(state.origin.label)}. All-in = charging + parking + idle fee + wear.</div>`;
  $('#nearCompare')?.addEventListener('click', () => {
    const picks = rows.slice(0, 2).map(r => {
      const c = r.cand; const slot = emptySlot();
      Object.assign(slot, { favId: c.favId || '', name: c.name, address: c.address, lat: c.lat, lng: c.lng, rate: c.rate, type: c.type, kw: c.kw, gentari: !!c.gentari, parking: c.parking ?? '', parkingUnit: c.parkingUnit || 'flat', ...pickExtras(c) });
      if (!r.routed) {
        const L = r.ev.legs;
        if (state.tripMode === 'detour') { slot.manualKm = num(L.extraKm, 1); slot.manualMin = String(Math.round(L.extraMin)); slot.manualToKm = num(L.toKm, 1); }
        else { slot.manualKm = num(L.toKm, 1); slot.manualMin = String(Math.round(L.toMin)); }
      }
      return slot;
    });
    while (picks.length < 2) picks.push(emptySlot());
    state.slots = picks; persist(); renderSlots(); compare();
  });
}

// ---------- history ----------
function logHistory(r, plan) {
  const e = r.ev, st = r.slot;
  history.unshift({ id: uid(), t: Date.now(), name: st.name || 'Charger', gentari: !!st.gentari, type: st.type, kw: Number(st.kw) || 0, rate: Number(st.rate) || 0,
    mode: state.tripMode, session: plan.mode, socNow: state.socNow, socArrive: Math.round(e.socArrive), socArriveExact: +e.socArrive.toFixed(1), socEnd: Math.round(e.socEnd), loss: Math.round(e.loss * 100),
    predKwh: +e.billedKwh.toFixed(1), predCost: +e.chargeCost.toFixed(2), predParking: +e.parkingCost.toFixed(2), predTotal: +e.total.toFixed(2),
    predChargeMin: Math.round(e.chargeMin), predDriveMin: Math.round(e.driveMin), km: +e.km.toFixed(1), predIdle: +e.idleCost.toFixed(2), actKwh: '', actCost: '', actMin: '', actEnd: '' });
  history = history.slice(0, 200);
  save(LS.history, history); renderHistory(); showToast('Logged. Fill in the receipt under History when you are done.');
}
/** Loss % implied by receipts: billed kWh vs energy that landed in the pack (arrival % → ended-at %). */
function calibration() {
  const out = {};
  for (const type of ['DC', 'AC']) {
    const es = history.filter(h => h.type === type && Number(h.actKwh) > 0 && h.actEnd !== '' && h.actEnd != null && Number(h.actEnd) > (h.socArriveExact ?? h.socArrive));
    if (es.length < 2) continue;
    const implied = es.map(h => 1 - ((Number(h.actEnd) - (h.socArriveExact ?? h.socArrive)) / 100 * settings.usableKwh) / Number(h.actKwh));
    const avg = implied.reduce((a, b) => a + b, 0) / implied.length * 100;
    out[type] = { n: es.length, loss: Math.round(Math.min(25, Math.max(0, avg))), current: type === 'AC' ? settings.acLoss : settings.dcLoss };
  }
  return out;
}
function renderHistory() {
  $('#histCount').textContent = history.length || '';
  const list = $('#histList'), sum = $('#histSummary');
  if (!history.length) { list.innerHTML = ''; sum.textContent = 'Nothing logged yet. After a comparison, tap “Log” on the charger you chose, then enter the kWh and RM from the receipt here.'; return; }
  const done = history.filter(h => h.actKwh !== '' && Number(h.actKwh) > 0);
  if (done.length) {
    const kwhErr = done.reduce((a, h) => a + (Number(h.actKwh) - h.predKwh) / h.predKwh, 0) / done.length * 100;
    const costDone = done.filter(h => h.actCost !== '' && h.predCost > 0);
    const costErr = costDone.length ? costDone.reduce((a, h) => a + (Number(h.actCost) - h.predCost) / h.predCost, 0) / costDone.length * 100 : null;
    const minDone = done.filter(h => h.actMin !== '' && h.predChargeMin > 0);
    const minErr = minDone.length ? minDone.reduce((a, h) => a + (Number(h.actMin) - h.predChargeMin) / h.predChargeMin, 0) / minDone.length * 100 : null;
    const w = (v) => v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(0)}%`;
    const cal = calibration();
    const calBtns = Object.entries(cal).filter(([, c]) => Math.abs(c.loss - c.current) >= 1)
      .map(([t, c]) => `<button type="button" class="btn secondary small" data-cal="${t}" data-v="${c.loss}">Set ${t} losses ${c.current}% → ${c.loss}% (from ${c.n} sessions)</button>`).join('');
    const calNote = Object.keys(cal).length ? (calBtns ? '' : ' Charging losses already match your receipts.') : ' Add “Ended at %” to two or more receipts of the same charger type to calibrate losses automatically.';
    sum.innerHTML = `${done.length} of ${history.length} sessions have receipts. Real kWh vs predicted: <b>${w(kwhErr)}</b>${costErr != null ? ` · cost <b>${w(costErr)}</b>` : ''}${minErr != null ? ` · charge time <b>${w(minErr)}</b>` : ''}.${calNote}${calBtns ? `<div class="cal-row">${calBtns}</div>` : ''}`;
    $$('[data-cal]', sum).forEach(b => b.addEventListener('click', () => {
      const v = Number(b.dataset.v); if (b.dataset.cal === 'AC') settings.acLoss = v; else settings.dcLoss = v;
      save(LS.settings, settings); showToast(`${b.dataset.cal} losses set to ${v}%.`); renderHistory();
    }));
  } else sum.textContent = `${history.length} logged, none with a receipt yet.`;
  list.innerHTML = history.map(h => {
    const d = new Date(h.t);
    const dt = d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' });
    const hasAct = h.actKwh !== '' && Number(h.actKwh) > 0;
    const diff = hasAct ? `<div class="diff">Receipt: <b>${num(h.actKwh, 1)} kWh</b>${h.actCost !== '' ? `, <b>${rm(Number(h.actCost))}</b>` : ''}${h.actMin !== '' ? `, <b>${h.actMin} min</b>` : ''} · predicted ${num(h.predKwh, 1)} kWh${h.actCost !== '' ? `, ${rm(h.predCost)}` : ''}${h.actMin !== '' ? `, ${h.predChargeMin} min` : ''}</div>` : '';
    return `<div class="hist" data-id="${h.id}">
      <div class="top"><span class="n">${esc(h.name)}${h.gentari ? ' <span class="tag">Gentari</span>' : ''}</span><span class="dt">${esc(dt)}</span></div>
      <div class="pred">${h.socNow}% → ${h.socEnd}% · ${num(h.predKwh, 1)} kWh · ${rm(h.predCost)} charging${h.predParking ? ` + ${rm(h.predParking)} parking` : ''} · ${h.predChargeMin} min charge · ${num(h.km, 1)} km · ${h.mode === 'round' ? 'round trip' : h.mode === 'detour' ? 'via charger' : 'one way'}</div>
      <div class="act">
        <label>Actual kWh <input type="number" step="0.1" min="0" inputmode="decimal" data-f="actKwh" value="${esc(h.actKwh)}" placeholder="${num(h.predKwh, 1)}"></label>
        <label>Actual RM <input type="number" step="0.01" min="0" inputmode="decimal" data-f="actCost" value="${esc(h.actCost)}" placeholder="${num(h.predCost, 2)}"></label>
        <button type="button" class="icon-btn" data-del aria-label="Delete">${ICON('trash')}</button>
        <label>Charge min <input type="number" step="1" min="0" inputmode="numeric" data-f="actMin" value="${esc(h.actMin)}" placeholder="${h.predChargeMin}"></label>
        <label>Ended at % <input type="number" step="1" min="0" max="100" inputmode="numeric" data-f="actEnd" value="${esc(h.actEnd ?? '')}" placeholder="${h.socEnd}"></label>
      </div>
      ${diff}
    </div>`;
  }).join('');
  $$('.hist input', list).forEach(i => i.addEventListener('change', e => {
    const id = e.target.closest('.hist').dataset.id; const h = history.find(x => x.id === id); if (!h) return;
    h[e.target.dataset.f] = e.target.value; save(LS.history, history); renderHistory();
  }));
  $$('.hist [data-del]', list).forEach(b => b.addEventListener('click', e => {
    const id = e.target.closest('.hist').dataset.id;
    if (confirm('Delete this entry?')) { history = history.filter(x => x.id !== id); save(LS.history, history); renderHistory(); }
  }));
}
function bindHistory() {
  renderHistory();
  $('#histClear').addEventListener('click', () => { if (history.length && confirm('Clear all history?')) { history = []; save(LS.history, history); renderHistory(); } });
  $('#histCopy').addEventListener('click', async () => {
    const cols = ['t', 'name', 'gentari', 'type', 'kw', 'rate', 'mode', 'session', 'socNow', 'socArrive', 'socEnd', 'km', 'loss', 'predKwh', 'predCost', 'predParking', 'predIdle', 'predTotal', 'predChargeMin', 'predDriveMin', 'actKwh', 'actCost', 'actMin', 'actEnd'];
    const csv = [cols.join(','), ...history.map(h => cols.map(c => c === 't' ? new Date(h.t).toISOString() : JSON.stringify(h[c] ?? '')).join(','))].join('\n');
    try { await navigator.clipboard.writeText(csv); showToast('History copied as CSV.'); } catch { showToast('Could not copy.'); }
  });
}

function renderOpTable() {
  const host = $('#opTable');
  host.innerHTML = '<div class="h">Operator</div><div class="h">DC RM/kWh</div><div class="h">AC RM/kWh</div>' + OPERATORS.map(([name]) => {
    const p = settings.operatorPrices[name] || DEFAULTS.operatorPrices[name];
    return `<div class="n">${esc(name)}</div><input type="number" step="0.01" min="0" inputmode="decimal" data-op="${esc(name)}" data-t="DC" value="${Number(p.DC).toFixed(2)}"><input type="number" step="0.01" min="0" inputmode="decimal" data-op="${esc(name)}" data-t="AC" value="${Number(p.AC).toFixed(2)}">`;
  }).join('');
}
function readOpTable() {
  const prices = {};
  $$('#opTable input').forEach(i => { prices[i.dataset.op] = prices[i.dataset.op] || {}; prices[i.dataset.op][i.dataset.t] = Number(i.value) || DEFAULTS.operatorPrices[i.dataset.op][i.dataset.t]; });
  return prices;
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
  bindTrip();
  bindFavs();
  bindHistory();
  renderSlots();
  $('#btnAddSlot').addEventListener('click', () => { if (state.slots.length < 4) { state.slots.push(emptySlot()); persist(); renderSlots(); } });
  $('#btnCompare').addEventListener('click', compare);
  $('#nearRadius').value = String(settings.nearbyRadiusKm || 5);
  $('#nearRadius').addEventListener('change', e => { settings.nearbyRadiusKm = Number(e.target.value); save(LS.settings, settings); });
  $('#btnNear').addEventListener('click', findNearby);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);

// expose for debugging in console
window.tcc = { evaluate, legsFor, chargeMinutes, dcMaxKw, get settings() { return settings; }, get state() { return state; }, get history() { return history; } };
})();
