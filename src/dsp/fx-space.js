// ============================================================================
// DEBACLE — SPACE bank: tape delays, reverbs, pitch, granular, resonators and
// glitch time effects. Plain worklet script; every top-level helper is
// prefixed SPC_ to stay out of other banks' way.
// ============================================================================

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const SPC_WN = 4096;
const SPC_HANN = new Float32Array(SPC_WN + 2);
for (let i = 0; i <= SPC_WN + 1; i++) SPC_HANN[i] = 0.5 - 0.5 * Math.cos(TAU * Math.min(i, SPC_WN) / SPC_WN);

// Hann window lookup, t in [0,1] (0 outside)
function SPC_win(t) {
  if (t <= 0 || t >= 1) return 0;
  const x = t * SPC_WN, i = x | 0;
  return SPC_HANN[i] + (SPC_HANN[i + 1] - SPC_HANN[i]) * (x - i);
}
// Tukey window via lookup, a = taper fraction (1 = hann, ->0 = flat top)
function SPC_tuk(t, a) {
  if (t <= 0 || t >= 1) return 0;
  const h = a * 0.5;
  if (t < h) return SPC_win(0.5 * t / h);
  if (t > 1 - h) return SPC_win(0.5 * (1 - t) / h);
  return 1;
}
// linear-interpolated read from a power-of-two ring at absolute position p
function SPC_rd(b, m, p) {
  const i = Math.floor(p), a = b[i & m];
  return a + (b[(i + 1) & m] - a) * (p - i);
}
// allpass on a raw ring (shared time index t): fractional / integer delay D
function SPC_ap(b, m, t, D, g, x) { const v = SPC_rd(b, m, t - D), u = x + g * v; b[t & m] = u; return v - g * u; }
function SPC_api(b, m, t, D, g, x) { const v = b[(t - D) & m], u = x + g * v; b[t & m] = u; return v - g * u; }
// transparent below 1.5, soft ceiling at ~4 (safety on resonant/feedback outs)
// (branch-free on purpose: rarely-taken branches deoptimise the JIT'd kernels)
function SPC_safe(x) {
  const a = Math.abs(x), m = Math.min(a, 1.5) + 2.5 * fastTanh(Math.max(0, a - 1.5) * 0.4);
  return m * (x < 0 ? -1 : 1);
}
// stereo "lean" matrix for l in [-1,1] written into arrays at index k
// outL = xL*ll + xR*rl ; outR = xR*rr + xL*lr
function SPC_lean(l, ll, rl, rr, lr, k) {
  if (l <= 0) { const a = -l; ll[k] = 1 - 0.5 * a; rl[k] = 0.5 * a; rr[k] = 1 - a; lr[k] = 0; }
  else { const a = l; rr[k] = 1 - 0.5 * a; lr[k] = 0.5 * a; ll[k] = 1 - a; rl[k] = 0; }
}
function SPC_pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
// (re)use a big buffer across reset(): zero-filled instead of reallocated, so
// reset() does not hand fresh, untouched memory pages to the audio thread.
function SPC_f32(o, key, n) { const a = o[key]; if (a && a.length === n) { a.fill(0); return a; } return new Float32Array(n); }

// Two-tap rotating-head pitch shifter (hann crossfaded taps, sum = 1).
// step() advances one sample; the caller reads its own delay line(s) at
// base + d0 / base + d1 and weights with g0 / g1.
class SPC_Shifter {
  constructor(seed) { this.ph = 0; this.o0 = 0; this.o1 = 0; this.rng = new Rng(seed); this.d0 = 0; this.d1 = 0; this.g0 = 0; this.g1 = 1; }
  step(ratio, win, jit) {
    const old = this.ph;
    let ph = old + (1 - ratio) / win;
    ph -= Math.floor(ph);
    let p1 = ph + 0.5; if (p1 >= 1) p1 -= 1;
    let q1 = old + 0.5; if (q1 >= 1) q1 -= 1;
    if (jit > 0) {
      if (Math.abs(ph - old) > 0.5) this.o0 = this.rng.next() * jit;
      if (Math.abs(p1 - q1) > 0.5) this.o1 = this.rng.next() * jit;
    } else { this.o0 = 0; this.o1 = 0; }
    this.ph = ph;
    this.d0 = this.o0 + ph * win; this.g0 = SPC_win(ph);
    this.d1 = this.o1 + p1 * win; this.g1 = SPC_win(p1);
  }
}

// Pool of windowed grains reading a stereo ring (bL/bR, mask). Grain = start
// position (absolute, fractional), increment (rate, may be negative), length,
// window taper, stereo lean, amplitude.
class SPC_Grains {
  constructor(n) {
    this.n = n; this.act = new Uint8Array(n); this.pos = new Float64Array(n); this.inc = new Float64Array(n);
    this.len = new Float64Array(n); this.age = new Float64Array(n); this.tap = new Float32Array(n); this.amp = new Float32Array(n);
    this.ll = new Float32Array(n); this.rl = new Float32Array(n); this.rr = new Float32Array(n); this.lr = new Float32Array(n);
    this.oL = 0; this.oR = 0; this.count = 0;
  }
  clear() { this.act.fill(0); this.count = 0; }
  spawn(pos, inc, len, taper, lean, amp) {
    let k = -1, oldest = -1, oa = -1;
    for (let j = 0; j < this.n; j++) {
      if (!this.act[j]) { k = j; break; }
      const a = this.age[j] / this.len[j]; if (a > oa) { oa = a; oldest = j; }
    }
    if (k < 0) { if (oa < 0.85) return; k = oldest; } // steal only nearly finished grains
    this.act[k] = 1; this.pos[k] = pos; this.inc[k] = inc; this.len[k] = Math.max(16, len); this.age[k] = 0;
    this.tap[k] = taper; this.amp[k] = amp;
    SPC_lean(lean, this.ll, this.rl, this.rr, this.lr, k);
  }
  tick(bL, bR, m) {
    let sl = 0, sr = 0, c = 0;
    const act = this.act, pos = this.pos, inc = this.inc, len = this.len, age = this.age;
    for (let k = 0; k < this.n; k++) {
      if (!act[k]) continue;
      const t = age[k] / len[k];
      if (t >= 1) { act[k] = 0; continue; }
      c++;
      const w = (this.tap[k] >= 0.999 ? SPC_win(t) : SPC_tuk(t, this.tap[k])) * this.amp[k];
      const p = pos[k], i = Math.floor(p), f = p - i, i0 = i & m, i1 = (i + 1) & m;
      const xl = bL[i0] + (bL[i1] - bL[i0]) * f, xr = bR[i0] + (bR[i1] - bR[i0]) * f;
      sl += w * (xl * this.ll[k] + xr * this.rl[k]);
      sr += w * (xr * this.rr[k] + xl * this.lr[k]);
      pos[k] = p + inc[k]; age[k] += 1;
    }
    this.oL = sl; this.oR = sr; this.count = c;
  }
}

// 8-line feedback delay network (Hadamard), per-line damping, slow modulation.
// All lines live in one buffer (8 segments of LEN, shared write index).
// setup() once per block, tick(inL, inR) per sample -> this.oL / this.oR
const SPC_FDN_MS = [31.71, 37.13, 41.19, 44.27, 53.39, 59.11, 67.93, 73.37];
class SPC_FDN {
  constructor(sr, maxScale, old) {
    this.sr = sr; this.maxScale = maxScale;
    this.LEN = SPC_pow2(Math.ceil(SPC_FDN_MS[7] * 0.001 * sr * maxScale + 64)); this.mask = this.LEN - 1;
    this.buf = SPC_f32(old || {}, 'buf', this.LEN * 8); this.w = 0;
    this.len = new Float64Array(8); this.lstep = new Float64Array(8); this.g = new Float64Array(8);
    this.lpS = new Float64Array(8); this.v = new Float64Array(8); this.lpc = 0.5; this.modD = 0;
    this.lph = new Float64Array(4); this.mcur = new Float64Array(4); this.mstep = new Float64Array(4);
    for (let i = 0; i < 4; i++) this.lph[i] = i * 0.25;
    this.oL = 0; this.oR = 0; this.first = true;
  }
  // size: delay scale, t60: seconds (Infinity = lossless), dampHz: line lowpass, mod 0..1
  setup(size, t60, dampHz, mod, n) {
    const sr = this.sr; size = clamp(size, 0.05, this.maxScale);
    for (let i = 0; i < 8; i++) {
      const Lt = SPC_FDN_MS[i] * 0.001 * sr * size;
      if (this.first) this.len[i] = Lt;
      const nl = this.len[i] + (Lt - this.len[i]) * 0.06; // per-block glide
      this.lstep[i] = (nl - this.len[i]) / n;
      this.g[i] = t60 === Infinity ? 1 : Math.pow(10, -3 * Lt / (sr * Math.max(0.05, t60)));
    }
    this.first = false;
    this.lpc = dampHz >= sr * 0.45 ? 1 : 1 - Math.exp(-TAU * dampHz / sr);
    this.modD = mod * 0.0022 * sr;
    for (let j = 0; j < 4; j++) {
      this.lph[j] = SPC_lfoAdv(this.lph[j], 0.11 + 0.063 * j, n, sr);
      const tv = (Math.sin(TAU * this.lph[j]) + 1) * this.modD;
      this.mstep[j] = (tv - this.mcur[j]) / n;
    }
  }
  tick(inL, inR) {
    const v = this.v, buf = this.buf, len = this.len, lstep = this.lstep, lp = this.lpS, g = this.g, mc = this.mcur, ms = this.mstep;
    const LEN = this.LEN, mask = this.mask, w = this.w, c = this.lpc;
    for (let i = 0; i < 8; i++) {
      len[i] += lstep[i];
      let d = len[i];
      if (i < 4) { mc[i] += ms[i]; d += mc[i]; }
      const p = w - 1 - d, k = Math.floor(p), f = p - k, o = i * LEN;
      const a = buf[o + (k & mask)], x = a + (buf[o + ((k + 1) & mask)] - a) * f;
      lp[i] += (x - lp[i]) * c;
      v[i] = lp[i] * g[i];
    }
    this.oL = v[0] - v[2] + v[4] - v[6];
    this.oR = v[1] - v[3] + v[5] - v[7];
    const a0 = v[0] + v[1], a1 = v[0] - v[1], a2 = v[2] + v[3], a3 = v[2] - v[3];
    const a4 = v[4] + v[5], a5 = v[4] - v[5], a6 = v[6] + v[7], a7 = v[6] - v[7];
    const b0 = a0 + a2, b2 = a0 - a2, b1 = a1 + a3, b3 = a1 - a3;
    const b4 = a4 + a6, b6 = a4 - a6, b5 = a5 + a7, b7 = a5 - a7;
    const s = 0.35355339;
    buf[w] = (b0 + b4) * s + inL; buf[LEN + w] = (b1 + b5) * s + inR;
    buf[2 * LEN + w] = (b2 + b6) * s - inL; buf[3 * LEN + w] = (b3 + b7) * s - inR;
    buf[4 * LEN + w] = (b0 - b4) * s + inL * 0.7; buf[5 * LEN + w] = (b1 - b5) * s + inR * 0.7;
    buf[6 * LEN + w] = (b2 - b6) * s - inL * 0.7; buf[7 * LEN + w] = (b3 - b7) * s - inR * 0.7;
    this.w = (w + 1) & mask;
  }
}

// slow drifting LFO helper evaluated once per block (sin + smoothed random)
function SPC_lfoAdv(ph, hz, n, sr) { ph += hz * n / sr; return ph - Math.floor(ph); }

