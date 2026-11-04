// ============================================================================
// DEBACLE UI — app shell: header, presets, MAIN row, visuals, boot
// ============================================================================

// ---------------------------------------------------------------- presets --
function snapshot() {
  const p = {};
  for (const [k, n] of Object.entries(P)) if (Math.abs(n - DEFS[k].d.defN) > 1e-6) p[k] = +n.toFixed(5);
  return { v: 1, p, chain: S.chain.slice(), slots: S.slots.map((x) => ({ ...x })), graphs: S.graphs.map((g) => g.map((q) => ({ ...q }))), seq: JSON.parse(JSON.stringify(S.seq)), dice: { ...S.dice } };
}
// Presets come from storage, the clipboard or files: rebuild every part with sane types so a
// damaged preset cannot leave NaN parameters or a sequencer / graph the engine cannot read.
const finiteOr = (x, d) => { x = +x; return Number.isFinite(x) ? x : d; };
function cleanSlots(list) {
  const out = [], seen = new Set(), count = {};
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || !DEFS[x.target] || !SRC_INFO[x.src] || seen.has(x.src + '>' + x.target)) continue;
    if ((count[x.src] = (count[x.src] || 0) + 1) > SLOT_CAP(x.src)) continue;
    seen.add(x.src + '>' + x.target);
    out.push({ src: x.src, target: x.target, min: clampN(finiteOr(x.min, 0)), max: clampN(finiteOr(x.max, 1)), start: clampN(finiteOr(x.start, 0)), end: clampN(finiteOr(x.end, 1)),
      skew: Math.max(-1, Math.min(1, finiteOr(x.skew, 0))), shape: Math.max(0, Math.min(2, finiteOr(x.shape, 0) | 0)) });
  }
  return out;
}
function cleanGraphs(g) {
  return DSP.DEFAULT_GRAPHS.map((def, i) => {
    const src = Array.isArray(g) && Array.isArray(g[i]) ? g[i] : [];
    const pts = src.filter((q) => q && Number.isFinite(+q.x) && Number.isFinite(+q.y))
      .map((q) => ({ x: Math.max(0, Math.min(0.999, +q.x)), y: clampN(+q.y), c: Math.max(-1, Math.min(1, finiteOr(q.c, 0))) })).sort((a, b) => a.x - b.x);
    return pts.length >= 2 ? pts : def.map((q) => ({ ...q }));
  });
}
function cleanSeq(seq) {
  const out = {};
  for (const w of ['stutter', 'stretch']) {
    const src = seq && Array.isArray(seq[w]) ? seq[w] : [];
    out[w] = DSP.defaultSeq(w).map((pat, p) => pat.map((d, k) => { const st = Array.isArray(src[p]) ? src[p][k] : null; return st ? { on: st.on ? 1 : 0, v: clampN(finiteOr(st.v, 0.5)) } : d; }));
  }
  return out;
}
function applyState(st) {
  st = st && typeof st === 'object' ? st : {};
  for (const k of Object.keys(P)) P[k] = DEFS[k].d.defN;
  for (const [k, n] of Object.entries(st.p || {})) if (k in P && Number.isFinite(+n)) P[k] = clampN(+n);
  S.chain = [...new Set((Array.isArray(st.chain) ? st.chain : []).filter((id) => FXMETA[id]))];
  S.slots = cleanSlots(st.slots);
  S.graphs = cleanGraphs(st.graphs);
  S.seq = cleanSeq(st.seq);
  S.dice = {};
  for (const [k, v] of Object.entries(st.dice || {})) if (DEFS[k] && Number.isFinite(+v)) S.dice[k] = clampN(+v);
  if (AUDIO.started) sendAll();
  refreshAllWidgets();
  for (const k of Object.keys(P)) runKeyHooks(k);
  emit('chain'); emit('slots');
  for (const v of seqViews) v.el && v.el.isConnected && v.el.dispatchEvent(new Event('refresh'));
}
// Build a preset from real values: { 'vari.speed': 40, ... } (value units, enum labels or indices)
function P_(vals, extra = {}) {
  const p = {};
  for (const [k, v] of Object.entries(vals)) {
    const m = DEFS[k]; if (!m) { PRESET_WARNINGS.push('unknown param ' + k); continue; }
    const d = m.d;
    if ((d.kind === 'enum' || d.kind === 'div') && typeof v === 'string' && d.options.indexOf(v) < 0) PRESET_WARNINGS.push(`unknown option ${k}=${v}`);
    if (d.kind === 'num' && (v < d.min || v > d.max)) PRESET_WARNINGS.push(`out of range ${k}=${v} (${d.min}..${d.max})`);
    if (d.kind === 'enum' || d.kind === 'div') p[k] = DSP.valueToNorm(d, typeof v === 'string' ? d.options.indexOf(v) : v);
    else if (d.kind === 'toggle') p[k] = v ? 1 : 0;
    else p[k] = DSP.valueToNorm(d, v);
    if (d.kind === 'div' && typeof v === 'string') p[k] = d.options.length > 1 ? Math.max(0, d.options.indexOf(v)) / (d.options.length - 1) : 0;
  }
  return Object.assign({ v: 1, p, chain: [], slots: [] }, extra);
}
const PRESET_WARNINGS = [];
const slot = (src, target, lo, hi, more = {}) => {
  const m = DEFS[target]; if (!m) { PRESET_WARNINGS.push('unknown slot target ' + target); return null; }
  const n = (v) => (typeof v === 'string' ? DSP.valueToNorm(m.d, m.d.options.indexOf(v)) : DSP.valueToNorm(m.d, v));
  return { src, target, min: n(lo), max: n(hi), start: 0, end: 1, skew: 0, shape: 0, ...more };
};
const FACTORY = [];
function factory(name, cat, st) { for (const id of st.chain || []) if (!FXMETA[id]) PRESET_WARNINGS.push('unknown fx ' + id); st.slots = (st.slots || []).filter(Boolean); st.chain = (st.chain || []).filter((id) => FXMETA[id]); FACTORY.push({ name, cat, st }); }

