// ============================================================================
// DEBACLE — time engines: VARISPEED, STUTTER (+ BENDIT mode), STRETCH.
// Each engine processes a stereo block in place, including its own dry/wet
// MIX and a 10 ms ON/OFF fade. Engines read params from ParamBank.v objects.
// ============================================================================

// Stereo ring buffer addressed by absolute sample index.
class TE_Ring {
  constructor(samples) {
    this.size = nextPow2(samples); this.mask = this.size - 1;
    this.L = new Float32Array(this.size); this.R = new Float32Array(this.size);
    this.w = 0; // absolute index of the next sample to write
  }
  push(l, r) { const j = this.w & this.mask; this.L[j] = l; this.R[j] = r; this.w++; }
  clear() { this.L.fill(0); this.R.fill(0); }
  // hermite read at absolute fractional position; writes into out[0], out[1]
  read(pos, out) {
    const i = Math.floor(pos), f = pos - i, m = this.mask;
    const a = (i - 1) & m, b = i & m, c = (i + 1) & m, d = (i + 2) & m;
    if (f === 0) { out[0] = this.L[b]; out[1] = this.R[b]; return; }
    let xm1 = this.L[a], x0 = this.L[b], x1 = this.L[c], x2 = this.L[d];
    let c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    out[0] = ((c3 * f + c2) * f + c1) * f + x0;
    xm1 = this.R[a]; x0 = this.R[b]; x1 = this.R[c]; x2 = this.R[d];
    c1 = 0.5 * (x1 - xm1); c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2; c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    out[1] = ((c3 * f + c2) * f + c1) * f + x0;
  }
  // clamp a read position so that hermite never touches unwritten / overwritten data
  safe(pos) {
    const hi = this.w - 3, lo = this.w - this.size + 4;
    return pos > hi ? hi : pos < lo ? lo : pos;
  }
}

// Linear ON/OFF + mix helper shared by the engines
class TE_Fader {
  constructor(sr) { this.v = 0; this.step = 1 / (0.01 * sr); }
  next(target) { if (this.v < target) { this.v += this.step; if (this.v > target) this.v = target; } else if (this.v > target) { this.v -= this.step; if (this.v < target) this.v = target; } return this.v; }
}

