// ============================================================================
// DEBACLE — SPECTRAL bank  (src/dsp/fx-spectral.js)
//   smear · sieve · spectra · contrast · separate · specdelay · magnet ·
//   fwarp · snapshot · formshift · codec
//
// Every effect runs on the shared lib STFT (Hann analysis + synthesis,
// overlap 4, latency N). Effects with a SIZE param pad smaller FFT sizes up to
// their static latency; a 4K size raises the latency to N, which every instance
// reports in this.latency (static maxLatency = 4096) so the host's dry
// compensation follows. Everything lives inside one IIFE; helper names carry an
// SPX_ prefix for readability only.
// ============================================================================
(() => {
  'use strict';

  const SPX_HP = Math.PI / 2;                 // phase advance per hop of bin 1 (overlap 4)
  const SPX_DB2LN = Math.LN10 / 20;           // dB -> ln(amplitude)
  const SPX_SIZES = ['512', '1K', '2K', '4K'];
  const SPX_coef = (sec, hop, sr) => (sec <= 1e-6 ? 1 : 1 - Math.exp(-hop / (sec * sr)));
  const SPX_lg = (db) => (db <= -59.5 ? 0 : Math.exp(db * SPX_DB2LN)); // layer gain, -60 dB = off
  const SPX_sstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  function SPX_lerpA(a, x, B) {
    if (x < 0) return 0;
    const i = x | 0, f = x - i;
    if (i + 1 < B) return a[i] + (a[i + 1] - a[i]) * f;
    return i < B ? a[i] * (1 - f) : 0;
  }
  // soft safety limiter above |1.5| (never reached in normal operation)
  function SPX_safe(x) {
    const s = x < 0 ? -1 : 1, a = x * s;
    return s * (1.5 + 2.5 * fastTanh((a - 1.5) / 2.5));
  }
  // zero every typed array (and arrays of typed arrays) directly inside o
  function SPX_zero(o) {
    if (!o) return;
    for (const k in o) {
      const v = o[k];
      if (v && v.BYTES_PER_ELEMENT) v.fill(0);
      else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) { const a = v[i]; if (a && a.BYTES_PER_ELEMENT) a.fill(0); }
    }
  }
  // fast log2 (quadratic mantissa fit, |err| < 0.005) for per-bin dB scoring
  const SPX_FB = new Float32Array(1), SPX_IB = new Int32Array(SPX_FB.buffer);
  function SPX_log2(x) {
    SPX_FB[0] = x;
    const i = SPX_IB[0], m = (i & 0x7fffff) * 1.1920928955078125e-7;
    return ((i >> 23) & 255) - 127 + m * (1.3465 - 0.3465 * m);
  }
  // dB -> linear gain table, -72..+36 dB in 0.05 dB steps
  const SPX_DBT = (() => { const t = new Float32Array(2161); for (let i = 0; i <= 2160; i++) t[i] = Math.pow(10, (i * 0.05 - 72) / 20); return t; })();
  const SPX_dbg = (db) => SPX_DBT[db <= -72 ? 0 : db >= 36 ? 2160 : ((db + 72) * 20 + 0.5) | 0];
  // random unit phasors: SPX_RT[2i], SPX_RT[2i+1] = cos/sin of angle (2i/1023 - 1)·π
  const SPX_RT = (() => { const t = new Float32Array(2048); for (let i = 0; i < 1024; i++) { const a = (i / 1023 * 2 - 1) * Math.PI; t[2 * i] = Math.cos(a); t[2 * i + 1] = Math.sin(a); } return t; })();
  // index into SPX_RT for a random angle of ±amt·π (amt 0..1)
  const SPX_ri = (rng, amt) => (((amt * rng.bi() * 0.5 + 0.5) * 1023 + 0.5) | 0) << 1;
  // nearest member note in O(1) from a 12-entry absolute pitch-class mask
  class SPX_Near {
    constructor() { this.dn = new Int8Array(12); this.up = new Int8Array(12); this.any = false; }
    set(mask) {
      this.any = false;
      for (let i = 0; i < 12; i++) if (mask[i]) this.any = true;
      for (let pc = 0; pc < 12; pc++) {
        let d = 0; while (d < 12 && !mask[(pc - d + 12) % 12]) d++; this.dn[pc] = d;
        d = 0; while (d < 12 && !mask[(pc + d) % 12]) d++; this.up[pc] = d;
      }
    }
    near(m) {
      if (!this.any) return Math.round(m);
      const f = Math.floor(m), pc = ((f % 12) + 12) % 12;
      const lo = f - this.dn[pc], hi = f + 1 + this.up[pc === 11 ? 0 : pc + 1];
      return m - lo <= hi - m ? lo : hi;
    }
  }
  // number-sieve tables
  const SPX_MAXH = 8192;
  const SPX_TAB = (() => {
    const prime = new Uint8Array(SPX_MAXH), fib = new Uint8Array(SPX_MAXH), pow2 = new Uint8Array(SPX_MAXH);
    for (let i = 2; i < SPX_MAXH; i++) prime[i] = 1;
    for (let i = 2; i * i < SPX_MAXH; i++) if (prime[i]) for (let j = i * i; j < SPX_MAXH; j += i) prime[j] = 0;
    let a = 1, b = 2; fib[1] = 1;
    while (b < SPX_MAXH) { fib[b] = 1; const c = a + b; a = b; b = c; }
    for (let v = 1; v < SPX_MAXH; v <<= 1) pow2[v] = 1;
    return { prime, fib, pow2 };
  })();
  const SPX_PROG = [0, 5, 3, 4, 0, 2, 5, 6]; // KEY sieve: triad degrees per step

  // ==========================================================================
  // Base class: STFT management, lazy SIZE switching, latency padding,
  // frame-time → ppq, stereo-linked auto gain.
  // ==========================================================================
  class SPX_Base extends FX {
    static maxLatency = 4096; // SIZE 4K; this.latency holds the current value
    init() {
      const C = this.constructor;
      this.L = C.latency | 0;
      this._slots = Object.create(null);
      this.N = 0; this.B = 0; this.hop = 0; this.stft = null; this.st = null;
      this._fc = 0; this._first = 0; this._ppq0 = 0; this._spb = this.sr / 2;
      this.ctx = null; this.p = null;
      this._cb = (re, im, ch, N) => { this.frame(re, im, ch, N); if (ch === 1) this._fc++; };
      this._pad0 = new Float32Array(8192); this._pad1 = new Float32Array(8192); this._pw = 0;
      this._dc0 = 0; this._dc1 = 0; this._last0 = 0; this._last1 = 0;
      if (C.hasSize) { // input history + scratch to prime a newly selected FFT size
        this._h0 = new Float32Array(8192); this._h1 = new Float32Array(8192); this._hw = 0; this._hn = 0;
        this._s0 = new Float32Array(8192); this._s1 = new Float32Array(8192);
      }
      this.rng = new Rng((0x9E3779B9 ^ (C.id.charCodeAt(0) * 7919 + C.id.length * 104729)) >>> 0);
      this.agcG = 1; this._Ei = 0; this._Eo = 0; this._ei = 0; this._eo = 0;
      this.agcT = [0.25, 0.25, 0.03, 0]; // energy averaging, gain-up, gain-down times (s); [3]=1: fast-rise envelopes
      this.setup();
      // every FFT size is built here, so changing SIZE never allocates inside the audio callback
      if (C.hasSize) for (let k = 0; k < 4; k++) { const M = 512 << k; if (!this._slots[M]) { const s = this._slots[M] = { stft: new STFT(M, 4), st: null }; s.st = this.alloc(M); } }
      this._use(this.L);
    }
    setup() {}
    alloc() { return {}; }
    onClear() {}
    block() {}
    frame() {}
    _use(N) {
      this.N = N; this.B = N / 2 + 1; this.hop = N / 4;
      this.latency = Math.max(this.L, N);
      let s = this._slots[N];
      if (!s) { s = this._slots[N] = { stft: new STFT(N, 4), st: null }; s.st = this.alloc(N); }
      this.stft = s.stft; this.st = s.st;
      const T = this.agcT;
      this._agcA = SPX_coef(T[0], this.hop, this.sr); this._agcU = SPX_coef(T[1], this.hop, this.sr); this._agcD = SPX_coef(T[2], this.hop, this.sr);
      this.stft.reset(); this.clear();
      this._pad0.fill(0); this._pad1.fill(0);
    }
    clear() { SPX_zero(this.st); this.agcG = 1; this._Ei = this._Eo = 0; this.onClear(); }
    reset() {
      this.stft.reset(); this.clear();
      this._pad0.fill(0); this._pad1.fill(0); this._pw = 0;
      this._dc0 = this._dc1 = this._last0 = this._last1 = 0;
      if (this._h0) { this._h0.fill(0); this._h1.fill(0); this._hw = 0; this._hn = 0; }
    }
    // After a SIZE change: run the recent input history through the new STFT so its
    // overlap-add is complete and the latency pad holds time-aligned output → no gap.
    _prime(p, ctx, n) {
      const N = this.N, pad = this.L - N, P = Math.min((pad > 0 ? pad : 0) + 2 * N, this._hn - n, 8192 - n);
      if (P < N) return;
      const h0 = this._h0, h1 = this._h1, a = this._s0, b = this._s1, base = this._hw - n - P;
      for (let j = 0; j < P; j++) { const r = (base + j) & 8191; a[j] = h0[r]; b[j] = h1[r]; }
      this._ppq0 = (ctx.ppq || 0) - P / this._spb; this._first = N - this.stft.rover - 1; this._fc = 0;
      this.block(p, ctx, P);
      this.stft.process(a, b, P, this._cb);
      if (pad > 0) {
        const q0 = this._pad0, q1 = this._pad1, w = this._pw - P;
        for (let j = 0; j < P; j++) { const r = (w + j) & 8191; q0[r] = a[j]; q1[r] = b[j]; }
      }
    }
    // musical position (quarter notes) of the centre of the frame being processed
    framePPQ() { return this._ppq0 + (this._first + this._fc * this.hop + 1 - this.N * 0.5) / this._spb; }
    // stereo-linked auto gain: keeps wet energy near input energy within [gmin, gmax].
    // Energies snap on signal start; gain falls fast and rises slowly (no overshoot).
    agc(re, im, ch, ein, gmin, gmax) {
      const B = this.B; let eo = 0;
      for (let k = 0; k < B; k++) eo += re[k] * re[k] + im[k] * im[k];
      const g = this.agcG;
      if (g !== 1) for (let k = 0; k < B; k++) { re[k] *= g; im[k] *= g; }
      if (ch === 0) { this._ei = ein; this._eo = eo; return; }
      const a = this._agcA, fl = 1e-7 * this.N * this.N, ei2 = this._ei + ein, eo2 = this._eo + eo;
      if (this._Ei <= fl && ei2 > fl) { this._Ei = ei2; this._Eo = eo2; }
      else if (this.agcT[3]) {
        this._Ei += (ei2 - this._Ei) * (ei2 > this._Ei ? 0.5 : a); this._Eo += (eo2 - this._Eo) * (eo2 > this._Eo ? 0.5 : a);
      } else { this._Ei += (ei2 - this._Ei) * a; this._Eo += (eo2 - this._Eo) * a; }
      let t = Math.sqrt((this._Ei + fl) / (this._Eo + fl));
      t = t < gmin ? gmin : t > gmax ? gmax : t;
      this.agcG = g + (t - g) * (t < g ? this._agcD : this._agcU);
    }
    process(L, R, n, p, ctx) {
      this.p = p; this.ctx = ctx;
      this._spb = ctx.spb > 1 ? ctx.spb : this.sr / 2;
      let sw = false;
      if (this.constructor.hasSize) {
        const h0 = this._h0, h1 = this._h1; let hw = this._hw;
        for (let i = 0; i < n; i++) { h0[hw] = L[i]; h1[hw] = R[i]; hw = (hw + 1) & 8191; }
        this._hw = hw; if (this._hn < 8192) this._hn += n;
        const want = 512 << clamp(p.size | 0, 0, 3);
        if (want !== this.N) { this._use(want); this._prime(p, ctx, n); sw = true; }
      }
      this._ppq0 = ctx.ppq || 0;
      this._first = this.N - this.stft.rover - 1; this._fc = 0;
      this.block(p, ctx, n);
      this.stft.process(L, R, n, this._cb);
      const pad = this.L - this.N;
      if (pad > 0) {
        const a = this._pad0, b = this._pad1; let w = this._pw;
        for (let i = 0; i < n; i++) {
          a[w] = L[i]; b[w] = R[i];
          const r = (w - pad) & 8191;
          L[i] = a[r]; R[i] = b[r];
          w = (w + 1) & 8191;
        }
        this._pw = w;
      }
      if (sw) { this._dc0 = this._last0 - L[0]; this._dc1 = this._last1 - R[0]; } // continuity across the switch
      let d0 = this._dc0, d1 = this._dc1;
      for (let i = 0; i < n; i++) {
        let x = L[i] + d0, y = R[i] + d1;
        d0 *= 0.992; d1 *= 0.992;
        if (x > 1.5 || x < -1.5) x = SPX_safe(x);
        if (y > 1.5 || y < -1.5) y = SPX_safe(y);
        L[i] = x; R[i] = y;
      }
      this._dc0 = (d0 > 1e-7 || d0 < -1e-7) ? d0 : 0;
      this._dc1 = (d1 > 1e-7 || d1 < -1e-7) ? d1 : 0;
      this._last0 = L[n - 1]; this._last1 = R[n - 1];
    }
  }

  // ==========================================================================
  // Peak-region phase vocoder (Laroche–Dolson style): finds spectral peaks,
  // estimates their true frequency from the inter-frame phase advance, and moves
  // each peak's region of influence rigidly to a new frequency with a running
  // phase rotation, which keeps partials coherent. Per-channel state.
  // ==========================================================================
  class SPX_PV {
    constructor(N) {
      const B = N / 2 + 1, H = (B >> 1) + 2;
      this.N = N; this.B = B; this.kf = 2 / Math.PI; // dev (rad/hop) -> bins, overlap 4
      this.pRe = [new Float32Array(B), new Float32Array(B)];
      this.pIm = [new Float32Array(B), new Float32Array(B)];
      this.th = [new Float64Array(B), new Float64Array(B)];
      this.sh = [new Float32Array(B), new Float32Array(B)];
      this.thT = new Float64Array(B); this.shT = new Float32Array(B);
      this.pw = new Float32Array(B);
      this.pk = new Int32Array(H); this.lo = new Int32Array(H); this.hi = new Int32Array(H);
      this.fq = new Float32Array(H); this.tg = new Float32Array(H); this.gn = new Float32Array(H);
      this.np = 0;
      this.oRe = new Float32Array(B); this.oIm = new Float32Array(B);
    }
    clear() {
      for (let c = 0; c < 2; c++) { this.pRe[c].fill(0); this.pIm[c].fill(0); this.th[c].fill(0); this.sh[c].fill(0); }
      this.np = 0;
    }
    storePrev(re, im, ch) {
      const a = this.pRe[ch], b = this.pIm[ch], B = this.B;
      for (let k = 0; k < B; k++) { a[k] = re[k]; b[k] = im[k]; }
    }
    // peaks + regions + true frequency (bins). Stores (sRe,sIm || re,im) as previous frame.
    analyze(re, im, ch, floorRel, sRe, sIm) {
      const B = this.B, pw = this.pw, pk = this.pk;
      let mx = 0;
      for (let k = 0; k < B; k++) { const v = re[k] * re[k] + im[k] * im[k]; pw[k] = v; if (v > mx) mx = v; }
      const thr = Math.max(mx * floorRel, 1e-13 * this.N * this.N);
      let np = 0;
      for (let k = 2; k < B - 2; k++) {
        const v = pw[k];
        if (v > thr && v > pw[k - 1] && v >= pw[k + 1] && v > pw[k - 2] && v >= pw[k + 2]) pk[np++] = k;
      }
      this.np = np;
      if (np) {
        const lo = this.lo, hi = this.hi, fq = this.fq, pRe = this.pRe[ch], pIm = this.pIm[ch], kf = this.kf;
        lo[0] = 1;
        for (let i = 0; i < np - 1; i++) {
          let t = pk[i] + 1, m = pw[t];
          for (let k = t + 1; k < pk[i + 1]; k++) if (pw[k] < m) { m = pw[k]; t = k; }
          hi[i] = t; lo[i + 1] = t + 1;
        }
        hi[np - 1] = B - 2;
        for (let i = 0; i < np; i++) {
          const k = pk[i], a = re[k], b = im[k], c = pRe[k], d = pIm[k];
          let dev = Math.atan2(b * c - a * d, a * c + b * d) - k * SPX_HP;
          dev -= TAU * Math.round(dev / TAU);
          fq[i] = k + dev * kf;
        }
      }
      this.storePrev(sRe || re, sIm || im, ch);
      return np;
    }
    // move each region by tg[i] octaves (glided per region), gain gn[i]; focus attenuates region skirts.
    render(re, im, ch, glide, focus) {
      const B = this.B, np = this.np;
      if (!np) return;
      const th = this.th[ch], sh = this.sh[ch], thT = this.thT, shT = this.shT, oRe = this.oRe, oIm = this.oIm;
      const pk = this.pk, lo = this.lo, hi = this.hi, fq = this.fq, tg = this.tg, gn = this.gn;
      thT.set(th); shT.set(sh); oRe.fill(0); oIm.fill(0);
      for (let i = 0; i < np; i++) {
        const p = pk[i];
        let s = sh[p]; s += (tg[i] - s) * glide;
        const D = fq[i] * (Math.exp(s * Math.LN2) - 1), si = Math.round(D);
        let t = th[p] + D * SPX_HP; t -= TAU * Math.round(t / TAU);
        const g = gn[i], cs = Math.cos(t) * g, sn = Math.sin(t) * g;
        const l = lo[i], h = hi[i];
        for (let k = l; k <= h; k++) {
          thT[k] = t; shT[k] = s;
          if (g === 0) continue;
          const j = k + si;
          if (j < 1 || j >= B - 1) continue;
          let a = re[k], b = im[k];
          if (focus > 0) {
            const d = k > p ? k - p : p - k;
            if (d > 1) { const w = 1 - focus * (d >= 4 ? 1 : (d - 1) / 3); a *= w; b *= w; }
          }
          oRe[j] += a * cs - b * sn; oIm[j] += a * sn + b * cs;
        }
      }
      this.th[ch] = thT; this.thT = th; this.sh[ch] = shT; this.shT = sh;
      for (let k = 1; k < B - 1; k++) { re[k] = oRe[k]; im[k] = oIm[k]; }
      re[B - 1] = 0; im[B - 1] = 0;
    }
  }

  // ==========================================================================
  // 1. SMEAR — spectral blur
  // ==========================================================================
  registerFX(class extends SPX_Base {
    static id = 'smear';
    static label = 'SMEAR';
    static cat = 'SPECTRAL';
    static desc = 'Spectral blur: smears every bin in time, drifts energy up or down the spectrum, diffuses phase into a cloud and can hold the spectrum per beat division.';
    static latency = 2048;
    static hasSize = true;
    static params = [
      { id: 'smear', label: 'SMEAR', min: 0, max: 100, def: 45, unit: '%' },
      { id: 'diff', label: 'DIFF', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'fb', label: 'FB', min: 0, max: 100, def: 25, unit: '%' },
      { id: 'tilt', label: 'TILT', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
      { id: 'dir', label: 'DIRECTION', options: ['BOTH', 'UP', 'DOWN'], def: 0 },
      { id: 'spread', label: 'SPREAD', min: 0, max: 100, def: 20, unit: '%' },
      { id: 'hold', label: 'HOLD', toggle: true, def: 0 },
      { id: 'hrate', label: 'HOLD RATE', div: ['1/1', '1/32'], def: '1/4' },
      { id: 'size', label: 'SIZE', options: SPX_SIZES, def: 2 },
    ];
    setup() { this.agcT = [0.5, 1.0, 0.04, 1]; this._k = new Float64Array(4).fill(NaN); this.hb = 0; this.hStep = NaN; this.hCap = false; this.hFirst = false; }
    alloc(N) {
      const B = N / 2 + 1, sr = this.sr, F = () => new Float32Array(B);
      const u = new Float32Array(B);
      for (let k = 0; k < B; k++) u[k] = clamp(Math.log2(Math.max(20, k * sr / N) / 630) / 5, -1, 1);
      return {
        S: [F(), F()], Pr: [F(), F()], Pi: [F(), F()], Ur: [F(), F()], Ui: [F(), F()], Rr: [F(), F()], Ri: [F(), F()],
        H: [F(), F()], HUr: [F(), F()], HUi: [F(), F()], HRr: [F(), F()], HRi: [F(), F()], Ho: [F(), F()],
        tmp: F(), aA: F(), aR: F(), t: { u },
      };
    }
    onClear() { this._k[0] = NaN; this.hb = 0; this.hStep = NaN; this.hCap = false; }
    block(p) {
      const sm = p.smear / 100, tl = p.tilt / 100, fb = p.fb / 100, k = this._k;
      if (k[0] !== sm || k[1] !== tl || k[2] !== fb || k[3] !== this.N) {
        k[0] = sm; k[1] = tl; k[2] = fb; k[3] = this.N;
        const st = this.st, u = st.t.u, B = this.B, hop = this.hop, sr = this.sr;
        const tau = 3.5 * sm * sm, tauF = 2 * fb / (1.02 - fb);
        for (let i = 0; i < B; i++) {
          const tk = tau * Math.pow(4, tl * u[i]);
          st.aA[i] = SPX_coef(tk, hop, sr);
          st.aR[i] = SPX_coef(Math.max(tk, tauF), hop, sr);
        }
      }
      this.diff = p.diff / 100;
      this.dir = p.dir | 0;
      this.rho = Math.pow(2, (p.spread / 100) * 1.5 * this.hop / this.sr); // up to 1.5 oct/s
      this.holdOn = p.hold >= 0.5;
      this.hrate = Math.max(1 / 128, p.hrate);
    }
    frame(re, im, ch) {
      const st = this.st, B = this.B, S = st.S[ch], Pr = st.Pr[ch], Pi = st.Pi[ch], Ur = st.Ur[ch], Ui = st.Ui[ch], Rr = st.Rr[ch], Ri = st.Ri[ch];
      const aA = st.aA, aR = st.aR, tmp = st.tmp, rng = this.rng, dz = this.diff, RT = SPX_RT;
      const rho = this.rho;
      if (rho > 1.000001) {
        const dir = this.dir, ir = 1 / rho;
        for (let k = 0; k < B; k++) {
          tmp[k] = dir === 1 ? SPX_lerpA(S, k * ir, B)
            : dir === 2 ? SPX_lerpA(S, k * rho, B)
              : 0.5 * (SPX_lerpA(S, k * ir, B) + SPX_lerpA(S, k * rho, B));
        }
      } else tmp.set(S);
      if (ch === 0) {
        const want = this.holdOn ? 1 : 0;
        let hb = this.hb + (want - this.hb) * 0.35;
        if (Math.abs(want - hb) < 1e-3) hb = want;
        if (this.holdOn) {
          const step = Math.floor(this.framePPQ() / this.hrate);
          this.hCap = step !== this.hStep; this.hStep = step;
          if (this.hCap) this.hFirst = this.hb === 0;
        } else { this.hCap = false; this.hStep = NaN; }
        this.hb = hb;
      }
      const hb = this.hb, useH = hb > 0, cap = this.hCap, first = this.hFirst;
      const H = st.H[ch], HUr = st.HUr[ch], HUi = st.HUi[ch], HRr = st.HRr[ch], HRi = st.HRi[ch], Ho = st.Ho[ch];
      let ein = 0;
      for (let k = 0; k < B; k++) {
        const a = re[k], b = im[k], pw = a * a + b * b; ein += pw;
        const X = Math.sqrt(pw);
        let ur = 1, ui = 0;
        if (X > 1e-12) { const iX = 1 / X; ur = a * iX; ui = b * iX; }
        // rotation since previous frame = u · conj(prev)
        const pr = Pr[k], pi = Pi[k], rr = ur * pr + ui * pi, ri = ui * pr - ur * pi;
        Pr[k] = ur; Pi[k] = ui;
        const s0 = tmp[k], s = s0 + (X - s0) * (X > s0 ? aA[k] : aR[k]);
        S[k] = s;
        let or, oi;
        if (X >= 0.8 * s) { or = ur; oi = ui; Rr[k] = rr; Ri[k] = ri; }
        else {
          const qr = Ur[k], qi = Ui[k], xr = Rr[k], xi = Ri[k];
          or = qr * xr - qi * xi; oi = qr * xi + qi * xr;
          const n = or * or + oi * oi;
          if (n < 0.25) { or = ur; oi = ui; } else { const g = (3 - n) * 0.5; or *= g; oi *= g; }
        }
        Ur[k] = or; Ui[k] = oi;
        if (dz > 0) { const j = SPX_ri(rng, dz), cr = RT[j], ci = RT[j + 1], t = or * cr - oi * ci; oi = or * ci + oi * cr; or = t; }
        let oR = s * or, oI = s * oi;
        if (useH) {
          if (cap) { H[k] = s; HRr[k] = Rr[k]; HRi[k] = Ri[k]; if (first) { HUr[k] = Ur[k]; HUi[k] = Ui[k]; Ho[k] = s; } }
          const qr = HUr[k], qi = HUi[k], xr = HRr[k], xi = HRi[k];
          let hr = qr * xr - qi * xi, hi = qr * xi + qi * xr;
          const n = hr * hr + hi * hi;
          if (n < 0.25) { hr = 1; hi = 0; } else { const g = (3 - n) * 0.5; hr *= g; hi *= g; }
          HUr[k] = hr; HUi[k] = hi;
          if (dz > 0) { const j = SPX_ri(rng, dz), cr = RT[j], ci = RT[j + 1], t = hr * cr - hi * ci; hi = hr * ci + hi * cr; hr = t; }
          const hm = (Ho[k] += (H[k] - Ho[k]) * 0.5);
          oR = oR * (1 - hb) + hb * hm * hr;
          oI = oI * (1 - hb) + hb * hm * hi;
        }
        re[k] = oR; im[k] = oI;
      }
      this.agc(re, im, ch, ein, 0.5, 2.5);
    }
  });

  // ==========================================================================
  // 2. SIEVE — rhythmic number-sieve spectral gate
  // ==========================================================================
  registerFX(class extends SPX_Base {
    static id = 'sieve';
    static label = 'SIEVE';
    static cat = 'SPECTRAL';
    static desc = 'Rhythmic spectral gate: a number sieve (primes, Fibonacci, powers of two, odd/even or key/chord tones) opens harmonic slots and steps through its pattern on the beat grid.';
    static latency = 2048;
    static hasSize = true;
    static params = [
      { id: 'pattern', label: 'PATTERN', options: ['PRIME', 'FIB', 'POW2', 'ODD', 'EVEN', 'KEY', 'CHORD'], def: 0 },
      { id: 'ratio', label: 'RATIO', min: 0.5, max: 8, def: 2, curve: 'exp', unit: '×' },
      { id: 'rate', label: 'RATE', div: ['1/1', '1/32'], def: '1/8' },
      { id: 'depth', label: 'DEPTH', min: 0, max: 100, def: 100, unit: '%' },
      { id: 'smooth', label: 'SMOOTH', min: 0, max: 100, def: 25, unit: '%' },
      { id: 'steps', label: 'STEPS', min: 1, max: 16, def: 8, curve: 'int' },
      { id: 'size', label: 'SIZE', options: SPX_SIZES, def: 2 },
    ];
    setup() { this.mk = 1; this.mkS = 1; this.pcm = new Uint8Array(12); this.near = new SPX_Near(); this.cKey = new Float64Array(5).fill(NaN); this.cIv = null; this.cCh = null; this.cR = -1; this.dirty = true; }
    alloc(N) { const B = N / 2 + 1; return { T: new Float32Array(B), G: [new Float32Array(B), new Float32Array(B)] }; }
    onClear() { this.cR = -1; this.dirty = true; this.mkS = this.mk; }
    block(p, ctx) {
      const key = ctx.key, pat = p.pattern | 0, ratio = p.ratio, sm = p.smooth / 100, c = this.cKey;
      if (c[0] !== pat || c[1] !== ratio || c[2] !== sm || c[3] !== key.root || c[4] !== this.N || this.cIv !== key.intervals || this.cCh !== key.chord) {
        c[0] = pat; c[1] = ratio; c[2] = sm; c[3] = key.root; c[4] = this.N; this.cIv = key.intervals; this.cCh = key.chord;
        this.dirty = true;
      }
      this.steps = Math.max(1, Math.round(p.steps));
      this.rate = Math.max(1 / 128, p.rate);
      this.depth = p.depth / 100;
      this.gc = SPX_coef(0.004 + 0.35 * sm * sm, this.hop, this.sr);
    }
    target(r) {
      const T = this.st.T, B = this.B, binHz = this.sr / this.N, key = this.ctx.key, c = this.cKey;
      const pat = c[0], ratio = c[1], sm = c[2];
      if (pat <= 4) {
        const f0 = mtof(24 + key.root) * ratio, hw = 0.5 - 0.25 * sm, ew = 0.02 + 0.23 * sm;
        const tab = pat === 0 ? SPX_TAB.prime : pat === 1 ? SPX_TAB.fib : SPX_TAB.pow2, mod = 2 + (r % 4);
        for (let k = 0; k < B; k++) {
          const h = k * binHz / f0, n = Math.round(h), d = Math.abs(h - n);
          let mem = false;
          if (n >= 1) {
            if (pat <= 2) { const idx = n + r; mem = idx < SPX_MAXH && tab[idx] === 1; }
            else if (pat === 3) mem = n % mod === 1;
            else mem = n % mod === 0;
          }
          T[k] = mem ? clamp((hw - d) / ew + 0.5, 0, 1) : 0;
        }
      } else {
        const mask = this.pcm; mask.fill(0);
        if (pat === 5) {
          const d = SPX_PROG[r % 8];
          for (let j = 0; j <= 4; j += 2) mask[(key.root + key.degreeSemis(d + j)) % 12] = 1;
        } else {
          const cs = key.chord, Lc = cs.length, P = Lc > 1 ? 2 * Lc - 2 : 1, i = r % P, t = i < Lc ? i : P - i;
          mask[(key.root + cs[t]) % 12] = 1;
        }
        const tol = 0.08 * ratio, nr = this.near; nr.set(mask);
        for (let k = 0; k < B; k++) {
          const f = Math.max(k, 0.5) * binHz, m = ftom(f);
          const dist = Math.abs(nr.near(m) - m);
          const te = Math.max(tol, 8.66 * binHz / f), ew = te * (0.15 + 0.85 * sm) + 1e-3;
          T[k] = clamp((te - dist) / ew + 0.5, 0, 1);
        }
      }
      // partial makeup gain from the pass fraction under a pink (1/f) weighting, 40 Hz..16 kHz, ≤ +6 dB
      let num = 0, den = 0;
      const k0 = Math.max(1, Math.round(40 / binHz)), k1 = Math.min(B - 1, Math.round(16000 / binHz));
      for (let k = k0; k <= k1; k++) { const w = 1 / k; num += T[k] * T[k] * w; den += w; }
      this.mk = clamp(Math.pow(den / Math.max(num, 1e-9), 0.35), 1, 2);
    }
    frame(re, im, ch) {
      const st = this.st, B = this.B;
      if (ch === 0) {
        const steps = this.steps, step = Math.floor(this.framePPQ() / this.rate), r = ((step % steps) + steps) % steps;
        if (r !== this.cR || this.dirty) { this.cR = r; this.dirty = false; this.target(r); }
      }
      const T = st.T, G = st.G[ch], c = this.gc, dep = this.depth, base = 1 - dep;
      if (ch === 0) this.mkS += (1 + dep * (this.mk - 1) - this.mkS) * c;
      const mk = this.mkS;
      for (let k = 0; k < B; k++) {
        const g = (G[k] += (T[k] - G[k]) * c), m = (base + dep * g) * mk;
        re[k] *= m; im[k] *= m;
      }
    }
  });

  // ==========================================================================
  // 3. SPECTRA — spectral shaping (bell + tilt + band warp + gate, scanning)
  // ==========================================================================
  registerFX(class extends SPX_Base {
    static id = 'spectra';
    static label = 'SPECTRA';
    static cat = 'SPECTRAL';
    static desc = 'FFT spectral shaper: a log-frequency bell with tilt, an in-band frequency warp and a spectral gate, with a tempo-synced centre sweep.';
    static latency = 2048;
    static params = [
      { id: 'center', label: 'CENTER', min: 40, max: 16000, def: 900, curve: 'exp', unit: 'Hz' },
      { id: 'bgain', label: 'BAND GAIN', min: -30, max: 18, def: 12, unit: 'dB', bipolar: true },
      { id: 'width', label: 'WIDTH', min: 0.2, max: 8, def: 1.2, curve: 'exp' },
      { id: 'tilt', label: 'TILT', min: -6, max: 6, def: 0, unit: 'dB', bipolar: true },
      { id: 'warp', label: 'WARP', min: -12, max: 12, def: 0, unit: 'st', bipolar: true },
      { id: 'gate', label: 'GATE', min: -90, max: 0, def: -90, unit: 'dB' },
      { id: 'scan', label: 'SCAN', toggle: true, def: 1 },
      { id: 'srate', label: 'SCAN RATE', div: ['4/1', '1/8'], def: '1/1' },
      { id: 'sdepth', label: 'SCAN DPTH', min: 0, max: 4, def: 2 },
    ];
    alloc(N) {
      const B = N / 2 + 1, lf = new Float32Array(B), sr = this.sr;
      for (let k = 0; k < B; k++) lf[k] = Math.log2(Math.max(0.5, k) * sr / N);
      return { g: new Float32Array(B), GG: [new Float32Array(B), new Float32Array(B)], pv: new SPX_PV(N), t: { lf } };
    }
    onClear() { this.st.pv.clear(); }
    block(p) {
      this.center = p.center; this.gain = p.bgain; this.sig = Math.max(0.05, p.width / 2.355);
      this.tilt = p.tilt; this.warp = p.warp / 12; this.gateOn = p.gate > -89.5;
      this.thr = Math.pow(10, p.gate / 20) * this.N * 0.25;
      this.scan = p.scan >= 0.5; this.srate = Math.max(1 / 32, p.srate); this.sdepth = p.sdepth;
    }
    curve() {
      let c = this.center;
      if (this.scan) c *= Math.pow(2, this.sdepth * Math.sin(TAU * (this.framePPQ() / this.srate)));
      c = clamp(c, 25, 20000);
      this.lc = Math.log2(c);
      const g = this.st.g, lf = this.st.t.lf, B = this.B, lc = this.lc, is2 = 0.5 / (this.sig * this.sig), gain = this.gain, tilt = this.tilt;
      for (let k = 0; k < B; k++) {
        const d = lf[k] - lc, dt = lf[k] - 9.9658, e = d * d * is2; // tilt pivots at 1 kHz
        let db = (e < 12 ? gain * Math.exp(-e) : 0) + tilt * (dt < -5.5 ? -5.5 : dt > 4.5 ? 4.5 : dt);
        db = db < -60 ? -60 : db > 24 ? 24 : db;
        g[k] = SPX_dbg(db);
      }
    }
    frame(re, im, ch) {
      const st = this.st, B = this.B, pv = st.pv;
      if (ch === 0) this.curve();
      let ein = 0;
      for (let k = 0; k < B; k++) ein += re[k] * re[k] + im[k] * im[k];
      if (this.warp > 0.001 || this.warp < -0.001) {
        const np = pv.analyze(re, im, ch, 1e-7), binHz = this.sr / this.N, lc = this.lc, is2 = 0.5 / (this.sig * this.sig);
        for (let i = 0; i < np; i++) {
          const d = Math.log2(Math.max(1, pv.fq[i] * binHz)) - lc;
          pv.tg[i] = this.warp * Math.exp(-d * d * is2); pv.gn[i] = 1;
        }
        pv.render(re, im, ch, 1, 0);
      } else pv.storePrev(re, im, ch);
      const g = st.g;
      if (this.gateOn) {
        const GG = st.GG[ch], thr = this.thr, it = 1 / thr;
        for (let k = 0; k < B; k++) {
          const a = re[k], b = im[k], m = Math.sqrt(a * a + b * b);
          let t = m >= thr ? 1 : m * it; t = t * t;
          const v = (GG[k] += (t - GG[k]) * (t > GG[k] ? 0.7 : 0.25)) * g[k];
          re[k] = a * v; im[k] = b * v;
        }
      } else {
        for (let k = 0; k < B; k++) { const v = g[k]; re[k] *= v; im[k] *= v; }
      }
      this.agc(re, im, ch, ein, 0.05, 1);
    }
  });

  // ==========================================================================
  // 4. CONTRAST — spectral dynamics by partial rank
  // ==========================================================================
  registerFX(class extends SPX_Base {
    static id = 'contrast';
    static label = 'CONTRAST';
    static cat = 'SPECTRAL';
    static desc = 'Spectral dynamics: ranks every bin against its neighbourhood and sets separate gains for strong, medium and weak partials, with a sustain hold for the strong ones.';
    static latency = 2048;
    static params = [
      { id: 'strong', label: 'STRONG', min: -24, max: 24, def: 9, unit: 'dB', bipolar: true },
      { id: 'medium', label: 'MEDIUM', min: -24, max: 24, def: 0, unit: 'dB', bipolar: true },
      { id: 'weak', label: 'WEAK', min: -48, max: 12, def: -18, unit: 'dB', bipolar: true },
      { id: 'low', label: 'LOW', min: 20, max: 20000, def: 60, curve: 'exp', unit: 'Hz' },
      { id: 'high', label: 'HIGH', min: 20, max: 20000, def: 14000, curve: 'exp', unit: 'Hz' },
      { id: 'sustain', label: 'SUSTAIN', min: 0, max: 100, def: 25, unit: '%' },
      { id: 'smooth', label: 'SMOOTH', min: 0, max: 100, def: 40, unit: '%' },
    ];
    setup() { this.hist = new Float64Array(66); this.cdf = new Float32Array(66); this.cR = new Float64Array(3).fill(NaN); }
    alloc(N) {
      const B = N / 2 + 1, F = () => new Float32Array(B);
      return {
        Ld: F(), sc: F(), cs: new Float64Array(B + 1), wr: F(), Gs: [F(), F()],
        Hd: [F(), F()], Pr: [F(), F()], Pi: [F(), F()], Ur: [F(), F()], Ui: [F(), F()], Rr: [F(), F()], Ri: [F(), F()],
      };
    }
    onClear() { this.cR[0] = NaN; }
    block(p) {
      let lo = p.low, hi = p.high; if (lo > hi) { const t = lo; lo = hi; hi = t; }
      const c = this.cR;
      if (c[0] !== lo || c[1] !== hi || c[2] !== this.N) {
        c[0] = lo; c[1] = hi; c[2] = this.N;
        const wr = this.st.wr, B = this.B, binHz = this.sr / this.N, llo = Math.log2(lo), lhi = Math.log2(hi);
        for (let k = 0; k < B; k++) {
          const lf = Math.log2(Math.max(0.5, k) * binHz);
          wr[k] = SPX_sstep((lf - llo) * 4 + 0.5) * SPX_sstep((lhi - lf) * 4 + 0.5);
        }
      }
      this.gs = p.strong; this.gm = p.medium; this.gw = p.weak;
      const sm = p.smooth / 100;
      this.sc = SPX_coef(0.003 + 0.25 * sm * sm, this.hop, this.sr);
      const sus = p.sustain / 100;
      this.sus = sus;
      this.dec = sus > 0 ? Math.exp(-this.hop / ((0.04 + 3 * sus * sus) * this.sr)) : 0;
      this.W = Math.max(2, this.N >> 8);
    }
    frame(re, im, ch) {
      const st = this.st, B = this.B, Ld = st.Ld, sc = st.sc, cs = st.cs, wr = st.wr, Gs = st.Gs[ch];
      const fl = 1e-13 * this.N * this.N;
      let ein = 0;
      cs[0] = 0;
      for (let k = 0; k < B; k++) {
        const a = re[k], b = im[k], v = a * a + b * b; ein += v;
        const d = SPX_log2(v + fl) * 3.0103; Ld[k] = d; cs[k + 1] = cs[k] + d;
      }
      // score vs local mean, histogram over the active range
      const W = this.W, hist = this.hist, cdf = this.cdf; hist.fill(0);
      let tot = 0;
      for (let k = 0; k < B; k++) {
        const a = k - W < 0 ? 0 : k - W, b = k + W + 1 > B ? B : k + W + 1;
        const s = Ld[k] - (cs[b] - cs[a]) / (b - a);
        sc[k] = s;
        if (wr[k] > 0.5) { let h = Math.floor((s + 36) / 1.125); h = h < 0 ? 0 : h > 63 ? 63 : h; hist[h]++; tot++; }
      }
      let run = 0; const it = tot > 0 ? 1 / tot : 0;
      for (let h = 0; h < 64; h++) { cdf[h] = (run + 0.5 * hist[h]) * it; run += hist[h]; }
      const gs = this.gs, gm = this.gm, gw = this.gw, c = this.sc, sus = this.sus;
      const Hd = st.Hd[ch], Pr = st.Pr[ch], Pi = st.Pi[ch], Ur = st.Ur[ch], Ui = st.Ui[ch], Rr = st.Rr[ch], Ri = st.Ri[ch], dec = this.dec;
      for (let k = 0; k < B; k++) {
        const s = sc[k];
        let h = Math.floor((s + 36) / 1.125); h = h < 0 ? 0 : h > 63 ? 63 : h;
        const x = s * 0.15, r = 0.5 * cdf[h] + 0.25 + 0.25 * x / (1 + (x < 0 ? -x : x));
        const g = (r < 0.5 ? gw + (gm - gw) * (r * 2) : gm + (gs - gm) * (r * 2 - 1)) * wr[k];
        const gv = (Gs[k] += (g - Gs[k]) * c);
        const lin = SPX_dbg(gv);
        const a = re[k], b = im[k];
        if (sus > 0) {
          const X = Math.sqrt(a * a + b * b);
          let ur = 1, ui = 0;
          if (X > 1e-12) { const iX = 1 / X; ur = a * iX; ui = b * iX; }
          const pr = Pr[k], pi = Pi[k], rr = ur * pr + ui * pi, ri = ui * pr - ur * pi;
          Pr[k] = ur; Pi[k] = ui;
          const mo = X * lin, ws = clamp((r - 0.6) * 4, 0, 1) * wr[k];
          let hd = Hd[k] * dec; const cand = ws * mo; if (cand > hd) hd = cand; Hd[k] = hd;
          if (hd > mo * 1.05) {
            const qr = Ur[k], qi = Ui[k], xr = Rr[k], xi = Ri[k];
            let or = qr * xr - qi * xi, oi = qr * xi + qi * xr;
            const n = or * or + oi * oi;
            if (n < 0.25) { or = ur; oi = ui; } else { const gg = (3 - n) * 0.5; or *= gg; oi *= gg; }
            Ur[k] = or; Ui[k] = oi;
            re[k] = hd * or; im[k] = hd * oi;
          } else {
            Ur[k] = ur; Ui[k] = ui; Rr[k] = rr; Ri[k] = ri;
            re[k] = a * lin; im[k] = b * lin;
          }
        } else { re[k] = a * lin; im[k] = b * lin; }
      }
      this.agc(re, im, ch, ein, 0.35, 2);
    }
  });

  // ==========================================================================
  // 5. SEPARATE — tonal / noise / hits separation
  // ==========================================================================
  registerFX(class extends SPX_Base {
    static id = 'separate';
    static label = 'SEPARATE';
    static cat = 'SPECTRAL';
    static desc = 'Splits the signal into tonal, noise and hit layers by spectral stability, with a gain for each layer, pitch-shift for the tonal layer and stereo spread for the noise.';
    static latency = 2048;
    static params = [
      { id: 'tonal', label: 'TONAL', min: -60, max: 6, def: 0, unit: 'dB', bipolar: true },
      { id: 'noise', label: 'NOISE', min: -60, max: 6, def: -12, unit: 'dB', bipolar: true },
      { id: 'hits', label: 'HITS', min: -60, max: 6, def: 3, unit: 'dB', bipolar: true },
      { id: 'pitch', label: 'PITCH', min: -12, max: 12, def: 0, unit: 'st', bipolar: true },
      { id: 'spread', label: 'SPREAD', min: 0, max: 100, def: 50, unit: '%' },
      { id: 'tight', label: 'TIGHT', min: 0, max: 100, def: 50, unit: '%' },
      { id: 'snap', label: 'SNAP', toggle: true, def: 1 },
    ];
    setup() { this.cSp = NaN; }
    alloc(N) {
      const B = N / 2 + 1, F = () => new Float32Array(B), rp = new Float32Array(B), rg = new Rng(0xA11CE);
      for (let k = 0; k < B; k++) rp[k] = rg.bi();
      return {
        Ld: F(), cs: new Float64Array(B + 1), H: [F(), F()], tR: F(), tI: F(), rc: F(), rs: F(),
        pv: new SPX_PV(N), t: { rp }, init: new Uint8Array(2),
      };
    }
    onClear() { this.st.pv.clear(); this.cSp = NaN; }
    block(p, ctx) {
      this.gT = SPX_lg(p.tonal); this.gN = SPX_lg(p.noise); this.gH = SPX_lg(p.hits);
      let pi = p.pitch;
      if (p.snap >= 0.5) pi = ctx.key.snapSemis(Math.round(pi));
      this.pitch = pi / 12;
      this.cH = SPX_coef(0.25 - 0.225 * (p.tight / 100), this.hop, this.sr);
      this.hT = 2 + 4 * (1 - p.tight / 100);
      const sp = p.spread / 100;
      if (sp !== this.cSp || this.st.rc.length !== this.B) {
        this.cSp = sp;
        const rc = this.st.rc, rs = this.st.rs, rp = this.st.t.rp, B = this.B;
        for (let k = 0; k < B; k++) { const a = sp * SPX_HP * rp[k]; rc[k] = Math.cos(a); rs[k] = Math.sin(a); }
      }
      this.W = Math.max(2, this.N >> 8);
    }
    frame(re, im, ch) {
      const st = this.st, B = this.B, Ld = st.Ld, cs = st.cs, H = st.H[ch], tR = st.tR, tI = st.tI;
      const fl = 1e-13 * this.N * this.N, cH = this.cH, W = this.W, hT = this.hT;
      cs[0] = 0;
      for (let k = 0; k < B; k++) { const v = re[k] * re[k] + im[k] * im[k], d = SPX_log2(v + fl) * 3.0103; Ld[k] = d; cs[k + 1] = cs[k] + d; }
      if (!st.init[ch]) { st.init[ch] = 1; for (let k = 0; k < B; k++) H[k] = Ld[k]; }
      const gT = this.gT, gN = this.gN, gH = this.gH, rc = st.rc, rs = st.rs, sgn = ch === 0 ? 1 : -1;
      const doPitch = this.pitch > 0.0005 || this.pitch < -0.0005;
      for (let k = 0; k < B; k++) {
        const a0 = k - W < 0 ? 0 : k - W, b0 = k + W + 1 > B ? B : k + W + 1;
        const P = (cs[b0] - cs[a0]) / (b0 - a0), L = Ld[k], h0 = H[k];
        const sT = (L < h0 ? L : h0) - P, sH = (L < P ? L : P) - h0;
        H[k] = h0 + (L - h0) * cH;
        let t = SPX_sstep((sT - 4) / 8), h = SPX_sstep((sH - hT) / 8);
        const u = t + h; if (u > 1) { t /= u; h /= u; }
        const n = 1 - t - h;
        const a = re[k], b = im[k];
        tR[k] = a * t; tI[k] = b * t;
        // noise: decorrelating per-bin phase rotation (opposite per channel)
        const c = rc[k], s = rs[k] * sgn, nr = (a * c - b * s) * n, ni = (a * s + b * c) * n;
        re[k] = gN * nr + gH * a * h; im[k] = gN * ni + gH * b * h;
      }
      const pv = st.pv;
      if (doPitch) {
        const np = pv.analyze(tR, tI, ch, 1e-6);
        for (let i = 0; i < np; i++) { pv.tg[i] = this.pitch; pv.gn[i] = 1; }
        pv.render(tR, tI, ch, 1, 0);
      } else pv.storePrev(tR, tI, ch);
      for (let k = 0; k < B; k++) { re[k] += gT * tR[k]; im[k] += gT * tI[k]; }
    }
  });

  // ==========================================================================
  // 6. SPECDELAY — per-bin delay with feedback, blur and pitch-shifted repeats
  // ==========================================================================
  registerFX(class extends SPX_Base {
    static id = 'specdelay';
    static label = 'SPECDELAY';
    static cat = 'DELAY';
    static desc = 'Spectral delay: every FFT bin gets its own delay time along a chosen curve, with feedback, blur, damping and pitch-shifted repeats.';
    static latency = 2048;
    static params = [
      { id: 'time', label: 'TIME', div: ['1/1', '1/32'], def: '1/4' },
      { id: 'shape', label: 'SHAPE', options: ['LIN', 'EXP', 'LOG', 'STEP', 'RANDOM', 'KEY'], def: 0 },
      { id: 'tilt', label: 'TILT', min: -100, max: 100, def: 70, unit: '%', bipolar: true },
      { id: 'fb', label: 'FB', min: 0, max: 95, def: 45, unit: '%' },
      { id: 'blur', label: 'BLUR', min: 0, max: 100, def: 10, unit: '%' },
      { id: 'shift', label: 'SHIFT', min: -12, max: 12, def: 0, unit: 'st', bipolar: true },
      { id: 'damp', label: 'DAMP', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'locut', label: 'LOCUT', min: 20, max: 2000, def: 80, curve: 'exp', unit: 'Hz' },
    ];
    setup() { this.cD = new Float64Array(6).fill(NaN); this.cIv = null; this.cDL = new Float64Array(3).fill(NaN); this.w = 0; }
    alloc(N) {
      const B = N / 2 + 1, hop = N / 4, sr = this.sr;
      const Fn = Math.min(512, nextPow2(Math.ceil(2.7 * sr / hop)));
      this.Fn = Fn;
      const F = () => new Float32Array(B), u = new Float32Array(B), rnd = new Float32Array(128), rg = new Rng(0xDE1A7);
      for (let k = 0; k < B; k++) u[k] = clamp(Math.log2(Math.max(1, k * sr / N) / 40) / Math.log2(400), 0, 1);
      for (let i = 0; i < 128; i++) rnd[i] = rg.next();
      return {
        hRe: [new Float32Array(Fn * B), new Float32Array(Fn * B)], hIm: [new Float32Array(Fn * B), new Float32Array(Fn * B)],
        yR: F(), yI: F(), fR: F(), fI: F(), pv: new SPX_PV(N),
        D: new Int32Array(B), dg: F(), lc: F(), t: { u, rnd },
      };
    }
    onClear() { this.w = 0; this.cD[0] = NaN; this.cDL[0] = NaN; this.st.pv.clear(); }
    block(p, ctx) {
      const key = ctx.key, hop = this.hop, B = this.B, st = this.st, Fn = this.Fn;
      const ts = p.time * ctx.spb, shape = p.shape | 0, tilt = p.tilt / 100, c = this.cD;
      if (c[0] !== ts || c[1] !== shape || c[2] !== tilt || c[3] !== key.root || c[4] !== this.N || this.cIv !== key.intervals) {
        c[0] = ts; c[1] = shape; c[2] = tilt; c[3] = key.root; c[4] = this.N; this.cIv = key.intervals;
        const u = st.t.u, rnd = st.t.rnd, D = st.D, binHz = this.sr / this.N, iv = key.intervals, nI = iv.length;
        const at = Math.abs(tilt), maxF = ts / hop;
        for (let k = 0; k < B; k++) {
          const x = u[k];
          let cv;
          switch (shape) {
            case 1: cv = (Math.pow(2, 3 * x) - 1) / 7; break;
            case 2: cv = 1 - (Math.pow(2, 3 * (1 - x)) - 1) / 7; break;
            case 3: cv = Math.min(5, Math.floor(x * 6)) / 5; break;
            case 4: cv = rnd[clamp(Math.round(ftom(Math.max(20, k * binHz))), 0, 127)]; break;
            case 5: {
              const m = ftom(Math.max(20, k * binHz)) - key.root, pc = ((m % 12) + 12) % 12;
              let best = 0, bd = 99;
              for (let i = 0; i < nI; i++) { let d = Math.abs(iv[i] - pc); if (d > 6) d = 12 - d; if (d < bd) { bd = d; best = i; } }
              cv = (best + 0.5) / nI; break;
            }
            default: cv = x;
          }
          if (tilt < 0) cv = 1 - cv;
          const fr = (1 - at) + at * cv;
          D[k] = clamp(Math.round(fr * maxF), 1, Fn - 1);
        }
      }
      const damp = p.damp / 100, lcut = p.locut, cl = this.cDL;
      if (cl[0] !== damp || cl[1] !== lcut || cl[2] !== this.N) {
        cl[0] = damp; cl[1] = lcut; cl[2] = this.N;
        const fc = 20000 * Math.pow(2, -damp * 6), binHz = this.sr / this.N;
        for (let k = 0; k < B; k++) {
          const f = k * binHz, x = f / fc, y = lcut / Math.max(1, f);
          st.dg[k] = 1 / Math.sqrt(1 + x * x);
          st.lc[k] = 1 / (1 + y * y * y * y);
        }
      }
      this.fb = p.fb / 100; this.blur = p.blur / 100;
      this.shOct = p.shift / 12;
      this.doShift = Math.abs(p.shift) > 0.01;
    }
    frame(re, im, ch) {
      const st = this.st, B = this.B, Fn = this.Fn, msk = Fn - 1, w = this.w;
      const hRe = st.hRe[ch], hIm = st.hIm[ch], D = st.D, yR = st.yR, yI = st.yI, fR = st.fR, fI = st.fI;
      for (let k = 0; k < B; k++) {
        const ri = ((w - D[k]) & msk) * B + k;
        yR[k] = hRe[ri]; yI[k] = hIm[ri];
      }
      // feedback path source (optionally pitch-shifted per peak region)
      fR.set(yR); fI.set(yI);
      const pv = st.pv;
      if (this.doShift) {
        const np = pv.analyze(fR, fI, ch, 1e-6);
        for (let i = 0; i < np; i++) { pv.tg[i] = this.shOct; pv.gn[i] = 1; }
        pv.render(fR, fI, ch, 1, 0);
      } else pv.storePrev(yR, yI, ch);
      const fb = this.fb, bl = this.blur, dg = st.dg, lc = st.lc, rng = this.rng, base = w * B;
      const lim = 0.6 * this.N, lim2 = lim * lim;
      let pr = 0, pi = 0;
      for (let k = 0; k < B; k++) {
        let a = fR[k], b = fI[k];
        if (bl > 0) {
          const nr = k + 1 < B ? fR[k + 1] : 0, ni = k + 1 < B ? fI[k + 1] : 0;
          const ca = a, cb = b;
          a = a * (1 - 0.5 * bl) + 0.25 * bl * (pr + nr); b = b * (1 - 0.5 * bl) + 0.25 * bl * (pi + ni);
          pr = ca; pi = cb;
          const j = SPX_ri(rng, bl), c = SPX_RT[j], s = SPX_RT[j + 1], t = a * c - b * s;
          b = a * s + b * c; a = t;
        }
        const g = fb * dg[k];
        let wr = lc[k] * re[k] + g * a, wi = lc[k] * im[k] + g * b;
        const m2 = wr * wr + wi * wi;
        if (m2 > lim2) { const sc = lim / Math.sqrt(m2); wr *= sc; wi *= sc; }
        hRe[base + k] = wr; hIm[base + k] = wi;
        re[k] = yR[k]; im[k] = yI[k];
      }
      if (ch === 1) this.w = (w + 1) & msk;
    }
  });

  // ==========================================================================
  // 7. MAGNET — pulls partials toward the key
  // ==========================================================================
  registerFX(class extends SPX_Base {
    static id = 'magnet';
    static label = 'MAGNET';
    static cat = 'PITCH';
    static desc = 'Spectral pitch magnet: tracks every partial with a phase vocoder and pulls it toward the nearest scale, chord or root note, with glide, focus and drift.';
    static latency = 2048;
    static params = [
      { id: 'attract', label: 'ATTRACT', min: 0, max: 100, def: 80, unit: '%' },
      { id: 'field', label: 'FIELD', options: ['SCALE', 'CHORD', 'ROOT'], def: 0 },
      { id: 'glide', label: 'GLIDE', min: 0, max: 1000, def: 40, curve: 'sq', unit: 'ms' },
      { id: 'focus', label: 'FOCUS', min: 0, max: 100, def: 30, unit: '%' },
      { id: 'drift', label: 'DRIFT', min: 0, max: 100, def: 10, unit: '%' },
      { id: 'shift', label: 'SHIFT', min: -12, max: 12, def: 0, curve: 'int', unit: 'st', bipolar: true },
    ];
    setup() { this.mask = new Uint8Array(12); this.near = new SPX_Near(); this.fn = 0; }
    alloc(N) {
      const B = N / 2 + 1, rate = new Float32Array(B), ph = new Float32Array(B), rg = new Rng(0x3A6E7);
      // per-bin slow drift LFOs (0.1..0.6 Hz), independent per channel via phase offset
      for (let k = 0; k < B; k++) { rate[k] = TAU * (0.1 + 0.5 * rg.next()) * (N / 4) / this.sr; ph[k] = TAU * rg.next(); }
      return { pv: new SPX_PV(N), t: { rate, ph } };
    }
    onClear() { this.st.pv.clear(); this.fn = 0; }
    block(p, ctx) {
      const key = ctx.key, m = this.mask, f = p.field | 0; m.fill(0);
      if (f === 0) for (let i = 0; i < key.intervals.length; i++) m[(key.root + key.intervals[i]) % 12] = 1;
      else if (f === 1) for (let i = 0; i < key.chord.length; i++) m[(key.root + key.chord[i]) % 12] = 1;
      else { m[key.root % 12] = 1; m[(key.root + 7) % 12] = 1; }
      this.near.set(m);
      this.att = p.attract / 100; this.gl = SPX_coef(p.glide / 1000, this.hop, this.sr);
      this.focus = p.focus / 100; this.drift = p.drift / 100 * 0.6; this.shift = Math.round(p.shift);
    }
    frame(re, im, ch) {
      const st = this.st, pv = st.pv, rate = st.t.rate, ph = st.t.ph;
      const np = pv.analyze(re, im, ch, 1e-6);
      const binHz = this.sr / this.N, att = this.att, nr = this.near, sh = this.shift, dz = this.drift * 2, tf = this.fn, po = ch * 2.1;
      for (let i = 0; i < np; i++) {
        const hz = pv.fq[i] * binHz;
        pv.gn[i] = 1;
        if (hz < 25) { pv.tg[i] = 0; continue; }
        const m = ftom(hz), k = pv.pk[i];
        let d = (nr.near(m + sh) - m) * att;
        if (dz > 0) d += dz * Math.sin(tf * rate[k] + ph[k] + po);
        pv.tg[i] = d / 12;
      }
      if (ch === 1) this.fn++;
      pv.render(re, im, ch, this.gl, this.focus);
    }
  });

  // ==========================================================================
  // 8. FREQWARP — frequency remap around a pivot
  // ==========================================================================
  registerFX(class extends SPX_Base {
    static id = 'fwarp';
    static label = 'FREQWARP';
    static cat = 'SPECTRAL';
    static desc = 'Frequency warp: remaps every partial around a pivot along a power, linear, mirror or fold curve, turning harmonic sounds into bells and inverted spectra.';
    static latency = 2048;
    static params = [
      { id: 'curve', label: 'CURVE', options: ['POWER', 'LINEAR', 'MIRROR', 'FOLD'], def: 0 },
      { id: 'pivot', label: 'PIVOT', min: 50, max: 8000, def: 400, curve: 'exp', unit: 'Hz' },
      { id: 'stretch', label: 'STRETCH', min: -100, max: 100, def: 35, unit: '%', bipolar: true },
      { id: 'tilt', label: 'TILT', min: -6, max: 6, def: 0, unit: 'dB', bipolar: true },
      { id: 'glide', label: 'GLIDE', min: 0, max: 2000, def: 0, curve: 'sq', unit: 'ms' },
      { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    ];
    setup() { this.cT = new Float64Array(3).fill(NaN); }
    alloc(N) { return { pv: new SPX_PV(N), tg: new Float32Array(N / 2 + 1) }; }
    onClear() { this.st.pv.clear(); this.cT[0] = NaN; }
    block(p, ctx) {
      let piv = p.pivot;
      if (p.snap >= 0.5) piv = ctx.key.snapHz(piv);
      this.piv = piv; this.ex = Math.pow(2, p.stretch / 100); this.curve = p.curve | 0;
      this.gl = SPX_coef(p.glide / 1000, this.hop, this.sr);
      const c = this.cT;
      if (c[0] !== p.tilt || c[2] !== this.N) {
        c[0] = p.tilt; c[2] = this.N;
        const tg = this.st.tg, B = this.B, binHz = this.sr / this.N;
        for (let k = 0; k < B; k++) tg[k] = Math.exp(p.tilt * clamp(Math.log2(Math.max(0.5, k) * binHz / 1000), -5.5, 4.5) * SPX_DB2LN);
      }
    }
    map(f) {
      const P = this.piv, e = this.ex;
      switch (this.curve) {
        case 0: return P * Math.exp(e * Math.log(f / P));
        case 1: return Math.abs(P + (f - P) * e);
        case 2: return P * Math.exp(e * Math.log(P / f));
        default: return f <= P ? f : Math.abs(P - (f - P) * e);
      }
    }
    frame(re, im, ch) {
      const st = this.st, pv = st.pv, B = this.B;
      const np = pv.analyze(re, im, ch, 1e-6);
      let ein = 0; const pw = pv.pw;
      for (let k = 0; k < B; k++) ein += pw[k];
      const binHz = this.sr / this.N, nyq = this.sr * 0.495;
      for (let i = 0; i < np; i++) {
        const hz = pv.fq[i] * binHz;
        if (hz < 8) { pv.tg[i] = 0; pv.gn[i] = 1; continue; }
        const t = this.map(hz);
        if ((t < 15 && t < hz) || (t > nyq && t > hz * 1.0001)) { pv.tg[i] = 0; pv.gn[i] = 0; }
        else { pv.tg[i] = Math.log2(t / hz); pv.gn[i] = 1; }
      }
      pv.render(re, im, ch, this.gl, 0);
      const tg = st.tg;
      for (let k = 0; k < B; k++) { re[k] *= tg[k]; im[k] *= tg[k]; }
      this.agc(re, im, ch, ein, 0.05, 2);
    }
  });

  // ==========================================================================
  // 9. SNAPSHOT — tempo-synced spectral freeze into a resynth
  // ==========================================================================
  const SPX_VOICES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 33, 0];
  registerFX(class extends SPX_Base {
    static id = 'snapshot';
    static label = 'SNAPSHOT';
    static cat = 'SPECTRAL';
    static desc = 'Freezes the spectrum on every slice of the beat grid and resynthesises it as a drifting partial bank, with voice count, inharmonic tension, octave and feedback.';
    static latency = 2048;
    static params = [
      { id: 'slice', label: 'SLICE', div: ['4/1', '1/32'], def: '1/4' },
      { id: 'blur', label: 'BLUR', min: 0, max: 100, def: 35, unit: '%' },
      { id: 'voices', label: 'VOICES', options: ['1', '2', '3', '4', '5', '6', '8', '10', '12', '16', '20', '24', '33', 'ALL'], def: 13 },
      { id: 'tension', label: 'TENSION', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
      { id: 'octave', label: 'OCTAVE', min: -2, max: 2, def: 0, curve: 'int', bipolar: true },
      { id: 'fdbk', label: 'FDBK', min: 0, max: 95, def: 30, unit: '%' },
      { id: 'mixin', label: 'MIX-IN', min: 0, max: 100, def: 0, unit: '%' },
      { id: 'morph', label: 'MORPH', min: 0, max: 100, def: 15, unit: '%' },
    ];
    setup() {
      this.cM = new Float64Array(3).fill(NaN); this.step = NaN; this.cap = false;
      this.mx = new Float32Array(2); this.pSt = new Float64Array(2); this.pAvg = new Float64Array(2); this.roDirty = new Uint8Array(2); this.remap = false;
    }
    alloc(N) {
      const B = N / 2 + 1, F = () => new Float32Array(B), F2 = () => [F(), F()];
      return {
        pRe: F2(), pIm: F2(), St: F2(), Ms: F2(), Mo: F2(),
        Wa: F2(),                  // captured true phase advance per hop (rad, unwrapped)
        Rr: F2(), Ri: F2(),        // rotation phasor per hop
        Ur: F2(), Ui: F2(),        // running output phasor
        Or: F2(), Oi: F2(), Qr: F2(), Qi: F2(), // remap: per-output-bin rotation / running phasor
        lm: [new Uint8Array(B), new Uint8Array(B)],
        X: F(), C: F(), src: F(), rat: F(), sel: new Uint8Array(B), pk: new Int32Array(B),
      };
    }
    onClear() { this.step = NaN; this.cap = false; this.mx.fill(1); this.pSt.fill(0); this.pAvg.fill(0); this.cM[0] = NaN; this.roDirty.fill(1); }
    block(p, ctx) {
      this.slice = Math.max(1 / 64, p.slice);
      this.blur = p.blur / 100; this.V = SPX_VOICES[clamp(p.voices | 0, 0, 13)];
      this.avgC = SPX_coef(0.3, this.hop, this.sr);
      this.fb = p.fdbk / 100; this.mi = p.mixin / 100 * 0.3;
      const sliceFr = this.slice * ctx.spb / this.hop;
      this.mstep = 1 / Math.max(1, (p.morph / 100) * sliceFr);
      const oct = Math.round(p.octave), te = p.tension / 100, c = this.cM;
      this.remap = oct !== 0 || Math.abs(te) > 0.005;
      if (this.remap && (c[0] !== oct || c[1] !== te || c[2] !== this.N)) {
        c[0] = oct; c[1] = te; c[2] = this.N;
        const src = this.st.src, rat = this.st.rat, B = this.B, ie = 1 / (1 + 0.25 * te), fr = 200 * this.N / this.sr, o2 = Math.pow(2, oct);
        for (let j = 0; j < B; j++) {
          const s = j < 1 ? -1 : fr * Math.pow(j / (o2 * fr), ie);
          src[j] = s; rat[j] = s > 0 ? j / s : 0;
        }
        this.roDirty.fill(1);
      }
    }
    // per-output-bin rotation for the remapped resynthesis (only after a capture or remap change)
    // and re-seed output phasors from the source phase with the (-1)^k lobe pattern of a
    // frame-start-referenced Hann window, so moved partials stay coherent sinusoids.
    buildRot(ch) {
      const st = this.st, B = this.B, src = st.src, rat = st.rat, Wa = st.Wa[ch], Or = st.Or[ch], Oi = st.Oi[ch];
      const Ur = st.Ur[ch], Ui = st.Ui[ch], Qr = st.Qr[ch], Qi = st.Qi[ch];
      for (let j = 0; j < B; j++) {
        const s = src[j];
        if (s < 0 || s >= B - 1) { Or[j] = 1; Oi[j] = 0; continue; }
        const i = s | 0, f = s - i, a = (Wa[i] + (Wa[i + 1] - Wa[i]) * f) * rat[j];
        Or[j] = Math.cos(a); Oi[j] = Math.sin(a);
        const ic = f < 0.5 ? i : i + 1, sg = ((j - ic) & 1) ? -1 : 1;
        Qr[j] = Ur[ic] * sg; Qi[j] = Ui[ic] * sg;
      }
      this.roDirty[ch] = 0;
    }
    capture(re, im, ch) {
      const st = this.st, B = this.B, X = st.X, C = st.C, pRe = st.pRe[ch], pIm = st.pIm[ch];
      const St = st.St[ch], Mo = st.Mo[ch], Ms = st.Ms[ch], Wa = st.Wa[ch], Rr = st.Rr[ch], Ri = st.Ri[ch], Ur = st.Ur[ch], Ui = st.Ui[ch];
      const lm = st.lm[ch], V = this.V, fb = this.fb;
      if (V === 0) C.set(X);
      else {
        C.fill(0);
        const pk = st.pk, sel = st.sel; let np = 0;
        for (let k = 2; k < B - 2; k++) { const v = X[k]; if (v > 0 && v > X[k - 1] && v >= X[k + 1] && v > X[k - 2] && v >= X[k + 2]) pk[np++] = k; }
        sel.fill(0);
        for (let v = 0; v < V && v < np; v++) {
          let bi = -1, bm = 0;
          for (let i = 0; i < np; i++) { const q = pk[i]; if (!sel[q] && X[q] > bm) { bm = X[q]; bi = q; } }
          if (bi < 0) break;
          sel[bi] = 2;
          for (let k = bi - 2; k <= bi + 2; k++) { C[k] = X[k]; if (k !== bi) sel[k] = 1; }
        }
      }
      let Pc = 0, Po = 0, Pt = 0;
      for (let k = 0; k < B; k++) {
        const cv = C[k], mo = Mo[k], ov = fb * mo;
        Pc += cv * cv; Po += mo * mo;
        const s = Math.sqrt(cv * cv + ov * ov);
        St[k] = s; Pt += s * s; lm[k] = s > 0 ? 1 : 0;
        if (cv > 0 && cv >= ov) {
          const a = re[k], b = im[k], c = pRe[k], d = pIm[k];
          let dev = Math.atan2(b * c - a * d, a * c + b * d) - k * SPX_HP; dev -= TAU * Math.round(dev / TAU);
          Wa[k] = k * SPX_HP + dev; Rr[k] = Math.cos(dev + k * SPX_HP); Ri[k] = Math.sin(dev + k * SPX_HP);
          const iX = 1 / X[k]; Ur[k] = a * iX; Ui[k] = b * iX;
        }
      }
      if (V !== 0) {
        // lobe bins advance with their peak so each voice stays a coherent sinusoid
        const sel = st.sel;
        for (let k = 2; k < B - 2; k++) if (sel[k] === 2) for (let j = k - 2; j <= k + 2; j++) if (j !== k && C[j] >= fb * Mo[j]) { Wa[j] = Wa[k]; Rr[j] = Rr[k]; Ri[j] = Ri[k]; }
      }
      // a frozen transient must not outshine the music it came from: cap at 2x recent input power
      const tgt = Math.min(Math.max(Pc, fb * Po), Math.max(2 * this.pAvg[ch], 1e-12));
      if (Pt > tgt && Pt > 0) { const sc = Math.sqrt(tgt / Pt); for (let k = 0; k < B; k++) St[k] *= sc; Pt = tgt; }
      this.pSt[ch] = Pt;
      Ms.set(Mo); this.mx[ch] = 0; this.roDirty[ch] = 1;
    }
    frame(re, im, ch) {
      const st = this.st, B = this.B, X = st.X, rng = this.rng, RT = SPX_RT;
      let pl = 0;
      for (let k = 0; k < B; k++) { const v = re[k] * re[k] + im[k] * im[k]; X[k] = Math.sqrt(v); pl += v; }
      // recent input power (~0.3 s average)
      this.pAvg[ch] += (pl - this.pAvg[ch]) * this.avgC;
      if (ch === 0) {
        const step = Math.floor(this.framePPQ() / this.slice);
        this.cap = step !== this.step; this.step = step;
      }
      const St = st.St[ch], Ms = st.Ms[ch], Mo = st.Mo[ch], lm = st.lm[ch];
      // capture on the grid, or as soon as signal appears after silence
      if (this.cap || (this.pSt[ch] < 1e-3 * pl && pl > 1e-8 * this.N * this.N)) this.capture(re, im, ch);
      else if (this.mi > 0) {
        const mi = this.mi, all = this.V === 0; let pt = 0;
        for (let k = 0; k < B; k++) { if (all || lm[k]) St[k] += (X[k] - St[k]) * mi; pt += St[k] * St[k]; }
        this.pSt[ch] = pt;
      }
      let x = this.mx[ch];
      if (x < 1) {
        x = Math.min(1, x + this.mstep); this.mx[ch] = x;
        const e = SPX_sstep(x);
        for (let k = 0; k < B; k++) Mo[k] = Ms[k] + (St[k] - Ms[k]) * e;
      } else Mo.set(St);
      const pRe = st.pRe[ch], pIm = st.pIm[ch];
      for (let k = 0; k < B; k++) { pRe[k] = re[k]; pIm[k] = im[k]; }
      const bz = this.blur;
      if (!this.remap) {
        const Rr = st.Rr[ch], Ri = st.Ri[ch], Ur = st.Ur[ch], Ui = st.Ui[ch];
        for (let k = 0; k < B; k++) {
          const qr = Ur[k], qi = Ui[k], xr = Rr[k], xi = Ri[k];
          let or = qr * xr - qi * xi, oi = qr * xi + qi * xr;
          if (bz > 0) { const j = SPX_ri(rng, bz), cr = RT[j], ci = RT[j + 1], t = or * cr - oi * ci; oi = or * ci + oi * cr; or = t; }
          const n = or * or + oi * oi;
          if (n < 0.25) { or = 1; oi = 0; } else { const g = (3 - n) * 0.5; or *= g; oi *= g; }
          Ur[k] = or; Ui[k] = oi;
          const m = Mo[k]; re[k] = m * or; im[k] = m * oi;
        }
      } else {
        if (this.roDirty[ch]) this.buildRot(ch);
        const src = st.src, rat = st.rat, Or = st.Or[ch], Oi = st.Oi[ch], Qr = st.Qr[ch], Qi = st.Qi[ch];
        for (let j = 0; j < B; j++) {
          const s = src[j];
          if (s < 0 || s >= B - 1) { re[j] = 0; im[j] = 0; continue; }
          const i = s | 0, f = s - i;
          const m = (Mo[i] + (Mo[i + 1] - Mo[i]) * f) / Math.sqrt(rat[j]);
          const qr = Qr[j], qi = Qi[j], xr = Or[j], xi = Oi[j];
          let or = qr * xr - qi * xi, oi = qr * xi + qi * xr;
          if (bz > 0) { const r = SPX_ri(rng, bz), cr = RT[r], ci = RT[r + 1], t = or * cr - oi * ci; oi = or * ci + oi * cr; or = t; }
          const n = or * or + oi * oi;
          if (n < 0.25) { or = 1; oi = 0; } else { const g = (3 - n) * 0.5; or *= g; oi *= g; }
          Qr[j] = or; Qi[j] = oi;
          re[j] = m * or; im[j] = m * oi;
        }
      }
    }
  });

  // ==========================================================================
  // 10. FORMSHIFT — formant (spectral envelope) shift, pitch preserved
  // ==========================================================================
  registerFX(class extends SPX_Base {
    static id = 'formshift';
    static label = 'FORMSHIFT';
    static cat = 'PITCH';
    static desc = 'Formant shifter: moves the cepstrally smoothed spectral envelope up or down while every partial keeps its pitch.';
    static latency = 2048;
    static hasSize = true;
    static params = [
      { id: 'shift', label: 'SHIFT', min: -12, max: 12, def: 7, unit: 'st', bipolar: true },
      { id: 'detail', label: 'DETAIL', min: 0, max: 100, def: 40, unit: '%' },
      { id: 'spread', label: 'SPREAD', min: 0, max: 6, def: 0, unit: 'st' },
      { id: 'size', label: 'SIZE', options: SPX_SIZES, def: 2 },
    ];
    alloc(N) {
      // cepstrum length scales with N (128..512) so cost per second stays flat across SIZE
      const Nc = clamp(N / 4, 128, 512);
      return {
        eR: new Float32Array(Nc), eI: new Float32Array(Nc), lw: new Float32Array(Nc), ge: new Float32Array(Nc / 2 + 1),
        pw: new Float32Array(N / 2 + 1), t: { fft: new FFT(Nc), Nc },
      };
    }
    onClear() { this.cLc = -1; }
    block(p) {
      const sp = p.spread / 2;
      this.r0 = Math.pow(2, (p.shift - sp) / 12); this.r1 = Math.pow(2, (p.shift + sp) / 12);
      const Nc = this.st.t.Nc, Lc = Math.max(3, Math.round((6 + 54 * (p.detail / 100)) * Nc / 512));
      if (Lc !== this.cLc) {
        this.cLc = Lc;
        const lw = this.st.lw, t0 = Lc * 0.7, h = Nc / 2;
        for (let q = 0; q < Nc; q++) {
          const qq = q <= h ? q : Nc - q;
          lw[q] = qq <= t0 ? 1 : qq >= Lc ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * (qq - t0) / (Lc - t0));
        }
      }
    }
    frame(re, im, ch) {
      const st = this.st, B = this.B, pw = st.pw, eR = st.eR, eI = st.eI, lw = st.lw, ge = st.ge, Nc = st.t.Nc, M = Nc / 2;
      const q = (B - 1) / M, fl = 1e-12 * this.N * this.N;
      let ein = 0;
      for (let k = 0; k < B; k++) { const v = re[k] * re[k] + im[k] * im[k]; pw[k] = v; ein += v; }
      // max-pooled log magnitude envelope (M+1 points), even-extended
      for (let m = 0; m <= M; m++) {
        let k0 = Math.round(m * q - q * 0.5), k1 = Math.round(m * q + q * 0.5) - 1;
        if (k0 < 0) k0 = 0; if (k1 >= B) k1 = B - 1; if (k1 < k0) k1 = k0;
        let mx = 0; for (let k = k0; k <= k1; k++) if (pw[k] > mx) mx = pw[k];
        const e = 0.5 * Math.log(mx + fl);
        eR[m] = e; if (m > 0 && m < M) eR[Nc - m] = e;
      }
      eI.fill(0);
      st.t.fft.forward(eR, eI);
      for (let i = 0; i < Nc; i++) { eR[i] *= lw[i]; eI[i] *= lw[i]; }
      st.t.fft.inverse(eR, eI);
      // gain at envelope resolution: exp(E(x / r) - E(x))
      const ir = 1 / (ch === 0 ? this.r0 : this.r1);
      for (let m = 0; m <= M; m++) {
        const xs = Math.min(M, m * ir), i1 = xs | 0, f1 = xs - i1, e1 = i1 < M ? eR[i1] + (eR[i1 + 1] - eR[i1]) * f1 : eR[M];
        let d = e1 - eR[m]; d = d < -3.4 ? -3.4 : d > 2.8 ? 2.8 : d;
        ge[m] = Math.exp(d);
      }
      const iq = 1 / q;
      for (let k = 0; k < B; k++) {
        const x = k * iq, i0 = x | 0, g = i0 < M ? ge[i0] + (ge[i0 + 1] - ge[i0]) * (x - i0) : ge[M];
        re[k] *= g; im[k] *= g;
      }
      this.agc(re, im, ch, ein, 0.5, 2);
    }
  });

  // ==========================================================================
  // 11. CODEC — lossy codec degradation
  // ==========================================================================
  const SPX_BARK = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500, 1e9];
  const SPX_NB = SPX_BARK.length - 1;
  registerFX(class extends SPX_Base {
    static id = 'codec';
    static label = 'CODEC';
    static cat = 'DISTORTION';
    static desc = 'Lossy codec simulator: bit-starved band quantisation with dropped bands, birdie sparkle and pre-echo, packet loss with repeats or holes, frame jitter and bandwidth limit.';
    static latency = 2048;
    static params = [
      { id: 'bitrate', label: 'BITRATE', min: 6, max: 256, def: 24, curve: 'exp' },
      { id: 'packet', label: 'PACKET', min: 0, max: 50, def: 3, unit: '%' },
      { id: 'repeat', label: 'REPEAT', min: 0, max: 100, def: 60, unit: '%' },
      { id: 'artfct', label: 'ARTFCT', min: 0, max: 100, def: 35, unit: '%' },
      { id: 'speed', label: 'SPEED', min: 0, max: 100, def: 100, unit: '%' },
      { id: 'jitter', label: 'JITTER', min: 0, max: 100, def: 10, unit: '%' },
      { id: 'tone', label: 'TONE', min: 0, max: 100, def: 100, unit: '%' },
    ];
    setup() {
      this.bE = new Float64Array(SPX_NB); this.bN = new Float64Array(SPX_NB); this.bW = new Float64Array(SPX_NB);
      this.mode = 0; this.newPkt = true; this.fcnt = 0; this.lost = 0; this.rpG = 1; this.tau = 0;
    }
    alloc(N) {
      const B = N / 2 + 1, band = new Uint8Array(B), binHz = this.sr / N, slope = new Float32Array(SPX_NB);
      for (let k = 0; k < B; k++) { const f = k * binHz; let b = 0; while (b < SPX_NB - 1 && f >= SPX_BARK[b + 1]) b++; band[k] = b; }
      for (let b = 0; b < SPX_NB; b++) slope[b] = Math.pow(Math.max(100, (SPX_BARK[b] + Math.min(20000, SPX_BARK[b + 1])) / 2) / 1000, 0.4);
      return {
        hRe: [new Float32Array(B), new Float32Array(B)], hIm: [new Float32Array(B), new Float32Array(B)],
        hm: [new Float32Array(B), new Float32Array(B)], t: { band, slope },
      };
    }
    onClear() { this.mode = 0; this.newPkt = true; this.fcnt = 0; this.lost = 0; this.rpG = 1; }
    block(p) {
      const kb = p.bitrate;
      this.bits = kb * 1000 * this.hop / this.sr * 0.5 * (1.2 + 5 * kb / 256);
      this.dz = 0.28 - 0.2 * kb / 256;
      const bw = Math.min(clamp(1500 * Math.sqrt(kb), 3000, 20000), 1500 * Math.pow(2, 3.7 * p.tone / 100));
      this.kbw = Math.min(this.B - 1, Math.round(bw * this.N / this.sr));
      this.loss = p.packet / 100; this.rep = p.repeat / 100; this.art = p.artfct / 100;
      this.hold = 1 + Math.round((1 - p.speed / 100) * 7);
      this.jit = p.jitter / 100;
    }
    packet() {
      const rng = this.rng;
      if (++this.fcnt >= this.hold) { this.fcnt = 0; this.newPkt = true; } else this.newPkt = false;
      if (this.lost > 0) { this.lost--; if (this.mode === 1) this.rpG *= 0.9; if (this.lost === 0) this.mode = 0; }
      else if (this.newPkt && this.loss > 0 && rng.next() < this.loss) {
        this.lost = 1 + rng.int(6) + (this.hold - 1);
        this.mode = rng.next() < this.rep ? 1 : 2; this.rpG = 1;
      }
      this.tau = this.jit > 0 ? this.jit * this.hop * 0.3 * rng.bi() : 0;
    }
    frame(re, im, ch) {
      const st = this.st, B = this.B, rng = this.rng, hRe = st.hRe[ch], hIm = st.hIm[ch], hm = st.hm[ch];
      if (ch === 0) this.packet();
      if (this.mode === 2) { re.fill(0, 0, B); im.fill(0, 0, B); return; }
      if (this.mode === 1) {
        const g = this.rpG;
        for (let k = 0; k < B; k++) { re[k] = hRe[k] * g; im[k] = hIm[k] * g; }
        return;
      }
      const kb = this.kbw, band = st.t.band, slope = st.t.slope, bE = this.bE, bN = this.bN, bW = this.bW;
      for (let k = kb; k < B; k++) { re[k] = 0; im[k] = 0; }
      if (this.newPkt) {
        bE.fill(0); bN.fill(0);
        for (let k = 1; k < kb; k++) { const b = band[k]; bE[b] += re[k] * re[k] + im[k] * im[k]; bN[b]++; }
        let mx = 0;
        for (let b = 0; b < SPX_NB; b++) { bE[b] = bN[b] > 0 ? Math.sqrt(bE[b] / bN[b]) : 0; if (bE[b] > mx) mx = bE[b]; }
        if (mx > 1e-9 * this.N) {
          // reverse water-filling: find noise level so that the bit budget is spent
          let lo = Math.log2(mx) - 24, hi = Math.log2(mx) + 2;
          for (let it = 0; it < 14; it++) {
            const mid = 0.5 * (lo + hi), W = Math.pow(2, mid); let bits = 0;
            for (let b = 0; b < SPX_NB; b++) { const r = bE[b] / (W * slope[b]); if (r > 1) bits += bN[b] * Math.log2(r); }
            if (bits > this.bits) lo = mid; else hi = mid;
          }
          const W = Math.pow(2, hi);
          for (let b = 0; b < SPX_NB; b++) bW[b] = W * slope[b];
        } else bW.fill(1e30);
        const art = this.art, dz = this.dz, sp = art * 0.45;
        for (let k = 1; k < kb; k++) {
          const b = band[k], w = bW[b], rms = bE[b];
          if (rms <= w) { // dropped band: optional noise substitution
            const nf = art * 0.5 * rms; re[k] = nf * rng.bi(); im[k] = nf * rng.bi(); continue;
          }
          const dl = 2 * w, idl = 1 / dl;
          let v = re[k] * idl, s = v < 0 ? -1 : 1; v *= s;
          let qv = Math.floor(v + 0.5 - dz + sp * rng.bi()); if (qv < 0) qv = 0;
          const qr = s * qv * dl + art * 0.25 * dl * rng.bi();
          v = im[k] * idl; s = v < 0 ? -1 : 1; v *= s;
          qv = Math.floor(v + 0.5 - dz + sp * rng.bi()); if (qv < 0) qv = 0;
          const qi = s * qv * dl + art * 0.25 * dl * rng.bi();
          re[k] = qr; im[k] = qi;
        }
        re[0] = 0; im[0] = 0;
        for (let k = 0; k < B; k++) hm[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      } else {
        // held codec frame: magnitudes from the frame start, live phase
        for (let k = 0; k < B; k++) {
          const a = re[k], b = im[k], m = Math.sqrt(a * a + b * b);
          if (m > 1e-12) { const g = hm[k] / m; re[k] = a * g; im[k] = b * g; } else { re[k] = hm[k]; im[k] = 0; }
        }
      }
      if (this.tau !== 0) {
        const ang = -TAU * (this.tau + (ch ? 0.15 * this.tau : 0)) / this.N, cr = Math.cos(ang), ci = Math.sin(ang);
        let zr = 1, zi = 0;
        for (let k = 0; k < B; k++) {
          const a = re[k], b = im[k];
          re[k] = a * zr - b * zi; im[k] = a * zi + b * zr;
          const t = zr * cr - zi * ci; zi = zr * ci + zi * cr; zr = t;
        }
      }
      for (let k = 0; k < B; k++) { hRe[k] = re[k]; hIm[k] = im[k]; }
    }
  });
})();