function userPresets() { try { return JSON.parse(localStorage.getItem('debacle.presets') || '[]'); } catch (e) { return []; } }
function saveUserPresets(list) { try { localStorage.setItem('debacle.presets', JSON.stringify(list)); return true; } catch (e) { return false; } }
let presetIdx = 0, presetName = 'INIT';
function allPresets() { return [...FACTORY.map((f) => ({ ...f, user: false })), ...userPresets().map((u) => ({ name: u.name, cat: 'USER', st: u.st, user: true }))]; }
function loadPreset(i) {
  const list = allPresets(); if (!list.length) return;
  presetIdx = ((i % list.length) + list.length) % list.length;
  const pr = list[presetIdx];
  applyState(pr.st);
  presetName = pr.name; dirty = false; emit('dirty', false);
  updatePresetLabel();
  if (pr.st.bpmHint && AUDIO.current !== 'file') { /* demo loops carry their own tempo */ }
  if (pr.st.loop && AUDIO.current !== pr.st.loop && AUDIO.current !== 'file' && AUDIO.current !== 'print') loadDemo(pr.st.loop, true);
}
function updatePresetLabel() {
  $('#preset-name').textContent = presetName;
  $('#preset-dirty').hidden = !dirty;
}
on('dirty', updatePresetLabel);
function presetMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const list = allPresets();
  const items = [];
  let lastCat = '';
  list.forEach((pr, i) => {
    if (pr.cat !== lastCat) { items.push({ sep: pr.cat }); lastCat = pr.cat; }
    items.push({ label: pr.name, checked: i === presetIdx && !dirty, act: () => loadPreset(i) });
  });
  items.push({ sep: 'Manage' });
  items.push({ label: 'Save as user preset…', act: () => savePresetDialog() });
  items.push({ label: 'Copy preset to clipboard', act: () => copyPreset() });
  items.push({ label: 'Import preset (paste or file)…', act: () => importDialog() });
  if (list[presetIdx] && list[presetIdx].user) items.push({ label: 'Delete “' + list[presetIdx].name + '”', danger: true, act: () => { const u = userPresets(); const k = presetIdx - FACTORY.length; u.splice(k, 1); saveUserPresets(u); toast('Preset deleted.'); presetIdx = 0; dirty = true; updatePresetLabel(); } });
  menu(items, r.left, r.bottom + 4, { title: 'PRESETS', cols: list.length > 18 ? 2 : 1 });
}
function dialog(title, bodyNodes, actions) {
  const wrap = h('div', { class: 'modal-wrap' });
  const close = () => { wrap.remove(); document.removeEventListener('keydown', esc, true); };
  const esc = (e) => { if (e.key === 'Escape') { close(); e.stopPropagation(); } };
  const foot = h('div', { class: 'modal-foot' }, ...actions.map(([label, fn, cls]) => h('button', { type: 'button', class: 'btn ' + (cls || ''), onclick: () => { if (fn() !== false) close(); } }, label)));
  const dlg = h('div', { class: 'modal small', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×')), ...bodyNodes, foot);
  wrap.append(dlg); wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', esc, true); document.body.append(wrap);
  const f = dlg.querySelector('input,textarea'); if (f) f.focus();
  return close;
}
function savePresetDialog() {
  const inp = h('input', { type: 'text', class: 'tp-search', id: 'preset-save-name', value: dirty ? presetName + ' 2' : presetName, maxlength: 32, 'aria-label': 'Preset name' });
  dialog('Save preset', [h('p', { class: 'muted small' }, 'User presets live in this browser only. Copy a preset to the clipboard to move it elsewhere.'), inp], [
    ['Cancel', () => true, 'ghost'],
    ['Save', () => {
      const name = inp.value.trim().toUpperCase() || 'UNTITLED';
      const u = userPresets(); const ex = u.findIndex((x) => x.name === name);
      const entry = { name, st: snapshot() };
      if (ex >= 0) u[ex] = entry; else u.push(entry);
      if (!saveUserPresets(u)) { toast('This browser blocks storage here. Use “Copy preset to clipboard” instead.'); return false; }
      presetName = name; presetIdx = FACTORY.length + (ex >= 0 ? ex : u.length - 1); dirty = false; emit('dirty', false); toast('Saved “' + name + '”.');
      return true;
    }, 'primary']]);
}
async function copyPreset() {
  const txt = JSON.stringify({ name: presetName, debacle: snapshot() });
  try { await navigator.clipboard.writeText(txt); toast('Preset copied to the clipboard.'); }
  catch (e) {
    const ta = h('textarea', { class: 'tp-search code', rows: 6, readonly: true }, txt);
    dialog('Copy this preset', [h('p', { class: 'muted small' }, 'Clipboard access is blocked here. Select the text and copy it.'), ta], [['Done', () => true, 'primary']]);
    ta.select();
  }
}
function importDialog() {
  const ta = h('textarea', { class: 'tp-search code', rows: 6, placeholder: 'Paste preset JSON here', 'aria-label': 'Preset JSON' });
  const file = h('input', { type: 'file', accept: '.json,application/json,text/plain', 'aria-label': 'Preset file' });
  file.addEventListener('change', async () => { if (file.files[0]) ta.value = await file.files[0].text(); });
  dialog('Import preset', [ta, file], [['Cancel', () => true, 'ghost'], ['Import', () => {
    try { const o = JSON.parse(ta.value); const st = o.debacle || o.st || o; applyState(st); presetName = (o.name || 'IMPORTED').toUpperCase(); dirty = true; updatePresetLabel(); toast('Preset imported.'); return true; }
    catch (e) { toast('That is not a DEBACLE preset. Check the pasted text.'); return false; }
  }, 'primary']]);
}

// ------------------------------------------------------------------ header -
function buildHeader() {
  // sources
  const srcBox = $('#sources');
  for (const d of DEMO_LOOPS) {
    const b = h('button', { type: 'button', class: 'src-btn' + (d.id === 'break' ? ' on' : ''), 'data-src': d.id, title: d.desc + ' · ' + d.bpm + ' BPM' }, d.name);
    b.addEventListener('click', async () => { await startAudio(); loadDemo(d.id); if (!live.playing) togglePlay(true); });
    srcBox.append(b);
  }
  const fileIn = h('input', { type: 'file', accept: 'audio/*', id: 'file-in', hidden: true });
  fileIn.addEventListener('change', () => { loadFile(fileIn.files[0]); fileIn.value = ''; });
  srcBox.append(fileIn, h('button', { type: 'button', class: 'src-btn', title: 'Load an audio file (or drop one anywhere)', onclick: () => fileIn.click() }, 'LOAD…'));
  $('#mic-btn').addEventListener('click', toggleMic);
  $('#print-btn').addEventListener('click', printLoop);
  $('#play').addEventListener('click', () => togglePlay());
  const bpm = $('#bpm');
  bpm.addEventListener('change', () => { const v = parseFloat(bpm.value); if (v > 0) setBpm(v); bpm.value = (Math.round(S.bpm * 10) / 10).toString(); });
  $('#tap').addEventListener('click', tapTempo);
  // key
  $('#keybox').append(Select('key.root', { label: 'ROOT' }), Select('key.scale', { label: 'SCALE' }), Select('key.chord', { label: 'CHORD' }), Select('key.csize', { label: 'VOICING' }));
  // dice
  $('#dicebox').append(
    h('div', { class: 'dice-g' }, DiceBtn('Dice the time engines', () => diceKeys([...unitKeys('stretch'), ...unitKeys('vari'), ...(P['stutter.bend'] >= 0.5 ? unitKeys('bend') : unitKeys('stutter'))])), h('span', null, 'TIME')),
    h('div', { class: 'dice-g' }, DiceBtn('Dice every effect in the chain', () => { for (const id of S.chain) diceKeys(FXMETA[id].params.map((d) => 'fx.' + id + '.' + d.id)); }), h('span', null, 'FX')));
  // presets
  $('#preset-prev').addEventListener('click', () => loadPreset(presetIdx - 1));
  $('#preset-next').addEventListener('click', () => loadPreset(presetIdx + 1));
  $('#preset-open').addEventListener('click', (e) => presetMenu(e.currentTarget));
  $('#preset-save').addEventListener('click', savePresetDialog);
  // tabs
  for (const b of $$('.tab')) b.addEventListener('click', () => showPage(b.dataset.page));
  // MAIN row
  $('#mainrow-ctl').append(Knob('main.gain'), Knob('main.low'), Knob('main.mid'), Knob('main.high'), Knob('main.pan'), Knob('main.comp'), Knob('main.auto'), Knob('main.mix'), Toggle('main.bypass', { cls: 'warn' }));
  // drag & drop files anywhere
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  window.addEventListener('drop', (e) => { document.body.classList.remove('dropping'); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) { e.preventDefault(); loadFile(f); } });
  // keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea,select,[contenteditable]')) return;
    if (e.code === 'Space' && !e.target.closest('button,[role=slider],[role=button]')) { e.preventDefault(); togglePlay(); }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && ['1', '2', '3', '4'].includes(e.key) && !e.target.closest('[role=slider]')) showPage(['time', 'fx', 'animate', 'perform'][+e.key - 1]);
  });
}
let taps = [];
function tapTempo() {
  const t = performance.now(); taps = taps.filter((x) => t - x < 2500); taps.push(t);
  if (taps.length >= 3) { const d = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); setBpm(60000 / d); }
}

