// ============================================================================
// DEBACLE — host engine. Owns transport, source player, parameter banks,
// modulation, time engines, FX chain, MAIN row and limiter.
// DebacleEngine is a plain class so it can run inside an AudioWorklet or, as a
// fallback, inside a ScriptProcessorNode on the main thread.
// ============================================================================

class ParamBank {
  constructor(key, descs) {
    this.key = key; this.d = descs; this.n = descs.length;
    this.base = new Float32Array(this.n); this.eff = new Float32Array(this.n);
    this.mod = new Uint8Array(this.n);
    this.idx = {}; this.v = {};
    descs.forEach((d, i) => { prepParam(d); this.idx[d.id] = i; this.base[i] = this.eff[i] = d.defN; this.v[d.id] = normToValue(d, d.defN); });
  }
  setBase(i, n) {
    this.base[i] = n;
    if (!this.mod[i]) { this.eff[i] = n; this.v[this.d[i].id] = normToValue(this.d[i], n); }
  }
  setEff(i, n) { this.eff[i] = n; this.v[this.d[i].id] = normToValue(this.d[i], n); }
}

const HOST_FX_PARAMS = () => [
  { id: 'on', label: 'ON', toggle: true, def: 0 },
  { id: 'mix', label: 'MIX', min: 0, max: 100, def: 100, unit: '%' },
  { id: 'gain', label: 'GAIN', min: -12, max: 12, def: 0, unit: 'dB', bipolar: true },
];

// Stereo (optionally + weight) delay whose length can change without a click: a new length
// crossfades from the old tap. set() once per block, then run() over the block.
class ENG_LatDelay {
  constructor(max, weight) {
    this.l = new DelayLine(max); this.r = new DelayLine(max); this.w = weight ? new DelayLine(max) : null;
    this.max = this.l.size - 8; this.d = 0; this.d0 = 0; this.x = 1;
  }
  set(d) {
    d = d < 0 ? 0 : d > this.max ? this.max : d | 0;
    if (d !== this.d) { if (this.x >= 0.5) this.d0 = this.d; this.d = d; this.x = 0; }
  }
  // inputs xl/xr (/xw; null = silence) -> outputs ol/or (/ow; null = discard)
  run(xl, xr, xw, ol, or, ow, n, step) {
    const lb = this.l.buf, rb = this.r.buf, wb = this.w ? this.w.buf : null, m = this.l.mask, d = this.d, d0 = this.d0;
    let pos = this.l.w, x = this.x;
    for (let i = 0; i < n; i++) {
      lb[pos] = xl ? xl[i] : 0; rb[pos] = xr ? xr[i] : 0; if (wb) wb[pos] = xw ? xw[i] : 0;
      const j = (pos - d) & m;
      let yl = lb[j], yr = rb[j], yw = wb ? wb[j] : 0;
      if (x < 1) {
        const j0 = (pos - d0) & m;
        yl = lb[j0] + (yl - lb[j0]) * x; yr = rb[j0] + (yr - rb[j0]) * x; if (wb) yw = wb[j0] + (yw - wb[j0]) * x;
        x += step; if (x > 1) x = 1;
      }
      if (ol) { ol[i] = yl; or[i] = yr; } if (ow) ow[i] = yw;
      pos = (pos + 1) & m;
    }
    this.l.w = pos; this.r.w = pos; if (this.w) this.w.w = pos; this.x = x;
  }
}

class FxSlot {
  constructor(cls, sr) {
    this.cls = cls; this.id = cls.id; this.sr = sr;
    this.bank = new ParamBank('fx.' + cls.id, HOST_FX_PARAMS().concat(cls.params.map((d) => Object.assign({}, d))));
    this.inst = null; this.fade = 0; this.wasOn = false; this.latency = cls.latency || 0;
    this.maxLat = Math.max(this.latency, cls.maxLatency || 0);
    this.dryL = new Float32Array(128); this.dryR = new Float32Array(128);
    this.dly = null; this.align = null; this.level = 0; this.inChain = false;
    this.gain = 1; this.mixS = -1; this.error = null;
  }
  // instantiate outside the per-sample path (called when the slot joins the chain)
  ensure() {
    if (!this.inst) this.inst = new this.cls(this.sr);
    if (this.maxLat > 0 && !this.dly) this.dly = new ENG_LatDelay(this.maxLat + 8, false);
    return this.inst;
  }
  ensureAlign(max) { if (!this.align) this.align = new ENG_LatDelay(max + 8, true); }
  // current latency: effects with a variable FFT size report it per instance
  lat() { const i = this.inst; return i && i.latency !== undefined ? i.latency : this.latency; }
}
// largest latency any effect can add (sizes the parallel-chain alignment lines)
const ENG_MAX_FX_LAT = FX_REGISTRY.reduce((m, c) => Math.max(m, c.latency || 0, c.maxLatency || 0), 0);
const ENG_GRAPH_SPEEDS = [0.25, 0.5, 1, 2, 4];