// ===========================================================================
// 1. ECHOTAPE — stereo tape echo
// ===========================================================================
registerFX(class extends FX {
  static id = 'echotape';
  static label = 'ECHOTAPE';
  static cat = 'DELAY';
  static desc = 'Stereo tape echo with wow/flutter, hiss, ducking, ageing repeats and four head voicings.';
  static params = [
    { id: 'timel', label: 'TIME L', div: ['1/1', '1/32'], def: '1/8D' },
    { id: 'timer', label: 'TIME R', div: ['1/1', '1/32'], def: '1/4' },
    { id: 'fdbk', label: 'FDBK', min: 0, max: 105, def: 45, unit: '%' },
    { id: 'head', label: 'HEAD', options: ['CLEAN', 'SPACE', 'MULTI', 'COLOR'], def: 0 },
    { id: 'age', label: 'AGE', min: 0, max: 100, def: 30, unit: '%' },
    { id: 'wobble', label: 'WOBBLE', min: 0, max: 100, def: 20, unit: '%' },
    { id: 'tone', label: 'TONE', min: -100, max: 100, def: 0, bipolar: true },
    { id: 'pingpong', label: 'PINGPONG', toggle: true, def: 0 },
    { id: 'hiss', label: 'HISS', min: 0, max: 100, def: 10, unit: '%' },
    { id: 'duck', label: 'DUCK', min: 0, max: 100, def: 0, unit: '%' },
    { id: 'sync', label: 'SYNC', toggle: true, def: 1 },
    { id: 'ms', label: 'FREE', min: 10, max: 2000, def: 350, unit: 'ms', curve: 'exp' },
  ];
  init() {
    const sr = this.sr;
    this.maxD = Math.floor(sr * 5);
    const N = SPC_pow2(this.maxD + 16);
    this.bl = SPC_f32(this, 'bl', N); this.br = SPC_f32(this, 'br', N); this.mask = N - 1; this.w = 0;
    this.st = new Float64Array(12); this.first = true;
    this.col = [new SVF(), new SVF()];
    const a = Math.ceil(sr * 0.04);
    this.ap = [new SchroederAP(a), new SchroederAP(a), new SchroederAP(a), new SchroederAP(a)];
    this.apD = [0.0073 * sr, 0.0171 * sr, 0.0081 * sr, 0.0189 * sr];
    this.envA = Math.exp(-1 / (0.004 * sr)); this.envR = Math.exp(-1 / (0.26 * sr));
    this.rng = new Rng(0x5eed1); this.seed = 0x1234567; this.K = new Float64Array(16);
    this.wph = 0; this.fph = 0; this.drift = 0; this.driftT = 0; this.m0 = 0; this.m1 = 0;
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, spb = ctx.spb, maxD = this.maxD, st = this.st;
    let tl = p.sync ? p.timel * spb : p.ms * sr * 0.001;
    let tr = p.sync ? p.timer * spb : p.ms * sr * 0.001 * (p.timer / p.timel);
    tl = clamp(tl, 32, maxD - 8); tr = clamp(tr, 32, maxD - 8);
    if (this.first) { st[0] = tl; st[1] = tr; st[7] = 1; st[10] = 0x1234567; this.first = false; }
    const head = p.head | 0, age = p.age * 0.01, tone = p.tone, fb = p.fdbk * 0.01, pp = p.pingpong;
    const lpHz = clamp(9500 * Math.pow(2, -age * 2.2 + (tone < 0 ? tone * 0.04 : 0)) * (head === 1 ? 0.65 : 1), 250, 16000);
    const hpHz = 35 * Math.pow(2, tone > 0 ? tone * 0.05 : 0) + age * 110;
    const cLp = 1 - Math.exp(-TAU * lpHz / sr), cHp = 1 - Math.exp(-TAU * hpHz / sr);
    if (head === 3) for (let c = 0; c < 2; c++) this.col[c].set(clamp(950 * Math.pow(2, tone * 0.025), 200, 6000), 1.1, sr);
    const drive = 1 + age * 3 + (head === 1 ? 1.2 : 0);
    // wow / flutter / drift (per block, ramped per sample)
    const wob = Math.min(1, p.wobble * 0.01 + age * 0.15);
    this.wph = SPC_lfoAdv(this.wph, 0.47, n, sr); this.fph = SPC_lfoAdv(this.fph, 6.1, n, sr);
    if (this.rng.next() < n / sr * 1.5) this.driftT = this.rng.bi();
    this.drift += (this.driftT - this.drift) * 0.02;
    const wowD = wob * 0.0026 * sr, flD = wob * 0.00016 * sr;
    const t0 = wowD * (Math.sin(TAU * this.wph) * 0.7 + this.drift * 0.5) + flD * Math.sin(TAU * this.fph);
    const t1 = wowD * (Math.sin(TAU * (this.wph + 0.21)) * 0.7 + this.drift * 0.5) + flD * Math.sin(TAU * (this.fph + 0.37));
    const K = this.K;
    K[0] = tl; K[1] = tr; K[2] = head; K[3] = fb; K[4] = pp; K[5] = cLp; K[6] = cHp; K[7] = drive;
    K[8] = (t0 - this.m0) / n; K[9] = (t1 - this.m1) / n; K[10] = p.duck * 0.01; K[11] = p.hiss * 0.01 * 0.012;
    K[12] = 1 - Math.exp(-1 / (0.14 * sr));
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const K = this.K, st = this.st;
    const tl = K[0], tr = K[1], head = K[2], fb = K[3], pp = K[4], cLp = K[5], cHp = K[6], drive = K[7], idr = 1 / drive;
    const s0 = K[8], s1 = K[9], duckAmt = K[10], hissG = K[11], gl = K[12];
    let m0 = this.m0, m1 = this.m1;
    const bl = this.bl, br = this.br, mask = this.mask;
    const haloG = 0.55, ap = this.ap, apD = this.apD, col0 = this.col[0], col1 = this.col[1], kc = col0.k * 0.9;
    const eA = this.envA, eR = this.envR;
    let w = this.w, d0s = st[0], d1s = st[1], lpl = st[2], lpr = st[3], hpl = st[4], hpr = st[5];
    let env = st[6], duck = st[7], nzs = st[8], nzh = st[9], seed = st[10];
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      d0s += (tl - d0s) * gl; d1s += (tr - d1s) * gl; m0 += s0; m1 += s1;
      const p0 = w - 3 - d0s - m0, p1 = w - 3 - d1s - m1;
      let oL, oR, fL, fR;
      if (head === 0 || head === 3) {
        oL = SPC_rd(bl, mask, p0); oR = SPC_rd(br, mask, p1); fL = oL; fR = oR;
      } else if (head === 1) { // SPACE: heads at 1/3, 2/3, 1
        const q0 = w - 3 - (d0s + m0) * 0.3333, q1 = w - 3 - (d0s + m0) * 0.6667;
        const r0 = w - 3 - (d1s + m1) * 0.3333, r1 = w - 3 - (d1s + m1) * 0.6667;
        const a = SPC_rd(bl, mask, q0), b = SPC_rd(bl, mask, q1), c = SPC_rd(bl, mask, p0);
        const e = SPC_rd(br, mask, r0), f = SPC_rd(br, mask, r1), g = SPC_rd(br, mask, p1);
        oL = (0.5 * a + 0.7 * b + c) * 0.55; oR = (0.5 * e + 0.7 * f + g) * 0.55;
        fL = 0.25 * a + 0.3 * b + 0.45 * c; fR = 0.25 * e + 0.3 * f + 0.45 * g;
      } else { // MULTI: four heads alternating sides
        const D0 = d0s + m0, D1 = d1s + m1;
        const a = SPC_rd(bl, mask, w - 3 - D0 * 0.25), b = SPC_rd(bl, mask, w - 3 - D0 * 0.5), c = SPC_rd(bl, mask, w - 3 - D0 * 0.75), d = SPC_rd(bl, mask, p0);
        const e = SPC_rd(br, mask, w - 3 - D1 * 0.25), f = SPC_rd(br, mask, w - 3 - D1 * 0.5), g = SPC_rd(br, mask, w - 3 - D1 * 0.75), h = SPC_rd(br, mask, p1);
        oL = (0.45 * a + 0.6 * f + 0.75 * c + 0.95 * h) * 0.5; oR = (0.45 * e + 0.6 * b + 0.75 * g + 0.95 * d) * 0.5;
        fL = d; fR = h;
      }
      // loop: tone/age filtering, colour, saturation
      lpl += cLp * (fL - lpl); lpr += cLp * (fR - lpr);
      hpl += cHp * (lpl - hpl); hpr += cHp * (lpr - hpr);
      let yl = lpl - hpl, yr = lpr - hpr;
      if (head === 3) {
        col0.process(yl); yl = 0.45 * yl + kc * col0.bp;
        col1.process(yr); yr = 0.45 * yr + kc * col1.bp;
        yl = ap[1].process(ap[0].process(yl, apD[0], haloG), apD[1], haloG);
        yr = ap[3].process(ap[2].process(yr, apD[2], haloG), apD[3], haloG);
      }
      yl = fastTanh(yl * drive) * idr; yr = fastTanh(yr * drive) * idr;
      let nz = 0;
      if (hissG > 0) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const wn = seed * 4.656612873e-10 - 1;
        nzs += 0.45 * (wn - nzs); nzh += 0.12 * (nzs - nzh); nz = (nzs - nzh) * hissG;
      }
      if (pp) { bl[w] = (xl + xr) * 0.5 + fb * yr + nz * 0.3; br[w] = fb * yl - nz * 0.3; }
      else { bl[w] = xl + fb * yl + nz * 0.3; br[w] = xr + fb * yr - nz * 0.3; }
      w = (w + 1) & mask;
      // ducking against the dry input
      const ax = Math.max(xl < 0 ? -xl : xl, xr < 0 ? -xr : xr);
      env = ax + (ax > env ? eA : eR) * (env - ax);
      const dt = 1 - duckAmt * Math.min(1, env * 3);
      duck += (dt - duck) * 0.002;
      L[i] = SPC_safe(oL * duck + nz); R[i] = SPC_safe(oR * duck - nz);
    }
    this.w = w; this.m0 = m0; this.m1 = m1; st[10] = seed;
    st[0] = d0s; st[1] = d1s; st[2] = lpl; st[3] = lpr; st[4] = hpl; st[5] = hpr; st[6] = env; st[7] = duck; st[8] = nzs; st[9] = nzh;
  }
});

// ===========================================================================
// 2. MULTIHEAD — multi-head tape loop, all heads feed back
// ===========================================================================
const SPC_MH_TAB = [
  [0.25, 0.5, 0.75, 1],                          // EVEN (computed as k/H)
  [1 / 6, 1 / 3, 2 / 3, 1],                      // TRIPLET
  [0.2360680, 0.3819660, 0.6180340, 1],          // GOLDEN (phi^-n)
  [0.0710678, 0.1715729, 0.4142136, 1],          // SILVER (delta^-n)
];
registerFX(class extends FX {
  static id = 'multihead';
  static label = 'MULTIHEAD';
  static cat = 'DELAY';
  static desc = 'Tape loop with up to four playback heads that all feed back, with diffusion and wear in the loop.';
  static params = [
    { id: 'time', label: 'TIME', div: ['2/1', '1/32'], def: '1/2' },
    { id: 'heads', label: 'HEADS', min: 1, max: 4, def: 3, curve: 'int' },
    { id: 'spacing', label: 'SPACING', options: ['EVEN', 'TRIPLET', 'GOLDEN', 'SILVER'], def: 0 },
    { id: 'fdbk', label: 'FDBK', min: 0, max: 100, def: 45, unit: '%' },
    { id: 'halo', label: 'HALO', min: 0, max: 100, def: 30, unit: '%' },
    { id: 'skew', label: 'SKEW', min: -100, max: 100, def: 0, bipolar: true },
    { id: 'age', label: 'AGE', min: 0, max: 100, def: 25, unit: '%' },
    { id: 'tone', label: 'TONE', min: -100, max: 100, def: 0, bipolar: true },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 70, unit: '%' },
    { id: 'sync', label: 'SYNC', toggle: true, def: 1 },
    { id: 'ms', label: 'FREE', min: 20, max: 4000, def: 1000, unit: 'ms', curve: 'exp' },
  ];
  init() {
    const sr = this.sr;
    this.maxD = Math.floor(sr * 6);
    const N = SPC_pow2(this.maxD + 16);
    this.bl = SPC_f32(this, 'bl', N); this.br = SPC_f32(this, 'br', N); this.mask = N - 1; this.w = 0;
    this.T = 0; this.first = true;
    this.fs = new Float64Array(4); this.fstep = new Float64Array(4);
    this.ll = new Float32Array(4); this.rl = new Float32Array(4); this.rr = new Float32Array(4); this.lr = new Float32Array(4);
    const a = Math.ceil(sr * 0.03);
    this.ap = []; for (let i = 0; i < 6; i++) this.ap.push(new SchroederAP(a));
    this.K = new Float64Array(16);
    this.apD = [0.0047, 0.0113, 0.0239, 0.0053, 0.0127, 0.0221].map((x) => x * sr);
    this.st = new Float64Array(6);
    this.wph = 0; this.fph = 0; this.m = 0;
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr;
    const T = clamp(p.sync ? p.time * ctx.spb : p.ms * 0.001 * sr, 64, this.maxD - 8);
    if (this.first) this.T = T;
    const H = clamp(p.heads | 0, 1, 4), sp = p.spacing | 0, tab = SPC_MH_TAB[sp];
    const ex = Math.pow(2, p.skew * 0.013), wd = p.width * 0.01;
    // smoothed head positions: per-block one-pole target, linearly ramped per sample
    const kb = 1 - Math.exp(-n / (0.15 * sr));
    for (let k = 0; k < 4; k++) {
      let f = 1;
      if (k < H) f = Math.pow(sp === 0 ? (k + 1) / H : tab[4 - H + k], ex);
      if (this.first) this.fs[k] = f;
      this.fstep[k] = (f - this.fs[k]) * kb / n;
      SPC_lean(H === 1 ? 0 : wd * (-1 + 2 * k / (H - 1)), this.ll, this.rl, this.rr, this.lr, k);
    }
    this.first = false;
    const age = p.age * 0.01, tone = p.tone;
    const lpHz = clamp(12000 * Math.pow(2, -age * 2.6 + (tone < 0 ? tone * 0.04 : 0)), 300, 18000);
    const hpHz = 30 * Math.pow(2, tone > 0 ? tone * 0.05 : 0) + age * 90;
    const cLp = 1 - Math.exp(-TAU * lpHz / sr), cHp = 1 - Math.exp(-TAU * hpHz / sr);
    this.wph = SPC_lfoAdv(this.wph, 0.31, n, sr); this.fph = SPC_lfoAdv(this.fph, 5.3, n, sr);
    const tv = (0.15 + age) * (0.0018 * sr * Math.sin(TAU * this.wph) + 0.0001 * sr * Math.sin(TAU * this.fph));
    const K = this.K;
    K[0] = T; K[1] = H; K[2] = cLp; K[3] = cHp; K[4] = 1 + age * 2.5; K[5] = p.fdbk * 0.01; K[6] = p.halo * 0.01 * 0.68;
    K[7] = (tv - this.m) / n; K[8] = 1 - Math.exp(-1 / (0.18 * sr));
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const K = this.K, T = K[0], H = K[1], cLp = K[2], cHp = K[3], drive = K[4], idr = 1 / drive, fb = K[5], halo = K[6], ms = K[7], gl = K[8];
    const invH = 1 / H, outG = 1 / Math.sqrt(H);
    let m = this.m;
    const bl = this.bl, br = this.br, mask = this.mask, fs = this.fs, fstep = this.fstep, ap = this.ap, apD = this.apD;
    const ll = this.ll, rl = this.rl, rr = this.rr, lr = this.lr, st = this.st;
    let w = this.w, Ts = this.T, lpl = st[0], lpr = st[1], hpl = st[2], hpr = st[3];
    for (let i = 0; i < n; i++) {
      Ts += (T - Ts) * gl; m += ms;
      let oL = 0, oR = 0, sL = 0, sR = 0;
      for (let k = 0; k < H; k++) {
        fs[k] += fstep[k];
        const pos = w - 3 - Ts * fs[k] - m * (1 + k * 0.3);
        const a = SPC_rd(bl, mask, pos), b = SPC_rd(br, mask, pos);
        sL += a; sR += b;
        oL += a * ll[k] + b * rl[k]; oR += b * rr[k] + a * lr[k];
      }
      let yl = sL * invH, yr = sR * invH;
      if (halo > 0.001) {
        yl = ap[2].process(ap[1].process(ap[0].process(yl, apD[0], halo), apD[1], halo), apD[2], halo);
        yr = ap[5].process(ap[4].process(ap[3].process(yr, apD[3], halo), apD[4], halo), apD[5], halo);
      }
      lpl += cLp * (yl - lpl); lpr += cLp * (yr - lpr);
      hpl += cHp * (lpl - hpl); hpr += cHp * (lpr - hpr);
      yl = fastTanh((lpl - hpl) * drive) * idr; yr = fastTanh((lpr - hpr) * drive) * idr;
      bl[w] = L[i] + fb * yl; br[w] = R[i] + fb * yr; w = (w + 1) & mask;
      L[i] = SPC_safe(oL * outG); R[i] = SPC_safe(oR * outG);
    }
    for (let k = H; k < 4; k++) fs[k] = 1;
    this.w = w; this.T = Ts; this.m = m; st[0] = lpl; st[1] = lpr; st[2] = hpl; st[3] = hpr;
  }
});