// ---------------------------------------------------------------------------
// VARISPEED — continuous capture, one read head with tape-coupled speed/pitch.
// ---------------------------------------------------------------------------
class Varispeed {
  constructor(sr) {
    this.sr = sr;
    this.ring = new TE_Ring(Math.ceil(sr * 10));
    this.tmp = new Float32Array(2);
    this.fader = new TE_Fader(sr);
    this.reset();
  }
  reset() {
    this.ring.clear(); this.ring.w = 0;
    this.headA = 0; this.headB = 0; this.dirA = 1; this.dirB = 1; this.xf = 1; // xf: gain of head A (1 = A only)
    this.xfStep = 1 / (0.012 * this.sr);
    this.win = -1; this.rate = 1; this.stopEnv = 1;
    // recursive sine oscillators (wow 0.5 Hz, flutter 6 Hz)
    const w1 = TAU * 0.5 / this.sr, w2 = TAU * 6 / this.sr;
    this.k1 = 2 * Math.cos(w1); this.k2 = 2 * Math.cos(w2);
    this.s1a = 0; this.s1b = Math.sin(-w1); this.s2a = 0; this.s2b = Math.sin(-w2);
    this.hold = 0; this.holdL = 0; this.holdR = 0;
    this.env = 0; this.compG = 1;
    this.readRate = 1; this.wasOn = false;
  }
  process(L, R, n, p, ctx) {
    const on = p.on >= 0.5;
    if (!on && this.fader.v === 0) { // keep recording so switching on is instant, nothing else
      for (let i = 0; i < n; i++) this.ring.push(L[i], R[i]);
      this.wasOn = false; return;
    }
    if (on && !this.wasOn) { this.win = -1; this.headA = this.ring.w - 1; this.xf = 1; }
    this.wasOn = on;
    const sr = this.sr, ring = this.ring, tmp = this.tmp, spb = ctx.spb;
    const winBeats = p.tempo, mode = p.mode, mix = p.mix / 100;
    const baseRate = p.speed / 100;
    const wow = p.wow / 100, scratch = p.scratch / 100;
    const sat = p.sat / 100, crush = p.dist === 1, comp = p.comp / 100;
    const heatK = 1 + sat * 9, heatNorm = 0.5 / fastTanh(0.5 * heatK);
    const bits = 16 - sat * 13, q = Math.pow(2, bits - 1), holdN = 1 + Math.floor(sat * sat * 10);
    const thr = dbToGain(-4 - comp * 26), ratio = 1 + comp * 7, makeup = dbToGain(comp * 13);
    const att = Math.exp(-1 / (0.002 * sr)), rel = Math.exp(-1 / (0.12 * sr));
    const stopDown = 1 / (0.9 * sr), stopUp = 1 / (0.35 * sr);
    const rateC = 1 - Math.exp(-1 / (0.004 * sr));
    for (let i = 0; i < n; i++) {
      const dl = L[i], dr = R[i];
      ring.push(dl, dr);
      const now = ring.w - 1;
      // capture window → rebase the head
      const bp = ctx.ppq + i / spb;
      const wi = Math.floor(bp / winBeats);
      if (wi !== this.win) {
        this.win = wi;
        const dir = mode === 0 ? 1 : mode === 2 ? -1 : (wi & 1 ? -1 : 1);
        this.headB = this.headA; this.dirB = this.dirA; this.xf = 0; // A fades in, B (old) fades out
        this.headA = now - 2; this.dirA = dir;
      }
      // rate: speed × stop × wow/flutter + scratch
      if (p.stop >= 0.5) { this.stopEnv -= stopDown; if (this.stopEnv < 0) this.stopEnv = 0; }
      else { this.stopEnv += stopUp; if (this.stopEnv > 1) this.stopEnv = 1; }
      let s1 = this.k1 * this.s1a - this.s1b; this.s1b = this.s1a; this.s1a = s1;
      let s2 = this.k2 * this.s2a - this.s2b; this.s2b = this.s2a; this.s2a = s2;
      let target = baseRate * this.stopEnv * this.stopEnv * (1 + wow * (0.022 * s1 + 0.007 * s2)) + scratch * 3;
      this.rate += (target - this.rate) * rateC;
      const r = this.rate;
      this.headA += this.dirA * r; this.headB += this.dirB * r;
      // never read the future, never read overwritten data
      let a = this.headA; if (a > now) { a = now; this.headA = now; }
      if (a < now - ring.size + 8) { a = now - 2; this.headA = a; }
      let b = this.headB; if (b > now) { b = now; this.headB = now; }
      if (b < now - ring.size + 8) { b = now - 2; this.headB = b; }
      ring.read(a, tmp); let wl = tmp[0], wr = tmp[1];
      if (this.xf < 1) {
        const g = this.xf; ring.read(b, tmp);
        wl = wl * g + tmp[0] * (1 - g); wr = wr * g + tmp[1] * (1 - g);
        this.xf += this.xfStep; if (this.xf > 1) this.xf = 1;
      }
      // saturation
      if (sat > 0.001) {
        if (crush) {
          if (this.hold-- <= 0) { this.hold = holdN - 1; this.holdL = Math.round(wl * q) / q; this.holdR = Math.round(wr * q) / q; }
          wl = this.holdL; wr = this.holdR;
        } else { wl = fastTanh(wl * heatK) * heatNorm; wr = fastTanh(wr * heatK) * heatNorm; }
      }
      // wet-path compressor (peak env)
      if (comp > 0.001) {
        const pk = Math.max(Math.abs(wl), Math.abs(wr));
        this.env = pk > this.env ? pk + att * (this.env - pk) : pk + rel * (this.env - pk);
        const g = this.env > thr ? Math.pow(this.env / thr, 1 / ratio - 1) : 1;
        wl *= g * makeup; wr *= g * makeup;
      }
      const f = this.fader.next(on ? 1 : 0) * mix;
      L[i] = dl + (wl - dl) * f; R[i] = dr + (wr - dr) * f;
    }
    this.readRate = this.rate;
  }
}

// ---------------------------------------------------------------------------
// STUTTER — beat-grid capture and repeat, with BENDIT mode.
// ---------------------------------------------------------------------------
const TE_SEQ_RATES = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32', '1/32T', '1/64', '1/128'];
const TE_SCRATCH_NAMES = ['BABY', 'TRANSFORMER', 'TEAR', 'SCRIBBLE'];

