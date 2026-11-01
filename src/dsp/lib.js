// ============================================================================
// DEBACLE — shared DSP library
// Runs inside the AudioWorkletGlobalScope (no DOM, no window). Also loaded by
// tools/test-fx.mjs inside a node vm context. Everything here is a global.
// ============================================================================

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (g) => 20 * Math.log10(Math.max(1e-12, g));
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const ftom = (f) => 69 + 12 * Math.log2(Math.max(1e-6, f) / 440);
const semisToRatio = (s) => Math.pow(2, s / 12);
const isBad = (x) => !(x === x) || x === Infinity || x === -Infinity; // NaN / Inf

// Pade-style tanh approximation, accurate to ~1e-3 and cheap. Hard-limited to ±1.
function fastTanh(x) {
  if (x > 4.97) return 1;
  if (x < -4.97) return -1;
  const x2 = x * x;
  return (x * (135135 + x2 * (17325 + x2 * (378 + x2)))) /
    (135135 + x2 * (62370 + x2 * (3150 + x2 * 28)));
}
// Cubic soft clip, ±1 knee at |x| = 1.5
function softClip(x) {
  if (x > 1.5) return 1;
  if (x < -1.5) return -1;
  return x - (x * x * x) / 6.75;
}
// Hann window value for phase t in [0,1]
const hann = (t) => 0.5 - 0.5 * Math.cos(TAU * t);
// Tukey window, alpha = taper fraction (0 = rect, 1 = hann)
function tukey(t, alpha) {
  if (alpha <= 0) return 1;
  const a2 = alpha / 2;
  if (t < a2) return 0.5 - 0.5 * Math.cos(Math.PI * t / a2);
  if (t > 1 - a2) return 0.5 - 0.5 * Math.cos(Math.PI * (1 - t) / a2);
  return 1;
}

// ---------------------------------------------------------------------------
// Random: xorshift32, deterministic when seeded.
// ---------------------------------------------------------------------------
class Rng {
  constructor(seed = 0x9e3779b9) { this.s = (seed >>> 0) || 1; }
  nextU32() { let x = this.s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x >>> 0; return this.s; }
  next() { return this.nextU32() / 4294967296; }          // [0,1)
  bi() { return this.next() * 2 - 1; }                    // [-1,1)
  int(n) { return Math.floor(this.next() * n); }          // 0..n-1
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[this.int(arr.length)]; }
  gauss() { // approx normal(0,1)
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }
}

// ---------------------------------------------------------------------------
// Smoothers / followers
// ---------------------------------------------------------------------------
class Smoother { // one-pole parameter smoother
  constructor(sr, ms = 20, v = 0) { this.v = v; this.t = v; this.setTime(sr, ms); }
  setTime(sr, ms) { this.c = 1 - Math.exp(-1 / (Math.max(0.01, ms) * 0.001 * sr)); }
  set(t) { this.t = t; }
  snap(v) { this.v = this.t = v; }
  next() { this.v += (this.t - this.v) * this.c; return this.v; }
}

