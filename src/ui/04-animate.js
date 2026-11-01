// ============================================================================
// DEBACLE UI — ANIMATE (modulators, graphs, sequencers) and PERFORM pages
// ============================================================================

const srcHist = DSP.MOD_SOURCE_IDS.map(() => new Float32Array(160));
let histPos = 0;
on('tick', (t) => { for (let i = 0; i < srcHist.length; i++) srcHist[i][histPos] = t.src[i]; histPos = (histPos + 1) % 160; });

function SlotList(src, advanced) {
  const wrap = h('div', { class: 'slots', id: 'slots-' + src });
  const add = h('button', { type: 'button', class: 'btn add-target' }, '+ TARGET');
  add.addEventListener('click', () => pickTarget(src, (k) => addSlot(src, k)));
  const render = () => {
    wrap.innerHTML = '';
    const list = slotsFrom(src);
    for (const sl of list) wrap.append(SlotRow(sl, { advanced, color: src.startsWith('lfo') || src.startsWith('graph') ? '--mod' : '--accent' }));
    add.disabled = list.length >= SLOT_CAP(src);
    add.textContent = list.length >= SLOT_CAP(src) ? `FULL ${list.length}/${SLOT_CAP(src)}` : `+ TARGET  ${list.length}/${SLOT_CAP(src)}`;
    wrap.append(add);
  };
  on('slots', () => { if (wrap.isConnected) render(); });
  render();
  return wrap;
}

function scopeCanvas(srcIdx, w = 220, hgt = 54) {
  const cv = h('canvas', { class: 'scope', width: w, height: hgt, 'aria-hidden': 'true' });
  scopes.push({ cv, srcIdx });
  return cv;
}
const scopes = [];
function drawScopes() {
  for (const sc of scopes) {
    if (!sc.cv.isConnected || sc.cv.offsetParent === null) continue;
    const c = sc.cv.getContext('2d'), W = sc.cv.width, H = sc.cv.height, hist = srcHist[sc.srcIdx];
    c.clearRect(0, 0, W, H);
    c.strokeStyle = cssVar('--line'); c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, H / 2 + 0.5); c.lineTo(W, H / 2 + 0.5); c.stroke();
    const col = sc.srcIdx < 7 ? cssVar('--mod') : cssVar('--accent');
    c.strokeStyle = col; c.lineWidth = 1.8; c.beginPath();
    for (let i = 0; i < 160; i++) { const v = hist[(histPos + i) % 160]; const x = i / 159 * W, y = H - 3 - v * (H - 6); i ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
    const v = hist[(histPos + 159) % 160];
    c.fillStyle = col; c.beginPath(); c.arc(W - 3, H - 3 - v * (H - 6), 3, 0, Math.PI * 2); c.fill();
  }
}

