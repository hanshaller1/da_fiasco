// ============================================================================
// DEBACLE UI — core: DSP metadata, state, messaging, widgets, menus.
// ============================================================================
'use strict';

const DSP_SRC = document.getElementById('dsp-src').textContent;
// The DSP script above runs on the main thread too (for metadata and the ScriptProcessor
// fallback); its source text is handed to the AudioWorklet. No eval needed.
const DSP = { UNITS, FX_REGISTRY, HOST_FX_PARAMS, DebacleEngine, prepParam, normToValue, valueToNorm, formatValue,
  MOD_SOURCES, MOD_SOURCE_IDS, LFO_SHAPES, WARP_ZONES, BREAK_ZONES, zoneOf, DEFAULT_GRAPHS, evalGraph, defaultSeq,
  SLOT_SHAPES, DIV_BEATS, NOTE_NAMES, SCALE_NAMES, LINK_PRESETS, TE_SEQ_RATES, clamp, CHORD_NAMES };

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const clampN = (x) => (x > 0 ? (x > 1 ? 1 : x) : 0); // NaN -> 0
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const svgNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs) { const el = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v); return el; }

// ------------------------------------------------------------- metadata ----
const DEFS = {};      // 'unit.param' -> { d, unit, ulabel, group }
const FXMETA = {};    // fx id -> { id, label, cat, desc, latency, params }
for (const [u, def] of Object.entries(DSP.UNITS)) for (const d of def.params) DEFS[u + '.' + d.id] = { d, unit: u, ulabel: def.label, group: def.group };
for (const cls of DSP.FX_REGISTRY) {
  const params = DSP.HOST_FX_PARAMS().concat(cls.params.map((d) => Object.assign({}, d)));
  params.forEach(DSP.prepParam);
  FXMETA[cls.id] = { id: cls.id, label: cls.label, cat: cls.cat, desc: cls.desc || '', latency: cls.latency || 0, params };
  for (const d of params) DEFS['fx.' + cls.id + '.' + d.id] = { d, unit: 'fx.' + cls.id, ulabel: cls.label, group: 'FX' };
}
const FX_CATS = ['DISTORTION', 'DYNAMICS', 'FILTER', 'MODULATION', 'SPECTRAL', 'PITCH', 'RESONATOR', 'GRANULAR', 'DELAY', 'REVERB', 'GLITCH'];
const SRC_INFO = Object.fromEntries(DSP.MOD_SOURCES.map(([id, label, tag]) => [id, { id, label, tag }]));
const SLOT_CAP = (src) => (src.startsWith('lfo') || src.startsWith('graph') ? 6 : 5);
const ENGINE_UNITS = { stretch: 'stretch.on', vari: 'vari.on', stutter: 'stutter.on', bend: 'stutter.on' };

// ---------------------------------------------------------------- state ----
const P = {};   // base normalized values
for (const [k, m] of Object.entries(DEFS)) P[k] = m.d.defN;
const S = {
  chain: [],
  slots: [],
  graphs: DSP.DEFAULT_GRAPHS.map((g) => g.map((p) => ({ ...p }))),
  seq: { stutter: DSP.defaultSeq('stutter'), stretch: DSP.defaultSeq('stretch') },
  bpm: 120,
  dice: {},        // 'unit.param' -> strength 0..1 (default 1; 0 = locked)
};
const live = { mods: {}, src: new Array(DSP.MOD_SOURCE_IDS.length).fill(0), tick: null, playing: false };

// --------------------------------------------------------------- engine link
let enginePort = null;     // set by audio module: { post(msg) }
function post(msg, transfer) { if (enginePort) enginePort.post(msg, transfer); }
const listeners = { change: new Set(), slots: new Set(), chain: new Set(), tick: new Set(), dirty: new Set() };
const on = (ev, fn) => listeners[ev].add(fn);
const emit = (ev, a) => { for (const fn of listeners[ev]) fn(a); };

const widgets = new Map(); // key -> Set of widgets with update()
function regWidget(key, w) { if (!widgets.has(key)) widgets.set(key, new Set()); widgets.get(key).add(w); }
function refreshWidgets(key) { const set = widgets.get(key); if (set) for (const w of set) { if (!w.el.isConnected) set.delete(w); else w.update(); } }
function refreshAllWidgets() { for (const k of widgets.keys()) refreshWidgets(k); }