// ===========================================================================
// 3. PLATE — figure-8 plate tank (Dattorro topology, own implementation)
// ===========================================================================
// base lengths at 29761 Hz: in diffusers, tank (ap1,d1,ap2,d2, ap3,d3,ap4,d4)
const SPC_PL_IN = [142, 107, 379, 277];
const SPC_PL_TK = [672, 4453, 1800, 3720, 908, 4217, 2656, 3163];
registerFX(class extends FX {
  static id = 'plate';
  static label = 'PLATE';
  static cat = 'REVERB';
  static desc = 'Bright, dense plate reverb: input diffusers into a modulated figure-8 tank, with freeze.';
  static params = [
    { id: 'size', label: 'SIZE', min: 0, max: 100, def: 60, unit: '%' },
    { id: 'decay', label: 'DECAY', min: 0, max: 100, def: 60, unit: '%' },
    { id: 'diff', label: 'DIFF', min: 0, max: 100, def: 75, unit: '%' },
    { id: 'predelay', label: 'PREDELAY', min: 0, max: 300, def: 15, unit: 'ms', curve: 'sq' },
    { id: 'tone', label: 'TONE', min: 800, max: 16000, def: 6500, unit: 'Hz', curve: 'exp' },
    { id: 'mod', label: 'MOD', min: 0, max: 100, def: 30, unit: '%' },
    { id: 'freeze', label: 'FREEZE', toggle: true, def: 0 },
    { id: 'lowcut', label: 'LOW CUT', min: 20, max: 800, def: 90, unit: 'Hz', curve: 'exp' },
    { id: 'width', label: 'WIDTH', min: 0, max: 150, def: 100, unit: '%' },
  ];
  init() {
    const sr = this.sr, k = sr / 29761, mx = 1.6 * k;
    this.k = k; this.B = []; this.M = new Int32Array(13);
    const mk = (i, len) => { const N = SPC_pow2(Math.ceil(len) + 8); const old = this._oldB && this._oldB[i]; this.B[i] = (old && old.length === N) ? (old.fill(0), old) : new Float32Array(N); this.M[i] = N - 1; };
    for (let i = 0; i < 4; i++) mk(i, SPC_PL_IN[i] * k);
    for (let i = 0; i < 8; i++) mk(4 + i, SPC_PL_TK[i] * mx + 40 * k);
    mk(12, 0.32 * sr);
    this._oldB = this.B;
    this.t = 0; this.st = new Float64Array(16); this.K = new Float64Array(24); this.first = true;
    this.lph = 0;
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, K = this.K, k = this.k;
    const size = 0.35 + 1.25 * p.size * 0.01;
    const dec = 0.2 + 0.775 * Math.pow(p.decay * 0.01, 0.6);
    const diff = p.diff * 0.01;
    if (this.first) { K[16] = size; K[17] = p.predelay * 0.001 * sr; K[18] = p.freeze; this.st[10] = 1; this.first = false; }
    this.lph = SPC_lfoAdv(this.lph, 0.9, n, sr);
    const ex = p.mod * 0.01 * 14 * k * 2;
    K[0] = (size - K[16]) * 0.05 / n;                     // size ramp per sample
    K[1] = ((p.predelay * 0.001 * sr) - K[17]) * 0.08 / n; // predelay ramp
    K[2] = dec; K[3] = 0.75 * diff; K[4] = 0.625 * diff; K[5] = 0.7 * (0.4 + 0.6 * diff);
    K[6] = clamp(dec + 0.15, 0.25, 0.5);
    K[7] = 1 - Math.exp(-TAU * p.tone / sr);                // tank damping
    K[8] = 1 - Math.exp(-TAU * Math.min(18000, p.tone * 1.8) / sr); // input bandwidth
    K[9] = 1 - Math.exp(-TAU * p.lowcut / sr);
    K[10] = (ex * (1 + Math.sin(TAU * this.lph)) - K[19]) / n;
    K[11] = (ex * (1 + Math.cos(TAU * this.lph)) - K[20]) / n;
    K[12] = p.freeze ? 1 : 0; K[13] = p.width * 0.01;
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const K = this.K, B = this.B, M = this.M, st = this.st, k = this.k;
    const i0 = B[0], i1 = B[1], i2 = B[2], i3 = B[3], a1 = B[4], d1 = B[5], a2 = B[6], d2 = B[7], a3 = B[8], d3 = B[9], a4 = B[10], d4 = B[11], pre = B[12];
    const m0 = M[0], m1 = M[1], m2 = M[2], m3 = M[3], ma1 = M[4], md1 = M[5], ma2 = M[6], md2 = M[7], ma3 = M[8], md3 = M[9], ma4 = M[10], md4 = M[11], mp = M[12];
    const D0 = Math.round(SPC_PL_IN[0] * k), D1 = Math.round(SPC_PL_IN[1] * k), D2 = Math.round(SPC_PL_IN[2] * k), D3 = Math.round(SPC_PL_IN[3] * k);
    const sStep = K[0], pStep = K[1], dec0 = K[2], g1 = K[3], g2 = K[4], dd1 = K[5], dd2 = K[6], cD0 = K[7], cBw = K[8], cHp = K[9];
    const mS1 = K[10], mS2 = K[11], frz = K[12], wid = K[13];
    let size = K[16], pd = K[17], xf = K[18], mo1 = K[19], mo2 = K[20];
    let hpS = st[0], bw = st[1], dmL = st[2], dmR = st[3], t = this.t;
    const xfc = 0.0008;
    for (let i = 0; i < n; i++) {
      size += sStep; pd += pStep; mo1 += mS1; mo2 += mS2; xf += (frz - xf) * xfc;
      const dec = dec0 + (1 - dec0) * xf, cD = cD0 + (1 - cD0) * xf, inG = 1 - xf;
      const sk = size * k;
      const x = (L[i] + R[i]) * 0.5;
      hpS += cHp * (x - hpS);
      pre[t & mp] = (x - hpS) * inG;
      let y = pd < 1 ? pre[t & mp] : SPC_rd(pre, mp, t - pd);
      bw += cBw * (y - bw); y = bw;
      y = SPC_api(i0, m0, t, D0, g1, y); y = SPC_api(i1, m1, t, D1, g1, y);
      y = SPC_api(i2, m2, t, D2, g2, y); y = SPC_api(i3, m3, t, D3, g2, y);
      const L1 = SPC_PL_TK[1] * sk, L2 = SPC_PL_TK[3] * sk, L3 = SPC_PL_TK[5] * sk, L4 = SPC_PL_TK[7] * sk;
      const endL = SPC_rd(d2, md2, t - L2), endR = SPC_rd(d4, md4, t - L4);
      // left half
      let u = SPC_ap(a1, ma1, t, SPC_PL_TK[0] * sk + mo1, -dd1, y + dec * endR);
      d1[t & md1] = u; u = SPC_rd(d1, md1, t - L1);
      dmL += cD * (u - dmL);
      u = SPC_ap(a2, ma2, t, SPC_PL_TK[2] * sk, dd2, dmL * dec);
      d2[t & md2] = u;
      // right half
      let v = SPC_ap(a3, ma3, t, SPC_PL_TK[4] * sk + mo2, -dd1, y + dec * endL);
      d3[t & md3] = v; v = SPC_rd(d3, md3, t - L3);
      dmR += cD * (v - dmR);
      v = SPC_ap(a4, ma4, t, SPC_PL_TK[6] * sk, dd2, dmR * dec);
      d4[t & md4] = v;
      // output taps
      const oL = d3[(t - ((266 * sk) | 0)) & md3] + d3[(t - ((2974 * sk) | 0)) & md3] - a4[(t - ((1913 * sk) | 0)) & ma4]
        + d4[(t - ((1996 * sk) | 0)) & md4] - d1[(t - ((1990 * sk) | 0)) & md1] - a2[(t - ((187 * sk) | 0)) & ma2] - d2[(t - ((1066 * sk) | 0)) & md2];
      const oR = d1[(t - ((353 * sk) | 0)) & md1] + d1[(t - ((3627 * sk) | 0)) & md1] - a2[(t - ((1228 * sk) | 0)) & ma2]
        + d2[(t - ((2673 * sk) | 0)) & md2] - d3[(t - ((2111 * sk) | 0)) & md3] - a4[(t - ((335 * sk) | 0)) & ma4] - d4[(t - ((121 * sk) | 0)) & md4];
      const mid = (oL + oR) * 0.5, side = (oL - oR) * 0.5 * wid;
      L[i] = SPC_safe((mid + side) * 0.62); R[i] = SPC_safe((mid - side) * 0.62);
      t = (t + 1) & 0x3fffffff;
    }
    this.t = t; K[16] = size; K[17] = pd; K[18] = xf; K[19] = mo1; K[20] = mo2;
    st[0] = hpS; st[1] = bw; st[2] = dmL; st[3] = dmR;
  }
});

// ===========================================================================
// 4. SPRING — dispersive spring tank with transient "crash"
// ===========================================================================
const SPC_SP_M = 18; // dispersion stages per spring
registerFX(class extends FX {
  static id = 'spring';
  static label = 'SPRING';
  static cat = 'REVERB';
  static desc = 'Twin spring tank: long stretched-allpass dispersion chirps, ripple echoes, and hits that shake the springs.';
  static params = [
    { id: 'size', label: 'SIZE', min: 0, max: 100, def: 50, unit: '%' },
    { id: 'decay', label: 'DECAY', min: 0, max: 100, def: 55, unit: '%' },
    { id: 'damp', label: 'DAMP', min: 0, max: 100, def: 35, unit: '%' },
    { id: 'ripple', label: 'RIPPLE', min: 0, max: 100, def: 35, unit: '%' },
    { id: 'crash', label: 'CRASH', min: 0, max: 100, def: 30, unit: '%' },
    { id: 'tension', label: 'TENSION', min: 0, max: 100, def: 50, unit: '%' },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 80, unit: '%' },
  ];
  init() {
    const sr = this.sr;
    this.Ks = Math.max(1, Math.round(sr / 9600));      // stretch factor
    this.KM = this.Ks + 1;                              // ring length per stage (> Ks)
    this.xh = new Float32Array(2 * SPC_SP_M * this.KM); this.yh = new Float32Array(2 * SPC_SP_M * this.KM); this.j = 0;
    const N = SPC_pow2(Math.ceil(0.16 * sr));
    this.dl = SPC_f32(this, 'dl', N * 2); this.N = N; this.mask = N - 1; this.w = 0;
    this.st = new Float64Array(24); this.K = new Float64Array(24); this.first = true;
    this.envA = Math.exp(-1 / (0.0007 * sr)); this.envR = Math.exp(-1 / (0.02 * sr)); this.envR2 = Math.exp(-1 / (0.25 * sr));
    this.seed = 1;
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, K = this.K;
    const dly = (0.028 + 0.06 * p.size * 0.01) * sr;
    const t60 = 0.4 * Math.pow(15, p.decay * 0.01);
    if (this.first) { K[20] = dly; this.first = false; }
    K[0] = (dly - K[20]) * 0.05 / n;
    K[1] = Math.pow(10, -3 * dly / (sr * t60));                       // loop gain (spring A)
    K[2] = Math.pow(10, -3 * dly * 1.13 / (sr * t60));                // spring B is longer
    K[3] = 1 - Math.exp(-TAU * (7000 * Math.pow(2, -p.damp * 0.045)) / sr);
    K[4] = p.ripple * 0.01 * 0.55;
    K[5] = p.crash * 0.01;
    K[6] = 0.38 + 0.45 * p.tension * 0.01;                            // dispersion coefficient
    K[7] = p.width * 0.01;
    K[8] = 1 - Math.exp(-TAU * 70 / sr);
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const K = this.K, st = this.st, sr = this.sr;
    const dStep = K[0], gA = K[1], gB = K[2], cLp = K[3], rip = K[4], crash = K[5], a = K[6], wid = K[7], cHp = K[8];
    const xh = this.xh, yh = this.yh, KM = this.KM, Ks = this.Ks, dl = this.dl, N = this.N, mask = this.mask;
    const eA = this.envA, eR = this.envR, eR2 = this.envR2;
    let d = K[20], j = this.j, w = this.w, seed = st[20] || 22222;
    let fA = st[0], fB = st[1], lpA = st[2], lpB = st[3], hpA = st[4], hpB = st[5];
    let ef = st[6], es = st[7], shake = st[8], sph = st[9], burst = st[10], hold = st[11];
    const shW = TAU * 5.5 / sr;
    for (let i = 0; i < n; i++) {
      d += dStep;
      const xl = L[i], xr = R[i];
      // transient detector -> crash: spring wobble + metallic burst
      const ax = Math.abs(xl) + Math.abs(xr);
      ef = ax + (ax > ef ? eA : eR) * (ef - ax); es = ax + (ax > es ? eA : eR2) * (es - ax);
      const hit = (hold <= 0 && ef > 0.15 && ef > es * 1.6) ? crash : 0; // branch-free trigger
      hold = hit > 0 ? sr * 0.06 : hold - 1;
      shake = Math.min(1.5, shake + ef * hit) * 0.99985;
      burst = Math.max(burst * 0.9965, Math.min(1, ef) * hit);
      sph += shW; sph -= sph > TAU ? TAU : 0;
      const wob = shake * Math.sin(sph) * 0.004 * sr;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const nz = (seed * 4.656612873e-10 - 1) * burst * 0.35;
      const drv = 1 + crash * 3;
      const inA = fastTanh((xl * 0.8 + xr * 0.2 + nz) * drv) / drv, inB = fastTanh((xr * 0.8 + xl * 0.2 - nz) * drv) / drv;
      // loop input = input + recirculation, then dispersion chain
      let sA = inA + fA, sB = inB + fB;
      const jr = (j - Ks + KM) % KM;
      for (let s = 0; s < SPC_SP_M; s++) {
        const o = s * KM, oB = (s + SPC_SP_M) * KM;
        let y = a * sA + xh[o + jr] - a * yh[o + jr]; xh[o + j] = sA; yh[o + j] = y; sA = y;
        y = a * sB + xh[oB + jr] - a * yh[oB + jr]; xh[oB + j] = sB; yh[oB + j] = y; sB = y;
      }
      j = (j + 1) % KM;
      dl[w] = sA; dl[N + w] = sB;
      // main + ripple taps (convex mix keeps loop gain <= g)
      const pA = w - d - wob, pB = w - d * 1.13 + wob * 0.8;
      let tA = SPC_rd(dl, mask, pA), tB = dl[N + (Math.floor(pB) & mask)] + (dl[N + ((Math.floor(pB) + 1) & mask)] - dl[N + (Math.floor(pB) & mask)]) * (pB - Math.floor(pB));
      if (rip > 0) {
        const qA = w - d * 0.371, qB = w - d * 0.4213;
        const rA = SPC_rd(dl, mask, qA), qi = Math.floor(qB), rB = dl[N + (qi & mask)];
        tA = tA * (1 - rip) + rA * rip; tB = tB * (1 - rip) + rB * rip;
      }
      lpA += cLp * (tA - lpA); lpB += cLp * (tB - lpB);
      hpA += cHp * (lpA - hpA); hpB += cHp * (lpB - hpB);
      fA = fastTanh((lpA - hpA) * gA * 1.2) * 0.8333; fB = fastTanh((lpB - hpB) * gB * 1.2) * 0.8333;
      w = (w + 1) & mask;
      // output: the spring's far end (main tap + ripple), stereo width
      const oA = tA * 1.1, oB = tB * 1.1, mid = (oA + oB) * 0.5, side = (oA - oB) * 0.5 * wid;
      L[i] = SPC_safe(mid + side); R[i] = SPC_safe(mid - side);
    }
    K[20] = d; this.j = j; this.w = w;
    st[0] = fA; st[1] = fB; st[2] = lpA; st[3] = lpB; st[4] = hpA; st[5] = hpB;
    st[6] = ef; st[7] = es; st[8] = shake; st[9] = sph; st[10] = burst; st[11] = hold; st[20] = seed;
  }
});