function buildAnimate(root) {
  const intro = h('p', { class: 'page-intro muted' }, 'Four modulators, three drawn curves and two step sequencers. Every source drives up to six parameters; set MIN and MAX to the range it sweeps. Right-click any knob for a shortcut.');
  const mods = h('div', { class: 'mods' });
  for (let i = 1; i <= 4; i++) {
    const u = 'lfo' + i, src = 'lfo' + i;
    const p = Panel('MOD ' + i, { id: 'src-' + src, cls: 'modcol', tools: [DiceBtn('Dice MOD ' + i, () => diceKeys(unitKeys(u)))] });
    const rate = Knob(u + '.rate'), hz = Knob(u + '.hz', { label: 'RATE' });
    const lfoCtl = h('div', { class: 'kgrid' }, Select(u + '.shape'), rate, hz, Knob(u + '.phase'), Knob(u + '.jitter'), Knob(u + '.smooth'));
    const rndCtl = h('div', { class: 'kgrid' });
    const envCtl = h('div', { class: 'kgrid' }, Segment(u + '.esrc', { labels: ['INTERNAL', 'DRY IN'] }), Knob(u + '.egain'), Knob(u + '.rise'), Knob(u + '.fall'), Knob(u + '.tone'));
    const freeT = Toggle(u + '.free', { autoOn: false }), binT = Toggle(u + '.bin', { autoOn: false, label: 'STEPPED' });
    // simpler: RANDOM uses its own knobs for jitter/smooth
    rndCtl.append(Knob(u + '.jitter'), Knob(u + '.smooth'));
    const syncSimple = () => {
      const mode = Math.round(P[u + '.mode'] * 2), free = P[u + '.free'] >= 0.5;
      if (mode === 1 && rate.parentNode !== rndCtl) { rndCtl.prepend(rate, hz); }
      if (mode === 0 && rate.parentNode !== lfoCtl) { lfoCtl.insertBefore(hz, lfoCtl.children[1]); lfoCtl.insertBefore(rate, hz); }
      lfoCtl.hidden = mode !== 0; rndCtl.hidden = mode !== 1; envCtl.hidden = mode !== 2;
      rate.hidden = free; hz.hidden = !free; freeT.hidden = mode === 2; binT.hidden = mode !== 1;
    };
    onKey(u + '.mode', syncSimple); onKey(u + '.free', syncSimple);
    p.body.append(
      h('div', { class: 'modtop' }, Segment(u + '.mode', { labels: ['LFO', 'RANDOM', 'ENV'] }), freeT, binT),
      scopeCanvas(i - 1), lfoCtl, rndCtl, envCtl, SlotList(src, false));
    mods.append(p.el);
  }
  const graphs = h('div', { class: 'graphs' });
  for (let g = 1; g <= 3; g++) graphs.append(GraphPanel(g));
  const seqs = h('div', { class: 'seqs' }, SeqPanel('stutter'), SeqPanel('stretch'));
  root.append(intro, mods, h('h2', { class: 'section-title' }, 'GRAPHS'), graphs, h('h2', { class: 'section-title' }, 'SEQUENCERS'), seqs);
}

