// ============================================================================
// DEBACLE UI — TIME and FX pages
// ============================================================================

const changeHooks = new Map(); // key -> [fn]
function onKey(key, fn) { if (!changeHooks.has(key)) changeHooks.set(key, []); changeHooks.get(key).push(fn); fn(); }
on('change', (k) => { const l = changeHooks.get(k); if (l) for (const fn of l) fn(); });

function unitKeys(prefix) { return Object.keys(DEFS).filter((k) => k.startsWith(prefix + '.')); }
function diceKeys(keys, amount = 1) {
  let changed = 0;
  for (const k of keys) {
    const st = S.dice[k] ?? defaultDice(k);
    if (st <= 0 || slotsFor(k).length) continue;
    const d = DEFS[k].d;
    let n;
    if (d.kind === 'toggle') { if (Math.random() > st * 0.35) continue; n = P[k] >= 0.5 ? 0 : 1; }
    else if (d.kind === 'enum' || d.kind === 'div') { if (Math.random() > st * 0.8) continue; const c = d.options.length; n = c > 1 ? Math.floor(Math.random() * c) / (c - 1) : 0; }
    else n = P[k] + (Math.random() - P[k]) * st * amount;
    setP(k, n); changed++;
  }
  return changed;
}
function DiceBtn(title, fn) {
  const b = h('button', { type: 'button', class: 'icon-btn dice', title, 'aria-label': title }, diceIcon());
  b.addEventListener('click', () => { fn(); b.classList.remove('roll'); void b.offsetWidth; b.classList.add('roll'); });
  return b;
}
function diceIcon() {
  const svg = s('svg', { viewBox: '0 0 20 20', width: 16, height: 16, 'aria-hidden': 'true' });
  svg.append(s('rect', { x: 2.5, y: 2.5, width: 15, height: 15, rx: 3.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }));
  for (const [x, y] of [[7, 7], [13, 13], [10, 10], [13, 7], [7, 13]]) svg.append(s('circle', { cx: x, cy: y, r: 1.3, fill: 'currentColor' }));
  return svg;
}
function GearBtn(title, keys) {
  const b = h('button', { type: 'button', class: 'icon-btn', title, 'aria-label': title }, '⚙');
  b.addEventListener('click', () => diceSetup(title, keys(), b));
  return b;
}
// Random setup: per-parameter dice strength (0 = locked)
function diceSetup(title, keys, anchor) {
  const items = keys.filter((k) => DEFS[k].d.id !== 'on').map((k) => {
    const st = S.dice[k] ?? defaultDice(k);
    const r = h('input', { type: 'range', min: 0, max: 100, value: Math.round(st * 100), 'aria-label': DEFS[k].d.label + ' dice strength' });
    const lab = h('span', { class: 'menu-hint' }, st === 0 ? 'locked' : Math.round(st * 100) + '%');
    r.addEventListener('input', () => { S.dice[k] = +r.value / 100; lab.textContent = +r.value === 0 ? 'locked' : r.value + '%'; markDirty(); });
    return { node: h('div', { class: 'menu-range named' }, h('span', { class: 'mr-name' }, DEFS[k].d.label), r, lab) };
  });
  const rc = anchor.getBoundingClientRect();
  menu([{ sep: 'Dice strength per parameter · 0 = locked' }, ...items], rc.left - 120, rc.bottom + 4, { title: title });
}

function Panel(title, opts = {}) {
  const head = h('div', { class: 'panel-head' },
    opts.power ? Power(opts.power, title) : null,
    h('h2', { class: 'panel-title' }, title),
    opts.sub ? h('span', { class: 'panel-sub' }, opts.sub) : null,
    h('div', { class: 'panel-tools' }, ...(opts.tools || [])));
  const body = h('div', { class: 'panel-body' });
  const el = h('section', { class: 'panel' + (opts.cls ? ' ' + opts.cls : ''), id: opts.id }, head, body);
  if (opts.power) onKey(opts.power, () => el.classList.toggle('is-off', P[opts.power] < 0.5));
  return { el, body, head };
}
const grid = (...kids) => h('div', { class: 'kgrid' }, ...kids);
const row = (...kids) => h('div', { class: 'trow' }, ...kids);
function showIf(el, keyList, pred) { const upd = () => { el.hidden = !pred(); }; for (const k of keyList) onKey(k, upd); return el; }