// ----------------------------------------------------------------- visuals -
let reelAngle = 0, lastT = performance.now();
const scopeBuf = new Float32Array(2048), specBuf = new Uint8Array(1024);
function frame(t) {
  const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
  const tick = live.tick;
  // reels in the logo turn with the transport (and the varispeed rate)
  if (live.playing) reelAngle += dt * 1.6 * (tick && P['vari.on'] >= 0.5 ? Math.max(0, tick.vr) : 1);
  const reels = $$('.reel-spin'); reels.forEach((r, i) => r.setAttribute('transform', `rotate(${(reelAngle * 57.3 * (i ? 1.25 : 1)) % 360} ${r.dataset.cx} ${r.dataset.cy})`));
  drawOutput();
  if (currentPage === 'time') drawEngines(dt);
  if (currentPage === 'animate') { drawScopes(); drawGraphs(); }
  if (currentPage === 'perform') { drawScopes(); padDraw(); }
  // source playhead
  const ph = $('#src-head'); if (ph && tick) ph.style.transform = `translateX(${(tick.srcPos * 100).toFixed(2)}%)`;
  requestAnimationFrame(frame);
}
function drawOutput() {
  const cv = $('#scope'); if (!cv) return;
  const f = fit(cv); if (!f) return;
  const { c, W, H } = f;
  c.clearRect(0, 0, W, H);
  if (AUDIO.analyser) {
    AUDIO.analyser.getByteFrequencyData(specBuf);
    c.fillStyle = cssVar('--mod-fill');
    const bins = 96;
    for (let i = 0; i < bins; i++) {
      const f0 = Math.pow(i / bins, 2.2) * 600, v = specBuf[Math.floor(f0)] / 255;
      const bw = W / bins; c.fillRect(i * bw, H - v * H, bw - 1, v * H);
    }
    AUDIO.analyser.getFloatTimeDomainData(scopeBuf);
    let z = 0; for (let i = 1; i < 1024; i++) if (scopeBuf[i - 1] < 0 && scopeBuf[i] >= 0) { z = i; break; }
    c.strokeStyle = cssVar('--accent'); c.lineWidth = 1.5; c.beginPath();
    for (let x = 0; x < W; x++) { const v = scopeBuf[z + Math.floor(x / W * 1000)] || 0; const y = H / 2 - v * H * 0.48; x ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
  } else {
    c.strokeStyle = cssVar('--line'); c.beginPath(); c.moveTo(0, H / 2); c.lineTo(W, H / 2); c.stroke();
  }
  const tk = live.tick;
  if (tk) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.style.transform = `scaleY(${Math.min(1, Math.max(0, (20 * Math.log10(v + 1e-6) + 48) / 48)).toFixed(3)})`; };
    set('m-l', tk.peaks[2]); set('m-r', tk.peaks[3]);
    const gr = $('#m-gr'); if (gr) gr.classList.toggle('on', tk.gr > 0.05);
  }
}
const vizState = { reel: 0 };
// ---- engine visuals: drawn from real buffer envelopes sent by the engine (tick.viz)
function vizText(c, txt, x, y, align, col) {
  c.font = '600 10.5px ' + cssVar('--f-mono'); c.textAlign = align || 'left'; c.textBaseline = 'middle';
  c.fillStyle = cssVar(col || '--fg-dim'); c.fillText(txt, x, y); c.textAlign = 'left';
}
function roundRect(c, x, y, w, hgt, r) {
  r = Math.min(r, w / 2, hgt / 2);
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + hgt, r); c.arcTo(x + w, y + hgt, x, y + hgt, r);
  c.arcTo(x, y + hgt, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
// Mirrored, smoothed waveform of an envelope (values 0..1, -1 = not recorded) between x0 and x1.
// opts: { from, to } draw only that fraction range; gain scales height; fn(t) extra amplitude shaping; flip mirrors in time
function waveShape(c, env, x0, x1, ym, hmax, opts = {}) {
  const n = env.length, from = opts.from ?? 0, to = opts.to ?? 1, gain = opts.gain ?? 1;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1); if (t < from - 1 / n || t > to + 1 / n) continue;
    let v = env[opts.flip ? n - 1 - i : i]; if (v < 0) v = 0;
    v = Math.pow(v, 0.7) * gain * (opts.fn ? opts.fn(t) : 1);
    pts.push([x0 + (x1 - x0) * t, Math.max(0.6, v * hmax)]);
  }
  if (pts.length < 2) return;
  c.beginPath();
  c.moveTo(pts[0][0], ym - pts[0][1]);
  for (let i = 1; i < pts.length; i++) { const p0 = pts[i - 1], p1 = pts[i]; const mx = (p0[0] + p1[0]) / 2; c.quadraticCurveTo(p0[0], ym - p0[1], mx, ym - (p0[1] + p1[1]) / 2); }
  c.lineTo(pts[pts.length - 1][0], ym - pts[pts.length - 1][1]);
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; c.lineTo(p[0], ym + p[1]); }
  c.closePath();
  c.fillStyle = opts.fill; c.fill();
}
function headLine(c, x, y0, y1, col) {
  c.save();
  c.shadowColor = cssVar(col); c.shadowBlur = 8;
  c.strokeStyle = cssVar(col); c.lineWidth = 2; c.lineCap = 'round';
  c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke();
  c.restore();
  c.fillStyle = cssVar(col);
  c.beginPath(); c.moveTo(x - 4, y0 - 4); c.lineTo(x + 4, y0 - 4); c.lineTo(x, y0 + 1); c.closePath(); c.fill();
}
function idleLine(c, x0, x1, ym) {
  c.strokeStyle = cssVar('--line-2'); c.setLineDash([2, 4]); c.lineWidth = 1;
  c.beginPath(); c.moveTo(x0, ym); c.lineTo(x1, ym); c.stroke(); c.setLineDash([]);
}