// ---------------------------------------------------------------- graphs ---
const graphEditors = [];
function GraphPanel(g) {
  const src = 'graph' + g, u = 'graph' + g;
  const p = Panel('GRAPH ' + g, { id: 'src-' + src, cls: 'graphcol', tools: [
    h('button', { type: 'button', class: 'icon-btn', title: 'Reset curve', 'aria-label': 'Reset curve', onclick: () => { S.graphs[g - 1] = DSP.DEFAULT_GRAPHS[g - 1].map((q) => ({ ...q })); graphSend(g - 1); } }, '↺'),
    DiceBtn('Random curve', () => { const n = 2 + Math.floor(Math.random() * 6); const pts = []; for (let i = 0; i < n; i++) pts.push({ x: i === 0 ? 0 : Math.random(), y: Math.random(), c: (Math.random() * 2 - 1) * 0.8 }); pts.sort((a, b) => a.x - b.x); S.graphs[g - 1] = pts; graphSend(g - 1); })] });
  const cv = h('canvas', { class: 'graph-cv', width: 520, height: 150, tabindex: 0, 'aria-label': `Graph ${g} curve editor. Click to add a point, drag to move, right-click or double-click a point to delete.` });
  const ed = { cv, g: g - 1, drag: null };
  graphEditors.push(ed);
  const toXY = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]; };
  const hit = (x, y) => { const pts = S.graphs[ed.g], r = cv.getBoundingClientRect(); for (let i = 0; i < pts.length; i++) if (Math.hypot((pts[i].x - x) * r.width, (pts[i].y - y) * r.height) < 11) return i; return -1; };
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    const [x, y] = toXY(e); const pts = S.graphs[ed.g];
    if (e.button === 2) { const i = hit(x, y); if (i >= 0 && pts.length > 2) { pts.splice(i, 1); graphSend(ed.g); } return; }
    let i = hit(x, y);
    if (i < 0) {
      // near the curve between points? → bend handle; else add point
      let seg = pts.length - 1; for (let k = 0; k < pts.length; k++) if (pts[k].x <= x) seg = k;
      const cy = DSP.evalGraph(pts, x);
      if (Math.abs(cy - y) * cv.getBoundingClientRect().height < 10 && !e.shiftKey && e.detail < 2) { ed.drag = { bend: seg, y0: e.clientY, c0: pts[seg].c || 0 }; return; }
      const nx = Math.max(0, Math.min(0.999, x)), ny = clampN(y);
      pts.push({ x: nx, y: ny, c: 0 }); pts.sort((a, b) => a.x - b.x); i = pts.findIndex((q) => q.x === nx && q.y === ny);
      ed.added = pts[i]; // a double click that adds a point must not delete it again
    } else if (e.detail < 2) ed.added = null;
    ed.drag = { i, pt: pts[i] }; graphSend(ed.g);
  });
  cv.addEventListener('pointermove', (e) => {
    const [x, y] = toXY(e); const pts = S.graphs[ed.g];
    if (!ed.drag) { cv.style.cursor = hit(x, y) >= 0 ? 'grab' : 'crosshair'; return; }
    if (ed.drag.bend !== undefined) { pts[ed.drag.bend].c = Math.max(-1, Math.min(1, ed.drag.c0 + (ed.drag.y0 - e.clientY) / 80 * (pts[(ed.drag.bend + 1) % pts.length].y >= pts[ed.drag.bend].y ? -1 : 1))); graphSend(ed.g); return; }
    const pt = ed.drag.pt; pt.x = Math.max(0, Math.min(0.999, x)); pt.y = Math.max(0, Math.min(1, y));
    pts.sort((a, b) => a.x - b.x); graphSend(ed.g);
  });
  const end = () => { ed.drag = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  // double-click / double-tap on a point deletes it (touch screens have no right click)
  cv.addEventListener('dblclick', (e) => { const [x, y] = toXY(e), pts = S.graphs[ed.g], i = hit(x, y); if (i >= 0 && pts.length > 2 && pts[i] !== ed.added) { pts.splice(i, 1); ed.drag = null; graphSend(ed.g); } ed.added = null; });
  p.body.append(cv, h('div', { class: 'kgrid' }, Knob(u + '.len'), Segment(u + '.dir', { labels: ['FWD', 'REV', 'PING'] }), Select(u + '.speed')),
    h('p', { class: 'muted small' }, 'Click to add a point · drag the line to bend it · right-click or double-click a point to delete'),
    SlotList(src, true));
  return p.el;
}
function graphSend(i) { post({ type: 'graph', i, points: S.graphs[i] }); markDirty(); }
function drawGraphs() {
  const t = live.tick;
  for (const ed of graphEditors) {
    const cv = ed.cv; if (!cv.isConnected || cv.offsetParent === null) continue;
    const c = cv.getContext('2d'), W = cv.width, H = cv.height, pts = S.graphs[ed.g];
    c.clearRect(0, 0, W, H);
    c.strokeStyle = cssVar('--line'); c.lineWidth = 1;
    for (let k = 1; k < 8; k++) { const x = Math.round(k / 8 * W) + 0.5; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let k = 1; k < 4; k++) { const y = Math.round(k / 4 * H) + 0.5; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    const pad = 6, ph = H - pad * 2;
    c.beginPath();
    for (let x = 0; x <= W; x += 2) { const y = H - pad - DSP.evalGraph(pts, x / W) * ph; x ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.lineTo(W, H); c.lineTo(0, H); c.closePath();
    c.fillStyle = cssVar('--mod-fill'); c.fill();
    c.beginPath();
    for (let x = 0; x <= W; x += 2) { const y = H - pad - DSP.evalGraph(pts, x / W) * ph; x ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.strokeStyle = cssVar('--mod'); c.lineWidth = 2; c.stroke();
    for (const q of pts) { c.beginPath(); c.arc(q.x * W, H - pad - q.y * ph, 5, 0, Math.PI * 2); c.fillStyle = cssVar('--panel'); c.fill(); c.strokeStyle = cssVar('--fg'); c.lineWidth = 1.5; c.stroke(); }
    if (t) { // playhead from the engine clock
      const v = DEFS['graph' + (ed.g + 1) + '.len']; const len = DSP.normToValue(v.d, P['graph' + (ed.g + 1) + '.len']);
      const sp = [0.25, 0.5, 1, 2, 4][Math.round(P['graph' + (ed.g + 1) + '.speed'] * 4)];
      let x = t.ppq * sp / len; const dir = Math.round(P['graph' + (ed.g + 1) + '.dir'] * 2);
      if (dir === 1) x = 1 - (x - Math.floor(x)); else if (dir === 2) { const q = x / 2 - Math.floor(x / 2); x = q < 0.5 ? q * 2 : 2 - q * 2; } else x -= Math.floor(x);
      c.strokeStyle = cssVar('--accent'); c.lineWidth = 1.5; c.beginPath(); c.moveTo(x * W, 0); c.lineTo(x * W, H); c.stroke();
      const y = H - pad - t.src[4 + ed.g] * ph; c.fillStyle = cssVar('--accent'); c.beginPath(); c.arc(x * W, y, 4, 0, Math.PI * 2); c.fill();
    }
  }
}

// ------------------------------------------------------------ sequencers ---
const seqViews = [];
function SeqPanel(which) {
  const u = which === 'stutter' ? 'sseq' : 'tseq', enable = which === 'stutter' ? 'stutter.seq' : 'stretch.seq';
  const title = which === 'stutter' ? 'STUTTER SEQ' : 'STRETCH SEQ';
  const p = Panel(title, { power: enable, sub: which === 'stutter' ? 'RATE per step · REPS in BEND · off-step = dry' : 'SPEED per step · off-step = dry', cls: 'seqcol' });
  const view = { which, pat: 0, el: null, cells: [] };
  const tabs = h('div', { class: 'seg pat-tabs', role: 'tablist' });
  const stepsEl = h('div', { class: 'steps' });
  for (let i = 0; i < 4; i++) {
    const b = h('button', { type: 'button', role: 'tab' }, 'P' + (i + 1));
    b.addEventListener('click', () => { view.pat = i; renderSteps(); });
    tabs.append(b);
  }
  const valLabel = (v) => which === 'stutter' ? (P['stutter.bend'] >= 0.5 ? (1 + Math.round(v * 31)) + '×' : DSP.TE_SEQ_RATES[Math.round(v * (DSP.TE_SEQ_RATES.length - 1))]) : Math.round(v * 100) + '%';
  const renderSteps = () => {
    $$('button', tabs).forEach((b, i) => { b.classList.toggle('on', i === view.pat); b.setAttribute('aria-selected', i === view.pat ? 'true' : 'false'); b.classList.toggle('inactive', i >= Math.round(DSP.normToValue(DEFS[u + '.chain'].d, P[u + '.chain']))); });
    const steps = S.seq[which][view.pat];
    stepsEl.innerHTML = ''; view.cells = [];
    steps.forEach((st, i) => {
      const fill = h('i', { style: { height: (st.v * 100).toFixed(1) + '%' } });
      const lab = h('span', null, valLabel(st.v));
      const cell = h('div', { class: 'step' + (st.on ? ' on' : '') + (i % 4 === 0 ? ' beat' : ''), role: 'button', tabindex: 0, 'aria-label': `Step ${i + 1}, ${st.on ? 'on' : 'off'}, ${valLabel(st.v)}`, 'aria-pressed': st.on ? 'true' : 'false' }, fill, lab);
      view.cells.push(cell);
      cell.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); st.on = st.on ? 0 : 1; seqSend(which); renderSteps(); } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); st.v = clampN(st.v + (e.key === 'ArrowUp' ? 0.05 : -0.05)); seqSend(which); renderSteps(); view.cells[i].focus(); } });
      stepsEl.append(cell);
    });
  };
  let drag = null;
  stepsEl.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.step'); if (!cell) return;
    e.preventDefault(); stepsEl.setPointerCapture(e.pointerId);
    drag = { i: view.cells.indexOf(cell), y: e.clientY, moved: false };
  });
  stepsEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientY - drag.y) < 5) return;
    drag.moved = true;
    const r = stepsEl.getBoundingClientRect();
    const i = Math.max(0, Math.min(15, Math.floor((e.clientX - r.left) / r.width * 16)));
    const cr = view.cells[i].getBoundingClientRect();
    const v = clampN(1 - (e.clientY - cr.top) / cr.height);
    const st = S.seq[which][view.pat][i]; st.v = v;
    view.cells[i].firstChild.style.height = (v * 100).toFixed(1) + '%'; view.cells[i].lastChild.textContent = valLabel(v);
    setInfo(title + ' · STEP ' + (i + 1), valLabel(v));
    seqSend(which);
  });
  const up = () => { if (drag && !drag.moved && drag.i >= 0) { const st = S.seq[which][view.pat][drag.i]; st.on = st.on ? 0 : 1; seqSend(which); renderSteps(); } drag = null; };
  stepsEl.addEventListener('pointerup', up); stepsEl.addEventListener('pointercancel', () => { drag = null; });
  const tool = (label, fn, title2) => h('button', { type: 'button', class: 'btn ghost sm', title: title2, onclick: () => { fn(S.seq[which][view.pat]); seqSend(which); renderSteps(); } }, label);
  const tools = h('div', { class: 'seq-tools' },
    tool('RND', (s) => s.forEach((x) => { x.on = Math.random() < 0.6 ? 1 : 0; x.v = Math.random(); }), 'Randomize steps'),
    tool('RND VAL', (s) => s.forEach((x) => { x.v = Math.random(); }), 'Randomize values only'),
    tool('FILL', (s) => s.forEach((x) => { x.on = 1; }), 'Turn every step on'),
    tool('INVERT', (s) => s.forEach((x) => { x.on = x.on ? 0 : 1; }), 'Toggle every step'),
    tool('CLEAR', (s) => s.forEach((x) => { x.on = 0; x.v = 0.5; }), 'Clear pattern'),
    tool('COPY →', (s) => { const nx = (view.pat + 1) % 4; S.seq[which][nx] = s.map((x) => ({ ...x })); view.pat = nx; }, 'Copy to the next pattern'));
  onKey(u + '.chain', renderSteps);
  stepsEl.addEventListener('refresh', renderSteps);
  if (which === 'stutter') onKey('stutter.bend', renderSteps);
  p.body.append(h('div', { class: 'seq-top' }, Knob(u + '.rate'), Knob(u + '.chain'), tabs), stepsEl, tools);
  view.el = stepsEl;
  seqViews.push(view);
  renderSteps();
  return p.el;
}
function seqSend(which) { post({ type: 'seq', which, pats: S.seq[which] }); markDirty(); }
on('tick', (t) => {
  if (currentPage !== 'animate') return;
  for (const v of seqViews) {
    const st = v.which === 'stutter' ? t.st : t.sh;
    const idx = st && st.seqIdx !== undefined ? st.seqIdx : -1;
    const pat = Math.floor(idx / 16), cur = idx % 16;
    v.cells.forEach((c, i) => c.classList.toggle('cur', pat === v.pat && i === cur && P[v.which === 'stutter' ? 'stutter.seq' : 'stretch.seq'] >= 0.5));
  }
});