class DebacleEngine {
  constructor(sr, post) {
    this.sr = sr; this.post = post;
    this.ctx = { sr, bpm: 120, spb: sr * 0.5, ppq: 0, playing: false, time: 0, blockSize: 128, key: new KeyHelper(), sidechain: null };
    // banks
    this.banks = {};
    for (const [k, u] of Object.entries(UNITS)) this.banks[k] = new ParamBank(k, u.params);
    this.fx = {};
    for (const cls of FX_REGISTRY) { const s = new FxSlot(cls, sr); this.fx[cls.id] = s; this.banks['fx.' + cls.id] = s.bank; }
    this.lfoBanks = [1, 2, 3, 4].map((i) => this.banks['lfo' + i]);
    this.graphBanks = [1, 2, 3].map((i) => this.banks['graph' + i]);
    this.chain = [];   // ordered FxSlots
    // engines
    this.vari = new Varispeed(sr); this.stutter = new Stutter(sr); this.stretch = new Stretch(sr);
    this.seqs = { stutter: { pats: defaultSeq('stutter'), rate: 0.25, chain: 1 }, stretch: { pats: defaultSeq('stretch'), rate: 0.5, chain: 1 } };
    // a routing change re-patches the engines: remove the step at their inputs (it would be recorded
    // into their buffers and replayed by every repeat) and at the section output
    this.order = 0; this.engDk = new TE_Declick(sr); this.inDk = [new TE_Declick(sr), new TE_Declick(sr), new TE_Declick(sr)];
    this.faders = [this.stretch.fader, this.vari.fader, this.stutter.fader];
    // modulation
    this.slots = []; this.targets = []; this.srcVal = new Float32Array(MOD_SOURCE_IDS.length);
    this.graphs = DEFAULT_GRAPHS.map((g) => g.map((p) => Object.assign({}, p)));
    this.lfo = [0, 1, 2, 3].map((i) => ({ phase: 0, out: 0.5, sm: 0.5, last: -1, env: 0, rnd: new Rng(1234 + i * 77), lp: new OnePole(), hp: new OnePole(), cyc: -1, jit: 0, amp: 1 }));
    // source + transport (beat clocks advance by n / spb, so tempo changes never make them jump)
    this.src = null; this.srcPos = 0; this.srcMode = 0; this.srcGain = 1; this.inGain = 1;
    this.srcEnv = 0; this.xsrc = null; this.srcOld = 0; this.srcXf = 0; this.srcXfN = Math.max(32, Math.round(sr * 0.004));
    this.playing = false; this.ppqPlay = 0; this.ppqFree = 0;
    // buffers
    this.bL = new Float32Array(128); this.bR = new Float32Array(128);
    this.dL = new Float32Array(128); this.dR = new Float32Array(128);      // dry (source) copy
    this.eL = new Float32Array(128); this.eR = new Float32Array(128);      // post-engine copy (env follower INTERNAL)
    this.pL = [new Float32Array(128), new Float32Array(128), new Float32Array(128)];
    this.pR = [new Float32Array(128), new Float32Array(128), new Float32Array(128)];
    this.aL = new Float32Array(128); this.aR = new Float32Array(128); this.aW = new Float32Array(128);
    this.fw = new Float32Array(128);   // per-sample fade of the slot just run (parallel chain)
    this.tL = new Float32Array(128); this.tR = new Float32Array(128); this.tW = new Float32Array(128); // delay-line scratch
    this.seam = new Uint8Array(128);
    // FX chain: edits (order, membership, SERIAL/PARALLEL) wait for a 5 ms dip to the chain input
    this.chainMode = 0; this.pendingChain = null; this.chainX = 1; this.chainHold = 0; this.cinL = new Float32Array(128); this.cinR = new Float32Array(128); this.cinX = new Float32Array(128);
    this.parDry = new ENG_LatDelay(ENG_MAX_FX_LAT + 8, false);
    // main
    this.eq = [0, 1].map(() => [new Biquad(), new Biquad(), new Biquad()]);
    this.eqLow = NaN; this.eqMid = NaN; this.eqHigh = NaN;
    this.mainDly = new ENG_LatDelay(65536, false);
    this.mixV = 1; this.byV = 0; this.mgL = -1; this.mgR = -1;
    this.compEnv = 0; this.rmsIn = 1e-4; this.rmsOut = 1e-4; this.autoG = 1;
    this.limEnv = 0; this.gr = 0;
    // telemetry
    this.tick = 0; this.tickN = Math.floor(sr / 30);
    this.peaks = new Float32Array(4);
    this.print = null;
    this.keySig = '';
  }