class Stutter {
  constructor(sr) {
    this.sr = sr;
    this.ring = new TE_Ring(Math.ceil(sr * 22));
    this.tmp = new Float32Array(2);
    this.fader = new TE_Fader(sr);
    this.rng = new Rng(0xC0FFEE);
    this.envD = new EnvFollower(sr, 3, 150); this.envW = new EnvFollower(sr, 3, 150);
    this.reset();
  }
  reset() {
    this.ring.clear(); this.ring.w = 0;
    this.cycle = null; this.active = false; this.act = 0;
    // voice A (current) and B (fading)
    this.va = { pos: 0, rate: 1, gain: 1, panL: 1, panR: 1, live: true, on: false };
    this.vb = { pos: 0, rate: 1, gain: 1, panL: 1, panR: 1, live: false, on: false };
    this.xf = 1; this.xfStep = 0.01;
    this.k = 0; this.t = 0; this.repLen = 1; this.sliceStart = 0; this.sliceLen = 1; this.repContent = 1;
    this.wasOn = false; this.seqStep = -1; this.seqIdx = 0; this.wasBend = false; this.histW = 0;
    // bendit
    this.b = { liveUntil: 0, cycle: null, capStart: 0, T: 1, sub: -1, subLen: 1, j: 0, rate: 1, rateT: 1, dir: 1, drop: false, t: 0, zoneW: 0, zoneB: 0, scratch: 0, beat: null, anchor: 0, depth: 1, srate: 1, captured: false, gate: 1 };
    this.state = { active: 0, k: 0, ph: 0 };
  }
  _repLen(k, base, pattern) {
    switch (pattern) {
      case 1: return base * (k % 3 === 2 ? 1 : 1.5);                 // dotted
      case 2: return base * (2 / 3);                                   // triplet
      case 3: return base * (k & 1 ? 2 / 3 : 4 / 3);                   // swing
      case 4: return Math.max(base / 8, base * Math.pow(0.8, k));      // ramp up (accelerando)
      case 5: return Math.min(base * 4, base * Math.pow(1.2, k));      // ramp down
      default: return base;
    }
  }
  _startRep(p, live) {
    // move current voice to fading slot, start a new voice for rep k
    const va = this.va, vb = this.vb;
    vb.pos = va.pos; vb.rate = va.rate; vb.gain = va.gain; vb.panL = va.panL; vb.panR = va.panR; vb.live = va.live; vb.on = va.on;
    this.xf = 0;
    const k = this.k;
    let semis = p.pitch + p.ramp * k; semis = clamp(semis, -36, 36);
    let ratio = semisToRatio(semis);
    const rev = p.rev >= 0.5 && !live;
    if (live) { ratio = Math.min(1, ratio); }
    va.live = live && ratio === 1;
    va.rate = rev ? -ratio : ratio;
    va.on = true;
    const content = this.repLen * Math.abs(ratio);
    va.pos = rev ? this.sliceStart + Math.min(content, this.repContent) - 1 : this.sliceStart;
    if (va.live) va.pos = this.sliceStart + this.t; // live pass reads the sample just written
    const decay = p.decay / 100;
    va.gain = k === 0 ? 1 : Math.pow(1 - decay * 0.82, k);
    const pan = p.pan / 100 * (k === 0 ? 0 : (k & 1 ? -1 : 1));
    const th = (pan + 1) * Math.PI / 4;
    va.panL = Math.cos(th) * Math.SQRT2; va.panR = Math.sin(th) * Math.SQRT2;
    if (va.panL > 1) va.panL = 1; if (va.panR > 1) va.panR = 1;
  }
  _trigger(p, ctx, rateBeats, backdate) {
    const sr = this.sr;
    this.sliceLen = p.sync >= 0.5 || this._seqDriven ? rateBeats * ctx.spb : p.rate_ms * sr / 1000;
    this.sliceLen = clamp(this.sliceLen, 32, sr * 10);
    this.sliceStart = this.ring.w - 1 - backdate;
    this.repContent = this.sliceLen;
    this.k = 0; this.t = 0; this.repLen = this._repLen(0, this.sliceLen, p.pattern);
    // fast-forward through reps when enabling mid-cycle (beat-aligned switch-on)
    let rem = backdate;
    while (rem >= this.repLen && this.k < 4096) { rem -= this.repLen; this.k++; this.repLen = this._repLen(this.k, this.sliceLen, p.pattern); }
    this.t = rem;
    this.active = true;
    this._startRep(p, this.k === 0);
    if (this.k > 0) { this.va.pos += this.va.rate * rem; }
    this.xf = 1; // no crossfade inside the engine for the first voice: act envelope handles dry→wet
  }
  _gateEnv(u, g, curve) {
    if (g <= 0.001) return 1;
    const open = 1 - 0.92 * g;
    if (u < open) return 1;
    const x = (u - open) / (1 - open); // 0..1 fade region
    switch (curve) { case 1: return 1 - Math.pow(x, 0.35); case 2: return Math.pow(1 - x, 3); default: return 1 - x; }
  }
  _readVoice(v, out) {
    const ring = this.ring;
    if (v.live) { const j = Math.round(v.pos) & ring.mask; out[0] = ring.L[j]; out[1] = ring.R[j]; return; }
    ring.read(ring.safe(v.pos), out);
  }

