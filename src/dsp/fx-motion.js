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
  const MOT_HA = new Float64Array([0.6923878, 0.9360654322959, 0.9882295226860, 0.9987488452737].map((a) => a * a));
  const MOT_HB = new Float64Array([0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278].map((a) => a * a));
  class MOT_Hilbert {
    constructor() { this.s = new Float64Array(32); this.d = 0; this.re = 0; this.im = 0; }
    reset() { this.s.fill(0); this.d = 0; this.re = this.im = 0; }
    process(x) {
      const s = this.s; let a = x, b = x;
      for (let k = 0; k < 4; k++) {
        const o = k * 4, c = MOT_HA[k];
        const y = c * (a + s[o + 3]) - s[o + 1];
        s[o + 1] = s[o]; s[o] = a; s[o + 3] = s[o + 2]; s[o + 2] = y; a = y;
        const o2 = o + 16, c2 = MOT_HB[k];
        const y2 = c2 * (b + s[o2 + 3]) - s[o2 + 1];
        s[o2 + 1] = s[o2]; s[o2] = b; s[o2 + 3] = s[o2 + 2]; s[o2 + 2] = y2; b = y2;
      }
      this.re = this.d; this.d = a; this.im = b;
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
      this.f = [[], []];
      for (let c = 0; c < 2; c++) for (let j = 0; j < 7; j++) this.f[c].push(new MOT_SVF());
      this.cur = new Float64Array(10); this.tg = new Float64Array(10);
      this.first = true; this.lc = false; this.hc = false;
    }
    process(L, R, n, p) {
      const sr = this.sr, cur = this.cur, tg = this.tg;
      tg[0] = p.low; tg[1] = p.mid; tg[2] = p.high; tg[3] = Math.log(p.lowcut); tg[4] = Math.log(p.hicut);
      tg[5] = p.drive * 0.01; tg[6] = Math.log(p.lowf); tg[7] = Math.log(p.midf); tg[8] = Math.log(p.midq); tg[9] = Math.log(p.highf);
      let changed = false;
      if (this.first) { cur.set(tg); changed = true; this.first = false; }
      else {
        for (let j = 0; j < 10; j++) {
          const d = tg[j] - cur[j];
          if (d === 0) continue;
          if (d < 1e-4 && d > -1e-4) cur[j] = tg[j]; else cur[j] += d * 0.3;
          changed = true;
        }
      }
      if (changed) {
        const lcf = Math.exp(cur[3]), hcf = Math.exp(cur[4]);
        const lc = lcf > 20.5, hc = hcf < 19500;
        for (let c = 0; c < 2; c++) {
          const f = this.f[c];
          MOT_eqSet(f[0], 0, Math.exp(cur[6]), cur[0], 0.71, sr);
          MOT_eqSet(f[1], 1, Math.exp(cur[7]), cur[1], Math.exp(cur[8]), sr);
          MOT_eqSet(f[2], 2, Math.exp(cur[9]), cur[2], 0.71, sr);
          if (lc && !this.lc) { f[3].reset(); f[4].reset(); }
          if (hc && !this.hc) { f[5].reset(); f[6].reset(); }
          MOT_eqSet(f[3], 3, lcf, 0, 0.5412, sr); MOT_eqSet(f[4], 3, lcf, 0, 1.3066, sr);
          MOT_eqSet(f[5], 4, hcf, 0, 0.5412, sr); MOT_eqSet(f[6], 4, hcf, 0, 1.3066, sr);
        }
        this.lc = lc; this.hc = hc;
      }
      const d = cur[5], dm = d * 3 > 1 ? 1 : d * 3, dg = 1 + 19 * d * d, dn = 0.5 / MOT_tanh(0.5 * dg);
      const lc = this.lc, hc = this.hc;
      for (let c = 0; c < 2; c++) {
        const buf = c ? R : L, f = this.f[c];
        const f0 = f[0], f1 = f[1], f2 = f[2], f3 = f[3], f4 = f[4], f5 = f[5], f6 = f[6];
        for (let i = 0; i < n; i++) {
          let x = f2.run(f1.run(f0.run(buf[i])));
          if (d > 0) x += (MOT_tanh(x * dg) * dn - x) * dm;
          if (lc) x = f4.run(f3.run(x));
          if (hc) x = f6.run(f5.run(x));
          buf[i] = x;
        }
      }
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
      { id: 'res', label: 'RES', min: 0, max: 100, def: 55, unit: '%' },
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
      const sr = this.sr;
      this.s = [new Float64Array(6), new Float64Array(6)];
      this.env = [new EnvFollower(sr, 2, 150), new EnvFollower(sr, 2, 150)];
      this.lfS = new Smoother(sr, 25, Math.log(650)); this.first = true;
      this.dv = new Float64Array(2); this.dt = new Float64Array(2); this.dtm = new Int32Array(2);
      this.kj = new Float64Array(2); this.pop = new Float64Array(2);
      this.rng = new Rng(0x51f15e); this.snp = new MOT_Snap();
      const gh = Math.tan(Math.PI * 110 / sr); this.hpG = gh / (1 + gh);
      this.lastType = -1; this.gc = new Float64Array(6);
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, type = p.type | 0, mode = p.mode | 0, slope = p.slope | 0;
      if (type !== this.lastType) { this.s[0].fill(0); this.s[1].fill(0); this.lastType = type; }
      const res = p.res * 0.01, drv = p.drive * 0.01, drift = p.drift * 0.01;
      const fm = p.fm * 0.01 * 3 * MOT_LN2, envA = p.env * 0.01 * 4 * MOT_LN2;
      let fc = p.cutoff; if (p.snap) fc = this.snp.hz(ctx.key, fc);
      const lt = Math.log(fc);
      if (this.first) { this.lfS.snap(lt); this.first = false; } else this.lfS.set(lt);
      const rng = this.rng, broken = type === 3;
      for (let c = 0; c < 2; c++) {
        if (--this.dtm[c] <= 0) { this.dt[c] = rng.bi(); this.dtm[c] = 40 + rng.int(160); }
        this.dv[c] += (this.dt[c] - this.dv[c]) * 0.015;
        if (broken) { this.kj[c] += (rng.bi() - this.kj[c]) * 0.08; if (rng.chance(0.04)) this.pop[c] = rng.bi(); }
      }
      const dS = (broken ? 0.9 : 0.5) * MOT_LN2 * drift;
      const d0 = this.dv[0] * dS, d1 = this.dv[1] * dS;
      const dr = 1 + 9 * drv * drv, og = 1 / Math.pow(dr, 0.55);
      const useEnv = envA !== 0 || broken;
      const lfS = this.lfS, sL = this.s[0], sR = this.s[1], eL = this.env[0], eR = this.env[1];
      if (type === 0) {
        // ---- SVF core: optional pre-stage (Q .54) + resonant stage with saturating band state
        let kB = 1.414 * Math.pow(1 - res, 1.3) - 0.03 * Math.pow(res, 8);
        const kA = 1.848, two = slope === 3 || ((mode === 1 || mode === 3) && slope === 2);
        const bpn = 1.5 * (kB > 0.03 ? kB : 0.03), op = slope === 2 && (mode === 0 || mode === 2);
        const ar = useEnv || fm !== 0;
        let gL = 0, gR = 0;
        for (let i = 0; i < n; i++) {
          const lf0 = lfS.next(), upd = ar || (i & 3) === 0;
          for (let c = 0; c < 2; c++) {
            const buf = c ? R : L, s = c ? sR : sL, x = buf[i];
            let g = c ? gR : gL;
            if (upd) {
              let lf = lf0 + (c ? d1 : d0);
              if (useEnv) lf += envA * (c ? eR : eL).process(x);
              lf += fm * x;
              g = MOT_g(Math.exp(lf), sr);
              if (c) gR = g; else gL = g;
            }
            let v = MOT_tanh(x * dr * 0.8) * 1.25;
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
            buf[i] = y * og;
          }
        }
        return;
      }
      // ---- ladder cores (linear ZDF solve + input nonlinearity)
      const diode = type === 2;
      const k0 = diode ? res * 5.2 : res * 4.15;
      let cm = 1;
      if (mode === 0) cm = diode ? 1 + 0.15 * k0 : 1 + 0.7 * k0;
      else if (mode === 3) cm = diode ? 1 + 0.1 * k0 : 1 + 0.35 * k0;
      const xo = (mode * 4 + slope) * 5;
      const t0 = MOT_XP[xo], t1 = MOT_XP[xo + 1], t2 = MOT_XP[xo + 2], t3 = MOT_XP[xo + 3], t4 = MOT_XP[xo + 4];
      const Gh = this.hpG, Bh = diode ? 1 - Gh : 1;
      const sag = 1.6 * MOT_LN2 * (0.3 + drv);
      const popA = 0.08 * drv + 0.02;
      const ar = useEnv || fm !== 0, gc = this.gc;
      for (let i = 0; i < n; i++) {
        const lf0 = lfS.next(), upd = ar || (i & 3) === 0;
        for (let c = 0; c < 2; c++) {
          const buf = c ? R : L, s = c ? sR : sL, x = buf[i], o = c * 3;
          let e = 0;
          if (upd) {
            let lf = lf0 + (c ? d1 : d0);
            if (useEnv) { e = (c ? eR : eL).process(x); lf += envA * e; }
            lf += fm * x - sag * e * (broken ? 1 : 0);
            const g = MOT_g(Math.exp(lf), sr);
            if (diode) { const ga = g * 1.6, gd = g * 0.7; gc[o] = ga / (1 + ga); gc[o + 1] = g / (1 + g); gc[o + 2] = gd / (1 + gd); }
            else { const G = g / (1 + g); gc[o] = G; gc[o + 1] = G; gc[o + 2] = G; }
          }
          const G1 = gc[o], G2 = gc[o + 1], G4 = gc[o + 2], G3 = G2;
          const S = (1 - G4) * s[3] + G4 * ((1 - G3) * s[2] + G3 * ((1 - G2) * s[1] + G2 * (1 - G1) * s[0]));
          const GG = G1 * G2 * G3 * G4;
          let xin = x * dr * cm;
          let k = k0;
          if (broken) { k = k0 * (1 + 0.22 * (c ? this.kj[1] : this.kj[0])); xin += (c ? this.pop[1] : this.pop[0]) * e * popA; }
          const sh = diode ? s[4] : 0;
          const y4e = (GG * (xin + k * Bh * sh) + S) / (1 + k * GG * Bh);
          let u = xin - k * Bh * (y4e - sh);
          if (type === 1) u = MOT_tanh(u);
          else if (diode) u = MOT_tanh(u + 0.3) - 0.2913;
          else { const a = u < 0 ? -u : u; u = u * (a + 0.012) / (a + 0.05); u = MOT_tanh(u > 0 ? u * 1.25 : u * 0.8); }
          let w = (u - s[0]) * G1; const y1 = w + s[0]; s[0] = y1 + w;
          w = (y1 - s[1]) * G2; const y2 = w + s[1]; s[1] = y2 + w;
          w = (y2 - s[2]) * G3; const y3 = w + s[2]; s[2] = y3 + w;
          if (broken) s[2] = Math.max(-0.45, Math.min(0.6, s[2]));
          w = (y3 - s[3]) * G4; const y4 = w + s[3]; s[3] = y4 + w;
          if (diode) s[4] += 2 * (y4 - s[4]) * Gh;
          buf[i] = (t0 * u + t1 * y1 + t2 * y2 + t3 * y3 + t4 * y4) * og;
        }
      }
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
      const sr = this.sr, maxD = Math.ceil(sr / 7) + 8, sz = MOT_pow2(maxD + 8);
      this.rb = []; for (let j = 0; j < 6; j++) this.rb.push(new Float32Array(sz));
      this.rm = sz - 1; this.rw = 0; this.maxD = maxD - 8;
      this.st = new Float64Array(10);  // tone ic1/ic2 L, R; loop low-pass x6
      this.dv = new Float64Array(3); this.dt = new Float64Array(3);
      this.sc = 1 - Math.exp(-1 / (0.025 * sr));
      this.tone = new MOT_SVF();
      this.efa = Math.exp(-1 / (0.0003 * sr)); this.efr = Math.exp(-1 / (0.015 * sr));
      this.esa = Math.exp(-1 / (0.012 * sr)); this.esr = Math.exp(-1 / (0.2 * sr));
      this.ef = 0; this.es = 0; this.rs = 0x2545f491;
      this.bAmp = 0; this.bDec = Math.exp(-1 / (0.007 * sr)); this.refr = 0;
      this.snp = [new MOT_Snap(), new MOT_Snap(), new MOT_Snap()];
      this.first = true; this.toneV = 0;
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, fb = p.fb * 0.01, neg = fb < 0, afb = neg ? -fb : fb;
      const damp = p.damp * 0.01;
      const fd = 18000 * Math.pow(600 / 18000, damp), cl = 1 - Math.exp(-2 * Math.PI * fd / sr), gd = (1 - cl) / cl;
      const dt = this.dt, dv = this.dv;
      for (let j = 0; j < 3; j++) {
        let f = p.freq * semisToRatio(j === 0 ? 0 : j === 1 ? p.off1 : p.off2);
        if (p.snap) f = this.snp[j].hz(ctx.key, f);
        // delay for y[n-D] read before the write; negative feedback halves it (odd harmonics at FREQ)
        let D = sr / f * (neg ? 0.5 : 1) - gd - 1;
        if (D < 3) D = 3; else if (D > this.maxD) D = this.maxD;
        dt[j] = D; if (this.first) dv[j] = D;
      }
      // tone tilt: LP below centre, HP above (one coefficient set for both channels)
      const tv = p.tone * 0.01;
      this.toneV += (tv - this.toneV) * (this.first ? 1 : 0.3);
      this.first = false;
      const t = this.toneV, tf = this.tone;
      if (t <= 0) tf.lp(MOT_g(18000 * Math.pow(2, t * 6.5), sr), 0.6); else tf.hp(MOT_g(20 * Math.pow(2, t * 7.6), sr), 0.6);
      const ta1 = tf.a1, ta2 = tf.a2, ta3 = tf.a3, tm0 = tf.m0, tm1 = tf.m1, tm2 = tf.m2;
      const og = 0.5 * Math.sqrt((1 - afb * afb) / (1 + afb * afb)) + 0.02;
      const pl = p.pluck * 0.01, refrN = Math.round(0.06 * sr), bDec = this.bDec, sc = this.sc;
      const efa = this.efa, efr = this.efr, esa = this.esa, esr = this.esr;
      const b0 = this.rb[0], b1 = this.rb[1], b2 = this.rb[2], b3 = this.rb[3], b4 = this.rb[4], b5 = this.rb[5], m = this.rm;
      const st = this.st, t0 = dt[0], t1 = dt[1], t2 = dt[2];
      let w = this.rw, v0 = dv[0], v1 = dv[1], v2 = dv[2], ef = this.ef, es = this.es, rs = this.rs, bAmp = this.bAmp, refr = this.refr;
      let tl1 = st[0], tl2 = st[1], tr1 = st[2], tr2 = st[3], l0 = st[4], l1 = st[5], l2 = st[6], l3 = st[7], l4 = st[8], l5 = st[9];
      for (let i = 0; i < n; i++) {
        v0 += (t0 - v0) * sc; v1 += (t1 - v1) * sc; v2 += (t2 - v2) * sc;
        let xl = L[i], xr = R[i];
        const am = 0.5 * ((xl < 0 ? -xl : xl) + (xr < 0 ? -xr : xr));
        ef = am + (am > ef ? efa : efr) * (ef - am); es = am + (am > es ? esa : esr) * (es - am);
        // transient -> pluck burst (branch-light so the JIT never meets a cold path)
        refr--;
        const hit = (ef - es * 1.6 - 0.01) * pl;
        if (hit > 0 && refr < 0) { bAmp = Math.max(bAmp, pl * Math.min(1, ef * 2) * 0.8); refr = refrN; }
        rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
        xl += ((rs & 0xffff) * 3.0517578125e-5 - 1) * bAmp; xr += ((rs >>> 16) * 3.0517578125e-5 - 1) * bAmp;
        bAmp *= bDec;
        // tone filter (SVF, mixed output)
        let v3 = xl - tl2, q1 = ta1 * tl1 + ta2 * v3, q2 = tl2 + ta2 * tl1 + ta3 * v3;
        tl1 = 2 * q1 - tl1; tl2 = 2 * q2 - tl2; const exl = tm0 * xl + tm1 * q1 + tm2 * q2;
        v3 = xr - tr2; q1 = ta1 * tr1 + ta2 * v3; q2 = tr2 + ta2 * tr1 + ta3 * v3;
        tr1 = 2 * q1 - tr1; tr2 = 2 * q2 - tr2; const exr = tm0 * xr + tm1 * q1 + tm2 * q2;
        // combs: y = ex + fb * tanh(lp(y[n-D]))
        let y, sl, sr2;
        l0 += cl * (MOT_rd(b0, m, w, v0) - l0); y = exl + fb * MOT_tanh(l0); b0[w] = y; sl = y;
        l1 += cl * (MOT_rd(b1, m, w, v1) - l1); y = exl + fb * MOT_tanh(l1); b1[w] = y; sl += y;
        l2 += cl * (MOT_rd(b2, m, w, v2) - l2); y = exl + fb * MOT_tanh(l2); b2[w] = y; sl += y;
        l3 += cl * (MOT_rd(b3, m, w, v0) - l3); y = exr + fb * MOT_tanh(l3); b3[w] = y; sr2 = y;
        l4 += cl * (MOT_rd(b4, m, w, v1) - l4); y = exr + fb * MOT_tanh(l4); b4[w] = y; sr2 += y;
        l5 += cl * (MOT_rd(b5, m, w, v2) - l5); y = exr + fb * MOT_tanh(l5); b5[w] = y; sr2 += y;
        w = (w + 1) & m;
        L[i] = sl * og; R[i] = sr2 * og;
      }
      st[0] = tl1; st[1] = tl2; st[2] = tr1; st[3] = tr2; st[4] = l0; st[5] = l1; st[6] = l2; st[7] = l3; st[8] = l4; st[9] = l5;
      dv[0] = v0; dv[1] = v1; dv[2] = v2; this.rw = w; this.ef = ef; this.es = es; this.rs = rs;
      this.bAmp = bAmp < 1e-6 ? 0 : bAmp; this.refr = refr < -1e6 ? -1 : refr;
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
      this.st = [new Float64Array(10), new Float64Array(10)];
      this.cf = [new Float64Array(20), new Float64Array(20)];
      this.pv = 0; this.first = true;
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, V = MOT_VOICES[p.voice | 0] || MOT_VOICES[0];
      const base = p.vowel * 0.04;
      const qs = Math.pow(2, (0.5 - p.q * 0.01) * 3.2);
      const shL = p.shift / 12 * MOT_LN2, sp = p.spread * 0.01;
      const gc = 1 - Math.exp(-16 / (Math.max(1, p.glide) * 0.001 * sr));
      const mk = 2.6;
      for (let off = 0; off < n; off += 16) {
        const m = n - off < 16 ? n - off : 16;
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
          let i0 = Math.floor(pos); if (i0 > 4) i0 = 4;
          const fr = pos - i0, i1 = i0 === 4 ? 0 : i0 + 1;
          const lo = shL + (c ? sp : -sp) * 0.04, cf = this.cf[c];
          for (let j = 0; j < 5; j++) {
            const o0 = (i0 * 5 + j) * 3, o1 = (i1 * 5 + j) * 3;
            const F = Math.exp(V[o0] + (V[o1] - V[o0]) * fr + lo);
            const amp = V[o0 + 1] + (V[o1 + 1] - V[o0 + 1]) * fr;
            let k = (V[o0 + 2] + (V[o1 + 2] - V[o0 + 2]) * fr) * qs / F;
            k = Math.max(0.015, Math.min(1.6, k));
            const g = MOT_g(F, sr), a1 = 1 / (1 + g * (g + k)), o = j * 4;
            cf[o] = a1; cf[o + 1] = g * a1; cf[o + 2] = g * g * a1; cf[o + 3] = amp * k * mk;
          }
        }
        for (let c = 0; c < 2; c++) {
          const buf = c ? R : L, cf = this.cf[c], st = this.st[c], e = off + m;
          for (let i = off; i < e; i++) {
            const x = buf[i]; let y = 0;
            for (let j = 0; j < 5; j++) {
              const o = j * 4, s = j * 2, ic1 = st[s], ic2 = st[s + 1];
              const v3 = x - ic2, v1 = cf[o] * ic1 + cf[o + 1] * v3, v2 = ic2 + cf[o + 1] * ic1 + cf[o + 2] * v3;
              st[s] = 2 * v1 - ic1; st[s + 1] = 2 * v2 - ic2;
              y += cf[o + 3] * v1;
            }
            buf[i] = y;
          }
        }
      }
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
      this.st = [new Float64Array(16), new Float64Array(16)];
      this.cf = [new Float64Array(24), new Float64Array(24)];
      this.lv = new Float64Array(6);
      this.fbS = new Float64Array(2);
      this.lfo = new MOT_LFO(); this.env = new EnvFollower(this.sr, 4, 160);
      this.lf = 0; this.first = true; this.ev = 0;
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, S = clamp(p.sections | 0, 2, 8);
      const ph0 = this.lfo.block(1, p.rate, 0, ctx, n, sr, false), inc = this.lfo.inc;
      const tl = Math.log(p.freq);
      if (this.first) { this.lf = tl; this.first = false; } else this.lf += (tl - this.lf) * 0.3;
      const dep = p.depth * 0.01 * 2.2 * MOT_LN2, envA = p.env * 0.01 * 3 * MOT_LN2, spr = p.spread * 0.01 * 3 * MOT_LN2;
      const fb = p.fdbk * 0.01, og = 1 / (1 + (fb < 0 ? -fb : fb) * 0.6);
      const K = 0.6, lv = this.lv, env = this.env, fbS = this.fbS;
      for (let off = 0; off < n; off += 8) {
        const m = n - off < 8 ? n - off : 8;
        const ph = ph0 + inc * (off + m * 0.5);
        for (let c = 0; c < 2; c++) for (let g = 0; g < 3; g++) lv[c * 3 + g] = Math.sin(TAU * (ph + g / 3 + (c ? 1 / 6 : 0)));
        const eo = envA * this.ev;
        for (let c = 0; c < 2; c++) {
          const cf = this.cf[c];
          for (let j = 0; j < S; j++) {
            const lf = this.lf + dep * lv[c * 3 + (j % 3)] + eo + spr * (j / (S - 1) - 0.5);
            const g = MOT_g(Math.exp(lf), sr), a1 = 1 / (1 + g * (g + K)), o = j * 3;
            cf[o] = a1; cf[o + 1] = g * a1; cf[o + 2] = g * g * a1;
          }
        }
        const e = off + m;
        let ev = this.ev;
        for (let i = off; i < e; i++) {
          const xl = L[i], xr = R[i];
          ev = env.process(0.5 * (xl + xr));
          for (let c = 0; c < 2; c++) {
            const cf = this.cf[c], st = this.st[c];
            let x = (c ? xr : xl) + fb * MOT_tanh(fbS[c]);
            for (let j = 0; j < S; j++) {
              const o = j * 3, s = j * 2, ic1 = st[s], ic2 = st[s + 1];
              const v3 = x - ic2, v1 = cf[o] * ic1 + cf[o + 1] * v3, v2 = ic2 + cf[o + 1] * ic1 + cf[o + 2] * v3;
              st[s] = 2 * v1 - ic1; st[s + 1] = 2 * v2 - ic2;
              x -= K * v1;
            }
            fbS[c] = x;
            if (c) R[i] = x * og; else L[i] = x * og;
          }
        }
        this.ev = ev;
      }
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
      const sr = this.sr, max = Math.ceil(sr * 0.1);
      this.dl = [new DelayLine(max), new DelayLine(max)];
      this.lfo = new MOT_LFO();
      this.tS = new Smoother(sr, 60, 12); this.aS = new Smoother(sr, 60, 0); this.first = true;
      this.fbL = 0; this.fbR = 0;
      this.lp = [new MOT_SVF(), new MOT_SVF()];
      for (const f of this.lp) f.lp(MOT_g(7000, sr), 0.6);
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, msr = sr * 0.001, mode = p.mode | 0;
      let ph = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, false); const inc = this.lfo.inc;
      const tms = p.time * (mode === 1 ? 0.7 : 1);
      const amp = p.depth * 0.01 * Math.min(p.time * 0.45, 8) * (mode === 1 ? 0.45 : 1);
      if (this.first) { this.tS.snap(tms); this.aS.snap(amp); this.first = false; } else { this.tS.set(tms); this.aS.set(amp); }
      const fb = p.fdbk * 0.01, w = p.width * 0.01, wa = 0.5 + 0.5 * w, wb = 0.5 - 0.5 * w;
      const dlL = this.dl[0], dlR = this.dl[1], tS = this.tS, aS = this.aS, lpL = this.lp[0], lpR = this.lp[1];
      let fbL = this.fbL, fbR = this.fbR;
      for (let i = 0; i < n; i++) {
        ph += inc; if (ph >= 1) ph -= 1;
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
      const sr = this.sr, max = Math.ceil(sr * 0.05);
      this.dl = [new DelayLine(max), new DelayLine(max)];
      this.lfo = new MOT_LFO(); this.p2 = 0;
      this.rot = new Float64Array(12); // per channel, per tap: cos/sin of phase offsets
      this.lp = [new MOT_SVF(), new MOT_SVF()];
      this.fbS = new Float64Array(2);
      this.env = new EnvFollower(sr, 5, 200);
      this.rng = new Rng(0xe95e); this.wr = 0; this.wt = 0; this.wc = 0;
      this.dS = new Smoother(sr, 80, 0); this.first = true;
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, msr = sr * 0.001, type = p.type | 0;
      let p1 = this.lfo.block(p.sync, p.div, p.rate1, ctx, n, sr, false); const i1 = this.lfo.inc;
      let p2 = this.p2; const i2 = p.rate2 / sr;
      const dep = p.depth * 0.01, w = p.width * 0.01, fb = p.fdbk * 0.01, bbd = p.bbd * 0.01;
      if (this.first) { this.dS.snap(dep); this.first = false; } else this.dS.set(dep);
      // tap phase offsets (cycles): 3 taps 120° apart, R channel rotated by width
      const rot = this.rot, roff = w * (type === 1 ? 0.33 : 0.25);
      for (let c = 0; c < 2; c++) for (let k = 0; k < 3; k++) {
        const a = TAU * (k / 3 + (c ? roff : 0)), o = (c * 3 + k) * 2; rot[o] = Math.cos(a); rot[o + 1] = Math.sin(a);
      }
      let base = 6, A1 = 1.6, A2 = 0.22;
      if (type === 1) { base = 10; A1 = 2.8; A2 = 0.3; } else if (type === 2) { base = 4; A1 = 0.9; A2 = 0; } else if (type === 3) { base = 8; A1 = 1.4; A2 = 0.12; }
      base *= msr; A1 *= msr; A2 *= msr;
      const lpf = 16000 * Math.pow(2, -bbd * 2.2) * (type === 3 ? 0.7 : 1);
      for (const f of this.lp) f.lp(MOT_g(lpf, sr), 0.65);
      const sat = 1 + bbd * 1.5, satN = 1 / sat, nz = bbd * 0.02;
      // TAPE wander (random wow), per block
      if (type === 3) { if (--this.wc <= 0) { this.wt = this.rng.bi(); this.wc = 20 + this.rng.int(60); } this.wr += (this.wt - this.wr) * 0.03; }
      const wr = this.wr * 0.5 * msr;
      const dlL = this.dl[0], dlR = this.dl[1], lpL = this.lp[0], lpR = this.lp[1], fbS = this.fbS, env = this.env, rng = this.rng, dS = this.dS;
      const ms = 1 - 0.5 * (1 - w);
      for (let i = 0; i < n; i++) {
        p1 += i1; if (p1 >= 1) p1 -= 1;
        p2 += i2; if (p2 >= 1) p2 -= 1;
        const d = dS.next();
        const s1 = Math.sin(TAU * p1), c1 = Math.cos(TAU * p1), s2 = Math.sin(TAU * p2), c2 = Math.cos(TAU * p2);
        const xl = L[i], xr = R[i];
        const e = env.process(0.5 * (xl + xr));
        dlL.write(xl + fb * MOT_tanh(fbS[0])); dlR.write(xr + fb * MOT_tanh(fbS[1]));
        let oL, oR;
        if (type <= 1) {
          let a0 = 0, a1 = 0;
          for (let k = 0; k < 3; k++) {
            let o = k * 2;
            const ml = s1 * rot[o] + c1 * rot[o + 1], fl = s2 * rot[o] + c2 * rot[o + 1];
            a0 += dlL.read(base + d * (A1 * ml + A2 * fl) + k * 0.4 * msr);
            o = (3 + k) * 2;
            const mr = s1 * rot[o] + c1 * rot[o + 1], fr = s2 * rot[o] + c2 * rot[o + 1];
            a1 += dlR.read(base + d * (A1 * mr + A2 * fr) + k * 0.4 * msr);
          }
          oL = a0 * 0.58; oR = a1 * 0.58;
          fbS[0] = oL; fbS[1] = oR;
        } else if (type === 2) {
          const tri = 1 - 4 * Math.abs(p1 - 0.5);
          const v0 = dlL.read(base + d * A1 * tri), v1 = dlR.read(base + d * A1 * -tri);
          fbS[0] = v0; fbS[1] = v1;
          oL = v0; oR = v1;
        } else {
          const v0 = dlL.read(base + d * (A1 * s1 + A2 * s2 + wr));
          const v1 = dlR.read(base + d * (A1 * (s1 * rot[6] + c1 * rot[7]) + A2 * (s2 * rot[6] + c2 * rot[7]) + wr));
          fbS[0] = v0; fbS[1] = v1;
          oL = v0; oR = v1;
        }
        // BBD colour: darkening, soft saturation, signal-following grit
        oL = MOT_tanh(lpL.run(oL) * sat) * satN + rng.bi() * nz * e;
        oR = MOT_tanh(lpR.run(oR) * sat) * satN + rng.bi() * nz * e;
        if (type === 2) { L[i] = 0.6 * xl + 0.6 * oL - 0.3 * w * oR; R[i] = 0.6 * xr + 0.6 * oR - 0.3 * w * oL; }
        else if (type === 3) { L[i] = 0.6 * (xl + oL); R[i] = 0.6 * (xr + oR); }
        else { const mid = 0.5 * (oL + oR), side = 0.5 * (oL - oR) * ms; L[i] = mid + side; R[i] = mid - side; }
      }
      this.p2 = p2;
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
      const sr = this.sr;
      this.dl = [new DelayLine(Math.ceil(sr * 0.1)), new DelayLine(Math.ceil(sr * 0.1))];
      this.lfo = new MOT_LFO();
      this.bS = new Smoother(sr, 40, 0.7); this.dS = new Smoother(sr, 40, 0.75); this.first = true;
      this.fbS = new Float64Array(2);
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, msr = sr * 0.001;
      let ph = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, false); const inc = this.lfo.inc;
      if (this.first) { this.bS.snap(p.delay); this.dS.snap(p.depth * 0.01); this.first = false; }
      else { this.bS.set(p.delay); this.dS.set(p.depth * 0.01); }
      const fb = p.fdbk * 0.01, sg = fb < 0 ? -1 : 1, barber = p.barber | 0, tzf = p.tzf && !barber;
      const wo = p.width * 0.005, fbS = this.fbS, bS = this.bS, dS = this.dS;
      for (let i = 0; i < n; i++) {
        ph += inc; if (ph >= 1) ph -= 1;
        const base = bS.next() * msr, dep = dS.next();
        for (let c = 0; c < 2; c++) {
          const buf = c ? R : L, dl = this.dl[c], x = buf[i];
          dl.write(x + fb * MOT_tanh(fbS[c]));
          const pc = c ? ph + wo : ph;
          let dry = x, wet;
          if (barber) {
            const r1 = pc - Math.floor(pc), r2 = MOT_frac(pc + 0.5), oc = 1 + dep * 3;
            const e1 = barber === 1 ? 1 - r1 : r1, e2 = barber === 1 ? 1 - r2 : r2;
            const t1 = dl.read(2 + base * Math.exp(oc * MOT_LN2 * e1)), t2 = dl.read(2 + base * Math.exp(oc * MOT_LN2 * e2));
            const w1 = 0.5 - 0.5 * Math.cos(TAU * r1);
            wet = t1 * w1 + t2 * (1 - w1);
          } else if (tzf) {
            const l = Math.cos(TAU * pc);
            const ref = base + 2;
            dry = dl.read(ref);
            wet = dl.read(2 + base * (1 + dep * l));
          } else {
            const l = 0.5 - 0.5 * Math.cos(TAU * pc);
            wet = dl.read(1.5 + base * Math.exp(dep * 3 * MOT_LN2 * l));
          }
          fbS[c] = wet;
          buf[i] = 0.5 * (dry + sg * wet);
        }
      }
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
      this.z = [new Float64Array(24), new Float64Array(24)]; // 2 chains x 12 stages
      this.fbS = new Float64Array(4);
      this.lfo = new MOT_LFO();
      this.cS = new Smoother(this.sr, 40, Math.log(700)); this.first = true;
      this.ac = new Float64Array(4); this.wc = new Float64Array(4);
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, S = clamp(p.stages | 0, 1, 12), barber = p.barber | 0;
      let ph = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, false); const inc = this.lfo.inc;
      const lc = Math.log(p.center);
      if (this.first) { this.cS.snap(lc); this.first = false; } else this.cS.set(lc);
      const dep = p.depth * 0.01, fb = p.fdbk * 0.01, wo = p.width * 0.005, fbS = this.fbS, cS = this.cS;
      const piSr = Math.PI / sr, oc = (1 + dep * 4) * MOT_LN2, sw = dep * 2.5 * MOT_LN2, fmax = sr * 0.45;
      const ac = this.ac, wc = this.wc;
      for (let i = 0; i < n; i++) {
        ph += inc; if (ph >= 1) ph -= 1;
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
          const buf = c ? R : L, z = this.z[c], x = buf[i];
          if (!barber) {
            const a = ac[c * 2];
            let y = x + fb * MOT_tanh(fbS[c]);
            for (let j = 0; j < S; j++) { const o = a * y + z[j]; z[j] = y - a * o; y = o; }
            fbS[c] = y;
            buf[i] = 0.5 * (x + y);
          } else {
            let acc = 0;
            for (let h = 0; h < 2; h++) {
              const a = ac[c * 2 + h], zo = h * 12, fi = c * 2 + h;
              let y = x + fb * MOT_tanh(fbS[fi]);
              for (let j = 0; j < S; j++) { const o = a * y + z[zo + j]; z[zo + j] = y - a * o; y = o; }
              fbS[fi] = y;
              acc += y * wc[fi];
            }
            buf[i] = 0.5 * (x + acc);
          }
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
      const sr = this.sr;
      this.phL = 0; this.phR = 0.25; this.lf = Math.log(320); this.first = true;
      this.det = new MOT_SVF(); this.det.lp(MOT_g(900, sr), 0.7);
      this.dc = new DCBlock(0.995); this.env = new EnvFollower(sr, 2, 80);
      this.st = 0; this.cnt = 0; this.est = 220; this.snp = new MOT_Snap();
    }
    process(L, R, n, p, ctx) {
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
      const sh = p.shape * 0.01, sd = 1 + sh * sh * 20, sn = 1 / MOT_tanh(sd);
      const b = p.bias * 0.01, cg = 1 - 0.5 * b, co = 0.5 * b, mk = 1.25 - 0.25 * b;
      let phL = this.phL, phR = this.phR;
      for (let i = 0; i < n; i++) {
        phL += iL; if (phL >= 1) phL -= 1;
        phR += iR; if (phR >= 1) phR -= 1;
        let cl = Math.sin(TAU * phL), cr = Math.sin(TAU * phR);
        if (sh > 0) { cl = MOT_tanh(cl * sd) * sn; cr = MOT_tanh(cr * sd) * sn; }
        L[i] *= (cl * cg + co) * mk; R[i] *= (cr * cg + co) * mk;
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
    init() { this.lfo = new MOT_LFO(); this.v = 0; this.rv = 0; this.lastF = 0; this.rng = new Rng(0xa7a9); this.first = true; }
    process(L, R, n, p, ctx) {
      const sr = this.sr, shape = p.shape | 0;
      let ph = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, true); const inc = this.lfo.inc;
      const off = p.phase / 360, dep = p.depth * 0.01, w = p.width * 0.01;
      const per = 1 / Math.max(1e-9, inc); // samples per cycle
      const sm = p.smooth * 0.01, tau = 0.0008 * sr + ((shape >= 2) ? sm * sm * 0.3 * per : 0);
      const c = 1 - Math.exp(-1 / tau);
      let v = this.v, rv = this.rv, lastF = this.lastF;
      if (this.first) { lastF = MOT_frac(ph + off); rv = this.rng.bi(); this.first = false; }
      for (let i = 0; i < n; i++) {
        ph += inc; if (ph >= 1) ph -= 1;
        const f = MOT_frac(ph + off);
        let t;
        if (shape === 0) t = Math.sin(TAU * f);
        else if (shape === 1) t = 4 * Math.abs(MOT_frac(f - 0.25) - 0.5) - 1;
        else if (shape === 2) t = f < 0.5 ? 1 : -1;
        else { if (f < lastF) rv = this.rng.bi(); t = rv; }
        lastF = f;
        v += (t - v) * c;
        const a = (dep * v + 1) * MOT_QPI, gL = Math.cos(a) * MOT_SQRT2, gR = Math.sin(a) * MOT_SQRT2;
        const xl = L[i], xr = R[i], m = 0.5 * (xl + xr), s = 0.5 * (xl - xr) * w;
        L[i] = (m + s) * gL; R[i] = (m - s) * gR;
      }
      this.v = v; this.rv = rv; this.lastF = lastF;
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
      this.lfo = new MOT_LFO(); this.v = new Float64Array([1, 1]); this.rv = new Float64Array([1, 1]);
      this.lastF = new Float64Array(2); this.rng = new Rng(0x7e3e); this.first = true;
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, shape = p.shape | 0;
      const ph0 = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, true), inc = this.lfo.inc;
      const dep = p.depth * 0.01, off = p.stereo / 360, per = 1 / Math.max(1e-9, inc);
      const sm = p.smooth * 0.01, tau = 0.0006 * sr + (shape >= 2 ? sm * sm * 0.25 * per : 0);
      const c = 1 - Math.exp(-1 / tau);
      if (this.first) { this.lastF[0] = ph0; this.lastF[1] = MOT_frac(ph0 + off); this.first = false; }
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch ? R : L;
        let ph = ch ? MOT_frac(ph0 + off) : ph0, v = this.v[ch], rv = this.rv[ch], lastF = this.lastF[ch];
        for (let i = 0; i < n; i++) {
          ph += inc; if (ph >= 1) ph -= 1;
          let t;
          if (shape === 0) t = 0.5 + 0.5 * Math.cos(TAU * ph);
          else if (shape === 1) t = Math.abs(2 * ph - 1);
          else if (shape === 2) t = ph < 0.5 ? 1 : 0;
          else if (shape === 3) t = 1 - ph;
          else if (shape === 4) t = ph;
          else { if (ph < lastF) rv = this.rng.next(); t = rv; }
          lastF = ph;
          v += (t - v) * c;
          buf[i] *= 1 - dep * (1 - v);
        }
        this.v[ch] = v; this.rv[ch] = rv; this.lastF[ch] = lastF;
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
      const sr = this.sr;
      this.hil = [new MOT_Hilbert(), new MOT_Hilbert()];
      this.dl = [new DelayLine(Math.ceil(sr * 1.02)), new DelayLine(Math.ceil(sr * 1.02))];
      this.ph = new Float64Array(2); this.lp = new Float64Array(2);
      this.sS = [new Smoother(sr, 30, 0), new Smoother(sr, 30, 0)];
      this.tS = [new Smoother(sr, 120, 140), new Smoother(sr, 120, 140)]; this.first = true;
      this.snp = [new MOT_Snap(), new MOT_Snap()];
      this.lc = 1 - Math.exp(-TAU * 7000 / sr);
    }
    _snap(key, s, k) {
      const ref = mtof(key.degreeMidi(0, 4));
      if (ref + s < 30) return s;
      return this.snp[k].hz(key, ref + s) - ref;
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr;
      let sl = p.shiftl, sR = p.link ? p.shiftl : p.shiftr;
      if (p.snap) { sl = this._snap(ctx.key, sl, 0); sR = this._snap(ctx.key, sR, 1); }
      const T = Math.max(2, p.time * 0.001 * sr);
      if (this.first) { this.sS[0].snap(sl); this.sS[1].snap(sR); this.tS[0].snap(T); this.tS[1].snap(T); this.first = false; }
      else { this.sS[0].set(sl); this.sS[1].set(sR); this.tS[0].set(T); this.tS[1].set(T); }
      const fb = p.fdbk * 0.01, lc = this.lc, isr = 1 / sr, lp = this.lp, ph = this.ph;
      for (let c = 0; c < 2; c++) {
        const buf = c ? R : L, hil = this.hil[c], dl = this.dl[c], sS = this.sS[c], tS = this.tS[c];
        let pc = ph[c], lpc = lp[c];
        for (let i = 0; i < n; i++) {
          const d = tS.next();
          pc += sS.next() * isr; pc -= Math.floor(pc);
          lpc += lc * (dl.read(d) - lpc);
          hil.process(buf[i] + fb * MOT_tanh(lpc));
          const y = hil.re * Math.cos(TAU * pc) - hil.im * Math.sin(TAU * pc);
          dl.write(y);
          buf[i] = y;
        }
        ph[c] = pc; lp[c] = lpc;
      }
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
      const sr = this.sr;
      this.lA = [new DelayLine(Math.ceil(sr * 0.36)), new DelayLine(Math.ceil(sr * 0.36))];
      this.lB = [new DelayLine(Math.ceil(sr * 0.06)), new DelayLine(Math.ceil(sr * 0.06))];
      this.maxA = Math.ceil(sr * 0.35); this.maxB = Math.ceil(sr * 0.05);
      this.lfo = new MOT_LFO(); this.dph = 0;
      // taps: [srcA earL, srcA earR, srcB earL, srcB earR]
      this.dP = new Float64Array(4); this.dN = new Float64Array(4);
      this.gP = new Float64Array(4); this.gN = new Float64Array(4);
      this.aP = new Float64Array(2); this.aN = new Float64Array(2); this.lpS = new Float64Array(2);
      this.xo = new Float64Array(2); this.xoc = 1 - Math.exp(-TAU * 800 / sr);
      this.rx = new Float64Array(4); this.rt = new Float64Array(2); this.rseg = -1;
      this.rng = new Rng(0xd0bb1e);
      this.path = -1; this.fade = 0; this.Ds = 8; this.first = true;
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
        let g = Math.min(1.25, Math.pow((dref + 1) / (dc + 1), 0.9));
        if (path === 1) { const w = Math.sin(Math.PI * MOT_frac(t + k * 0.5)); g *= w * w; }
        else if (path === 5) g *= k === 0 ? 0.6 - 0.4 * Math.cos(TAU * t) : 0.85 - 0.15 * Math.cos(TAU * this.dph);
        const pan = x / dc * width * 0.8;
        const dd = Math.max(0, dscale * (dc - dref));
        const dl = Math.sqrt((x + ear) * (x + ear) + y * y), dr = Math.sqrt((x - ear) * (x - ear) + y * y);
        const lim = path === 5 && k === 1 ? this.maxB : this.maxA;
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
      const sr = this.sr, path = p.path | 0;
      const ph0 = this.lfo.block(p.sync, p.div, p.rate, ctx, n, sr, false), inc = this.lfo.inc;
      const dscale = p.depth * 0.015, width = p.width * 0.01, air = p.air * 0.01;
      const STEP = 16;
      if (this.first) { this.path = path; this.Ds = p.distance; this.fade = 1; }
      const dP = this.dP, dN = this.dN, gP = this.gP, gN = this.gN, aP = this.aP, aN = this.aN, lpS = this.lpS, xo = this.xo, xoc = this.xoc;
      const lAL = this.lA[0], lAR = this.lA[1], lBL = this.lB[0], lBR = this.lB[1];
      for (let off = 0; off < n; off += STEP) {
        const m = n - off < STEP ? n - off : STEP;
        // path switch: fade out, swap, fade in
        if (path !== this.path) { this.fade -= m / 384; if (this.fade <= 0) { this.fade = 0; this.path = path; this.rseg = -1; this.first = true; } }
        else if (this.fade < 1) { this.fade += m / 384; if (this.fade > 1) this.fade = 1; }
        this.Ds += (p.distance - this.Ds) * (1 - Math.exp(-m / (0.25 * sr)));
        this.dph = MOT_frac(this.dph + inc * 0.9 * m);
        if (this.first && this.path === 4) {
          const rx = this.rx, D = this.Ds; rx[0] = rx[2] = 0.3 * D; rx[1] = rx[3] = 0.6 * D;
        }
        this._ctl(MOT_frac(ph0 + inc * (off + m)), m, dscale, width, air, sr);
        if (this.first) { dP.set(dN); gP.set(gN); aP.set(aN); this.first = false; }
        const rotor = this.path === 5, im = 1 / m;
        const dd0 = (dN[0] - dP[0]) * im, dd1 = (dN[1] - dP[1]) * im, dd2 = (dN[2] - dP[2]) * im, dd3 = (dN[3] - dP[3]) * im;
        const gd0 = (gN[0] - gP[0]) * im, gd1 = (gN[1] - gP[1]) * im, gd2 = (gN[2] - gP[2]) * im, gd3 = (gN[3] - gP[3]) * im;
        const ad = (aN[0] - aP[0]) * im;
        let d0 = dP[0], d1 = dP[1], d2 = dP[2], d3 = dP[3], g0 = gP[0], g1 = gP[1], g2 = gP[2], g3 = gP[3], ac = aP[0];
        for (let i = off; i < off + m; i++) {
          d0 += dd0; d1 += dd1; d2 += dd2; d3 += dd3; g0 += gd0; g1 += gd1; g2 += gd2; g3 += gd3; ac += ad;
          const xl = L[i], xr = R[i];
          let yl, yr;
          if (rotor) {
            xo[0] += xoc * (xl - xo[0]); xo[1] += xoc * (xr - xo[1]);
            lAL.write(xl - xo[0]); lAR.write(xr - xo[1]); lBL.write(xo[0]); lBR.write(xo[1]);
            yl = g0 * lAL.read(d0) + g2 * lBL.read(d2); yr = g1 * lAR.read(d1) + g3 * lBR.read(d3);
          } else {
            lAL.write(xl); lAR.write(xr);
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
      this.z = [new Float64Array(64), new Float64Array(64)];
      this.c = [new Float64Array(64), new Float64Array(64)];
      this.fbS = new Float64Array(2);
      this.amt = -1; this.lf = 0; this.q = 0; this.sp = 0; this.active = 0;
    }
    process(L, R, n, p) {
      const sr = this.sr;
      const tA = clamp(p.amount, 0, 32), tlf = Math.log(p.focus), tq = 0.4 * Math.pow(2, p.reso * 0.045), tsp = p.spread * 0.01;
      let dirty = false;
      if (this.amt < 0) { this.amt = tA; this.lf = tlf; this.q = tq; this.sp = tsp; dirty = true; }
      else {
        if (this.amt !== tA) { this.amt += (tA - this.amt) * 0.2; if (Math.abs(tA - this.amt) < 0.01) this.amt = tA; }
        if (this.lf !== tlf) { this.lf += (tlf - this.lf) * 0.3; if (Math.abs(tlf - this.lf) < 1e-4) this.lf = tlf; dirty = true; }
        if (this.q !== tq) { this.q += (tq - this.q) * 0.3; if (Math.abs(tq - this.q) < 1e-4) this.q = tq; dirty = true; }
        if (this.sp !== tsp) { this.sp += (tsp - this.sp) * 0.3; if (Math.abs(tsp - this.sp) < 1e-4) this.sp = tsp; dirty = true; }
      }
      const amt = this.amt, nAct = Math.ceil(amt - 1e-9), fr = nAct > 0 ? amt - (nAct - 1) : 0;
      if (nAct > this.active) dirty = true;
      if (dirty) {
        for (let c = 0; c < 2; c++) {
          const co = this.c[c], sg = c ? -1 : 1;
          for (let j = 0; j < nAct; j++) {
            const f = clamp(Math.exp(this.lf + this.sp * 2 * MOT_LN2 * MOT_DU[j] * sg), 20, sr * 0.45);
            const w = TAU * f / sr, al = Math.sin(w) / (2 * this.q), a0 = 1 + al;
            co[j * 2] = -2 * Math.cos(w) / a0; co[j * 2 + 1] = (1 - al) / a0;
          }
        }
      }
      if (nAct < this.active) for (let c = 0; c < 2; c++) this.z[c].fill(0, nAct * 2, this.active * 2);
      this.active = nAct;
      const trail = p.trail * 0.01, d = p.drive * 0.01, dm = d * 3 > 1 ? 1 : d * 3, dg = 1 + 15 * d * d, dn = 0.5 / MOT_tanh(0.5 * dg);
      const nFull = nAct - 1;
      for (let c = 0; c < 2; c++) {
        const buf = c ? R : L, z = this.z[c], co = this.c[c];
        let fbv = this.fbS[c];
        for (let i = 0; i < n; i++) {
          let x = buf[i] + trail * MOT_tanh(fbv);
          if (d > 0) x += (MOT_tanh(x * dg) * dn - x) * dm;
          let y = x;
          for (let j = 0; j < nFull; j++) {
            const j2 = j * 2, c1 = co[j2], c2 = co[j2 + 1];
            const o = c2 * y + z[j2];
            z[j2] = c1 * (y - o) + z[j2 + 1];
            z[j2 + 1] = y - c2 * o;
            y = o;
          }
          if (nAct > 0) {
            const j2 = nFull * 2, c1 = co[j2], c2 = co[j2 + 1];
            const o = c2 * y + z[j2];
            z[j2] = c1 * (y - o) + z[j2 + 1];
            z[j2 + 1] = y - c2 * o;
            y += (o - y) * fr;
          }
          fbv = y;
          buf[i] = y;
        }
        this.fbS[c] = fbv;
      }
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
      const sr = this.sr;
      this.bf = [[], []];
      for (let c = 0; c < 2; c++) for (let j = 0; j < 4; j++) this.bf[c].push(new MOT_SVF());
      this.hil = [new MOT_Hilbert(), new MOT_Hilbert()];
      this.rng = new Rng(0x7ad10);
      this.envIn = new EnvFollower(sr, 1, 60); this.envC = new EnvFollower(sr, 3, 150);
      this.gate = 0; this.open = false; this.hold = 0; this.tail = 0; this.tlp = new Float64Array(2); this.thp = new Float64Array(2);
      this.bT = Math.round(sr * 2); this.bLeft = 0; this.bEnv = 0; this.bLvl = 0; this.chop = 0; this.chopT = 0; this.chopC = 0;
      this.dT = Math.round(sr * 3); this.dLeft = 0; this.dG = 1;
      this.crk = new Float64Array(2);
      this.oph = 0; this.wph = 0; this.wob = 0;
      this.lo = 0; this.hi = 0; this.first = true;
    }
    process(L, R, n, p) {
      const sr = this.sr, rng = this.rng;
      const dial = p.dial * 0.01, ad = dial < 0 ? -dial : dial;
      // band edges (log-smoothed per block)
      const fc = p.freq * Math.pow(2, dial * 0.5), bw = 0.6 + p.width * 0.044;
      const tlo = Math.log(clamp(fc * Math.pow(2, -bw / 2), 40, sr * 0.2)), thi = Math.log(clamp(fc * Math.pow(2, bw / 2), 400, sr * 0.45));
      if (this.first) { this.lo = tlo; this.hi = thi; }
      else { this.lo += (tlo - this.lo) * 0.3; this.hi += (thi - this.hi) * 0.3; }
      const gl = MOT_g(Math.exp(this.lo), sr), gh = MOT_g(Math.exp(this.hi), sr);
      for (let c = 0; c < 2; c++) { const b = this.bf[c]; b[0].hp(gl, 0.5412); b[1].hp(gl, 1.3066); b[2].lp(gh, 0.5412); b[3].lp(gh, 1.3066); }
      const nz = p.noise * 0.01, nl = Math.pow(nz, 1.5) * 0.09 * (1 + ad), crkP = nz * 30 / sr;
      const comp = p.comp * 0.01, cx = comp * 0.75;
      const drv = p.drive * 0.01, dg = 1 + drv * 10, bias = 0.15 * drv, tb = MOT_tanh(bias), dn = 0.55 / MOT_tanh(dg * 0.4);
      const burst = p.burst * 0.01, bMean = (0.25 + 6 * (1 - burst) * (1 - burst)) * sr;
      const drop = p.dropout * 0.01, dMean = (0.5 + 9 * (1 - drop) * (1 - drop)) * sr;
      const sq = p.squelch * 0.01, thr = sq > 0 ? dbToGain(-72 + sq * 62) : 0, holdN = Math.round(0.22 * sr);
      const shift = dial * 240 / sr, wf = (350 + ad * 2800) / sr, wl = 0.05 * ad;
      const gc = 1 - Math.exp(-1 / (0.004 * sr)), dc = 1 - Math.exp(-1 / (0.012 * sr)), bc = 1 - Math.exp(-1 / (0.004 * sr));
      const tdec = Math.exp(-1 / (0.05 * sr)), tl = 1 - Math.exp(-TAU * 3500 / sr), th = 1 - Math.exp(-TAU * 600 / sr);
      const chopN = Math.round(0.006 * sr);
      if (this.first) { this.gate = thr > 0 ? 0 : 1; this.first = false; }
      const envIn = this.envIn, envC = this.envC, crk = this.crk, tlp = this.tlp, thp = this.thp;
      const bL = this.bf[0], bR = this.bf[1], hL = this.hil[0], hR = this.hil[1];
      for (let i = 0; i < n; i++) {
        const xl0 = L[i], xr0 = R[i];
        const al = xl0 < 0 ? -xl0 : xl0, ar = xr0 < 0 ? -xr0 : xr0;
        // ---- squelch (on clean input)
        const ei = envIn.process(al > ar ? al : ar);
        if (thr > 0) {
          if (ei > thr * 1.4) { this.open = true; this.hold = holdN; }
          else if (this.open && ei < thr) { if (--this.hold <= 0) { this.open = false; this.tail = 0.3; } }
        } else this.open = true;
        this.gate += ((this.open ? 1 : 0) - this.gate) * gc;
        // ---- random events: bursts / dropouts
        if (burst > 0 && --this.bT <= 0) {
          this.bLeft = Math.round((0.03 + 0.35 * rng.next()) * sr); this.bLvl = (0.25 + 0.6 * rng.next()) * burst;
          this.bT = Math.round(-Math.log(1e-6 + rng.next()) * bMean) + this.bLeft;
        }
        let bTarget = 0;
        if (this.bLeft > 0) { this.bLeft--; bTarget = 1; }
        this.bEnv += (bTarget - this.bEnv) * bc;
        if (--this.chopC <= 0) { const r = rng.next(); this.chopT = r * r; this.chopC = chopN + rng.int(chopN * 2); }
        this.chop += (this.chopT - this.chop) * bc;
        if (drop > 0 && --this.dT <= 0) {
          this.dLeft = Math.round((0.05 + 0.45 * rng.next()) * sr);
          this.dT = Math.round(-Math.log(1e-6 + rng.next()) * dMean) + this.dLeft;
        }
        let dTarget = 1;
        if (this.dLeft > 0) { this.dLeft--; dTarget = 0.03; }
        this.dG += (dTarget - this.dG) * dc;
        const bn = this.bEnv * this.bLvl * this.chop, sigG = this.dG * (1 - 0.6 * this.bEnv);
        // ---- AGC on input level
        const ec = envC.process(0.5 * (al + ar));
        let cg = Math.pow(0.2 / (ec + 0.003), cx); if (cg > 3) cg = 3; else if (cg < 0.1) cg = 0.1;
        // ---- oscillators
        this.oph += shift; this.oph -= Math.floor(this.oph);
        const co = Math.cos(TAU * this.oph), si = Math.sin(TAU * this.oph);
        let wv = 0;
        if (wl > 0) { this.wob += 0.3 / sr; if (this.wob >= 1) this.wob -= 1; this.wph += wf * (1 + 0.02 * Math.sin(TAU * this.wob)); if (this.wph >= 1) this.wph -= 1; wv = Math.sin(TAU * this.wph) * wl * Math.min(1, ec * 6); }
        const tn = this.tail > 1e-4 ? this.tail : 0;
        for (let c = 0; c < 2; c++) {
          const b = c ? bR : bL, h = c ? hR : hL;
          let x = (c ? xr0 : xl0) * sigG + rng.bi() * (nl + bn);
          if (crkP > 0 && rng.next() < crkP) crk[c] = rng.bi() * 0.5 * nz;
          x += crk[c]; crk[c] *= 0.6;
          x = b[3].run(b[2].run(b[1].run(b[0].run(x))));
          h.process(x);
          x = h.re * co - h.im * si;
          x *= cg;
          x = (MOT_tanh(dg * x + bias) - tb) * dn + wv;
          x *= this.gate;
          if (tn > 0) { // squelch tail: band-limited noise burst after the gate closes
            const r = rng.bi() * tn;
            tlp[c] += tl * (r - tlp[c]); thp[c] += th * (tlp[c] - thp[c]);
            x += tlp[c] - thp[c];
          }
          if (c) R[i] = x; else L[i] = x;
        }
        this.tail *= tdec;
      }
    }
  });
})();