function drawStretchViz(cv, tk) {
  const f = fit(cv); if (!f) return; const { c, W, H } = f; c.clearRect(0, 0, W, H);
  const on = P['stretch.on'] >= 0.5, fr = P['stretch.freeze'] >= 0.5, rev = P['stretch.rev'] >= 0.5;
  const v = tk && tk.viz && tk.viz.sh;
  const sp = tk && tk.sh && on ? tk.sh.speed : getV('stretch.speed') / 100;
  vizText(c, (fr ? 'FROZEN LOOP' : 'CAPTURE ' + fmt('stretch.tempo')) + (rev ? '  ◀ REV' : ''), 10, 11, 'left', fr ? '--mod' : '--fg-dim');
  vizText(c, 'SPEED ' + Math.round(sp * 100) + '%', W - 10, 11, 'right');
  const x0 = 10, x1 = W - 10, top = 22, bot = H - 6, ym = (top + bot) / 2, hm = (bot - top) / 2 - 1;
  roundRect(c, x0 - 4, top - 2, x1 - x0 + 8, bot - top + 4, 5); c.fillStyle = cssVar(fr ? '--mod-fill' : '--panel-2'); c.fill();
  if (!v || !on) { idleLine(c, x0, x1, ym); return; }
  c.save(); if (fr) c.globalAlpha = 0.55;
  waveShape(c, v.env, x0, x1, ym, hm, { fill: cssVar(fr ? '--mod' : '--fg-faint'), to: Math.min(1, v.rec) });
  c.restore();
  // grains: translucent windows over the stretch of audio each one is reading
  for (const [gx, w, dir, span] of v.grains) {
    const a = Math.max(0, Math.min(1, dir > 0 ? gx : gx - span)), b = Math.max(0, Math.min(1, dir > 0 ? gx + span : gx));
    if (b <= a) continue;
    c.save(); c.globalAlpha = 0.25 + 0.6 * w;
    waveShape(c, v.env, x0, x1, ym, hm, { from: a, to: b, fill: cssVar('--accent'), fn: (t) => 0.35 + 0.65 * Math.sin(Math.PI * Math.max(0, Math.min(1, (t - a) / (b - a)))) });
    c.restore();
    const gxp = x0 + (x1 - x0) * Math.max(0, Math.min(1, gx));
    c.fillStyle = cssVar('--accent'); c.globalAlpha = 0.4 + 0.6 * w; c.beginPath(); c.arc(gxp, ym, 1.8 + 1.6 * w, 0, Math.PI * 2); c.fill(); c.globalAlpha = 1;
  }
  headLine(c, x0 + (x1 - x0) * Math.max(0, Math.min(1, v.head)), top, bot, '--accent');
}