// ===========================================================================
// 5. HALO — shimmer reverb (FDN with pitch-shifted regeneration)
// ===========================================================================
const SPC_HALO_R1 = [2, 1.5, 2, 0.5], SPC_HALO_R2 = [0, 0, 1.4983071, 0]; // second voice for OCT+5TH
registerFX(class extends FX {
  static id = 'halo';
  static label = 'HALO';
  static cat = 'REVERB';
  static desc = 'Shimmer reverb: an 8-line FDN whose tail is pitch-shifted and fed back into itself.';
  static params = [
    { id: 'size', label: 'SIZE', min: 0, max: 100, def: 60, unit: '%' },
    { id: 'decay', label: 'DECAY', min: 0, max: 100, def: 60, unit: '%' },
    { id: 'shimmer', label: 'SHIMMER', min: 0, max: 100, def: 50, unit: '%' },
    { id: 'interval', label: 'INTERVAL', options: ['OCT', '5TH', 'OCT+5TH', '-OCT'], def: 0 },
    { id: 'tone', label: 'TONE', min: 1000, max: 16000, def: 7000, unit: 'Hz', curve: 'exp' },
    { id: 'mod', label: 'MOD', min: 0, max: 100, def: 35, unit: '%' },
    { id: 'freeze', label: 'FREEZE', toggle: true, def: 0 },
    { id: 'predelay', label: 'PREDELAY', min: 0, max: 250, def: 20, unit: 'ms', curve: 'sq' },
    { id: 'width', label: 'WIDTH', min: 0, max: 150, def: 100, unit: '%' },
  ];
  init() {
    const sr = this.sr;
    this.fdn = new SPC_FDN(sr, 2.0, this.fdn);
    const N = SPC_pow2(Math.ceil(0.27 * sr));
    this.pre = SPC_f32(this, 'pre', N * 2); this.pN = N; this.pm = N - 1;
    const SN = SPC_pow2(Math.ceil(0.2 * sr));
    this.sh = SPC_f32(this, 'sh', SN * 2); this.sN = SN; this.sm = SN - 1;
    const AN = SPC_pow2(Math.ceil(0.02 * sr));
    this.ap = SPC_f32(this, 'ap', AN * 4); this.aN = AN; this.am = AN - 1;
    this.apD = new Int32Array([0.0053 * sr, 0.0117 * sr, 0.0061 * sr, 0.0133 * sr]);
    this.s1 = new SPC_Shifter(11); this.s2 = new SPC_Shifter(12);
    this.t = 0; this.st = new Float64Array(16); this.K = new Float64Array(16); this.first = true;
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, K = this.K, iv = p.interval | 0;
    const frz = p.freeze ? 1 : 0;
    const t60 = frz ? Infinity : 0.6 * Math.pow(40, p.decay * 0.01);
    this.fdn.setup(0.4 + 1.6 * p.size * 0.01, t60, frz ? sr : p.tone, p.mod * 0.01, n);
    if (this.first) { K[10] = p.predelay * 0.001 * sr; this.first = false; }
    K[0] = (p.predelay * 0.001 * sr - K[10]) * 0.08 / n;
    K[1] = SPC_HALO_R1[iv]; K[2] = SPC_HALO_R2[iv];
    K[3] = frz ? 0 : p.shimmer * 0.01;          // regeneration amount
    K[4] = p.shimmer * 0.01;                    // audible shimmer layer
    K[5] = frz; K[6] = p.width * 0.01;
    K[7] = 1 - Math.exp(-TAU * 280 / sr); K[8] = 1 - Math.exp(-TAU * Math.min(12000, p.tone * 1.2) / sr);
    K[9] = Math.round(0.085 * sr);
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const K = this.K, st = this.st, fdn = this.fdn, s1 = this.s1, s2 = this.s2;
    const pre = this.pre, pm = this.pm, sh = this.sh, sm = this.sm, ap = this.ap, aN = this.aN, am = this.am, apD = this.apD;
    const pStep = K[0], r1 = K[1], r2 = K[2], regen = K[3], layer = K[4], frz = K[5], wid = K[6], cHp = K[7], cLp = K[8], win = K[9];
    const ad0 = apD[0], ad1 = apD[1], ad2 = apD[2], ad3 = apD[3];
    let pd = K[10], t = this.t, xf = st[0], yl = st[1], yr = st[2], hl = st[3], hr = st[4], ll = st[5], lr = st[6], env = st[7];
    for (let i = 0; i < n; i++) {
      pd += pStep; xf += (frz - xf) * 0.001;
      const inG = 1 - xf;
      const tw = (t & pm) << 1;
      pre[tw] = L[i] * inG; pre[tw + 1] = R[i] * inG;
      let xl, xr;
      { const q = t - pd, k = Math.floor(q), f = q - k, j0 = (k & pm) << 1, j1 = ((k + 1) & pm) << 1;
        xl = pre[j0] + (pre[j1] - pre[j0]) * f; xr = pre[j0 + 1] + (pre[j1 + 1] - pre[j0 + 1]) * f; }
      // input diffusion
      let v = ap[(t - ad0) & am], u = xl + 0.6 * v; ap[t & am] = u; xl = v - 0.6 * u;
      v = ap[aN + ((t - ad1) & am)]; u = xl + 0.6 * v; ap[aN + (t & am)] = u; xl = v - 0.6 * u;
      v = ap[2 * aN + ((t - ad2) & am)]; u = xr + 0.6 * v; ap[2 * aN + (t & am)] = u; xr = v - 0.6 * u;
      v = ap[3 * aN + ((t - ad3) & am)]; u = xr + 0.6 * v; ap[3 * aN + (t & am)] = u; xr = v - 0.6 * u;
      // shimmer regeneration (level-limited)
      const ag = regen * 0.55 / (1 + 4 * Math.max(0, env - 0.2));
      fdn.tick(xl * 0.6 + yl * ag, xr * 0.6 + yr * ag);
      const fl = fdn.oL * 0.32, fr = fdn.oR * 0.32;
      const sw = (t & sm) << 1;
      sh[sw] = fl; sh[sw + 1] = fr;
      // pitch shift the tail (interleaved stereo ring)
      s1.step(r1, win, 0);
      let q = t - 2 - s1.d0, k = Math.floor(q), f = q - k, j0 = (k & sm) << 1, j1 = ((k + 1) & sm) << 1, g = s1.g0;
      let pl = (sh[j0] + (sh[j1] - sh[j0]) * f) * g, pr = (sh[j0 + 1] + (sh[j1 + 1] - sh[j0 + 1]) * f) * g;
      q = t - 2 - s1.d1; k = Math.floor(q); f = q - k; j0 = (k & sm) << 1; j1 = ((k + 1) & sm) << 1; g = s1.g1;
      pl += (sh[j0] + (sh[j1] - sh[j0]) * f) * g; pr += (sh[j0 + 1] + (sh[j1 + 1] - sh[j0 + 1]) * f) * g;
      if (r2 > 0) {
        s2.step(r2, win * 1.31, 0);
        q = t - 2 - s2.d0; k = Math.floor(q); f = q - k; j0 = (k & sm) << 1; j1 = ((k + 1) & sm) << 1; g = s2.g0;
        let ql = (sh[j0] + (sh[j1] - sh[j0]) * f) * g, qr = (sh[j0 + 1] + (sh[j1 + 1] - sh[j0 + 1]) * f) * g;
        q = t - 2 - s2.d1; k = Math.floor(q); f = q - k; j0 = (k & sm) << 1; j1 = ((k + 1) & sm) << 1; g = s2.g1;
        ql += (sh[j0] + (sh[j1] - sh[j0]) * f) * g; qr += (sh[j0 + 1] + (sh[j1 + 1] - sh[j0 + 1]) * f) * g;
        pl = 0.6 * (pl + ql); pr = 0.6 * (pr + qr);
      }
      // band-limit the shimmer path (cuts mud + fizz)
      ll += cLp * (pl - ll); lr += cLp * (pr - lr);
      hl += cHp * (ll - hl); hr += cHp * (lr - hr);
      yl = ll - hl; yr = lr - hr;
      const ay = Math.abs(yl) + Math.abs(yr);
      env += (ay - env) * (ay > env ? 0.01 : 0.0002);
      const ol = fl + yl * layer * 0.8, or = fr + yr * layer * 0.8;
      const mid = (ol + or) * 0.5, side = (ol - or) * 0.5 * wid;
      L[i] = SPC_safe(mid + side); R[i] = SPC_safe(mid - side);
      t = (t + 1) & 0x3fffffff;
    }
    this.t = t; K[10] = pd;
    st[0] = xf; st[1] = yl; st[2] = yr; st[3] = hl; st[4] = hr; st[5] = ll; st[6] = lr; st[7] = env;
  }
});

// ===========================================================================
// 6. GRAINVERB — FDN reverb rendered through scattered, pitched grains
// ===========================================================================
registerFX(class extends FX {
  static id = 'grainverb';
  static label = 'GRAINVERB';
  static cat = 'REVERB';
  static desc = 'FDN reverb whose tail is re-rendered as a cloud of scattered, pitched grains; DECAY above 99% freezes.';
  static params = [
    { id: 'size', label: 'SIZE', min: 0, max: 100, def: 55, unit: '%' },
    { id: 'grain', label: 'GRAIN', min: 20, max: 500, def: 140, unit: 'ms', curve: 'exp' },
    { id: 'scatter', label: 'SCATTER', min: 0, max: 100, def: 45, unit: '%' },
    { id: 'decay', label: 'DECAY', min: 0, max: 100, def: 70, unit: '%' },
    { id: 'pitch', label: 'PITCH', options: ['OFF', '+5TH', '+OCT', '-OCT', '±OCT', 'RND'], def: 0 },
    { id: 'density', label: 'DENSITY', min: 0, max: 100, def: 55, unit: '%' },
    { id: 'blend', label: 'BLEND', min: 0, max: 100, def: 70, unit: '%' },
    { id: 'tone', label: 'TONE', min: 800, max: 16000, def: 6000, unit: 'Hz', curve: 'exp' },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 80, unit: '%' },
  ];
  init() {
    const sr = this.sr;
    this.fdn = new SPC_FDN(sr, 1.8, this.fdn);
    const N = SPC_pow2(Math.ceil(2.6 * sr));
    this.bL = SPC_f32(this, 'bL', N); this.bR = SPC_f32(this, 'bR', N); this.mask = N - 1; this.w = 0;
    this.gr = new SPC_Grains(16); this.rng = new Rng(0x6a1f);
    this.next = 0; this.K = new Float64Array(16); this.xf = 0;
  }
  _ratio(mode) {
    const r = this.rng;
    switch (mode) {
      case 1: return r.chance(0.6) ? 1.4983071 : 1;
      case 2: return r.chance(0.6) ? 2 : 1;
      case 3: return r.chance(0.6) ? 0.5 : 1;
      case 4: { const u = r.next(); return u < 0.35 ? 0.5 : u < 0.7 ? 2 : 1; }
      case 5: { const u = r.int(6); return u === 0 ? 0.5 : u === 1 ? 0.7491535 : u === 2 ? 1.4983071 : u === 3 ? 2 : u === 4 ? 1.3348399 : 1; }
      default: return 1;
    }
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, K = this.K;
    const frz = p.decay >= 99;
    this.fdn.setup(0.35 + 1.45 * p.size * 0.01, frz ? Infinity : 0.35 * Math.pow(60, p.decay * 0.01), frz ? sr : p.tone, 0.3, n);
    K[0] = frz ? 1 : 0; K[1] = p.blend * 0.01;
    this._dsp(L, R, n);
    // grain scheduling happens at block rate (sub-block onset precision is not needed for a diffuse tail)
    const glen = p.grain * 0.001 * sr, ovl = 1 + p.density * 0.07, sc = p.scatter * 0.01, rng = this.rng;
    this.next -= n;
    let guard = 0;
    while (this.next <= 0 && guard++ < 8) {
      const ratio = this._ratio(p.pitch | 0);
      const back = 64 + (ratio > 1 ? (ratio - 1) * glen : 0) + sc * rng.next() * 1.2 * sr + rng.next() * glen * 0.5;
      const amp = 1.3 / Math.sqrt(ovl);
      this.gr.spawn(this.w - back, ratio, glen * (1 + sc * 0.4 * rng.bi()), 1, rng.bi() * p.width * 0.01 * (0.4 + 0.6 * sc), amp);
      this.next += glen / ovl * (1 + sc * 0.6 * rng.bi());
    }
  }
  _dsp(L, R, n) {
    const K = this.K, fdn = this.fdn, gr = this.gr, bL = this.bL, bR = this.bR, mask = this.mask;
    const frz = K[0], blend = K[1];
    let w = this.w, xf = this.xf;
    for (let i = 0; i < n; i++) {
      xf += (frz - xf) * 0.001;
      const g = (1 - xf) * 0.6;
      fdn.tick(L[i] * g, R[i] * g);
      const fl = fdn.oL * 0.3, fr = fdn.oR * 0.3;
      bL[w] = fl; bR[w] = fr; w = (w + 1) & mask;
      gr.tick(bL, bR, mask);
      L[i] = SPC_safe((fl * (1 - blend) + gr.oL * blend) * 1.4);
      R[i] = SPC_safe((fr * (1 - blend) + gr.oR * blend) * 1.4);
    }
    this.w = w; this.xf = xf;
  }
});