  process(L, R, n, p, bp, seq, ctx) {
    const on = p.on >= 0.5;
    const ring = this.ring;
    if (!on && this.fader.v === 0) {
      for (let i = 0; i < n; i++) ring.push(L[i], R[i]);
      this.wasOn = false; this.active = false; this.act = 0; this.cycle = null; this.b.cycle = null; this.b.captured = false;
      this.state.active = 0; return;
    }
    const justOn = on && !this.wasOn; this.wasOn = on;
    if (p.bend >= 0.5) {
      const enter = !this.wasBend; this.wasBend = true;
      return this._processBend(L, R, n, p, bp, seq, ctx, justOn || enter);
    }
    if (this.wasBend) { this.wasBend = false; this.cycle = null; }
    const sr = this.sr, spb = ctx.spb, tmp = this.tmp, va = this.va, vb = this.vb;
    const mix = p.mix / 100;
    let rateBeats = p.rate, capBeats = p.capture;
    if (p.link >= 0.5) { const lp = LINK_PRESETS[p.lpreset | 0] || LINK_PRESETS[4]; rateBeats = DIV_BEATS[lp[0]]; capBeats = DIV_BEATS[lp[1]]; }
    const useSeq = p.seq >= 0.5 && seq;
    this._seqDriven = useSeq;
    const smoothN = Math.max(16, p.smooth * sr / 1000);
    this.xfStep = 1 / smoothN;
    const actStep = 1 / smoothN;
    const gate = p.gate / 100, gcurve = p.gcurve | 0, prob = p.prob / 100, retrig = p.retrig / 100;
    for (let i = 0; i < n; i++) {
      const dl = L[i], dr = R[i];
      ring.push(dl, dr);
      const beat = ctx.ppq + i / spb;
      // --- cycle / sequencer triggers ---
      if (useSeq) {
        const stepBeats = seq.rate, total = 16 * seq.chain;
        const si = Math.floor(beat / stepBeats);
        if (si !== this.seqStep) {
          this.seqStep = si;
          const idx = ((si % total) + total) % total; this.seqIdx = idx;
          const st = seq.pats[Math.floor(idx / 16)][idx % 16];
          if (st.on) {
            const rb = DIV_BEATS[TE_SEQ_RATES[Math.round(st.v * (TE_SEQ_RATES.length - 1))]];
            this._trigger(p, ctx, rb, 0);
          } else this.active = false;
        }
      } else {
        const ci = Math.floor(beat / capBeats);
        if (ci !== this.cycle) {
          const first = this.cycle === null || justOn;
          this.cycle = ci;
          if (first) {
            const back = Math.max(0, Math.floor((beat - ci * capBeats) * spb));
            this._trigger(p, ctx, rateBeats, Math.min(back, ring.size - sr));
          } else if (this.rng.next() < prob) this._trigger(p, ctx, rateBeats, 0);
          else this.active = false;
        }
      }
      // --- repetition clock ---
      if (this.active) {
        if (this.t >= this.repLen) {
          this.t -= this.repLen; this.k++;
          let live = false;
          if (retrig > 0 && this.rng.next() < retrig) { this.sliceStart = ring.w - 1; this.k = 0; live = true; }
          this.repLen = this._repLen(this.k, this.sliceLen, p.pattern);
          this._startRep(p, live);
          if (live) this.va.pos = this.sliceStart;
        }
      }
      // --- render voices ---
      let wl = dl, wr = dr;
      if (va.on) {
        this._readVoice(va, tmp);
        const env = this.active ? this._gateEnv(this.t / this.repLen, gate, gcurve) : 1;
        let g = va.gain * env;
        wl = tmp[0] * g * va.panL; wr = tmp[1] * g * va.panR;
        if (this.xf < 1) {
          this._readVoice(vb, tmp);
          const gb = vb.gain * (1 - this.xf), ga = this.xf;
          wl = wl * ga + tmp[0] * gb * vb.panL; wr = wr * ga + tmp[1] * gb * vb.panR;
          vb.pos += vb.rate; this.xf += this.xfStep;
        }
        va.pos += va.rate;
      }
      if (this.active) this.t++;
      // dry ↔ stutter crossfade (linear)
      if (this.active) { this.act += actStep; if (this.act > 1) this.act = 1; }
      else { this.act -= actStep; if (this.act <= 0) { this.act = 0; va.on = false; } }
      wl = dl + (wl - dl) * this.act; wr = dr + (wr - dr) * this.act;
      const f = this.fader.next(on ? 1 : 0) * mix;
      L[i] = dl + (wl - dl) * f; R[i] = dr + (wr - dr) * f;
    }
    this.state.active = this.active ? 1 : 0; this.state.k = this.k; this.state.ph = this.repLen ? this.t / this.repLen : 0;
    this.state.seqIdx = this.seqIdx; this.state.bend = 0;
  }