function drawVariViz(cv, tk, dt) {
  const f = fit(cv); if (!f) return; const { c, W, H } = f; c.clearRect(0, 0, W, H);
  const on = P['vari.on'] >= 0.5, v = tk && tk.viz && tk.viz.vr;
  const rate = on && v ? v.rate : on ? 0 : 1;
  if (live.playing) vizState.reel += dt * 3.2 * rate;
  const R = Math.min(H / 2 - 4, 30), cy = H / 2, cxL = R + 8, cxR = W - R - 8;
  const reel = (cx, pack, ang) => {
    // flange
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fillStyle = cssVar('--panel-2'); c.fill();
    c.lineWidth = 1.2; c.strokeStyle = cssVar('--line-2'); c.stroke();
    // tape pack
    const grd = c.createRadialGradient(cx, cy, R * 0.25, cx, cy, R * pack);
    grd.addColorStop(0, '#3a2a1c'); grd.addColorStop(1, '#5a3f27');
    c.beginPath(); c.arc(cx, cy, R * pack, 0, Math.PI * 2); c.fillStyle = grd; c.fill();
    for (let k = 1; k < 4; k++) { c.beginPath(); c.arc(cx, cy, R * (0.3 + (pack - 0.3) * k / 4), 0, Math.PI * 2); c.strokeStyle = 'rgba(0,0,0,0.18)'; c.lineWidth = 1; c.stroke(); }
    // hub with three windows, turning
    c.beginPath(); c.arc(cx, cy, R * 0.3, 0, Math.PI * 2); c.fillStyle = cssVar('--fg-dim'); c.fill();
    for (let k = 0; k < 3; k++) {
      const an = ang + k * 2.0944;
      c.beginPath(); c.arc(cx, cy, R * 0.24, an, an + 0.9); c.arc(cx, cy, R * 0.12, an + 0.9, an, true); c.closePath(); c.fillStyle = cssVar('--bg'); c.fill();
    }
    c.beginPath(); c.arc(cx, cy, 2.2, 0, Math.PI * 2); c.fillStyle = cssVar('--bg'); c.fill();
  };
  reel(cxL, 0.86, vizState.reel); reel(cxR, 0.62, vizState.reel * 1.38);
  // tape window between the reels: last two seconds of input, newest at the right (record head)
  const x0 = cxL + R + 10, x1 = cxR - R - 10, top = 8, bot = H - 8, ym = (top + bot) / 2 + 4, hm = (bot - top) / 2 - 6;
  if (x1 - x0 < 40) return;
  roundRect(c, x0, top, x1 - x0, bot - top, 4); c.fillStyle = cssVar('--bg'); c.fill(); c.strokeStyle = cssVar('--line'); c.lineWidth = 1; c.stroke();
  // tape lines from the reels into the window
  c.strokeStyle = '#5a3f27'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(cxL, cy + R * 0.86); c.lineTo(x0, bot - 2); c.moveTo(cxR, cy + R * 0.62); c.lineTo(x1, bot - 2); c.stroke();
  const rateTxt = !on ? 'BYPASS' : P['vari.stop'] >= 0.5 && Math.abs(rate) < 0.02 ? 'STOPPED' : (rate < 0 ? '◀ ×' : '×') + Math.abs(rate).toFixed(2);
  vizText(c, rateTxt, (x0 + x1) / 2, top + 9, 'center', rate < 0 ? '--warn' : on ? '--fg' : '--fg-dim');
  if (!v || !on) { idleLine(c, x0 + 8, x1 - 8, ym); return; }
  const ix0 = x0 + 6, ix1 = x1 - 6, hx = ix0 + (ix1 - ix0) * Math.max(0, Math.min(1, v.head));
  // lag between play head and record head
  c.fillStyle = cssVar('--accent-fill'); c.fillRect(Math.min(hx, ix1), top + 18, Math.abs(ix1 - hx), bot - top - 22);
  waveShape(c, v.env, ix0, ix1, ym, hm - 6, { fill: cssVar('--fg-faint') });
  c.save(); c.beginPath(); c.rect(Math.min(hx, ix1), top, Math.abs(ix1 - hx), bot - top); c.clip();
  waveShape(c, v.env, ix0, ix1, ym, hm - 6, { fill: cssVar('--fg-dim') }); c.restore();
  headLine(c, hx, top + 18, bot - 4, '--accent');
  c.fillStyle = cssVar('--warn'); c.beginPath(); c.arc(ix1, top + 20, 2.6, 0, Math.PI * 2); c.fill();
}