class EnvFollower { // peak follower with separate attack/release (ms)
  constructor(sr, attMs = 5, relMs = 120) { this.sr = sr; this.env = 0; this.set(attMs, relMs); }
  set(attMs, relMs) {
    this.a = Math.exp(-1 / (Math.max(0.01, attMs) * 0.001 * this.sr));
    this.r = Math.exp(-1 / (Math.max(0.01, relMs) * 0.001 * this.sr));
  }
  process(x) {
    const ax = x < 0 ? -x : x;
    const c = ax > this.env ? this.a : this.r;
    this.env = ax + c * (this.env - ax);
    return this.env;
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
class OnePole { // TPT one-pole: lp() / hp() outputs
  constructor() { this.s = 0; this.g = 0.5; this.lpv = 0; }
  set(fc, sr) { const g = Math.tan(Math.PI * clamp(fc, 1, sr * 0.49) / sr); this.g = g / (1 + g); }
  lp(x) { const v = (x - this.s) * this.g; const y = v + this.s; this.s = y + v; return y; }
  hp(x) { return x - this.lp(x); }
  reset() { this.s = 0; }
}

class Biquad { // RBJ cookbook, transposed direct form II. Mono.
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  _set(b0, b1, b2, a0, a1, a2) {
    const ia = 1 / a0; this.b0 = b0 * ia; this.b1 = b1 * ia; this.b2 = b2 * ia; this.a1 = a1 * ia; this.a2 = a2 * ia;
  }
  _w(f, sr) { const w = TAU * clamp(f, 5, sr * 0.49) / sr; this._c = Math.cos(w); this._s = Math.sin(w); } // no allocation
  lp(f, q, sr) { this._w(f, sr); const c = this._c, s = this._s, al = s / (2 * q); this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); return this; }
  hp(f, q, sr) { this._w(f, sr); const c = this._c, s = this._s, al = s / (2 * q); this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); return this; }
  bp(f, q, sr) { this._w(f, sr); const c = this._c, s = this._s, al = s / (2 * q); this._set(al, 0, -al, 1 + al, -2 * c, 1 - al); return this; } // 0 dB peak
  notch(f, q, sr) { this._w(f, sr); const c = this._c, s = this._s, al = s / (2 * q); this._set(1, -2 * c, 1, 1 + al, -2 * c, 1 - al); return this; }
  ap(f, q, sr) { this._w(f, sr); const c = this._c, s = this._s, al = s / (2 * q); this._set(1 - al, -2 * c, 1 + al, 1 + al, -2 * c, 1 - al); return this; }
  peak(f, q, db, sr) {
    this._w(f, sr); const c = this._c, s = this._s, A = Math.pow(10, db / 40), al = s / (2 * q);
    this._set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A); return this;
  }
  lowShelf(f, db, sr, slope = 1) {
    this._w(f, sr); const c = this._c, s = this._s, A = Math.pow(10, db / 40);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2), sa = 2 * Math.sqrt(A) * al;
    this._set(A * ((A + 1) - (A - 1) * c + sa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sa),
      (A + 1) + (A - 1) * c + sa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sa); return this;
  }
  highShelf(f, db, sr, slope = 1) {
    this._w(f, sr); const c = this._c, s = this._s, A = Math.pow(10, db / 40);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2), sa = 2 * Math.sqrt(A) * al;
    this._set(A * ((A + 1) + (A - 1) * c + sa), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sa),
      (A + 1) - (A - 1) * c + sa, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sa); return this;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = this.z2 = 0; }
}

// Zero-delay-feedback state variable filter (Simper/Cytomic). After process():
// this.lp, this.bp, this.hp, this.notch, this.peak hold the outputs.
// Stable under fast modulation — prefer this for anything swept.
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.lp = this.bp = this.hp = this.notch = this.peak = 0; this.set(1000, 0.707, 48000); }
  set(fc, q, sr) {
    this.g = Math.tan(Math.PI * clamp(fc, 5, sr * 0.48) / sr);
    this.k = 1 / Math.max(0.05, q);
    this.a1 = 1 / (1 + this.g * (this.g + this.k)); this.a2 = this.g * this.a1; this.a3 = this.g * this.a2;
  }
  process(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1; this.hp = x - this.k * v1 - v2; this.notch = this.lp + this.hp; this.peak = this.lp - this.hp;
    return v2;
  }
  reset() { this.ic1 = this.ic2 = 0; }
}

// First-order allpass (phaser stage), coefficient from frequency.
class Allpass1 {
  constructor() { this.a = 0; this.z = 0; }
  set(fc, sr) { const t = Math.tan(Math.PI * clamp(fc, 5, sr * 0.49) / sr); this.a = (t - 1) / (t + 1); }
  process(x) { const y = this.a * x + this.z; this.z = x - this.a * y; return y; }
  reset() { this.z = 0; }
}

// DC blocker
class DCBlock {
  constructor(r = 0.995) { this.r = r; this.x1 = 0; this.y1 = 0; }
  process(x) { const y = x - this.x1 + this.r * this.y1; this.x1 = x; this.y1 = y; return y; }
  reset() { this.x1 = this.y1 = 0; }
}

// ---------------------------------------------------------------------------
// Ring buffer / delay line (power-of-two size). read(d) = sample written d
// samples ago (fractional, 4-point hermite). d >= 1 recommended.
// ---------------------------------------------------------------------------
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
class DelayLine {
  constructor(maxSamples) {
    this.size = nextPow2(Math.max(4, Math.ceil(maxSamples) + 4));
    this.mask = this.size - 1; this.buf = new Float32Array(this.size); this.w = 0;
  }
  write(x) { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }
  // delay in samples (fractional); clamps to buffer
  read(d) {
    d = clamp(d, 0, this.size - 4);
    const pos = this.w - 1 - d;
    return this.readAt(pos);
  }
  readLinear(d) {
    d = clamp(d, 0, this.size - 2);
    const pos = this.w - 1 - d, i = Math.floor(pos), f = pos - i, m = this.mask, b = this.buf;
    return b[i & m] + (b[(i + 1) & m] - b[i & m]) * f;
  }
  // absolute (wrapping) fractional index read, hermite
  readAt(pos) {
    const i = Math.floor(pos), f = pos - i, m = this.mask, b = this.buf;
    const xm1 = b[(i - 1) & m], x0 = b[i & m], x1 = b[(i + 1) & m], x2 = b[(i + 2) & m];
    const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }
  tap(d) { return this.buf[(this.w - 1 - (d | 0)) & this.mask]; } // integer delay, cheap
  clear() { this.buf.fill(0); }
}

