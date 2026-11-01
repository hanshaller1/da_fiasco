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
// setup() once per block, tick(inL, inR) per sample -> this.oL / this.oR
const SPC_FDN_MS = [31.71, 37.13, 41.19, 44.27, 53.39, 59.11, 67.93, 73.37];
class SPC_FDN {
  constructor(sr, maxScale) {
    this.sr = sr; this.dl = []; this.len = new Float64Array(8); this.tgt = new Float64Array(8); this.g = new Float64Array(8);
    for (let i = 0; i < 8; i++) this.dl.push(new DelayLine(SPC_FDN_MS[i] * 0.001 * sr * maxScale + 64));
    this.lpS = new Float64Array(8); this.v = new Float64Array(8); this.lpc = 0.5; this.modD = 0;
    this.lph = new Float64Array(4); this.mcur = new Float64Array(4); this.mstep = new Float64Array(4);
    for (let i = 0; i < 4; i++) this.lph[i] = i * 0.25;
    this.oL = 0; this.oR = 0; this.first = true; this.maxScale = maxScale;
  }
  clear() { for (const d of this.dl) d.clear(); this.lpS.fill(0); this.first = true; }
  // size: delay scale, t60: seconds (Infinity = freeze), dampHz: line lowpass, mod 0..1
  setup(size, t60, dampHz, mod, n) {
    const sr = this.sr; size = clamp(size, 0.05, this.maxScale);
    for (let i = 0; i < 8; i++) {
      const L = SPC_FDN_MS[i] * 0.001 * sr * size;
      this.tgt[i] = L;
      if (this.first) this.len[i] = L;
      this.g[i] = t60 === Infinity ? 1 : Math.pow(10, -3 * L / (sr * Math.max(0.05, t60)));
    }
    this.first = false;
    this.lpc = dampHz >= sr * 0.45 ? 1 : 1 - Math.exp(-TAU * dampHz / sr);
    this.modD = mod * 0.0025 * sr;
    for (let j = 0; j < 4; j++) {
      this.lph[j] += n * (0.13 + 0.07 * j) / sr; this.lph[j] -= Math.floor(this.lph[j]);
      const tv = Math.sin(TAU * this.lph[j]) * this.modD;
      this.mstep[j] = (tv - this.mcur[j]) / n;
    }
    this.n = n;
  }
  tick(inL, inR) {
    const v = this.v, dl = this.dl, len = this.len, tgt = this.tgt;
    for (let i = 0; i < 8; i++) {
      len[i] += (tgt[i] - len[i]) * 0.0005;
      let d = len[i];
      if (i < 4) { this.mcur[i] += this.mstep[i]; d += this.mcur[i]; }
      let x = dl[i].readLinear(d);
      this.lpS[i] += (x - this.lpS[i]) * this.lpc;
      v[i] = this.lpS[i] * this.g[i];
    }
    this.oL = v[0] + v[2] + v[4] + v[6];
    this.oR = v[1] + v[3] + v[5] + v[7];
    // fast Walsh-Hadamard (8) / sqrt(8)
    let a0 = v[0] + v[1], a1 = v[0] - v[1], a2 = v[2] + v[3], a3 = v[2] - v[3];
    let a4 = v[4] + v[5], a5 = v[4] - v[5], a6 = v[6] + v[7], a7 = v[6] - v[7];
    let b0 = a0 + a2, b2 = a0 - a2, b1 = a1 + a3, b3 = a1 - a3;
    let b4 = a4 + a6, b6 = a4 - a6, b5 = a5 + a7, b7 = a5 - a7;
    const s = 0.35355339;
    dl[0].write((b0 + b4) * s + inL); dl[1].write((b1 + b5) * s + inR);
    dl[2].write((b2 + b6) * s + inL); dl[3].write((b3 + b7) * s + inR);
    dl[4].write((b0 - b4) * s - inL); dl[5].write((b1 - b5) * s - inR);
    dl[6].write((b2 - b6) * s + inL * 0.7); dl[7].write((b3 - b7) * s - inR * 0.7);
  }
}

// slow drifting LFO helper evaluated once per block (sin + smoothed random)
function SPC_lfoAdv(ph, hz, n, sr) { ph += hz * n / sr; return ph - Math.floor(ph); }