// ------------------------------------------------------------------ TIME ---
function buildTime(root) {
  const routing = h('div', { class: 'routing' },
    h('span', { class: 'lbl' }, 'ENGINE ORDER'),
    Segment('time.order', { labels: ['STRETCH › VARI › STUTTER', 'VARI › STRETCH › STUTTER', 'STUTTER › STRETCH › VARI', 'PARALLEL'], cls: 'wide' }),
    h('span', { class: 'muted small hide-sm' }, 'Engines feed the FX chain, then MAIN. Click any knob of a sleeping engine to wake it.'));

  // STRETCH
  const st = Panel('STRETCH', { power: 'stretch.on', sub: 'dual-grain stretch / freeze', id: 'eng-stretch', tools: [DiceBtn('Dice STRETCH', () => diceKeys(unitKeys('stretch'))), GearBtn('STRETCH dice setup', () => unitKeys('stretch'))] });
  const stViz = h('canvas', { class: 'viz', id: 'viz-stretch', width: 360, height: 70, 'aria-hidden': 'true' });
  const grainSync = Knob('stretch.grain'), grainFree = Knob('stretch.grain_hz', { label: 'GRAIN' });
  showIf(grainSync, ['stretch.sync'], () => P['stretch.sync'] >= 0.5); showIf(grainFree, ['stretch.sync'], () => P['stretch.sync'] < 0.5);
  st.body.append(stViz,
    h('div', { class: 'hero-row' }, Knob('stretch.speed', { big: true }), grid(Knob('stretch.tempo'), grainSync, grainFree, Knob('stretch.pitch'), Knob('stretch.spread'), Knob('stretch.scatter'), Knob('stretch.mix'))),
    row(Toggle('stretch.freeze', { cls: 'accent' }), Toggle('stretch.rev'), Toggle('stretch.sync'), Toggle('stretch.link'), Toggle('stretch.seq', { label: 'SEQ' })));

  // VARISPEED
  const vr = Panel('VARISPEED', { power: 'vari.on', sub: 'tape machine', id: 'eng-vari', tools: [DiceBtn('Dice VARISPEED', () => diceKeys(unitKeys('vari'))), GearBtn('VARISPEED dice setup', () => unitKeys('vari'))] });
  const vrViz = h('canvas', { class: 'viz', id: 'viz-vari', width: 360, height: 70, 'aria-hidden': 'true' });
  const scratch = Knob('vari.scratch', { spring: true });
  springKnob(scratch, 'vari.scratch');
  vr.body.append(vrViz,
    h('div', { class: 'hero-row' }, Knob('vari.speed', { big: true }), grid(Knob('vari.tempo'), Knob('vari.wow'), scratch, Knob('vari.sat'), Knob('vari.comp'), Knob('vari.mix'))),
    row(Segment('vari.mode', { labels: ['FWD', 'FWD-REV', 'REV'] }), Segment('vari.dist'), Toggle('vari.stop', { momentary: true, cls: 'stop-btn', label: 'HOLD TO STOP' })));

  // STUTTER / BENDIT
  const su = Panel('STUTTER', { power: 'stutter.on', sub: 'capture & repeat', id: 'eng-stutter', tools: [DiceBtn('Dice STUTTER', () => diceKeys(P['stutter.bend'] >= 0.5 ? unitKeys('bend') : unitKeys('stutter'))), GearBtn('STUTTER dice setup', () => P['stutter.bend'] >= 0.5 ? unitKeys('bend') : unitKeys('stutter'))] });
  onKey('stutter.bend', () => { su.head.querySelector('.panel-title').textContent = P['stutter.bend'] >= 0.5 ? 'BENDIT' : 'STUTTER'; su.head.querySelector('.panel-sub').textContent = P['stutter.bend'] >= 0.5 ? 'circuit-bent buffer' : 'capture & repeat'; su.el.classList.toggle('bent', P['stutter.bend'] >= 0.5); });
  const suViz = h('canvas', { class: 'viz', id: 'viz-stutter', width: 360, height: 70, 'aria-hidden': 'true' });
  const rateSync = Knob('stutter.rate'), rateMs = Knob('stutter.rate_ms', { label: 'RATE' }), rateLink = Knob('stutter.lpreset', { label: 'LINK RATE' });
  const vis = () => { const link = P['stutter.link'] >= 0.5, sync = P['stutter.sync'] >= 0.5; rateLink.hidden = !link; rateSync.hidden = link || !sync; rateMs.hidden = link || sync; capK.hidden = link; };
  const capK = Knob('stutter.capture');
  const normal = h('div', { class: 'mode-stutter' },
    h('div', { class: 'hero-row' }, h('div', { class: 'hero-stack' }, rateSync, rateMs, rateLink), grid(capK, Knob('stutter.pitch'), Knob('stutter.ramp'), Knob('stutter.gate'), Knob('stutter.decay'), Knob('stutter.pan'), Knob('stutter.prob'), Knob('stutter.retrig'), Knob('stutter.smooth'), Knob('stutter.mix'))),
    row(Select('stutter.pattern'), Segment('stutter.gcurve', { labels: ['LIN', 'LOG', 'EXP'] }), Toggle('stutter.rev'), Toggle('stutter.sync'), Toggle('stutter.link')));
  ['stutter.link', 'stutter.sync'].forEach((k) => onKey(k, vis));
  const tSync = Knob('bend.time'), tMs = Knob('bend.time_ms', { label: 'TIME' });
  showIf(tSync, ['bend.tsync'], () => P['bend.tsync'] >= 0.5); showIf(tMs, ['bend.tsync'], () => P['bend.tsync'] < 0.5);
  const warpK = Knob('bend.warp', { big: true }), brkK = Knob('bend.brk', { big: true });
  const warpZ = h('div', { class: 'zone' }), brkZ = h('div', { class: 'zone' });
  onKey('bend.warp', () => { warpZ.textContent = DSP.WARP_ZONES[DSP.zoneOf(DSP.WARP_ZONES, P['bend.warp'])][2]; });
  onKey('bend.brk', () => { brkZ.textContent = DSP.BREAK_ZONES[DSP.zoneOf(DSP.BREAK_ZONES, P['bend.brk'])][2]; });
  const bent = h('div', { class: 'mode-bend' },
    h('div', { class: 'hero-row' }, h('div', { class: 'hero-stack' }, warpK, warpZ), h('div', { class: 'hero-stack' }, brkK, brkZ),
      grid(Knob('bend.reps'), tSync, tMs, Knob('stutter.capture'), Knob('bend.width'), Knob('bend.window'), Knob('bend.duck'), Knob('stutter.mix'))),
    row(Toggle('bend.tsync', { label: 'SYNC' }), Toggle('bend.freeze', { cls: 'accent' })));
  onKey('stutter.bend', () => { normal.hidden = P['stutter.bend'] >= 0.5; bent.hidden = P['stutter.bend'] < 0.5; });
  su.body.append(suViz, normal, bent, row(Toggle('stutter.bend', { label: 'BEND', cls: 'accent' }), Toggle('stutter.seq', { label: 'SEQ' }), h('span', { class: 'muted small' }, 'BEND turns the slicer into a circuit-bent buffer mangler.')));

  root.append(routing, h('div', { class: 'engines' }, st.el, vr.el, su.el));
}