let dirty = false;
function markDirty() { if (!dirty) { dirty = true; emit('dirty', true); } }

function setP(key, n, opts = {}) {
  if (!(key in DEFS)) return;
  n = clampN(+n);
  P[key] = n;
  if (opts.send !== false) post({ type: 'param', k: key, n });
  refreshWidgets(key);
  if (!opts.quiet) markDirty();
  emit('change', key);
}
const getV = (key) => DSP.normToValue(DEFS[key].d, P[key]);
const fmt = (key, n = P[key]) => DSP.formatValue(DEFS[key].d, n);
function sendAll() {
  post({ type: 'params', list: Object.entries(P) });
  post({ type: 'chain', ids: S.chain });
  post({ type: 'slots', slots: S.slots });
  S.graphs.forEach((pts, i) => post({ type: 'graph', i, points: pts }));
  post({ type: 'seq', which: 'stutter', pats: S.seq.stutter });
  post({ type: 'seq', which: 'stretch', pats: S.seq.stretch });
  post({ type: 'bpm', bpm: S.bpm });
}

// ------------------------------------------------------------------ slots --
function slotsFor(key) { return S.slots.filter((s) => s.target === key); }
function slotsFrom(src) { return S.slots.filter((s) => s.src === src); }
function sendSlots() { post({ type: 'slots', slots: S.slots }); emit('slots'); markDirty(); }
function addSlot(src, target) {
  if (!DEFS[target]) return null;
  if (slotsFrom(src).length >= SLOT_CAP(src)) { toast(`${SRC_INFO[src].label} already drives ${SLOT_CAP(src)} targets. Remove one first.`); return null; }
  if (S.slots.some((s) => s.src === src && s.target === target)) { toast('That source already drives this parameter.'); return null; }
  const base = P[target];
  const perform = !(src.startsWith('lfo') || src.startsWith('graph'));
  const d = DEFS[target].d;
  let min, max;
  if (d.kind === 'toggle') { min = 0; max = 1; }
  else if (perform) { min = base; max = base < 0.7 ? 1 : 0; }
  else { min = Math.max(0, base - 0.3); max = Math.min(1, base + 0.3); if (max - min < 0.3) { min = Math.max(0, max - 0.6); max = Math.min(1, min + 0.6); } }
  const slot = { src, target, min, max, start: 0, end: 1, skew: 0, shape: 0 };
  S.slots.push(slot);
  sendSlots(); refreshWidgets(target);
  return slot;
}
function removeSlot(slot) {
  const i = S.slots.indexOf(slot); if (i < 0) return;
  S.slots.splice(i, 1); sendSlots(); refreshWidgets(slot.target);
}
function slotChanged(slot) { post({ type: 'slots', slots: S.slots }); markDirty(); refreshWidgets(slot.target); }
function keyLabel(key) {
  const m = DEFS[key]; if (!m) return key;
  return `${m.ulabel} · ${m.d.label}`;
}

// ------------------------------------------------------------- info bar ----
let infoEl = null, infoTimer = 0;
function setInfo(text, val) {
  if (!infoEl) infoEl = $('#info');
  if (!infoEl) return;
  infoEl.querySelector('.info-name').textContent = text || '';
  infoEl.querySelector('.info-val').textContent = val || '';
  clearTimeout(infoTimer);
}
function clearInfoSoon() { clearTimeout(infoTimer); infoTimer = setTimeout(() => setInfo('', ''), 1600); }
function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3100);
}

