// ============================================================================
// DEBACLE UI — audio: context, worklet (with ScriptProcessor fallback),
// demo loop synthesis, file loading, print/resample.
// ============================================================================

const AUDIO = { ctx: null, node: null, analyser: null, mode: '', micNode: null, micStream: null, started: false, starting: null, loops: {}, current: null };

const DEMO_LOOPS = [
  { id: 'break', name: 'BREAK', bpm: 96, bars: 2, desc: 'Dusty breakbeat with a round bass' },
  { id: 'keys', name: 'KEYS', bpm: 84, bars: 2, desc: 'Electric piano chords, Am9 → Fmaj7' },
  { id: 'arp', name: 'ARP', bpm: 122, bars: 2, desc: 'Plucked minor arpeggio over a four-to-floor kick' },
  { id: 'choir', name: 'CHOIR', bpm: 70, bars: 2, desc: 'Breathy vowel pad, slowly opening' },
];

// Concurrent callers (a quick double click on PLAY, a demo button while PLAY is still starting)
// share one start-up instead of each creating an AudioContext and an engine.
async function startAudio() {
  if (AUDIO.started) { if (AUDIO.ctx.state !== 'running') await AUDIO.ctx.resume(); return true; }
  if (!AUDIO.starting) AUDIO.starting = bootAudio().catch((err) => { console.warn(err); toast('Audio could not start in this browser.'); return false; }).then((ok) => { AUDIO.starting = null; return ok; });
  return AUDIO.starting;
}
async function bootAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) { toast('This browser has no Web Audio support.'); return false; }
  const ctx = new Ctx({ latencyHint: 'interactive' });
  AUDIO.ctx = ctx;
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.75;
  AUDIO.analyser = analyser;
  let ok = false;
  if (ctx.audioWorklet && window.isSecureContext !== false) {
    try {
      const url = URL.createObjectURL(new Blob([DSP_SRC], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'debacle', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      node.port.onmessage = (e) => onEngineMsg(e.data);
      node.onprocessorerror = () => toast('The audio engine stopped after an error. Reload the page to restart it.');
      AUDIO.node = node; AUDIO.mode = 'worklet';
      enginePort = { post: (m, t) => node.port.postMessage(m, t || []) };
      ok = true;
    } catch (err) { console.warn('AudioWorklet unavailable, falling back', err); }
  }
  if (!ok) {
    // Fallback: run the same engine on the main thread
    const node = ctx.createScriptProcessor(1024, 2, 2);
    const eng = new DSP.DebacleEngine(ctx.sampleRate, (m) => queueMicrotask(() => onEngineMsg(m)));
    const bl = [new Float32Array(128), new Float32Array(128)], il = [new Float32Array(128), new Float32Array(128)];
    node.onaudioprocess = (e) => {
      const iL = e.inputBuffer.getChannelData(0), iR = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : iL;
      const oL = e.outputBuffer.getChannelData(0), oR = e.outputBuffer.getChannelData(1);
      for (let o = 0; o < oL.length; o += 128) {
        il[0].set(iL.subarray(o, o + 128)); il[1].set(iR.subarray(o, o + 128));
        eng.process(il[0], il[1], bl[0], bl[1], 128);
        oL.set(bl[0], o); oR.set(bl[1], o);
      }
    };
    AUDIO.node = node; AUDIO.mode = 'script';
    enginePort = { post: (m) => eng.handle(m) };
  }
  // keep a silent input connected so the processor always runs
  const silent = ctx.createConstantSource ? ctx.createConstantSource() : null;
  if (silent) { silent.offset.value = 0; silent.connect(AUDIO.node); silent.start(); }
  AUDIO.node.connect(analyser); analyser.connect(ctx.destination);
  AUDIO.started = true;
  sendAll();
  post({ type: 'viz', on: currentPage === 'time' });
  await loadDemo(AUDIO.current || 'break', true);
  post({ type: 'srcmode', mode: AUDIO.srcMode || 0 });
  $('#engine-mode').textContent = AUDIO.mode === 'worklet' ? 'WORKLET' : 'SCRIPT';
  return true;
}

function onEngineMsg(m) {
  if (m.type === 'tick') { live.tick = m; live.src = m.src; live.mods = m.mods; live.playing = m.playing; emit('tick', m); }
  else if (m.type === 'printed') onPrinted(m);
}

// ---------------------------------------------------------- demo loops -----
function synthLoop(id, sr) {
  const spec = DEMO_LOOPS.find((d) => d.id === id);
  const beat = 60 / spec.bpm, len = Math.round(spec.bars * 4 * beat * sr);
  const L = new Float32Array(len), R = new Float32Array(len);
  let seed = 7 + id.length * 31;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  const add = (i, l, r) => { const j = ((i % len) + len) % len; L[j] += l; R[j] += r; };
  const T = (b) => Math.round(b * beat * sr); // beats → samples
  const kick = (b, g = 1, dec = 7) => { const s0 = T(b); let ph = 0; for (let i = 0; i < sr * 0.5; i++) { const t = i / sr; const f = 46 + 110 * Math.exp(-t * 32); ph += 2 * Math.PI * f / sr; const v = Math.sin(ph) * Math.exp(-t * dec) * g * (1 - Math.exp(-t * 900)); const c = Math.tanh(v * 1.6) * 0.75; add(s0 + i, c, c); } };
  const snare = (b, g = 1) => { const s0 = T(b); let lp = 0; for (let i = 0; i < sr * 0.35; i++) { const t = i / sr; const n = rnd(); lp += (n - lp) * 0.55; const tone = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 28) * 0.55; const v = ((n - lp) * Math.exp(-t * 16) * 0.75 + tone) * g * 0.6; add(s0 + i, v * 0.95, v); } };
  const hat = (b, g = 1, open = false) => { const s0 = T(b); let x1 = 0; const dec = open ? 9 : 55; for (let i = 0; i < sr * (open ? 0.4 : 0.08); i++) { const t = i / sr; const n = rnd(); const hp = n - x1; x1 = n; const v = hp * Math.exp(-t * dec) * 0.22 * g; add(s0 + i, v * 0.8, v * 1.1); } };
  const note = (b, dur, midi, g, fn) => { const s0 = T(b), n = Math.round(dur * beat * sr), f = 440 * Math.pow(2, (midi - 69) / 12); fn(s0, n, f, g); };
  if (id === 'break') {
    const sw = 0.06;
    const pat = [[0, 'k', 1], [0.5, 'h', 0.7], [1, 's', 1], [1.5 + sw, 'h', 0.6], [1.75 + sw, 'k', 0.7], [2.25, 'k', 0.8], [2.5, 'h', 0.7], [3, 's', 1], [3.5 + sw, 'h', 0.5], [3.75 + sw, 's', 0.35],
      [4, 'k', 1], [4.5, 'h', 0.7], [5, 's', 1], [5.25 + sw, 's', 0.3], [5.5 + sw, 'k', 0.8], [6, 'h', 0.6], [6.5, 'k', 0.9], [7, 's', 1], [7.5, 'H', 0.6]];
    for (const [b, t, g] of pat) { if (t === 'k') kick(b, g); else if (t === 's') snare(b, g); else hat(b, g, t === 'H'); }
    for (let b = 0; b < 8; b += 0.5) hat(b + 0.25 + (b % 1 ? sw : 0), 0.25);
    const bassNotes = [[0, 1.5, 33], [1.75, 0.5, 36], [2.25, 1.5, 33], [4, 1.5, 31], [5.5, 0.5, 33], [6.5, 1.25, 28]];
    for (const [b, d, m] of bassNotes) note(b, d, m, 0.32, (s0, n, f, g) => { let ph = 0; for (let i = 0; i < n + sr * 0.05; i++) { const t = i / sr; ph += f / sr; const env = Math.min(1, t * 200) * (i < n ? 1 : Math.exp(-(i - n) / sr * 60)); const v = (Math.sin(2 * Math.PI * ph) + 0.25 * Math.sin(4 * Math.PI * ph)) * env * g; add(s0 + i, v, v); } });
  } else if (id === 'keys') {
    const chords = [[0, 4, [57, 60, 64, 67, 71]], [4, 4, [53, 57, 60, 64, 69]]];
    for (const [b, d, notes] of chords) for (let k = 0; k < notes.length; k++) {
      const delay = k * 0.012;
      note(b + delay, d - delay, notes[k], 0.11, (s0, n, f, g) => { for (let i = 0; i < n; i++) { const t = i / sr; const im = 1.6 * Math.exp(-t * 3); const mod = Math.sin(2 * Math.PI * f * t) * im; const v = Math.sin(2 * Math.PI * f * t + mod) * Math.exp(-t * 0.9) * Math.min(1, t * 400) * g * (i > n - 600 ? (n - i) / 600 : 1); const trem = 1 + 0.25 * Math.sin(2 * Math.PI * 4.5 * t); add(s0 + i, v * trem, v * (2 - trem)); } });
    }
    for (let b = 0; b < 8; b++) { hat(b + 0.5, 0.35); if (b % 2 === 1) snare(b, 0.25); if (b % 4 === 0) kick(b, 0.55, 9); }
    note(2.5, 1.5, 76, 0.06, (s0, n, f, g) => { for (let i = 0; i < n; i++) { const t = i / sr; const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 2) * g; add(s0 + i, v * 0.6, v); } });
  } else if (id === 'arp') {
    const seq = [57, 60, 64, 69, 67, 64, 60, 62, 57, 60, 65, 69, 72, 69, 65, 60];
    for (let s = 0; s < 32; s++) {
      const m = seq[s % 16] + (s >= 16 && s % 4 === 3 ? 12 : 0);
      note(s * 0.25, 0.24, m, 0.16, (s0, n, f, g) => { let lp = 0, ph = 0; for (let i = 0; i < n + sr * 0.15; i++) { const t = i / sr; ph += f / sr; const saw = 2 * (ph - Math.floor(ph)) - 1; const cut = 0.04 + 0.5 * Math.exp(-t * 18); lp += (saw - lp) * cut; const env = Math.exp(-t * 7) * Math.min(1, t * 600); const v = lp * env * g; const pan = Math.sin(s * 1.3) * 0.3; add(s0 + i, v * (1 - pan), v * (1 + pan)); } });
    }
    for (let b = 0; b < 8; b++) { kick(b, 0.9, 8); hat(b + 0.5, 0.5); }
    for (let b = 1; b < 8; b += 2) snare(b, 0.45);
  } else if (id === 'choir') {
    const formants = [[[800, 1150, 2900], [1, 0.5, 0.25]], [[400, 1600, 2700], [1, 0.4, 0.3]], [[350, 1700, 2700], [1, 0.3, 0.3]], [[450, 800, 2830], [1, 0.45, 0.2]]];
    const notes = [57, 64, 67, 72];
    const bp = notes.map(() => formants[0][0].map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 })));
    for (let v = 0; v < notes.length; v++) {
      const f0 = 440 * Math.pow(2, (notes[v] - 69) / 12); let ph = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr, pos = (t / (len / sr)) * formants.length, a = Math.floor(pos) % formants.length, bq = (a + 1) % formants.length, fr = pos - Math.floor(pos);
        const vib = 1 + 0.004 * Math.sin(2 * Math.PI * (5 + v * 0.3) * t);
        ph += f0 * vib / sr;
        const src = (2 * (ph - Math.floor(ph)) - 1) * 0.6 + rnd() * 0.12;
        let out = 0;
        for (let k = 0; k < 3; k++) {
          const fc = formants[a][0][k] * (1 - fr) + formants[bq][0][k] * fr, gk = formants[a][1][k];
          const w = 2 * Math.PI * fc / sr, q = 9, al = Math.sin(w) / (2 * q), c = Math.cos(w);
          const st = bp[v][k];
          // RBJ band-pass (0 dB peak), direct form I
          const y = (al * src - al * st.x2 + 2 * c * st.y1 - (1 - al) * st.y2) / (1 + al);
          st.x2 = st.x1; st.x1 = src; st.y2 = st.y1; st.y1 = y; out += y * gk;
        }
        const env = Math.min(1, t * 2) * Math.min(1, (len / sr - t) * 4 + 0.6);
        const pan = (v - 1.5) * 0.35;
        add(i, out * env * 0.5 * (1 - pan), out * env * 0.5 * (1 + pan));
      }
    }
    for (let b = 0; b < 8; b += 2) kick(b, 0.4, 5);
  }
  // normalize to −3 dBFS and make loop seam click-free
  let pk = 0; for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  const g = pk > 0 ? 0.7 / pk : 1; for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; }
  return { L, R, bpm: spec.bpm, name: spec.name };
}

