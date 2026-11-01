// ============================================================================
// DEBACLE — FX bank "MOTION": filters, modulation and movement effects.
//   eq multifilter combs vowel swirl chorus ensemble flanger phaser ringmod
//   autopan tremolo freqshift doppler disperse radio
// Everything lives inside one IIFE: nothing but the registered classes leaves
// this file. Helpers carry a MOT_ prefix for readability.
//
// Shared conventions of this bank
//   * LFO effects use the param triplet  sync (toggle) / div (tempo division,
//     beats) / rate (free Hz).  When synced, the LFO phase is locked to
//     ctx.ppq: delay/filter effects pull towards the grid with a soft PLL
//     (no clicks when DIV changes or the transport jumps), gain effects
//     (tremolo, autopan) lock hard.
//   * Swept filters use ZDF SVFs; coefficients are recomputed per sample or
//     per small sub-block with a cheap rational tan() pre-warp.
// ============================================================================
(() => {
  'use strict';

  const MOT_LN2 = Math.LN2;
  const MOT_SQRT2 = Math.SQRT2;
  const MOT_QPI = Math.PI / 4;

  // NOTE on style: per-sample code avoids rarely-taken branches (clamps use Math.min/max)
  // so V8 never meets a path without type feedback and deoptimises mid-stream.
  // Rational tan approximation (Pade 3/2), good to ~1 % up to x≈1.3, monotonic to 1.49.
  function MOT_tan(x) { x = Math.min(x, 1.49); const x2 = x * x; return x * (15 - x2) / (15 - 6 * x2); }
  // Pre-warped integrator gain for a cutoff in Hz (clamped to a safe range).
  function MOT_g(fc, sr) { return MOT_tan(Math.PI * Math.max(5, Math.min(fc, sr * 0.47)) / sr); }
  // Branch-free variant of lib fastTanh (same Pade 7/6 core, clamped input).
  function MOT_tanh(x) {
    x = Math.max(-4.97, Math.min(4.97, x));
    const x2 = x * x;
    return (x * (135135 + x2 * (17325 + x2 * (378 + x2)))) / (135135 + x2 * (62370 + x2 * (3150 + x2 * 28)));
  }
  function MOT_frac(x) { return x - Math.floor(x); }
  function MOT_pow2(n) { let p = 4; while (p < n) p <<= 1; return p; }
  // 4-point hermite read from a power-of-two ring buffer. w = next write index,
  // d = delay in samples (d = 0 -> most recently written sample). Caller keeps 1 <= d < size-4.
  function MOT_rd(b, m, w, d) {
    const pos = w - 1 - d, i = Math.floor(pos), f = pos - i;
    const xm1 = b[(i - 1) & m], x0 = b[i & m], x1 = b[(i + 1) & m], x2 = b[(i + 2) & m];
    const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }

  // ---------------------------------------------------------------------------
  // LFO phase clock. block() returns the phase at the block start; per-sample
  // increment is in .inc. Synced: phase tracks ctx.ppq / beats (hard or PLL).
  // ---------------------------------------------------------------------------
  class MOT_LFO {
    constructor() { this.ph = 0; this.inc = 0; this.fresh = true; }
    reset() { this.ph = 0; this.fresh = true; }
    block(sync, beats, hz, ctx, n, sr, hard) {
      let inc;
      if (sync) {
        const b = beats > 1e-4 ? beats : 1e-4;
        inc = 1 / (b * ctx.spb);
        const x = ctx.ppq / b, tgt = x - Math.floor(x);
        if (this.fresh || hard) this.ph = tgt;
        else {
          let err = tgt - this.ph; err -= Math.round(err);
          let lim = 0.5 * inc * n; const lim2 = 0.5 * n / sr; if (lim2 > lim) lim = lim2;
          let c = err * 0.3; if (c > lim) c = lim; else if (c < -lim) c = -lim;
          inc += c / n;
        }
      } else inc = hz / sr;
      this.fresh = false; this.inc = inc;
      const s = this.ph, e = s + inc * n; this.ph = e - Math.floor(e);
      return s;
    }
  }

  // ---------------------------------------------------------------------------
  // Simper SVF with Cytomic output mixing: y = m0*x + m1*band + m2*low.
  // ---------------------------------------------------------------------------
  class MOT_SVF {
    constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 1; this.a2 = 0; this.a3 = 0; this.k = 1.414; this.m0 = 1; this.m1 = 0; this.m2 = 0; }
    coef(g, k) { const a1 = 1 / (1 + g * (g + k)); this.k = k; this.a1 = a1; this.a2 = g * a1; this.a3 = g * g * a1; }
    lp(g, q) { this.coef(g, 1 / q); this.m0 = 0; this.m1 = 0; this.m2 = 1; }
    hp(g, q) { const k = 1 / q; this.coef(g, k); this.m0 = 1; this.m1 = -k; this.m2 = -1; }
    run(x) {
      const ic1 = this.ic1, ic2 = this.ic2;
      const v3 = x - ic2, v1 = this.a1 * ic1 + this.a2 * v3, v2 = ic2 + this.a2 * ic1 + this.a3 * v3;
      this.ic1 = 2 * v1 - ic1; this.ic2 = 2 * v2 - ic2;
      return this.m0 * x + this.m1 * v1 + this.m2 * v2;
    }
    reset() { this.ic1 = this.ic2 = 0; }
  }
  // type: 0 low shelf, 1 bell, 2 high shelf, 3 HP, 4 LP
  function MOT_eqSet(f, type, fc, db, q, sr) {
    const t = Math.tan(Math.PI * clamp(fc, 5, sr * 0.47) / sr);
    const A = Math.pow(10, db / 40);
    let g = t, k = 1 / q;
    if (type === 0) { g = t / Math.sqrt(A); f.m0 = 1; f.m1 = k * (A - 1); f.m2 = A * A - 1; }
    else if (type === 1) { k = 1 / (q * A); f.m0 = 1; f.m1 = k * (A * A - 1); f.m2 = 0; }
    else if (type === 2) { g = t * Math.sqrt(A); f.m0 = A * A; f.m1 = k * (1 - A) * A; f.m2 = 1 - A * A; }
    else if (type === 3) { f.m0 = 1; f.m1 = -k; f.m2 = -1; }
    else { f.m0 = 0; f.m1 = 0; f.m2 = 1; }
    f.coef(g, k);
  }

  // ---------------------------------------------------------------------------
  // 90° phase-splitter: two 4-stage 2nd-order allpass chains (Niemitalo).
  // After process(x): .re / .im form the analytic signal.
  // ---------------------------------------------------------------------------
  const MOT_HA0 = 0.6923878 ** 2, MOT_HA1 = 0.9360654322959 ** 2, MOT_HA2 = 0.9882295226860 ** 2, MOT_HA3 = 0.9987488452737 ** 2;
  const MOT_HB0 = 0.4021921162426 ** 2, MOT_HB1 = 0.8561710882420 ** 2, MOT_HB2 = 0.9722909545651 ** 2, MOT_HB3 = 0.9952884791278 ** 2;
  class MOT_Hilbert {
    constructor() { this.s = new Float64Array(34); this.re = 0; this.im = 0; }
    reset() { this.s.fill(0); this.re = this.im = 0; }
    // each stage: y = c*(x + y[n-2]) - x[n-2]; state per stage: x1, x2, y1, y2 (unrolled, constant indices)
    process(x) {
      const s = this.s;
      let y = MOT_HA0 * (x + s[3]) - s[1]; s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y; let a = y;
      y = MOT_HA1 * (a + s[7]) - s[5]; s[5] = s[4]; s[4] = a; s[7] = s[6]; s[6] = y; a = y;
      y = MOT_HA2 * (a + s[11]) - s[9]; s[9] = s[8]; s[8] = a; s[11] = s[10]; s[10] = y; a = y;
      y = MOT_HA3 * (a + s[15]) - s[13]; s[13] = s[12]; s[12] = a; s[15] = s[14]; s[14] = y;
      this.re = s[32]; s[32] = y;
      y = MOT_HB0 * (x + s[19]) - s[17]; s[17] = s[16]; s[16] = x; s[19] = s[18]; s[18] = y; a = y;
      y = MOT_HB1 * (a + s[23]) - s[21]; s[21] = s[20]; s[20] = a; s[23] = s[22]; s[22] = y; a = y;
      y = MOT_HB2 * (a + s[27]) - s[25]; s[25] = s[24]; s[24] = a; s[27] = s[26]; s[26] = y; a = y;
      y = MOT_HB3 * (a + s[31]) - s[29]; s[29] = s[28]; s[28] = a; s[31] = s[30]; s[30] = y;
      this.im = -y; // sign chosen so that re*cos - im*sin shifts UP for positive frequencies
    }
  }

  // Per-block parameter smoother: every numeric param glides with a one-pole (~20 ms at block
  // rate) before the effect sees it; enums, toggles and tempo divisions pass through untouched.
  // Gains that act directly on the signal are additionally ramped per sample inside the kernels.
  class MOT_PSm {
    constructor(params, ms) {
      this.all = []; this.num = [];
      for (const d of params) { this.all.push(d.id); if (!d.options && !d.toggle && !d.div) this.num.push(d.id); }
      this.s = new Float64Array(this.num.length); this.v = {}; this.first = true; this.ms = ms || 20;
      for (const id of this.all) this.v[id] = 0;
    }
    step(p, n, sr) {
      const v = this.v, s = this.s, num = this.num, all = this.all;
      const c = this.first ? 1 : 1 - Math.exp(-n / (this.ms * 0.001 * sr));
      for (let j = 0; j < all.length; j++) v[all[j]] = p[all[j]];
      for (let j = 0; j < num.length; j++) {
        const t = p[num[j]];
        let x = s[j] + (t - s[j]) * c;
        if (Math.abs(t - x) <= 1e-7 * (1 + Math.abs(t))) x = t;
        s[j] = x; v[num[j]] = x;
      }
      this.first = false;
      return v;
    }
  }

  // Click-free stage count (phaser stages, swirl sections, disperse amount): the count glides at most
  // `rate` stages per block and never crosses an integer inside a block. Per block the kernel runs
  // `n` full stages plus stage `n` blended in with a weight ramping f0 -> f1.
  class MOT_FracCount {
    constructor() { this.v = -1; this.n = 0; this.f0 = 0; this.f1 = 0; }
    step(target, max, rate) {
      target = Math.max(0, Math.min(max, target));
      if (this.v < 0) this.v = target;
      const v0 = this.v, up = target >= v0;
      if (up && v0 >= max) { this.n = max - 1; this.f0 = this.f1 = 1; this.v = max; return this.n; }
      const base = up ? Math.floor(v0) : Math.ceil(v0) - 1;
      const v1 = Math.max(base, Math.min(base + 1, v0 + Math.max(-rate, Math.min(rate, target - v0))));
      this.n = base; this.f0 = v0 - base; this.f1 = v1 - base; this.v = v1;
      return base;
    }
  }

  // Key-snap cache (KeyHelper.snapHz is a linear search; only redo it when needed)
  class MOT_Snap {
    constructor() { this.inp = -1; this.out = 0; this.notes = null; }
    hz(key, f) {
      if (f !== this.inp || key.notes !== this.notes) { this.inp = f; this.notes = key.notes; this.out = key.snapHz(f); }
      return this.out;
    }
  }

  // ===========================================================================
  // 1. EQ
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'eq';
    static label = 'EQ';
    static cat = 'FILTER';
    static desc = 'Three-band EQ (low shelf, bell, high shelf) with 24 dB/oct cut filters and a soft drive stage.';
    static latency = 0;
    static params = [
      { id: 'low', label: 'LOW', min: -18, max: 18, def: 4, unit: 'dB', bipolar: true },
      { id: 'mid', label: 'MID', min: -18, max: 18, def: -4, unit: 'dB', bipolar: true },
      { id: 'high', label: 'HIGH', min: -18, max: 18, def: 5, unit: 'dB', bipolar: true },
      { id: 'lowcut', label: 'LOW CUT', min: 20, max: 2000, def: 20, unit: 'Hz', curve: 'exp' },
      { id: 'hicut', label: 'HIGH CUT', min: 200, max: 20000, def: 20000, unit: 'Hz', curve: 'exp' },
      { id: 'drive', label: 'DRIVE', min: 0, max: 100, def: 15, unit: '%' },
      { id: 'lowf', label: 'LOW FREQ', min: 30, max: 800, def: 110, unit: 'Hz', curve: 'exp' },
      { id: 'midf', label: 'MID FREQ', min: 150, max: 10000, def: 700, unit: 'Hz', curve: 'exp' },
      { id: 'midq', label: 'MID Q', min: 0.3, max: 10, def: 0.8, curve: 'exp' },
      { id: 'highf', label: 'HIGH FREQ', min: 1000, max: 16000, def: 5000, unit: 'Hz', curve: 'exp' },
    ];
    init() {
      const sr = this.sr;
      this.co = new Float64Array(7 * 6);                       // stage coefs a1 a2 a3 m0 m1 m2 (shared L/R)
      this.st = [new Float64Array(16), new Float64Array(16)];  // per channel: 7 x (ic1, ic2), cut-filter mixes
      this.cur = new Float64Array(10); this.tg = new Float64Array(10);
      this.tmp = new MOT_SVF(); this.first = true;
      this.c16 = 1 - Math.exp(-16 / (0.02 * sr)); this.cmx = 1 - Math.exp(-1 / (0.005 * sr));
    }
    _coefs() {
      const sr = this.sr, cur = this.cur, co = this.co, f = this.tmp;
      const lcf = Math.exp(cur[3]), hcf = Math.exp(cur[4]);
      for (let j = 0; j < 7; j++) {
        if (j === 0) MOT_eqSet(f, 0, Math.exp(cur[6]), cur[0], 0.71, sr);
        else if (j === 1) MOT_eqSet(f, 1, Math.exp(cur[7]), cur[1], Math.exp(cur[8]), sr);
        else if (j === 2) MOT_eqSet(f, 2, Math.exp(cur[9]), cur[2], 0.71, sr);
        else if (j < 5) MOT_eqSet(f, 3, lcf, 0, j === 3 ? 0.5412 : 1.3066, sr);
        else MOT_eqSet(f, 4, hcf, 0, j === 5 ? 0.5412 : 1.3066, sr);
        const o = j * 6; co[o] = f.a1; co[o + 1] = f.a2; co[o + 2] = f.a3; co[o + 3] = f.m0; co[o + 4] = f.m1; co[o + 5] = f.m2;
      }
    }
    process(L, R, n, p) {
      // EQ smooths its own params (log domain for frequencies) and updates coefficients every 16 samples
      const cur = this.cur, tg = this.tg, c16 = this.c16;
      tg[0] = p.low; tg[1] = p.mid; tg[2] = p.high; tg[3] = Math.log(p.lowcut); tg[4] = Math.log(p.hicut);
      tg[5] = p.drive * 0.01; tg[6] = Math.log(p.lowf); tg[7] = Math.log(p.midf); tg[8] = Math.log(p.midq); tg[9] = Math.log(p.highf);
      if (this.first) { cur.set(tg); this._coefs(); this.first = false; }
      for (let off = 0; off < n; off += 16) {
        const e = Math.min(n, off + 16);
        let changed = false;
        for (let j = 0; j < 10; j++) {
          const d = tg[j] - cur[j];
          if (d === 0) continue;
          cur[j] = Math.abs(d) < 1e-5 ? tg[j] : cur[j] + d * c16; changed = true;
        }
        if (changed) this._coefs();
        const d = cur[5], dm = Math.min(1, d * 3), dg = 1 + 19 * d * d, dn = 0.5 / MOT_tanh(0.5 * dg);
        const lcT = cur[3] > 3.0204 ? 1 : 0, hcT = cur[4] < 9.8782 ? 1 : 0; // ln(20.5 Hz), ln(19.5 kHz)
        this._k(L, this.st[0], off, e, dm, dg, dn, lcT, hcT);
        this._k(R, this.st[1], off, e, dm, dg, dn, lcT, hcT);
      }
    }
    // shelf -> bell -> shelf -> drive -> 24 dB low cut -> 24 dB high cut (cuts cross-faded in/out)
    _k(buf, st, i0, i1, dm, dg, dn, lcT, hcT) {
      const co = this.co, cmx = this.cmx;
      let ml = st[14], mh = st[15];
      for (let i = i0; i < i1; i++) {
        let x = buf[i];
        for (let j = 0; j < 3; j++) {
          const o = j * 6, s = j * 2, ic1 = st[s], ic2 = st[s + 1];
          const v3 = x - ic2, v1 = co[o] * ic1 + co[o + 1] * v3, v2 = ic2 + co[o + 1] * ic1 + co[o + 2] * v3;
          st[s] = 2 * v1 - ic1; st[s + 1] = 2 * v2 - ic2;
          x = co[o + 3] * x + co[o + 4] * v1 + co[o + 5] * v2;
        }
        x += (MOT_tanh(x * dg) * dn - x) * dm;
        let y = x;
        for (let j = 3; j < 7; j++) {
          const o = j * 6, s = j * 2, ic1 = st[s], ic2 = st[s + 1];
          const v3 = y - ic2, v1 = co[o] * ic1 + co[o + 1] * v3, v2 = ic2 + co[o + 1] * ic1 + co[o + 2] * v3;
          st[s] = 2 * v1 - ic1; st[s + 1] = 2 * v2 - ic2;
          const out = co[o + 3] * y + co[o + 4] * v1 + co[o + 5] * v2;
          if (j === 4) { ml += (lcT - ml) * cmx; y = x + (out - x) * ml; x = y; }
          else if (j === 6) { mh += (hcT - mh) * cmx; y = x + (out - x) * mh; }
          else y = out;
        }
        buf[i] = y;
      }
      st[14] = ml; st[15] = mh;
    }
  });

  // ===========================================================================
  // 2. MULTIFILT — SVF / ladder / diode / broken cores, Xpander-style mode mixing
  // ===========================================================================
  // ladder tap mix [mode][slope] over (u, y1, y2, y3, y4)
  const MOT_XP = new Float64Array([
    0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1,          // LP 6/12/18/24
    0, 2, -2, 0, 0, 0, 2, -2, 0, 0, 0, 0, 2.6, -2.6, 0, 0, 0, 4, -8, 4,  // BP
    1, -1, 0, 0, 0, 1, -2, 1, 0, 0, 1, -3, 3, -1, 0, 1, -4, 6, -4, 1,    // HP
    1, -2, 2, 0, 0, 1, -2, 2, 0, 0, 1, -2, 2, 0, 0, 1, -4, 8, -8, 4,     // NOTCH
  ]);
  registerFX(class extends FX {
    static id = 'multifilter';
    static label = 'MULTIFILT';
    static cat = 'FILTER';
    static desc = 'Analog-style multimode filter with SVF, ladder, diode and broken-transistor cores, drive, audio-rate FM and drift.';
    static latency = 0;
    static params = [
      { id: 'cutoff', label: 'CUTOFF', min: 20, max: 20000, def: 650, unit: 'Hz', curve: 'exp' },
      { id: 'res', label: 'RES', min: 0, max: 100, def: 60, unit: '%' },
      { id: 'type', label: 'TYPE', options: ['SVF', 'LADDER', 'DIODE', 'BROKEN'], def: 1 },
      { id: 'mode', label: 'MODE', options: ['LP', 'BP', 'HP', 'NOTCH'], def: 0 },
      { id: 'drive', label: 'DRIVE', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'slope', label: 'SLOPE', options: ['6', '12', '18', '24'], def: 3 },
      { id: 'env', label: 'ENV', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
      { id: 'fm', label: 'FM', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'drift', label: 'DRIFT', min: 0, max: 100, def: 15, unit: '%' },
      { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      const sr = this.sr;
      this.s = [new Float64Array(6), new Float64Array(6)];
      // misc state: 0 smoothed ln(cutoff), 1..2 env L/R, 3..8 cached ladder G1/G2/G4 per channel, 9..10 cached SVF g,
      // 11 input gain, 12 output gain (both ramped per sample)
      this.S = new Float64Array(16); this.K = new Float64Array(24); this.S[11] = -1;
      this.lsc = 1 - Math.exp(-1 / (0.025 * sr)); this.ea = Math.exp(-1 / (0.002 * sr)); this.er = Math.exp(-1 / (0.15 * sr));
      this.first = true;
      this.dv = new Float64Array(2); this.dt = new Float64Array(2); this.dtm = new Int32Array(2);
      this.kj = new Float64Array(2); this.pop = new Float64Array(2);
      this.rng = new Rng(0x51f15e); this.snp = new MOT_Snap();
      const gh = Math.tan(Math.PI * 110 / sr); this.hpG = gh / (1 + gh);
      this.lastType = -1; this.lastTypeG = -1;
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const type = p.type | 0, mode = p.mode | 0, slope = p.slope | 0, S = this.S, K = this.K;
      if (type !== this.lastType) { this.s[0].fill(0); this.s[1].fill(0); this.lastType = type; }
      const res = p.res * 0.01, drv = p.drive * 0.01, drift = p.drift * 0.01;
      let fc = p.cutoff; if (p.snap) fc = this.snp.hz(ctx.key, fc);
      if (this.first) { S[0] = Math.log(fc); this.first = false; }
      const typeChanged = type !== this.lastTypeG; this.lastTypeG = type;
      const rng = this.rng, broken = type === 3;
      for (let c = 0; c < 2; c++) {
        if (--this.dtm[c] <= 0) { this.dt[c] = rng.bi(); this.dtm[c] = 40 + rng.int(160); }
        this.dv[c] += (this.dt[c] - this.dv[c]) * 0.015;
        if (broken) { this.kj[c] += (rng.bi() - this.kj[c]) * 0.08; if (rng.chance(0.04)) this.pop[c] = rng.bi(); }
      }
      const dS = (broken ? 0.9 : 0.5) * MOT_LN2 * drift, dr = 1 + 9 * drv * drv;
      const envA = p.env * 0.01 * 4 * MOT_LN2, fm = p.fm * 0.01 * 3 * MOT_LN2;
      // common block constants
      K[0] = Math.log(fc); K[1] = this.dv[0] * dS; K[2] = this.dv[1] * dS; K[3] = dr; K[4] = 1 / Math.pow(dr, 0.55);
      K[5] = envA; K[6] = fm; K[7] = envA !== 0 || broken ? 1 : 0; K[8] = mode; K[9] = slope;
      if (type === 0) {
        const kB = 1.414 * Math.pow(1 - res, 1.3) - 0.1 * Math.pow(res, 8);
        K[10] = kB; K[11] = 1.5 * Math.max(kB, 0.03);
        K[12] = slope === 3 || ((mode === 1 || mode === 3) && slope === 2) ? 1 : 0;
        K[13] = slope === 2 && (mode === 0 || mode === 2) ? 1 : 0;
        if (S[11] < 0 || typeChanged) { S[11] = dr; S[12] = K[4]; }
        this._svf(L, R, n);
        return;
      }
      // self-oscillation: ladder above ~95 % RES; diode threshold rises at low cutoff (HP in the feedback path)
      const rr = res * Math.sqrt(res), diode = type === 2, k0 = diode ? 5.8 * rr : 4.5 * rr;
      let cm = 1;
      if (mode === 0) cm = diode ? 1 + 0.45 * k0 : 1 + 0.7 * k0;
      else if (mode === 3) cm = diode ? 1 + 0.1 * k0 : 1 + 0.35 * k0;
      const xo = (mode * 4 + slope) * 5;
      for (let j = 0; j < 5; j++) K[10 + j] = MOT_XP[xo + j];
      K[15] = type; K[16] = k0; K[17] = cm; K[18] = broken ? 1.6 * MOT_LN2 * (0.3 + drv) : 0; K[19] = 0.08 * drv + 0.02;
      K[20] = broken ? k0 * (1 + 0.22 * this.kj[0]) : k0; K[21] = broken ? k0 * (1 + 0.22 * this.kj[1]) : k0;
      K[22] = broken ? this.pop[0] : 0; K[23] = broken ? this.pop[1] : 0;
      if (S[11] < 0 || typeChanged) { S[11] = dr * cm; S[12] = K[4]; }
      this._lad(L, R, n);
    }
    // SVF core: optional pre-stage (Q .54) + resonant stage with a saturating band state
    _svf(L, R, n) {
      const K = this.K, S = this.S, sr = this.sr, sL = this.s[0], sR = this.s[1];
      const lt = K[0], d0 = K[1], d1 = K[2], dr = K[3], og = K[4], envA = K[5], fm = K[6], useEnv = K[7], mode = K[8], slope = K[9];
      const kB = K[10], bpn = K[11], two = K[12], op = K[13], kA = 1.848, lsc = this.lsc, ea = this.ea, er = this.er;
      const ar = useEnv || fm !== 0;
      let lf0 = S[0], eL = S[1], eR = S[2], gL = S[9], gR = S[10], gi = S[11], go = S[12];
      const giI = (dr - gi) / n, goI = (og - go) / n;
      for (let i = 0; i < n; i++) {
        lf0 += (lt - lf0) * lsc; gi += giI; go += goI;
        const upd = ar || (i & 3) === 0;
        for (let c = 0; c < 2; c++) {
          const buf = c ? R : L, s = c ? sR : sL, x = buf[i];
          let g = c ? gR : gL;
          if (upd) {
            const ax = Math.abs(x);
            if (c) eR = ax + (ax > eR ? ea : er) * (eR - ax); else eL = ax + (ax > eL ? ea : er) * (eL - ax);
            g = MOT_g(Math.exp(lf0 + (c ? d1 : d0) + envA * (c ? eR : eL) * useEnv + fm * x), sr);
            if (c) gR = g; else gL = g;
          }
          let v = MOT_tanh(x * gi * 0.8) * 1.25;
          if (two) {
            const a1 = 1 / (1 + g * (g + kA)), a2 = g * a1, a3 = g * a2;
            const v3 = v - s[1], v1 = a1 * s[0] + a2 * v3, v2 = s[1] + a2 * s[0] + a3 * v3;
            s[0] = 2 * v1 - s[0]; s[1] = 2 * v2 - s[1];
            v = mode === 0 ? v2 : mode === 2 ? v - kA * v1 - v2 : mode === 1 ? kA * v1 : v - kA * v1;
          }
          const a1 = 1 / (1 + g * (g + kB)), a2 = g * a1, a3 = g * a2;
          const v3 = v - s[3], v1 = a1 * s[2] + a2 * v3, v2 = s[3] + a2 * s[2] + a3 * v3;
          s[2] = MOT_tanh((2 * v1 - s[2]) * 0.6) * 1.6667; s[3] = 2 * v2 - s[3];
          let y;
          if (mode === 0) y = slope === 0 ? v2 + kB * v1 : v2;
          else if (mode === 2) y = slope === 0 ? v - v2 : v - kB * v1 - v2;
          else if (mode === 1) y = v1 * bpn;
          else y = v - kB * v1;
          if (op) { const G = g / (1 + g), w = (y - s[4]) * G, lp = w + s[4]; s[4] = lp + w; y = mode === 0 ? lp : y - lp; }
          buf[i] = y * go;
        }
      }
      S[0] = lf0; S[1] = eL; S[2] = eR; S[9] = gL; S[10] = gR; S[11] = gi; S[12] = go;
    }
    // ladder cores: linear ZDF solve of the 4-pole loop + input nonlinearity, Xpander tap mixing
    _lad(L, R, n) {
      const K = this.K, S = this.S, sr = this.sr, sL = this.s[0], sR = this.s[1];
      const lt = K[0], d0 = K[1], d1 = K[2], dr = K[3], og = K[4], envA = K[5], fm = K[6], useEnv = K[7];
      const t0 = K[10], t1 = K[11], t2 = K[12], t3 = K[13], t4 = K[14], type = K[15], cm = K[17], sag = K[18], popA = K[19];
      const kL = K[20], kR = K[21], pL = K[22], pR = K[23], lsc = this.lsc, ea = this.ea, er = this.er;
      const diode = type === 2, broken = type === 3, Gh = this.hpG, Bh = diode ? 1 - Gh : 1;
      const ar = useEnv || fm !== 0;
      let lf0 = S[0], eL = S[1], eR = S[2], gi = S[11], go = S[12];
      const giI = (dr * cm - gi) / n, goI = (og - go) / n;
      for (let i = 0; i < n; i++) {
        lf0 += (lt - lf0) * lsc; gi += giI; go += goI;
        const upd = ar || (i & 3) === 0;
        for (let c = 0; c < 2; c++) {
          const buf = c ? R : L, s = c ? sR : sL, x = buf[i], o = 3 + c * 3;
          if (upd) {
            const ax = Math.abs(x);
            if (c) eR = ax + (ax > eR ? ea : er) * (eR - ax); else eL = ax + (ax > eL ? ea : er) * (eL - ax);
            const e = (c ? eR : eL) * useEnv;
            const g = MOT_g(Math.exp(lf0 + (c ? d1 : d0) + envA * e + fm * x - sag * e), sr);
            if (diode) { const ga = g * 1.6, gd = g * 0.7; S[o] = ga / (1 + ga); S[o + 1] = g / (1 + g); S[o + 2] = gd / (1 + gd); }
            else { const G = g / (1 + g); S[o] = G; S[o + 1] = G; S[o + 2] = G; }
          }
          const G1 = S[o], G2 = S[o + 1], G4 = S[o + 2], G3 = G2;
          const Sx = (1 - G4) * s[3] + G4 * ((1 - G3) * s[2] + G3 * ((1 - G2) * s[1] + G2 * (1 - G1) * s[0]));
          const GG = G1 * G2 * G3 * G4, k = c ? kR : kL;
          const xin = x * gi + (c ? pR * eR : pL * eL) * popA;
          const sh = diode ? s[4] : 0;
          const y4e = (GG * (xin + k * Bh * sh) + Sx) / (1 + k * GG * Bh);
          let u = xin - k * Bh * (y4e - sh);
          if (type === 1) u = 1.6 * MOT_tanh(u * 0.625);                   // ladder: symmetric, 1.6 headroom
          else if (diode) u = 1.6 * (MOT_tanh(u * 0.625 + 0.2) - 0.1974); // diode: biased (even harmonics)
          else { const a = Math.abs(u); u = u * (a + 0.012) / (a + 0.05); u = MOT_tanh(u > 0 ? u * 1.25 : u * 0.8); }
          let w = (u - s[0]) * G1; const y1 = w + s[0]; s[0] = y1 + w;
          w = (y1 - s[1]) * G2; const y2 = w + s[1]; s[1] = y2 + w;
          w = (y2 - s[2]) * G3; const y3 = w + s[2]; s[2] = y3 + w;
          if (broken) s[2] = Math.max(-0.45, Math.min(0.6, s[2]));
          w = (y3 - s[3]) * G4; const y4 = w + s[3]; s[3] = y4 + w;
          if (diode) s[4] += 2 * (y4 - s[4]) * Gh;
          buf[i] = (t0 * u + t1 * y1 + t2 * y2 + t3 * y3 + t4 * y4) * go;
        }
      }
      S[0] = lf0; S[1] = eL; S[2] = eR; S[11] = gi; S[12] = go;
    }
  });

  // ===========================================================================
  // 3. COMBS — three pitch-related feedback combs with transient pluck exciter
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'combs';
    static label = 'COMBS';
    static cat = 'FILTER';
    static desc = 'Three tuned feedback comb filters at musical offsets, with damping, tone tilt and a noise pluck on transients.';
    static latency = 0;
    static params = [
      { id: 'freq', label: 'FREQ', min: 30, max: 2000, def: 110, unit: 'Hz', curve: 'exp' },
      { id: 'fb', label: 'FB', min: -99, max: 99, def: 85, unit: '%', bipolar: true },
      { id: 'off1', label: 'OFF1', min: -24, max: 24, def: 7, unit: 'st', curve: 'int', bipolar: true },
      { id: 'off2', label: 'OFF2', min: -24, max: 24, def: 12, unit: 'st', curve: 'int', bipolar: true },
      { id: 'damp', label: 'DAMP', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'tone', label: 'TONE', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
      { id: 'pluck', label: 'PLUCK', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      const sr = this.sr, maxD = Math.ceil(sr / 7) + 8, sz = MOT_pow2(maxD + 8);
      this.rb = []; for (let j = 0; j < 6; j++) this.rb.push(new Float32Array(sz));
      this.rm = sz - 1; this.rw = 0; this.maxD = maxD - 8;
      // per channel (stride 12): tone LP ic1/ic2, tone HP ic1/ic2, loop LP x3, delays x3, fb, og
      this.st = new Float64Array(24); this.rs = new Int32Array([0x2545f491, 0x1b873593]);
      this.dt = new Float64Array(3); this.ba = new Float64Array(128);
      this.sc = 1 - Math.exp(-1 / (0.025 * sr));
      this.efa = Math.exp(-1 / (0.0003 * sr)); this.efr = Math.exp(-1 / (0.015 * sr));
      this.esa = Math.exp(-1 / (0.012 * sr)); this.esr = Math.exp(-1 / (0.2 * sr));
      this.ef = 0; this.es = 0;
      this.bAmp = 0; this.bDec = Math.exp(-1 / (0.007 * sr)); this.refr = 0;
      this.snp = [new MOT_Snap(), new MOT_Snap(), new MOT_Snap()];
      this.first = true; this.toneV = 0; this.K = new Float64Array(16); this.lpT = new MOT_SVF(); this.hpT = new MOT_SVF();
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, fb = p.fb * 0.01, afb = Math.abs(fb), st = this.st;
      const damp = p.damp * 0.01;
      const fd = 18000 * Math.pow(600 / 18000, damp), cl = 1 - Math.exp(-2 * Math.PI * fd / sr), gd = (1 - cl) / cl;
      const dt = this.dt;
      for (let j = 0; j < 3; j++) {
        let f = p.freq * semisToRatio(j === 0 ? 0 : j === 1 ? p.off1 : p.off2);
        if (p.snap) f = this.snp[j].hz(ctx.key, f);
        // delay for y[n-D] (read before the write). Negative feedback keeps D: odd harmonics, an octave lower
        dt[j] = Math.max(3, Math.min(this.maxD, sr / f - gd - 1));
      }
      // tone tilt = LP (closes below centre) in series with HP (opens above centre): both always running
      const tv = p.tone * 0.01;
      this.toneV += (tv - this.toneV) * (this.first ? 1 : 0.3);
      const t = this.toneV, lpT = this.lpT, hpT = this.hpT;
      lpT.lp(MOT_g(18000 * Math.pow(2, Math.min(0, t) * 6.5), sr), 0.6); hpT.hp(MOT_g(20 * Math.pow(2, Math.max(0, t) * 7.6), sr), 0.6);
      const og = 0.5 * Math.sqrt((1 - afb * afb) / (1 + afb * afb)) + 0.02;
      if (this.first) {
        for (let c = 0; c < 2; c++) { const o = c * 12; st[o + 7] = dt[0]; st[o + 8] = dt[1]; st[o + 9] = dt[2]; st[o + 10] = fb; st[o + 11] = og; }
        this.first = false;
      }
      const K = this.K;
      K[0] = fb; K[1] = cl; K[2] = og; K[4] = lpT.a1; K[5] = lpT.a2; K[6] = lpT.a3; K[7] = hpT.a1; K[8] = hpT.a2; K[9] = hpT.a3; K[10] = hpT.k;
      this._env(L, R, n, p.pluck * 0.01);
      this._k(L, n, 0); this._k(R, n, 1);
      this.rw = (this.rw + n) & this.rm;
    }
    // transient detector on the mono input -> per-sample pluck-burst amplitude (this.ba)
    _env(L, R, n, pl) {
      const ba = this.ba, efa = this.efa, efr = this.efr, esa = this.esa, esr = this.esr, bDec = this.bDec, refrN = Math.round(0.06 * this.sr);
      let ef = this.ef, es = this.es, bAmp = this.bAmp, refr = this.refr;
      for (let i = 0; i < n; i++) {
        const am = 0.5 * (Math.abs(L[i]) + Math.abs(R[i]));
        ef = am + (am > ef ? efa : efr) * (ef - am); es = am + (am > es ? esa : esr) * (es - am);
        refr--;
        const trig = ((ef - es * 1.6 - 0.01) * pl > 0 ? 1 : 0) * (refr < 0 ? 1 : 0); // branch-light (no cold JIT paths)
        bAmp = Math.max(bAmp, trig * pl * Math.min(1, ef * 2) * 0.8); refr = trig ? refrN : refr;
        ba[i] = bAmp; bAmp *= bDec;
      }
      this.ef = ef; this.es = es; this.bAmp = bAmp < 1e-6 ? 0 : bAmp; this.refr = Math.max(-1, refr);
    }
    // per-channel kernel: pluck noise -> tone (LP, HP) -> three feedback combs y = ex + fb * tanh(lp(y[n-D]))
    _k(buf, n, c) {
      const K = this.K, st = this.st, dt = this.dt, ba = this.ba, o = c * 12, sc = this.sc;
      const cl = K[1], ta1 = K[4], ta2 = K[5], ta3 = K[6], ha1 = K[7], ha2 = K[8], ha3 = K[9], hk = K[10];
      const b0 = this.rb[c * 3], b1 = this.rb[c * 3 + 1], b2 = this.rb[c * 3 + 2], m = this.rm, t0 = dt[0], t1 = dt[1], t2 = dt[2];
      let w = this.rw, rs = this.rs[c];
      let lp1 = st[o], lp2 = st[o + 1], hp1 = st[o + 2], hp2 = st[o + 3], l0 = st[o + 4], l1 = st[o + 5], l2 = st[o + 6];
      let v0 = st[o + 7], v1 = st[o + 8], v2 = st[o + 9], fb = st[o + 10], og = st[o + 11];
      const fbI = (K[0] - fb) / n, ogI = (K[2] - og) / n;
      for (let i = 0; i < n; i++) {
        v0 += (t0 - v0) * sc; v1 += (t1 - v1) * sc; v2 += (t2 - v2) * sc; fb += fbI; og += ogI;
        rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
        const x = buf[i] + rs * 4.656612873077393e-10 * ba[i];
        let v3 = x - lp2, q1 = ta1 * lp1 + ta2 * v3, q2 = lp2 + ta2 * lp1 + ta3 * v3;
        lp1 = 2 * q1 - lp1; lp2 = 2 * q2 - lp2; const e = q2;
        v3 = e - hp2; q1 = ha1 * hp1 + ha2 * v3; q2 = hp2 + ha2 * hp1 + ha3 * v3;
        hp1 = 2 * q1 - hp1; hp2 = 2 * q2 - hp2; const ex = e - hk * q1 - q2;
        let y, sum;
        l0 += cl * (MOT_rd(b0, m, w, v0) - l0); y = ex + fb * MOT_tanh(l0); b0[w] = y; sum = y;
        l1 += cl * (MOT_rd(b1, m, w, v1) - l1); y = ex + fb * MOT_tanh(l1); b1[w] = y; sum += y;
        l2 += cl * (MOT_rd(b2, m, w, v2) - l2); y = ex + fb * MOT_tanh(l2); b2[w] = y; sum += y;
        w = (w + 1) & m;
        buf[i] = sum * og;
      }
      st[o] = lp1; st[o + 1] = lp2; st[o + 2] = hp1; st[o + 3] = hp2; st[o + 4] = l0; st[o + 5] = l1; st[o + 6] = l2;
      st[o + 7] = v0; st[o + 8] = v1; st[o + 9] = v2; st[o + 10] = fb; st[o + 11] = og; this.rs[c] = rs;
    }
  });

  // ===========================================================================
  // 4. VOWEL — 5-formant filter with voice models and grid sequencer
  // ===========================================================================
  // per vowel A E I O U: F1..F5 (Hz), A1..A5 (dB), BW1..BW5 (Hz)
  const MOT_VOW_M = [
    [650, 1080, 2650, 2900, 3250, 0, -6, -7, -8, -22, 80, 90, 120, 130, 140],
    [400, 1700, 2600, 3200, 3580, 0, -14, -12, -14, -20, 70, 80, 100, 120, 120],
    [290, 1870, 2800, 3250, 3540, 0, -15, -18, -20, -30, 40, 90, 100, 120, 120],
    [400, 800, 2600, 2800, 3000, 0, -10, -12, -12, -26, 40, 80, 100, 120, 120],
    [350, 600, 2700, 2900, 3300, 0, -20, -17, -14, -26, 40, 60, 100, 120, 120],
  ];
  const MOT_VOW_F = [
    [800, 1150, 2900, 3900, 4950, 0, -6, -32, -20, -50, 80, 90, 120, 130, 140],
    [350, 2000, 2800, 3600, 4950, 0, -20, -15, -40, -56, 60, 100, 120, 150, 200],
    [270, 2140, 2950, 3900, 4950, 0, -12, -26, -26, -44, 60, 90, 100, 120, 120],
    [450, 800, 2830, 3800, 4950, 0, -11, -22, -22, -50, 40, 80, 100, 120, 120],
    [325, 700, 2700, 3800, 4950, 0, -16, -35, -40, -60, 50, 60, 170, 180, 200],
  ];
  // -> Float64Array[(vowel*5 + formant)*3] = [ln F, linear amp, bandwidth]
  function MOT_mkVoice(src, fMul, bwMul, ampMul, kind) {
    const out = new Float64Array(75);
    for (let v = 0; v < 5; v++) {
      for (let j = 0; j < 5; j++) {
        let f = src[v][j] * fMul; const a = src[v][5 + j] * ampMul; let b = src[v][10 + j] * bwMul;
        if (kind === 1) { f = Math.max(220, Math.round(f / 110) * 110); b = Math.max(22, b); } // robot: harmonic grid
        if (kind === 2) f = 1.05e6 / f;                                                       // alien: inverted formants
        const o = (v * 5 + j) * 3; out[o] = Math.log(f); out[o + 1] = dbToGain(a); out[o + 2] = b;
      }
    }
    return out;
  }
  const MOT_VOICE_GAIN = new Float64Array([1, 0.95, 1.12, 1.42, 0.55]); // level match across voices
  const MOT_VOICES = [
    MOT_mkVoice(MOT_VOW_M, 1, 1, 0.7, 0),
    MOT_mkVoice(MOT_VOW_F, 1, 1, 0.7, 0),
    MOT_mkVoice(MOT_VOW_F, 1.17, 1.25, 0.7, 0),
    MOT_mkVoice(MOT_VOW_M, 1, 0.35, 0.35, 1),
    MOT_mkVoice(MOT_VOW_M, 1, 1.6, 0.7, 2),
  ];
  registerFX(class extends FX {
    static id = 'vowel';
    static label = 'VOWEL';
    static cat = 'FILTER';
    static desc = 'Five-formant vowel filter morphing A-E-I-O-U, with voice models and a tempo-synced vowel sequencer.';
    static latency = 0;
    static params = [
      { id: 'vowel', label: 'VOWEL', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'q', label: 'Q', min: 0, max: 100, def: 55, unit: '%' },
      { id: 'shift', label: 'SHIFT', min: -12, max: 12, def: 0, unit: 'st', bipolar: true },
      { id: 'voice', label: 'VOICE', options: ['MALE', 'FEMALE', 'CHILD', 'ROBOT', 'ALIEN'], def: 0 },
      { id: 'seq', label: 'SEQ', toggle: true, def: 0 },
      { id: 'rate', label: 'SEQ RATE', div: ['4/1', '1/32'], def: '1/4' },
      { id: 'glide', label: 'GLIDE', min: 1, max: 500, def: 60, unit: 'ms', curve: 'exp' },
      { id: 'spread', label: 'SPREAD', min: 0, max: 100, def: 30, unit: '%' },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      this.st = [new Float64Array(10), new Float64Array(10)];
      this.cf = [new Float64Array(20), new Float64Array(20)];
      this.pv = 0; this.first = true; this.prev = new Float64Array([-1, 0, 0]);
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, V = MOT_VOICES[p.voice | 0] || MOT_VOICES[0];
      const base = p.vowel * 0.04;
      // Q / SHIFT / SPREAD are interpolated across the block (coefficients update every 16 samples)
      const pv = this.prev; if (pv[0] < 0) { pv[0] = p.q; pv[1] = p.shift; pv[2] = p.spread; }
      const q0 = pv[0], h0 = pv[1], s0 = pv[2], qd = p.q - q0, hd = p.shift - h0, sd = p.spread - s0;
      pv[0] = p.q; pv[1] = p.shift; pv[2] = p.spread;
      const gc = 1 - Math.exp(-16 / (Math.max(1, p.glide) * 0.001 * sr));
      const mk = 5.8 * (MOT_VOICE_GAIN[p.voice | 0] || 1); // make-up: five narrow bands keep only a fraction of broadband energy
      for (let off = 0; off < n; off += 16) {
        const m = n - off < 16 ? n - off : 16, fr0 = (off + m) / n;
        const qs = Math.pow(2, (0.5 - (q0 + qd * fr0) * 0.01) * 3.2), shL = (h0 + hd * fr0) / 12 * MOT_LN2, sp = (s0 + sd * fr0) * 0.01;
        const mkq = mk * Math.sqrt(0.8950 / qs); // broadband energy ~ bandwidth: keep level steady across Q
        let tgt = base;
        if (p.seq) { const b = p.rate > 1e-4 ? p.rate : 1e-4; tgt += Math.floor((ctx.ppq + off / ctx.spb) / b + 1e-9); }
        tgt -= 5 * Math.floor(tgt / 5);
        let v = this.pv;
        if (this.first) { v = tgt; this.first = false; }
        else { const t2 = tgt + 5 * Math.round((v - tgt) / 5); v += (t2 - v) * gc; }
        if (v > 1000 || v < -1000) v -= 5 * Math.floor(v / 5);
        this.pv = v;
        for (let c = 0; c < 2; c++) {
          let pos = v + (c ? sp : -sp) * 0.6; pos -= 5 * Math.floor(pos / 5);
          const i0 = Math.min(4, Math.floor(pos));
          const fr = pos - i0, i1 = i0 === 4 ? 0 : i0 + 1;
          const lo = shL + (c ? sp : -sp) * 0.04, cf = this.cf[c];
          for (let j = 0; j < 5; j++) {
            const o0 = (i0 * 5 + j) * 3, o1 = (i1 * 5 + j) * 3;
            const F = Math.exp(V[o0] + (V[o1] - V[o0]) * fr + lo);
            const amp = V[o0 + 1] + (V[o1 + 1] - V[o0 + 1]) * fr;
            let k = (V[o0 + 2] + (V[o1 + 2] - V[o0 + 2]) * fr) * qs / F;
            k = Math.max(0.015, Math.min(1.6, k));
            const g = MOT_g(F, sr), a1 = 1 / (1 + g * (g + k)), o = j * 4;
            cf[o] = a1; cf[o + 1] = g * a1; cf[o + 2] = g * g * a1; cf[o + 3] = amp * k * mkq;
          }
        }
        this._k(L, this.cf[0], this.st[0], off, off + m);
        this._k(R, this.cf[1], this.st[1], off, off + m);
      }
    }
    // five parallel band-passes (SVF), formant amplitudes folded into cf[j*4+3]
    _k(buf, cf, st, i0, i1) {
      const a0 = cf[0], b0 = cf[1], c0 = cf[2], g0 = cf[3], a1 = cf[4], b1 = cf[5], c1 = cf[6], g1 = cf[7];
      const a2 = cf[8], b2 = cf[9], c2 = cf[10], g2 = cf[11], a3 = cf[12], b3 = cf[13], c3 = cf[14], g3 = cf[15];
      const a4 = cf[16], b4 = cf[17], c4 = cf[18], g4 = cf[19];
      let p0 = st[0], q0 = st[1], p1 = st[2], q1 = st[3], p2 = st[4], q2 = st[5], p3 = st[6], q3 = st[7], p4 = st[8], q4 = st[9];
      for (let i = i0; i < i1; i++) {
        const x = buf[i];
        let v3 = x - q0, v1 = a0 * p0 + b0 * v3, v2 = q0 + b0 * p0 + c0 * v3; p0 = 2 * v1 - p0; q0 = 2 * v2 - q0; let y = g0 * v1;
        v3 = x - q1; v1 = a1 * p1 + b1 * v3; v2 = q1 + b1 * p1 + c1 * v3; p1 = 2 * v1 - p1; q1 = 2 * v2 - q1; y += g1 * v1;
        v3 = x - q2; v1 = a2 * p2 + b2 * v3; v2 = q2 + b2 * p2 + c2 * v3; p2 = 2 * v1 - p2; q2 = 2 * v2 - q2; y += g2 * v1;
        v3 = x - q3; v1 = a3 * p3 + b3 * v3; v2 = q3 + b3 * p3 + c3 * v3; p3 = 2 * v1 - p3; q3 = 2 * v2 - q3; y += g3 * v1;
        v3 = x - q4; v1 = a4 * p4 + b4 * v3; v2 = q4 + b4 * p4 + c4 * v3; p4 = 2 * v1 - p4; q4 = 2 * v2 - q4; y += g4 * v1;
        buf[i] = y;
      }
      st[0] = p0; st[1] = q0; st[2] = p1; st[3] = q1; st[4] = p2; st[5] = q2; st[6] = p3; st[7] = q3; st[8] = p4; st[9] = q4;
    }
  });

  // ===========================================================================
  // 5. SWIRL — cascade of notches in three LFO phase groups (0/120/240°)
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'swirl';
    static label = 'SWIRL';
    static cat = 'FILTER';
    static desc = 'Three-phase swirling notch network: notch groups sweep 120° apart, with feedback and envelope follow.';
    static latency = 0;
    static params = [
      { id: 'freq', label: 'FREQ', min: 80, max: 8000, def: 800, unit: 'Hz', curve: 'exp' },
      { id: 'rate', label: 'RATE', div: ['8/1', '1/32'], def: '1/1' },
      { id: 'depth', label: 'DEPTH', min: 0, max: 100, def: 65, unit: '%' },
      { id: 'fdbk', label: 'FDBK', min: -95, max: 95, def: 55, unit: '%', bipolar: true },
      { id: 'sections', label: 'SECTIONS', min: 2, max: 8, def: 6, curve: 'int' },
      { id: 'spread', label: 'SPREAD', min: 0, max: 100, def: 50, unit: '%' },
      { id: 'env', label: 'ENV', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      this.st = [new Float64Array(18), new Float64Array(18)];
      this.cf = [new Float64Array(27), new Float64Array(27)];
      this.lv = new Float64Array(6);
      this.fbS = new Float64Array(2);
      this.lfo = new MOT_LFO(); this.cnt = new MOT_FracCount();
      this.ea = Math.exp(-1 / (0.004 * this.sr)); this.er = Math.exp(-1 / (0.16 * this.sr));
      this.lf = 0; this.first = true; this.ev = 0; this.fb = 0; this.og = 1;
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, cnt = this.cnt;
      const nb = cnt.step(p.sections, 8, 0.34), Sv = Math.max(2, cnt.v);
      for (let c = 0; c < 2; c++) this.st[c].fill(0, (nb + 1) * 2, 18);
      const ph0 = this.lfo.block(1, p.rate, 0, ctx, n, sr, false), inc = this.lfo.inc;
      const tl = Math.log(p.freq), fbT = p.fdbk * 0.01, ogT = 1 / (1 + Math.abs(fbT) * 0.3);
      if (this.first) { this.lf = tl; this.fb = fbT; this.og = ogT; this.first = false; } else this.lf += (tl - this.lf) * 0.3;
      const dep = p.depth * 0.01 * 2.2 * MOT_LN2, envA = p.env * 0.01 * 3 * MOT_LN2, spr = p.spread * 0.01 * 3 * MOT_LN2;
      const K = 0.4, lv = this.lv, ea = this.ea, er = this.er;
      const fwI = (cnt.f1 - cnt.f0) / n, fbI = (fbT - this.fb) / n, ogI = (ogT - this.og) / n;
      for (let off = 0; off < n; off += 8) {
        const e = Math.min(n, off + 8), m = e - off;
        const ph = ph0 + inc * (off + m * 0.5);
        for (let c = 0; c < 2; c++) for (let g = 0; g < 3; g++) lv[c * 3 + g] = Math.sin(TAU * (ph + g / 3 + (c ? 1 / 6 : 0)));
        const eo = envA * this.ev;
        for (let c = 0; c < 2; c++) {
          const cf = this.cf[c];
          for (let j = 0; j <= nb; j++) {
            const lf = this.lf + dep * lv[c * 3 + (j % 3)] + eo + spr * (j / (Sv - 1) - 0.5);
            const g = MOT_g(Math.exp(lf), sr), a1 = 1 / (1 + g * (g + K)), o = j * 3;
            cf[o] = a1; cf[o + 1] = g * a1; cf[o + 2] = g * g * a1;
          }
        }
        let ev = this.ev;
        for (let i = off; i < e; i++) { const a = Math.abs(L[i] + R[i]) * 0.5; ev = a + (a > ev ? ea : er) * (ev - a); }
        this.ev = ev;
        const f0 = cnt.f0 + fwI * off, b0 = this.fb + fbI * off, o0 = this.og + ogI * off;
        this._k(L, 0, off, e, nb, f0, fwI, b0, fbI, o0, ogI);
        this._k(R, 1, off, e, nb, f0, fwI, b0, fbI, o0, ogI);
      }
      this.fb = fbT; this.og = ogT;
    }
    // notch cascade: nb full sections + one partially blended section; soft-clipped feedback
    _k(buf, c, i0, i1, nb, fw, fwI, fb, fbI, og, ogI) {
      const cf = this.cf[c], st = this.st[c], K = 0.4;
      let fs = this.fbS[c];
      for (let i = i0; i < i1; i++) {
        fw += fwI; fb += fbI; og += ogI;
        let x = buf[i] + fb * MOT_tanh(fs);
        for (let j = 0; j <= nb; j++) {
          const o = j * 3, s = j * 2, ic1 = st[s], ic2 = st[s + 1];
          const v3 = x - ic2, v1 = cf[o] * ic1 + cf[o + 1] * v3, v2 = ic2 + cf[o + 1] * ic1 + cf[o + 2] * v3;
          st[s] = 2 * v1 - ic1; st[s + 1] = 2 * v2 - ic2;
          x -= (j < nb ? K : K * fw) * v1;
        }
        fs = x;
        buf[i] = x * og;
      }
      this.fbS[c] = fs;
    }
  });

  // ===========================================================================
  // 6. CHORUS — 4-voice chorus with CLASSIC / DIMENSION / VINTAGE modes
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'chorus';
    static label = 'CHORUS';
    static cat = 'MODULATION';
    static desc = 'Four-voice stereo chorus with classic quadrature, dimension-style and vintage BBD modes.';
    static latency = 0;
    static params = [
      { id: 'rate', label: 'RATE', min: 0.03, max: 10, def: 0.7, unit: 'Hz', curve: 'exp' },
      { id: 'depth', label: 'DEPTH', min: 0, max: 100, def: 55, unit: '%' },
      { id: 'time', label: 'TIME', min: 2, max: 40, def: 12, unit: 'ms', curve: 'exp' },
      { id: 'fdbk', label: 'FDBK', min: -90, max: 90, def: 0, unit: '%', bipolar: true },
      { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 100, unit: '%' },
      { id: 'mode', label: 'MODE', options: ['CLASSIC', 'DIMENSION', 'VINTAGE'], def: 0 },
      { id: 'sync', label: 'SYNC', toggle: true, def: 0 },
      { id: 'div', label: 'DIV', div: ['8/1', '1/16'], def: '1/1' },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      const sr = this.sr, max = Math.ceil(sr * 0.1);
      this.dl = [new DelayLine(max), new DelayLine(max)];
      this.lfo = new MOT_LFO();
      this.tS = new Smoother(sr, 60, 12); this.aS = new Smoother(sr, 60, 0); this.first = true;
      this.fbL = 0; this.fbR = 0; this.fbv = -10; this.wv = 0;
      this.lp = [new MOT_SVF(), new MOT_SVF()];
      for (const f of this.lp) f.lp(MOT_g(7000, sr), 0.6);
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, msr = sr * 0.001, mode = p.mode | 0;
      let ph = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, false); const inc = this.lfo.inc;
      const tms = p.time * (mode === 1 ? 0.7 : 1);
      const amp = p.depth * 0.01 * Math.min(p.time * 0.45, 8) * (mode === 1 ? 0.45 : 1);
      if (this.first) { this.tS.snap(tms); this.aS.snap(amp); this.first = false; } else { this.tS.set(tms); this.aS.set(amp); }
      const fbT = p.fdbk * 0.01, wT = p.width * 0.01;
      if (this.fbv < -9) { this.fbv = fbT; this.wv = wT; }
      let fb = this.fbv, w = this.wv; const fbI = (fbT - fb) / n, wI = (wT - w) / n; this.fbv = fbT; this.wv = wT;
      const dlL = this.dl[0], dlR = this.dl[1], tS = this.tS, aS = this.aS, lpL = this.lp[0], lpR = this.lp[1];
      let fbL = this.fbL, fbR = this.fbR;
      for (let i = 0; i < n; i++) {
        ph += inc; ph -= Math.floor(ph);
        fb += fbI; w += wI;
        const wa = 0.5 + 0.5 * w, wb = 0.5 - 0.5 * w;
        const T = tS.next() * msr, A = aS.next() * msr;
        const xl = L[i], xr = R[i];
        dlL.write(xl + fb * MOT_tanh(fbL)); dlR.write(xr + fb * MOT_tanh(fbR));
        if (mode === 0) {
          const s = Math.sin(TAU * ph), co = Math.cos(TAU * ph);
          const v0 = dlL.read(T + A * s), v2 = dlL.read(T * 0.87 - A * s);
          const v1 = dlR.read(T * 1.13 + A * co), v3 = dlR.read(T * 1.24 - A * co);
          const sl = v0 + v2, sr2 = v1 + v3;
          L[i] = 0.7 * (sl * wa + sr2 * wb); R[i] = 0.7 * (sr2 * wa + sl * wb);
          fbL = 0.5 * sl; fbR = 0.5 * sr2;
        } else {
          const tri = 1 - 4 * Math.abs(ph - 0.5);
          let v0 = dlL.read(T + A * tri), v1 = dlR.read(T * 1.07 - A * tri);
          fbL = v0; fbR = v1;
          if (mode === 1) {
            L[i] = 0.62 * xl + 0.6 * v0 - 0.3 * w * v1; R[i] = 0.62 * xr + 0.6 * v1 - 0.3 * w * v0;
          } else {
            v0 = MOT_tanh(lpL.run(v0) * 1.3) * 0.77; v1 = MOT_tanh(lpR.run(v1) * 1.3) * 0.77;
            L[i] = 0.72 * (xl + v0 * wa + v1 * wb); R[i] = 0.72 * (xr + v1 * wa + v0 * wb);
          }
        }
      }
      this.fbL = fbL; this.fbR = fbR;
    }
  });

  // ===========================================================================
  // 7. ENSEMBLE — BBD string ensemble (dual LFO, 3-phase taps)
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'ensemble';
    static label = 'ENSEMBLE';
    static cat = 'MODULATION';
    static desc = 'Bucket-brigade string ensemble: three-phase taps modulated by a slow and a fast LFO, with BBD darkening and grit.';
    static latency = 0;
    static params = [
      { id: 'type', label: 'TYPE', options: ['STRINGS', 'LUSH', 'DIMENSION', 'TAPE'], def: 0 },
      { id: 'rate1', label: 'RATE 1', min: 0.05, max: 4, def: 0.6, unit: 'Hz', curve: 'exp' },
      { id: 'rate2', label: 'RATE 2', min: 1, max: 15, def: 6, unit: 'Hz', curve: 'exp' },
      { id: 'depth', label: 'DEPTH', min: 0, max: 100, def: 65, unit: '%' },
      { id: 'fdbk', label: 'FDBK', min: 0, max: 80, def: 0, unit: '%' },
      { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 80, unit: '%' },
      { id: 'bbd', label: 'BBD', min: 0, max: 100, def: 35, unit: '%' },
      { id: 'sync', label: 'SYNC', toggle: true, def: 0 },
      { id: 'div', label: 'DIV', div: ['16/1', '1/4'], def: '2/1' },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      const sr = this.sr, sz = MOT_pow2(Math.ceil(sr * 0.05) + 8);
      this.bL = new Float32Array(sz); this.bR = new Float32Array(sz); this.m = sz - 1; this.w = 0;
      this.lfo = new MOT_LFO(); this.p2 = 0;
      this.rot = new Float64Array(12); // per channel, per tap: cos/sin of phase offsets
      this.lp = new MOT_SVF();         // BBD low-pass coefficients (state kept in .st)
      this.st = new Float64Array(8);   // lp ic1/ic2 L,R; feedback L,R; env; spare
      this.ea = Math.exp(-1 / (0.005 * sr)); this.er = Math.exp(-1 / (0.2 * sr));
      this.rng = new Rng(0xe95e); this.rs = 0x6a09e667; this.wr = 0; this.wt = 0; this.wc = 0;
      this.dv = 0; this.dc = 1 - Math.exp(-1 / (0.08 * sr)); this.first = true; this.K = new Float64Array(24); this.sat0 = -1;
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, msr = sr * 0.001, type = p.type | 0;
      let p1 = this.lfo.block(p.sync, p.div, p.rate1, ctx, n, sr, false); const i1 = this.lfo.inc;
      let p2 = this.p2; const i2 = p.rate2 / sr;
      const dep = p.depth * 0.01, w = p.width * 0.01, fb = p.fdbk * 0.01, bbd = p.bbd * 0.01;
      if (this.first) { this.dv = dep; this.first = false; }
      // tap phase offsets (cycles): 3 taps 120° apart, R channel rotated by width
      const rot = this.rot, roff = w * (type === 1 ? 0.33 : 0.25);
      for (let c = 0; c < 2; c++) for (let k = 0; k < 3; k++) {
        const a = TAU * (k / 3 + (c ? roff : 0)), o = (c * 3 + k) * 2; rot[o] = Math.cos(a); rot[o + 1] = Math.sin(a);
      }
      let base = 6, A1 = 1.6, A2 = 0.22;
      if (type === 1) { base = 10; A1 = 2.8; A2 = 0.3; } else if (type === 2) { base = 4; A1 = 0.9; A2 = 0; } else if (type === 3) { base = 8; A1 = 1.4; A2 = 0.12; }
      base *= msr; A1 *= msr; A2 *= msr;
      const lpf = 16000 * Math.pow(2, -bbd * 2.2) * (type === 3 ? 0.7 : 1);
      const lf = this.lp; lf.lp(MOT_g(lpf, sr), 0.65);
      const la1 = lf.a1, la2 = lf.a2, la3 = lf.a3;
      const sat = 1 + bbd * 1.5, satN = 1 / sat, nz = bbd * 0.02 * 3.0517578125e-5;
      // TAPE wander (random wow), per block
      if (type === 3) { if (--this.wc <= 0) { this.wt = this.rng.bi(); this.wc = 20 + this.rng.int(60); } this.wr += (this.wt - this.wr) * 0.03; }
      const K = this.K;
      K[0] = type; K[1] = p1; K[2] = i1; K[3] = p2; K[4] = i2; K[5] = dep; K[6] = fb; K[7] = base; K[8] = A1; K[9] = A2;
      K[10] = la1; K[11] = la2; K[12] = la3; K[13] = sat; K[14] = satN; K[15] = nz; K[16] = this.wr * 0.5 * msr; K[17] = 0.4 * msr;
      K[18] = 1 - 0.5 * (1 - w); K[19] = 0.3 * w;
      if (this.sat0 < 0) this.sat0 = sat;
      K[20] = this.sat0; K[21] = (sat - this.sat0) / n; this.sat0 = sat;
      this._k(L, R, n);
      this.p2 = MOT_frac(p2 + i2 * n);
    }
    // per-sample kernel (compact, so the JIT tiers it up quickly)
    _k(L, R, n) {
      const K = this.K, rot = this.rot, type = K[0], i1 = K[2], i2 = K[4], dep = K[5], fb = K[6], base = K[7], A1 = K[8], A2 = K[9];
      const la1 = K[10], la2 = K[11], la3 = K[12], satI = K[21], nz = K[15], wr = K[16], sp = K[17], ms = K[18], dxw = K[19];
      let sat = K[20];
      let p1 = K[1], p2 = K[3];
      const bL = this.bL, bR = this.bR, m = this.m, st = this.st, ea = this.ea, er = this.er, dc = this.dc;
      const r0 = rot[0], r1 = rot[1], r2 = rot[2], r3 = rot[3], r4 = rot[4], r5 = rot[5];
      const r6 = rot[6], r7 = rot[7], r8 = rot[8], r9 = rot[9], r10 = rot[10], r11 = rot[11];
      let wi = this.w, d = this.dv, rs = this.rs;
      let l1 = st[0], l2 = st[1], q1 = st[2], q2 = st[3], fL = st[4], fR = st[5], env = st[6];
      for (let i = 0; i < n; i++) {
        p1 += i1; p1 -= Math.floor(p1);
        p2 += i2; p2 -= Math.floor(p2);
        d += (dep - d) * dc;
        const s1 = Math.sin(TAU * p1), c1 = Math.cos(TAU * p1), s2 = Math.sin(TAU * p2), c2 = Math.cos(TAU * p2);
        const xl = L[i], xr = R[i], am = Math.abs(xl + xr) * 0.5;
        env = am + (am > env ? ea : er) * (env - am);
        bL[wi] = xl + fb * MOT_tanh(fL); bR[wi] = xr + fb * MOT_tanh(fR);
        wi = (wi + 1) & m;
        let oL, oR;
        if (type <= 1) {
          const dA1 = d * A1, dA2 = d * A2;
          oL = (MOT_rd(bL, m, wi, base + dA1 * (s1 * r0 + c1 * r1) + dA2 * (s2 * r0 + c2 * r1))
            + MOT_rd(bL, m, wi, base + sp + dA1 * (s1 * r2 + c1 * r3) + dA2 * (s2 * r2 + c2 * r3))
            + MOT_rd(bL, m, wi, base + 2 * sp + dA1 * (s1 * r4 + c1 * r5) + dA2 * (s2 * r4 + c2 * r5))) * 0.58;
          oR = (MOT_rd(bR, m, wi, base + dA1 * (s1 * r6 + c1 * r7) + dA2 * (s2 * r6 + c2 * r7))
            + MOT_rd(bR, m, wi, base + sp + dA1 * (s1 * r8 + c1 * r9) + dA2 * (s2 * r8 + c2 * r9))
            + MOT_rd(bR, m, wi, base + 2 * sp + dA1 * (s1 * r10 + c1 * r11) + dA2 * (s2 * r10 + c2 * r11))) * 0.58;
        } else if (type === 2) {
          const tri = 1 - 4 * Math.abs(p1 - 0.5);
          oL = MOT_rd(bL, m, wi, base + d * A1 * tri); oR = MOT_rd(bR, m, wi, base - d * A1 * tri);
        } else {
          oL = MOT_rd(bL, m, wi, base + d * (A1 * s1 + A2 * s2 + wr));
          oR = MOT_rd(bR, m, wi, base + d * (A1 * (s1 * r6 + c1 * r7) + A2 * (s2 * r6 + c2 * r7) + wr));
        }
        fL = oL; fR = oR;
        // BBD colour: darkening (SVF LP), soft saturation, signal-following grit
        let v3 = oL - l2, v1 = la1 * l1 + la2 * v3, v2 = l2 + la2 * l1 + la3 * v3; l1 = 2 * v1 - l1; l2 = 2 * v2 - l2; oL = v2;
        v3 = oR - q2; v1 = la1 * q1 + la2 * v3; v2 = q2 + la2 * q1 + la3 * v3; q1 = 2 * v1 - q1; q2 = 2 * v2 - q2; oR = v2;
        rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
        const ne = nz * env; sat += satI; const satN = 1 / sat;
        oL = MOT_tanh(oL * sat) * satN + ((rs & 0xffff) - 32768) * ne;
        oR = MOT_tanh(oR * sat) * satN + ((rs >>> 16) - 32768) * ne;
        if (type === 2) { L[i] = 0.6 * xl + 0.6 * oL - dxw * oR; R[i] = 0.6 * xr + 0.6 * oR - dxw * oL; }
        else if (type === 3) { L[i] = 0.6 * (xl + oL); R[i] = 0.6 * (xr + oR); }
        else { const mid = 0.5 * (oL + oR), side = 0.5 * (oL - oR) * ms; L[i] = mid + side; R[i] = mid - side; }
      }
      st[0] = l1; st[1] = l2; st[2] = q1; st[3] = q2; st[4] = fL; st[5] = fR; st[6] = env;
      this.w = wi; this.dv = d; this.rs = rs;
    }
  });

  // ===========================================================================
  // 8. FLANGER — exponential sweep, through-zero and barber-pole modes
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'flanger';
    static label = 'FLANGER';
    static cat = 'MODULATION';
    static desc = 'Stereo flanger with through-zero mode and an endless barber-pole sweep up or down.';
    static latency = 0;
    static params = [
      { id: 'div', label: 'DIV', div: ['16/1', '1/16'], def: '2/1' },
      { id: 'depth', label: 'DEPTH', min: 0, max: 100, def: 75, unit: '%' },
      { id: 'fdbk', label: 'FDBK', min: -95, max: 95, def: 60, unit: '%', bipolar: true },
      { id: 'delay', label: 'DELAY', min: 0.1, max: 10, def: 0.7, unit: 'ms', curve: 'exp' },
      { id: 'tzf', label: 'TZF', toggle: true, def: 0 },
      { id: 'barber', label: 'BARBER', options: ['OFF', 'RISE', 'FALL'], def: 0 },
      { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 50, unit: '%' },
      { id: 'sync', label: 'SYNC', toggle: true, def: 1 },
      { id: 'rate', label: 'RATE', min: 0.02, max: 10, def: 0.2, unit: 'Hz', curve: 'exp' },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      const sr = this.sr;
      this.dl = [new DelayLine(Math.ceil(sr * 0.1)), new DelayLine(Math.ceil(sr * 0.1))];
      this.lfo = new MOT_LFO();
      this.bS = new Smoother(sr, 40, 0.7); this.dS = new Smoother(sr, 40, 0.75); this.first = true;
      this.fbS = new Float64Array(2); this.fbv = -10; this.sg = 0; this.K = new Float64Array(12);
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, msr = sr * 0.001;
      let ph = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, false); const inc = this.lfo.inc;
      if (this.first) { this.bS.snap(p.delay); this.dS.snap(p.depth * 0.01); this.first = false; }
      else { this.bS.set(p.delay); this.dS.set(p.depth * 0.01); }
      const fbT = p.fdbk * 0.01, barber = p.barber | 0, tzf = p.tzf && !barber;
      if (this.fbv < -9) this.fbv = fbT;
      let fb = this.fbv, sg = this.sg; const fbI = (fbT - fb) / n, sgT = fbT < 0 ? -1 : 1, sgR = 1 / (0.005 * sr); this.fbv = fbT;
      if (sg === 0) sg = sgT;
      const K = this.K;
      K[0] = ph; K[1] = inc; K[2] = fb; K[3] = fbI; K[4] = sg; K[5] = sgT; K[6] = sgR; K[7] = barber; K[8] = tzf ? 1 : 0; K[9] = p.width * 0.005;
      this._k(L, R, n);
    }
    // per-sample kernel: write (input + soft-clipped feedback), read modulated tap(s), mix with dry
    _k(L, R, n) {
      const K = this.K, inc = K[1], fbI = K[3], sgT = K[5], sgR = K[6], barber = K[7], tzf = K[8], wo = K[9];
      const msr = this.sr * 0.001, fbS = this.fbS, bS = this.bS, dS = this.dS, dlL = this.dl[0], dlR = this.dl[1];
      const m = dlL.mask, bL = dlL.buf, bR = dlR.buf, dmax = dlL.size - 8;
      let ph = K[0], fb = K[2], sg = K[4], w = dlL.w;
      for (let i = 0; i < n; i++) {
        ph += inc; ph -= Math.floor(ph);
        fb += fbI;
        sg += Math.max(-sgR, Math.min(sgR, sgT - sg)); // wet polarity follows the FDBK sign, slewed over ~5 ms
        const base = bS.next() * msr, dep = dS.next();
        bL[w] = L[i] + fb * MOT_tanh(fbS[0]); bR[w] = R[i] + fb * MOT_tanh(fbS[1]); w = (w + 1) & m;
        for (let c = 0; c < 2; c++) {
          const buf = c ? R : L, b = c ? bR : bL, x = buf[i];
          const pc = c ? ph + wo : ph;
          let dry = x, wet;
          if (barber) {
            const r1 = pc - Math.floor(pc), r2 = MOT_frac(pc + 0.5), oc = (1 + dep * 3) * MOT_LN2;
            const e1 = barber === 1 ? 1 - r1 : r1, e2 = barber === 1 ? 1 - r2 : r2;
            const t1 = MOT_rd(b, m, w, Math.min(dmax, 2 + base * Math.exp(oc * e1))), t2 = MOT_rd(b, m, w, Math.min(dmax, 2 + base * Math.exp(oc * e2)));
            const w1 = 0.5 - 0.5 * Math.cos(TAU * r1);
            wet = t1 * w1 + t2 * (1 - w1);
          } else if (tzf) {
            dry = MOT_rd(b, m, w, base + 2);
            wet = MOT_rd(b, m, w, 2 + base * (1 + dep * Math.cos(TAU * pc)));
          } else {
            wet = MOT_rd(b, m, w, 1.5 + base * Math.exp(dep * 3 * MOT_LN2 * (0.5 - 0.5 * Math.cos(TAU * pc))));
          }
          fbS[c] = wet;
          buf[i] = 0.5 * (dry + sg * wet);
        }
      }
      dlL.w = w; dlR.w = w; this.sg = sg;
    }
  });

  // ===========================================================================
  // 9. PHASER — 2..12 first-order stages, feedback, barber-pole mode
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'phaser';
    static label = 'PHASER';
    static cat = 'MODULATION';
    static desc = 'Stereo allpass phaser with 2-12 stages, feedback and an endless barber-pole sweep.';
    static latency = 0;
    static params = [
      { id: 'div', label: 'DIV', div: ['16/1', '1/16'], def: '2/1' },
      { id: 'depth', label: 'DEPTH', min: 0, max: 100, def: 70, unit: '%' },
      { id: 'fdbk', label: 'FDBK', min: -95, max: 95, def: 55, unit: '%', bipolar: true },
      { id: 'center', label: 'CENTER', min: 100, max: 8000, def: 700, unit: 'Hz', curve: 'exp' },
      { id: 'stages', label: 'STAGES', min: 2, max: 12, def: 6, curve: 'int' },
      { id: 'barber', label: 'BARBER', options: ['OFF', 'RISE', 'FALL'], def: 0 },
      { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 50, unit: '%' },
      { id: 'sync', label: 'SYNC', toggle: true, def: 1 },
      { id: 'rate', label: 'RATE', min: 0.02, max: 10, def: 0.3, unit: 'Hz', curve: 'exp' },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      this.z = [new Float64Array(26), new Float64Array(26)]; // 2 chains x 13 (12 stages + spare)
      this.fbS = new Float64Array(4);
      this.lfo = new MOT_LFO(); this.cnt = new MOT_FracCount();
      this.cS = new Smoother(this.sr, 40, Math.log(700)); this.first = true;
      this.ac = new Float64Array(4); this.wc = new Float64Array(4); this.K = new Float64Array(16); this.fb = 0;
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, barber = p.barber | 0, cnt = this.cnt;
      const nb = cnt.step(p.stages, 12, 0.34);
      for (let c = 0; c < 2; c++) { this.z[c].fill(0, nb + 1, 13); this.z[c].fill(0, 13 + nb + 1, 26); }
      const ph = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, false);
      const lc = Math.log(p.center);
      if (this.first) { this.cS.snap(lc); this.fb = p.fdbk * 0.01; this.first = false; } else this.cS.set(lc);
      const dep = p.depth * 0.01, K = this.K;
      K[0] = ph; K[1] = this.lfo.inc; K[2] = barber; K[3] = nb; K[4] = cnt.f0; K[5] = cnt.f1;
      K[6] = this.fb; K[7] = p.fdbk * 0.01; K[8] = p.width * 0.005; K[9] = (1 + dep * 4) * MOT_LN2; K[10] = dep * 2.5 * MOT_LN2;
      this.fb = K[7];
      this._k(L, R, n);
    }
    // allpass chains: nb full stages + one partial stage (fractional count), feedback, barber cross-fade
    _k(L, R, n) {
      const K = this.K, sr = this.sr, inc = K[1], barber = K[2], nb = K[3], fI = (K[5] - K[4]) / n, fbI = (K[7] - K[6]) / n;
      const wo = K[8], oc = K[9], sw = K[10], piSr = Math.PI / sr, fmax = sr * 0.45;
      const ac = this.ac, wc = this.wc, fbS = this.fbS, cS = this.cS, zL = this.z[0], zR = this.z[1];
      let ph = K[0], fw = K[4], fb = K[6];
      for (let i = 0; i < n; i++) {
        ph += inc; ph -= Math.floor(ph);
        fw += fI; fb += fbI;
        const lcv = cS.next();
        if ((i & 3) === 0) { // allpass coefficients (and barber weights) every 4 samples
          for (let c = 0; c < 2; c++) {
            const pc = c ? ph + wo : ph;
            if (!barber) {
              const t = MOT_tan(piSr * Math.min(fmax, Math.exp(lcv + sw * Math.sin(TAU * pc))));
              ac[c * 2] = (t - 1) / (t + 1);
            } else {
              for (let h = 0; h < 2; h++) {
                const r = MOT_frac(pc + h * 0.5), e = barber === 1 ? r : 1 - r;
                const t = MOT_tan(piSr * Math.min(fmax, Math.exp(lcv + oc * (e - 0.5))));
                ac[c * 2 + h] = (t - 1) / (t + 1); wc[c * 2 + h] = 0.5 - 0.5 * Math.cos(TAU * r);
              }
            }
          }
        }
        for (let c = 0; c < 2; c++) {
          const buf = c ? R : L, z = c ? zR : zL, x = buf[i];
          let acc = 0;
          for (let h = 0; h <= (barber ? 1 : 0); h++) {
            const a = ac[c * 2 + h], zo = h * 13, fi = c * 2 + h;
            let y = x + fb * MOT_tanh(fbS[fi]);
            for (let j = 0; j < nb; j++) { const o = a * y + z[zo + j]; z[zo + j] = y - a * o; y = o; }
            const o = a * y + z[zo + nb]; z[zo + nb] = y - a * o; y += (o - y) * fw;
            fbS[fi] = y;
            acc += barber ? y * wc[fi] : y;
          }
          buf[i] = 0.5 * (x + acc);
        }
      }
    }
  });

  // ===========================================================================
  // 10. RINGMOD — ring/AM modulator with pitch-tracking carrier
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'ringmod';
    static label = 'RINGMOD';
    static cat = 'MODULATION';
    static desc = 'Ring modulator with sine-to-square carrier, AM bias, stereo detune and an optional pitch-tracking carrier.';
    static latency = 0;
    static params = [
      { id: 'freq', label: 'FREQ', min: 1, max: 4000, def: 320, unit: 'Hz', curve: 'exp' },
      { id: 'shape', label: 'SHAPE', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'bias', label: 'BIAS', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'spread', label: 'SPREAD', min: 0, max: 100, def: 25, unit: '%' },
      { id: 'track', label: 'TRACK', toggle: true, def: 0 },
      { id: 'ratio', label: 'RATIO', min: 0.25, max: 8, def: 1, unit: '×', curve: 'exp' },
      { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      const sr = this.sr;
      this.phL = 0; this.phR = 0.25; this.lf = Math.log(320); this.first = true;
      this.det = new MOT_SVF(); this.det.lp(MOT_g(900, sr), 0.7);
      this.dc = new DCBlock(0.995); this.env = new EnvFollower(sr, 2, 80);
      this.st = 0; this.cnt = 0; this.est = 220.5; this.snp = new MOT_Snap(); this.sh = -1; this.b = 0;
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, track = p.track;
      // pitch tracker: low-passed mono, hysteretic zero crossings
      if (track) {
        const det = this.det, dc = this.dc, env = this.env;
        let st = this.st, cnt = this.cnt, est = this.est;
        for (let i = 0; i < n; i++) {
          const v = det.run(dc.process(0.5 * (L[i] + R[i]))), e = env.process(v), th = e * 0.25 + 1e-4;
          cnt++;
          if (st === 0 && v > th) {
            st = 1;
            const f = sr / cnt;
            if (cnt > 0 && f > 35 && f < 1600 && e > 0.003) est = est + (f - est) * 0.5;
            cnt = 0;
          } else if (st === 1 && v < -th) st = 0;
          if (cnt > sr) cnt = sr;
        }
        this.st = st; this.cnt = cnt; this.est = est;
      }
      let f = track ? this.est * p.ratio : p.freq;
      if (p.snap) f = this.snp.hz(ctx.key, f);
      const lt = Math.log(Math.max(0.5, f));
      if (this.first) { this.lf = lt; this.first = false; } else this.lf += (lt - this.lf) * (track ? 0.2 : 0.5);
      const fc = Math.exp(this.lf), r = Math.pow(2, p.spread * 0.01 * 0.75 / 12);
      const iL = fc / r / sr, iR = fc * r / sr;
      // shape (sine -> square) and bias (ring -> AM) are ramped per sample: carrier = mix(sin, sq) * cg + co
      const sh = p.shape * 0.01, b = p.bias * 0.01;
      if (this.sh < 0) { this.sh = sh; this.b = b; }
      let s0 = this.sh, b0 = this.b; const sI = (sh - s0) / n, bI = (b - b0) / n; this.sh = sh; this.b = b;
      let phL = this.phL, phR = this.phR;
      for (let i = 0; i < n; i++) {
        phL += iL; phL -= Math.floor(phL);
        phR += iR; phR -= Math.floor(phR);
        s0 += sI; b0 += bI;
        const sl = Math.sin(TAU * phL), sr2 = Math.sin(TAU * phR), w = Math.sqrt(s0);
        const cl = sl + (MOT_tanh(sl * 12) - sl) * w, cr = sr2 + (MOT_tanh(sr2 * 12) - sr2) * w;
        const cg = (1 - 0.5 * b0) * (1.25 - 0.25 * b0), co = 0.5 * b0 * (1.25 - 0.25 * b0);
        L[i] *= cl * cg + co; R[i] *= cr * cg + co;
      }
      this.phL = phL; this.phR = phR;
    }
  });

  // ===========================================================================
  // 11. AUTOPAN
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'autopan';
    static label = 'AUTOPAN';
    static cat = 'MODULATION';
    static desc = 'Grid-locked auto-panner with sine, triangle, square and random shapes and an input-width control.';
    static latency = 0;
    static params = [
      { id: 'div', label: 'DIV', div: ['8/1', '1/32'], def: '1/4' },
      { id: 'depth', label: 'DEPTH', min: 0, max: 100, def: 80, unit: '%' },
      { id: 'shape', label: 'SHAPE', options: ['SINE', 'TRI', 'SQUARE', 'RANDOM'], def: 0 },
      { id: 'phase', label: 'PHASE', min: 0, max: 360, def: 0, unit: '°' },
      { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 60, unit: '%' },
      { id: 'smooth', label: 'SMOOTH', min: 0, max: 100, def: 25, unit: '%' },
      { id: 'sync', label: 'SYNC', toggle: true, def: 1 },
      { id: 'rate', label: 'RATE', min: 0.05, max: 20, def: 1, unit: 'Hz', curve: 'exp' },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params); this.lfo = new MOT_LFO(); this.v = 0; this.rv = 0; this.lastF = 0; this.rs = 0x7a9a3c1;
      this.first = true; this.dep = -1; this.w = -1;
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, shape = p.shape | 0;
      let ph = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, true); const inc = this.lfo.inc;
      const off = p.phase / 360, dep = p.depth * 0.01, w = p.width * 0.01;
      const per = 1 / Math.max(1e-9, inc); // samples per cycle
      const sm = p.smooth * 0.01, tau = 0.0008 * sr + ((shape >= 2) ? sm * sm * 0.3 * per : 0);
      const c = 1 - Math.exp(-1 / tau);
      let v = this.v, rv = this.rv, lastF = this.lastF, rs = this.rs;
      if (this.first) { lastF = MOT_frac(ph + off); rv = 0.3; this.first = false; }
      if (this.dep < 0) { this.dep = dep; this.w = w; }
      let d = this.dep, ww = this.w; const dInc = (dep - d) / n, wInc = (w - ww) / n; this.dep = dep; this.w = w;
      for (let i = 0; i < n; i++) {
        ph += inc; ph -= Math.floor(ph);
        const f = MOT_frac(ph + off);
        rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
        rv = f < lastF ? rs * 4.656612873077393e-10 : rv; // new random position each cycle (branch-free)
        let t;
        if (shape === 0) t = Math.sin(TAU * f);
        else if (shape === 1) t = 4 * Math.abs(MOT_frac(f - 0.25) - 0.5) - 1;
        else if (shape === 2) t = f < 0.5 ? 1 : -1;
        else t = rv;
        lastF = f;
        v += (t - v) * c;
        d += dInc; ww += wInc;
        const a = (d * v + 1) * MOT_QPI, gL = Math.cos(a) * MOT_SQRT2, gR = Math.sin(a) * MOT_SQRT2;
        const xl = L[i], xr = R[i], m = 0.5 * (xl + xr), s = 0.5 * (xl - xr) * ww;
        L[i] = (m + s) * gL; R[i] = (m - s) * gR;
      }
      this.v = v; this.rv = rv; this.lastF = lastF; this.rs = rs;
    }
  });

  // ===========================================================================
  // 12. TREMOLO
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'tremolo';
    static label = 'TREMOLO';
    static cat = 'MODULATION';
    static desc = 'Grid-locked tremolo with six shapes, stereo phase offset and edge smoothing.';
    static latency = 0;
    static params = [
      { id: 'div', label: 'DIV', div: ['4/1', '1/64'], def: '1/8' },
      { id: 'depth', label: 'DEPTH', min: 0, max: 100, def: 75, unit: '%' },
      { id: 'shape', label: 'SHAPE', options: ['SINE', 'TRI', 'SQUARE', 'SAW', 'RAMP', 'RANDOM'], def: 0 },
      { id: 'stereo', label: 'STEREO', min: 0, max: 180, def: 0, unit: '°' },
      { id: 'smooth', label: 'SMOOTH', min: 0, max: 100, def: 20, unit: '%' },
      { id: 'sync', label: 'SYNC', toggle: true, def: 1 },
      { id: 'rate', label: 'RATE', min: 0.1, max: 30, def: 5, unit: 'Hz', curve: 'exp' },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      this.lfo = new MOT_LFO(); this.v = new Float64Array([1, 1]); this.rv = new Float64Array([1, 1]);
      this.lastF = new Float64Array(2); this.rs = new Int32Array([0x3c6ef372, 0x2545f491]); this.first = true; this.dep = -1;
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, shape = p.shape | 0;
      const ph0 = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, true), inc = this.lfo.inc;
      const dep = p.depth * 0.01, off = p.stereo / 360, per = 1 / Math.max(1e-9, inc);
      const sm = p.smooth * 0.01, tau = 0.0006 * sr + (shape >= 2 ? sm * sm * 0.25 * per : 0);
      const c = 1 - Math.exp(-1 / tau);
      if (this.first) { this.lastF[0] = ph0; this.lastF[1] = MOT_frac(ph0 + off); this.first = false; }
      if (this.dep < 0) this.dep = dep;
      const d0 = this.dep, dInc = (dep - d0) / n; this.dep = dep;
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch ? R : L;
        let ph = ch ? MOT_frac(ph0 + off) : ph0, v = this.v[ch], rv = this.rv[ch], lastF = this.lastF[ch], rs = this.rs[ch], d = d0;
        for (let i = 0; i < n; i++) {
          ph += inc; ph -= Math.floor(ph);
          rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
          rv = ph < lastF ? (rs >>> 0) * 2.3283064365386963e-10 : rv; // new random level each cycle (branch-free)
          let t;
          if (shape === 0) t = 0.5 + 0.5 * Math.cos(TAU * ph);
          else if (shape === 1) t = Math.abs(2 * ph - 1);
          else if (shape === 2) t = ph < 0.5 ? 1 : 0;
          else if (shape === 3) t = 1 - ph;
          else if (shape === 4) t = ph;
          else t = rv;
          lastF = ph;
          v += (t - v) * c;
          d += dInc;
          buf[i] *= 1 - d * (1 - v);
        }
        this.v[ch] = v; this.rv[ch] = rv; this.lastF[ch] = lastF; this.rs[ch] = rs;
      }
    }
  });

  // ===========================================================================
  // 13. FREQSHIFT — Bode SSB shifter with spiralling feedback delay
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'freqshift';
    static label = 'FREQSHIFT';
    static cat = 'PITCH';
    static desc = 'Single-sideband frequency shifter, independent per channel, with a feedback delay for spiralling shifts.';
    static latency = 0;
    static params = [
      { id: 'shiftl', label: 'SHIFT L', min: -500, max: 500, def: 30, unit: 'Hz', bipolar: true },
      { id: 'shiftr', label: 'SHIFT R', min: -500, max: 500, def: -30, unit: 'Hz', bipolar: true },
      { id: 'link', label: 'LINK', toggle: true, def: 0 },
      { id: 'fdbk', label: 'FDBK', min: 0, max: 95, def: 35, unit: '%' },
      { id: 'time', label: 'TIME', min: 1, max: 1000, def: 140, unit: 'ms', curve: 'exp' },
      { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      const sr = this.sr, sz = MOT_pow2(Math.ceil(sr * 1.02) + 8);
      this.hil = [new MOT_Hilbert(), new MOT_Hilbert()];
      this.bL = new Float32Array(sz); this.bR = new Float32Array(sz); this.m = sz - 1; this.w = 0;
      // state: 0..1 shift (Hz, block-smoothed) L/R, 2..3 delay (smp) L/R, 4..7 phasors cos/sin L, R, 8..9 loop LP
      const S = this.S = new Float64Array(12); S[4] = 1; S[6] = 1; S[10] = -1;
      this.K = new Float64Array(12);
      this.first = true;
      this.snp = [new MOT_Snap(), new MOT_Snap()];
      this.lc = 1 - Math.exp(-TAU * 7000 / sr); this.tc = 1 - Math.exp(-1 / (0.12 * sr));
    }
    _snap(key, s, k) {
      const ref = mtof(key.degreeMidi(0, 4));
      if (ref + s < 30) return s;
      return this.snp[k].hz(key, ref + s) - ref;
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, S = this.S, K = this.K;
      let sl = p.shiftl, sR = p.link ? p.shiftl : p.shiftr;
      if (p.snap) { sl = this._snap(ctx.key, sl, 0); sR = this._snap(ctx.key, sR, 1); }
      const T = Math.max(2, p.time * 0.001 * sr);
      // shift smoothed per block (~30 ms); the oscillator stays phase-continuous
      const bc = this.first ? 1 : 1 - Math.exp(-n / (0.03 * sr));
      if (this.first) { S[2] = T; S[3] = T; this.first = false; }
      S[0] += (sl - S[0]) * bc; S[1] += (sR - S[1]) * bc;
      for (let c = 0; c < 2; c++) {
        const a = TAU * S[c] / sr, o = 4 + c * 2, nr = 1 / Math.hypot(S[o], S[o + 1]);
        S[o] *= nr; S[o + 1] *= nr; K[c * 2] = Math.cos(a); K[c * 2 + 1] = Math.sin(a);
      }
      if (S[10] < 0) S[10] = p.fdbk * 0.01;
      K[4] = S[10]; K[6] = (p.fdbk * 0.01 - S[10]) / n; K[5] = T; S[10] = p.fdbk * 0.01;
      this._k(L, n, 0); this._k(R, n, 1);
      this.w = (this.w + n) & this.m;
    }
    // per-channel kernel: feedback delay -> Hilbert pair -> complex rotation
    _k(buf, n, c) {
      const S = this.S, K = this.K, hil = this.hil[c], b = c ? this.bR : this.bL, m = this.m;
      const rc = K[c * 2], rsn = K[c * 2 + 1], fbI = K[6], T = K[5], lc = this.lc, tc = this.tc, o = 4 + c * 2;
      let w = this.w, d = S[2 + c], oc = S[o], os = S[o + 1], lp = S[8 + c], fb = K[4];
      for (let i = 0; i < n; i++) {
        d += (T - d) * tc; fb += fbI;
        lp += lc * (MOT_rd(b, m, w, d) - lp);
        hil.process(buf[i] + fb * MOT_tanh(lp));
        const t = oc * rc - os * rsn; os = os * rc + oc * rsn; oc = t;
        const y = hil.re * oc - hil.im * os;
        b[w] = y; w = (w + 1) & m;
        buf[i] = y;
      }
      S[2 + c] = d; S[o] = oc; S[o + 1] = os; S[8 + c] = lp;
    }
  });

  // ===========================================================================
  // 14. DOPPLER — moving point source: fractional delay doppler + ITD/ILD + air
  // ===========================================================================
  const MOT_C = 343;
  registerFX(class extends FX {
    static id = 'doppler';
    static label = 'DOPPLER';
    static cat = 'MODULATION';
    static desc = 'Moving-source simulation: doppler pitch, distance level and air loss, and interaural time/level panning along six paths.';
    static latency = 0;
    static params = [
      { id: 'path', label: 'PATH', options: ['ORBIT', 'PASS', 'FIG-8', 'BOUNCE', 'RANDOM', 'ROTOR'], def: 0 },
      { id: 'div', label: 'SPEED', div: ['16/1', '1/32'], def: '1/1' },
      { id: 'distance', label: 'DISTANCE', min: 2, max: 40, def: 8, curve: 'exp' },
      { id: 'depth', label: 'DEPTH', min: 0, max: 100, def: 60, unit: '%' },
      { id: 'air', label: 'AIR', min: 0, max: 100, def: 40, unit: '%' },
      { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 70, unit: '%' },
      { id: 'sync', label: 'SYNC', toggle: true, def: 1 },
      { id: 'rate', label: 'SPEED HZ', min: 0.05, max: 10, def: 0.5, unit: 'Hz', curve: 'exp' },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      const sr = this.sr;
      this.lA = [new DelayLine(Math.ceil(sr * 0.36)), new DelayLine(Math.ceil(sr * 0.36))];
      // rotor bands (horn = highs, drum = lows); all lines are written every sample so path changes never read stale audio
      this.lB = [new DelayLine(Math.ceil(sr * 0.06)), new DelayLine(Math.ceil(sr * 0.06))];
      this.lH = [new DelayLine(Math.ceil(sr * 0.06)), new DelayLine(Math.ceil(sr * 0.06))];
      this.maxA = Math.ceil(sr * 0.35); this.maxB = Math.ceil(sr * 0.05);
      this.lfo = new MOT_LFO(); this.dph = 0;
      // taps: [srcA earL, srcA earR, srcB earL, srcB earR]
      this.dP = new Float64Array(4); this.dN = new Float64Array(4);
      this.gP = new Float64Array(4); this.gN = new Float64Array(4);
      this.aP = new Float64Array(2); this.aN = new Float64Array(2); this.lpS = new Float64Array(2);
      this.xo = new Float64Array(2); this.xoc = 1 - Math.exp(-TAU * 800 / sr);
      this.rx = new Float64Array(4); this.rt = new Float64Array(2); this.rseg = -1;
      this.rng = new Rng(0xd0bb1e);
      this.path = -1; this.fade = 0; this.Ds = 8; this.first = true; this.snap = true; this.dsc = 0.9; this.wid = 0.7;
    }
    // source position (x right, y front) for source k at path phase t; returns [x,y] in this.px/py
    _pos(path, t, D, k) {
      let x, y;
      switch (path) {
        case 0: { const a = TAU * t; x = 0.6 * D * Math.sin(a); y = 0.3 * D + 0.6 * D * Math.cos(a); break; }
        case 1: { const tk = MOT_frac(t + k * 0.5); x = (tk - 0.5) * 3 * D; y = 0.25 * D + 0.5; break; }
        case 2: { const a = TAU * t; x = 0.9 * D * Math.sin(a); y = 0.45 * D + 0.35 * D * Math.sin(2 * a); break; }
        case 3: { const tri = 1 - Math.abs(2 * t - 1); x = 0.7 * D * (2 * tri - 1); y = 0.2 * D + 0.3 + 0.8 * D * Math.abs(Math.sin(TAU * t)); break; }
        case 4: { x = this.rx[2]; y = this.rx[3]; break; }
        default: { // rotor: horn (k=0) / drum (k=1)
          const rh = 0.08 + 0.02 * D, cy = 1.2 + 0.05 * D;
          if (k === 0) { const a = TAU * t; x = rh * Math.sin(a); y = cy + rh * Math.cos(a); }
          else { const a = TAU * this.dph, rb = rh * 1.4; x = -rb * Math.sin(a); y = cy + rb * Math.cos(a); }
        }
      }
      this.px = x; this.py = y;
    }
    _dref(path, D) {
      switch (path) {
        case 0: return 0.3 * D; case 1: return 0.25 * D + 0.5; case 2: return 0.35 * D;
        case 3: return 0.2 * D + 0.3; case 4: return 0.25 * D; default: return 1.2 + 0.05 * D - (0.08 + 0.02 * D) * 1.4;
      }
    }
    // compute next control targets (delays, gains, air) at path phase t
    _ctl(t, step, dscale, width, air, sr) {
      const path = this.path, D = this.Ds, dref = this._dref(path, D);
      const ear = 0.0875 * (0.3 + 1.7 * width), itd = ear / MOT_C * sr;
      if (path === 4) { // random: two-stage smoothing towards random targets, 4 per cycle
        const seg = Math.floor(t * 4);
        if (seg !== this.rseg) {
          this.rseg = seg;
          let tx = this.rng.bi() * D, ty = -0.5 * D + this.rng.next() * 1.5 * D;
          const dd = Math.hypot(tx, ty); if (dd < 0.35 * D) { const s = 0.35 * D / Math.max(1e-3, dd); tx *= s; ty = (ty === 0 ? 1 : ty) * s; }
          this.rt[0] = tx; this.rt[1] = ty;
        }
        const tau = Math.max(32, 0.25 / Math.max(1e-9, this.lfo.inc) / 2.5), cR = 1 - Math.exp(-step / tau), rx = this.rx;
        rx[0] += (this.rt[0] - rx[0]) * cR; rx[1] += (this.rt[1] - rx[1]) * cR;
        rx[2] += (rx[0] - rx[2]) * cR; rx[3] += (rx[1] - rx[3]) * cR;
      }
      const nsrc = path === 1 || path === 5 ? 2 : 1;
      let dsum = 0, wsum = 0, back = 0;
      for (let k = 0; k < 2; k++) {
        if (k >= nsrc) { this.gN[2] = 0; this.gN[3] = 0; this.dN[2] = this.dN[0]; this.dN[3] = this.dN[1]; break; }
        this._pos(path, t, D, k);
        const x = this.px, y = this.py;
        let dc = Math.sqrt(x * x + y * y); if (dc < 0.25) dc = 0.25;
        let g = 1.4 * Math.min(1.25, Math.pow((dref + 1) / (dc + 1), 0.9));
        if (path === 1) { const w = Math.sin(Math.PI * MOT_frac(t + k * 0.5)); g *= w * w; }
        else if (path === 5) g *= k === 0 ? 0.6 - 0.4 * Math.cos(TAU * t) : 0.85 - 0.15 * Math.cos(TAU * this.dph);
        const pan = x / dc * width * 0.8;
        const dd = Math.max(0, dscale * (dc - dref));
        const dl = Math.sqrt((x + ear) * (x + ear) + y * y), dr = Math.sqrt((x - ear) * (x - ear) + y * y);
        const lim = path === 5 ? this.maxB : this.maxA; // rotor taps read the short band lines
        this.dN[k * 2] = Math.min(lim, 2 + itd + (dd + dl - dc) / MOT_C * sr);
        this.dN[k * 2 + 1] = Math.min(lim, 2 + itd + (dd + dr - dc) / MOT_C * sr);
        this.gN[k * 2] = g * Math.sqrt(1 - pan) * this.fade;
        this.gN[k * 2 + 1] = g * Math.sqrt(1 + pan) * this.fade;
        const wk = path === 1 ? g + 1e-6 : 1;
        dsum += dc * wk; wsum += wk; if (y < 0) back += -y / dc * wk;
      }
      const dAvg = dsum / wsum, bk = back / wsum;
      const fcA = 18000 / (1 + air * dAvg * 0.3 + bk * 1.5);
      const ca = 1 - Math.exp(-TAU * Math.min(fcA, sr * 0.45) / sr);
      this.aN[0] = ca; this.aN[1] = ca;
    }
    process(L, R, n, p, ctx) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, path = p.path | 0;
      const ph0 = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, false), inc = this.lfo.inc;
      const dscale = p.depth * 0.015, width = p.width * 0.01, air = p.air * 0.01;
      const STEP = 16;
      if (this.first) { this.path = path; this.Ds = p.distance; this.fade = 1; this.snap = true; this.first = false; }
      const dP = this.dP, dN = this.dN, gP = this.gP, gN = this.gN, aP = this.aP, aN = this.aN, lpS = this.lpS, xo = this.xo, xoc = this.xoc;
      const lAL = this.lA[0], lAR = this.lA[1], lBL = this.lB[0], lBR = this.lB[1], lHL = this.lH[0], lHR = this.lH[1];
      for (let off = 0; off < n; off += STEP) {
        const m = n - off < STEP ? n - off : STEP;
        // path switch: fade out, swap, fade in
        if (path !== this.path) { this.fade -= m / 384; if (this.fade <= 0) { this.fade = 0; this.path = path; this.rseg = -1; this.snap = true; } }
        else if (this.fade < 1) { this.fade += m / 384; if (this.fade > 1) this.fade = 1; }
        this.Ds += (p.distance - this.Ds) * (1 - Math.exp(-m / (0.25 * sr)));
        const gk = this.snap ? 1 : 1 - Math.exp(-m / (0.15 * sr));
        this.dsc += (dscale - this.dsc) * gk; this.wid += (width - this.wid) * gk;
        this.dph = MOT_frac(this.dph + inc * 0.9 * m);
        if (this.snap && this.path === 4) {
          const rx = this.rx, D = this.Ds; rx[0] = rx[2] = 0.3 * D; rx[1] = rx[3] = 0.6 * D;
        }
        this._ctl(MOT_frac(ph0 + inc * (off + m)), m, this.dsc, this.wid, air, sr);
        if (this.snap) { dP.set(dN); gP.set(gN); aP.set(aN); this.snap = false; }
        const rotor = this.path === 5, im = 1 / m;
        const dd0 = (dN[0] - dP[0]) * im, dd1 = (dN[1] - dP[1]) * im, dd2 = (dN[2] - dP[2]) * im, dd3 = (dN[3] - dP[3]) * im;
        const gd0 = (gN[0] - gP[0]) * im, gd1 = (gN[1] - gP[1]) * im, gd2 = (gN[2] - gP[2]) * im, gd3 = (gN[3] - gP[3]) * im;
        const ad = (aN[0] - aP[0]) * im;
        let d0 = dP[0], d1 = dP[1], d2 = dP[2], d3 = dP[3], g0 = gP[0], g1 = gP[1], g2 = gP[2], g3 = gP[3], ac = aP[0];
        for (let i = off; i < off + m; i++) {
          d0 += dd0; d1 += dd1; d2 += dd2; d3 += dd3; g0 += gd0; g1 += gd1; g2 += gd2; g3 += gd3; ac += ad;
          const xl = L[i], xr = R[i];
          let yl, yr;
          xo[0] += xoc * (xl - xo[0]); xo[1] += xoc * (xr - xo[1]);
          lAL.write(xl); lAR.write(xr); lHL.write(xl - xo[0]); lHR.write(xr - xo[1]); lBL.write(xo[0]); lBR.write(xo[1]);
          if (rotor) {
            yl = g0 * lHL.read(d0) + g2 * lBL.read(d2); yr = g1 * lHR.read(d1) + g3 * lBR.read(d3);
          } else {
            yl = g0 * lAL.read(d0); yr = g1 * lAR.read(d1);
            if (g2 !== 0 || g3 !== 0) { yl += g2 * lAL.read(d2); yr += g3 * lAR.read(d3); }
          }
          lpS[0] += ac * (yl - lpS[0]); lpS[1] += ac * (yr - lpS[1]);
          L[i] = lpS[0]; R[i] = lpS[1];
        }
        dP.set(dN); gP.set(gN); aP.set(aN);
      }
    }
  });

  // ===========================================================================
  // 15. DISPERSE — chain of 2nd-order allpasses around FOCUS (chirp / laser smear)
  // ===========================================================================
  const MOT_DU = new Float64Array(32);
  for (let j = 0; j < 32; j++) MOT_DU[j] = MOT_frac(j * 0.6180339887 + 0.31) * 2 - 1;
  registerFX(class extends FX {
    static id = 'disperse';
    static label = 'DISPERSE';
    static cat = 'FILTER';
    static desc = 'Phase dispersion through up to 32 allpass stages around a focus frequency: chirps, lasers and smeared transients.';
    static latency = 0;
    static params = [
      { id: 'amount', label: 'AMOUNT', min: 0, max: 32, def: 20, curve: 'int' },
      { id: 'focus', label: 'FOCUS', min: 40, max: 8000, def: 700, unit: 'Hz', curve: 'exp' },
      { id: 'reso', label: 'RESO', min: 0, max: 100, def: 45, unit: '%' },
      { id: 'spread', label: 'SPREAD', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'drive', label: 'DRIVE', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'trail', label: 'TRAIL', min: 0, max: 95, def: 35, unit: '%' },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      this.z = [new Float64Array(66), new Float64Array(66)];
      this.c = [new Float64Array(66), new Float64Array(66)];
      this.fbS = new Float64Array(2); this.cnt = new MOT_FracCount(); this.hpS = new Float64Array(2); this.hpc = 0.01;
      this.g = new Float64Array(4); // ramped: trail, drive mix, drive gain, drive norm
      this.lf = 0; this.q = 0; this.sp = 0; this.first = true; this.nb = -1;
      this.c32 = 1 - Math.exp(-32 / (0.015 * this.sr));
    }
    _coefs(nb) {
      const sr = this.sr;
      for (let c = 0; c < 2; c++) {
        const co = this.c[c], sg = c ? -1 : 1;
        for (let j = 0; j <= nb && j < 32; j++) {
          const f = clamp(Math.exp(this.lf + this.sp * 2 * MOT_LN2 * MOT_DU[j] * sg), 20, sr * 0.45);
          const w = TAU * f / sr, al = Math.sin(w) / (2 * this.q), a0 = 1 + al;
          co[j * 2] = -2 * Math.cos(w) / a0; co[j * 2 + 1] = (1 - al) / a0;
        }
      }
    }
    process(L, R, n, p) {
      p = this.ps.step(p, n, this.sr);
      const tlf = Math.log(p.focus), tq = 0.4 * Math.pow(2, p.reso * 0.045), tsp = p.spread * 0.01, cnt = this.cnt;
      const nb = cnt.step(p.amount, 32, 0.5);
      // TRAIL fades in over the first stage (no plain feedback loop at AMOUNT 0)
      const d = p.drive * 0.01, g = this.g, t0 = p.trail * 0.01 * Math.min(1, cnt.v), t1 = Math.min(1, d * 3), t2 = 1 + 15 * d * d, t3 = 0.5 / MOT_tanh(0.5 * t2);
      this.hpc = 1 - Math.exp(-TAU * Math.max(40, p.focus * 0.12) / this.sr); // feedback high-pass: no bass build-up
      if (this.first) { this.lf = tlf; this.q = tq; this.sp = tsp; g[0] = t0; g[1] = t1; g[2] = t2; g[3] = t3; this._coefs(nb); this.first = false; }
      if (nb !== this.nb) {
        if (nb > this.nb) this._coefs(nb);
        for (let c = 0; c < 2; c++) this.z[c].fill(0, (nb + 1) * 2, 66);
        this.nb = nb;
      }
      const moving = this.lf !== tlf || this.q !== tq || this.sp !== tsp, steps = moving ? 4 : 1, m = n / steps, c32 = this.c32;
      const fI = (cnt.f1 - cnt.f0) / n, i0 = (t0 - g[0]) / n, i1 = (t1 - g[1]) / n, i2 = (t2 - g[2]) / n, i3 = (t3 - g[3]) / n;
      for (let k = 0; k < steps; k++) {
        if (moving) { // glide focus / reso / spread with coefficient updates every 32 samples
          this.lf += (tlf - this.lf) * c32; this.q += (tq - this.q) * c32; this.sp += (tsp - this.sp) * c32;
          if (Math.abs(tlf - this.lf) < 1e-4) this.lf = tlf; if (Math.abs(tq - this.q) < 1e-4) this.q = tq; if (Math.abs(tsp - this.sp) < 1e-4) this.sp = tsp;
          this._coefs(nb);
        }
        const a = Math.round(k * m), e = Math.round((k + 1) * m), f0 = cnt.f0 + fI * a;
        this._k(L, 0, a, e, nb, f0, fI, g, a, i0, i1, i2, i3);
        this._k(R, 1, a, e, nb, f0, fI, g, a, i0, i1, i2, i3);
      }
      g[0] = t0; g[1] = t1; g[2] = t2; g[3] = t3;
    }
    // per-channel allpass chain: TDF-II 2nd-order allpasses; stage nb blended by the fractional AMOUNT
    _k(buf, c, a, e, nb, fw, fI, g, off, i0, i1, i2, i3) {
      const z = this.z[c], co = this.c[c], hpc = this.hpc;
      let fbv = this.fbS[c], hp = this.hpS[c], tr = g[0] + i0 * off, dm = g[1] + i1 * off, dg = g[2] + i2 * off, dn = g[3] + i3 * off;
      const last = Math.min(nb, 31) * 2;
      for (let i = a; i < e; i++) {
        fw += fI; tr += i0; dm += i1; dg += i2; dn += i3;
        hp += hpc * (fbv - hp);
        let x = buf[i] + tr * MOT_tanh(fbv - hp);
        x += (MOT_tanh(x * dg) * dn - x) * dm; // drive (dm = 0 when off)
        let y = x;
        for (let j2 = 0; j2 < last; j2 += 2) {
          const c1 = co[j2], c2 = co[j2 + 1];
          const o = c2 * y + z[j2];
          z[j2] = c1 * (y - o) + z[j2 + 1];
          z[j2 + 1] = y - c2 * o;
          y = o;
        }
        const c1 = co[last], c2 = co[last + 1];
        const o = c2 * y + z[last];
        z[last] = c1 * (y - o) + z[last + 1];
        z[last + 1] = y - c2 * o;
        y += (o - y) * fw;
        fbv = y;
        buf[i] = y;
      }
      this.fbS[c] = fbv; this.hpS[c] = hp;
    }
  });

  // ===========================================================================
  // 16. RADIO — band-limited, compressed, driven AM channel with decay events
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'radio';
    static label = 'RADIO';
    static cat = 'DISTORTION';
    static desc = 'Decaying radio channel: band-pass, AGC compression, detector drive, hiss, static bursts, squelch, dropouts and mistuning.';
    static latency = 0;
    static params = [
      { id: 'freq', label: 'FREQ', min: 300, max: 5000, def: 1400, unit: 'Hz', curve: 'exp' },
      { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 45, unit: '%' },
      { id: 'drive', label: 'DRIVE', min: 0, max: 100, def: 35, unit: '%' },
      { id: 'comp', label: 'COMP', min: 0, max: 100, def: 50, unit: '%' },
      { id: 'noise', label: 'NOISE', min: 0, max: 100, def: 20, unit: '%' },
      { id: 'burst', label: 'BURST', min: 0, max: 100, def: 20, unit: '%' },
      { id: 'squelch', label: 'SQUELCH', min: 0, max: 100, def: 15, unit: '%' },
      { id: 'dropout', label: 'DROPOUT', min: 0, max: 100, def: 10, unit: '%' },
      { id: 'dial', label: 'DIAL', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
    ];
    init() {
      this.ps = new MOT_PSm(this.constructor.params);
      const sr = this.sr;
      this.bs = new Float64Array(16);   // band filter states: [ch*8 + stage*2] ic1, ic2
      this.bq = new MOT_SVF();          // coefficient scratch
      this.hil = [new MOT_Hilbert(), new MOT_Hilbert()];
      // scalar state lives in a typed array (stable double representation for the JIT)
      // 0 ssb cos, 1 ssb sin, 2 whistle cos, 3 whistle sin, 4 in-env, 5 agc-env, 6 drive bias (ramped), 7 agc gain (smoothed)
      // 8 gate, 9 open, 10 hold, 11 tail, 12 burst countdown, 13 burst left, 14 burst level, 15 burst env
      // 16 chop target, 17 chop, 18 chop countdown, 19 dropout countdown, 20 dropout left, 21 dropout gain
      // 22..23 crackle L/R, 24..27 squelch-tail filters, 28 wobble phase, 29 band lo, 30 band hi, 31 drive gain (ramped)
      const S = this.S = new Float64Array(32);
      S[0] = 1; S[2] = 1; S[7] = 1; S[12] = 0.4 * sr; S[19] = 0.9 * sr; S[21] = 1;
      this.dn0 = -1; this.c16 = 1 - Math.exp(-16 / (0.015 * sr)); this.C = new Float64Array(24);
      this.rs = 0x1f83d9ab; this.first = true;
      const K = this.K = new Float64Array(56); // per-block coefficients [0..31], sr constants [40..51]
      K[40] = 1 - Math.exp(-1 / (0.004 * sr)); K[41] = 1 - Math.exp(-1 / (0.012 * sr)); K[42] = 1 - Math.exp(-1 / (0.004 * sr));
      K[43] = 1 - Math.exp(-1 / (0.003 * sr)); K[44] = Math.exp(-16 / (0.05 * sr));
      K[45] = 1 - Math.exp(-TAU * 3500 / sr); K[46] = 1 - Math.exp(-TAU * 600 / sr); K[47] = 0.006 * sr;
      K[48] = Math.exp(-1 / (0.001 * sr)); K[49] = Math.exp(-1 / (0.06 * sr)); K[50] = Math.exp(-1 / (0.003 * sr)); K[51] = Math.exp(-1 / (0.15 * sr));
    }
    process(L, R, n, p) {
      p = this.ps.step(p, n, this.sr);
      const sr = this.sr, S = this.S;
      const dial = p.dial * 0.01, ad = Math.abs(dial);
      // ---- band edges (targets; _ctl glides them in the log domain and recomputes the 24 dB/oct
      //      HP/LP coefficients every 16 samples, shared by L/R). DIAL also shifts the band.
      const fc = p.freq * Math.pow(2, dial * 0.5), bw = 0.6 + p.width * 0.044;
      const tlo = Math.log(clamp(fc * Math.pow(2, -bw / 2), 40, sr * 0.2)), thi = Math.log(clamp(fc * Math.pow(2, bw / 2), 400, sr * 0.45));
      if (this.first) { S[29] = tlo; S[30] = thi; }
      // ---- amounts
      const nz = p.noise * 0.01, nl = Math.pow(nz, 1.5) * 0.08 * (1 + ad) * 3.0517578125e-5, crkP = nz * 30 / sr * 65536, crkA = 1.5e-5 * nz;
      const cx = p.comp * 0.01 * 0.8;
      const drv = p.drive * 0.01, dg = 1 + drv * 10, bias = 0.15 * drv, dn = 0.6 / MOT_tanh(dg * 0.35);
      const burst = p.burst * 0.01, bMean = burst > 0 ? (0.25 + 6 * (1 - burst) * (1 - burst)) * sr : 1e12;
      const drop = p.dropout * 0.01, dMean = drop > 0 ? (0.5 + 9 * (1 - drop) * (1 - drop)) * sr : 1e12;
      const sq = p.squelch * 0.01, thr = sq > 0 ? dbToGain(-72 + sq * 62) : -1, holdN = 0.22 * sr;
      if (this.first) { S[8] = thr > 0 ? 0 : 1; this.first = false; }
      if (burst <= 0) S[12] = Math.max(S[12], 1e9);
      if (drop <= 0) S[19] = Math.max(S[19], 1e9);
      S[12] = Math.min(S[12], 1.7 * bMean + sr); S[19] = Math.min(S[19], 1.7 * dMean + sr);
      // oscillators as rotating phasors (per-block rotation, renormalised): SSB shift and heterodyne whistle
      S[28] = MOT_frac(S[28] + 0.3 * n / sr);
      const sa = TAU * dial * 240 / sr, wa = TAU * (350 + ad * 2800) * (1 + 0.02 * Math.sin(TAU * S[28])) / sr;
      let nrm = 1 / Math.hypot(S[0], S[1]); S[0] *= nrm; S[1] *= nrm;
      nrm = 1 / Math.hypot(S[2], S[3]); S[2] *= nrm; S[3] *= nrm;
      const K = this.K;
      K[0] = tlo; K[1] = thi;
      if (S[31] === 0) { S[31] = dg; S[6] = bias; }
      K[14] = nl; K[15] = crkP; K[16] = crkA; K[17] = cx; K[18] = dg; K[19] = bias; K[21] = dn;
      if (this.dn0 < 0) this.dn0 = dn;
      K[20] = this.dn0; this.dn0 = dn;
      K[22] = burst; K[23] = bMean; K[24] = dMean; K[25] = thr; K[26] = holdN;
      K[27] = Math.cos(sa); K[28] = Math.sin(sa); K[29] = Math.cos(wa); K[30] = Math.sin(wa); K[31] = 0.05 * ad;
      // drive stage ramps (evaluated per sample in the kernel)
      K[32] = S[31]; K[33] = (dg - S[31]) / n; K[34] = S[6]; K[35] = (bias - S[6]) / n; K[36] = K[20]; K[37] = (dn - K[20]) / n;
      S[31] = dg; S[6] = bias;
      for (let off = 0; off < n; off += 16) {
        this._ctl();
        this._k(L, R, off, Math.min(n, off + 16));
      }
    }
    // control rate (every 16 samples): band coefficients, squelch, random events, AGC gain -> this.C
    _ctl() {
      const K = this.K, S = this.S, C = this.C, sr = this.sr, bq = this.bq, STEP = 16;
      S[29] += (K[0] - S[29]) * this.c16; S[30] += (K[1] - S[30]) * this.c16;
      const gl = MOT_g(Math.exp(S[29]), sr), gh = MOT_g(Math.exp(S[30]), sr);
      bq.coef(gl, 1 / 0.5412); C[0] = bq.a1; C[1] = bq.a2; C[2] = bq.a3; C[3] = bq.k;
      bq.coef(gl, 1 / 1.3066); C[4] = bq.a1; C[5] = bq.a2; C[6] = bq.a3; C[7] = bq.k;
      bq.coef(gh, 1 / 0.5412); C[8] = bq.a1; C[9] = bq.a2; C[10] = bq.a3;
      bq.coef(gh, 1 / 1.3066); C[11] = bq.a1; C[12] = bq.a2; C[13] = bq.a3;
      let rs = this.rs; rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; this.rs = rs;
      const uA = (rs & 0xffff) * 1.52587890625e-5, uB = (rs >>> 16) * 1.52587890625e-5;
      // squelch: hysteresis + hold; a closing gate fires the squelch tail
      const thr = K[25], ei = S[4], above = ei > thr * 1.4 ? 1 : 0, open0 = S[9];
      S[10] = above ? K[26] : S[10] - STEP;
      const open = Math.max(above, open0 * Math.max(ei >= thr ? 1 : 0, S[10] > 0 ? 1 : 0));
      S[11] = Math.max(S[11] * K[44], (open0 - open) * 0.3); S[9] = open;
      // events: countdowns re-armed branch-free (static bursts, chop, dropouts)
      const burst = K[22], bMean = K[23], dMean = K[24];
      S[12] -= STEP;
      const bTrig = S[12] <= 0 ? 1 : 0, nbL = (0.03 + 0.35 * uA) * sr, nbV = (0.25 + 0.6 * uB) * burst, nbT = (0.3 + 1.4 * uB) * bMean + nbL;
      S[13] = bTrig ? nbL : S[13] - STEP; S[14] = bTrig ? nbV : S[14]; S[12] = bTrig ? nbT : S[12];
      S[18] -= STEP;
      const cTrig = S[18] <= 0 ? 1 : 0, ncT = uA * uA, ncC = K[47] * (1 + 2 * uB);
      S[16] = cTrig ? ncT : S[16]; S[18] = cTrig ? ncC : S[18];
      S[19] -= STEP;
      const dTrig = S[19] <= 0 ? 1 : 0, ndL = (0.05 + 0.45 * uB) * sr, ndT = (0.3 + 1.4 * uA) * dMean + ndL;
      S[20] = dTrig ? ndL : S[20] - STEP; S[19] = dTrig ? ndT : S[19];
      C[14] = open; C[15] = S[13] > 0 ? 1 : 0; C[16] = 1 - 0.97 * (S[20] > 0 ? 1 : 0); C[17] = S[14]; C[18] = S[16];
      C[19] = Math.max(0.1, Math.min(3, Math.pow(0.35 / (S[5] + 0.003), K[17]))); C[20] = S[11] * 3.0517578125e-5;
    }
    // per-sample kernel (compact so the JIT tiers it up quickly)
    _k(L, R, i0, i1) {
      const K = this.K, S = this.S, C = this.C, hL = this.hil[0], hR = this.hil[1], bs = this.bs;
      const A0 = C[0], B0 = C[1], C0 = C[2], K0 = C[3], A1 = C[4], B1 = C[5], C1 = C[6], K1 = C[7];
      const A2 = C[8], B2 = C[9], C2 = C[10], A3 = C[11], B3 = C[12], C3 = C[13];
      const open = C[14], bOn = C[15], dT = C[16], bLvl = C[17], chT = C[18], cg = C[19], tn = C[20];
      const nl = K[14], crkP = K[15], crkA = K[16], rc = K[27], rsn = K[28], wrc = K[29], wrs = K[30], wl = K[31];
      const dg0 = K[32], dgI = K[33], bi0 = K[34], bI = K[35], dn0 = K[36], dnI = K[37];
      const gc = K[40], dc = K[41], bcf = K[42], cgc = K[43], tl = K[45], th = K[46], mk = 1.15;
      const eia = K[48], eir = K[49], eca = K[50], ecr = K[51];
      let oc = S[0], os = S[1], wc = S[2], ws = S[3], ei = S[4], ec = S[5], cgs = S[7], gate = S[8];
      let bEnv = S[15], chop = S[17], dG = S[21], ck0 = S[22], ck1 = S[23], t0 = S[24], t1 = S[25], t2 = S[26], t3 = S[27], rs = this.rs;
      for (let i = i0; i < i1; i++) {
        const xl0 = L[i], xr0 = R[i];
        const ain = Math.max(Math.abs(xl0), Math.abs(xr0));
        ei = ain + (ain > ei ? eia : eir) * (ei - ain);
        gate += (open - gate) * gc;
        bEnv += (bOn - bEnv) * bcf; chop += (chT - chop) * bcf; dG += (dT - dG) * dc;
        rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
        const na = (rs & 0xffff) - 32768, nb = (rs >>> 16) - 32768;
        const ck = (rs & 0xffff) * 0.37 + (rs >>> 16) * 0.63 < crkP ? 1 : 0;
        ck0 = ck0 * 0.6 + ck * na * crkA; ck1 = ck1 * 0.6 + ck * nb * crkA;
        const nn = nl + bEnv * bLvl * chop * 3.0517578125e-5, sigG = dG * (1 - 0.6 * bEnv);
        // signal + noise -> 24 dB/oct band-pass
        let xl = xl0 * sigG + na * nn + ck0, xr = xr0 * sigG + nb * nn + ck1;
        let v3 = xl - bs[1], v1 = A0 * bs[0] + B0 * v3, v2 = bs[1] + B0 * bs[0] + C0 * v3; bs[0] = 2 * v1 - bs[0]; bs[1] = 2 * v2 - bs[1]; xl = xl - K0 * v1 - v2;
        v3 = xl - bs[3]; v1 = A1 * bs[2] + B1 * v3; v2 = bs[3] + B1 * bs[2] + C1 * v3; bs[2] = 2 * v1 - bs[2]; bs[3] = 2 * v2 - bs[3]; xl = xl - K1 * v1 - v2;
        v3 = xl - bs[5]; v1 = A2 * bs[4] + B2 * v3; v2 = bs[5] + B2 * bs[4] + C2 * v3; bs[4] = 2 * v1 - bs[4]; bs[5] = 2 * v2 - bs[5]; xl = v2;
        v3 = xl - bs[7]; v1 = A3 * bs[6] + B3 * v3; v2 = bs[7] + B3 * bs[6] + C3 * v3; bs[6] = 2 * v1 - bs[6]; bs[7] = 2 * v2 - bs[7]; xl = v2;
        v3 = xr - bs[9]; v1 = A0 * bs[8] + B0 * v3; v2 = bs[9] + B0 * bs[8] + C0 * v3; bs[8] = 2 * v1 - bs[8]; bs[9] = 2 * v2 - bs[9]; xr = xr - K0 * v1 - v2;
        v3 = xr - bs[11]; v1 = A1 * bs[10] + B1 * v3; v2 = bs[11] + B1 * bs[10] + C1 * v3; bs[10] = 2 * v1 - bs[10]; bs[11] = 2 * v2 - bs[11]; xr = xr - K1 * v1 - v2;
        v3 = xr - bs[13]; v1 = A2 * bs[12] + B2 * v3; v2 = bs[13] + B2 * bs[12] + C2 * v3; bs[12] = 2 * v1 - bs[12]; bs[13] = 2 * v2 - bs[13]; xr = v2;
        v3 = xr - bs[15]; v1 = A3 * bs[14] + B3 * v3; v2 = bs[15] + B3 * bs[14] + C3 * v3; bs[14] = 2 * v1 - bs[14]; bs[15] = 2 * v2 - bs[15]; xr = v2;
        // DIAL: single-sideband mistuning (always running; zero shift = allpass)
        let t = oc * rc - os * rsn; os = os * rc + oc * rsn; oc = t;
        hL.process(xl); hR.process(xr);
        xl = hL.re * oc - hL.im * os; xr = hR.re * oc - hR.im * os;
        // AGC follower, detector drive, heterodyne whistle, squelch gate + tail
        const ab = Math.abs(xl) + Math.abs(xr);
        ec = ab + (ab > ec ? eca : ecr) * (ec - ab);
        cgs += (cg - cgs) * cgc;
        t = wc * wrc - ws * wrs; ws = ws * wrc + wc * wrs; wc = t;
        const wv = ws * wl * Math.min(1, ec * 6), gg = gate * mk;
        t0 += tl * (na * tn - t0); t1 += th * (t0 - t1); t2 += tl * (nb * tn - t2); t3 += th * (t2 - t3);
        const j = i + 1, dg = dg0 + dgI * j, bias = bi0 + bI * j, dn = dn0 + dnI * j, tb = MOT_tanh(bias);
        L[i] = ((MOT_tanh(dg * xl * cgs + bias) - tb) * dn + wv) * gg + t0 - t1;
        R[i] = ((MOT_tanh(dg * xr * cgs + bias) - tb) * dn + wv) * gg + t2 - t3;
      }
      S[0] = oc; S[1] = os; S[2] = wc; S[3] = ws; S[4] = ei; S[5] = ec; S[7] = cgs; S[8] = gate;
      S[15] = bEnv; S[17] = chop; S[21] = dG; S[22] = ck0; S[23] = ck1; S[24] = t0; S[25] = t1; S[26] = t2; S[27] = t3;
      this.rs = rs;
    }
  });
})();