// --------------------------------------------------------------- knobs -----
const A0 = -135, A1 = 135;
function polar(cx, cy, r, deg) { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
function arc(cx, cy, r, d0, d1) {
  if (Math.abs(d1 - d0) < 0.01) d1 = d0 + 0.01;
  const [x0, y0] = polar(cx, cy, r, Math.min(d0, d1)), [x1, y1] = polar(cx, cy, r, Math.max(d0, d1));
  const large = Math.abs(d1 - d0) > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
const n2deg = (n) => A0 + (A1 - A0) * n;

function engineAutoOn(key) {
  const unit = DEFS[key].unit, onKey = ENGINE_UNITS[unit];
  if (onKey && key !== onKey && P[onKey] < 0.5) setP(onKey, 1);
  if (unit.startsWith('fx.')) { const ok = unit + '.on'; if (key !== ok && P[ok] < 0.5) setP(ok, 1); }
}

function attachParamHover(el, key) {
  el.addEventListener('pointerenter', () => setInfo(keyLabel(key), fmt(key)));
  el.addEventListener('pointerleave', clearInfoSoon);
}
function attachContext(el, key) {
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); paramMenu(key, e.clientX, e.clientY); });
  let lp = 0, sx = 0, sy = 0;
  el.addEventListener('pointerdown', (e) => { delete el.dataset.lp; if (e.pointerType !== 'touch') return; sx = e.clientX; sy = e.clientY; lp = setTimeout(() => { lp = 0; el.dataset.lp = '1'; paramMenu(key, sx, sy); }, 550); });
  const cancel = (e) => { if (lp && (!e || Math.hypot(e.clientX - sx, e.clientY - sy) > 8 || e.type !== 'pointermove')) { clearTimeout(lp); lp = 0; } };
  el.addEventListener('pointermove', cancel); el.addEventListener('pointerup', cancel); el.addEventListener('pointercancel', cancel);
}

function Knob(key, opts = {}) {
  const m = DEFS[key]; if (!m) return h('div', { class: 'knob missing' }, '?');
  const d = m.d, size = opts.size || (opts.big ? 64 : 44), r = size / 2 - 5, cx = size / 2, cy = size / 2;
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'knob-svg', 'aria-hidden': 'true' });
  const track = s('path', { class: 'k-track', d: arc(cx, cy, r, A0, A1) });
  const val = s('path', { class: 'k-val' });
  const modr = s('path', { class: 'k-mod' });
  const dot = s('circle', { class: 'k-dot', r: 2.2, cx: -20, cy: -20 });
  const cap = s('circle', { class: 'k-cap', cx, cy, r: r - 5 });
  const ptr = s('line', { class: 'k-ptr' });
  svg.append(track, val, modr, cap, ptr, dot);
  const labText = opts.label || d.label;
  const label = h('div', { class: 'k-label' + (labText.length > 9 ? ' long' : '') }, labText);
  const value = h('div', { class: 'k-value' });
  const badge = h('div', { class: 'k-badge' });
  const el = h('div', { class: 'knob' + (opts.big ? ' big' : '') + (d.bipolar ? ' bipolar' : ''), tabindex: 0, role: 'slider', 'aria-label': keyLabel(key), 'aria-valuemin': 0, 'aria-valuemax': 100 }, badge, svg, value, label);
  const w = {
    el,
    update() {
      const n = P[key];
      const a = n2deg(n), mid = d.bipolar ? 0 : A0;
      val.setAttribute('d', arc(cx, cy, r, mid, a));
      const [px, py] = polar(cx, cy, r - 5, a), [qx, qy] = polar(cx, cy, r - 11, a);
      ptr.setAttribute('x1', qx); ptr.setAttribute('y1', qy); ptr.setAttribute('x2', px); ptr.setAttribute('y2', py);
      const sl = slotsFor(key);
      el.classList.toggle('modded', sl.length > 0);
      if (sl.length) {
        const lo = Math.min(...sl.map((x) => Math.min(x.min, x.max))), hi = Math.max(...sl.map((x) => Math.max(x.min, x.max)));
        modr.setAttribute('d', arc(cx, cy, r + 3.5, n2deg(lo), n2deg(hi)));
        badge.textContent = [...new Set(sl.map((x) => SRC_INFO[x.src].tag === 'LFO' ? modTag(x.src) : SRC_INFO[x.src].tag))].join(' ');
      } else { modr.setAttribute('d', ''); badge.textContent = ''; }
      dot.style.display = sl.length ? '' : 'none';
      value.textContent = fmt(key, sl.length && live.mods[key] !== undefined ? live.mods[key] : n);
      el.setAttribute('aria-valuetext', value.textContent); el.setAttribute('aria-valuenow', Math.round(n * 100));
    },
    live(nm) { // modulated live value
      const [x, y] = polar(cx, cy, r + 3.5, n2deg(nm)); dot.setAttribute('cx', x); dot.setAttribute('cy', y);
      value.textContent = fmt(key, nm);
    },
  };
  regWidget(key, w);
  liveKnobs.add({ key, w });
  w.update();
  // interaction
  let drag = null;
  const discrete = d.kind !== 'num';
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.k-badge') && slotsFor(key).length) { e.preventDefault(); badgeMenu(key, e.clientX, e.clientY); return; }
    e.preventDefault(); el.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, x: e.clientX, n: P[key], acc: 0, moved: false, slots: slotsFor(key).map((x) => ({ x, min: x.min, max: x.max })) };
    engineAutoOn(key);
    el.classList.add('drag');
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || el.dataset.lp) return; // long-press opened the menu: the finger no longer drags
    const dy = (drag.y - e.clientY) + (e.clientX - drag.x) * 0.35;
    if (Math.abs(dy) > 2) drag.moved = true;
    const sens = (e.shiftKey ? 900 : 180) * (opts.big ? 1.4 : 1);
    if (drag.slots.length) { // modulated: drag shifts the modulation window
      const off = dy / sens;
      for (const q of drag.slots) { const lo = Math.min(q.min, q.max), hi = Math.max(q.min, q.max); const o = Math.max(-lo, Math.min(1 - hi, off)); q.x.min = q.min + o; q.x.max = q.max + o; }
      post({ type: 'slots', slots: S.slots }); w.update(); setInfo(keyLabel(key), 'mod range ' + fmt(key, Math.min(drag.slots[0].x.min, drag.slots[0].x.max)) + ' – ' + fmt(key, Math.max(drag.slots[0].x.min, drag.slots[0].x.max)));
      markDirty(); emit('slots');
      return;
    }
    let n = drag.n + dy / sens;
    if (discrete) { const steps = d.options.length - 1; n = Math.round(clampN(n) * steps) / steps; }
    if (n !== P[key]) { setP(key, n); setInfo(keyLabel(key), fmt(key)); }
  });
  const end = () => { if (drag) { drag = null; el.classList.remove('drag'); clearInfoSoon(); } delete el.dataset.lp; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => { setP(key, d.defN); setInfo(keyLabel(key), fmt(key)); });
  el.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.altKey && !el.matches(':focus')) return;
    e.preventDefault();
    const step = discrete ? 1 / (d.options.length - 1) : (e.shiftKey ? 0.002 : 0.012);
    setP(key, P[key] + (e.deltaY < 0 ? step : -step)); setInfo(keyLabel(key), fmt(key));
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const step = discrete ? 1 / (d.options.length - 1) : (e.shiftKey ? 0.002 : 0.02);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setP(key, P[key] + step); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setP(key, P[key] - step); e.preventDefault(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { setP(key, d.defN); e.preventDefault(); }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { const r0 = el.getBoundingClientRect(); paramMenu(key, r0.left, r0.bottom); e.preventDefault(); }
    else return;
    setInfo(keyLabel(key), fmt(key));
  });
  attachParamHover(el, key); attachContext(el, key);
  return el;
}
const liveKnobs = new Set();
function modTag(src) { return 'MOD' + src.slice(3); }

