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

class FxSlot {
  constructor(cls, sr) {
    this.cls = cls; this.id = cls.id; this.sr = sr;
    this.bank = new ParamBank('fx.' + cls.id, HOST_FX_PARAMS().concat(cls.params.map((d) => Object.assign({}, d))));
    this.inst = null; this.fade = 0; this.wasOn = false; this.latency = cls.latency || 0;
    this.dryL = new Float32Array(128); this.dryR = new Float32Array(128);
    this.dly = null; this.level = 0; this.inChain = false;
    this.gain = 1;
  }
  ensure() {
    if (!this.inst) this.inst = new this.cls(this.sr);
    if (this.latency > 0 && !this.dly) { this.dly = [new DelayLine(this.latency + 8), new DelayLine(this.latency + 8)]; }
  }
}

class DebacleEngine {
  constructor(sr, post) {
    this.sr = sr; this.post = post;
    this.ctx = { sr, bpm: 120, spb: sr * 0.5, ppq: 0, playing: false, time: 0, blockSize: 128, key: new KeyHelper(), sidechain: null };
    // banks
    this.banks = {};
    for (const [k, u] of Object.entries(UNITS)) this.banks[k] = new ParamBank(k, u.params);
    this.fx = {};
    for (const cls of FX_REGISTRY) { const s = new FxSlot(cls, sr); this.fx[cls.id] = s; this.banks['fx.' + cls.id] = s.bank; }
    this.chain = [];   // ordered FxSlots
    // engines
    this.vari = new Varispeed(sr); this.stutter = new Stutter(sr); this.stretch = new Stretch(sr);
    this.seqs = { stutter: { pats: defaultSeq('stutter'), rate: 0.25, chain: 1 }, stretch: { pats: defaultSeq('stretch'), rate: 0.5, chain: 1 } };
    // modulation
    this.slots = []; this.targets = []; this.srcVal = new Float32Array(MOD_SOURCE_IDS.length);
    this.graphs = DEFAULT_GRAPHS.map((g) => g.map((p) => Object.assign({}, p)));
    this.lfo = [0, 1, 2, 3].map((i) => ({ phase: 0, out: 0.5, sm: 0.5, last: -1, env: 0, rnd: new Rng(1234 + i * 77), lp: new OnePole(), hp: new OnePole(), cyc: -1, jit: 0, amp: 1 }));
    // source
    this.src = null; this.srcPos = 0; this.srcMode = 0; this.srcGain = 1; this.inGain = 1;
    this.playing = false; this.playSamples = 0; this.freeSamples = 0;
    // buffers
    this.bL = new Float32Array(128); this.bR = new Float32Array(128);
    this.dL = new Float32Array(128); this.dR = new Float32Array(128);      // dry (source) copy
    this.eL = new Float32Array(128); this.eR = new Float32Array(128);      // post-engine copy (env follower INTERNAL)
    this.pL = [new Float32Array(128), new Float32Array(128), new Float32Array(128)];
    this.pR = [new Float32Array(128), new Float32Array(128), new Float32Array(128)];
    this.aL = new Float32Array(128); this.aR = new Float32Array(128);
    this.seam = new Uint8Array(128);
    // main
    this.eq = [0, 1].map(() => [new Biquad(), new Biquad(), new Biquad()]);
    this.eqSig = '';
    this.mainDly = [new DelayLine(sr * 0.25), new DelayLine(sr * 0.25)];
    this.gainS = new Smoother(sr, 30, 1); this.panS = new Smoother(sr, 30, 0); this.mixS = new Smoother(sr, 30, 1); this.byS = new Smoother(sr, 10, 0);
    this.compEnv = 0; this.rmsIn = 1e-4; this.rmsOut = 1e-4; this.autoG = 1;
    this.limEnv = 0; this.gr = 0;
    this.engFade = { stretch: 0, vari: 0, stutter: 0 };
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
      case 'graph': this.graphs[m.i] = m.points.map((p) => ({ x: p.x, y: p.y, c: p.c || 0 })).sort((a, b) => a.x - b.x); break;
      case 'seq': this.seqs[m.which].pats = m.pats; break;
      case 'source': this.src = { L: m.L, R: m.R || m.L, len: m.L.length }; this.srcPos = this.playing ? this.srcPos % this.src.len : 0; break;
      case 'srcmode': this.srcMode = m.mode; break;
      case 'srcgain': this.srcGain = m.g; break;
      case 'bpm': this.setBpm(m.bpm); break;
      case 'play': this.setPlay(m.on); break;
      case 'print': this.startPrint(m.len); break;
      case 'resetfx': { const s = this.fx[m.id]; if (s && s.inst) s.inst.reset(); break; }
    }
  }
  setBpm(b) { this.ctx.bpm = clamp(b, 30, 300); this.ctx.spb = this.sr * 60 / this.ctx.bpm; }
  setPlay(on) {
    this.playing = !!on;
    if (on) { this.playSamples = 0; this.srcPos = 0; this.rearm(); }
  }
  rearm() {
    const st = this.stutter; st.cycle = null; st.seqStep = -1; st.b.cycle = null; st.b.captured = false; st.histW = st.ring.w;
    const sh = this.stretch; sh.chunk = null; sh.gIdx = null; sh.seqStep = -1;
    this.vari.win = -1;
  }
  setParam(k, n) {
    const dot = k.lastIndexOf('.');
    const bank = this.banks[k.slice(0, dot)];
    if (!bank) return;
    const i = bank.idx[k.slice(dot + 1)];
    if (i === undefined) return;
    bank.setBase(i, clamp(+n, 0, 1));
  }
  setChain(ids) {
    for (const s of this.chain) s.inChain = false;
    this.chain = ids.map((id) => this.fx[id]).filter(Boolean);
    for (const s of this.chain) { s.inChain = true; }
  }
  setSlots(slots) {
    // restore previously modulated params
    for (const t of this.targets) { t.bank.mod[t.i] = 0; t.bank.setBase(t.i, t.bank.base[t.i]); }
    this.slots = slots;
    const map = new Map();
    for (const s of slots) {
      const dot = s.target.lastIndexOf('.');
      const bank = this.banks[s.target.slice(0, dot)];
      if (!bank) continue;
      const i = bank.idx[s.target.slice(dot + 1)];
      const si = MOD_SOURCE_IDS.indexOf(s.src);
      if (i === undefined || si < 0) continue;
      let t = map.get(s.target);
      if (!t) { t = { key: s.target, bank, i, slots: [] }; map.set(s.target, t); }
      t.slots.push({ si, min: s.min, max: s.max, start: s.start ?? 0, end: s.end ?? 1, skew: s.skew || 0, shape: s.shape | 0 });
    }
    this.targets = [...map.values()];
    for (const t of this.targets) t.bank.mod[t.i] = 1;
  }
  startPrint(len) {
    const n = Math.min(Math.floor(len), this.sr * 32);
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
      const v = this.banks['lfo' + (i + 1)].v, st = this.lfo[i];
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
        if (v.free >= 0.5) { st.phase += v.hz * n / sr; pos = st.phase; }
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
    const speeds = [0.25, 0.5, 1, 2, 4];
    for (let g = 0; g < 3; g++) {
      const v = this.banks['graph' + (g + 1)].v;
      let x = ppq * speeds[v.speed] / v.len;
      if (v.dir === 1) x = 1 - (x - Math.floor(x));
      else if (v.dir === 2) { const q = (x / 2) - Math.floor(x / 2); x = q < 0.5 ? q * 2 : 2 - q * 2; }
      this.srcVal[4 + g] = clamp(evalGraph(this.graphs[g], x), 0, 1);
    }
    const pf = this.banks.perform.eff;
    for (let k = 0; k < 6; k++) this.srcVal[7 + k] = pf[k];
  }
  applyMods() {
    const sv = this.srcVal;
    for (let t = 0; t < this.targets.length; t++) {
      const tg = this.targets[t]; let acc = 0;
      for (let s = 0; s < tg.slots.length; s++) acc += DebacleEngine.slotMap(sv[tg.slots[s].si], tg.slots[s]);
      tg.bank.setEff(tg.i, clamp(acc / tg.slots.length, 0, 1));
    }
  }

  // ------------------------------------------------------------------- render
  process(inL, inR, outL, outR, n) {
    const ctx = this.ctx, sr = this.sr;
    // clock
    if (this.playing) ctx.ppq = this.playSamples / ctx.spb; else ctx.ppq = this.freeSamples / ctx.spb;
    ctx.playing = this.playing; ctx.time += n;
    // key
    const kv = this.banks.key.v;
    const sig = kv.root * 1000 + kv.scale * 100 + kv.chord * 10 + kv.csize;
    if (sig !== this.keySig) { this.keySig = sig; ctx.key.set(kv.root, SCALE_NAMES[kv.scale], kv.chord, kv.csize); }
    // modulation (sources computed from the previous block's signals)
    this.applyMods();
    this.seqs.stutter.rate = this.banks.sseq.v.rate; this.seqs.stutter.chain = this.banks.sseq.v.chain;
    this.seqs.stretch.rate = this.banks.tseq.v.rate; this.seqs.stretch.chain = this.banks.tseq.v.chain;

    // source
    const L = this.bL, R = this.bR;
    const src = this.src;
    for (let i = 0; i < n; i++) {
      let l = 0, r = 0;
      this.seam[i] = 0;
      if (this.playing && src && this.srcMode !== 1) {
        const p = this.srcPos;
        this.seam[i] = p === 0 ? 1 : 0;
        l = src.L[p]; r = src.R[p];
        // 3 ms crossfade at the loop seam
        const fadeN = 144;
        if (src.len > fadeN * 4 && p < fadeN) { const t = p / fadeN, q = src.len - fadeN + p; l = l * t + src.L[q] * (1 - t); r = r * t + src.R[q] * (1 - t); }
        this.srcPos = p + 1 >= src.len ? 0 : p + 1;
        l *= this.srcGain; r *= this.srcGain;
      }
      if (this.srcMode !== 0 && inL) { l += inL[i] * this.inGain; r += (inR || inL)[i] * this.inGain; }
      L[i] = l; R[i] = r; this.dL[i] = l; this.dR[i] = r;
    }

    // time engines
    const order = this.banks.time.v.order;
    const bs = this.banks.stretch.v, bv = this.banks.vari.v, bt = this.banks.stutter.v, bb = this.banks.bend.v;
    const runStretch = (a, b) => this.stretch.process(a, b, n, bs, this.seqs.stretch, ctx);
    const runVari = (a, b) => this.vari.process(a, b, n, bv, ctx);
    const runStutter = (a, b) => this.stutter.process(a, b, n, bt, bb, this.seqs.stutter, ctx);
    if (order === 3) {
      const runs = [runStretch, runVari, runStutter];
      const ons = [bs.on >= 0.5 || this.stretch.fader.v > 0, bv.on >= 0.5 || this.vari.fader.v > 0, bt.on >= 0.5 || this.stutter.fader.v > 0];
      let cnt = 0; this.aL.fill(0, 0, n); this.aR.fill(0, 0, n);
      for (let e = 0; e < 3; e++) {
        const pl = this.pL[e], pr = this.pR[e];
        pl.set(L.subarray(0, n)); pr.set(R.subarray(0, n));
        runs[e](pl, pr); // always run (keeps buffers recording); off engines return dry
        if (ons[e]) { cnt++; for (let i = 0; i < n; i++) { this.aL[i] += pl[i]; this.aR[i] += pr[i]; } }
      }
      if (cnt) { const g = 1 / cnt; for (let i = 0; i < n; i++) { L[i] = this.aL[i] * g; R[i] = this.aR[i] * g; } }
    } else {
      const seqOrder = order === 0 ? [runStretch, runVari, runStutter] : order === 1 ? [runVari, runStretch, runStutter] : [runStutter, runStretch, runVari];
      for (const f of seqOrder) f(L, R);
    }
    for (let i = 0; i < n; i++) { this.eL[i] = L[i]; this.eR[i] = R[i]; }

    // FX chain
    let latency = 0;
    const parallel = this.banks.chain.v.mode === 1;
    if (parallel) {
      let cnt = 0; this.aL.fill(0, 0, n); this.aR.fill(0, 0, n);
      const pl = this.pL[0], pr = this.pR[0];
      for (const s of this.chain) {
        const v = s.bank.v;
        if (v.on < 0.5 && s.fade === 0) { s.wasOn = false; s.level *= 0.8; continue; }
        pl.set(L.subarray(0, n)); pr.set(R.subarray(0, n));
        this.runFx(s, pl, pr, n);
        cnt++; for (let i = 0; i < n; i++) { this.aL[i] += pl[i]; this.aR[i] += pr[i]; }
        if (s.latency > latency) latency = s.latency;
      }
      if (cnt) { const g = 1 / Math.sqrt(cnt); for (let i = 0; i < n; i++) { L[i] = this.aL[i] * g; R[i] = this.aR[i] * g; } }
    } else {
      for (const s of this.chain) {
        const v = s.bank.v;
        if (v.on < 0.5 && s.fade === 0) { s.wasOn = false; s.level *= 0.8; continue; }
        this.runFx(s, L, R, n);
        latency += s.latency;
      }
    }

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
    if (this.playing) this.playSamples += n; else this.freeSamples += n;
    // telemetry
    this.tick += n;
    if (this.tick >= this.tickN) { this.tick = 0; this.sendTick(latency); }
  }

  runFx(s, L, R, n) {
    const v = s.bank.v, on = v.on >= 0.5;
    s.ensure();
    if (on && !s.wasOn) { if (s.fade === 0) s.inst.reset(); if (s.dly) { s.dly[0].clear(); s.dly[1].clear(); } }
    s.wasOn = on;
    const dryL = s.dryL, dryR = s.dryR;
    for (let i = 0; i < n; i++) { dryL[i] = L[i]; dryR[i] = R[i]; }
    try { s.inst.process(L, R, n, v, this.ctx); }
    catch (e) { for (let i = 0; i < n; i++) { L[i] = dryL[i]; R[i] = dryR[i]; } s.error = String(e && e.message || e); return; }
    const step = 1 / (0.01 * this.sr) ;
    const mix = v.mix / 100, gT = dbToGain(v.gain);
    let fade = s.fade, bad = false, lev = 0;
    for (let i = 0; i < n; i++) {
      let wl = L[i], wr = R[i];
      if (!(wl === wl) || !(wr === wr) || Math.abs(wl) > 1e4 || Math.abs(wr) > 1e4) { bad = true; break; }
      let dl = dryL[i], dr = dryR[i];
      if (s.dly) { s.dly[0].write(dl); s.dly[1].write(dr); dl = s.dly[0].tap(s.latency); dr = s.dly[1].tap(s.latency); }
      if (on) { fade += step; if (fade > 1) fade = 1; } else { fade -= step; if (fade < 0) fade = 0; }
      s.gain += (gT - s.gain) * 0.002;
      const m = mix * fade;
      wl *= s.gain; wr *= s.gain;
      L[i] = dl + (wl - dl) * m; R[i] = dr + (wr - dr) * m;
      lev += wl * wl + wr * wr;
    }
    if (bad) { // NaN / Inf guard: drop the block, reset the effect
      for (let i = 0; i < n; i++) { L[i] = dryL[i]; R[i] = dryR[i]; }
      s.inst.reset(); return;
    }
    s.fade = fade;
    s.level = Math.max(s.level * 0.9, Math.sqrt(lev / (2 * n)));
  }

  processMain(L, R, n, latency) {
    const v = this.banks.main.v, sr = this.sr;
    const sig = v.low + ',' + v.mid + ',' + v.high;
    if (sig !== this.eqSig) {
      this.eqSig = sig;
      for (let c = 0; c < 2; c++) { this.eq[c][0].lowShelf(200, v.low, sr); this.eq[c][1].peak(1000, 0.7, v.mid, sr); this.eq[c][2].highShelf(5000, v.high, sr); }
    }
    const eqOn = Math.abs(v.low) > 0.05 || Math.abs(v.mid) > 0.05 || Math.abs(v.high) > 0.05;
    this.gainS.set(dbToGain(v.gain)); this.panS.set(v.pan / 100); this.mixS.set(v.mix / 100); this.byS.set(v.bypass >= 0.5 ? 1 : 0);
    const comp = v.comp / 100, auto = v.auto / 100;
    const thr = dbToGain(-6 - comp * 24), ratio = 1 + comp * 7, makeup = dbToGain(comp * 10);
    const att = Math.exp(-1 / (0.005 * sr)), rel = Math.exp(-1 / (0.15 * sr));
    const rmsC = 1 - Math.exp(-1 / (1.5 * sr));
    const dlat = Math.min(latency, this.mainDly[0].size - 8);
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (eqOn) { const e0 = this.eq[0], e1 = this.eq[1]; l = e0[2].process(e0[1].process(e0[0].process(l))); r = e1[2].process(e1[1].process(e1[0].process(r))); }
      if (comp > 0.001) {
        const pk = Math.max(Math.abs(l), Math.abs(r));
        this.compEnv = pk > this.compEnv ? pk + att * (this.compEnv - pk) : pk + rel * (this.compEnv - pk);
        const g = (this.compEnv > thr ? Math.pow(this.compEnv / thr, 1 / ratio - 1) : 1) * makeup;
        l *= g; r *= g;
      }
      const g = this.gainS.next();
      const pan = this.panS.next(), th = (pan + 1) * Math.PI / 4;
      l *= g * Math.min(1, Math.cos(th) * Math.SQRT2); r *= g * Math.min(1, Math.sin(th) * Math.SQRT2);
      // dry (original source) for master MIX, latency compensated
      this.mainDly[0].write(this.dL[i]); this.mainDly[1].write(this.dR[i]);
      const dl = dlat ? this.mainDly[0].tap(dlat) : this.dL[i], dr = dlat ? this.mainDly[1].tap(dlat) : this.dR[i];
      // auto-gain: match long-term loudness of wet to the dry input
      if (auto > 0.001) {
        this.rmsIn += (dl * dl + dr * dr - this.rmsIn) * rmsC; this.rmsOut += (l * l + r * r - this.rmsOut) * rmsC;
        const want = clamp(Math.sqrt((this.rmsIn + 1e-7) / (this.rmsOut + 1e-7)), 0.125, 8);
        this.autoG += (Math.pow(want, auto) - this.autoG) * 0.0005;
        l *= this.autoG; r *= this.autoG;
      }
      const m = this.mixS.next();
      l = dl + (l - dl) * m; r = dr + (r - dr) * m;
      const by = this.byS.next();
      L[i] = l + (this.dL[i] - l) * by; R[i] = r + (this.dR[i] - r) * by;
    }
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