// ===========================================================================
// 7. PITCH — grain pitch shifter / frequency shifter / ring modulator
// ===========================================================================
const SPC_HB_A = [0.6923878, 0.9360654322959, 0.9882295226860, 0.9987488452737].map((a) => a * a);
const SPC_HB_B = [0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278].map((a) => a * a);
registerFX(class extends FX {
  static id = 'pitch';
  static label = 'PITCH';
  static cat = 'PITCH';
  static desc = 'Grain pitch shifter with stereo detune, delay/feedback cascades and tape-like spray; also frequency-shift and ring modes.';
  static params = [
    { id: 'semis', label: 'SEMIS', min: -24, max: 24, def: 12, curve: 'int', unit: 'st', bipolar: true },
    { id: 'fine', label: 'FINE', min: -100, max: 100, def: 0, bipolar: true },
    { id: 'mode', label: 'MODE', options: ['PITCH', 'FREQ', 'RING'], def: 0 },
    { id: 'spread', label: 'SPREAD', min: 0, max: 50, def: 8 },
    { id: 'delay', label: 'DELAY', min: 0, max: 1000, def: 0, unit: 'ms', curve: 'sq' },
    { id: 'fdbk', label: 'FDBK', min: 0, max: 95, def: 0, unit: '%' },
    { id: 'spray', label: 'SPRAY', min: 0, max: 100, def: 0, unit: '%' },
    { id: 'window', label: 'WINDOW', min: 10, max: 200, def: 70, unit: 'ms', curve: 'exp' },
    { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    { id: 'tone', label: 'TONE', min: -100, max: 100, def: 0, bipolar: true },
  ];
  init() {
    const sr = this.sr;
    const N = SPC_pow2(Math.ceil(1.5 * sr));
    this.bL = SPC_f32(this, 'bL', N); this.bR = SPC_f32(this, 'bR', N); this.mask = N - 1; this.w = 0;
    this.shL = new SPC_Shifter(21); this.shR = new SPC_Shifter(22);
    this.hb = new Float64Array(2 * 2 * 4 * 4); // [ch][branch][stage][x1,x2,y1,y2]
    this.hbd = new Float64Array(2);             // one-sample delay for branch A
    this.K = new Float64Array(24); this.st = new Float64Array(16); this.first = true;
    this.rng = new Rng(0x91c4); this.wob = 0; this.wobT = 0;
    this.cL = 1; this.sL = 0; this.cR = 1; this.sR = 0;
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, K = this.K, mode = p.mode | 0;
    let semis = p.semis;
    if (p.snap) semis = ctx.key.snapSemis(semis);
    const spray = p.spray * 0.01;
    if (this.rng.next() < n / sr * (2 + 6 * spray)) this.wobT = this.rng.bi();
    this.wob += (this.wobT - this.wob) * 0.04;
    const cents = semis * 100 + p.fine + this.wob * spray * 35;
    const winS = p.window * 0.001 * sr, dS = p.delay * 0.001 * sr;
    if (this.first) { K[12] = dS; K[13] = winS; this.first = false; }
    K[0] = mode;
    K[1] = Math.pow(2, (cents - p.spread * 0.5) / 1200); K[2] = Math.pow(2, (cents + p.spread * 0.5) / 1200);
    K[3] = (dS - K[12]) * 0.06 / n; K[4] = (winS - K[13]) * 0.1 / n;
    K[5] = spray * 0.5; K[6] = p.fdbk * 0.01;
    const tone = p.tone;
    K[7] = 1 - Math.exp(-TAU * (tone < 0 ? 12000 * Math.pow(2, tone * 0.05) : 14000) / sr);
    K[8] = 1 - Math.exp(-TAU * (tone > 0 ? 40 * Math.pow(2, tone * 0.06) : 30) / sr);
    // frequency shift / ring carrier
    let fL, fR;
    if (mode === 1) { const hz = semis * 25 + p.fine * 0.25 + this.wob * spray * 6; fL = hz - p.spread * 0.2; fR = hz + p.spread * 0.2; }
    else { let hz = 220 * Math.pow(2, (semis + p.fine * 0.01) / 12); if (p.snap) hz = ctx.key.snapHz(hz); fL = hz * Math.pow(2, -p.spread / 2400); fR = hz * Math.pow(2, p.spread / 2400); }
    K[9] = TAU * fL / sr; K[10] = TAU * fR / sr;
    // renormalise quadrature oscillators once per block
    let m = 1 / Math.hypot(this.cL, this.sL); this.cL *= m; this.sL *= m;
    m = 1 / Math.hypot(this.cR, this.sR); this.cR *= m; this.sR *= m;
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const K = this.K, st = this.st, bL = this.bL, bR = this.bR, mask = this.mask, shL = this.shL, shR = this.shR;
    const mode = K[0], rL = K[1], rR = K[2], dStep = K[3], wStep = K[4], jit = K[5], fb = K[6], cLp = K[7], cHp = K[8];
    const wcl = Math.cos(K[9]), wsl = Math.sin(K[9]), wcr = Math.cos(K[10]), wsr = Math.sin(K[10]);
    const hb = this.hb, A = SPC_HB_A, B = SPC_HB_B;
    let dly = K[12], win = K[13], w = this.w, cL = this.cL, sL = this.sL, cR = this.cR, sR = this.sR;
    let yl = st[0], yr = st[1], ll = st[2], lr = st[3], hl = st[4], hr = st[5], dA0 = this.hbd[0], dA1 = this.hbd[1];
    for (let i = 0; i < n; i++) {
      dly += dStep; win += wStep;
      // feedback tone + soft clip, write history
      ll += cLp * (yl - ll); lr += cLp * (yr - lr); hl += cHp * (ll - hl); hr += cHp * (lr - hr);
      bL[w] = L[i] + fb * fastTanh(ll - hl); bR[w] = R[i] + fb * fastTanh(lr - hr);
      if (mode === 0) {
        shL.step(rL, win, jit * win); shR.step(rR, win, jit * win);
        const b0 = w - 1 - dly;
        yl = SPC_rd(bL, mask, b0 - shL.d0) * shL.g0 + SPC_rd(bL, mask, b0 - shL.d1) * shL.g1;
        yr = SPC_rd(bR, mask, b0 - shR.d0) * shR.g0 + SPC_rd(bR, mask, b0 - shR.d1) * shR.g1;
      } else {
        const xl = dly < 1 ? bL[w] : SPC_rd(bL, mask, w - dly), xr = dly < 1 ? bR[w] : SPC_rd(bR, mask, w - dly);
        // advance quadrature oscillators
        let t = cL * wcl - sL * wsl; sL = sL * wcl + cL * wsl; cL = t;
        t = cR * wcr - sR * wsr; sR = sR * wcr + cR * wsr; cR = t;
        if (mode === 2) { yl = xl * sL; yr = xr * sR; }
        else {
          // Hilbert pair (two 4-stage allpass chains per channel)
          let a = xl, b = xl, c = xr, d = xr;
          for (let s = 0; s < 4; s++) {
            let o = s * 4; let y = A[s] * (a + hb[o + 3]) - hb[o + 1]; hb[o + 1] = hb[o]; hb[o] = a; hb[o + 3] = hb[o + 2]; hb[o + 2] = y; a = y;
            o = 16 + s * 4; y = B[s] * (b + hb[o + 3]) - hb[o + 1]; hb[o + 1] = hb[o]; hb[o] = b; hb[o + 3] = hb[o + 2]; hb[o + 2] = y; b = y;
            o = 32 + s * 4; y = A[s] * (c + hb[o + 3]) - hb[o + 1]; hb[o + 1] = hb[o]; hb[o] = c; hb[o + 3] = hb[o + 2]; hb[o + 2] = y; c = y;
            o = 48 + s * 4; y = B[s] * (d + hb[o + 3]) - hb[o + 1]; hb[o + 1] = hb[o]; hb[o] = d; hb[o + 3] = hb[o + 2]; hb[o + 2] = y; d = y;
          }
          const reL = dA0, reR = dA1; dA0 = a; dA1 = c;  // branch A delayed one sample
          yl = reL * cL + b * sL; yr = reR * cR + d * sR;
        }
      }
      w = (w + 1) & mask;
      L[i] = SPC_safe(yl); R[i] = SPC_safe(yr);
    }
    this.w = w; this.cL = cL; this.sL = sL; this.cR = cR; this.sR = sR; this.hbd[0] = dA0; this.hbd[1] = dA1;
    K[12] = dly; K[13] = win; st[0] = yl; st[1] = yr; st[2] = ll; st[3] = lr; st[4] = hl; st[5] = hr;
  }
});

// ===========================================================================
// 8. CLOUD — granular cloud from a rolling buffer
// ===========================================================================
const SPC_CLOUD_IV = [12, -12, 7, -5, 5, 19, -7, 24];
registerFX(class extends FX {
  static id = 'cloud';
  static label = 'CLOUD';
  static cat = 'GRANULAR';
  static desc = 'Granular cloud: clocked grains that pitch, reverse, scatter, scramble and freeze the recent past.';
  static params = [
    { id: 'size', label: 'SIZE', div: ['1/2', '1/64'], def: '1/16' },
    { id: 'density', label: 'DENSITY', min: 0, max: 100, def: 50, unit: '%' },
    { id: 'pitch', label: 'PITCH', min: -24, max: 24, def: 0, curve: 'int', unit: 'st', bipolar: true },
    { id: 'prnd', label: 'PITCH RND', min: 0, max: 100, def: 25, unit: '%' },
    { id: 'reverse', label: 'REVERSE', min: 0, max: 100, def: 20, unit: '%' },
    { id: 'spray', label: 'SPRAY', min: 0, max: 100, def: 35, unit: '%' },
    { id: 'freeze', label: 'FREEZE', toggle: true, def: 0 },
    { id: 'scramble', label: 'SCRAMBLE', min: 0, max: 100, def: 0, unit: '%' },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 70, unit: '%' },
    { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    { id: 'sync', label: 'SYNC', toggle: true, def: 1 },
    { id: 'ms', label: 'FREE', min: 10, max: 1000, def: 90, unit: 'ms', curve: 'exp' },
  ];
  init() {
    const sr = this.sr;
    const N = SPC_pow2(Math.ceil(8 * sr));
    this.bL = SPC_f32(this, 'bL', N); this.bR = SPC_f32(this, 'bR', N); this.mask = N - 1; this.N = N; this.w = 0;
    this.gr = new SPC_Grains(24); this.rng = new Rng(0xc10d);
    this.ev = new Int32Array(16); this.lastTick = -1; this.next = 0; this.frz = 0; this.extra = 0;
  }
  _spawn(p, ctx, len, ovl, at) {
    const rng = this.rng, sr = this.sr;
    let semis = p.pitch;
    if (rng.chance(p.prnd * 0.01)) semis += SPC_CLOUD_IV[rng.int(p.prnd > 60 ? 8 : 5)];
    if (p.snap) semis = ctx.key.snapSemis(semis);
    semis = clamp(semis, -36, 36);
    const ratio = Math.pow(2, semis / 12);
    const rev = rng.chance(p.reverse * 0.01);
    const sp = p.spray * 0.01;
    let back = 32 + (!rev && ratio > 1 ? (ratio - 1) * len : 0) + sp * sp * rng.next() * 2 * sr;
    if (rng.chance(p.scramble * 0.01)) back += (1 + rng.int(8)) * len;
    back = Math.min(back, this.N - len * (ratio + 1) - 64);
    const now = this.w + at;
    this.gr.spawn(now - back, rev ? -ratio : ratio, len, 1, rng.bi() * p.width * 0.01, 1.15 / Math.sqrt(Math.max(1, ovl * 0.7)));
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, spb = ctx.spb;
    const ovl = 1 + p.density * 0.07;
    const len = clamp(p.sync ? p.size * spb : p.ms * 0.001 * sr, 64, 2 * sr);
    let ne = 0;
    if (p.sync) {
      // onsets on the ppq grid: step = SIZE / 2^k (k from density); the fractional rest of the
      // overlap becomes a chance of an extra grain on each tick
      const q = Math.pow(2, Math.floor(Math.log2(ovl)));
      const step = p.size / q;
      this.extra = ovl / q - 1;
      const p0 = ctx.ppq, p1 = ctx.ppq + n / spb;
      let k = Math.floor(p0 / step);
      if (this.lastTick < 0 || k < this.lastTick - 1) this.lastTick = k - 1; // start / transport jumped back
      for (let j = k; j * step < p1 && ne < 16; j++) {
        if (j <= this.lastTick) continue;
        const at = Math.max(0, Math.min(n - 1, Math.round((j * step - p0) * spb)));
        this.ev[ne++] = at; this.lastTick = j;
      }
    } else {
      this.lastTick = -1;
      while (this.next < n && ne < 16) { this.ev[ne++] = Math.max(0, this.next | 0); this.next += len / ovl * (1 + 0.5 * p.spray * 0.01 * this.rng.bi()); }
      this.next -= n;
    }
    this.frz = p.freeze ? 1 : 0;
    let i0 = 0;
    for (let e = 0; e < ne; e++) {
      const at = this.ev[e];
      if (at > i0) { this._dsp(L, R, i0, at); i0 = at; }
      this._spawn(p, ctx, len, ovl, 0);
      // density can ask for several grains per tick in sync mode when overlap is fractional
      if (p.sync && this.rng.chance(this.extra)) this._spawn(p, ctx, len, ovl, 0);
    }
    if (i0 < n) this._dsp(L, R, i0, n);
  }
  _dsp(L, R, from, to) {
    const bL = this.bL, bR = this.bR, mask = this.mask, gr = this.gr, frz = this.frz;
    let w = this.w;
    for (let i = from; i < to; i++) {
      if (!frz) { bL[w] = L[i]; bR[w] = R[i]; w = (w + 1) & mask; }
      gr.tick(bL, bR, mask);
      L[i] = SPC_safe(gr.oL); R[i] = SPC_safe(gr.oR);
    }
    this.w = w;
  }
});

// ===========================================================================
// 9. RESONATE — playable resonator bank tuned to the global scale
// ===========================================================================
const SPC_RES_MAX = 33;
registerFX(class extends FX {
  static id = 'resonate';
  static label = 'RESONATE';
  static cat = 'RESONATOR';
  static desc = 'Bank of up to 33 two-pole resonators tuned to the global key/scale, with wander, skew, tilt and a voice arpeggiator.';
  static params = [
    { id: 'octaves', label: 'OCTAVES', min: 1, max: 4, def: 3, curve: 'int' },
    { id: 'focus', label: 'FOCUS', min: 4, max: 400, def: 60, curve: 'exp' },
    { id: 'bloom', label: 'BLOOM', min: 0, max: 100, def: 30, unit: '%' },
    { id: 'skew', label: 'SKEW', min: -100, max: 100, def: 0, bipolar: true },
    { id: 'wander', label: 'WANDER', min: 0, max: 100, def: 15, unit: '%' },
    { id: 'color', label: 'COLOR', min: -100, max: 100, def: 0, bipolar: true },
    { id: 'arprate', label: 'ARP RATE', div: ['1/1', '1/32'], def: '1/16' },
    { id: 'arpmode', label: 'ARP MODE', options: ['OFF', 'UP', 'DOWN', 'RANDOM'], def: 0 },
    { id: 'spread', label: 'SPREAD', min: 0, max: 100, def: 60, unit: '%' },
    { id: 'base', label: 'BASE OCT', min: 1, max: 5, def: 2, curve: 'int' },
  ];
  init() {
    const M = SPC_RES_MAX;
    this.midi = new Float32Array(M); this.nv = 0; this.keyRef = null; this.keyOct = -1; this.keyBase = -1;
    this.c1 = new Float64Array(M); this.c2 = new Float64Array(M); this.b = new Float64Array(M);
    this.y1 = new Float64Array(M); this.y2 = new Float64Array(M);
    this.g = new Float64Array(M); this.gStep = new Float64Array(M); this.env = new Float64Array(M);
    this.pl = new Float64Array(M); this.pr = new Float64Array(M); this.ps = new Float64Array(M);
    this.drift = new Float64Array(M); this.driftT = new Float64Array(M);
    this.rng = new Rng(0x2e50); this.arpIdx = -1; this.lastStep = -1; this.cur = 0;
    for (let v = 0; v < M; v++) this.env[v] = 1;
  }
  _voices(key, base, oct) {
    const lo = 12 * (base + 1) + key.root, hi = lo + 12 * oct;
    let nv = 0;
    for (let m = lo; m <= hi && nv < SPC_RES_MAX; m++) {
      if (key.intervals.indexOf(((m - key.root) % 12 + 12) % 12) >= 0) this.midi[nv++] = m;
    }
    this.nv = nv; this.keyRef = key.notes; this.keyOct = oct; this.keyBase = base;
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, key = ctx.key, oct = p.octaves | 0, base = p.base | 0;
    if (key.notes !== this.keyRef || oct !== this.keyOct || base !== this.keyBase) this._voices(key, base, oct);
    const nv = this.nv, rng = this.rng, bloom = p.bloom * 0.01, wander = p.wander * 0.01;
    const Q = p.focus * (1 + 2.5 * bloom);
    const sk = p.skew * 0.01 * 0.06, col = p.color * 0.01, sp = p.spread * 0.01;
    // arpeggiator (grid-locked emphasis of one voice)
    const mode = p.arpmode | 0;
    if (mode > 0) {
      const step = Math.floor((ctx.ppq + n * 0.5 / ctx.spb) / p.arprate);
      if (step !== this.lastStep) {
        this.lastStep = step;
        if (mode === 1) this.cur = (this.cur + 1) % nv;
        else if (mode === 2) this.cur = (this.cur - 1 + nv) % nv;
        else { let c = rng.int(nv); if (c === this.cur && nv > 1) c = (c + 1) % nv; this.cur = c; }
      }
    }
    const tAtk = 0.004 + bloom * 0.25, tRel = 0.03 + bloom * 1.2;
    const kA = 1 - Math.exp(-n / (tAtk * sr)), kR = 1 - Math.exp(-n / (tRel * sr));
    const lo = this.midi[0], span = Math.max(1, this.midi[nv - 1] - lo);
    let norm = 0;
    for (let v = 0; v < nv; v++) {
      // wander: smoothed random drift per voice (cents)
      if (rng.next() < n / sr * 0.8) this.driftT[v] = rng.bi();
      this.drift[v] += (this.driftT[v] - this.drift[v]) * 0.01;
      const rel = (this.midi[v] - lo) / 12;
      let m = this.midi[v] + this.drift[v] * wander * 0.35 + sk * rel * rel * 12;
      const f = Math.min(mtof(m), sr * 0.45);
      const w = TAU * f / sr, r = Math.exp(-Math.PI * f / (Q * sr));
      this.c1[v] = 2 * r * Math.cos(w); this.c2[v] = r * r;
      const tilt = Math.pow(2, col * 2.5 * ((this.midi[v] - lo) / span - 0.5));
      const pk = (1 - r) * Math.sqrt(1 - 2 * r * Math.cos(2 * w) + r * r); // unity peak
      this.b[v] = pk * tilt * Math.sqrt(Q) * 0.55;
      // arp envelope
      const tgt = mode === 0 ? 1 : (v === this.cur ? 1.6 : 0.06);
      const e0 = this.env[v], e1 = e0 + (tgt - e0) * (tgt > e0 ? kA : kR);
      this.env[v] = e1; this.gStep[v] = (e1 - e0) / n; this.g[v] = e0;
      const pan = nv === 1 ? 0 : sp * ((v & 1) ? 1 : -1) * (0.35 + 0.65 * ((v * 7) % nv) / nv);
      this.pl[v] = Math.sqrt(0.5 * (1 - pan)); this.pr[v] = Math.sqrt(0.5 * (1 + pan)); this.ps[v] = pan;
      norm += tilt;
    }
    this.outG = 2.6 / Math.sqrt(Math.max(1, norm));
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const nv = this.nv, c1 = this.c1, c2 = this.c2, b = this.b, y1 = this.y1, y2 = this.y2, g = this.g, gs = this.gStep;
    const pl = this.pl, pr = this.pr, ps = this.ps, og = this.outG;
    for (let i = 0; i < n; i++) {
      const xm = (L[i] + R[i]) * 0.5, xs = (L[i] - R[i]) * 0.5;
      let oL = 0, oR = 0;
      for (let v = 0; v < nv; v++) {
        const y = b[v] * (xm + ps[v] * xs) + c1[v] * y1[v] - c2[v] * y2[v];
        y2[v] = y1[v]; y1[v] = y;
        const gv = g[v] + gs[v]; g[v] = gv;
        const o = y * gv;
        oL += o * pl[v]; oR += o * pr[v];
      }
      L[i] = SPC_safe(oL * og); R[i] = SPC_safe(oR * og);
    }
  }
});

// ===========================================================================
// 10. STRIKE — modal resonator (wood -> metal -> glass)
// ===========================================================================
const SPC_MODES = 20;
const SPC_MOD_WOOD = [], SPC_MOD_METAL = [1, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501, 3.6, 4.06, 4.154, 4.601, 4.903, 5.131, 5.412, 5.651, 5.951, 6.21, 6.4, 6.82], SPC_MOD_GLASS = [];
for (let k = 1; k <= SPC_MODES; k++) { SPC_MOD_WOOD.push(Math.pow((2 * k + 1) / 3, 2) * (k === 1 ? 1 : 0.98)); SPC_MOD_GLASS.push(k * (1 + 0.0025 * (k - 1) * (k - 1))); }
registerFX(class extends FX {
  static id = 'strike';
  static label = 'STRIKE';
  static cat = 'RESONATOR';
  static desc = 'Struck modal resonator with 20 modes morphing from wood through metal to glass.';
  static params = [
    { id: 'tune', label: 'TUNE', min: 24, max: 96, def: 45, curve: 'int' }, // MIDI note (45 = A2)
    { id: 'decay', label: 'DECAY', min: 0.05, max: 10, def: 1.2, unit: 's', curve: 'exp' },
    { id: 'material', label: 'MATERIAL', min: 0, max: 100, def: 45, unit: '%' },
    { id: 'position', label: 'POSITION', min: 0, max: 100, def: 30, unit: '%' },
    { id: 'bright', label: 'BRIGHT', min: 0, max: 100, def: 60, unit: '%' },
    { id: 'stretch', label: 'STRETCH', min: -100, max: 100, def: 0, bipolar: true },
    { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 60, unit: '%' },
  ];
  init() {
    const M = SPC_MODES;
    this.c1 = new Float64Array(M); this.c2 = new Float64Array(M); this.b = new Float64Array(M); this.bt = new Float64Array(M);
    this.y1 = new Float64Array(M); this.y2 = new Float64Array(M); this.pl = new Float64Array(M); this.pr = new Float64Array(M);
    this.nm = 0; this.pv = new Float64Array(8); this.pv[0] = -1; this.first = true;
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr;
    let tune = p.tune; if (p.snap) tune = ctx.key.snapMidi(tune);
    const pv = this.pv;
    if (pv[0] !== tune || pv[1] !== p.decay || pv[2] !== p.material || pv[3] !== p.position || pv[4] !== p.bright || pv[5] !== p.stretch || pv[6] !== p.width) {
      pv[0] = tune; pv[1] = p.decay; pv[2] = p.material; pv[3] = p.position; pv[4] = p.bright; pv[5] = p.stretch; pv[6] = p.width;
      const f0 = mtof(tune), mat = p.material * 0.01, br = p.bright * 0.01, pos = 0.07 + 0.43 * p.position * 0.01, st = p.stretch * 0.01;
      let nm = 0, norm = 0;
      for (let k = 0; k < SPC_MODES; k++) {
        let ratio, damp;
        if (mat < 0.5) { const t = mat * 2; ratio = Math.exp(lerp(Math.log(SPC_MOD_WOOD[k]), Math.log(SPC_MOD_METAL[k]), t)); damp = lerp(1 / (1 + 1.1 * k), 1 / (1 + 0.18 * k), t) * lerp(0.45, 1, t); }
        else { const t = (mat - 0.5) * 2; ratio = Math.exp(lerp(Math.log(SPC_MOD_METAL[k]), Math.log(SPC_MOD_GLASS[k]), t)); damp = lerp(1 / (1 + 0.18 * k), 1.6 / (1 + 0.06 * k), t); }
        ratio *= 1 + st * 0.0009 * k * k;
        const f = f0 * ratio;
        if (f > sr * 0.45 || f < 20) continue;
        const t60 = Math.max(0.01, p.decay * damp * (0.4 + 0.6 * br + (1 - br) * 0.6 / (1 + 0.3 * k)));
        const r = Math.exp(-6.91 / (t60 * sr)), w = TAU * f / sr;
        let a = Math.abs(Math.sin(Math.PI * (k + 1) * pos)) * Math.pow(k + 1, -(1 - br) * 1.4) * (0.3 + 0.7 * br);
        this.c1[nm] = 2 * r * Math.cos(w); this.c2[nm] = r * r;
        this.bt[nm] = a * Math.sin(w) * Math.sqrt(1 - r) * 3.2;
        const pan = p.width * 0.01 * ((nm & 1) ? 1 : -1) * Math.min(1, 0.3 + nm * 0.12);
        this.pl[nm] = Math.sqrt(0.5 * (1 - pan)); this.pr[nm] = Math.sqrt(0.5 * (1 + pan));
        norm += a; nm++;
      }
      for (let k = nm; k < this.nm; k++) { this.y1[k] = 0; this.y2[k] = 0; }
      this.nm = nm; this.og = 0.32 / Math.max(0.6, Math.sqrt(norm));
      if (this.first) { this.b.set(this.bt); this.first = false; }
    }
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const nm = this.nm, c1 = this.c1, c2 = this.c2, b = this.b, bt = this.bt, y1 = this.y1, y2 = this.y2, pl = this.pl, pr = this.pr, og = this.og;
    for (let k = 0; k < nm; k++) b[k] += (bt[k] - b[k]) * 0.3; // soften excitation-gain jumps
    for (let i = 0; i < n; i++) {
      const x = (L[i] + R[i]) * 0.5;
      let oL = 0, oR = 0;
      for (let k = 0; k < nm; k++) {
        const y = b[k] * x + c1[k] * y1[k] - c2[k] * y2[k];
        y2[k] = y1[k]; y1[k] = y;
        oL += y * pl[k]; oR += y * pr[k];
      }
      L[i] = SPC_safe(oL * og); R[i] = SPC_safe(oR * og);
    }
  }
});

// ===========================================================================
// 11. HARP — sympathetic Karplus-Strong strings on the global chord
// ===========================================================================
registerFX(class extends FX {
  static id = 'harp';
  static label = 'HARP';
  static cat = 'RESONATOR';
  static desc = 'Up to six sympathetic plucked strings tuned to the global chord, excited (or bowed) by the input.';
  static params = [
    { id: 'strings', label: 'STRINGS', min: 1, max: 6, def: 4, curve: 'int' },
    { id: 'octave', label: 'OCTAVE', min: 1, max: 5, def: 3, curve: 'int' },
    { id: 'damp', label: 'DAMP', min: 0, max: 100, def: 35, unit: '%' },
    { id: 'bright', label: 'BRIGHT', min: 0, max: 100, def: 55, unit: '%' },
    { id: 'couple', label: 'COUPLE', min: 0, max: 100, def: 25, unit: '%' },
    { id: 'position', label: 'POSITION', min: 0, max: 100, def: 25, unit: '%' },
    { id: 'bow', label: 'BOW', min: 0, max: 100, def: 0, unit: '%' },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 70, unit: '%' },
  ];
  init() {
    const sr = this.sr;
    this.SN = SPC_pow2(Math.ceil(sr / 30) + 8); this.sm = this.SN - 1;
    this.buf = SPC_f32(this, 'buf', this.SN * 6); this.w = 0;
    this.P = new Float64Array(6); this.Pt = new Float64Array(6); this.Pstep = new Float64Array(6);
    this.g = new Float64Array(6); this.lp = new Float64Array(6); this.y = new Float64Array(6);
    this.pl = new Float64Array(6); this.pr = new Float64Array(6);
    this.chordRef = null; this.oct = -1; this.first = true;
    this.K = new Float64Array(16); this.st = new Float64Array(8); this.st[7] = 0x2468ace;
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, key = ctx.key, K = this.K, ns = p.strings | 0, oct = p.octave | 0;
    if (key.chord !== this.chordRef || oct !== this.oct) {
      this.chordRef = key.chord; this.oct = oct;
      const ch = key.chord, cl = ch.length;
      for (let s = 0; s < 6; s++) {
        const m = 12 * (oct + 1) + key.root + ch[s % cl] + 12 * Math.floor(s / cl);
        this.Pt[s] = clamp(sr / mtof(m), 8, this.SN - 8);
      }
      if (this.first) { this.P.set(this.Pt); this.first = false; }
    }
    const bright = p.bright * 0.01;
    const lpHz = Math.min(sr * 0.45, 1200 * Math.pow(2, bright * 4.2));
    const c = 1 - Math.exp(-TAU * lpHz / sr);
    const t60 = 9 * Math.pow(2, -p.damp * 0.065);
    for (let s = 0; s < 6; s++) {
      const P = this.P[s], np = P + (this.Pt[s] - P) * 0.15;  // glide on chord changes
      this.Pstep[s] = (np - P) / n;
      this.g[s] = Math.pow(10, -3 * P / (sr * t60));
      const pan = ns === 1 ? 0 : p.width * 0.01 * (-1 + 2 * s / Math.max(1, ns - 1));
      this.pl[s] = Math.sqrt(0.5 * (1 - pan)); this.pr[s] = Math.sqrt(0.5 * (1 + pan));
    }
    K[0] = ns; K[1] = c; K[2] = (1 - c) / c;                   // loop LP + its phase delay (samples)
    K[3] = p.couple * 0.01 * 0.12; K[4] = 0.04 + 0.46 * p.position * 0.01; K[5] = p.bow * 0.01;
    K[6] = 1 - Math.exp(-TAU * (500 + 9000 * bright) / sr);     // excitation brightness
    K[7] = 1 / Math.sqrt(ns);
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const K = this.K, st = this.st, buf = this.buf, SN = this.SN, sm = this.sm;
    const P = this.P, Ps = this.Pstep, g = this.g, lp = this.lp, y = this.y, pl = this.pl, pr = this.pr;
    const ns = K[0], c = K[1], lpd = K[2], cpl = K[3], pos = K[4], bow = K[5], ce = K[6], og = K[7];
    let w = this.w, ex = st[0], env = st[1], bus = st[2], seed = st[7];
    for (let i = 0; i < n; i++) {
      const x = (L[i] + R[i]) * 0.5;
      const ax = x < 0 ? -x : x; env += (ax - env) * (ax > env ? 0.01 : 0.0003);
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const nz = seed * 4.656612873e-10 - 1;
      ex += ce * (x * 0.35 + nz * env * bow * 0.6 - ex);       // excitation (input + bow friction noise)
      let oL = 0, oR = 0, nb = 0;
      for (let s = 0; s < ns; s++) {
        const Pp = P[s] + Ps[s]; P[s] = Pp;
        const o = s * SN, rp = w - Pp + lpd;
        const k = Math.floor(rp), f = rp - k, a = buf[o + (k & sm)];
        const yd = a + (buf[o + ((k + 1) & sm)] - a) * f;
        lp[s] += c * (yd - lp[s]);
        const v = fastTanh(lp[s] * g[s] + ex + cpl * (bus - y[s]));
        buf[o + w] = v; y[s] = v; nb += v;
        // pickup position (comb) -> output
        const q = w - Pp * pos, kq = Math.floor(q), fq = q - kq, b = buf[o + (kq & sm)];
        const out = v - (b + (buf[o + ((kq + 1) & sm)] - b) * fq);
        oL += out * pl[s]; oR += out * pr[s];
      }
      bus = nb / ns;
      w = (w + 1) & sm;
      L[i] = SPC_safe(oL * og * 1.15); R[i] = SPC_safe(oR * og * 1.15);
    }
    this.w = w; st[0] = ex; st[1] = env; st[2] = bus; st[7] = seed;
  }
});