// Schroeder allpass with internal delay line (diffusers, reverbs)
class SchroederAP {
  constructor(maxSamples) { this.dl = new DelayLine(maxSamples); this.d = maxSamples; this.g = 0.5; }
  process(x, d = this.d, g = this.g) {
    const v = this.dl.readLinear(d);
    const u = x + g * v;
    this.dl.write(u);
    return v - g * u;
  }
  clear() { this.dl.clear(); }
}

// ---------------------------------------------------------------------------
// FFT (radix-2, in place, complex). N power of two.
// ---------------------------------------------------------------------------
class FFT {
  constructor(n) {
    this.n = n; this.levels = Math.log2(n) | 0;
    this.cos = new Float32Array(n / 2); this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(TAU * i / n); this.sin[i] = Math.sin(TAU * i / n); }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0, x = i; for (let j = 0; j < this.levels; j++) { r = (r << 1) | (x & 1); x >>>= 1; } this.rev[i] = r; }
  }
  _transform(re, im, inv) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    const cs = this.cos, sn = this.sin, sgn = inv ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const wr = cs[k], wi = sgn * sn[k];
          const xr = re[l] * wr - im[l] * wi, xi = re[l] * wi + im[l] * wr;
          re[l] = re[j] - xr; im[l] = im[j] - xi; re[j] += xr; im[j] += xi;
        }
      }
    }
  }
  forward(re, im) { this._transform(re, im, false); }
  // inverse includes 1/N scaling
  inverse(re, im) { this._transform(re, im, true); const s = 1 / this.n; for (let i = 0; i < this.n; i++) { re[i] *= s; im[i] *= s; } }
}