// Toggle button bound to a param
function Toggle(key, opts = {}) {
  const m = DEFS[key]; const d = m.d;
  const el = h('button', { class: 'tog' + (opts.cls ? ' ' + opts.cls : ''), type: 'button', 'aria-pressed': 'false' }, opts.label || d.label);
  const w = { el, update() { const onv = P[key] >= 0.5; el.classList.toggle('on', onv); el.setAttribute('aria-pressed', onv ? 'true' : 'false'); el.classList.toggle('modded', slotsFor(key).length > 0); } };
  regWidget(key, w); w.update();
  if (opts.momentary) {
    const down = (e) => { e.preventDefault(); el.setPointerCapture?.(e.pointerId); engineAutoOn(key); setP(key, 1); };
    const up = () => { if (P[key] >= 0.5) setP(key, 0); };
    el.addEventListener('pointerdown', down); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) setP(key, 1); } });
    el.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') setP(key, 0); });
  } else el.addEventListener('click', () => { if (el.dataset.lp) { delete el.dataset.lp; return; } if (opts.autoOn !== false) engineAutoOn(key); setP(key, P[key] >= 0.5 ? 0 : 1); setInfo(keyLabel(key), fmt(key)); });
  attachParamHover(el, key); attachContext(el, key);
  return el;
}
// Power button for a unit
function Power(key, title) {
  const el = h('button', { class: 'power', type: 'button', title: title || 'On / off', 'aria-label': (title || 'Power') + ' ' + DEFS[key].ulabel, 'aria-pressed': 'false' },
    h('span', { class: 'power-led' }));
  const w = { el, update() { const v = P[key] >= 0.5; el.classList.toggle('on', v); el.setAttribute('aria-pressed', v ? 'true' : 'false'); } };
  regWidget(key, w); w.update();
  el.addEventListener('click', () => setP(key, P[key] >= 0.5 ? 0 : 1));
  attachContext(el, key);
  return el;
}
// Segmented selector for small enums
function Segment(key, opts = {}) {
  const m = DEFS[key]; const d = m.d;
  const labels = opts.labels || d.options;
  const el = h('div', { class: 'seg' + (opts.cls ? ' ' + opts.cls : ''), role: 'radiogroup', 'aria-label': keyLabel(key) });
  const btns = labels.map((lab, i) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false' }, lab);
    b.addEventListener('click', () => { if (el.dataset.lp) { delete el.dataset.lp; return; } engineAutoOn(key); setP(key, d.options.length > 1 ? i / (d.options.length - 1) : 0); setInfo(keyLabel(key), fmt(key)); });
    el.append(b); return b;
  });
  const w = { el, update() { const idx = Math.round(P[key] * (d.options.length - 1)); btns.forEach((b, i) => { b.classList.toggle('on', i === idx); b.setAttribute('aria-checked', i === idx ? 'true' : 'false'); }); el.classList.toggle('modded', slotsFor(key).length > 0); } };
  regWidget(key, w); w.update();
  attachParamHover(el, key); attachContext(el, key);
  return el;
}
// Dropdown selector for long enums
function Select(key, opts = {}) {
  const m = DEFS[key]; const d = m.d;
  const lab = h('span', { class: 'sel-label' }, opts.label || d.label);
  const val = h('span', { class: 'sel-val' });
  const el = h('button', { type: 'button', class: 'sel' + (opts.cls ? ' ' + opts.cls : ''), 'aria-haspopup': 'listbox' }, lab, val, h('span', { class: 'sel-caret', 'aria-hidden': 'true' }, '▾'));
  const w = { el, update() { val.textContent = fmt(key); el.classList.toggle('modded', slotsFor(key).length > 0); } };
  regWidget(key, w); w.update();
  el.addEventListener('click', () => {
    if (el.dataset.lp) { delete el.dataset.lp; return; }
    const r = el.getBoundingClientRect();
    const items = d.options.map((o, i) => ({ label: o, checked: Math.round(P[key] * (d.options.length - 1)) === i, act: () => { engineAutoOn(key); setP(key, i / (d.options.length - 1)); } }));
    menu(items, r.left, r.bottom + 4, { title: opts.label || d.label, cols: d.options.length > 12 ? 2 : 1 });
  });
  attachParamHover(el, key); attachContext(el, key);
  return el;
}
// Auto widget by descriptor
function Ctl(key, opts = {}) {
  const m = DEFS[key]; if (!m) return null;
  const d = m.d;
  if (d.kind === 'toggle') return Toggle(key, opts);
  if (d.kind === 'enum') return d.options.length <= 3 && d.options.join('').length <= 18 && !opts.select ? Segment(key, opts) : Select(key, opts);
  return Knob(key, opts);
}