// make a knob spring back to its default on release (scratch wheel)
function springKnob(el, key) {
  const back = () => {
    const d = DEFS[key].d, from = P[key], t0 = performance.now();
    const step = (t) => { const u = Math.min(1, (t - t0) / 220); setP(key, from + (d.defN - from) * (1 - Math.pow(1 - u, 3)), { quiet: true }); if (u < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };
  el.addEventListener('pointerup', back); el.addEventListener('pointercancel', back);
}

// -------------------------------------------------------------------- FX ---
function buildFx(root) {
  const lib = h('aside', { class: 'fx-lib', 'aria-label': 'Effect library' });
  const libHead = h('div', { class: 'fx-lib-head' }, h('h2', { class: 'panel-title' }, 'LIBRARY'), h('span', { class: 'muted small', id: 'fx-count' }));
  const libSearch = h('input', { type: 'search', class: 'tp-search', placeholder: 'Find an effect…', 'aria-label': 'Find an effect' });
  const libList = h('div', { class: 'fx-lib-list' });
  lib.append(libHead, libSearch, libList);
  const renderLib = () => {
    libList.innerHTML = '';
    const q = libSearch.value.trim().toLowerCase();
    let total = 0;
    for (const cat of FX_CATS) {
      const items = Object.values(FXMETA).filter((m) => m.cat === cat && (!q || (m.label + ' ' + m.desc + ' ' + cat).toLowerCase().includes(q)));
      if (!items.length) continue;
      total += items.length;
      const det = h('details', { class: 'fx-cat', open: true, style: { '--cat': `var(--c-${cat.toLowerCase()})` } }, h('summary', null, h('span', { class: 'cat-dot' }), cat, h('span', { class: 'muted small' }, items.length)));
      for (const m of items) {
        const inChain = S.chain.includes(m.id);
        const b = h('button', { type: 'button', class: 'fx-lib-item' + (inChain ? ' in' : ''), draggable: 'true', title: m.desc }, h('span', { class: 'fx-lib-name' }, m.label), h('span', { class: 'fx-lib-desc' }, m.desc), m.latency ? h('span', { class: 'lat' }, 'FFT') : null);
        b.addEventListener('click', () => { if (S.chain.includes(m.id)) revealCard(m.id); else addFx(m.id); });
        b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'add:' + m.id); e.dataTransfer.effectAllowed = 'copyMove'; });
        det.append(b);
      }
      libList.append(det);
    }
    $('#fx-count', lib).textContent = `${Object.keys(FXMETA).length} effects`;
    if (!total) libList.append(h('p', { class: 'muted small' }, 'No effect matches that search.'));
  };
  libSearch.addEventListener('input', renderLib);
  on('chain', renderLib);

  const chainEl = h('div', { class: 'fx-chain', id: 'fx-chain' });
  const toolbar = h('div', { class: 'fx-toolbar' },
    h('h2', { class: 'panel-title' }, 'CHAIN'),
    Segment('chain.mode', { labels: ['SERIAL', 'PARALLEL'] }),
    h('span', { class: 'muted small', id: 'chain-info' }),
    h('div', { class: 'panel-tools' },
      DiceBtn('Dice every effect in the chain', () => { for (const id of S.chain) diceKeys(FXMETA[id].params.map((d) => 'fx.' + id + '.' + d.id)); }),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { if (!S.chain.length) return; clearChainConfirm(); } }, 'CLEAR')));
  const empty = h('div', { class: 'fx-empty' }, h('p', null, 'The chain is empty. Pick effects from the library; they run top to bottom (or side by side in PARALLEL). Drag cards to reorder.'));
  chainEl.addEventListener('dragover', (e) => { e.preventDefault(); const at = dropIndex(chainEl, e.clientX, e.clientY); markDrop(chainEl, at); });
  chainEl.addEventListener('dragleave', (e) => { if (!chainEl.contains(e.relatedTarget)) markDrop(chainEl, -1); });
  chainEl.addEventListener('drop', (e) => {
    e.preventDefault(); const data = e.dataTransfer.getData('text/plain'); const at = dropIndex(chainEl, e.clientX, e.clientY); markDrop(chainEl, -1);
    if (data.startsWith('add:')) { const id = data.slice(4); if (!S.chain.includes(id)) addFx(id, at); }
    else if (data.startsWith('move:')) { moveFx(data.slice(5), at); }
  });
  const main = h('div', { class: 'fx-main' }, toolbar, empty, chainEl);
  root.append(h('div', { class: 'fx-layout' }, lib, main));
  const renderChain = () => {
    chainEl.innerHTML = '';
    empty.hidden = S.chain.length > 0;
    for (const id of S.chain) chainEl.append(FxCard(id));
    const lat = S.chain.reduce((a, id) => a + (P['fx.' + id + '.on'] >= 0.5 ? FXMETA[id].latency : 0), 0);
    $('#chain-info').textContent = S.chain.length ? `${S.chain.length} in chain${lat ? ` · +${lat} samples FFT latency` : ''}` : '';
  };
  on('chain', renderChain);
  renderLib(); renderChain();
}
function clearChainConfirm() {
  const btn = $('.fx-toolbar .btn.ghost');
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = 'CLEAR'; S.chain = []; chainChanged(); return; }
  btn.dataset.armed = '1'; btn.textContent = 'CLEAR ALL?';
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = 'CLEAR'; } }, 2500);
}
function dropIndex(chainEl, x, y) {
  const cards = $$('.fx-card', chainEl);
  for (let i = 0; i < cards.length; i++) { const r = cards[i].getBoundingClientRect(); if (y < r.top + r.height / 2 && (x < r.right || y < r.top)) return i; if (y < r.bottom && x < r.left + r.width / 2) return i; }
  return cards.length;
}
function markDrop(chainEl, at) { $$('.fx-card', chainEl).forEach((c, i) => c.classList.toggle('drop-before', i === at)); chainEl.classList.toggle('drop-end', at === $$('.fx-card', chainEl).length); }
function chainChanged() { post({ type: 'chain', ids: S.chain }); emit('chain'); markDirty(); }
function addFx(id, at) {
  if (S.chain.includes(id)) return;
  if (at === undefined || at < 0 || at > S.chain.length) S.chain.push(id); else S.chain.splice(at, 0, id);
  setP('fx.' + id + '.on', 1);
  chainChanged();
  requestAnimationFrame(() => revealCard(id));
}
function removeFx(id) {
  S.chain = S.chain.filter((x) => x !== id);
  // drop modulation pointing at a removed effect
  const before = S.slots.length; S.slots = S.slots.filter((sl) => !sl.target.startsWith('fx.' + id + '.'));
  if (S.slots.length !== before) sendSlots();
  chainChanged();
}
function moveFx(id, at) {
  const from = S.chain.indexOf(id); if (from < 0) return;
  S.chain.splice(from, 1); if (at > from) at--; S.chain.splice(Math.max(0, Math.min(S.chain.length, at)), 0, id);
  chainChanged();
}
function revealCard(id) { const c = document.getElementById('fx-' + id); if (c) { showPage('fx'); c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 800); } }