// ===========================================================================
// 12. HARMONY — three-voice scale harmonizer
// ===========================================================================
registerFX(class extends FX {
  static id = 'harmony';
  static label = 'HARMONY';
  static cat = 'PITCH';
  static desc = 'Three pitch-shifted voices that follow the input pitch and land on scale degrees of the global key.';
  static params = [
    { id: 'v1', label: 'V1', min: -14, max: 14, def: 2, curve: 'int', bipolar: true },
    { id: 'v2', label: 'V2', min: -14, max: 14, def: 4, curve: 'int', bipolar: true },
    { id: 'v3', label: 'V3', min: -14, max: 14, def: -7, curve: 'int', bipolar: true },
    { id: 'level', label: 'LEVEL', min: 0, max: 100, def: 70, unit: '%' },
    { id: 'glide', label: 'GLIDE', min: 0, max: 1000, def: 40, unit: 'ms', curve: 'sq' },
    { id: 'loose', label: 'LOOSE', min: 0, max: 100, def: 15, unit: '%' },
    { id: 'stagger', label: 'STAGGER', min: 0, max: 100, def: 0, unit: '%' },
    { id: 'fdbk', label: 'FDBK', min: 0, max: 90, def: 0, unit: '%' },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 70, unit: '%' },
  ];
  init() {
    const sr = this.sr;
    const N = SPC_pow2(Math.ceil(1.2 * sr));
    this.b = SPC_f32(this, 'b', N); this.mask = N - 1; this.w = 0;
    this.sh = [new SPC_Shifter(31), new SPC_Shifter(32), new SPC_Shifter(33)];
    this.iv = new Float64Array(3); this.ivS = new Float64Array(3); this.ivStep = new Float64Array(3);
    this.dl = new Float64Array(3); this.dlStep = new Float64Array(3);
    this.dr = new Float64Array(3); this.drT = new Float64Array(3); this.jt = new Float64Array(3); this.jtT = new Float64Array(3);
    this.ratio = new Float64Array(3); this.pl = new Float64Array(3); this.pr = new Float64Array(3);
    this.rng = new Rng(0x4a2d);
    // pitch tracker state
    this.trk = new Float64Array(8); this.inMidi = -1; this.first = true;
    this.K = new Float64Array(8);
  }
  _interval(key, d) {
    const notes = key.notes;
    if (this.inMidi < 0) return key.degreeSemis(d);
    const m = key.snapMidi(this.inMidi);
    let idx = 0; while (idx < notes.length - 1 && notes[idx] < m) idx++;
    const j = clamp(idx + d, 0, notes.length - 1);
    return notes[j] - m;
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, key = ctx.key, rng = this.rng, K = this.K;
    // pitch estimate from the tracker (period between rising zero crossings)
    const per = this.trk[4];
    if (per > 0 && this.trk[5] > 0.01) {
      const f = sr / per;
      if (f > 60 && f < 1200) this.inMidi = this.inMidi < 0 ? ftom(f) : this.inMidi + (ftom(f) - this.inMidi) * 0.5;
    }
    const kg = 1 - Math.exp(-n / (Math.max(1, p.glide) * 0.001 * sr));
    const loose = p.loose * 0.01, wd = p.width * 0.01;
    for (let v = 0; v < 3; v++) {
      const tgt = this._interval(key, (v === 0 ? p.v1 : v === 1 ? p.v2 : p.v3) | 0);
      if (this.first) this.ivS[v] = tgt;
      const ns = this.ivS[v] + (tgt - this.ivS[v]) * kg;
      this.ivStep[v] = (ns - this.ivS[v]) / n;
      if (rng.next() < n / sr * 1.2) { this.drT[v] = rng.bi(); this.jtT[v] = rng.next(); }
      this.dr[v] += (this.drT[v] - this.dr[v]) * 0.02; this.jt[v] += (this.jtT[v] - this.jt[v]) * 0.01;
      this.ratio[v] = this.dr[v] * loose * 0.3; // semitone humanize offset
      const dTgt = (v * p.stagger * 0.01 * 0.25 * ctx.spb) + this.jt[v] * loose * 0.03 * sr;
      if (this.first) this.dl[v] = dTgt;
      this.dlStep[v] = (dTgt - this.dl[v]) * 0.05 / n;
      const pan = v === 0 ? -wd : v === 1 ? wd : 0;
      this.pl[v] = Math.sqrt(0.5 * (1 - pan)); this.pr[v] = Math.sqrt(0.5 * (1 + pan));
    }
    this.first = false;
    K[0] = p.level * 0.01; K[1] = p.fdbk * 0.01; K[2] = Math.round(0.045 * sr);
    K[3] = 1 - Math.exp(-TAU * 900 / sr);
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const K = this.K, b = this.b, mask = this.mask, sh = this.sh, s0 = sh[0], s1 = sh[1], s2 = sh[2];
    const ivS = this.ivS, ivStep = this.ivStep, dl = this.dl, dlStep = this.dlStep, hum = this.ratio, pl = this.pl, pr = this.pr, trk = this.trk;
    const level = K[0], fb = K[1], win = K[2], cT = K[3];
    let w = this.w, last = trk[6];
    let l1 = trk[0], l2 = trk[1], cnt = trk[2], arm = trk[3], per = trk[4], lev = trk[5];
    const c0 = Math.LN2 / 12;
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i], x = (xl + xr) * 0.5;
      // --- pitch tracker: 2-pole LP, hysteresis zero-crossing period ---
      l1 += cT * (x - l1); l2 += cT * (l1 - l2);
      const al = l2 < 0 ? -l2 : l2; lev += (al - lev) * 0.001;
      cnt++;
      if (l2 < -lev * 0.3) arm = 1;
      else if (arm && l2 > lev * 0.3) { arm = 0; if (cnt > 30 && cnt < 900) per = per > 0 ? per * 0.7 + cnt * 0.3 : cnt; cnt = 0; }
      if (cnt > 2000) { cnt = 2000; per = 0; }
      // --- voices ---
      b[w] = x + fb * fastTanh(last);
      ivS[0] += ivStep[0]; ivS[1] += ivStep[1]; ivS[2] += ivStep[2];
      dl[0] += dlStep[0]; dl[1] += dlStep[1]; dl[2] += dlStep[2];
      s0.step(Math.exp((ivS[0] + hum[0]) * c0), win, 0);
      s1.step(Math.exp((ivS[1] + hum[1]) * c0), win, 0);
      s2.step(Math.exp((ivS[2] + hum[2]) * c0), win, 0);
      const p0 = w - 1 - dl[0], p1 = w - 1 - dl[1], p2 = w - 1 - dl[2];
      const v0 = SPC_rd(b, mask, p0 - s0.d0) * s0.g0 + SPC_rd(b, mask, p0 - s0.d1) * s0.g1;
      const v1 = SPC_rd(b, mask, p1 - s1.d0) * s1.g0 + SPC_rd(b, mask, p1 - s1.d1) * s1.g1;
      const v2 = SPC_rd(b, mask, p2 - s2.d0) * s2.g0 + SPC_rd(b, mask, p2 - s2.d1) * s2.g1;
      last = (v0 + v1 + v2) * 0.4;
      w = (w + 1) & mask;
      const hl = (v0 * pl[0] + v1 * pl[1] + v2 * pl[2]) * level * 0.8, hr = (v0 * pr[0] + v1 * pr[1] + v2 * pr[2]) * level * 0.8;
      L[i] = SPC_safe(xl * 0.8 + hl); R[i] = SPC_safe(xr * 0.8 + hr);
    }
    this.w = w; trk[0] = l1; trk[1] = l2; trk[2] = cnt; trk[3] = arm; trk[4] = per; trk[5] = lev; trk[6] = last;
  }
});