  // ------------------------------------------------------------------ messages
  handle(m) {
    switch (m.type) {
      case 'param': this.setParam(m.k, m.n); break;
      case 'params': for (const [k, n] of m.list) this.setParam(k, n); break;
      case 'chain': this.setChain(m.ids); break;
      case 'slots': this.setSlots(m.slots); break;
      case 'graph': this.setGraph(m.i, m.points); break;
      case 'seq': this.setSeq(m.which, m.pats); break;
      case 'source': this.setSource(m.L, m.R || m.L); break;
      case 'srcmode': this.srcMode = m.mode | 0; break;
      case 'srcgain': if (Number.isFinite(+m.g)) this.srcGain = +m.g; break;
      case 'bpm': this.setBpm(m.bpm); break;
      case 'play': this.setPlay(m.on); break;
      case 'print': this.startPrint(m.len); break;
      case 'viz': this.vizOn = !!m.on; break;
      case 'resetfx': { const s = this.fx[m.id]; if (s && s.inst) s.inst.reset(); break; }
    }
  }
  setGraph(i, points) {
    if (!(i >= 0 && i < this.graphs.length) || !Array.isArray(points)) return;
    const pts = [];
    for (const p of points) {
      if (!p || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) continue;
      pts.push({ x: clamp(+p.x, 0, 0.9999), y: clamp(+p.y, 0, 1), c: Number.isFinite(+p.c) ? clamp(+p.c, -1, 1) : 0 });
    }
    if (pts.length) this.graphs[i] = pts.sort((a, b) => a.x - b.x);
  }
  // sequencer patterns: always 4 patterns x 16 steps of { on, v } (the engines index them blindly)
  setSeq(which, pats) {
    const sq = this.seqs[which];
    if (!sq || !Array.isArray(pats)) return;
    const def = defaultSeq(which), out = [];
    for (let p = 0; p < 4; p++) {
      const src = Array.isArray(pats[p]) ? pats[p] : null, steps = [];
      for (let k = 0; k < 16; k++) {
        const st = src && src[k];
        steps.push(st ? { on: st.on ? 1 : 0, v: Number.isFinite(+st.v) ? clamp(+st.v, 0, 1) : 0.5 } : def[p][k]);
      }
      out.push(steps);
    }
    sq.pats = out;
  }
  setSource(L, R) {
    if (!L || !(L.length >= 2)) return;
    if (!R || R.length !== L.length) R = L;
    // loops that do not wrap smoothly get a 1.5 ms fade at the seam (length stays exact)
    const len = L.length, jump = Math.abs(L[len - 1] - L[0]) + Math.abs(R[len - 1] - R[0]);
    if (jump > 0.004 && len > 1024) {
      const f = Math.max(16, Math.round(this.sr * 0.0015));
      for (let i = 0; i < f; i++) { const g = i / f; L[i] *= g; L[len - 1 - i] *= g; if (R !== L) { R[i] *= g; R[len - 1 - i] *= g; } }
    }
    // a new loop while audible: crossfade from the old one
    if (this.src && this.srcEnv > 0) { this.xsrc = this.src; this.srcOld = this.srcPos; this.srcXf = this.srcXfN; }
    this.src = { L, R, len };
    this.srcPos = this.playing ? this.srcPos % len : 0;
  }
  setBpm(b) { b = +b; if (!Number.isFinite(b)) return; this.ctx.bpm = clamp(b, 30, 300); this.ctx.spb = this.sr * 60 / this.ctx.bpm; }
  setPlay(on) {
    on = !!on;
    if (on) {
      // (re)start: the loop restarts from its top (crossfaded if it was already playing)
      if (this.src && this.srcEnv > 0) { this.xsrc = this.src; this.srcOld = this.srcPos; this.srcXf = this.srcXfN; }
      this.ppqPlay = 0; this.srcPos = 0; this.rearm();
      if (this.playing) this.engDk.arm();
    } else if (this.playing) this.ppqFree = this.ppqPlay; // stop: the free-running clock carries on from here
    this.playing = on;
  }
  rearm() {
    const st = this.stutter; st.cycle = null; st.seqStep = -1; st.b.cycle = null; st.b.captured = false; st.histW = st.ring.w;
    const sh = this.stretch; sh.chunk = null; sh.gIdx = null; sh.seqStep = -1;
    this.vari.win = -1;
  }
  setParam(k, n) {
    if (typeof k !== 'string') return;
    const dot = k.lastIndexOf('.');
    const bank = this.banks[k.slice(0, dot)];
    if (!bank) return;
    const i = bank.idx[k.slice(dot + 1)];
    if (i === undefined) return;
    n = +n; if (!(n === n)) return; // NaN
    bank.setBase(i, clamp(n, 0, 1));
  }
  setChain(ids) {
    if (!Array.isArray(ids)) return;
    const next = ids.map((id) => this.fx[id]).filter((s, i, a) => s && a.indexOf(s) === i);
    // effects are built (buffers allocated) here, not inside the audio callback
    for (const s of next) { s.ensure(); s.ensureAlign(ENG_MAX_FX_LAT); }
    let same = next.length === this.chain.length;
    for (let i = 0; same && i < next.length; i++) same = next[i] === this.chain[i];
    this.pendingChain = same ? null : next; // applied by runChain once the dip reaches the input
  }
  // swap in a pending chain (called while the chain output is faded out)
  applyChain() {
    const next = this.pendingChain; this.pendingChain = null;
    for (const s of this.chain) s.inChain = false;
    for (const s of next) s.inChain = true;
    // a slot that left the chain starts from silence (and a reset) when it comes back
    for (const s of this.chain) if (!s.inChain) { s.fade = 0; s.wasOn = false; s.level = 0; s.error = null; }
    this.chain = next;
  }
  setSlots(slots) {
    if (!Array.isArray(slots)) return;
    // restore previously modulated params
    for (const t of this.targets) { t.bank.mod[t.i] = 0; t.bank.setBase(t.i, t.bank.base[t.i]); }
    const num = (x, d) => { x = +x; return x === x && x !== Infinity && x !== -Infinity ? x : d; };
    this.slots = slots;
    const map = new Map();
    for (const s of slots) {
      if (!s || typeof s.target !== 'string') continue;
      const dot = s.target.lastIndexOf('.');
      const bank = this.banks[s.target.slice(0, dot)];
      if (!bank) continue;
      const i = bank.idx[s.target.slice(dot + 1)];
      const si = MOD_SOURCE_IDS.indexOf(s.src);
      if (i === undefined || si < 0) continue;
      let t = map.get(s.target);
      if (!t) { t = { key: s.target, bank, i, slots: [] }; map.set(s.target, t); }
      t.slots.push({ si, min: clamp(num(s.min, 0), 0, 1), max: clamp(num(s.max, 1), 0, 1), start: clamp(num(s.start, 0), 0, 1), end: clamp(num(s.end, 1), 0, 1), skew: clamp(num(s.skew, 0), -1, 1), shape: num(s.shape, 0) | 0 });
    }
    this.targets = [...map.values()];
    for (const t of this.targets) t.bank.mod[t.i] = 1;
  }
  startPrint(len) {
    const n = Math.min(Math.floor(+len) || 0, this.sr * 32);
    if (n < 64) return;
    this.print = { L: new Float32Array(n), R: new Float32Array(n), pos: 0, armed: true };
  }

  // ---------------------------------------------------------------- modulation
  static slotMap(s, sl) {
    let t;
    const span = sl.end - sl.start;
    if (Math.abs(span) < 1e-6) t = s >= sl.start ? 1 : 0; else t = clamp((s - sl.start) / span, 0, 1);
    if (sl.shape === 1) t = t < 0.5 ? t * 2 : 2 - t * 2;
    else if (sl.shape === 2) t = t * t * (3 - 2 * t);
    if (sl.skew) t = Math.pow(t, Math.pow(4, -sl.skew));
    return sl.min + (sl.max - sl.min) * t;
  }
  lfoShape(shape, ph) {
    switch (shape) {
      case 0: return 0.5 - 0.5 * Math.cos(TAU * ph);                    // sine (starts at 0)
      case 1: return ph < 0.5 ? ph * 2 : 2 - ph * 2;                     // triangle
      case 2: return ph;                                                 // saw up
      case 3: return 1 - ph;                                             // saw down
      case 4: return ph < 0.5 ? 1 : 0;                                   // square
      case 5: return ph < 0.25 ? 1 : 0;                                  // pulse 25
      case 6: return ph < 0.1 ? 1 : 0;                                   // pulse 10
      case 7: return (Math.exp(ph * 4) - 1) / (Math.exp(4) - 1);         // exp
      case 8: return Math.log1p(ph * 20) / Math.log(21);                 // log
      case 9: return Math.pow(1 - Math.abs(ph * 2 - 1), 3);               // peak
      case 10: return 1 - Math.pow(1 - Math.abs(ph * 2 - 1), 3);          // valley
      case 11: return Math.sin(Math.PI * ph);                            // bump
      case 12: { const q = (ph * 2) % 1; return 0.5 - 0.5 * Math.cos(TAU * q); } // double
      case 13: return ph < 0.2 ? ph / 0.2 : 1 - (ph - 0.2) / 0.8;         // skew
      case 14: return Math.floor(ph * 4) / 3;                            // stairs 4
      case 15: return Math.floor(ph * 8) / 7;                            // stairs 8
      case 16: return Math.abs(Math.sin(Math.PI * 2 * ph)) ;             // half sine (rectified)
      case 17: { const q = ph < 0.5 ? ph * 2 : (ph - 0.5) * 2; return Math.abs(Math.cos(Math.PI * q * 0.5)) * (ph < 0.5 ? 1 : 0.55); } // bounce
      case 18: return clamp(ph < 0.5 ? ph * 4 : (1 - ph) * 4, 0, 1);     // trapezoid
      default: return 0.5;
    }
  }
  hash(k, seed) { let x = (k * 374761393 + seed * 668265263) | 0; x = (x ^ (x >>> 13)) * 1274126177 | 0; x ^= x >>> 16; return (x >>> 0) / 4294967296; }