async function loadDemo(id, silentToast) {
  AUDIO.current = id;
  for (const b of $$('.src-btn')) b.classList.toggle('on', b.dataset.src === id);
  if (!AUDIO.started) { previewDemo(id); return; }
  let lp = AUDIO.loops[id];
  if (!lp) { lp = synthLoop(id, AUDIO.ctx.sampleRate); AUDIO.loops[id] = lp; }
  setSource(lp, silentToast);
}
// before audio starts: show the loop (and its tempo) that PLAY will start
function previewDemo(id) {
  const lp = synthLoop(id, 48000);
  drawWaveform(lp); $('#src-name').textContent = lp.name;
  S.bpm = lp.bpm; const inp = $('#bpm'); if (inp) inp.value = String(lp.bpm);
}
function setSource(lp, silentToast) {
  const L = lp.L.slice(), R = lp.R.slice();
  post({ type: 'source', L, R }, [L.buffer, R.buffer]);
  if (lp.bpm) setBpm(lp.bpm);
  AUDIO.loopLen = lp.L.length;
  drawWaveform(lp);
  $('#src-name').textContent = lp.name;
  if (!silentToast) toast(`Loaded ${lp.name} · ${Math.round(lp.bpm)} BPM`);
}
function setBpm(b) {
  S.bpm = Math.max(30, Math.min(300, b));
  post({ type: 'bpm', bpm: S.bpm });
  const inp = $('#bpm'); if (inp && document.activeElement !== inp) inp.value = (Math.round(S.bpm * 10) / 10).toString();
}
function guessBpm(dur) {
  // choose bars so that the tempo lands in 70–170 BPM, assuming 4/4
  let best = 120, bestD = 1e9;
  for (const beats of [2, 4, 8, 16, 32, 64]) { const bpm = beats * 60 / dur; const d = bpm < 70 ? 70 - bpm : bpm > 170 ? bpm - 170 : Math.abs(bpm - 118) * 0.01; if (d < bestD) { bestD = d; best = bpm; } }
  return best;
}
async function loadFile(file) {
  if (!file) return;
  const ok = await startAudio(); if (!ok) return;
  try {
    const buf = await AUDIO.ctx.decodeAudioData(await file.arrayBuffer());
    const L = buf.getChannelData(0).slice(), R = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice();
    const maxLen = AUDIO.ctx.sampleRate * 60;
    const lp = { L: L.length > maxLen ? L.subarray(0, maxLen) : L, R: R.length > maxLen ? R.subarray(0, maxLen) : R, bpm: guessBpm(Math.min(L.length, maxLen) / AUDIO.ctx.sampleRate), name: file.name.replace(/\.[^.]+$/, '').slice(0, 24).toUpperCase() };
    AUDIO.loops.file = lp; AUDIO.current = 'file';
    for (const b of $$('.src-btn')) b.classList.remove('on');
    setSource(lp);
    if (!live.playing) togglePlay(true);
  } catch (e) { toast('Could not decode that file. Try WAV, MP3, OGG or FLAC.'); }
}