// ---------------------------------------------------------------------------
// STFT framework (stereo, overlap-add, hann analysis + synthesis windows).
//   const stft = new STFT(2048, 4);
//   stft.process(L, R, n, (re, im, ch, N) => { ...modify bins 0..N/2... });
// The callback edits bins k = 0..N/2 (inclusive) of re/im; negative
// frequencies are rebuilt automatically (conjugate symmetry). Output is
// delayed by stft.latency = N samples. Processing is in place.
// ---------------------------------------------------------------------------
class STFT {
  constructor(size = 2048, overlap = 4) {
    this.N = size; this.hop = size / overlap; this.latency = size; this._lat = size - this.hop;
    this.fft = new FFT(size);
    this.win = new Float32Array(size);
    for (let i = 0; i < size; i++) this.win[i] = hann(i / size);
    // normalisation for analysis*synthesis hann^2 at this overlap
    let acc = 0; for (let i = 0; i < size; i++) acc += this.win[i] * this.win[i];
    this.norm = this.hop / acc;
    this.inF = [new Float32Array(size), new Float32Array(size)];
    this.outF = [new Float32Array(size), new Float32Array(size)];
    this.acc = [new Float32Array(size * 2), new Float32Array(size * 2)];
    this.re = new Float32Array(size); this.im = new Float32Array(size);
    this.rover = this._lat;
    this.frameCount = 0;
  }
  reset() {
    for (let c = 0; c < 2; c++) { this.inF[c].fill(0); this.outF[c].fill(0); this.acc[c].fill(0); }
    this.rover = this._lat; this.frameCount = 0;
  }
  process(L, R, n, frame) {
    const N = this.N, lat = this._lat;
    const inL = this.inF[0], inR = this.inF[1], outL = this.outF[0], outR = this.outF[1];
    for (let i = 0; i < n; i++) {
      const r = this.rover;
      inL[r] = L[i]; inR[r] = R[i];
      L[i] = outL[r - lat]; R[i] = outR[r - lat];
      this.rover = r + 1;
      if (this.rover >= N) { this.rover = lat; this._frame(frame); this.frameCount++; }
    }
  }
  // Both channels share one complex FFT (x = left + i·right); the callback still sees
  // separate per-channel half spectra.
  _frame(frame) {
    const N = this.N, H = N >> 1, hop = this.hop, m = N - 1, re = this.re, im = this.im, w = this.win;
    const inL = this.inF[0], inR = this.inF[1];
    if (!this.cre) { this.cre = [new Float32Array(N), new Float32Array(N)]; this.cim = [new Float32Array(N), new Float32Array(N)]; }
    const lr = this.cre[0], li = this.cim[0], rr = this.cre[1], ri = this.cim[1];
    for (let k = 0; k < N; k++) { re[k] = inL[k] * w[k]; im[k] = inR[k] * w[k]; }
    this.fft.forward(re, im);
    for (let k = 0; k <= H; k++) {
      const kk = (N - k) & m, xr = re[k], xi = im[k], yr = re[kk], yi = im[kk];
      lr[k] = (xr + yr) * 0.5; li[k] = (xi - yi) * 0.5;
      rr[k] = (xi + yi) * 0.5; ri[k] = (yr - xr) * 0.5;
    }
    frame(lr, li, 0, N);
    frame(rr, ri, 1, N);
    li[0] = li[H] = ri[0] = ri[H] = 0;
    re[0] = lr[0] - ri[0]; im[0] = li[0] + rr[0];
    re[H] = lr[H] - ri[H]; im[H] = li[H] + rr[H];
    for (let k = 1; k < H; k++) {
      const a = lr[k], b = li[k], c = rr[k], d = ri[k];
      re[k] = a - d; im[k] = b + c;              // L + i·R
      re[N - k] = a + d; im[N - k] = c - b;      // conj(L) + i·conj(R)
    }
    this.fft.inverse(re, im);
    const g = this.norm, accL = this.acc[0], accR = this.acc[1], outL = this.outF[0], outR = this.outF[1];
    for (let k = 0; k < N; k++) { const ww = w[k] * g; accL[k] += re[k] * ww; accR[k] += im[k] * ww; }
    for (let k = 0; k < hop; k++) { outL[k] = accL[k]; outR[k] = accR[k]; }
    accL.copyWithin(0, hop, N * 2); accL.fill(0, N * 2 - hop);
    accR.copyWithin(0, hop, N * 2); accR.fill(0, N * 2 - hop);
    inL.copyWithin(0, hop, N); inR.copyWithin(0, hop, N);
  }
}
const princArg = (p) => p - TAU * Math.round(p / TAU);

// ---------------------------------------------------------------------------
// Musical time: divisions. Values are in BEATS (quarter notes).
// ---------------------------------------------------------------------------
const DIV_TABLE = [
  ['16/1', 64], ['8/1', 32], ['4/1', 16], ['2/1', 8], ['1/1', 4], ['1/2D', 3], ['1/2', 2], ['1/2T', 4 / 3],
  ['1/4D', 1.5], ['1/4', 1], ['1/4T', 2 / 3], ['1/8D', 0.75], ['1/8', 0.5], ['1/8T', 1 / 3],
  ['1/16D', 0.375], ['1/16', 0.25], ['1/16T', 1 / 6], ['1/32', 0.125], ['1/32T', 1 / 12],
  ['1/64', 1 / 16], ['1/128', 1 / 32], ['1/256', 1 / 64], ['1/512', 1 / 128],
];
const DIV_BEATS = Object.fromEntries(DIV_TABLE);
// list of division labels from `from` to `to` inclusive (order of DIV_TABLE: long → short)
function divRange(from, to, straightOnly = false) {
  const a = DIV_TABLE.findIndex((d) => d[0] === from), b = DIV_TABLE.findIndex((d) => d[0] === to);
  let out = DIV_TABLE.slice(Math.min(a, b), Math.max(a, b) + 1).map((d) => d[0]);
  if (straightOnly) out = out.filter((l) => !/[DT]$/.test(l));
  return out;
}