function drawStutterViz(cv, tk) {
  const f = fit(cv); if (!f) return; const { c, W, H } = f; c.clearRect(0, 0, W, H);
  const st = tk && tk.st, v = tk && tk.viz && tk.viz.st, on = P['stutter.on'] >= 0.5;
  const x0 = 10, x1 = W - 10, top = 22, bot = H - 6;
  if (P['stutter.bend'] >= 0.5) {
    const wz = DSP.WARP_ZONES[DSP.zoneOf(DSP.WARP_ZONES, P['bend.warp'])][2], bz = DSP.BREAK_ZONES[DSP.zoneOf(DSP.BREAK_ZONES, P['bend.brk'])][2];
    vizText(c, 'WARP ' + wz + (st && st.scratch ? ' · ' + st.scratch : ''), 10, 11, 'left', wz === 'OFF' ? '--fg-dim' : '--c-glitch');
    vizText(c, 'BREAK ' + bz, W - 10, 11, 'right', bz === 'OFF' ? '--fg-dim' : '--c-glitch');
    const reps = st && st.bend ? st.reps : Math.round(getV('bend.reps')), bw = (x1 - x0) / reps;
    for (let i = 0; i < reps; i++) {
      const cur = st && st.bend && i === st.j && on;
      roundRect(c, x0 + i * bw + 1, top, bw - 2, bot - top, 3);
      c.fillStyle = cssVar(cur ? '--accent-fill' : '--panel-2'); c.fill();
      if (cur) { c.strokeStyle = cssVar('--accent'); c.lineWidth = 1.2; c.stroke(); }
    }
    const ym = (top + bot) / 2, hm = (bot - top) / 2 - 3;
    if (!v || !on) { idleLine(c, x0, x1, ym); return; }
    waveShape(c, v.env, x0, x1, ym, hm, { fill: cssVar(v.live ? '--warn' : '--fg-dim') });
    if (st && st.bend) {
      const j = st.j, a = j / reps, b = (j + 1) / reps;
      c.save(); c.beginPath(); c.rect(x0 + a * (x1 - x0), top, (b - a) * (x1 - x0), bot - top); c.clip();
      waveShape(c, v.env, x0, x1, ym, hm, { fill: cssVar('--accent') }); c.restore();
    }
    let hx = v.head - Math.floor(v.head);
    headLine(c, x0 + (x1 - x0) * hx, top, bot, '--fg');
    if (v.live) vizText(c, 'RECORDING LOOP', (x0 + x1) / 2, (top + bot) / 2, 'center', '--fg');
    return;
  }
  // STUTTER: one tile per repeat of the captured slice, shaped by decay, gate and reverse
  const link = P['stutter.link'] >= 0.5;
  let rateB, capB;
  if (link) { const lp = DSP.LINK_PRESETS[Math.round(getV('stutter.lpreset'))] || DSP.LINK_PRESETS[4]; rateB = DSP.DIV_BEATS[lp[0]]; capB = DSP.DIV_BEATS[lp[1]]; }
  else { capB = getV('stutter.capture'); rateB = P['stutter.sync'] >= 0.5 ? getV('stutter.rate') : getV('stutter.rate_ms') / 1000 * S.bpm / 60; }
  const n = Math.max(1, Math.min(16, Math.round(capB / rateB)));
  const act = !!(st && st.active && on), k = st ? st.k : 0;
  vizText(c, act ? `REPEAT ${k + 1}` + (n > 1 ? ` / ${n}` : '') : on ? 'DRY' : 'OFF', 10, 11, 'left', act ? '--accent' : '--fg-dim');
  vizText(c, (link ? fmt('stutter.lpreset') : (P['stutter.sync'] >= 0.5 ? fmt('stutter.rate') : fmt('stutter.rate_ms')) + ' / ' + fmt('stutter.capture')), W - 10, 11, 'right');
  const bw = (x1 - x0) / n, ym = (top + bot) / 2, hm = (bot - top) / 2 - 3;
  const decay = getV('stutter.decay') / 100, gate = getV('stutter.gate') / 100, rev = P['stutter.rev'] >= 0.5;
  const gateFn = (t) => { if (gate <= 0.001) return 1; const open = 1 - 0.92 * gate; return t < open ? 1 : Math.max(0, 1 - (t - open) / (1 - open)); };
  for (let i = 0; i < n; i++) {
    const tx0 = x0 + i * bw + 1.5, tx1 = x0 + (i + 1) * bw - 1.5;
    const cur = act && i === Math.min(k, n - 1), done = act && i < k;
    roundRect(c, tx0, top, tx1 - tx0, bot - top, 3); c.fillStyle = cssVar(cur ? '--accent-fill' : '--panel-2'); c.fill();
    if (cur) { c.strokeStyle = cssVar('--accent'); c.lineWidth = 1.2; c.stroke(); }
    const g = i === 0 ? 1 : Math.pow(1 - decay * 0.82, i);
    if (v && act) waveShape(c, v.env, tx0 + 2, tx1 - 2, ym, hm, { gain: g, fn: gateFn, flip: rev && i > 0, fill: cssVar(cur ? '--accent' : done ? '--fg-dim' : '--fg-faint') });
    else idleLine(c, tx0 + 3, tx1 - 3, ym);
    if (cur && st) headLine(c, tx0 + 2 + (tx1 - tx0 - 4) * Math.max(0, Math.min(1, st.ph)), top, bot, '--fg');
  }
}