  // ---- BENDIT ---------------------------------------------------------------
  _scratchRate(kind, ph, depth) {
    // ph: phase within one beat (0..1). returns playback rate (can be negative)
    switch (kind) {
      case 0: return depth * 2.2 * Math.sin(TAU * ph * 2);                         // baby: fwd/back per 1/8
      case 1: return depth * 2.2 * Math.sin(TAU * ph * 2);                         // transformer: baby + chop (gate below)
      case 2: { const x = (ph * 2) % 1; return x < 0.35 ? depth * 3 : x < 0.55 ? -depth * 2 : x < 0.62 ? 0 : -depth * 1.6; } // tear
      default: return depth * 1.4 * Math.sin(TAU * ph * 8) + 0.3;                  // scribble
    }
  }
  _processBend(L, R, n, p, bp, seq, ctx, justOn) {
    const sr = this.sr, spb = ctx.spb, ring = this.ring, tmp = this.tmp, b = this.b, rng = this.rng;
    const va = this.va, vb = this.vb;
    const mix = p.mix / 100;
    const T = clamp(bp.tsync >= 0.5 ? bp.time * spb : bp.time_ms * sr / 1000, 64, sr * 18);
    const cycBeats = Math.max(p.capture, T / spb);
    const warp = bp.warp / 100, brk = bp.brk / 100;
    const zw = zoneOf(WARP_ZONES, warp), zb = zoneOf(BREAK_ZONES, brk);
    const zwAmt = clamp((warp - WARP_ZONES[zw][0]) / (WARP_ZONES[zw][1] - WARP_ZONES[zw][0]), 0, 1);
    const zbAmt = clamp((brk - BREAK_ZONES[zb][0]) / (BREAK_ZONES[zb][1] - BREAK_ZONES[zb][0]), 0, 1);
    const useSeq = p.seq >= 0.5 && seq;
    let reps = zw === 5 ? 1 : Math.max(1, Math.round(bp.reps));
    if (useSeq && zw !== 5) {
      const total = 16 * seq.chain, si = Math.floor((ctx.ppq) / seq.rate), idx = ((si % total) + total) % total;
      const st = seq.pats[Math.floor(idx / 16)][idx % 16]; this.seqIdx = idx;
      if (st.on) reps = 1 + Math.round(st.v * 31);
    }
    const subLen = T / reps;
    const alpha = Math.max(0.04, bp.window / 100);
    const width = bp.width, duck = bp.duck / 100;
    const slewMs = zw === 4 ? 60 : zw === 5 ? 3 : 12;
    const slewC = 1 - Math.exp(-1 / (slewMs * 0.001 * sr));
    const xfN = Math.max(32, 0.006 * sr);
    this.xfStep = 1 / xfN;
    for (let i = 0; i < n; i++) {
      const dl = L[i], dr = R[i];
      ring.push(dl, dr);
      const now = ring.w - 1;
      const beat = ctx.ppq + i / spb;
      // capture cycle: loop the most recent T samples
      const ci = Math.floor(beat / cycBeats);
      if (ci !== b.cycle || justOn) {
        justOn = false;
        b.cycle = ci;
        if (bp.freeze < 0.5 || !b.captured) {
          // loop the most recent T samples; with too little history, record the next T live first
          if (now - this.histW >= T) { b.capStart = now - T; b.liveUntil = 0; }
          else { b.capStart = now; b.liveUntil = now + T; }
          b.captured = true;
        }
        b.T = T; b.sub = -1; b.t = 0;
        b.cycStart = ci * cycBeats;
      }
      // sub-section clock, aligned to the cycle start
      const tc = (beat - b.cycStart) * spb; // samples since cycle start
      const si = Math.floor(tc / subLen);
      if (zw === 5) {
        // SCRATCH: re-roll pattern/depth/anchor every beat, host-quantized on 1/8
        const bi = Math.floor(beat);
        if (bi !== b.beat) {
          b.beat = bi;
          b.drop = false; b.scratch = rng.int(4); b.depth = 0.5 + rng.next() * (0.5 + zwAmt);
          b.anchor = b.capStart + Math.floor(rng.next() * 8) / 8 * T;
          this._swapVoice(); va.pos = b.anchor; va.rate = 0; va.live = false; va.on = true; va.gain = 1; va.panL = va.panR = 1;
        }
        const ph = beat - bi;
        const rr = this._scratchRate(b.scratch, ph, b.depth);
        b.rate += (rr - b.rate) * slewC;
        va.rate = b.rate;
        b.gate = b.scratch === 1 ? ((Math.floor(ph * 8) & 1) ? 0.05 : 1) : 1;
      } else if (si !== b.sub) {
        b.sub = si;
        // choose source sub-section
        let j = ((si % reps) + reps) % reps;
        b.drop = false;
        let nudge = 0;
        if (zb === 1) nudge = (rng.next() - 0.5) * 0.5 * zbAmt;
        else if (zb === 2) { if (rng.next() < 0.15 + 0.35 * zbAmt) j = rng.int(reps); }
        else if (zb === 3) { if (rng.next() < 0.5 + 0.3 * zbAmt) j = rng.int(reps); }
        else if (zb === 4) { j = rng.int(reps); b.drop = rng.next() < 0.25 + 0.35 * zbAmt; }
        b.j = j;
        // choose rate
        let r = 1, dir = 1;
        switch (zw) {
          case 1: r = 1 + (rng.next() * 2 - 1) * 0.5 * (0.3 + 0.7 * zwAmt); break;
          case 2: r = rng.pick([2, 0.5, 1]); break;
          case 3: r = rng.pick([4, 2, 0.5, 0.25, 1]); if (rng.next() < 0.25 * zwAmt) dir = -1; break;
          case 4: r = rng.pick([0.1, 4, 2, 1]); if (rng.next() < 0.3) dir = -1; break;
          case 6: r = Math.pow(2, (rng.next() * 2 - 1) * 3); if (rng.next() < 0.4) dir = -1; break;
          default: r = 1;
        }
        b.rateT = r * dir;
        this.xf = 1; // tukey windows close each sub-section: no voice crossfade needed
        const srcSub = T / reps;
        va.live = false; va.on = true; va.gain = 1; va.panL = va.panR = 1;
        va.pos = b.capStart + (j + nudge) * srcSub + (dir < 0 ? srcSub - 1 : 0);
        if (zw === 0) b.rate = b.rateT;
        b.gate = 1;
      }
      if (zw !== 5) { b.rate += (b.rateT - b.rate) * slewC; va.rate = b.rate; }
      // render
      let wl, wr;
      if (now < b.liveUntil) { // live first pass while the loop is being recorded
        const f0 = this.fader.next(p.on >= 0.5 ? 1 : 0); void f0;
        L[i] = dl; R[i] = dr; va.pos = b.capStart + (now - b.capStart); continue;
      }
      // keep reads inside the captured loop
      va.pos = this._wrapLoop(va.pos, b.capStart, b.T);
      ring.read(ring.safe(va.pos), tmp);
      const u = zw === 5 ? 0.5 : (tc - si * subLen) / subLen;
      const win = zw === 5 ? 1 : tukey(clamp(u, 0, 1), alpha);
      const g = (b.drop ? 0 : 1) * win * b.gate;
      wl = tmp[0] * g; wr = tmp[1] * g;
      if (this.xf < 1) {
        vb.pos = this._wrapLoop(vb.pos, b.capStart, b.T);
        ring.read(ring.safe(vb.pos), tmp);
        const gb = (1 - this.xf) * vb.gain;
        wl = wl * this.xf + tmp[0] * gb; wr = wr * this.xf + tmp[1] * gb;
        vb.pos += vb.rate; this.xf += this.xfStep;
      }
      va.pos += va.rate;
      // width (mid/side)
      if (width !== 1) {
        const m = (wl + wr) * 0.5, s = (wl - wr) * 0.5 * width;
        wl = m + s; wr = m - s;
      }
      // duck: <0 dry ducks wet, >0 wet ducks dry
      let dg = 1, wg = 1;
      if (duck < -0.01) { const e = this.envD.process(Math.abs(dl) + Math.abs(dr)); wg = 1 - (-duck) * clamp(e * 2, 0, 1); }
      else if (duck > 0.01) { const e = this.envW.process(Math.abs(wl) + Math.abs(wr)); dg = 1 - duck * clamp(e * 2, 0, 1); }
      const f = this.fader.next(p.on >= 0.5 ? 1 : 0);
      const m = mix * f;
      L[i] = dl * (1 - m) * dg + wl * m * wg;
      R[i] = dr * (1 - m) * dg + wr * m * wg;
    }
    this.state.active = 1; this.state.bend = 1; this.state.zw = zw; this.state.zb = zb; this.state.j = b.j; this.state.reps = reps;
    this.state.ph = clamp(((ctx.ppq - b.cycStart) * spb) / (b.T || 1), 0, 1); this.state.seqIdx = this.seqIdx;
    this.state.scratch = zw === 5 ? TE_SCRATCH_NAMES[b.scratch] : '';
  }
  _swapVoice() {
    const va = this.va, vb = this.vb;
    vb.pos = va.pos; vb.rate = va.rate; vb.gain = va.gain * (this.b.drop ? 0 : 1); vb.on = va.on; this.xf = 0;
  }
  _wrapLoop(pos, start, T) {
    let x = pos - start;
    if (x >= T || x < 0) x = x - Math.floor(x / T) * T;
    return start + x;
  }
}