  updateSources(n) {
    const ctx = this.ctx, sr = this.sr;
    const ppq = ctx.ppq;
    for (let i = 0; i < 4; i++) {
      const v = this.lfoBanks[i].v, st = this.lfo[i];
      let out;
      if (v.mode === 2) { // envelope follower
        const srcL = v.esrc === 1 ? this.dL : this.eL, srcR = v.esrc === 1 ? this.dR : this.eR;
        const tone = v.tone / 100;
        st.lp.set(tone < 0 ? 20000 * Math.pow(0.005, -tone) : 20000, sr);
        st.hp.set(tone > 0 ? 20 * Math.pow(250, tone) : 20, sr);
        const a = Math.exp(-1 / (v.rise * 0.001 * sr)), r = Math.exp(-1 / (v.fall * 0.001 * sr));
        const g = dbToGain(v.egain);
        let e = st.env;
        for (let k = 0; k < n; k++) {
          let x = (srcL[k] + srcR[k]) * 0.5;
          x = st.lp.lp(x); x = st.hp.hp(x);
          const ax = Math.abs(x) * g;
          e = ax > e ? ax + a * (e - ax) : ax + r * (e - ax);
        }
        st.env = e; out = clamp(e, 0, 1);
      } else {
        let pos; // position in cycles
        if (v.free >= 0.5) { st.phase += v.hz * n / sr; pos = st.phase; } // unbounded: RANDOM hashes the cycle index
        else pos = ppq / v.rate;
        pos += v.phase / 360;
        const jit = v.jitter / 100;
        const cyc = Math.floor(pos);
        if (v.mode === 1) { // random
          const seed = 17 + i * 101;
          let x = pos;
          if (jit > 0) x += (this.hash(cyc, seed + 5) - 0.5) * jit * 0.9;
          const c = Math.floor(x), f = x - c;
          const a = this.hash(c, seed), b = this.hash(c + 1, seed);
          out = v.bin >= 0.5 ? a : a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * f));
        } else {
          let ph = pos - cyc;
          if (cyc !== st.cyc) { st.cyc = cyc; st.jit = (this.hash(cyc, 999 + i) - 0.5) * jit * 0.5; st.amp = 1 - jit * this.hash(cyc, 333 + i) * 0.8; }
          ph = ph + st.jit; ph -= Math.floor(ph);
          out = 0.5 + (this.lfoShape(v.shape, ph) - 0.5) * st.amp;
        }
      }
      const sm = v.smooth / 100;
      if (sm > 0.001) {
        const tc = 0.002 + sm * sm * 1.5; // seconds
        const c = 1 - Math.exp(-n / (tc * sr));
        st.sm += (out - st.sm) * c; out = st.sm;
      } else st.sm = out;
      st.out = out;
      this.srcVal[i] = out;
    }
    for (let g = 0; g < 3; g++) {
      const v = this.graphBanks[g].v;
      let x = ppq * ENG_GRAPH_SPEEDS[v.speed] / v.len;
      if (v.dir === 1) x = 1 - (x - Math.floor(x));
      else if (v.dir === 2) { const q = (x / 2) - Math.floor(x / 2); x = q < 0.5 ? q * 2 : 2 - q * 2; }
      this.srcVal[4 + g] = clamp(evalGraph(this.graphs[g], x), 0, 1);
    }
    const pf = this.banks.perform.eff;
    for (let k = 0; k < 6; k++) this.srcVal[7 + k] = pf[k];
  }
  applyMods() {
    const sv = this.srcVal, targets = this.targets;
    for (let t = 0; t < targets.length; t++) {
      const tg = targets[t], sl = tg.slots; let acc = 0;
      for (let s = 0; s < sl.length; s++) acc += DebacleEngine.slotMap(sv[sl[s].si], sl[s]);
      tg.bank.setEff(tg.i, clamp(acc / sl.length, 0, 1));
    }
  }

  // ------------------------------------------------------------------- render
  process(inL, inR, outL, outR, n) {
    const ctx = this.ctx, sr = this.sr;
    // clock
    ctx.ppq = this.playing ? this.ppqPlay : this.ppqFree;
    ctx.playing = this.playing; ctx.time += n;
    // key
    const kv = this.banks.key.v;
    const sig = kv.root * 1000 + kv.scale * 100 + kv.chord * 10 + kv.csize;
    if (sig !== this.keySig) { this.keySig = sig; ctx.key.set(kv.root, SCALE_NAMES[kv.scale], kv.chord, kv.csize); }
    // modulation (sources computed from the previous block's signals)
    this.applyMods();
    this.seqs.stutter.rate = this.banks.sseq.v.rate; this.seqs.stutter.chain = this.banks.sseq.v.chain;
    this.seqs.stretch.rate = this.banks.tseq.v.rate; this.seqs.stretch.chain = this.banks.tseq.v.chain;

    // source (fades in on PLAY, out on STOP, crossfades on restart / loop change)
    const L = this.bL, R = this.bR;
    const src = this.src, xfN = this.srcXfN, envStep = 1 / xfN, want = this.playing && this.srcMode !== 1;
    for (let i = 0; i < n; i++) {
      let l = 0, r = 0;
      this.seam[i] = 0;
      if (src && (want || this.srcEnv > 0)) {
        const len = src.len, p = this.srcPos;
        this.seam[i] = p === 0 && this.playing ? 1 : 0;
        l = src.L[p]; r = src.R[p];
        this.srcPos = p + 1 >= len ? 0 : p + 1;
        const xs = this.xsrc;
        if (this.srcXf > 0 && xs) {
          const q = this.srcOld < xs.len ? this.srcOld : 0, g = this.srcXf / xfN;
          l += (xs.L[q] - l) * g; r += (xs.R[q] - r) * g;
          this.srcOld = q + 1 >= xs.len ? 0 : q + 1;
          if (--this.srcXf === 0) this.xsrc = null;
        }
        if (want) { if (this.srcEnv < 1) { this.srcEnv += envStep; if (this.srcEnv > 1) this.srcEnv = 1; } }
        else { this.srcEnv -= envStep; if (this.srcEnv < 0) this.srcEnv = 0; }
        const g = this.srcGain * this.srcEnv;
        l *= g; r *= g;
      }
      if (this.srcMode !== 0 && inL) { l += inL[i] * this.inGain; r += (inR || inL)[i] * this.inGain; }
      L[i] = l; R[i] = r; this.dL[i] = l; this.dR[i] = r;
    }

    // time engines
    const order = this.banks.time.v.order;
    if (order !== this.order) { this.order = order; this.engDk.arm(); this.inDk[0].arm(); this.inDk[1].arm(); this.inDk[2].arm(); }
    if (order === 3) {
      // parallel: every engine processes the dry signal; the sum is weighted by the engines' on/off faders
      const aL = this.aL, aR = this.aR, aW = this.aW, faders = this.faders;
      aL.fill(0, 0, n); aR.fill(0, 0, n); aW.fill(0, 0, n);
      for (let e = 0; e < 3; e++) {
        const pl = this.pL[e], pr = this.pR[e], w0 = faders[e].v;
        for (let i = 0; i < n; i++) { pl[i] = L[i]; pr[i] = R[i]; }
        this.runEngine(e, pl, pr, n); // always run (keeps buffers recording); off engines return dry
        const w1 = faders[e].v;
        if (w0 <= 0 && w1 <= 0) continue;
        const dw = (w1 - w0) / n;
        for (let i = 0; i < n; i++) { const w = w0 + dw * (i + 1); aL[i] += pl[i] * w; aR[i] += pr[i] * w; aW[i] += w; }
      }
      for (let i = 0; i < n; i++) { const w = aW[i]; if (w > 1e-6) { L[i] = aL[i] / w; R[i] = aR[i] / w; } }
    } else if (order === 1) { this.runEngine(1, L, R, n); this.runEngine(0, L, R, n); this.runEngine(2, L, R, n); }
    else if (order === 2) { this.runEngine(2, L, R, n); this.runEngine(0, L, R, n); this.runEngine(1, L, R, n); }
    else { this.runEngine(0, L, R, n); this.runEngine(1, L, R, n); this.runEngine(2, L, R, n); }
    this.engDk.run(L, R, n);
    for (let i = 0; i < n; i++) { this.eL[i] = L[i]; this.eR[i] = R[i]; }

    // FX chain
    const latency = this.runChain(L, R, n);

    // MAIN
    this.processMain(L, R, n, latency);
    // limiter + output + meters
    let pI0 = this.peaks[0], pI1 = this.peaks[1], pO0 = this.peaks[2], pO1 = this.peaks[3];
    const rel = Math.exp(-1 / (0.08 * sr)), thr = 0.89;
    let grMax = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(this.dL[i]), b = Math.abs(this.dR[i]); if (a > pI0) pI0 = a; if (b > pI1) pI1 = b;
      let l = L[i], r = R[i];
      if (!(l === l) || !(r === r) || Math.abs(l) > 1e6 || Math.abs(r) > 1e6) { l = r = 0; }
      const pk = Math.max(Math.abs(l), Math.abs(r));
      this.limEnv = pk > this.limEnv ? pk : pk + rel * (this.limEnv - pk);
      const g = this.limEnv > thr ? thr / this.limEnv : 1;
      if (1 - g > grMax) grMax = 1 - g;
      l *= g; r *= g;
      l = l > 0.85 ? 0.85 + 0.13 * fastTanh((l - 0.85) / 0.13) : l < -0.85 ? -0.85 + 0.13 * fastTanh((l + 0.85) / 0.13) : l;
      r = r > 0.85 ? 0.85 + 0.13 * fastTanh((r - 0.85) / 0.13) : r < -0.85 ? -0.85 + 0.13 * fastTanh((r + 0.85) / 0.13) : r;
      outL[i] = l; outR[i] = r;
      const al = Math.abs(l), ar = Math.abs(r); if (al > pO0) pO0 = al; if (ar > pO1) pO1 = ar;
    }
    this.peaks[0] = pI0; this.peaks[1] = pI1; this.peaks[2] = pO0; this.peaks[3] = pO1;
    this.gr = Math.max(this.gr, grMax);
    // print (resample output into a new loop, starting at the loop seam)
    if (this.print) {
      const pr = this.print;
      for (let i = 0; i < n && pr.pos < pr.L.length; i++) {
        if (pr.armed) { if (this.seam[i] || !this.src || this.srcMode === 1) pr.armed = false; else continue; }
        pr.L[pr.pos] = outL[i]; pr.R[pr.pos] = outR[i]; pr.pos++;
      }
      if (pr.pos >= pr.L.length) { this.post({ type: 'printed', L: pr.L, R: pr.R }); this.print = null; }
    }

    // sources for next block (env follower needs this block's signals)
    this.updateSources(n);
    // advance clock
    if (this.playing) this.ppqPlay += n / ctx.spb; else this.ppqFree += n / ctx.spb;
    // telemetry
    this.tick += n;
    if (this.tick >= this.tickN) { this.tick = 0; this.sendTick(latency); }
  }
  runEngine(e, L, R, n) {
    this.inDk[e].run(L, R, n);
    if (e === 0) this.stretch.process(L, R, n, this.banks.stretch.v, this.seqs.stretch, this.ctx);
    else if (e === 1) this.vari.process(L, R, n, this.banks.vari.v, this.ctx);
    else this.stutter.process(L, R, n, this.banks.stutter.v, this.banks.bend.v, this.seqs.stutter, this.ctx);
  }

  // FX chain with click-free re-patching: a change of order, membership or SERIAL/PARALLEL first
  // fades the chain's input and output to the plain input (5 ms), lets the effects' filters ring
  // out on silence (10 ms), switches, and fades back (5 ms).
  runChain(L, R, n) {
    const mode = this.banks.chain.v.mode, change = this.pendingChain !== null || mode !== this.chainMode;
    let x = this.chainX;
    if (!change && x >= 1) return this.runChainNow(L, R, n);
    if (x <= 0 && change && this.chainHold >= 0.01 * this.sr) {
      this.chainHold = 0;
      if (this.pendingChain) this.applyChain();
      if (mode !== this.chainMode) {
        this.chainMode = mode;
        // alignment lines were idle in SERIAL: start PARALLEL from empty lines (the dry fills in)
        // and let every branch fade in again, so its weight arrives as a ramp, not a step
        if (mode === 1) for (const s of this.chain) { const al = s.align; al.l.clear(); al.r.clear(); al.w.clear(); s.fade = 0; }
      }
    }
    // the effects' inputs fade too, so the switch is not recorded into their buffers and tails
    const inL = this.cinL, inR = this.cinR, xw = this.cinX, st = 1 / (0.005 * this.sr), down = this.pendingChain !== null || mode !== this.chainMode;
    for (let i = 0; i < n; i++) {
      if (down) { x -= st; if (x <= 0) { x = 0; this.chainHold++; } } else { x += st; if (x > 1) x = 1; }
      xw[i] = x; inL[i] = L[i]; inR[i] = R[i]; L[i] *= x; R[i] *= x;
    }
    this.chainX = x;
    const latency = this.runChainNow(L, R, n);
    for (let i = 0; i < n; i++) { const g = xw[i]; L[i] = inL[i] + (L[i] - inL[i]) * g; R[i] = inR[i] + (R[i] - inR[i]) * g; }
    return latency;
  }
  runChainNow(L, R, n) {
    const chain = this.chain, step = 1 / (0.01 * this.sr), mode = this.chainMode;
    let latency = 0;
    if (mode === 1) {
      // PARALLEL: every branch gets the chain input. Branch outputs and their on/off fades are
      // aligned to the slowest active branch, then summed: below one active branch the dry
      // fills in, above it the sum is normalised by sqrt(sum of fades).
      for (let k = 0; k < chain.length; k++) { const s = chain[k]; if (s.bank.v.on >= 0.5 || s.fade > 0) { const l = s.lat(); if (l > latency) latency = l; } }
      const aL = this.aL, aR = this.aR, aW = this.aW, pl = this.pL[0], pr = this.pR[0], fw = this.fw, D = this.parDry, tL = this.tL, tR = this.tR, tW = this.tW;
      aL.fill(0, 0, n); aR.fill(0, 0, n); aW.fill(0, 0, n);
      for (let k = 0; k < chain.length; k++) {
        const s = chain[k], al = s.align;
        al.set(latency - s.lat());
        if (s.bank.v.on < 0.5 && s.fade === 0) {
          s.wasOn = false; s.level *= 0.8;
          if (s.dly) { s.dly.set(s.lat()); s.dly.run(L, R, null, null, null, null, n, step); }
          al.run(null, null, null, tL, tR, tW, n, step); // drain
        } else {
          for (let i = 0; i < n; i++) { pl[i] = L[i]; pr[i] = R[i]; }
          this.runFx(s, pl, pr, n, true);
          for (let i = 0; i < n; i++) { const f = fw[i]; pl[i] *= f; pr[i] *= f; }
          al.run(pl, pr, fw, tL, tR, tW, n, step);
        }
        for (let i = 0; i < n; i++) { aL[i] += tL[i]; aR[i] += tR[i]; aW[i] += tW[i]; }
      }
      D.set(latency); D.run(L, R, null, tL, tR, null, n, step);
      for (let i = 0; i < n; i++) {
        const w = aW[i];
        if (w < 1) { L[i] = tL[i] * (1 - w) + aL[i]; R[i] = tR[i] * (1 - w) + aR[i]; }
        else { const g = 1 / Math.sqrt(w); L[i] = aL[i] * g; R[i] = aR[i] * g; }
      }
      return latency;
    }
    this.parDry.run(L, R, null, null, null, null, n, step); // keeps PARALLEL's dry line current
    for (let k = 0; k < chain.length; k++) {
      const s = chain[k];
      if (s.bank.v.on < 0.5 && s.fade === 0) {
        s.wasOn = false; s.level *= 0.8;
        // keep the dry compensation line filled so switching on is seamless
        if (s.dly) { s.dly.set(s.lat()); s.dly.run(L, R, null, null, null, null, n, step); }
        continue;
      }
      this.runFx(s, L, R, n, false);
      latency += s.lat();
    }
    return latency;
  }

  // one effect slot: wet/dry MIX, GAIN, 10 ms ON/OFF fade, NaN guard, dry latency compensation.
  // Serial: writes the faded result into L/R. Parallel (par): writes the unfaded branch output
  // and leaves the per-sample fade in this.fw.
  runFx(s, L, R, n, par) {
    const v = s.bank.v, on = v.on >= 0.5, inst = s.ensure();
    if (on && !s.wasOn && s.fade === 0) inst.reset();
    s.wasOn = on;
    const dryL = s.dryL, dryR = s.dryR, step = 1 / (0.01 * this.sr), fw = this.fw;
    for (let i = 0; i < n; i++) { dryL[i] = L[i]; dryR[i] = R[i]; }
    let bad = false;
    try { inst.process(L, R, n, v, this.ctx); }
    catch (e) { bad = true; s.error = String(e && e.message || e); }
    if (!bad) for (let i = 0; i < n; i++) { const wl = L[i], wr = R[i]; if (!(wl === wl) || !(wr === wr) || Math.abs(wl) > 1e4 || Math.abs(wr) > 1e4) { bad = true; inst.reset(); break; } }
    // dry, delayed by the effect's latency (tL/tR)
    const dd = s.dly, tL = this.tL, tR = this.tR;
    if (dd) { dd.set(s.lat()); dd.run(dryL, dryR, null, tL, tR, null, n, step); }
    else for (let i = 0; i < n; i++) { tL[i] = dryL[i]; tR[i] = dryR[i]; }
    if (bad) { // drop the block (dry passes)
      for (let i = 0; i < n; i++) { if (par) { L[i] = tL[i]; R[i] = tR[i]; fw[i] = s.fade; } else { L[i] = dryL[i]; R[i] = dryR[i]; } }
      return;
    }
    const mixT = v.mix / 100, gT = dbToGain(v.gain), kg = 1 - Math.exp(-1 / (0.01 * this.sr));
    let fade = s.fade, mx = s.mixS < 0 ? mixT : s.mixS, gain = s.gain, lev = 0;
    for (let i = 0; i < n; i++) {
      const dl = dryL[i], dr = dryR[i], ddl = tL[i], ddr = tR[i];
      if (on) { fade += step; if (fade > 1) fade = 1; } else { fade -= step; if (fade < 0) fade = 0; }
      gain += (gT - gain) * kg; mx += (mixT - mx) * kg;
      const wl = L[i] * gain, wr = R[i] * gain;
      lev += wl * wl + wr * wr;
      const yl = ddl + (wl - ddl) * mx, yr = ddr + (wr - ddr) * mx; // effect at full level
      if (par) { L[i] = yl; R[i] = yr; fw[i] = fade; }
      else { L[i] = dl + (yl - dl) * fade; R[i] = dr + (yr - dr) * fade; } // fades against the undelayed input
    }
    s.fade = fade; s.mixS = mx; s.gain = gain;
    s.level = Math.max(s.level * 0.9, Math.sqrt(lev / (2 * n)));
  }

  processMain(L, R, n, latency) {
    const v = this.banks.main.v, sr = this.sr;
    if (v.low !== this.eqLow || v.mid !== this.eqMid || v.high !== this.eqHigh) {
      this.eqLow = v.low; this.eqMid = v.mid; this.eqHigh = v.high;
      for (let c = 0; c < 2; c++) { this.eq[c][0].lowShelf(200, v.low, sr); this.eq[c][1].peak(1000, 0.7, v.mid, sr); this.eq[c][2].highShelf(5000, v.high, sr); }
    }
    if (Math.abs(v.low) > 0.05 || Math.abs(v.mid) > 0.05 || Math.abs(v.high) > 0.05) { this.eqRun(L, this.eq[0], n); this.eqRun(R, this.eq[1], n); }
    const th = (clamp(v.pan / 100, -1, 1) + 1) * Math.PI / 4;
    const gT = dbToGain(v.gain), glT = gT * Math.min(1, Math.cos(th) * Math.SQRT2), grT = gT * Math.min(1, Math.sin(th) * Math.SQRT2);
    const mixT = v.mix / 100, byT = v.bypass >= 0.5 ? 1 : 0;
    const comp = v.comp / 100, auto = v.auto / 100, useComp = comp > 0.001, useAuto = auto > 0.001;
    const thr = dbToGain(-6 - comp * 24), ratio = 1 + comp * 7, makeup = dbToGain(comp * 10), expo = 1 / ratio - 1;
    const att = Math.exp(-1 / (0.005 * sr)), rel = Math.exp(-1 / (0.15 * sr));
    // dry (original source) for master MIX, latency compensated (tL/tR)
    const md = this.mainDly, tL = this.tL, tR = this.tR, dL = this.dL, dR = this.dR;
    md.set(latency); md.run(dL, dR, null, tL, tR, null, n, 1 / (0.01 * sr));
    const sc = 1 - Math.exp(-1 / (0.03 * sr)), sb = 1 - Math.exp(-1 / (0.01 * sr));
    if (this.mgL < 0) { this.mgL = glT; this.mgR = grT; }
    let sumIn = 0, sumOut = 0, env = this.compEnv, mgL = this.mgL, mgR = this.mgR, mx = this.mixV, by = this.byV;
    const ag = this.autoG;
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (useComp) {
        const al = l < 0 ? -l : l, ar = r < 0 ? -r : r, pk = al > ar ? al : ar;
        env = pk > env ? pk + att * (env - pk) : pk + rel * (env - pk);
        const g = (env > thr ? Math.pow(env / thr, expo) : 1) * makeup;
        l *= g; r *= g;
      }
      mgL += (glT - mgL) * sc; mgR += (grT - mgR) * sc;
      l *= mgL; r *= mgR;
      const dl = tL[i], dr = tR[i];
      if (useAuto) { sumIn += dl * dl + dr * dr; sumOut += l * l + r * r; l *= ag; r *= ag; }
      mx += (mixT - mx) * sc; by += (byT - by) * sb;
      l = dl + (l - dl) * mx; r = dr + (r - dr) * mx;
      L[i] = l + (dL[i] - l) * by; R[i] = r + (dR[i] - r) * by;
    }
    this.compEnv = env; this.mgL = mgL; this.mgR = mgR; this.mixV = mx; this.byV = by;
    // auto-gain: match long-term loudness of the wet signal to the dry input (block rate)
    if (useAuto) {
      const c = 1 - Math.exp(-n / (1.5 * sr));
      this.rmsIn += (sumIn / n - this.rmsIn) * c; this.rmsOut += (sumOut / n - this.rmsOut) * c;
      const want = clamp(Math.sqrt((this.rmsIn + 1e-7) / (this.rmsOut + 1e-7)), 0.125, 8);
      this.autoG += (Math.pow(want, auto) - this.autoG) * (1 - Math.exp(-n / (0.4 * sr)));
    }
  }
  // MAIN EQ: low shelf -> bell -> high shelf on one channel (TDF-II, state kept in locals)
  eqRun(X, q, n) {
    const a = q[0], b = q[1], c = q[2];
    const a0 = a.b0, a1 = a.b1, a2 = a.b2, a3 = a.a1, a4 = a.a2, b0 = b.b0, b1 = b.b1, b2 = b.b2, b3 = b.a1, b4 = b.a2, c0 = c.b0, c1 = c.b1, c2 = c.b2, c3 = c.a1, c4 = c.a2;
    let az1 = a.z1, az2 = a.z2, bz1 = b.z1, bz2 = b.z2, cz1 = c.z1, cz2 = c.z2;
    for (let i = 0; i < n; i++) {
      const x = X[i];
      const y = a0 * x + az1; az1 = a1 * x - a3 * y + az2; az2 = a2 * x - a4 * y;
      const u = b0 * y + bz1; bz1 = b1 * y - b3 * u + bz2; bz2 = b2 * y - b4 * u;
      const w = c0 * u + cz1; cz1 = c1 * u - c3 * w + cz2; cz2 = c2 * u - c4 * w;
      X[i] = w;
    }
    a.z1 = az1; a.z2 = az2; b.z1 = bz1; b.z2 = bz2; c.z1 = cz1; c.z2 = cz2;
  }

  // Peak envelope of a stretch of an engine ring buffer: `bins` values 0..1, or -1 where the
  // region lies in the future (not recorded yet). Strided reads keep this cheap (~3k reads).
  static env(ring, start, len, bins) {
    const out = new Array(bins), L = ring.L, R = ring.R, m = ring.mask, w = ring.w - 1;
    start = Math.floor(start); len = Math.max(bins, Math.floor(len));
    for (let b = 0; b < bins; b++) {
      const a = start + Math.floor(b * len / bins), e = start + Math.floor((b + 1) * len / bins);
      if (a > w) { out[b] = -1; continue; }
      const stop = Math.min(e, w + 1), step = Math.max(1, Math.floor((stop - a) / 48));
      let pk = 0;
      for (let i = a; i < stop; i += step) { const j = i & m, v = Math.max(Math.abs(L[j]), Math.abs(R[j])); if (v > pk) pk = v; }
      out[b] = Math.round(Math.min(1, pk) * 1000) / 1000;
    }
    return out;
  }
  vizInfo() {
    const v = {}, B = 96;
    const sh = this.stretch;
    if (sh.fader.v > 0 && sh.chunkLen) {
      const rev = this.banks.stretch.v.rev >= 0.5, fz = sh.frozenLoop || 0, len = fz || sh.chunkLen;
      const start = rev && !fz ? sh.chunkStart - len : sh.chunkStart;
      const grains = [];
      for (const g of sh.grains) if (g.on) grains.push([(g.pos - start) / len, hann(g.t / g.dur), g.rate < 0 ? -1 : 1, (g.dur - g.t) * Math.abs(g.rate) / len]);
      const head = rev ? ((fz ? sh.chunkStart + fz : sh.chunkStart) - sh.readPos - start) / len : (sh.chunkStart + sh.readPos - start) / len;
      v.sh = { env: DebacleEngine.env(sh.ring, start, len, B), rec: Math.min(1, (sh.ring.w - start) / len), grains, frozen: fz > 0, rev, head };
    }
    const vr = this.vari;
    if (vr.fader.v > 0) {
      const span = Math.round(this.sr * 2), start = vr.ring.w - span;
      v.vr = { env: DebacleEngine.env(vr.ring, start, span, B), head: (vr.headA - start) / span, rate: vr.readRate };
    }
    const st = this.stutter;
    if (st.fader.v > 0) {
      if (st.state.bend) { const b = st.b; v.st = { env: DebacleEngine.env(st.ring, b.capStart, b.T, B), head: (st.va.pos - b.capStart) / (b.T || 1), live: st.ring.w - 1 < b.liveUntil }; }
      else v.st = { env: DebacleEngine.env(st.ring, st.sliceStart, st.sliceLen, B), head: (st.va.pos - st.sliceStart) / (st.sliceLen || 1) };
    }
    return v;
  }
  sendTick(latency) {
    const mods = {};
    for (const t of this.targets) mods[t.key] = t.bank.eff[t.i];
    const fxl = {};
    for (const s of this.chain) fxl[s.id] = [s.level, s.fade, s.error || null];
    this.post({
      type: 'tick', ppq: this.ctx.ppq, playing: this.playing, src: Array.from(this.srcVal), mods,
      peaks: Array.from(this.peaks), gr: this.gr, latency,
      st: Object.assign({}, this.stutter.state), sh: Object.assign({}, this.stretch.state), vr: this.vari.readRate,
      srcPos: this.src ? this.srcPos / this.src.len : 0, fx: fxl,
      engines: [this.stretch.fader.v, this.vari.fader.v, this.stutter.fader.v],
      viz: this.vizOn ? this.vizInfo() : null,
    });
    this.peaks.fill(0); this.gr = 0;
  }
}

// --------------------------------------------------------------- worklet glue
if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  class DebacleProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.engine = new DebacleEngine(sampleRate, (m) => {
        if (m.type === 'printed') this.port.postMessage(m, [m.L.buffer, m.R.buffer]); else this.port.postMessage(m);
      });
      this.port.onmessage = (e) => this.engine.handle(e.data);
      this.port.postMessage({ type: 'ready', sr: sampleRate });
    }
    process(inputs, outputs) {
      const out = outputs[0];
      if (!out || !out[0]) return true;
      const inp = inputs[0] && inputs[0].length ? inputs[0] : null;
      const n = out[0].length;
      this.engine.process(inp ? inp[0] : null, inp ? (inp[1] || inp[0]) : null, out[0], out[1] || out[0], n);
      return true;
    }
  }
  registerProcessor('debacle', DebacleProcessor);
}
