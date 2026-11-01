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
  const c = cv.getContext('2d'), W = cv.width, H = cv.height;
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
function drawEngines(dt) {
  const tk = live.tick;
  // STRETCH: captured chunk with read head
  let cv = $('#viz-stretch');
  if (cv) {
    const c = cv.getContext('2d'), W = cv.width, H = cv.height; c.clearRect(0, 0, W, H);
    const on = P['stretch.on'] >= 0.5, fr = P['stretch.freeze'] >= 0.5;
    c.fillStyle = cssVar(fr ? '--mod-fill' : '--panel-2'); c.fillRect(8, 18, W - 16, H - 36);
    c.strokeStyle = cssVar('--line'); c.strokeRect(8.5, 18.5, W - 17, H - 37);
    const rev = P['stretch.rev'] >= 0.5;
    const raw = tk && tk.sh ? tk.sh.pos : 0, pos = rev ? 1 - raw : raw; // REVERSE reads right → left
    const grains = 10, dir = rev ? -1 : 1; c.fillStyle = cssVar('--fg-dim');
    for (let g = 0; g < grains; g++) { const x = 8 + (pos * (W - 16)) - dir * g * 6; if (x < 8 || x > W - 8) break; c.globalAlpha = 1 - g / grains; c.fillRect(x - 1, 22 + (g % 3) * 8, 3, H - 52); }
    c.globalAlpha = 1;
    c.fillStyle = cssVar(on ? '--accent' : '--fg-dim'); c.fillRect(8 + pos * (W - 16) - 1, 12, 2.5, H - 24);
    c.font = '600 11px ' + cssVar('--f-mono'); c.fillStyle = cssVar('--fg-dim');
    c.fillText((fr ? 'FROZEN' : 'CAPTURE ' + fmt('stretch.tempo')) + (rev ? '  ◀ REVERSE' : ''), 10, 12);
    const sp = tk && tk.sh && on ? tk.sh.speed : getV('stretch.speed') / 100;
    c.textAlign = 'right'; c.fillText('SPEED ' + Math.round(sp * 100) + '%', W - 10, 12); c.textAlign = 'left';
  }
  // VARISPEED: two reels turning at the head rate
  cv = $('#viz-vari');
  if (cv) {
    const c = cv.getContext('2d'), W = cv.width, H = cv.height; c.clearRect(0, 0, W, H);
    const rate = tk && P['vari.on'] >= 0.5 ? tk.vr : (P['vari.on'] >= 0.5 ? 0 : 1);
    if (live.playing) vizState.reel += dt * 4 * rate;
    const reel = (cx, r, a) => {
      c.strokeStyle = cssVar('--fg-dim'); c.lineWidth = 1.5; c.beginPath(); c.arc(cx, H / 2, r, 0, Math.PI * 2); c.stroke();
      c.fillStyle = cssVar('--panel-2'); c.beginPath(); c.arc(cx, H / 2, r * 0.82, 0, Math.PI * 2); c.fill();
      for (let k = 0; k < 3; k++) { const an = a + k * 2.094; c.fillStyle = cssVar('--bg'); c.beginPath(); c.moveTo(cx, H / 2); c.arc(cx, H / 2, r * 0.7, an, an + 0.8); c.closePath(); c.fill(); }
      c.fillStyle = cssVar('--fg-dim'); c.beginPath(); c.arc(cx, H / 2, 4, 0, Math.PI * 2); c.fill();
    };
    reel(W * 0.3, H * 0.4, vizState.reel); reel(W * 0.7, H * 0.4, vizState.reel * 1.1);
    c.strokeStyle = cssVar('--accent'); c.lineWidth = 2; c.beginPath(); c.moveTo(W * 0.3, H / 2 + H * 0.4); c.lineTo(W * 0.7, H / 2 + H * 0.4); c.stroke();
    c.font = '600 11px ' + cssVar('--f-mono'); c.fillStyle = cssVar(rate < 0 ? '--warn' : '--fg-dim'); c.textAlign = 'center';
    c.fillText((rate < 0 ? 'REV ×' : '×') + Math.abs(rate).toFixed(2), W / 2, H / 2 + 4); c.textAlign = 'left';
  }
  // STUTTER / BENDIT
  cv = $('#viz-stutter');
  if (cv) {
    const c = cv.getContext('2d'), W = cv.width, H = cv.height; c.clearRect(0, 0, W, H);
    const st = tk && tk.st; c.font = '600 11px ' + cssVar('--f-mono');
    if (P['stutter.bend'] >= 0.5) {
      const reps = st && st.bend ? st.reps : Math.round(getV('bend.reps'));
      const bw = (W - 16) / reps;
      for (let i = 0; i < reps; i++) { c.fillStyle = cssVar(st && st.bend && i === st.j ? '--accent' : '--panel-2'); c.fillRect(8 + i * bw + 1, 22, bw - 2, H - 34); }
      if (st && st.bend) { c.fillStyle = cssVar('--fg'); c.fillRect(8 + st.ph * (W - 16), 18, 2, H - 26); }
      c.fillStyle = cssVar('--fg-dim');
      const wz = DSP.WARP_ZONES[DSP.zoneOf(DSP.WARP_ZONES, P['bend.warp'])][2], bz = DSP.BREAK_ZONES[DSP.zoneOf(DSP.BREAK_ZONES, P['bend.brk'])][2];
      c.fillText('WARP ' + wz + (st && st.scratch ? ' · ' + st.scratch : ''), 10, 13); c.textAlign = 'right'; c.fillText('BREAK ' + bz, W - 10, 13); c.textAlign = 'left';
    } else {
      const n = 8, bw = (W - 16) / n, k = st ? st.k : 0, act = st && st.active;
      for (let i = 0; i < n; i++) {
        const cur = act && i === Math.min(k, n - 1);
        const decay = Math.pow(1 - getV('stutter.decay') / 100 * 0.82, i);
        const hh = (H - 34) * (i === 0 ? 1 : decay);
        c.fillStyle = cssVar(cur ? '--accent' : i <= k && act ? '--fg-dim' : '--panel-2');
        c.fillRect(8 + i * bw + 1, H - 12 - hh, bw - 2, hh);
        if (cur) { c.fillStyle = cssVar('--fg'); c.fillRect(8 + i * bw + 1 + (bw - 2) * st.ph, H - 12 - hh, 2, hh); }
      }
      c.fillStyle = cssVar('--fg-dim');
      c.fillText(act ? 'REPEAT ' + (k + 1) : 'DRY', 10, 13);
      c.textAlign = 'right'; c.fillText((P['stutter.link'] >= 0.5 ? fmt('stutter.lpreset') : (P['stutter.sync'] >= 0.5 ? fmt('stutter.rate') : fmt('stutter.rate_ms')) + ' / ' + fmt('stutter.capture')), W - 10, 13); c.textAlign = 'left';
    }
  }
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
  requestAnimationFrame(frame);
}
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