// ---------------------------------------------------------------------------
// STRETCH — dual-grain stretcher / freezer
// ---------------------------------------------------------------------------
class Stretch {
  constructor(sr) {
    this.sr = sr;
    this.ring = new TE_Ring(Math.ceil(sr * 12));
    this.tmp = new Float32Array(2);
    this.fader = new TE_Fader(sr);
    this.rng = new Rng(0xBEEF);
    this.MAXG = 8;
    this.grains = [];
    for (let i = 0; i < this.MAXG; i++) this.grains.push({ on: false, pos: 0, rate: 1, t: 0, dur: 1, gl: 1, gr: 1 });
    this.reset();
  }
  reset() {
    this.ring.clear(); this.ring.w = 0;
    for (const g of this.grains) g.on = false;
    this.chunk = null; this.chunkStart = 0; this.readPos = 0; this.gIdx = null; this.gCount = 0; this.gTimer = 0;
    this.wasOn = false; this.seqStep = -1; this.seqIdx = 0; this.seqOn = true; this.seqSpeed = 0.5; this.dry = 1;
    this.state = { pos: 0, speed: 0 };
  }
  _spawn(p, G, ratio, rev, spread) {
    let g = null;
    for (let i = 0; i < this.MAXG; i++) if (!this.grains[i].on) { g = this.grains[i]; break; }
    if (!g) { // steal the oldest
      g = this.grains[0]; for (let i = 1; i < this.MAXG; i++) if (this.grains[i].t > g.t) g = this.grains[i];
    }
    const dur = 2 * G;
    const span = dur * ratio;
    const chunkLen = this.chunkLen;
    let start = this.chunkStart + this.readPos;
    if (p.scatter > 0) start -= this.rng.next() * (p.scatter / 100) * chunkLen * 0.75;
    // read a grain's worth behind so forward grains never reach the write head
    start -= span + 4;
    g.on = true; g.t = 0; g.dur = dur; g.rate = rev ? -ratio : ratio; g.pos = rev ? start + span : start;
    const side = (this.gCount++ & 1) ? 1 : -1;
    const pan = side * spread, th = (pan + 1) * Math.PI / 4;
    g.gl = Math.min(1, Math.cos(th) * Math.SQRT2); g.gr = Math.min(1, Math.sin(th) * Math.SQRT2);
  }
  process(L, R, n, p, seq, ctx) {
    const on = p.on >= 0.5;
    const ring = this.ring;
    if (!on && this.fader.v === 0) { for (let i = 0; i < n; i++) ring.push(L[i], R[i]); this.wasOn = false; return; }
    let justOn = on && !this.wasOn; this.wasOn = on;
    const sr = this.sr, spb = ctx.spb, tmp = this.tmp;
    const mix = p.mix / 100;
    const tempoBeats = p.tempo;
    this.chunkLen = tempoBeats * spb;
    const useSeq = p.seq >= 0.5 && seq;
    let speed = p.speed / 100;
    const sync = p.sync >= 0.5;
    const G = Math.max(32, sync ? p.grain * spb : sr / p.grain_hz);
    let ratio = semisToRatio(p.pitch);
    const rev = p.rev >= 0.5, freeze = p.freeze >= 0.5, spread = p.spread / 100;
    const dryStep = 1 / (0.008 * sr);
    for (let i = 0; i < n; i++) {
      const dl = L[i], dr = R[i];
      if (!freeze || this.chunk === null) ring.push(dl, dr); // FREEZE stops capture
      const now = ring.w - 1;
      const beat = ctx.ppq + i / spb;
      // sequencer: SPEED per step, off-step = dry
      if (useSeq) {
        const si = Math.floor(beat / seq.rate);
        if (si !== this.seqStep) {
          this.seqStep = si; const total = 16 * seq.chain, idx = ((si % total) + total) % total; this.seqIdx = idx;
          const st = seq.pats[Math.floor(idx / 16)][idx % 16]; this.seqOn = !!st.on; this.seqSpeed = st.v;
        }
        speed = this.seqSpeed;
      } else this.seqOn = true;
      // chunk capture
      const ci = Math.floor(beat / tempoBeats);
      if (ci !== this.chunk || justOn) {
        justOn = false;
        if (!freeze || this.chunk === null) {
          const back = this.chunk === null ? Math.floor((beat - ci * tempoBeats) * spb) : 0;
          this.chunkStart = now - back; this.readPos = back * speed;
        }
        this.chunk = ci;
      }
      this.readPos += speed;
      const avail = now - this.chunkStart;
      if (freeze) { const loop = Math.max(64, Math.min(this.chunkLen, avail)); if (this.readPos >= loop) this.readPos -= loop * Math.floor(this.readPos / loop); }
      else if (this.readPos > avail) this.readPos = avail;
      // grain scheduling
      let fire = false;
      if (sync) { const gi = Math.floor(beat / p.grain); if (gi !== this.gIdx) { this.gIdx = gi; fire = true; } }
      else { this.gTimer -= 1; if (this.gTimer <= 0) { this.gTimer += G; fire = true; } }
      const r = p.link >= 0.5 ? ratio * Math.max(0.125, speed) : ratio;
      if (fire) this._spawn(p, G, r, rev, spread);
      // render grains
      let wl = 0, wr = 0;
      for (let k = 0; k < this.MAXG; k++) {
        const g = this.grains[k]; if (!g.on) continue;
        const w = hann(g.t / g.dur);
        ring.read(ring.safe(g.pos), tmp);
        wl += tmp[0] * w * g.gl; wr += tmp[1] * w * g.gr;
        g.pos += g.rate; g.t++;
        if (g.t >= g.dur) g.on = false;
      }
      // seq off-step → dry
      if (this.seqOn) { this.dry -= dryStep; if (this.dry < 0) this.dry = 0; } else { this.dry += dryStep; if (this.dry > 1) this.dry = 1; }
      wl = wl + (dl - wl) * this.dry; wr = wr + (dr - wr) * this.dry;
      const f = this.fader.next(on ? 1 : 0) * mix;
      L[i] = dl + (wl - dl) * f; R[i] = dr + (wr - dr) * f;
    }
    this.state.pos = this.chunkLen ? clamp(this.readPos / this.chunkLen, 0, 1) : 0; this.state.speed = speed; this.state.seqIdx = this.seqIdx;
  }
}