// ---------------------------------------------------------------- menus ----
let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escClose, true); } }
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
function escClose(e) { if (e.key === 'Escape') { closeMenu(); e.stopPropagation(); } }
function menu(items, x, y, opts = {}) {
  closeMenu();
  const el = h('div', { class: 'menu' + (opts.cols === 2 ? ' cols2' : ''), role: 'menu' });
  if (opts.title) el.append(h('div', { class: 'menu-title' }, opts.title));
  for (const it of items) {
    if (it.sep) { el.append(h('div', { class: 'menu-sep' }, it.sep === true ? '' : it.sep)); continue; }
    if (it.node) { el.append(it.node); continue; }
    const b = h('button', { type: 'button', role: 'menuitem', class: 'menu-item' + (it.checked ? ' checked' : '') + (it.danger ? ' danger' : ''), disabled: it.disabled }, h('span', null, it.label), it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null);
    b.addEventListener('click', () => { if (!it.keep) closeMenu(); it.act && it.act(); });
    el.append(b);
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  el.style.left = Math.max(8, Math.min(x, vw - r.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, vh - r.height - 8)) + 'px';
  openMenu = el;
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escClose, true); }, 0);
  const first = el.querySelector('.menu-item:not([disabled])'); if (first) first.focus({ preventScroll: true });
  return el;
}
function paramMenu(key, x, y) {
  const m = DEFS[key]; const sl = slotsFor(key);
  const items = [];
  items.push({ label: 'Reset to default', hint: fmt(key, m.d.defN), act: () => setP(key, m.d.defN) });
  items.push({ sep: 'Modulate with' });
  for (const [id, label] of DSP.MOD_SOURCES) {
    const used = sl.some((q) => q.src === id);
    const full = slotsFrom(id).length >= SLOT_CAP(id);
    items.push({ label, checked: used, disabled: used || full, hint: full && !used ? 'full' : `${slotsFrom(id).length}/${SLOT_CAP(id)}`, act: () => { addSlot(id, key); toast(`${label} → ${keyLabel(key)}`); } });
  }
  if (sl.length) {
    items.push({ sep: 'Remove' });
    for (const q of sl) items.push({ label: 'Remove ' + SRC_INFO[q.src].label, danger: true, act: () => removeSlot(q) });
  }
  // dice strength (random setup)
  const st = S.dice[key] ?? defaultDice(key);
  const range = h('input', { type: 'range', min: 0, max: 100, value: Math.round(st * 100), 'aria-label': 'Dice strength' });
  const lab = h('span', { class: 'menu-hint' }, st === 0 ? 'locked' : Math.round(st * 100) + '%');
  range.addEventListener('input', () => { const v = +range.value / 100; S.dice[key] = v; lab.textContent = v === 0 ? 'locked' : range.value + '%'; markDirty(); });
  items.push({ sep: 'Dice strength' });
  items.push({ node: h('div', { class: 'menu-range' }, range, lab) });
  menu(items, x, y, { title: keyLabel(key), cols: 1 });
}
function badgeMenu(key, x, y) {
  const items = [];
  for (const q of slotsFor(key)) {
    items.push({ label: 'Show ' + SRC_INFO[q.src].label, act: () => gotoSource(q.src) });
    items.push({ label: 'Remove ' + SRC_INFO[q.src].label, danger: true, act: () => removeSlot(q) });
  }
  menu(items, x, y, { title: keyLabel(key) });
}
function gotoSource(src) {
  const page = src.startsWith('lfo') || src.startsWith('graph') ? 'animate' : 'perform';
  showPage(page);
  const el = document.getElementById('src-' + src);
  if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900); }
}
function defaultDice(key) { const id = key.slice(key.lastIndexOf('.') + 1); return ['on', 'mix', 'gain', 'bend', 'seq', 'freeze', 'stop', 'bypass', 'link', 'sync', 'tsync', 'free', 'mode', 'esrc'].includes(id) || key.startsWith('main.') || key.startsWith('key.') ? 0 : 1; }