// ---------------------------------------------------------------------------
// Key / scale helper (global SCALE / ROOT / CHORD). ctx.key is an instance.
// ---------------------------------------------------------------------------
const SCALES = {
  'MAJOR': [0, 2, 4, 5, 7, 9, 11], 'MINOR': [0, 2, 3, 5, 7, 8, 10], 'DORIAN': [0, 2, 3, 5, 7, 9, 10],
  'PHRYGIAN': [0, 1, 3, 5, 7, 8, 10], 'LYDIAN': [0, 2, 4, 6, 7, 9, 11], 'MIXOLYD': [0, 2, 4, 5, 7, 9, 10],
  'LOCRIAN': [0, 1, 3, 5, 6, 8, 10], 'HARM MIN': [0, 2, 3, 5, 7, 8, 11], 'MEL MIN': [0, 2, 3, 5, 7, 9, 11],
  'PENTA MAJ': [0, 2, 4, 7, 9], 'PENTA MIN': [0, 3, 5, 7, 10], 'BLUES': [0, 3, 5, 6, 7, 10],
  'WHOLE TONE': [0, 2, 4, 6, 8, 10], 'HIRAJOSHI': [0, 2, 3, 7, 8], 'IN SEN': [0, 1, 5, 7, 10],
  'DIMINISHED': [0, 2, 3, 5, 6, 8, 9, 11], 'CHROMATIC': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const SCALE_NAMES = Object.keys(SCALES);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CHORD_NAMES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const CHORD_SIZES = ['TRIAD', '7TH', 'SUS', 'POWER'];

class KeyHelper {
  constructor() { this.set(0, 'MINOR', 0, 0); }
  set(root, scaleName, chordDeg, chordSize) {
    this.root = root | 0; this.scaleName = scaleName; this.intervals = SCALES[scaleName] || SCALES.MINOR;
    this.chordDeg = chordDeg | 0; this.chordSize = chordSize | 0;
    // full table of in-scale midi notes 0..127
    this.notes = [];
    for (let m = 0; m < 128; m++) if (this.intervals.includes(((m - this.root) % 12 + 12) % 12)) this.notes.push(m);
    // chord as scale-degree stacking
    const degs = this.chordSize === 1 ? [0, 2, 4, 6] : this.chordSize === 2 ? [0, 3, 4] : this.chordSize === 3 ? [0, 4, 7] : [0, 2, 4];
    this.chord = degs.map((d) => this.chordSize === 3 ? this.degreeSemis(this.chordDeg) + (d === 7 ? 12 : d === 4 ? this.degreeSemis(this.chordDeg + 4) - this.degreeSemis(this.chordDeg) : 0) : this.degreeSemis(this.chordDeg + d));
  }
  // semitones above root of scale degree d (d may be negative or > scale length)
  degreeSemis(d) {
    const n = this.intervals.length, o = Math.floor(d / n), i = ((d % n) + n) % n;
    return this.intervals[i] + 12 * o;
  }
  degreeMidi(d, octave = 4) { return 12 * (octave + 1) + this.root + this.degreeSemis(d); }
  // nearest in-scale midi note (float in, integer out)
  snapMidi(m) {
    const notes = this.notes; let best = notes[0], bd = 1e9;
    for (let i = 0; i < notes.length; i++) { const d = Math.abs(notes[i] - m); if (d < bd) { bd = d; best = notes[i]; } }
    return best;
  }
  snapHz(hz) { return mtof(this.snapMidi(ftom(hz))); }
  // snap an interval in semitones to the nearest interval of the scale (relative to root)
  snapSemis(s) {
    const o = Math.floor(s / 12), r = s - o * 12; let best = 0, bd = 1e9;
    const iv = this.intervals;
    for (let i = 0; i < iv.length; i++) { const d = Math.abs(iv[i] - r); if (d < bd) { bd = d; best = iv[i]; } }
    if (Math.abs(12 - r) < bd) best = 12;
    return best + o * 12;
  }
  // chord tones as semitone offsets above root (sorted)
  chordSemis() { return this.chord; } // shared array: do not modify
  // chord tones as midi notes around an octave
  chordMidi(octave = 3) { return this.chord.map((s) => 12 * (octave + 1) + this.root + s); }
  // nearest chord tone (any octave) to midi note m
  snapChordMidi(m) {
    let best = m, bd = 1e9;
    const ch = this.chord;
    for (let o = -1; o <= 10; o++) for (let k = 0; k < ch.length; k++) { const n = 12 * o + this.root + ch[k]; const d = Math.abs(n - m); if (d < bd) { bd = d; best = n; } }
    return best;
  }
}

// ---------------------------------------------------------------------------
// FX base + registry
// ---------------------------------------------------------------------------
const FX_REGISTRY = [];
function registerFX(cls) { FX_REGISTRY.push(cls); return cls; }

class FX {
  constructor(sr) { this.sr = sr; this.init(); }
  init() {}                         // allocate buffers here
  reset() { this.init(); }          // clear state (called when effect is switched on)
  process(L, R, n, p, ctx) {}       // in place, Float32Array L/R of length n
}