function drawEngines(dt) {
  const tk = live.tick;
  const a = $('#viz-stretch'), b = $('#viz-vari'), d = $('#viz-stutter');
  if (a) drawStretchViz(a, tk);
  if (b) drawVariViz(b, tk, dt);
  if (d) drawStutterViz(d, tk);
}
on('tick', (t) => {
  // live values on modulated knobs
  for (const lk of liveKnobs) {
    if (!lk.w.el.isConnected) { liveKnobs.delete(lk); continue; }
    if (t.mods[lk.key] !== undefined && lk.w.el.offsetParent !== null) lk.w.live(t.mods[lk.key]);
  }
  for (let i = 0; i < 3; i++) { const p = $(`#eng-${['stretch', 'vari', 'stutter'][i]}`); if (p) p.classList.toggle('busy', t.engines[i] > 0.5); }
  const lat = $('#lat'); if (lat) lat.textContent = t.latency ? `+${t.latency} smp` : '';
});

// -------------------------------------------------------------------- boot -
function boot() {
  buildHeader();
  buildTime($('#page-time'));
  buildFx($('#page-fx'));
  buildAnimate($('#page-animate'));
  buildPerform($('#page-perform'));
  definePresets();
  // open in a realistic working state: the first factory scene, ready to play
  const first = FACTORY.findIndex((f) => f.name === 'TAPE LULL');
  loadPreset(first >= 0 ? first : 0);
  let page = 'time'; try { page = localStorage.getItem('debacle.page') || 'time'; } catch (e) { /* ignore */ }
  showPage(['time', 'fx', 'animate', 'perform'].includes(page) ? page : 'time');
  // preview the loop PLAY will start (loadPreset already did if the preset names one)
  if (!AUDIO.current) { AUDIO.current = 'break'; previewDemo('break'); }
  window.addEventListener('resize', () => { if (AUDIO.waveLoop) drawWaveform(AUDIO.waveLoop); });
  requestAnimationFrame(frame);
}
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