// ===========================================================================
// 13. GRAINDELAY — two grain readers into a long history
// ===========================================================================
const SPC_GD_IV = [12, -12, 7, -5, 5, -7, 24, -24];
registerFX(class extends FX {
  static id = 'graindelay';
  static label = 'GRAINDELAY';
  static cat = 'DELAY';
  static desc = 'Granular delay: two windowed readers pull pitched, sprayed and reversed grains from an 8 s history.';
  static params = [
    { id: 'time', label: 'TIME', div: ['2/1', '1/32'], def: '1/4' },
    { id: 'feedback', label: 'FEEDBACK', min: 0, max: 100, def: 40, unit: '%' },
    { id: 'pitch', label: 'PITCH', min: -36, max: 12, def: 0, curve: 'int', unit: 'st', bipolar: true },
    { id: 'spray', label: 'SPRAY', min: 0, max: 100, def: 20, unit: '%' },
    { id: 'random', label: 'RANDOM', min: 0, max: 100, def: 15, unit: '%' },
    { id: 'reverse', label: 'REVERSE', min: 0, max: 100, def: 10, unit: '%' },
    { id: 'size', label: 'SIZE', min: 20, max: 500, def: 100, unit: 'ms', curve: 'exp' },
    { id: 'tone', label: 'TONE', min: -100, max: 100, def: 0, bipolar: true },
    { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 60, unit: '%' },
    { id: 'sync', label: 'SYNC', toggle: true, def: 1 },
    { id: 'ms', label: 'FREE', min: 10, max: 4000, def: 500, unit: 'ms', curve: 'exp' },
  ];
  init() {
    const sr = this.sr;
    const N = SPC_pow2(Math.ceil(8.4 * sr));
    this.bL = SPC_f32(this, 'bL', N); this.bR = SPC_f32(this, 'bR', N); this.mask = N - 1; this.N = N; this.w = 0;
    this.ph = new Float64Array([0, 0.5]); this.pos = new Float64Array(2); this.inc = new Float64Array(2);
    this.ll = new Float32Array(2); this.rl = new Float32Array(2); this.rr = new Float32Array(2); this.lr = new Float32Array(2);
    this.rng = new Rng(0x6d31); this.K = new Float64Array(16); this.st = new Float64Array(8); this.pend = 0;
    this.par = new Float64Array(12);
  }
  // choose a new grain for reader k (called from the kernel on window wrap)
  _grain(k, w) {
    const P = this.par, rng = this.rng, G = P[0];
    let semis = P[1];
    if (rng.chance(P[4])) semis += SPC_GD_IV[rng.int(P[4] > 0.6 ? 8 : 4)];
    if (P[6]) semis = this.key.snapSemis(semis);
    const ratio = Math.pow(2, clamp(semis, -48, 24) / 12);
    const rev = rng.chance(P[5]);
    let D = P[2] * (1 + P[3] * rng.next() * 0.9) + P[3] * rng.bi() * G * 0.5;
    if (rev) { D = Math.max(D, ratio * G * 0.5 + 2); this.pos[k] = w - D + ratio * G * 0.5; this.inc[k] = -ratio; }
    else { D = Math.max(D, (ratio * 0.5 - 1) * G + ratio * G * 0.5 + 4, ratio * G * 0.5 + 2); this.pos[k] = w - D - ratio * G * 0.5; this.inc[k] = ratio; }
    const lean = (k ? 1 : -1) * P[7] * (0.4 + 0.6 * rng.next());
    SPC_lean(lean, this.ll, this.rl, this.rr, this.lr, k);
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, P = this.par, K = this.K;
    this.key = ctx.key;
    const G = clamp(p.size * 0.001 * sr, 64, sr);
    P[0] = G; P[1] = p.pitch; P[2] = Math.min(p.sync ? p.time * ctx.spb : p.ms * 0.001 * sr, this.N - 3 * sr); P[3] = p.spray * 0.01;
    P[4] = p.random * 0.01; P[5] = p.reverse * 0.01; P[6] = p.snap; P[7] = p.width * 0.01;
    const tone = p.tone;
    K[0] = 1 / G; K[1] = p.feedback * 0.01;
    K[2] = 1 - Math.exp(-TAU * (tone < 0 ? 14000 * Math.pow(2, tone * 0.055) : 15000) / sr);
    K[3] = 1 - Math.exp(-TAU * (tone > 0 ? 30 * Math.pow(2, tone * 0.06) : 25) / sr);
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const K = this.K, st = this.st, bL = this.bL, bR = this.bR, mask = this.mask, ph = this.ph, pos = this.pos, inc = this.inc;
    const ll = this.ll, rl = this.rl, rr = this.rr, lr = this.lr;
    const dph = K[0], fb = K[1], cLp = K[2], cHp = K[3];
    let w = this.w, yl = st[0], yr = st[1], al = st[2], ar = st[3], hl = st[4], hr = st[5];
    for (let i = 0; i < n; i++) {
      al += cLp * (yl - al); ar += cLp * (yr - ar); hl += cHp * (al - hl); hr += cHp * (ar - hr);
      bL[w] = L[i] + fb * fastTanh(al - hl); bR[w] = R[i] + fb * fastTanh(ar - hr);
      let ol = 0, or = 0;
      for (let k = 0; k < 2; k++) {
        let t = ph[k] + dph;
        if (t >= 1) { t -= 1; this._grain(k, w); }
        ph[k] = t;
        const g = SPC_win(t), q = pos[k], j = Math.floor(q), f = q - j, j0 = j & mask, j1 = (j + 1) & mask;
        const xl = bL[j0] + (bL[j1] - bL[j0]) * f, xr = bR[j0] + (bR[j1] - bR[j0]) * f;
        ol += g * (xl * ll[k] + xr * rl[k]); or += g * (xr * rr[k] + xl * lr[k]);
        pos[k] = q + inc[k];
      }
      w = (w + 1) & mask;
      yl = ol; yr = or;
      L[i] = SPC_safe(al - hl); R[i] = SPC_safe(ar - hr);
    }
    this.w = w; st[0] = yl; st[1] = yr; st[2] = al; st[3] = ar; st[4] = hl; st[5] = hr;
  }
});

// ===========================================================================
// 14. SLICER — record one bank while playing the previous one sliced
// ===========================================================================
registerFX(class extends FX {
  static id = 'slicer';
  static label = 'SLICER';
  static cat = 'GLITCH';
  static desc = 'Records one bank while replaying the previous bank as grid-locked slices that shuffle, repeat, pitch, reverse, gate and ratchet.';
  static params = [
    { id: 'size', label: 'SIZE', div: ['2/1', '1/8'], straight: true, def: '1/1' },
    { id: 'division', label: 'DIVISION', min: 2, max: 32, def: 8, curve: 'int' },
    { id: 'shuffle', label: 'SHUFFLE', min: 0, max: 100, def: 40, unit: '%' },
    { id: 'repeat', label: 'REPEAT', min: 0, max: 100, def: 20, unit: '%' },
    { id: 'pitch', label: 'PITCH', min: 0, max: 100, def: 10, unit: '%' },
    { id: 'reverse', label: 'REVERSE', min: 0, max: 100, def: 15, unit: '%' },
    { id: 'gate', label: 'GATE', min: 0, max: 100, def: 0, unit: '%' },
    { id: 'ratchet', label: 'RATCHET', min: 0, max: 100, def: 10, unit: '%' },
    { id: 'fade', label: 'FADE', min: 1, max: 30, def: 4, unit: 'ms', curve: 'exp' },
  ];
  init() {
    const sr = this.sr;
    const N = SPC_pow2(Math.ceil(20 * sr));
    this.bL = SPC_f32(this, 'bL', N); this.bR = SPC_f32(this, 'bR', N); this.mask = N - 1; this.N = N;
    this.t = 0; this.bank = -1e9; this.slice = -1e9; this.curStart = 0; this.curFull = 0; this.prevStart = 0; this.prevFull = 0;
    this.rng = new Rng(0x511c); this.lastSrc = -1; this.lg = 1;
    this.S = new Float64Array(10); // slice: startT, len, srcAbs, rate, rev, nRat, playFrac
    this.prm = new Float64Array(12);
  }
  _newSlice(t, idx, bankLen) {
    const P = this.prm, S = this.S, rng = this.rng, D = P[1];
    const sl = bankLen / D;
    let src = idx;
    if (rng.chance(P[2])) src = rng.int(D);
    if (this.lastSrc >= 0 && rng.chance(P[3])) src = this.lastSrc;
    this.lastSrc = src;
    S[0] = t; S[1] = sl; S[2] = this.prevStart + src * sl;
    S[3] = rng.chance(P[4]) ? (rng.chance(0.5) ? 2 : 0.5) : 1;
    S[4] = rng.chance(P[5]) ? 1 : 0;
    S[5] = rng.chance(P[7]) ? 2 + rng.int(3) : 1;
    S[6] = rng.chance(P[6]) ? 0.3 + 0.25 * rng.next() : 1;
  }
  process(L, R, n, p, ctx) {
    const P = this.prm;
    P[0] = p.size; P[1] = clamp(p.division | 0, 2, 32); P[2] = p.shuffle * 0.01; P[3] = p.repeat * 0.01; P[4] = p.pitch * 0.01;
    P[5] = p.reverse * 0.01; P[6] = p.gate * 0.01; P[7] = p.ratchet * 0.01; P[8] = p.fade * 0.001 * this.sr;
    P[9] = ctx.ppq; P[10] = ctx.spb;
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const P = this.prm, S = this.S, bL = this.bL, bR = this.bR, mask = this.mask, N = this.N;
    const B = P[0], D = P[1], fadeS = P[8], ppq = P[9], spb = P[10];
    const bankLen = Math.min(B * spb, N * 0.5 - 4096), sliceB = B / D, fadeC = 1 - Math.exp(-2.5 / Math.max(8, fadeS));
    let t = this.t;
    for (let i = 0; i < n; i++) {
      bL[t & mask] = L[i]; bR[t & mask] = R[i];
      const pos = ppq + i / spb;
      const bk = Math.floor(pos / B);
      if (bk !== this.bank) {
        // bank boundary: the bank just recorded becomes the playback source
        const fresh = this.bank === -1e9;
        this.prevStart = this.curStart; this.prevFull = this.curFull;
        const into = (pos - bk * B) * spb;
        this.curStart = t - into; this.curFull = (!fresh || into < 1) ? 1 : 0;
        if (fresh) this.prevFull = 0;
        this.bank = bk; this.slice = -1e9;
      }
      const si = Math.floor((pos - bk * B) / sliceB);
      if (si !== this.slice) { this.slice = si; this._newSlice(t - ((pos - bk * B) - si * sliceB) * spb, si, bankLen); }
      let ol = 0, or = 0;
      // live pass-through until a complete bank exists, then a short crossfade into the slices
      const lt = this.prevFull ? 0 : 1;
      this.lg += (lt - this.lg) * (lt > this.lg ? 1 : fadeC);
      if (this.lg < 1e-4) this.lg = 0;
      if (this.prevFull) {
        const sl = S[1], nr = S[5], seg = sl / nr, tl = t - S[0];
        const sub = Math.min(nr - 1, Math.floor(tl / seg)), tt = tl - sub * seg;
        const play = seg * S[6];
        let env = 0;
        if (tt < play) {
          env = tt < fadeS ? SPC_win(0.5 * tt / fadeS) : 1;
          const rem = play - tt;
          if (rem < fadeS) env *= SPC_win(0.5 * rem / fadeS);
        }
        if (env > 0) {
          const off = S[4] ? (seg - tt) * S[3] : tt * S[3];
          const q = Math.min(S[2] + off, t - 1), j = Math.floor(q), f = q - j, j0 = j & mask, j1 = (j + 1) & mask;
          ol = (bL[j0] + (bL[j1] - bL[j0]) * f) * env; or = (bR[j0] + (bR[j1] - bR[j0]) * f) * env;
        }
      }
      L[i] = ol + L[i] * this.lg; R[i] = or + R[i] * this.lg;
      t++;
    }
    this.t = t;
  }
});

