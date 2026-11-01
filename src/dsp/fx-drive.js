// ============================================================================
// DEBACLE — FX bank "drive": distortion, dynamics and circuit-bent glitch.
//   crush · chipglitch · clip · arc · folder · sheen · howl · oxide · subdiv ·
//   mirror · squeeze · gate · mauler · shaper
// Plain worklet script. Everything lives inside one IIFE; shared helpers carry a
// DRV_ prefix so they stay recognisable in stack traces.
// ============================================================================
(() => {
  'use strict';

  const DRV_DB = 20 / Math.LN10; // ln(gain) -> dB
  const DRV_LN = Math.LN10 / 20; // dB -> ln(gain)
  const DRV_HPI = Math.PI / 2;
  const DRV_Q = Math.SQRT1_2;

  // ---------------------------------------------------------------------------
  // Allocation-free biquad coefficient setters (the lib setters build arrays).
  // ---------------------------------------------------------------------------
  function DRV_bqLP(bq, f, q, sr) {
    const w = TAU * clamp(f, 5, sr * 0.49) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    bq._set((1 - c) * 0.5, 1 - c, (1 - c) * 0.5, 1 + al, -2 * c, 1 - al);
  }
  function DRV_bqHP(bq, f, q, sr) {
    const w = TAU * clamp(f, 5, sr * 0.49) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    bq._set((1 + c) * 0.5, -(1 + c), (1 + c) * 0.5, 1 + al, -2 * c, 1 - al);
  }
  function DRV_bqAP(bq, f, q, sr) {
    const w = TAU * clamp(f, 5, sr * 0.49) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    bq._set(1 - al, -2 * c, 1 + al, 1 + al, -2 * c, 1 - al);
  }
  function DRV_bqPeak(bq, f, q, db, sr) {
    const w = TAU * clamp(f, 5, sr * 0.49) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), A = Math.pow(10, db / 40);
    bq._set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }


  // ---------------------------------------------------------------------------
  // 2x oversampler: polyphase IIR halfband (6 allpass coefs, elliptic design,
  // ~-85 dB image/alias rejection above 0.58 fs). Mono; up() fills .a/.b.
  // ---------------------------------------------------------------------------
  const H0 = 0.054217525755, H1 = 0.196797969814, H2 = 0.383087327291,
    H3 = 0.573136411148, H4 = 0.748720944436, H5 = 0.914293709685;
  class DRV_OS2 {
    constructor() { this.reset(); }
    reset() {
      this.ux0 = this.ux1 = this.ux2 = this.ux3 = this.ux4 = this.ux5 = 0;
      this.uy0 = this.uy1 = this.uy2 = this.uy3 = this.uy4 = this.uy5 = 0;
      this.dx0 = this.dx1 = this.dx2 = this.dx3 = this.dx4 = this.dx5 = 0;
      this.dy0 = this.dy1 = this.dy2 = this.dy3 = this.dy4 = this.dy5 = 0;
      this.a = 0; this.b = 0;
    }
    up(x) {
      let e = x, o = x, t;
      t = (e - this.uy0) * H0 + this.ux0; this.ux0 = e; this.uy0 = t; e = t;
      t = (o - this.uy1) * H1 + this.ux1; this.ux1 = o; this.uy1 = t; o = t;
      t = (e - this.uy2) * H2 + this.ux2; this.ux2 = e; this.uy2 = t; e = t;
      t = (o - this.uy3) * H3 + this.ux3; this.ux3 = o; this.uy3 = t; o = t;
      t = (e - this.uy4) * H4 + this.ux4; this.ux4 = e; this.uy4 = t; e = t;
      t = (o - this.uy5) * H5 + this.ux5; this.ux5 = o; this.uy5 = t; o = t;
      this.a = e; this.b = o;
    }
    down(a, b) {
      let s0 = b, s1 = a, t;
      t = (s0 - this.dy0) * H0 + this.dx0; this.dx0 = s0; this.dy0 = t; s0 = t;
      t = (s1 - this.dy1) * H1 + this.dx1; this.dx1 = s1; this.dy1 = t; s1 = t;
      t = (s0 - this.dy2) * H2 + this.dx2; this.dx2 = s0; this.dy2 = t; s0 = t;
      t = (s1 - this.dy3) * H3 + this.dx3; this.dx3 = s1; this.dy3 = t; s1 = t;
      t = (s0 - this.dy4) * H4 + this.dx4; this.dx4 = s0; this.dy4 = t; s0 = t;
      t = (s1 - this.dy5) * H5 + this.dx5; this.dx5 = s1; this.dy5 = t; s1 = t;
      return 0.5 * (s0 + s1);
    }
  }

  // ---------------------------------------------------------------------------
  // Automatic level matcher: compares mean-square of a reference (pre-stage)
  // and of the raw stage output (both channels), returns a make-up gain that is
  // ramped across the next block. Holds its value while the input is silent.
  //   lv.begin(n); per sample: lv.si += in², lv.so += out², gain = lv.g0 + lv.dg*(i+1)
  //   lv.end(n);
  // ---------------------------------------------------------------------------
  class DRV_Level {
    constructor(sr, ms, lo, hi) { this.sr = sr; this.ms = ms; this.lo = lo; this.hi = hi; this.reset(); }
    reset() { this.pi = 0; this.po = 0; this.g = 1; this.gt = 1; this.k = 0; this.si = 0; this.so = 0; this.g0 = 1; this.dg = 0; }
    begin(n) { this.g0 = this.g; this.dg = (this.gt - this.g) / n; this.g = this.gt; this.si = 0; this.so = 0; }
    end(n) {
      const mi = this.si / (2 * n), mo = this.so / (2 * n);
      if (mi < 1e-9) return;
      this.k++;
      const c = Math.max(1 - Math.exp(-n / (this.ms * 0.001 * this.sr)), 1 / this.k);
      this.pi += (mi - this.pi) * c; this.po += (mo - this.po) * c;
      this.gt = clamp(Math.sqrt(this.pi / (this.po + 1e-12)), this.lo, this.hi);
    }
  }

  // Tilt EQ around ~900 Hz, t in [-1, 1] -> +-6 dB per side, gains smoothed.
  class DRV_Tilt {
    constructor(sr) { this.op = new OnePole(); this.op.set(900, sr); this.gl = 1; this.gh = 1; this.tl = 1; this.th = 1; }
    set(t) { this.tl = dbToGain(-6 * t); this.th = dbToGain(6 * t); }
    process(x) {
      this.gl += (this.tl - this.gl) * 0.003; this.gh += (this.th - this.gh) * 0.003;
      const lo = this.op.lp(x);
      return lo * this.gl + (x - lo) * this.gh;
    }
  }

  // Linkwitz-Riley 4th-order crossover (2 or 3 bands, phase-aligned sum).
  class DRV_XO {
    constructor() {
      this.a1 = new Biquad(); this.a2 = new Biquad(); this.b1 = new Biquad(); this.b2 = new Biquad();
      this.c1 = new Biquad(); this.c2 = new Biquad(); this.d1 = new Biquad(); this.d2 = new Biquad(); this.ap = new Biquad();
      this.f1 = -1; this.f2 = -1; this.lo = 0; this.mid = 0; this.hi = 0;
    }
    set(f1, f2, sr) {
      if (f1 !== this.f1) {
        this.f1 = f1; DRV_bqLP(this.a1, f1, DRV_Q, sr); DRV_bqLP(this.a2, f1, DRV_Q, sr);
        DRV_bqHP(this.b1, f1, DRV_Q, sr); DRV_bqHP(this.b2, f1, DRV_Q, sr);
      }
      if (f2 !== this.f2) {
        this.f2 = f2; DRV_bqLP(this.c1, f2, DRV_Q, sr); DRV_bqLP(this.c2, f2, DRV_Q, sr);
        DRV_bqHP(this.d1, f2, DRV_Q, sr); DRV_bqHP(this.d2, f2, DRV_Q, sr); DRV_bqAP(this.ap, f2, DRV_Q, sr);
      }
    }
    split2(x) { this.lo = this.a2.process(this.a1.process(x)); this.hi = this.b2.process(this.b1.process(x)); }
    split3(x) {
      this.split2(x);
      const h = this.hi;
      this.lo = this.ap.process(this.lo);
      this.mid = this.c2.process(this.c1.process(h));
      this.hi = this.d2.process(this.d1.process(h));
    }
  }

  // triangle fold, unit slope at 0, peaks +-1 at u = +-1, period 4
  function DRV_tri(u) { let t = (u + 1) * 0.25; t -= Math.floor(t); t -= 0.5; return 1 - 4 * (t < 0 ? -t : t); }
  // transparent below |1|, soft ceiling at 2 (safety on dynamics outputs)
  function DRV_soft(x) { return x > 1 ? 1 + fastTanh(x - 1) : x < -1 ? -1 - fastTanh(-x - 1) : x; }
  // downward gain computer (dB in, dB gain <= 0 out), soft knee
  function DRV_down(lv, thr, ratio, knee) {
    const o = lv - thr, h = knee * 0.5;
    if (o <= -h) return 0;
    const s = 1 - 1 / ratio;
    if (o >= h) return -o * s;
    const t = o + h; return -s * t * t / (2 * knee);
  }
  // upward gain computer (dB gain >= 0), faded out below `floor` dB so noise is not lifted
  function DRV_up(lv, thr, ratio, maxUp, floor) {
    const u = thr - lv;
    if (u <= 0) return 0;
    let g = u * (1 - 1 / ratio);
    if (g > maxUp) g = maxUp;
    if (lv < floor) { const k = 1 - (floor - lv) / 12; g = k > 0 ? g * k : 0; }
    return g;
  }
  const DRV_coef = (ms, sr) => 1 - Math.exp(-1 / (Math.max(0.01, ms) * 0.001 * sr));

  // ===========================================================================
  // 1. CRUSH — bitcrusher
  // ===========================================================================
  const CR_LN256 = Math.log(256), CR_IMU = 1 / CR_LN256;
  registerFX(class extends FX {
    static id = 'crush';
    static label = 'CRUSH';
    static cat = 'DISTORTION';
    static desc = 'Bitcrusher with sample-rate reduction, six converter models, tempo-synced hold clock and DAC smoothing.';
    static latency = 0;
    static params = [
      { id: 'bits', label: 'BITS', min: 1, max: 16, def: 6 },
      { id: 'rate', label: 'RATE', min: 100, max: 48000, def: 6000, unit: 'Hz', curve: 'exp' },
      { id: 'model', label: 'MODEL', options: ['CLASSIC', 'MU-LAW', 'FLOAT', 'DELTA', 'GLIDE', 'ERROR FB'], def: 0 },
      { id: 'drive', label: 'DRIVE', min: 0, max: 24, def: 0, unit: 'dB' },
      { id: 'smooth', label: 'SMOOTH', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 25, unit: '%' },
      { id: 'dither', label: 'DITHER', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'jitter', label: 'JITTER', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'sync', label: 'SYNC', toggle: true, def: 0 },
      { id: 'div', label: 'DIV', div: ['1/1', '1/512'], def: '1/512' },
    ];
    init() {
      this.rng = new Rng(0xc0ffee);
      this.st = [0, 1].map(() => ({ ph: 1, h: 0, hp: 0, jm: 1, ds: 0, dd: 0.01, e1: 0, e2: 0, svf: new SVF() }));
      this.g = -1;
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, rng = this.rng, model = p.model | 0;
      const bits = clamp(p.bits, 1, 16), Lv = Math.pow(2, bits - 1), step = 1 / Lv;
      const gT = dbToGain(p.drive), g0 = this.g < 0 ? gT : this.g, dg = (gT - g0) / n; this.g = gT;
      const m0 = Math.pow(g0, -0.6), dm = (Math.pow(gT, -0.6) - m0) / n; // make-up for the drive
      const inc = p.sync ? 1 / Math.max(1, p.div * ctx.spb) : p.rate / sr;
      const dith = p.dither * 0.01 * step, jit = p.jitter * 0.009, sm = p.smooth * 0.01, useSm = sm > 0.004;
      const maxC = Math.max(1, Math.floor(Lv) - 1), hiC = maxC * 0.74, loC = maxC * 0.26;
      const fM = Math.pow(2, Math.max(1, bits * 0.5)), fMin = Math.pow(2, -(bits + 2));
      for (let c = 0; c < 2; c++) {
        const X = c ? R : L, s = this.st[c], svf = s.svf;
        const incC = Math.min(1, inc * (c ? 1 + p.width * 0.0015 : 1));
        if (useSm) svf.set(20000 * Math.pow(clamp(incC * sr * 0.45, 40, 20000) / 20000, sm), 0.6, sr);
        let ph = s.ph, h = s.h, hp = s.hp, jm = s.jm, ds = s.ds, dd = s.dd, e1 = s.e1, e2 = s.e2;
        for (let i = 0; i < n; i++) {
          const g = g0 + dg * (i + 1);
          let x = X[i] * g; x = x > 1 ? 1 : x < -1 ? -1 : x;
          ph += incC * jm;
          if (ph >= 1) {
            ph -= Math.floor(ph);
            if (jit > 0) jm = 1 + jit * rng.bi();
            let v = x, q;
            if (dith > 0) v += (rng.next() - rng.next()) * dith;
            switch (model) {
              case 1: { // MU-LAW companding
                const a = v < 0 ? -v : v;
                const cq = Math.round(Math.log(1 + 255 * a) * CR_IMU * Lv) * step;
                const o = (Math.exp(cq * CR_LN256) - 1) / 255;
                q = v < 0 ? -o : o; break;
              }
              case 2: { // FLOAT: few mantissa bits, limited exponent range (flush to zero)
                const a = v < 0 ? -v : v;
                if (a < fMin) q = 0;
                else {
                  const s2 = Math.pow(2, Math.ceil(Math.log2(a)));
                  const m = Math.round(a / s2 * fM) / fM * s2;
                  q = v < 0 ? -m : m;
                }
                break;
              }
              case 3: { // DELTA: adaptive delta modulation (ADPCM-like)
                let code = Math.round((v - ds) / dd);
                if (code > maxC) code = maxC; else if (code < -maxC) code = -maxC;
                ds += code * dd; ds = (ds > 1 ? 1 : ds < -1 ? -1 : ds) * 0.9995;
                const ac = code < 0 ? -code : code;
                if (ac >= hiC) dd *= 1.6; else if (ac <= loC) dd *= 0.88;
                dd = dd < 1e-4 ? 1e-4 : dd > 0.6 ? 0.6 : dd;
                q = ds; break;
              }
              case 5: { // ERROR FB: 2nd-order error-feedback quantiser (noise pushed up)
                let w = v - (2 * e1 - e2);
                w = w > 1.5 ? 1.5 : w < -1.5 ? -1.5 : w;
                q = Math.round(w * Lv) * step;
                q = q > 1 ? 1 : q < -1 ? -1 : q;
                e2 = e1; e1 = q - w; break;
              }
              default: q = Math.round(v * Lv) * step; // CLASSIC / GLIDE
            }
            hp = h; h = q;
          }
          let y = model === 4 ? hp + (h - hp) * ph : h; // GLIDE = first-order hold
          const f = svf.process(y);
          if (useSm) y = f;
          X[i] = y * (m0 + dm * (i + 1));
        }
        s.ph = ph; s.h = h; s.hp = hp; s.jm = jm; s.ds = ds; s.dd = dd; s.e1 = e1; s.e2 = e2;
      }
    }
  });

  // ===========================================================================
  // 2. CHIPGLITCH — memory-chip circuit bend
  // ===========================================================================
  const CG_SIZE = 1 << 18, CG_MASK = CG_SIZE - 1;
  const CG_voice = () => ({ mode: 0, start: 0, len: 1, t: 0, pass: 0, fade: 1, rp: 0, rate: 1, rmin: 1, rk: 0, xr: 0, or: 0, and: 0xffff, trunc: 0xffff, shl: 0, spr: 0 });
  function CG_copy(d, s) {
    d.mode = s.mode; d.start = s.start; d.len = s.len; d.t = s.t; d.pass = s.pass; d.fade = s.fade;
    d.rp = s.rp; d.rate = s.rate; d.rmin = s.rmin; d.rk = s.rk;
    d.xr = s.xr; d.or = s.or; d.and = s.and; d.trunc = s.trunc; d.shl = s.shl; d.spr = s.spr;
  }
  registerFX(class extends FX {
    static id = 'chipglitch';
    static label = 'CHIPGLITCH';
    static cat = 'GLITCH';
    static desc = 'Circuit-bent memory chip: grid-locked bit corruption, bit shifting, CD-skip stalls and clock starvation on a narrow data bus.';
    static latency = 0;
    static params = [
      { id: 'corrupt', label: 'CORRUPT', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'shift', label: 'SHIFT', min: 0, max: 100, def: 25, unit: '%' },
      { id: 'stall', label: 'STALL', min: 0, max: 100, def: 45, unit: '%' },
      { id: 'rate', label: 'RATE', div: ['1/1', '1/64'], def: '1/16' },
      { id: 'bus', label: 'BUS', options: ['16 BIT', '8 BIT', '4 BIT'], def: 1 },
      { id: 'clock', label: 'CLOCK', min: 0, max: 100, def: 25, unit: '%' },
      { id: 'spread', label: 'SPREAD', min: 0, max: 100, def: 30, unit: '%' },
    ];
    init() {
      this.rng = new Rng(0x5eed1);
      this.ch = [0, 1].map(() => ({ buf: new Float32Array(CG_SIZE), wc: 0, cur: CG_voice(), old: CG_voice(), xf: 0, env: 0, dc: new DCBlock(0.9995) }));
      this.last = -1e12; this.xfN = Math.max(16, Math.round(this.sr * 0.003)); this.B = 16;
      this.eA = DRV_coef(1, this.sr); this.eR = DRV_coef(60, this.sr); this.gate = 0;
    }
    reset() {
      for (const s of this.ch) { s.buf.fill(0); s.wc = 0; s.xf = 0; s.env = 0; s.dc.reset(); s.cur = CG_voice(); s.old = CG_voice(); }
      this.last = -1e12; this.B = 16; this.rng = new Rng(0x5eed1); this.gate = 0;
    }
    process(L, R, n, p, ctx) {
      const B = p.bus === 0 ? 16 : p.bus === 1 ? 8 : 4;
      const half = 1 << (B - 1), full = 1 << B, um = full - 1, qs = half - 1;
      if (B !== this.B) { // bus width changed: neutralise bit masks of running voices
        this.B = B;
        for (let c = 0; c < 2; c++) for (let k = 0; k < 2; k++) {
          const v = k ? this.ch[c].old : this.ch[c].cur;
          v.xr = 0; v.or = 0; v.and = um; v.trunc = um; v.shl = 0; v.spr = 0;
        }
      }
      const spb = ctx.spb, div = p.rate, divS = div * spb, xfN = this.xfN, dpos = 1 / spb;
      const s0 = this.ch[0], s1 = this.ch[1];
      let pos = ctx.ppq;
      for (let i = 0; i < n; i++, pos += dpos) {
        const idx = Math.floor(pos / div);
        if (idx !== this.last) { this.last = idx; this._event(divS, p, B, um); }
        for (let c = 0; c < 2; c++) {
          const X = c ? R : L, s = c ? s1 : s0, x = X[i], ax = x < 0 ? -x : x;
          s.buf[s.wc & CG_MASK] = x;
          // bent bits only act while there is signal, so silence stays silent
          s.env += (ax - s.env) * (ax > s.env ? this.eA : this.eR);
          this.gate = s.env * 30 > 1 ? 1 : s.env * 30;
          let y = this._read(s.cur, s, x, B, half, full, um, qs);
          if (s.xf > 0) {
            const k = s.xf / xfN;
            y += (this._read(s.old, s, x, B, half, full, um, qs) - y) * k;
            s.xf--;
          }
          s.wc++;
          X[i] = s.dc.process(y);
        }
      }
    }
    _read(v, s, x, B, half, full, um, qs) {
      let y;
      if (v.mode === 0) y = x;
      else if (v.mode === 1) { // stall: loop a captured chunk, short fades at the seams
        const t = v.t;
        y = s.buf[(v.start + t) & CG_MASK];
        if (v.pass > 0 && t < v.fade) y *= t / v.fade;
        else if (v.len - t <= v.fade) y *= (v.len - t) / v.fade;
        if (++v.t >= v.len) { v.t = 0; v.pass++; }
      } else { // clock starvation: read clock sags -> pitch drop + level sag
        v.rate = v.rmin + (v.rate - v.rmin) * v.rk;
        v.rp += v.rate;
        if (s.wc - v.rp > CG_SIZE - 64) v.rp = s.wc - (CG_SIZE - 64);
        const ip = Math.floor(v.rp), f = v.rp - ip, b = s.buf;
        const xm1 = b[(ip - 1) & CG_MASK], x0 = b[ip & CG_MASK], x1 = b[(ip + 1) & CG_MASK], x2 = b[(ip + 2) & CG_MASK];
        const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        y = (((c3 * f + c2) * f + c1) * f + x0) * (0.5 + 0.5 * v.rate);
      }
      // data bus: B-bit two's complement word, then the bent bit operations
      let w = Math.round(y * qs);
      if (w > qs) w = qs; else if (w < -half) w = -half;
      const yq = w / half;
      let u = w & um;
      u = ((((u & v.trunc) << v.shl) & um) ^ v.xr) | v.or;
      u &= v.and;
      if (v.spr > 0 && this.rng.next() < v.spr) u ^= 1 << (B - 2 - this.rng.int(B > 3 ? 3 : B - 1));
      if (u >= half) u -= full;
      return yq + (u / half - yq) * this.gate;
    }
    _event(divS, p, B, um) {
      const rng = this.rng;
      const cor = p.corrupt * 0.01, shf = p.shift * 0.01, stl = p.stall * 0.01, clk = p.clock * 0.01, spr = p.spread * 0.01;
      for (let c = 0; c < 2; c++) {
        const s = this.ch[c];
        const tmp = s.old; s.old = s.cur; s.cur = tmp;
        s.xf = this.xfN;
        if (c === 1 && rng.next() >= spr) { CG_copy(s.cur, this.ch[0].cur); continue; }
        this._decide(s.cur, s, divS, cor, shf, stl, clk, B, um);
      }
    }
    _decide(v, s, divS, cor, shf, stl, clk, B, um) {
      const rng = this.rng, sr = this.sr;
      v.mode = 0; v.xr = 0; v.or = 0; v.and = um; v.trunc = um; v.shl = 0; v.spr = 0; v.t = 0; v.pass = 0;
      if (stl > 0 && rng.next() < stl * 0.85) {
        const r = rng.next();
        const frac = r < 0.35 ? 0.5 : r < 0.7 ? 0.25 : r < 0.85 ? 0.125 : 1 / 3;
        v.mode = 1;
        v.len = Math.max(32, Math.round(clamp(divS * frac, 0.006 * sr, 0.5 * sr)));
        v.start = s.wc; v.fade = Math.max(4, Math.min(96, v.len >> 2));
      } else if (clk > 0 && rng.next() < clk * 0.75) {
        v.mode = 2; v.rp = s.wc - 3; v.rate = 1;
        v.rmin = 1 - clk * (0.35 + 0.55 * rng.next());
        v.rk = Math.exp(-1 / Math.max(64, divS * 0.3));
      }
      if (cor > 0 && rng.next() < cor) {
        const nb = 1 + rng.int(1 + Math.floor(cor * 2)), span = Math.min(4, B - 1);
        for (let k = 0; k < nb; k++) {
          const bit = 1 << (B - 2 - rng.int(span)), m = rng.int(3);
          if (m === 0) v.xr |= bit; else if (m === 1) v.or |= bit; else v.and &= ~bit;
        }
        v.and &= um;
        v.spr = cor * cor * 0.003;
      }
      if (shf > 0 && rng.next() < shf) {
        if (rng.next() < 0.55) { const k = 1 + rng.int(Math.max(1, Math.floor((B - 2) * shf))); v.trunc = um & ~((1 << k) - 1); }
        else v.shl = 1 + rng.int(1 + Math.floor(shf * 2));
      }
    }
  });

  // ===========================================================================
  // 3. CLIP — 12-curve waveshaper, band-limited nonlinearity
  // ===========================================================================
  function CL_shape(m, x) {
    switch (m) {
      case 0: return x > 1 ? 1 : x < -1 ? -1 : x; // HARD
      case 2: return x >= 0 ? fastTanh(0.9 * x) : 0.75 * fastTanh(1.5 * x); // TUBE (asym)
      case 3: return x >= 0 ? 0.85 * (1 - Math.exp(-1.2 * x)) : -0.55 * (1 - Math.exp(1.8 * x)); // DIODE
      case 4: return x >= 0 ? fastTanh(3 * x) : 0.7 * fastTanh(1.6 * x); // FUZZ
      case 5: { const t = fastTanh(x); return t < 0 ? -t : t; } // RECTIFY
      case 6: return Math.sin(x); // SINE fold
      case 7: { const c = x > 1 ? 1 : x < -1 ? -1 : x; return 1.5 * c - 0.5 * c * c * c; } // CUBIC
      case 8: return DRV_tri(x); // FOLDBACK
      case 9: { const t = fastTanh(x); return 1.4 * t * t + 0.25 * t; } // OCTAVE up
      case 10: return x / Math.sqrt(1 + x * x); // SIGMOID
      case 11: { // BROKEN: dead zone (sputter on tails) + lopsided clip
        const a = x < 0 ? -x : x;
        if (a < 0.3) return 0;
        const y = fastTanh((a - 0.3) * 1.6);
        return x < 0 ? -y : (y > 0.6 ? 0.6 : y);
      }
      default: return fastTanh(x); // SOFT
    }
  }
  registerFX(class extends FX {
    static id = 'clip';
    static label = 'CLIP';
    static cat = 'DISTORTION';
    static desc = 'Twelve-curve waveshaper (2x oversampled) that can distort just one frequency band, with bias, tone and automatic level matching.';
    static latency = 0;
    static params = [
      { id: 'drive', label: 'DRIVE', min: 0, max: 48, def: 18, unit: 'dB' },
      { id: 'model', label: 'MODEL', options: ['HARD', 'SOFT', 'TUBE', 'DIODE', 'FUZZ', 'RECTIFY', 'SINE', 'CUBIC', 'FOLDBACK', 'OCTAVE', 'SIGMOID', 'BROKEN'], def: 1 },
      { id: 'bias', label: 'BIAS', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
      { id: 'lowcut', label: 'LOW CUT', min: 20, max: 2000, def: 20, unit: 'Hz', curve: 'exp' },
      { id: 'highcut', label: 'HIGH CUT', min: 500, max: 20000, def: 20000, unit: 'Hz', curve: 'exp' },
      { id: 'tone', label: 'TONE', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
    ];
    init() {
      this.ch = [0, 1].map(() => ({ hp: new SVF(), lp: new SVF(), os: new DRV_OS2(), dc: new DCBlock(0.9995), tilt: new DRV_Tilt(this.sr) }));
      this.lv = new DRV_Level(this.sr, 300, 0.02, 3);
      this.g = -1;
    }
    process(L, R, n, p) {
      const sr = this.sr, m = p.model | 0, lv = this.lv;
      const gT = dbToGain(p.drive), g0 = this.g < 0 ? gT : this.g, dg = (gT - g0) / n; this.g = gT;
      const bias = p.bias * 0.008, off = CL_shape(m, bias);
      // band edges fade to "off" at the range ends so the default is truly full-band
      const kH = clamp((p.lowcut - 20) / 15, 0, 1), kL = clamp((20000 - p.highcut) / 3000, 0, 1);
      lv.begin(n);
      const lg0 = lv.g0, ldg = lv.dg;
      for (let c = 0; c < 2; c++) {
        const X = c ? R : L, s = this.ch[c];
        s.hp.set(p.lowcut, DRV_Q, sr); s.lp.set(p.highcut, DRV_Q, sr); s.tilt.set(p.tone * 0.01);
        const hp = s.hp, lp = s.lp, os = s.os, dc = s.dc, tl = s.tilt;
        let si = 0, so = 0;
        for (let i = 0; i < n; i++) {
          const x = X[i];
          hp.process(x);
          const b1 = x + (hp.hp - x) * kH;
          const b = b1 + (lp.process(b1) - b1) * kL;
          os.up(b * (g0 + dg * (i + 1)));
          const y = dc.process(os.down(CL_shape(m, os.a + bias) - off, CL_shape(m, os.b + bias) - off));
          si += b * b; so += y * y;
          X[i] = tl.process(x - b + y * (lg0 + ldg * (i + 1)));
        }
        lv.si += si; lv.so += so;
      }
      lv.end(n);
    }
  });

  // ===========================================================================
  // 4. ARC — chaotic hysteretic plasma-arc distortion
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'arc';
    static label = 'ARC';
    static cat = 'DISTORTION';
    static desc = 'Plasma-arc distortion: peaks strike a chaotic buzzing arc with hysteretic conduction that stays lit for HOLD.';
    static latency = 0;
    static params = [
      { id: 'drive', label: 'DRIVE', min: 0, max: 36, def: 14, unit: 'dB' },
      { id: 'arc', label: 'ARC', min: 0, max: 100, def: 60, unit: '%' },
      { id: 'freq', label: 'FREQ', min: 20, max: 4000, def: 110, unit: 'Hz', curve: 'exp' },
      { id: 'hold', label: 'HOLD', min: 0, max: 2000, def: 160, unit: 'ms', curve: 'sq' },
      { id: 'chaos', label: 'CHAOS', min: 0, max: 100, def: 40, unit: '%' },
      { id: 'tone', label: 'TONE', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
      { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    ];
    init() {
      this.rng = new Rng(0xa4c);
      this.ch = [0, 1].map((c) => ({ lit: 0, hold: 0, le: 0, env: 0, ph: c * 0.37, z: 0.31 + 0.2 * c, fm: 1, aj: 1, bl: 0, spark: 0, dc: new DCBlock(0.999), tilt: new DRV_Tilt(this.sr) }));
      this.lv = new DRV_Level(this.sr, 400, 0.05, 2);
      this.g = -1;
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, rng = this.rng, lv = this.lv;
      const gT = dbToGain(p.drive), g0 = this.g < 0 ? gT : this.g, dg = (gT - g0) / n; this.g = gT;
      const a01 = p.arc * 0.01, th = 0.02 + 1.6 * (1 - a01) * (1 - a01), ext = th * 0.5;
      const holdN = Math.max(1, p.hold * 0.001 * sr);
      const ch = p.chaos * 0.01, rL = 3.58 + 0.41 * ch;
      const inc = (p.snap ? ctx.key.snapHz(p.freq) : p.freq) / sr;
      const cA = DRV_coef(0.8, sr), cR = DRV_coef(20, sr), eA = DRV_coef(0.5, sr), eR = DRV_coef(50, sr);
      const spD = Math.exp(-1 / (0.004 * sr));
      lv.begin(n);
      const lg0 = lv.g0, ldg = lv.dg;
      for (let c = 0; c < 2; c++) {
        const X = c ? R : L, s = this.ch[c], dc = s.dc, tl = s.tilt;
        tl.set(p.tone * 0.01);
        let lit = s.lit, hold = s.hold, le = s.le, env = s.env, ph = s.ph, z = s.z, fm = s.fm, aj = s.aj, bl = s.bl, spark = s.spark;
        let si = 0, so = 0;
        for (let i = 0; i < n; i++) {
          const x = X[i], v = x * (g0 + dg * (i + 1)), a = v < 0 ? -v : v;
          env += (a - env) * (a > env ? eA : eR);
          if (a > th) { if (!lit) { lit = 1; spark = 1; } hold = holdN; }
          else if (lit) { if (a > ext) hold = holdN; else if (--hold <= 0) lit = 0; }
          le += (lit - le) * (lit ? cA : cR);
          // relaxation oscillator; its period is kicked around by a logistic map
          ph += inc * fm;
          if (ph >= 1) {
            ph -= Math.floor(ph);
            z = rL * z * (1 - z);
            if (z < 0.001 || z > 0.999) z = 0.2 + 0.6 * rng.next();
            fm = 1 + ch * 1.5 * (z - 0.5); aj = 1 - ch * 0.7 * z;
            if (lit && rng.next() < ch * 0.15) spark = spark > 0.6 ? spark : 0.6;
          }
          const w = ph < 0.85 ? ph * 2.352941 - 1 : 1 - (ph - 0.85) * 13.33333;
          // hysteretic conduction: backlash whose width breathes with the arc
          const hw = le * (0.08 + 0.4 * ch * (0.5 + 0.5 * w));
          if (v > bl + hw) bl = v - hw; else if (v < bl - hw) bl = v + hw;
          const amp = le * aj * (0.3 + 0.7 * (env > 1 ? 1 : env));
          spark *= spD;
          const yl = fastTanh(bl + amp * w * 1.2) + spark * rng.bi() * 0.35 * le;
          const yu = 0.3 * fastTanh(v); // corona leakage while the gap is dark
          const y = dc.process(yu + (yl - yu) * le);
          si += x * x; so += y * y;
          X[i] = tl.process(y * (lg0 + ldg * (i + 1)));
        }
        lv.si += si; lv.so += so;
        s.lit = lit; s.hold = hold; s.le = le; s.env = env; s.ph = ph; s.z = z; s.fm = fm; s.aj = aj; s.bl = bl; s.spark = spark;
      }
      lv.end(n);
    }
  });

  // ===========================================================================
  // 5. FOLDER — west-coast wavefolder (2x oversampled)
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'folder';
    static label = 'FOLDER';
    static cat = 'DISTORTION';
    static desc = 'West-coast wavefolder with five fold models, symmetry bias and 2x oversampling.';
    static latency = 0;
    static params = [
      { id: 'drive', label: 'DRIVE', min: 0, max: 100, def: 45, unit: '%' },
      { id: 'folds', label: 'FOLDS', min: 1, max: 8, def: 2.5, unit: '×' },
      { id: 'shape', label: 'SHAPE', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'bias', label: 'BIAS', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
      { id: 'model', label: 'MODEL', options: ['FOLD', 'TRI', 'SERGE', 'WRAP', 'SINE'], def: 0 },
      { id: 'tone', label: 'TONE', min: 500, max: 20000, def: 12000, unit: 'Hz', curve: 'exp' },
    ];
    init() {
      this.ch = [0, 1].map(() => ({ os: new DRV_OS2(), dc: new DCBlock(0.999), lp: new SVF() }));
      this.lv = new DRV_Level(this.sr, 300, 0.05, 2.5);
      this.g = -1; this.fo = -1;
    }
    _f(u) { // fold law for the current block settings
      const s = this.s;
      switch (this.m) {
        case 1: { // TRI: asymmetric triangle, corners soft -> hard
          const t = DRV_tri(u >= 0 ? u : u * 1.5);
          return t * (1.5 - 0.5 * t * t) * (1 - s) + t * s;
        }
        case 2: return fastTanh(this.k * Math.sin(DRV_HPI * u)) * this.kn; // SERGE: sine -> squarish folds
        case 3: { // WRAP: modulo wrap; the wrap edge is tapered, wide (soft) -> razor (hard)
          const w = u - 2 * Math.floor((u + 1) * 0.5), e = (1 - (w < 0 ? -w : w)) * this.ie;
          return (e < 1 ? w * e : w) * this.wn;
        }
        case 4: return Math.sin(DRV_HPI * u + s * 1.5 * Math.sin(Math.PI * u)); // SINE: self-modulated fold
        default: { const t = DRV_tri(u); return Math.sin(DRV_HPI * u) + (t - Math.sin(DRV_HPI * u)) * s; } // FOLD: sine -> triangle
      }
    }
    process(L, R, n, p) {
      const sr = this.sr, lv = this.lv;
      const gT = dbToGain(p.drive * 0.3), g0 = this.g < 0 ? gT : this.g, dg = (gT - g0) / n; this.g = gT;
      const fT = p.folds, f0 = this.fo < 0 ? fT : this.fo, df = (fT - f0) / n; this.fo = fT;
      this.m = p.model | 0; this.s = p.shape * 0.01;
      this.k = 1 + 5 * this.s; this.kn = 1 / fastTanh(this.k);
      const eps = 0.6 - 0.58 * this.s; this.ie = 1 / eps; this.wn = 1 / (1 - eps);
      const bias = p.bias * 0.01, off = this._f(bias);
      lv.begin(n);
      const lg0 = lv.g0, ldg = lv.dg;
      for (let c = 0; c < 2; c++) {
        const X = c ? R : L, s = this.ch[c], os = s.os, dc = s.dc, lp = s.lp;
        lp.set(p.tone, DRV_Q, sr);
        let si = 0, so = 0;
        for (let i = 0; i < n; i++) {
          const x = X[i], fo = f0 + df * (i + 1);
          os.up(x * (g0 + dg * (i + 1)));
          const ya = this._f(fo * fastTanh(os.a) + bias) - off;
          const yb = this._f(fo * fastTanh(os.b) + bias) - off;
          const y = lp.process(dc.process(os.down(ya, yb)));
          si += x * x; so += y * y;
          X[i] = y * (lg0 + ldg * (i + 1));
        }
        lv.si += si; lv.so += so;
      }
      lv.end(n);
    }
  });

  // ===========================================================================
  // 6. SHEEN — aural exciter (parallel)
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'sheen';
    static label = 'SHEEN';
    static cat = 'DISTORTION';
    static desc = 'Aural exciter: adds dynamic harmonics above TONE and saturated low harmonics in parallel with the dry signal.';
    static latency = 0;
    static params = [
      { id: 'amount', label: 'AMOUNT', min: 0, max: 100, def: 55, unit: '%' },
      { id: 'drive', label: 'DRIVE', min: 0, max: 100, def: 50, unit: '%' },
      { id: 'tone', label: 'TONE', min: 700, max: 12000, def: 3000, unit: 'Hz', curve: 'exp' },
      { id: 'sub', label: 'SUB', min: 0, max: 100, def: 25, unit: '%' },
      { id: 'attack', label: 'ATTACK', min: 0.3, max: 100, def: 3, unit: 'ms', curve: 'exp' },
      { id: 'release', label: 'RELEASE', min: 10, max: 1000, def: 120, unit: 'ms', curve: 'exp' },
      { id: 'color', label: 'COLOR', min: 0, max: 100, def: 30, unit: '%' },
    ];
    init() {
      const sr = this.sr;
      this.ch = [0, 1].map(() => {
        const s = { h1: new SVF(), h2: new SVF(), l1: new SVF(), l2: new SVF(), env: new EnvFollower(sr, 3, 120) };
        s.l1.set(110, 0.6, sr); s.l2.set(420, DRV_Q, sr);
        return s;
      });
    }
    process(L, R, n, p) {
      const sr = this.sr;
      const amt = p.amount * 0.012, k = 1 + p.drive * 0.06, col = p.color * 0.01, sub = p.sub * 0.01;
      for (let c = 0; c < 2; c++) {
        const X = c ? R : L, s = this.ch[c], h1 = s.h1, h2 = s.h2, l1 = s.l1, l2 = s.l2, ef = s.env;
        h1.set(p.tone, DRV_Q, sr); h2.set(p.tone * 0.8, DRV_Q, sr); ef.set(p.attack, p.release);
        for (let i = 0; i < n; i++) {
          const x = X[i];
          h1.process(x);
          const hb = h1.hp, e = ef.process(hb);
          // level-normalised harmonic generator (odd -> even with COLOR)
          const t = fastTanh(k * hb / (e + 0.004));
          h2.process(t + col * (1.6 * t * t - t));
          const exc = h2.hp * e;
          const lo = l1.process(x);
          const sh = l2.process(fastTanh(lo * 3));
          X[i] = x + amt * exc + sub * (0.6 * sh - 0.3 * lo);
        }
      }
    }
  });

  // ===========================================================================
  // 7. HOWL — tuned feedback loop
  // ===========================================================================
  const HW_NOTES = [];
  for (let m = 33; m <= 93; m++) HW_NOTES.push(NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1));
  registerFX(class extends FX {
    static id = 'howl';
    static label = 'HOWL';
    static cat = 'RESONATOR';
    static desc = 'Tuned feedback loop the input excites; above 70 % REGEN it howls on its own, DAMP ducks it while you play.';
    static latency = 0;
    static params = [
      { id: 'note', label: 'NOTE', options: HW_NOTES, def: 'A3' },
      { id: 'regen', label: 'REGEN', min: 0, max: 100, def: 58, unit: '%' },
      { id: 'color', label: 'COLOR', min: 0, max: 100, def: 45, unit: '%' },
      { id: 'bite', label: 'BITE', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'damp', label: 'DAMP', min: 0, max: 100, def: 15, unit: '%' },
      { id: 'couple', label: 'COUPLE', min: 0, max: 100, def: 35, unit: '%' },
      { id: 'drift', label: 'DRIFT', min: 0, max: 100, def: 20, unit: '%' },
      { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    ];
    init() {
      const sr = this.sr, max = Math.ceil(sr / 24) + 16;
      this.ch = [0, 1].map(() => ({ dl: new DelayLine(max), lp: new OnePole(), hp: new OnePole(), d: new Smoother(sr, 40, sr / 220), fb: 0, exc: 1, dr: 0, drT: 0, drC: 0 }));
      this.rng = new Rng(0x40f1);
      this.lv = new DRV_Level(sr, 800, 0.5, 8);
      this.env = 0; this.first = true;
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, rng = this.rng, r = p.regen;
      const kB = 1 + p.bite * 0.05, ikB = 1 / kB, outG = Math.sqrt(kB) * 0.9;
      const cpl = p.couple * 0.01, cross = cpl > 0.15 ? 0.12 * ((cpl - 0.15) / 0.85) * ((cpl - 0.15) / 0.85) : 0, damp = p.damp * 0.01, drift = p.drift * 0.01, col = p.color * 0.01;
      const envA = DRV_coef(2, sr), envR = DRV_coef(150, sr);
      for (let c = 0; c < 2; c++) {
        const s = this.ch[c];
        s.drC -= n;
        if (s.drC <= 0) { s.drC = 0.08 * sr * (0.5 + rng.next()); s.drT = rng.bi(); }
        s.dr += (s.drT - s.dr) * 0.03;
        let m = 33 + (p.note | 0) + (c ? 7 * Math.min(1, cpl * 6.67) : 0);
        if (p.snap) m = ctx.key.snapMidi(m);
        const f = mtof(m + drift * 0.35 * s.dr);
        const fc = Math.min(sr * 0.45, f * (1.2 + 40 * col * col)), fh = f * 0.15;
        s.lp.set(fc, sr); s.hp.set(fh, sr);
        // loop-filter gain at the fundamental (normalised away) and at the 2nd harmonic
        const ratio = f / fc, hl = 1 / Math.sqrt(1 + ratio * ratio) * 0.98894; // 0.98894 = HP gain at f
        const h2 = 1 / Math.sqrt(1 + 4 * ratio * ratio) * 0.99720 / hl;
        // compensate the loop filters' phase so the loop sits on pitch
        const D = sr / f * (1 - Math.atan(ratio) / TAU + Math.atan(fh / f) / TAU);
        if (this.first) s.d.snap(D); else s.d.set(D);
        let fb;
        if (r <= 70) fb = Math.pow(10, -3 / (0.05 * Math.pow(80, r / 70) * f)); // T60 50 ms .. 4 s
        else fb = 1 + (r - 70) / 30 * 0.15; // self-oscillation, bounded by the loop saturator
        s.fb = r <= 70 ? Math.min(fb / hl, 0.9995 / ((h2 > 1 ? h2 : 1) * (1 + cross))) : Math.min(1.6, fb / hl);
        const fq = Math.min(0.99, fb);
        s.exc = Math.sqrt(Math.max(0.02, 1 - fq * fq));
      }
      this.first = false;
      const sL = this.ch[0], sR = this.ch[1], lv = this.lv;
      lv.begin(n);
      const lg0 = lv.g0, ldg = lv.dg;
      let env = this.env, si = 0, so = 0;
      for (let i = 0; i < n; i++) {
        const xl = L[i], xr = R[i], al = xl < 0 ? -xl : xl, ar = xr < 0 ? -xr : xr, a = al > ar ? al : ar;
        env += (a - env) * (a > env ? envA : envR);
        const duckFb = 1 - 0.6 * damp * (env * 3 > 1 ? 1 : env * 3), duckOut = 1 / (1 + 6 * damp * env);
        let yl = sL.dl.read(sL.d.next() - 1), yr = sR.dl.read(sR.d.next() - 1);
        yl = fastTanh(sL.hp.hp(sL.lp.lp(yl)) * kB) * ikB;
        yr = fastTanh(sR.hp.hp(sR.lp.lp(yr)) * kB) * ikB;
        sL.dl.write(xl * sL.exc + sL.fb * duckFb * (yl + yr * cross));
        sR.dl.write(xr * sR.exc + sR.fb * duckFb * (yr + yl * cross));
        const ol = yl * outG, or = yr * outG, g = (lg0 + ldg * (i + 1)) * duckOut;
        si += xl * xl + xr * xr; so += ol * ol + or * or;
        L[i] = fastTanh(ol * g);
        R[i] = fastTanh(or * g);
      }
      lv.si = si; lv.so = so; lv.end(n);
      this.env = env;
    }
  });

  // ===========================================================================
  // 8. OXIDE — tape saturator
  // ===========================================================================
  // per MODE: extra drive (dB), pre/de-emphasis (dB), bias, curve gain, hardness (tanh -> hard clip)
  const OX_PRE = [-3, 0, 5, 10], OX_EMPH = [2, 4, 6, 10], OX_BIAS = [0, 0.06, 0.12, 0.2], OX_A = [0.75, 1, 1.3, 1.8], OX_H = [0, 0, 0.45, 0.9];
  function OX_sat(x, a, h) { // one code path for every mode (no JIT deopt on mode switches)
    const v = a * x, t = fastTanh(v), c = v > 1 ? 1 : v < -1 ? -1 : v;
    return t + (c - t) * h;
  }
  registerFX(class extends FX {
    static id = 'oxide';
    static label = 'OXIDE';
    static cat = 'DISTORTION';
    static desc = 'Oversampled tape machine: hysteretic saturation, head bump, HF loss, hiss, wow & flutter, generation loss and oxide dropouts.';
    static latency = 0;
    static params = [
      { id: 'drive', label: 'DRIVE', min: -12, max: 24, def: 6, unit: 'dB' },
      { id: 'mode', label: 'MODE', options: ['GENTLE', 'NORMAL', 'HARD', 'HARSH'], def: 1 },
      { id: 'bass', label: 'BASS', min: 0, max: 100, def: 35, unit: '%' },
      { id: 'dull', label: 'DULL', min: 0, max: 100, def: 25, unit: '%' },
      { id: 'wow', label: 'WOW', min: 0, max: 100, def: 15, unit: '%' },
      { id: 'flutter', label: 'FLUTTER', min: 0, max: 100, def: 20, unit: '%' },
      { id: 'noise', label: 'NOISE', min: 0, max: 100, def: 10, unit: '%' },
      { id: 'hyst', label: 'HYST', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'age', label: 'AGE', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'dropout', label: 'DROPOUT', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 50, unit: '%' },
    ];
    init() {
      const sr = this.sr;
      this.ch = [0, 1].map(() => ({
        bump: new Biquad(), lp: new Biquad(), ns: 0x1234567, zA: 0, zB: 0, zH: 0, zN: 0, zD: 0,
        os: new DRV_OS2(), line: new DelayLine(Math.ceil(sr * 0.012) + 8), M: 0, base: -1, dPrev: -1, wr: 0, wrT: 0, fr: 0, frT: 0,
        dropT: 0, dropLen: 1, dropDepth: 0, nextDrop: 1e12, rateUsed: 0,
      }));
      const tg = (f) => { const t = Math.tan(Math.PI * Math.min(f, sr * 0.45) / sr); return t / (1 + t); }; // TPT one-pole coef
      this.tg = tg; this.gN = tg(700); this.gD = tg(1500); this.gA = tg(2500); this.gB = tg(2500); this.aE = 1; this.gH = tg(12);
      this.lv = new DRV_Level(sr, 400, 0.1, 6);
      this.rng = new Rng(0x7a9e);
      this.wph = 0; this.fph = 0; this.fph2 = 0.3; this.g = -1;
      this.key = ''; // cached EQ settings
    }
    process(L, R, n, p) {
      const sr = this.sr, rng = this.rng, lv = this.lv, mode = p.mode | 0;
      const age = p.age * 0.01, width = p.width * 0.01;
      const gT = dbToGain(p.drive + OX_PRE[mode] + age * 4), g0 = this.g < 0 ? gT : this.g, dg = (gT - g0) / n; this.g = gT;
      const bias = OX_BIAS[mode], sa = OX_A[mode], sh = OX_H[mode], off = OX_sat(bias, sa, sh);
      const cRel = 1 - Math.exp(-TAU * 20000 * Math.pow(0.06, p.hyst * 0.01) / (2 * sr));
      // EQ (only recomputed when something changed)
      const fcLP = clamp(20000 * Math.pow(0.1, p.dull * 0.01 + age * 0.5), 1200, 20000);
      const eqKey = mode * 1e9 + Math.round(p.bass * 10) * 1e5 + Math.round(fcLP) + age * 0.5;
      if (eqKey !== this.key) {
        this.key = eqKey;
        // first-order pre-emphasis shelf (+E dB above 2.5 kHz) and its exact inverse
        this.aE = dbToGain(OX_EMPH[mode]) - 1; this.gB = this.tg(2500 / (1 + this.aE)); this.gH = this.tg(12 + age * 110);
        for (const s of this.ch) { DRV_bqPeak(s.bump, 72, 1.2, p.bass * 0.07, sr); DRV_bqLP(s.lp, fcLP, 0.62, sr); }
      }
      // wow & flutter (block-rate LFOs, interpolated)
      const wowA = Math.min(1.3, p.wow * 0.01 + age * 0.3), flA = Math.min(1.3, p.flutter * 0.01 + age * 0.2);
      const Aw = wowA * 0.007 * sr / (TAU * 0.55), Af = flA * 0.002 * sr / (TAU * 7);
      const bt = n / sr;
      this.wph = (this.wph + 0.55 * bt) % 1; this.fph = (this.fph + 6.8 * bt) % 1; this.fph2 = (this.fph2 + 11.3 * bt) % 1;
      const hiss = p.noise * p.noise * 2e-6 * (1 + 2 * age);
      const dropRate = (p.dropout * p.dropout * 8e-4 + (p.dropout > 0 ? age : 0)) / sr;
      lv.begin(n);
      const lg0 = lv.g0, ldg = lv.dg;
      this.linkI = -1;
      for (let c = 0; c < 2; c++) {
        const s = this.ch[c];
        // dropout scheduling (Poisson); the right channel shares the left's dropouts as WIDTH -> 0
        const dRate = c ? dropRate * width : dropRate;
        if (dRate !== s.rateUsed) { s.rateUsed = dRate; s.nextDrop = dRate > 0 ? -Math.log(1 - rng.next()) / dRate : 1e12; }
        // random-walk parts; the right channel follows the left as WIDTH -> 0
        if (rng.next() < 0.05) s.wrT = rng.bi();
        if (rng.next() < 0.3) s.frT = rng.bi();
        s.wr += (s.wrT - s.wr) * 0.02; s.fr += (s.frT - s.fr) * 0.2;
        const o = c ? width * 0.5 : 0;
        const wr = c ? this.ch[0].wr + (s.wr - this.ch[0].wr) * width : s.wr;
        const fr = c ? this.ch[0].fr + (s.fr - this.ch[0].fr) * width : s.fr;
        const wl = 0.75 * Math.sin(TAU * (this.wph + o)) + 0.25 * wr;
        const fl = 0.6 * Math.sin(TAU * (this.fph + o * 0.7)) + 0.25 * Math.sin(TAU * (this.fph2 + o * 0.3)) + 0.15 * fr;
        const bT = Aw + Af + 3;
        s.base = s.base < 0 ? bT : s.base + (bT - s.base) * 0.05;
        const dEnd = s.base + Aw * wl + Af * fl, dStart = s.dPrev < 0 ? dEnd : s.dPrev;
        s.dPrev = dEnd;
        this.dStart = dStart; this.dd = (dEnd - dStart) / n; this.dRate = dRate; this.width = width;
        this._chan(c ? R : L, s, c, n, g0, dg, bias, sa, sh, off, cRel, lg0, ldg, hiss);
      }
      lv.end(n);
    }
    _drop(s, c, i) { // start an oxide dropout (and maybe mirror it on the right channel)
      const rng = this.rng;
      if (s.nextDrop <= 0) s.nextDrop = this.dRate > 0 ? -Math.log(1 - rng.next()) / this.dRate : 1e12;
      s.dropLen = Math.round((0.015 + 0.1 * rng.next()) * this.sr); s.dropT = s.dropLen; s.dropDepth = 0.4 + 0.55 * rng.next();
      if (c === 0 && rng.next() > this.width) this.linkI = i;
    }
    _chan(X, s, c, n, g0, dg, bias, sa, sh, off, cRel, lg0, ldg, hiss) {
      const lv = this.lv, dStart = this.dStart, dd = this.dd;
      const gA = this.gA, gB = this.gB, aE = this.aE, iE = 1 / (1 + aE), gH = this.gH, gN = this.gN, gD = this.gD;
      {
        const os = s.os, bump = s.bump, lp = s.lp, line = s.line, lb = line.buf, lm = line.mask;
        let M = s.M, si = 0, so = 0, ns = s.ns, zA = s.zA, zB = s.zB, zH = s.zH, zN = s.zN, zD = s.zD, v, u;
        for (let i = 0; i < n; i++) {
          const x = X[i], xd = x * (g0 + dg * (i + 1));
          v = (xd - zA) * gA; u = v + zA; zA = u + v; // pre-emphasis: x + a*HP(x)
          os.up(xd + aE * (xd - u));
          // saturation with direction-dependent relaxation (hysteresis)
          let T = OX_sat(os.a + bias, sa, sh) - off;
          if (T * M >= 0 && (T < 0 ? -T : T) > (M < 0 ? -M : M)) M = T; else M += (T - M) * cRel;
          const ya = M;
          T = OX_sat(os.b + bias, sa, sh) - off;
          if (T * M >= 0 && (T < 0 ? -T : T) > (M < 0 ? -M : M)) M = T; else M += (T - M) * cRel;
          let y = os.down(ya, M);
          v = (y - zB) * gB; u = v + zB; zB = u + v; y = u + (y - u) * iE; // de-emphasis
          si += x * x; so += y * y;
          y = bump.process(y * (lg0 + ldg * (i + 1)));
          if (hiss > 0) { // bright tape hiss
            ns = (Math.imul(ns, 1664525) + 1013904223) | 0;
            const w = ns * 4.656612873e-10; v = (w - zN) * gN; u = v + zN; zN = u + v; y += (w - u) * hiss;
          }
          y = lp.process(y);
          v = (y - zH) * gH; u = v + zH; zH = u + v; y -= u; // rumble / generation low cut
          line.write(y);
          { // hermite read, delay >= 3 samples
            const pos = line.w - 1 - (dStart + dd * (i + 1)), ip = Math.floor(pos), f = pos - ip;
            const xm1 = lb[(ip - 1) & lm], x0 = lb[ip & lm], x1 = lb[(ip + 1) & lm], x2 = lb[(ip + 2) & lm];
            const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
            y = ((c3 * f + c2) * f + c1) * f + x0;
          }
          // oxide dropouts
          if (s.dropT > 0) {
            const t = s.dropT / s.dropLen, q = 4 * t * (1 - t), k = s.dropDepth * q * q;
            v = (y - zD) * gD; u = v + zD; zD = u + v;
            y = (y + (u - y) * k * 0.6) * (1 - k);
            s.dropT--;
          } else if (--s.nextDrop <= 0 || (c === 1 && i === this.linkI)) { this._drop(s, c, i); zD = y; }
          X[i] = y;
        }
        s.M = M; s.ns = ns; s.zA = zA; s.zB = zB; s.zH = zH; s.zN = zN; s.zD = zD;
        lv.si += si; lv.so += so;
      }
    }
  });

  // ===========================================================================
  // 9. SUBDIV — subharmonic divider (parallel)
  // ===========================================================================
  const SD_DIVS = ['÷2', '÷3', '÷4', '÷5', '÷6', '÷7', '÷8'];
  registerFX(class extends FX {
    static id = 'subdiv';
    static label = 'SUBDIV';
    static cat = 'PITCH';
    static desc = 'Flip-flop subharmonic divider: tracks the fundamental and adds square subs at 1/N (two dividers, blendable) under the dry signal.';
    static latency = 0;
    static params = [
      { id: 'divide', label: 'DIVIDE', options: SD_DIVS, def: 0 },
      { id: 'level', label: 'LEVEL', min: 0, max: 200, def: 100, unit: '%' },
      { id: 'tone', label: 'TONE', min: 40, max: 2000, def: 220, unit: 'Hz', curve: 'exp' },
      { id: 'blend', label: 'BLEND', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'divb', label: 'DIVIDE B', options: SD_DIVS, def: 2 },
      { id: 'misfire', label: 'MISFIRE', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'dry', label: 'DRY', min: 0, max: 100, def: 100, unit: '%' },
      { id: 'track', label: 'TRACK', min: 60, max: 1000, def: 280, unit: 'Hz', curve: 'exp' },
    ];
    init() {
      this.t1 = new SVF(); this.t2 = new SVF(); this.hp = new OnePole(); this.hp.set(28, this.sr);
      this.tone = new SVF(); this.rng = new Rng(0xd1f);
      this.env = 0; this.hi = 0; this.cA = 0; this.cB = 0; this.qA = 1; this.qB = 1; this.sA = 0; this.sB = 0;
      this.lvl = -1; this.dry = -1;
    }
    _edge(nA, nB, mis) {
      let cnt = 1;
      if (mis > 0) {
        const r = this.rng.next();
        if (r < mis * 0.2) cnt = 0; else if (r < mis * 0.35) cnt = 2; else if (r < mis * 0.42) { this.cA = 0; this.cB = 0; }
      }
      for (let k = 0; k < cnt; k++) { this.cA = (this.cA + 1) % nA; this.cB = (this.cB + 1) % nB; }
      this.qA = 2 * this.cA < nA ? 1 : -1; this.qB = 2 * this.cB < nB ? 1 : -1;
    }
    process(L, R, n, p) {
      const sr = this.sr, nA = (p.divide | 0) + 2, nB = (p.divb | 0) + 2, mis = p.misfire * 0.01, bl = p.blend * 0.01;
      this.t1.set(p.track, 0.6, sr); this.t2.set(p.track, 0.6, sr); this.tone.set(p.tone, DRV_Q, sr);
      const lT = p.level * 0.01, l0 = this.lvl < 0 ? lT : this.lvl, dl = (lT - l0) / n; this.lvl = lT;
      const dT = p.dry * 0.01, d0 = this.dry < 0 ? dT : this.dry, dd = (dT - d0) / n; this.dry = dT;
      const eA = DRV_coef(3, sr), eR = DRV_coef(80, sr), slew = DRV_coef(0.4, sr);
      const t1 = this.t1, t2 = this.t2, hp = this.hp, tn = this.tone;
      let env = this.env, sA = this.sA, sB = this.sB;
      for (let i = 0; i < n; i++) {
        const t = t2.process(t1.process(hp.hp(0.5 * (L[i] + R[i])))), at = t < 0 ? -t : t;
        env += (at - env) * (at > env ? eA : eR);
        const th = 0.12 * env + 0.0005;
        if (!this.hi && t > th) { this.hi = 1; this._edge(nA, nB, mis); } else if (this.hi && t < -th) this.hi = 0;
        sA += (this.qA - sA) * slew; sB += (this.qB - sB) * slew;
        const sub = tn.process((sA + (sB - sA) * bl) * env) * (l0 + dl * (i + 1));
        const dr = d0 + dd * (i + 1);
        L[i] = L[i] * dr + sub; R[i] = R[i] * dr + sub;
      }
      this.env = env; this.sA = sA; this.sB = sB;
    }
  });

  // ===========================================================================
  // 10. MIRROR — shimmer folder (folder inside a pitch-shifted feedback loop)
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'mirror';
    static label = 'MIRROR';
    static cat = 'DISTORTION';
    static desc = 'Shimmer folder: a sine/triangle wavefolder whose output is pitch-shifted and fed back into itself as a glittering trail.';
    static latency = 0;
    static params = [
      { id: 'fold', label: 'FOLD', min: 0, max: 100, def: 45, unit: '%' },
      { id: 'shape', label: 'SHAPE', min: 0, max: 100, def: 20, unit: '%' },
      { id: 'fdbk', label: 'FDBK', min: 0, max: 100, def: 45, unit: '%' },
      { id: 'trail', label: 'TRAIL', min: -24, max: 24, def: 12, unit: 'st', bipolar: true },
      { id: 'tone', label: 'TONE', min: 1000, max: 16000, def: 7000, unit: 'Hz', curve: 'exp' },
      { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    ];
    init() {
      const sr = this.sr;
      this.W = Math.round(0.06 * sr); this.pre = Math.round(0.05 * sr);
      this.ch = [0, 1].map((c) => ({ dl: new DelayLine(this.W + this.pre + 16), ph: c * 0.25, fb: 0, lp: new OnePole(), hp: new OnePole(), dc: new DCBlock(0.999) }));
      this.lv = new DRV_Level(sr, 400, 0.1, 2);
      this.gF = -1; this.sT = NaN; this.sRoot = -1; this.sIv = null; this.sV = 0;
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, lv = this.lv, W = this.W, pre = this.pre;
      const fold = p.fold * 0.01, gT = 1 + 7 * fold * fold, g0 = this.gF < 0 ? gT : this.gF, dg = (gT - g0) / n; this.gF = gT;
      const sh = p.shape * 0.01, fbk = p.fdbk * 0.0092;
      let semis = p.trail;
      if (p.snap) { // lib snapSemis allocates: only recompute when trail or key change
        const k = ctx.key;
        if (p.trail !== this.sT || k.root !== this.sRoot || k.intervals !== this.sIv) { this.sT = p.trail; this.sRoot = k.root; this.sIv = k.intervals; this.sV = k.snapSemis(p.trail); }
        semis = this.sV;
      }
      const dph = (1 - Math.pow(2, semis / 12)) / W;
      lv.begin(n);
      const lg0 = lv.g0, ldg = lv.dg;
      for (let c = 0; c < 2; c++) {
        const X = c ? R : L, s = this.ch[c], dl = s.dl, lp = s.lp, hp = s.hp, dc = s.dc;
        lp.set(p.tone, sr); hp.set(90, sr);
        let ph = s.ph, fb = s.fb, si = 0, so = 0;
        for (let i = 0; i < n; i++) {
          const x = X[i];
          const u = (g0 + dg * (i + 1)) * x + fbk * fb;
          const sn = Math.sin(u);
          const y = dc.process(sn + (DRV_tri(u) - sn) * sh);
          dl.write(y);
          // two-grain pitch shifter on the folded signal (hann pair sums to 1)
          ph += dph; ph -= Math.floor(ph);
          let p2 = ph + 0.5; if (p2 >= 1) p2 -= 1;
          const w1 = 0.5 - 0.5 * Math.cos(TAU * ph);
          const shf = dl.read(pre + ph * W) * w1 + dl.read(pre + p2 * W) * (1 - w1);
          fb = hp.hp(lp.lp(shf));
          si += x * x; so += y * y;
          X[i] = y * (lg0 + ldg * (i + 1));
        }
        s.ph = ph; s.fb = fb;
        lv.si += si; lv.so += so;
      }
      lv.end(n);
    }
  });

  // ===========================================================================
  // 11. SQUEEZE — OTT-style up/down multiband compressor
  // ===========================================================================
  const SQ_ATT = [8, 3, 1], SQ_REL = [220, 140, 90];
  registerFX(class extends FX {
    static id = 'squeeze';
    static label = 'SQUEEZE';
    static cat = 'DYNAMICS';
    static desc = 'Aggressive multiband upward + downward compressor (1-3 bands) that lifts tails and flattens peaks.';
    static latency = 0;
    static params = [
      { id: 'depth', label: 'DEPTH', min: 0, max: 100, def: 60, unit: '%' },
      { id: 'time', label: 'TIME', min: 0, max: 100, def: 40, unit: '%' },
      { id: 'input', label: 'IN', min: -24, max: 24, def: 0, unit: 'dB', bipolar: true },
      { id: 'output', label: 'OUT', min: -24, max: 24, def: 0, unit: 'dB', bipolar: true },
      { id: 'bands', label: 'BANDS', options: ['1', '2', '3'], def: 2 },
      { id: 'upward', label: 'UPWARD', min: 0, max: 100, def: 100, unit: '%' },
      { id: 'downward', label: 'DOWNWARD', min: 0, max: 100, def: 100, unit: '%' },
      { id: 'lox', label: 'LO X', min: 40, max: 600, def: 120, unit: 'Hz', curve: 'exp' },
      { id: 'hix', label: 'HI X', min: 800, max: 10000, def: 2500, unit: 'Hz', curve: 'exp' },
    ];
    init() {
      this.xl = new DRV_XO(); this.xr = new DRV_XO();
      this.env = new Float64Array(3); this.ca = new Float64Array(3); this.cr = new Float64Array(3);
      this.gc = new Float64Array([1, 1, 1]); this.gs = new Float64Array(3);
      this.gi = -1; this.go = -1;
    }
    // band gain (linear) from its envelope; thresholds sit lower for higher bands
    _gain(e, b) {
      const lv = DRV_DB * Math.log(e + 1e-9), o = 2 * b;
      return Math.exp((this.depth * (DRV_down(lv, -20 - o, this.Rd, 6) + DRV_up(lv, -40 - o, this.Ru, 18, -62 - o)) + this.mk) * DRV_LN);
    }
    process(L, R, n, p) {
      const sr = this.sr, nb = (p.bands | 0) + 1, env = this.env, ca = this.ca, cr = this.cr, gc = this.gc, gs = this.gs;
      this.depth = p.depth * 0.01; this.Rd = 1 + 9 * p.downward * 0.01; this.Ru = 1 + 3 * p.upward * 0.01; this.mk = this.depth * 8;
      const tf = 0.1 * Math.pow(100, p.time * 0.01);
      for (let b = 0; b < 3; b++) { ca[b] = DRV_coef(SQ_ATT[b] * tf, sr); cr[b] = DRV_coef(SQ_REL[b] * tf, sr); }
      if (nb > 1) { this.xl.set(p.lox, p.hix, sr); this.xr.set(p.lox, p.hix, sr); }
      const giT = dbToGain(p.input), gi0 = this.gi < 0 ? giT : this.gi, dgi = (giT - gi0) / n; this.gi = giT;
      const goT = dbToGain(p.output), go0 = this.go < 0 ? goT : this.go, dgo = (goT - go0) / n; this.go = goT;
      const xl = this.xl, xr = this.xr, ca0 = ca[0], ca1 = ca[1], ca2 = ca[2], cr0 = cr[0], cr1 = cr[1], cr2 = cr[2];
      let e0 = env[0], e1 = env[1], e2 = env[2], g0 = gc[0], g1 = gc[1], g2 = gc[2], s0 = gs[0], s1 = gs[1], s2 = gs[2];
      for (let i = 0; i < n; i++) {
        const gi = gi0 + dgi * (i + 1), l = L[i] * gi, r = R[i] * gi;
        let l0 = l, r0 = r, l1 = 0, r1 = 0, l2 = 0, r2 = 0, a, d;
        if (nb === 2) { xl.split2(l); xr.split2(r); l0 = xl.lo; r0 = xr.lo; l1 = xl.hi; r1 = xr.hi; }
        else if (nb === 3) { xl.split3(l); xr.split3(r); l0 = xl.lo; r0 = xr.lo; l1 = xl.mid; r1 = xr.mid; l2 = xl.hi; r2 = xr.hi; }
        // stereo-linked peak envelopes per band
        a = l0 < 0 ? -l0 : l0; d = r0 < 0 ? -r0 : r0; if (a > d) d = a; e0 += (d - e0) * (d > e0 ? ca0 : cr0);
        a = l1 < 0 ? -l1 : l1; d = r1 < 0 ? -r1 : r1; if (a > d) d = a; e1 += (d - e1) * (d > e1 ? ca1 : cr1);
        a = l2 < 0 ? -l2 : l2; d = r2 < 0 ? -r2 : r2; if (a > d) d = a; e2 += (d - e2) * (d > e2 ? ca2 : cr2);
        if ((i & 3) === 0) { // gain computer at 1/4 rate, linear ramps in between
          s0 = (this._gain(e0, 0) - g0) * 0.25;
          if (nb > 1) s1 = (this._gain(e1, 1) - g1) * 0.25;
          if (nb > 2) s2 = (this._gain(e2, 2) - g2) * 0.25;
        }
        g0 += s0; g1 += s1; g2 += s2;
        const go = go0 + dgo * (i + 1);
        L[i] = DRV_soft((l0 * g0 + l1 * g1 + l2 * g2) * go); R[i] = DRV_soft((r0 * g0 + r1 * g1 + r2 * g2) * go);
      }
      env[0] = e0; env[1] = e1; env[2] = e2; gc[0] = g0; gc[1] = g1; gc[2] = g2; gs[0] = s0; gs[1] = s1; gs[2] = s2;
    }
  });

  // ===========================================================================
  // 12. GATE — noise gate + rhythmic trance gate
  // ===========================================================================
  const GT_PATS = [
    ['CLASSIC', 'x.x.x.x.x.x.x.x.'], ['GALLOP', 'x.xxx.xxx.xxx.xx'], ['OFFBEAT', '..x...x...x...x.'],
    ['SYNCOPA', 'x..x..x...x..x..'], ['PUMP', '.xxx.xxx.xxx.xxx'], ['STUTTER', 'xxxx..x.xx..x.x.'],
    ['BROKEN', 'x.x..x.xx..x.x..'], ['TRIPLET', 'xx.xx.xx.xx.xx.x'], ['SPARSE', 'x.......x...x...'], ['RANDOM', ''],
  ];
  const GT_MASK = GT_PATS.map((d) => { let m = 0; for (let i = 0; i < d[1].length; i++) if (d[1][i] === 'x') m |= 1 << i; return m; });
  registerFX(class extends FX {
    static id = 'gate';
    static label = 'GATE';
    static cat = 'DYNAMICS';
    static desc = 'Noise gate with hold and range, or a tempo-locked 16-step trance gate with shaped steps (THRESH applies to NOISE mode).';
    static latency = 0;
    static params = [
      { id: 'mode', label: 'MODE', options: ['NOISE', 'TRANCE'], def: 1 },
      { id: 'pattern', label: 'PATTERN', options: GT_PATS.map((d) => d[0]), def: 0 },
      { id: 'rate', label: 'RATE', div: ['1/4', '1/64'], def: '1/16' },
      { id: 'thresh', label: 'THRESH', min: -80, max: 0, def: -30, unit: 'dB' },
      { id: 'release', label: 'RELEASE', min: 5, max: 2000, def: 60, unit: 'ms', curve: 'exp' },
      { id: 'range', label: 'RANGE', min: -80, max: 0, def: -60, unit: 'dB' },
      { id: 'attack', label: 'ATTACK', min: 0.1, max: 100, def: 1, unit: 'ms', curve: 'exp' },
      { id: 'hold', label: 'HOLD', min: 0, max: 500, def: 20, unit: 'ms', curve: 'sq' },
      { id: 'shape', label: 'SHAPE', min: 0, max: 100, def: 25, unit: '%' },
    ];
    init() {
      this.e = 0; this.det = 0; this.open = 0; this.hc = 0; this.rng = new Rng(0x6a7e);
      this.rnd = 0xa5a5; this.lastBar = -1;
    }
    process(L, R, n, p, ctx) {
      const sr = this.sr, floor = p.range <= -79.5 ? 0 : dbToGain(p.range);
      const rel = Math.max(1, p.release), cR = DRV_coef(rel, sr);
      let e = this.e;
      if ((p.mode | 0) === 1) {
        const div = p.rate, stepLen = div * ctx.spb, sh = p.shape * 0.01, pat = p.pattern | 0;
        const cA = DRV_coef(Math.max(0.5, p.attack) + sh * 350 * stepLen / sr, sr);
        let pos = ctx.ppq / div;
        const dp = 1 / stepLen;
        let mask = pat === 9 ? this.rnd : GT_MASK[pat];
        for (let i = 0; i < n; i++, pos += dp) {
          const st = Math.floor(pos), ph = pos - st, k = ((st % 16) + 16) % 16;
          if (pat === 9 && k === 0 && st !== this.lastBar) {
            this.lastBar = st; this.rnd = (this.rng.nextU32() & 0xffff) | 1; mask = this.rnd;
          }
          const tgt = (mask >> k) & 1 ? 1 - sh * 0.7 * ph : 0;
          e += (tgt - e) * (tgt > e ? cA : cR);
          const g = floor + (1 - floor) * e;
          L[i] *= g; R[i] *= g;
        }
      } else {
        const thr = dbToGain(p.thresh), thrC = thr * 0.6, holdN = p.hold * 0.001 * sr;
        const cA = DRV_coef(Math.max(0.5, p.attack), sr), dA = DRV_coef(0.2, sr), dR = DRV_coef(15, sr);
        let det = this.det, open = this.open, hc = this.hc;
        for (let i = 0; i < n; i++) {
          const al = L[i] < 0 ? -L[i] : L[i], ar = R[i] < 0 ? -R[i] : R[i], d = al > ar ? al : ar;
          det += (d - det) * (d > det ? dA : dR);
          if (det > thr) { open = 1; hc = holdN; } else if (hc > 0) hc--; else if (det < thrC) open = 0;
          e += (open - e) * (open > e ? cA : cR);
          const g = floor + (1 - floor) * e;
          L[i] *= g; R[i] *= g;
        }
        this.det = det; this.open = open; this.hc = hc;
      }
      this.e = e;
    }
  });

  // ===========================================================================
  // 13. MAULER — 2-band compressor + saturator (CLASSIC) / 3-band lifter (MELT)
  // ===========================================================================
  registerFX(class extends FX {
    static id = 'mauler';
    static label = 'MAULER';
    static cat = 'DYNAMICS';
    static desc = 'Brutal band compressor + saturator: CLASSIC is a punchy 2-band squash, MELT a 3-band upward-lifting smear.';
    static latency = 0;
    static params = [
      { id: 'engine', label: 'ENGINE', options: ['CLASSIC', 'MELT'], def: 0 },
      { id: 'brutal', label: 'BRUTAL', min: 0, max: 100, def: 50, unit: '%' },
      { id: 'lift', label: 'LIFT', min: 0, max: 100, def: 25, unit: '%' },
      { id: 'pump', label: 'PUMP', min: 0, max: 100, def: 20, unit: '%' },
      { id: 'grit', label: 'GRIT', min: 0, max: 100, def: 35, unit: '%' },
      { id: 'tone', label: 'TONE', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
    ];
    init() {
      const sr = this.sr;
      this.xl = new DRV_XO(); this.xr = new DRV_XO();
      this.xl.set(150, 2500, sr); this.xr.set(150, 2500, sr);
      this.e0 = 0; this.e1 = 0; this.e2 = 0;
      this.ch = [0, 1].map(() => ({ dc: new DCBlock(0.999), tilt: new DRV_Tilt(sr) }));
      this.lv = new DRV_Level(sr, 900, 0.25, 4);
    }
    process(L, R, n, p) {
      const sr = this.sr, lv = this.lv, melt = (p.engine | 0) === 1;
      const br = p.brutal * 0.01, lift = p.lift * 0.01, pump = p.pump * 0.01, grit = p.grit * 0.01;
      let thr, ratio, att, rel, uThr, uR, uMax, kG;
      if (!melt) { thr = -8 - 26 * br; ratio = 2 + 14 * br; att = 8 - 6 * br; rel = 90 + 450 * pump; uThr = thr - 14; uR = 1 + 3 * lift; uMax = 15 * lift; kG = 1 + 8 * grit; }
      else { thr = -14 - 20 * br; ratio = 1.5 + 5 * br; att = 18 - 8 * br; rel = 220 + 700 * pump; uThr = -34; uR = 1 + 6 * lift; uMax = 24 * lift; kG = 1 + 5 * grit; }
      const ca = DRV_coef(att, sr), cr = DRV_coef(rel, sr), key = pump * 1.5, ikG = 1 / kG;
      const xl = this.xl, xr = this.xr, sL = this.ch[0], sR = this.ch[1];
      sL.tilt.set(p.tone * 0.01); sR.tilt.set(p.tone * 0.01);
      let e0 = this.e0, e1 = this.e1, e2 = this.e2;
      lv.begin(n);
      const lg0 = lv.g0, ldg = lv.dg;
      let si = 0, so = 0;
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        if (melt) { xl.split3(l); xr.split3(r); } else { xl.split2(l); xr.split2(r); }
        let a, d;
        a = xl.lo < 0 ? -xl.lo : xl.lo; d = xr.lo < 0 ? -xr.lo : xr.lo; if (a > d) d = a;
        const dLow = d;
        e0 += (d - e0) * (d > e0 ? ca : cr);
        a = DRV_DB * Math.log(e0 + 1e-9);
        const g0 = Math.exp((DRV_down(a, thr, ratio, 8) + DRV_up(a, uThr, uR, uMax, -60)) * DRV_LN);
        let ol, or;
        if (!melt) {
          const hl = xl.hi, hr = xr.hi;
          a = hl < 0 ? -hl : hl; d = hr < 0 ? -hr : hr; if (a > d) d = a;
          if (dLow * key > d) d = dLow * key; // PUMP: the low band keys the top band
          e1 += (d - e1) * (d > e1 ? ca : cr);
          a = DRV_DB * Math.log(e1 + 1e-9);
          const g1 = Math.exp((DRV_down(a, thr - 4, ratio, 8) + DRV_up(a, uThr - 4, uR, uMax, -62)) * DRV_LN);
          ol = fastTanh(xl.lo * g0 * kG) * ikG + softClip(hl * g1 * kG * 1.2) * ikG;
          or = fastTanh(xr.lo * g0 * kG) * ikG + softClip(hr * g1 * kG * 1.2) * ikG;
        } else {
          a = xl.mid < 0 ? -xl.mid : xl.mid; d = xr.mid < 0 ? -xr.mid : xr.mid; if (a > d) d = a;
          if (dLow * key > d) d = dLow * key;
          e1 += (d - e1) * (d > e1 ? ca : cr);
          a = DRV_DB * Math.log(e1 + 1e-9);
          const g1 = Math.exp((DRV_down(a, thr - 3, ratio, 10) + DRV_up(a, uThr - 3, uR, uMax, -62)) * DRV_LN);
          a = xl.hi < 0 ? -xl.hi : xl.hi; d = xr.hi < 0 ? -xr.hi : xr.hi; if (a > d) d = a;
          if (dLow * key > d) d = dLow * key;
          e2 += (d - e2) * (d > e2 ? ca : cr);
          a = DRV_DB * Math.log(e2 + 1e-9);
          const g2 = Math.exp((DRV_down(a, thr - 6, ratio, 10) + DRV_up(a, uThr - 6, uR, uMax, -64)) * DRV_LN);
          // "melt" saturation: asymmetric, softer
          let v = (xl.lo * g0 + xl.mid * g1 + xl.hi * g2) * kG;
          ol = (v >= 0 ? fastTanh(v) : fastTanh(v * 1.3) * 0.77) * ikG;
          v = (xr.lo * g0 + xr.mid * g1 + xr.hi * g2) * kG;
          or = (v >= 0 ? fastTanh(v) : fastTanh(v * 1.3) * 0.77) * ikG;
        }
        ol = sL.dc.process(ol); or = sR.dc.process(or);
        si += l * l + r * r; so += ol * ol + or * or;
        const lg = lg0 + ldg * (i + 1);
        L[i] = DRV_soft(sL.tilt.process(ol * lg)); R[i] = DRV_soft(sR.tilt.process(or * lg));
      }
      lv.si = si; lv.so = so;
      lv.end(n);
      this.e0 = e0; this.e1 = e1; this.e2 = e2;
    }
  });

  // ===========================================================================
  // 14. SHAPER — level-independent transient designer
  // ===========================================================================
  const SH_SPLITS = ['FULL', '40 Hz', '80 Hz', '160 Hz', '315 Hz', '630 Hz', '1.2 kHz', '2.5 kHz', '5 kHz', '10 kHz'];
  const SH_FREQ = [0, 40, 80, 160, 315, 630, 1250, 2500, 5000, 10000];
  registerFX(class extends FX {
    static id = 'shaper';
    static label = 'SHAPER';
    static cat = 'DYNAMICS';
    static desc = 'Level-independent transient designer: boost or cut attacks and sustain, optionally only above or below a split frequency.';
    static latency = 0;
    static params = [
      { id: 'attack', label: 'ATTACK', min: -100, max: 100, def: 50, unit: '%', bipolar: true },
      { id: 'sustain', label: 'SUSTAIN', min: -100, max: 100, def: -30, unit: '%', bipolar: true },
      { id: 'time', label: 'TIME', min: 1, max: 80, def: 15, unit: 'ms', curve: 'exp' },
      { id: 'release', label: 'RELEASE', min: 30, max: 2000, def: 250, unit: 'ms', curve: 'exp' },
      { id: 'split', label: 'SPLIT', options: SH_SPLITS, def: 0 },
      { id: 'band', label: 'BAND', options: ['HIGH', 'LOW'], def: 0 },
    ];
    init() {
      this.xl = new DRV_XO(); this.xr = new DRV_XO();
      this.pw = 0; this.e2 = 0; this.e3 = 0; this.gs = 1;
    }
    process(L, R, n, p) {
      const sr = this.sr, si = p.split | 0, low = (p.band | 0) === 1;
      if (si > 0) { this.xl.set(SH_FREQ[si], 20000, sr); this.xr.set(SH_FREQ[si], 20000, sr); }
      const atk = p.attack * 0.005, sus = p.sustain * 0.005;
      const cP = DRV_coef(2, sr), rF = DRV_coef(20, sr), aS = DRV_coef(p.time, sr), rS = DRV_coef(p.release, sr), gc = DRV_coef(0.5, sr);
      const xl = this.xl, xr = this.xr;
      let pw = this.pw, e2 = this.e2, e3 = this.e3, gs = this.gs;
      for (let i = 0; i < n; i++) {
        let bl = L[i], br = R[i], ol = 0, or = 0;
        if (si > 0) {
          xl.split2(bl); xr.split2(br);
          if (low) { bl = xl.lo; br = xr.lo; ol = xl.hi; or = xr.hi; } else { bl = xl.hi; br = xr.hi; ol = xl.lo; or = xr.lo; }
        }
        const al = bl < 0 ? -bl : bl, ar = br < 0 ? -br : br, d = al > ar ? al : ar;
        pw += (d * d - pw) * cP; // short power average: little ripple on steady tones
        const e1 = Math.sqrt(pw);
        e2 += (e1 - e2) * (e1 > e2 ? aS : rF); // slow-attack envelope
        e3 = e1 > e3 ? e1 : e3 + (e1 - e3) * rS; // slow-release envelope
        const l1 = Math.log(e1 + 1e-6);
        let T = (l1 - Math.log(e2 + 1e-6)) * DRV_DB, S = (Math.log(e3 + 1e-6) - l1) * DRV_DB;
        T = T < 0 ? 0 : T > 24 ? 24 : T; S = S < 0 ? 0 : S > 30 ? 30 : S;
        let gdb = atk * T + sus * S;
        gdb = gdb < -30 ? -30 : gdb > 12 ? 12 : gdb;
        gs += (Math.exp(gdb * DRV_LN) - gs) * gc;
        L[i] = DRV_soft(ol + bl * gs); R[i] = DRV_soft(or + br * gs);
      }
      this.pw = pw; this.e2 = e2; this.e3 = e3; this.gs = gs;
    }
  });
})();