// Target picker (modal list of all parameters, grouped)
function targetGroups(excludeSrc) {
  const groups = [];
  const unitParams = (u, filter) => DSP.UNITS[u].params.filter((d) => !filter || filter(d)).map((d) => u + '.' + d.id);
  groups.push(['STRETCH', unitParams('stretch')]);
  groups.push(['VARISPEED', unitParams('vari')]);
  groups.push(['STUTTER', unitParams('stutter')]);
  groups.push(['BENDIT', unitParams('bend')]);
  groups.push(['TIME', unitParams('time')]);
  for (const id of S.chain) groups.push(['FX · ' + FXMETA[id].label, FXMETA[id].params.map((d) => 'fx.' + id + '.' + d.id)]);
  groups.push(['MAIN', unitParams('main')]);
  groups.push(['KEY', unitParams('key')]);
  for (let i = 1; i <= 4; i++) if (excludeSrc !== 'lfo' + i) groups.push(['MOD ' + i, unitParams('lfo' + i, (d) => !['mode', 'esrc'].includes(d.id))]);
  for (let i = 1; i <= 3; i++) if (excludeSrc !== 'graph' + i) groups.push(['GRAPH ' + i, unitParams('graph' + i)]);
  groups.push(['PERFORM', unitParams('perform').filter((k) => k !== 'perform.' + excludeSrc)]);
  groups.push(['SEQUENCERS', [...unitParams('sseq'), ...unitParams('tseq')]]);
  return groups;
}
function pickTarget(src, cb) {
  closeMenu();
  const wrap = h('div', { class: 'modal-wrap' });
  const search = h('input', { type: 'search', class: 'tp-search', placeholder: 'Search parameters…', 'aria-label': 'Search parameters' });
  const list = h('div', { class: 'tp-list' });
  const close = () => { wrap.remove(); document.removeEventListener('keydown', esc, true); };
  const esc = (e) => { if (e.key === 'Escape') { close(); e.stopPropagation(); } };
  const render = () => {
    list.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    for (const [g, keys] of targetGroups(src)) {
      const ks = keys.filter((k) => !q || (g + ' ' + DEFS[k].d.label).toLowerCase().includes(q));
      if (!ks.length) continue;
      const box = h('div', { class: 'tp-group' }, h('div', { class: 'tp-gname' }, g));
      const row = h('div', { class: 'tp-items' });
      for (const k of ks) {
        const taken = S.slots.some((x) => x.src === src && x.target === k);
        row.append(h('button', { type: 'button', class: 'tp-item' + (taken ? ' taken' : ''), disabled: taken, onclick: () => { close(); cb(k); } }, DEFS[k].d.label));
      }
      box.append(row); list.append(box);
    }
    if (!list.children.length) list.append(h('p', { class: 'muted' }, 'No parameter matches that search.'));
  };
  search.addEventListener('input', render);
  const dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose a target' },
    h('div', { class: 'modal-head' }, h('h3', null, `${SRC_INFO[src].label} → target`), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×')),
    search, list);
  wrap.append(dlg);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', esc, true);
  document.body.append(wrap); render(); search.focus();
}