// --------------------------------------------------------------- PERFORM ---
function buildPerform(root) {
  const intro = h('p', { class: 'page-intro muted' }, 'Four macros and an X/Y pad, each driving up to five parameters. A target moves from MIN to MAX while the control travels from START to END. TRI shapes crossfade through three points; SKEW bends the curve. Macro moves are sent to the engine instantly.');
  const macros = h('div', { class: 'macros' });
  for (let i = 1; i <= 4; i++) {
    const p = Panel('MACRO ' + i, { id: 'src-m' + i, cls: 'macrocol' });
    p.body.append(h('div', { class: 'macro-knob' }, Knob('perform.m' + i, { big: true, size: 84, label: 'MACRO ' + i })), SlotList('m' + i, true));
    macros.append(p.el);
  }
  const padP = Panel('X / Y PAD', { id: 'src-x', cls: 'padcol' });
  const pad = h('div', { class: 'xypad', tabindex: 0, role: 'slider', 'aria-label': 'X/Y pad' });
  const cv = h('canvas', { width: 420, height: 420, 'aria-hidden': 'true' });
  pad.append(cv);
  const trail = [];
  const padText = () => { const t = `X ${Math.round(P['perform.x'] * 100)}% · Y ${Math.round(P['perform.y'] * 100)}%`; pad.setAttribute('aria-valuetext', t); return t; };
  const setXY = (e) => { const r = pad.getBoundingClientRect(); const x = clampN((e.clientX - r.left) / r.width), y = clampN(1 - (e.clientY - r.top) / r.height); setP('perform.x', x); setP('perform.y', y); setInfo('PAD', padText()); };
  let dn = false;
  pad.addEventListener('pointerdown', (e) => { e.preventDefault(); dn = true; pad.setPointerCapture(e.pointerId); setXY(e); });
  pad.addEventListener('pointermove', (e) => { if (dn) setXY(e); });
  pad.addEventListener('pointerup', () => { dn = false; }); pad.addEventListener('pointercancel', () => { dn = false; });
  pad.addEventListener('keydown', (e) => { const st = 0.03; let x = P['perform.x'], y = P['perform.y']; if (e.key === 'ArrowLeft') x -= st; else if (e.key === 'ArrowRight') x += st; else if (e.key === 'ArrowUp') y += st; else if (e.key === 'ArrowDown') y -= st; else return; e.preventDefault(); setP('perform.x', x); setP('perform.y', y); setInfo('PAD', padText()); });
  onKey('perform.x', padText); onKey('perform.y', padText);
  padDraw = () => {
    if (!cv.isConnected || cv.offsetParent === null) return;
    const c = cv.getContext('2d'), W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    c.strokeStyle = cssVar('--line'); c.lineWidth = 1;
    for (let k = 1; k < 8; k++) { const q = Math.round(k / 8 * W) + 0.5; c.beginPath(); c.moveTo(q, 0); c.lineTo(q, H); c.moveTo(0, q); c.lineTo(W, q); c.stroke(); }
    const x = P['perform.x'] * W, y = (1 - P['perform.y']) * H;
    trail.push([x, y]); if (trail.length > 40) trail.shift();
    for (let k = 0; k < trail.length; k++) { c.fillStyle = cssVar('--accent-fill'); c.beginPath(); c.arc(trail[k][0], trail[k][1], 2 + k / 6, 0, Math.PI * 2); c.fill(); }
    c.strokeStyle = cssVar('--accent'); c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
    c.fillStyle = cssVar('--accent'); c.beginPath(); c.arc(x, y, 9, 0, Math.PI * 2); c.fill();
  };
  padP.body.append(pad,
    h('div', { class: 'pad-slots' },
      h('div', null, h('h3', { class: 'mini-title' }, 'X →'), SlotList('x', true)),
      h('div', { id: 'src-y' }, h('h3', { class: 'mini-title' }, 'Y ↑'), SlotList('y', true))));
  root.append(intro, h('div', { class: 'perform-grid' }, macros, padP.el));
}
let padDraw = () => {};