async function toggleMic() {
  const ok = await startAudio(); if (!ok) return;
  if (AUDIO.micNode) {
    AUDIO.micNode.disconnect(); AUDIO.micNode = null;
    if (AUDIO.micStream) { for (const t of AUDIO.micStream.getTracks()) t.stop(); AUDIO.micStream = null; } // releases the microphone
    AUDIO.srcMode = 0; post({ type: 'srcmode', mode: 0 }); $('#mic-btn').classList.remove('on'); $('#mic-btn').setAttribute('aria-pressed', 'false'); return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    AUDIO.micStream = stream;
    AUDIO.micNode = AUDIO.ctx.createMediaStreamSource(stream); AUDIO.micNode.connect(AUDIO.node);
    AUDIO.srcMode = 1; post({ type: 'srcmode', mode: 1 }); $('#mic-btn').classList.add('on'); $('#mic-btn').setAttribute('aria-pressed', 'true');
    toast('Live input on. Use headphones to avoid feedback.');
  } catch (e) { toast('Live input is not available here. Load an audio file instead.'); }
}

function printLoop() {
  if (!AUDIO.started || !live.playing) { toast('Start playback first, then PRINT records one loop of the output.'); return; }
  const len = AUDIO.loopLen || Math.round(AUDIO.ctx.sampleRate * 60 / S.bpm * 8);
  post({ type: 'print', len });
  $('#print-btn').classList.add('rec');
  toast('Printing one loop of the output…');
}
function onPrinted(m) {
  $('#print-btn').classList.remove('rec');
  const lp = { L: m.L, R: m.R, bpm: S.bpm, name: 'PRINT ' + new Date().toTimeString().slice(0, 5) };
  AUDIO.loops.print = lp; AUDIO.current = 'print';
  for (const b of $$('.src-btn')) b.classList.remove('on');
  setSource(lp, true);
  toast('Printed. The output is now the source loop.');
}

async function togglePlay(force) {
  const ok = await startAudio(); if (!ok) return;
  const playing = force !== undefined ? force : !live.playing;
  live.playing = playing;
  post({ type: 'play', on: playing });
  document.body.classList.toggle('playing', playing);
  $('#play').setAttribute('aria-pressed', playing ? 'true' : 'false');
  $('#play .play-label').textContent = playing ? 'STOP' : 'PLAY';
}

// waveform of the current source
function drawWaveform(lp) {
  const cv = $('#src-wave'); if (!cv) return;
  const f = fit(cv); if (!f) return;
  const { c, W, H } = f;
  AUDIO.waveLoop = lp;
  c.clearRect(0, 0, W, H);
  c.fillStyle = cssVar('--fg-dim');
  const n = lp.L.length, step = n / W;
  for (let x = 0; x < W; x++) {
    let mx = 0; const a = Math.floor(x * step), b = Math.min(n, Math.floor((x + 1) * step));
    for (let i = a; i < b; i += 4) mx = Math.max(mx, Math.abs(lp.L[i]), Math.abs(lp.R[i]));
    const hh = Math.max(1, mx * H * 0.9);
    c.fillRect(x, (H - hh) / 2, 1, hh);
  }
}