// ------------------------------------------------------------ slot editor --
// Compact editor row for a modulation slot (MIN/MAX/START/END/SKEW/SHAPE + curve preview)
function SlotRow(slot, opts = {}) {
  const row = h('div', { class: 'slot' });
  const name = h('button', { type: 'button', class: 'slot-name', title: 'Show parameter' }, keyLabel(slot.target));
  name.addEventListener('click', () => revealParam(slot.target));
  const del = h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Remove assignment' }, '×');
  del.addEventListener('click', () => removeSlot(slot));
  const cv = h('canvas', { class: 'slot-curve', width: 72, height: 30, 'aria-hidden': 'true' });
  const draw = () => {
    const f = fit(cv); if (!f) { requestAnimationFrame(draw); return; }
    const { c, W, H } = f;
    c.clearRect(0, 0, W, H);
    c.strokeStyle = cssVar('--line'); c.lineWidth = 1; c.strokeRect(0.5, 0.5, W - 1, H - 1);
    c.strokeStyle = cssVar(opts.color || '--mod'); c.lineWidth = 1.6; c.beginPath();
    for (let i = 0; i <= W; i++) { const y = mapSlot(slot, i / W); const py = H - 3 - y * (H - 6); i ? c.lineTo(i, py) : c.moveTo(i, py); }
    c.stroke();
  };
  const field = (prop, label, lo, hi, fmtf) => {
    const f = h('div', { class: 'slot-f', tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuemin': lo, 'aria-valuemax': hi },
      h('span', { class: 'slot-fl' }, label), h('span', { class: 'slot-fv' }));
    const upd = () => { const t = fmtf(slot[prop]); f.querySelector('.slot-fv').textContent = t; f.setAttribute('aria-valuenow', +slot[prop].toFixed(3)); f.setAttribute('aria-valuetext', t); };
    let dr = null;
    f.addEventListener('pointerdown', (e) => { e.preventDefault(); f.setPointerCapture(e.pointerId); dr = { y: e.clientY, x: e.clientX, v: slot[prop] }; });
    f.addEventListener('pointermove', (e) => { if (!dr) return; const dv = ((dr.y - e.clientY) + (e.clientX - dr.x) * 0.5) / (e.shiftKey ? 800 : 160) * (hi - lo); slot[prop] = Math.max(lo, Math.min(hi, dr.v + dv)); upd(); draw(); slotChanged(slot); });
    f.addEventListener('pointerup', () => { dr = null; }); f.addEventListener('pointercancel', () => { dr = null; });
    f.addEventListener('dblclick', () => { slot[prop] = prop === 'max' || prop === 'end' ? 1 : 0; upd(); draw(); slotChanged(slot); });
    f.addEventListener('keydown', (e) => { const st = (hi - lo) / 50; if (e.key === 'ArrowUp' || e.key === 'ArrowRight') slot[prop] = Math.min(hi, slot[prop] + st); else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') slot[prop] = Math.max(lo, slot[prop] - st); else return; e.preventDefault(); upd(); draw(); slotChanged(slot); });
    upd(); return f;
  };
  const tv = (v) => fmt(slot.target, v);
  const pc = (v) => Math.round(v * 100) + '%';
  const shapeBtn = h('button', { type: 'button', class: 'slot-shape', title: 'Curve shape' });
  const updShape = () => { shapeBtn.textContent = DSP.SLOT_SHAPES[slot.shape | 0]; };
  shapeBtn.addEventListener('click', () => { slot.shape = ((slot.shape | 0) + 1) % 3; updShape(); draw(); slotChanged(slot); }); updShape();
  const top = h('div', { class: 'slot-top' }, name, del);
  const f1 = h('div', { class: 'slot-fields' }, field('min', 'MIN', 0, 1, tv), field('max', 'MAX', 0, 1, tv));
  const f2 = h('div', { class: 'slot-fields adv' }, field('start', 'START', 0, 1, pc), field('end', 'END', 0, 1, pc), field('skew', 'SKEW', -1, 1, (v) => (v > 0 ? '+' : '') + v.toFixed(2)), shapeBtn);
  row.append(top, h('div', { class: 'slot-body' }, h('div', { class: 'slot-cols' }, f1, opts.advanced ? f2 : null), cv));
  draw();
  return row;
}
function mapSlot(sl, s0) {
  let t; const span = sl.end - sl.start;
  if (Math.abs(span) < 1e-6) t = s0 >= sl.start ? 1 : 0; else t = Math.max(0, Math.min(1, (s0 - sl.start) / span));
  if ((sl.shape | 0) === 1) t = t < 0.5 ? t * 2 : 2 - t * 2; else if ((sl.shape | 0) === 2) t = t * t * (3 - 2 * t);
  if (sl.skew) t = Math.pow(t, Math.pow(4, -sl.skew));
  return sl.min + (sl.max - sl.min) * t;
}
function revealParam(key) {
  const unit = DEFS[key].unit;
  const page = unit.startsWith('fx.') ? 'fx' : ['stretch', 'vari', 'stutter', 'bend', 'time'].includes(unit) ? 'time' : unit === 'main' || unit === 'key' ? null : unit === 'perform' ? 'perform' : 'animate';
  if (page) showPage(page);
  const set = widgets.get(key);
  if (set) for (const w of set) if (w.el.isConnected) { w.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); w.el.classList.add('flash'); setTimeout(() => w.el.classList.remove('flash'), 900); break; }
}

// Size a canvas to its CSS box at the display's pixel density and draw in CSS pixels,
// so every visual stays sharp (Retina included) at any panel width.
function fit(cv) {
  const w = cv.clientWidth, hh = cv.clientHeight;
  if (!w || !hh) return null;
  const dpr = Math.min(3, window.devicePixelRatio || 1), W = Math.round(w * dpr), H = Math.round(hh * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, W: w, H: hh };
}
const cssCache = {};
function cssVar(name) { if (!(name in cssCache)) cssCache[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; return cssCache[name]; }

// Pages
const pageHooks = {};
let currentPage = 'time';
function showPage(p) {
  currentPage = p;
  for (const b of $$('.tab')) { const on = b.dataset.page === p; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); }
  for (const el of $$('.page')) el.hidden = el.id !== 'page-' + p;
  if (pageHooks[p]) pageHooks[p]();
  post({ type: 'viz', on: p === 'time' });
  try { localStorage.setItem('debacle.page', p); } catch (e) { /* storage unavailable */ }
}
