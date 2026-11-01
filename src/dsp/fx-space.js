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
function SPC_safe(x) {
  if (x > 1.5) return 1.5 + 2.5 * fastTanh((x - 1.5) * 0.4);
  if (x < -1.5) return -1.5 - 2.5 * fastTanh((-x - 1.5) * 0.4);
  return x;
}
// drive-normalised saturator (unity small-signal gain, bounded by 1/d)
function SPC_sat(x, d) { return fastTanh(x * d) / d; }
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
    { id: 'head', label: 'HEAD', options: ['CLEAN', 'SPACE', 'VOLANTE', 'MIMEO'], def: 0 },
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
      } else { // VOLANTE: four heads alternating sides
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
    this.KM = 8;                                        // ring length per stage (>= Ks)
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
      if (hold > 0) hold--;
      else if (crash > 0 && ef > 0.15 && ef > es * 1.6) { shake = Math.min(1.5, shake + ef * crash); burst = Math.min(1, ef) * crash; hold = sr * 0.06 | 0; }
      shake *= 0.99985; burst *= 0.9965; sph += shW; if (sph > TAU) sph -= TAU;
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
      // output: dispersed signal, stereo width
      const oA = sA * 0.7, oB = sB * 0.7, mid = (oA + oB) * 0.5, side = (oA - oB) * 0.5 * wid;
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
    const pre = this.pre, pN = this.pN, pm = this.pm, sh = this.sh, sN = this.sN, sm = this.sm, ap = this.ap, aN = this.aN, am = this.am, apD = this.apD;
    const pStep = K[0], r1 = K[1], r2 = K[2], regen = K[3], layer = K[4], frz = K[5], wid = K[6], cHp = K[7], cLp = K[8], win = K[9];
    const ad0 = apD[0], ad1 = apD[1], ad2 = apD[2], ad3 = apD[3];
    let pd = K[10], t = this.t, xf = st[0], yl = st[1], yr = st[2], hl = st[3], hr = st[4], ll = st[5], lr = st[6], env = st[7];
    for (let i = 0; i < n; i++) {
      pd += pStep; xf += (frz - xf) * 0.001;
      const inG = 1 - xf;
      pre[t & pm] = L[i] * inG; pre[pN + (t & pm)] = R[i] * inG;
      let xl, xr;
      if (pd < 1) { xl = pre[t & pm]; xr = pre[pN + (t & pm)]; }
      else { const q = t - pd, k = Math.floor(q), f = q - k, a = pre[k & pm], b = pre[pN + (k & pm)]; xl = a + (pre[(k + 1) & pm] - a) * f; xr = b + (pre[pN + ((k + 1) & pm)] - b) * f; }
      // input diffusion
      let v = ap[(t - ad0) & am], u = xl + 0.6 * v; ap[t & am] = u; xl = v - 0.6 * u;
      v = ap[aN + ((t - ad1) & am)]; u = xl + 0.6 * v; ap[aN + (t & am)] = u; xl = v - 0.6 * u;
      v = ap[2 * aN + ((t - ad2) & am)]; u = xr + 0.6 * v; ap[2 * aN + (t & am)] = u; xr = v - 0.6 * u;
      v = ap[3 * aN + ((t - ad3) & am)]; u = xr + 0.6 * v; ap[3 * aN + (t & am)] = u; xr = v - 0.6 * u;
      // shimmer regeneration (level-limited)
      const ag = regen * 0.55 / (1 + 4 * Math.max(0, env - 0.2));
      fdn.tick(xl * 0.6 + yl * ag, xr * 0.6 + yr * ag);
      const fl = fdn.oL * 0.32, fr = fdn.oR * 0.32;
      sh[t & sm] = fl; sh[sN + (t & sm)] = fr;
      // pitch shift the tail
      s1.step(r1, win, 0);
      let q0 = t - 2 - s1.d0, q1 = t - 2 - s1.d1;
      let pl = SPC_rd(sh, sm, q0) * s1.g0 + SPC_rd(sh, sm, q1) * s1.g1;
      let k0 = Math.floor(q0), k1 = Math.floor(q1);
      let pr = (sh[sN + (k0 & sm)] + (sh[sN + ((k0 + 1) & sm)] - sh[sN + (k0 & sm)]) * (q0 - k0)) * s1.g0
        + (sh[sN + (k1 & sm)] + (sh[sN + ((k1 + 1) & sm)] - sh[sN + (k1 & sm)]) * (q1 - k1)) * s1.g1;
      if (r2 > 0) {
        s2.step(r2, win * 1.31, 0);
        q0 = t - 2 - s2.d0; q1 = t - 2 - s2.d1; k0 = Math.floor(q0); k1 = Math.floor(q1);
        pl = 0.6 * pl + 0.6 * (SPC_rd(sh, sm, q0) * s2.g0 + SPC_rd(sh, sm, q1) * s2.g1);
        pr = 0.6 * pr + 0.6 * ((sh[sN + (k0 & sm)] + (sh[sN + ((k0 + 1) & sm)] - sh[sN + (k0 & sm)]) * (q0 - k0)) * s2.g0
          + (sh[sN + (k1 & sm)] + (sh[sN + ((k1 + 1) & sm)] - sh[sN + (k1 & sm)]) * (q1 - k1)) * s2.g1);
      }
      // band-limit the shimmer path (cuts mud + fizz)
      ll += cLp * (pl - ll); lr += cLp * (pr - lr);
      hl += cHp * (ll - hl); hr += cHp * (lr - hr);
      yl = ll - hl; yr = lr - hr;
      const ay = Math.abs(yl) + Math.abs(yr);
      env += (ay - env) * (ay > env ? 0.01 : 0.0002);
      const ol = fl + yl * layer * 0.5, or = fr + yr * layer * 0.5;
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
      L[i] = SPC_safe(fl * (1 - blend) + gr.oL * blend);
      R[i] = SPC_safe(fr * (1 - blend) + gr.oR * blend);
    }
    this.w = w; this.xf = xf;
  }
});