const fxMeters = new Map();
function FxCard(id) {
  const m = FXMETA[id];
  const keys = m.params.map((d) => 'fx.' + id + '.' + d.id);
  const meter = h('div', { class: 'fx-meter', 'aria-hidden': 'true' }, h('i'));
  fxMeters.set(id, meter);
  const handle = h('span', { class: 'drag-handle', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⠿');
  const idx = S.chain.indexOf(id);
  const head = h('div', { class: 'fx-head', draggable: 'true' },
    handle, Power('fx.' + id + '.on', m.label), h('h3', { class: 'fx-name' }, m.label), h('span', { class: 'cat-chip' }, m.cat),
    m.latency ? h('span', { class: 'lat', title: `Adds ${m.latency} samples latency` }, 'FFT') : null, meter,
    h('div', { class: 'panel-tools' },
      DiceBtn('Dice ' + m.label, () => diceKeys(keys)),
      GearBtn(m.label + ' dice setup', () => keys),
      h('button', { type: 'button', class: 'icon-btn', title: 'Move up', 'aria-label': 'Move ' + m.label + ' earlier', disabled: idx === 0, onclick: () => moveFx(id, idx - 1) }, '↑'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Move down', 'aria-label': 'Move ' + m.label + ' later', disabled: idx === S.chain.length - 1, onclick: () => moveFx(id, idx + 2) }, '↓'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Remove from chain', 'aria-label': 'Remove ' + m.label, onclick: () => removeFx(id) }, '×')));
  head.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'move:' + id); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
  head.addEventListener('dragend', () => card.classList.remove('dragging'));
  const own = keys.slice(3).map((k) => Ctl(k));
  // effects with a SYNC toggle: show either the tempo divisions or the free rate/time
  const syncKey = 'fx.' + id + '.sync';
  if (DEFS[syncKey] && DEFS[syncKey].d.kind === 'toggle') {
    const freeIds = ['rate', 'ms', 'hz'];
    const upd = () => {
      const on = P[syncKey] >= 0.5;
      keys.slice(3).forEach((k, i) => {
        const d = DEFS[k].d;
        if (d.kind === 'div') own[i].hidden = !on;
        else if (d.kind === 'num' && freeIds.includes(d.id) && keys.some((q) => DEFS[q].d.kind === 'div')) own[i].hidden = on;
      });
    };
    onKey(syncKey, upd);
  }
  const body = h('div', { class: 'fx-body' }, h('div', { class: 'kgrid' }, ...own), h('div', { class: 'fx-host' }, Knob('fx.' + id + '.mix'), Knob('fx.' + id + '.gain')));
  const card = h('article', { class: 'fx-card', id: 'fx-' + id, style: { '--cat': `var(--c-${m.cat.toLowerCase()})` } }, head, h('p', { class: 'fx-desc' }, m.desc), body);
  onKey('fx.' + id + '.on', () => card.classList.toggle('is-off', P['fx.' + id + '.on'] < 0.5));
  return card;
}
on('tick', (t) => {
  if (currentPage !== 'fx') return;
  for (const [id, el] of fxMeters) {
    if (!el.isConnected) { fxMeters.delete(id); continue; }
    const f = t.fx[id];
    const lv = f ? Math.min(1, Math.sqrt(f[0]) * 1.4) : 0;
    el.firstChild.style.transform = `scaleX(${lv.toFixed(3)})`;
    el.classList.toggle('err', !!(f && f[2]));
    if (f && f[2]) el.title = 'Effect error: ' + f[2];
  }
});