// ===========================================================================
// 15. MEMORY — memory disorder: replays windows of the recent past
// ===========================================================================
registerFX(class extends FX {
  static id = 'memory';
  static label = 'MEMORY';
  static cat = 'GLITCH';
  static desc = 'Keeps 16 s of history and replays a SPAN-long window CUTS times, with slips, wear gaps and soft edges.';
  static params = [
    { id: 'span', label: 'SPAN', div: ['4/1', '1/32'], def: '1/4' },
    { id: 'cuts', label: 'CUTS', min: 1, max: 32, def: 4, curve: 'int' },
    { id: 'slip', label: 'SLIP', min: 0, max: 100, def: 15, unit: '%' },
    { id: 'seek', label: 'SEEK', min: 0, max: 16, def: 0, unit: 's', curve: 'sq' },
    { id: 'wear', label: 'WEAR', min: 0, max: 100, def: 10, unit: '%' },
    { id: 'edge', label: 'EDGE', min: 0, max: 100, def: 25, unit: '%' },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 50, unit: '%' },
  ];
  init() {
    const sr = this.sr;
    const N = SPC_pow2(Math.ceil(20 * sr));
    this.bL = SPC_f32(this, 'bL', N); this.bR = SPC_f32(this, 'bR', N); this.mask = N - 1; this.N = N;
    this.t = 0; this.rep = -1e9; this.rng = new Rng(0x3e30);
    this.S = new Float64Array(12); // repStart, spanS, srcBase, slipL, slipR, gapL, gapR, lpC, cycleStart, repIdx
    this.prm = new Float64Array(10); this.st = new Float64Array(4);
  }
  _newRep(t, ri, into) {
    const P = this.prm, S = this.S, rng = this.rng, cuts = P[1], spanS = P[0] * P[9], sr = this.sr;
    const idx = ((ri % cuts) + cuts) % cuts;
    const start = t - into;
    if (idx === 0 || this.rep === -1e9) {
      // new cycle: grab a window SEEK seconds back (seek 0 = live first pass)
      const cyc = start - idx * spanS;
      S[8] = cyc; S[2] = cyc - Math.min(P[3] * sr, this.N - 2 * spanS - 8192);
    }
    S[0] = start; S[1] = spanS; S[9] = idx;
    const slip = P[2], wear = P[4], wid = P[6];
    const maxFwd = (S[8] + idx * spanS) - S[2];  // how far forward a read may slip without reading the future
    let sl = rng.bi() * slip * spanS * 0.5;
    let sr2 = rng.chance(wid) ? rng.bi() * slip * spanS * 0.5 : sl;
    if (idx === 0 && slip > 0) sl -= slip * spanS * 0.1;
    S[3] = Math.min(sl, maxFwd); S[4] = Math.min(sr2, maxFwd);
    const gapL = idx > 0 && rng.chance(wear * 0.55);
    S[5] = gapL ? 0 : 1; S[6] = (rng.chance(wid) ? (idx > 0 && rng.chance(wear * 0.55)) : gapL) ? 0 : 1;
    S[7] = 1 - Math.exp(-TAU * Math.max(400, 18000 * Math.pow(2, -wear * idx * 0.7)) / sr);
  }
  process(L, R, n, p, ctx) {
    const P = this.prm;
    P[0] = p.span; P[1] = clamp(p.cuts | 0, 1, 32); P[2] = p.slip * 0.01; P[3] = p.seek; P[4] = p.wear * 0.01;
    P[5] = 0.02 + 0.98 * p.edge * 0.01; P[6] = p.width * 0.01; P[7] = ctx.ppq; P[9] = ctx.spb;
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const P = this.prm, S = this.S, st = this.st, bL = this.bL, bR = this.bR, mask = this.mask;
    const span = P[0], edge = P[5], ppq = P[7], spb = P[9];
    let t = this.t, lpl = st[0], lpr = st[1];
    for (let i = 0; i < n; i++) {
      bL[t & mask] = L[i]; bR[t & mask] = R[i];
      const pos = ppq + i / spb, ri = Math.floor(pos / span);
      if (ri !== this.rep) { this._newRep(t, ri, (pos - ri * span) * spb); this.rep = ri; }
      const tl = t - S[0], u = tl / S[1];
      const env = SPC_tuk(Math.min(0.99999, Math.max(1e-5, u)), edge);
      const base = S[2] + (S[9] * S[1]) + tl;
      let ql = Math.min(base + S[3], t), qr = Math.min(base + S[4], t);
      const a = bL[ql & mask], b = bR[qr & mask];
      const c = S[7];
      lpl += c * (a - lpl); lpr += c * (b - lpr);
      L[i] = lpl * env * S[5] * 1.2; R[i] = lpr * env * S[6] * 1.2;
      t++;
    }
    this.t = t; st[0] = lpl; st[1] = lpr;
  }
});

// ===========================================================================
// 16. SCANFREEZE — two grains scanning a held capture
// ===========================================================================
registerFX(class extends FX {
  static id = 'scanfreeze';
  static label = 'SCANFREEZE';
  static cat = 'GRANULAR';
  static desc = 'Holds a one-second capture and scans it with two overlapping grains; hits can trigger a fresh capture.';
  static params = [
    { id: 'scan', label: 'SCAN', min: 0, max: 100, def: 50, unit: '%' },
    { id: 'size', label: 'SIZE', min: 10, max: 1000, def: 120, unit: 'ms', curve: 'exp' },
    { id: 'pitch', label: 'PITCH', min: -24, max: 24, def: 0, curve: 'int', unit: 'st', bipolar: true },
    { id: 'capture', label: 'CAPTURE', toggle: true, def: 1 },
    { id: 'transient', label: 'TRANSIENT', min: 0, max: 100, def: 40, unit: '%' },
    { id: 'shape', label: 'SHAPE', min: 0, max: 100, def: 0, unit: '%' },
    { id: 'spray', label: 'SPRAY', min: 0, max: 100, def: 15, unit: '%' },
    { id: 'duck', label: 'DUCK', min: 0, max: 100, def: 0, unit: '%' },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 50, unit: '%' },
    { id: 'snap', label: 'SNAP', toggle: true, def: 0 },
  ];
  init() {
    const sr = this.sr;
    this.capLen = sr; this.CN = SPC_pow2(Math.ceil(2.2 * sr)); this.cm = this.CN - 1;
    this.bL = SPC_f32(this, 'bL', this.CN * 2); this.bR = SPC_f32(this, 'bR', this.CN * 2);
    this.rec = 0; this.rw = 0; this.recCount = 0; this.have = 0; this.frzEnd = 0; this.lastCap = 0;
    this.gh = new Float64Array(2); this.gpos = new Float64Array(2); this.ginc = new Float64Array(2); this.gage = new Float64Array(2); this.glen = new Float64Array(2);
    this.gl = new Float64Array(2); this.gr = new Float64Array(2); this.gact = new Float64Array(2);
    this.rng = new Rng(0x5ca7); this.K = new Float64Array(16); this.st = new Float64Array(8); this.next = 0; this.which = 0;
  }
  _capture() { this.frzBuf = this.rec; this.frzEnd = this.rw; this.rec ^= 1; this.rw = 0; this.recCount = 0; this.have = 1; }
  _spawn() {
    const K = this.K, rng = this.rng, cap = this.capLen, k = this.which; this.which ^= 1;
    const G = K[0], ratio = K[1], frozen = K[2] > 0 && this.have;
    const span = Math.min(cap - 8, G * ratio);
    let off = K[3] * (cap - span) + rng.bi() * K[4] * cap * 0.25;
    off = clamp(off, 0, cap - span - 4);
    if (frozen) { this.gh[k] = this.frzBuf; this.gpos[k] = this.frzEnd - cap + off; }
    else { this.gh[k] = this.rec; this.gpos[k] = this.rw - cap + off - Math.max(0, (ratio - 1) * G); }
    this.ginc[k] = ratio; this.gage[k] = 0; this.glen[k] = G; this.gact[k] = 1;
    const pan = (k ? 1 : -1) * K[5] * (0.5 + 0.5 * rng.next());
    this.gl[k] = Math.sqrt(0.5 * (1 - pan)); this.gr[k] = Math.sqrt(0.5 * (1 + pan));
  }
  process(L, R, n, p, ctx) {
    const sr = this.sr, K = this.K;
    let semis = p.pitch; if (p.snap) semis = ctx.key.snapSemis(semis);
    K[0] = clamp(p.size * 0.001 * sr, 32, this.capLen * 0.9); K[1] = Math.pow(2, semis / 12);
    if (p.capture && !this.prevCap && this.recCount > this.capLen * 0.25) this._capture(); // toggle on -> grab now
    this.prevCap = p.capture;
    K[2] = p.capture; K[3] = p.scan * 0.01; K[4] = p.spray * 0.01; K[5] = p.width * 0.01;
    K[6] = 1 - 0.9 * p.shape * 0.01; K[7] = p.transient * 0.01; K[8] = p.duck * 0.01;
    K[9] = 1 / (1 + 0.5 * (1 - K[6]));
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const K = this.K, st = this.st, bL = this.bL, bR = this.bR, CN = this.CN, cm = this.cm, cap = this.capLen;
    const G = K[0], tap = K[6], trs = K[7], duck = K[8], norm = K[9];
    const gh = this.gh, gpos = this.gpos, ginc = this.ginc, gage = this.gage, glen = this.glen, gl = this.gl, gr = this.gr, gact = this.gact;
    let ef = st[0], es = st[1], hold = st[2], denv = st[3], dg = st[4] || 1;
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      const o = this.rec * CN + (this.rw & cm);
      bL[o] = xl; bR[o] = xr; this.rw++; this.recCount++;
      // auto capture once enough is recorded; transient re-capture
      const ax = Math.max(xl < 0 ? -xl : xl, xr < 0 ? -xr : xr);
      ef += (ax - ef) * (ax > ef ? 0.3 : 0.004); es += (ax - es) * (ax > es ? 0.01 : 0.0003);
      if (hold > 0) hold--;
      if (K[2] > 0 && this.recCount >= cap) {
        if (!this.have) this._capture();
        else if (trs > 0 && hold <= 0 && ef > 0.05 + (1 - trs) * 0.4 && ef > es * (1.2 + (1 - trs) * 2)) { this._capture(); hold = cap * 0.25; }
      }
      // grain clock: hop = G/2
      if (--this.next <= 0) { this._spawn(); this.next += G * 0.5; }
      let ol = 0, or = 0;
      for (let k = 0; k < 2; k++) {
        if (!gact[k]) continue;
        const u = gage[k] / glen[k];
        if (u >= 1) { gact[k] = 0; continue; }
        const w = tap >= 0.999 ? SPC_win(u) : SPC_tuk(u, tap);
        const q = gpos[k], j = Math.floor(q), f = q - j, base = gh[k] * CN, j0 = base + (j & cm), j1 = base + ((j + 1) & cm);
        const a = bL[j0] + (bL[j1] - bL[j0]) * f, b = bR[j0] + (bR[j1] - bR[j0]) * f;
        ol += w * gl[k] * (a + b); or += w * gr[k] * (a + b);
        gpos[k] = q + ginc[k]; gage[k]++;
      }
      denv += (ax - denv) * (ax > denv ? 0.02 : 0.0005);
      dg += ((1 - duck * Math.min(1, denv * 3)) - dg) * 0.003;
      L[i] = SPC_safe(ol * norm * 0.55 * dg); R[i] = SPC_safe(or * norm * 0.55 * dg);
    }
    st[0] = ef; st[1] = es; st[2] = hold; st[3] = denv; st[4] = dg;
  }
});

// ===========================================================================
// 17. FRAGMENT — transient-triggered fragment sequencer
// ===========================================================================
registerFX(class extends FX {
  static id = 'fragment';
  static label = 'FRAGMENT';
  static cat = 'GLITCH';
  static desc = 'Input hits are cut into fragment slots that a grid-locked sequencer replays forward, reversed, shuffled, ranked or euclidean.';
  static params = [
    { id: 'slots', label: 'SLOTS', min: 2, max: 16, def: 8, curve: 'int' },
    { id: 'rate', label: 'RATE', div: ['1/1', '1/64'], def: '1/16' },
    { id: 'pattern', label: 'PATTERN', options: ['FWD', 'REV', 'SHUF', 'RANK', 'EUCLID'], def: 0 },
    { id: 'pitch', label: 'PITCH', min: -12, max: 12, def: 0, curve: 'int', unit: 'st', bipolar: true },
    { id: 'decay', label: 'DECAY', min: 0, max: 100, def: 60, unit: '%' },
    { id: 'sense', label: 'SENSE', min: 0, max: 100, def: 50, unit: '%' },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, def: 50, unit: '%' },
    { id: 'hold', label: 'HOLD', toggle: true, def: 0 },
  ];
  init() {
    const sr = this.sr;
    const N = SPC_pow2(Math.ceil(8.5 * sr));
    this.bL = SPC_f32(this, 'bL', N); this.bR = SPC_f32(this, 'bR', N); this.mask = N - 1; this.N = N; this.t = 0;
    this.slotPos = new Float64Array(16); this.slotLvl = new Float64Array(16); this.filled = 0; this.nextSlot = 0;
    this.order = new Int32Array(16); this.step = -1e9; this.rng = new Rng(0xf4a6);
    this.V = new Float64Array(10); // voice: src, startT, len, rate, tau, pan(l), pan(r), active
    this.prm = new Float64Array(12); this.st = new Float64Array(6);
  }
  _order(ns, pat) {
    const o = this.order, rng = this.rng;
    for (let i = 0; i < ns; i++) o[i] = i;
    if (pat === 2) { for (let i = ns - 1; i > 0; i--) { const j = rng.int(i + 1), x = o[i]; o[i] = o[j]; o[j] = x; } }
    else if (pat === 3) { // loudest hits first (insertion sort, no allocation)
      const lv = this.slotLvl;
      for (let i = 1; i < ns; i++) { const x = o[i]; let j = i - 1; while (j >= 0 && lv[o[j]] < lv[x]) { o[j + 1] = o[j]; j--; } o[j + 1] = x; }
    }
  }
  _newStep(t, stepIdx, into) {
    const P = this.prm, V = this.V, ns = P[0], pat = P[2];
    const k = ((stepIdx % ns) + ns) % ns;
    if (k === 0 || this.step === -1e9) this._order(ns, pat);
    V[7] = 0;
    if (this.filled === 0) return;
    let slot;
    if (pat === 1) slot = ns - 1 - k;
    else if (pat === 4) { const hits = Math.max(1, Math.round(ns * 0.625)); if (((k * hits) % ns) >= hits) return; slot = k; }
    else slot = this.order[k];
    slot = slot % this.filled;
    const len = P[1] * P[9];
    V[0] = this.slotPos[slot]; V[1] = t - into; V[2] = len; V[3] = P[3];
    V[4] = 0.008 * this.sr + P[4] * P[4] * len * 2.5;
    const pan = ((stepIdx & 1) ? 1 : -1) * P[5];
    V[5] = Math.sqrt(0.5 * (1 - pan)); V[6] = Math.sqrt(0.5 * (1 + pan)); V[7] = 1;
  }
  process(L, R, n, p, ctx) {
    const P = this.prm;
    P[0] = clamp(p.slots | 0, 2, 16); P[1] = p.rate; P[2] = p.pattern | 0; P[3] = Math.pow(2, p.pitch / 12);
    P[4] = p.decay * 0.01; P[5] = p.width * 0.01; P[6] = p.sense * 0.01; P[7] = p.hold; P[8] = ctx.ppq; P[9] = ctx.spb;
    if (this.filled > P[0]) this.filled = P[0];
    if (this.nextSlot >= P[0]) this.nextSlot = 0;
    this._dsp(L, R, n);
  }
  _dsp(L, R, n) {
    const P = this.prm, V = this.V, st = this.st, bL = this.bL, bR = this.bR, mask = this.mask, sr = this.sr;
    const rate = P[1], sense = P[6], hold = P[7], ppq = P[8], spb = P[9], ns = P[0];
    const ratio = 1.3 + (1 - sense) * 2.5, thr = 0.02 + (1 - sense) * 0.25, fade = 0.002 * sr;
    let t = this.t, ef = st[0], es = st[1], ref = st[2], g = st[3];
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      bL[t & mask] = xl; bR[t & mask] = xr;
      // transient detection -> new fragment slot
      const ax = Math.max(xl < 0 ? -xl : xl, xr < 0 ? -xr : xr);
      ef += (ax - ef) * (ax > ef ? 0.5 : 0.003); es += (ax - es) * (ax > es ? 0.004 : 0.0002);
      if (ref > 0) ref--;
      else if (!hold && ef > thr && ef > es * ratio) {
        const s = this.nextSlot;
        this.slotPos[s] = t - 0.002 * sr; this.slotLvl[s] = ef;
        this.nextSlot = (s + 1) % ns; if (this.filled < ns) this.filled++;
        ref = 0.07 * sr;
      }
      // sequencer
      const pos = ppq + i / spb, si = Math.floor(pos / rate);
      if (si !== this.step) { this._newStep(t, si, (pos - si * rate) * spb); this.step = si; }
      let ol = 0, or = 0;
      if (V[7]) {
        const tl = t - V[1];
        if (tl < V[2]) {
          let env = tl < fade ? SPC_win(0.5 * tl / fade) : 1;
          const rem = V[2] - tl; if (rem < fade) env *= SPC_win(0.5 * rem / fade);
          env *= Math.exp(-tl / V[4]);
          const q = Math.min(V[0] + tl * V[3], t - 1), j = Math.floor(q), f = q - j, j0 = j & mask, j1 = (j + 1) & mask;
          const a = bL[j0] + (bL[j1] - bL[j0]) * f, b = bR[j0] + (bR[j1] - bR[j0]) * f;
          ol = a * env * V[5] * 1.05; or = b * env * V[6] * 1.05;
        }
      }
      L[i] = ol; R[i] = or;
      t++;
    }
    this.t = t; st[0] = ef; st[1] = es; st[2] = ref; st[3] = g;
  }
});
