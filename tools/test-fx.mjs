// Effect test harness.  Usage:  node tools/test-fx.mjs src/dsp/fx-drive.js [more files] [--only id] [--quick]
// Loads lib.js + params.js + the given effect files into a vm context (like the
// AudioWorkletGlobalScope), then for every registered effect:
//   * validates metadata (id/label/cat/params)
//   * renders test signals with default params and with random param sets
//   * checks for NaN/Inf, runaway levels, silence-in → silence-out, CPU cost
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const quick = args.includes('--quick');
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');

// Scripts run in this realm's global scope (like classic scripts in the worklet):
// top-level const/class are shared between files, so name clashes throw — as they would in the browser.
// (A separate vm context would make global lookups ~10x slower and distort the CPU numbers.)
const load = (f) => vm.runInThisContext(fs.readFileSync(path.resolve(root, f), 'utf8') + '\n', { filename: f });
load('src/dsp/lib.js');
load('src/dsp/params.js');
for (const f of files) load(f);
const G = (code) => vm.runInThisContext(code);

const REG = G('FX_REGISTRY');
const KeyHelper = G('KeyHelper');
const prepParam = G('prepParam'), normToValue = G('normToValue');
const SR = 48000, BLOCK = 128;

function makeSignals(len) {
  const sig = {};
  let s = 12345; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  // drum-ish loop: kick + snare noise + hats at 120 bpm
  const dL = new Float32Array(len), dR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR, beat = (t * 2) % 1, half = (t * 4) % 1;
    const k = Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 8);
    const sn = ((Math.floor(t * 2) % 2) === 1 ? rnd() * Math.exp(-beat * 18) * 0.5 : 0);
    const hh = rnd() * Math.exp(-half * 60) * 0.2;
    dL[i] = 0.6 * k + sn + hh; dR[i] = 0.6 * k + sn * 0.8 + hh * 1.2;
  }
  sig.drums = [dL, dR];
  // chord pad (saw-ish)
  const pL = new Float32Array(len), pR = new Float32Array(len);
  const fr = [220, 261.6, 329.6, 392];
  for (let i = 0; i < len; i++) { let a = 0; for (const f of fr) a += ((i * f / SR) % 1) * 2 - 1; pL[i] = a * 0.15; pR[i] = a * 0.15; }
  sig.pad = [pL, pR];
  // noise
  const nL = new Float32Array(len), nR = new Float32Array(len);
  for (let i = 0; i < len; i++) { nL[i] = rnd() * 0.5; nR[i] = rnd() * 0.5; }
  sig.noise = [nL, nR];
  // full-scale sine 100 Hz (stress)
  const sL = new Float32Array(len), sR = new Float32Array(len);
  for (let i = 0; i < len; i++) { sL[i] = sR[i] = Math.sin(2 * Math.PI * 100 * i / SR); }
  sig.sine = [sL, sR];
  return sig;
}

function render(fx, params, inL, inR, ctx, outL, outR) {
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  let t = 0, bad = false, peak = 0, ms = 0;
  for (let off = 0; off < inL.length; off += BLOCK) {
    const n = Math.min(BLOCK, inL.length - off);
    L.set(inL.subarray(off, off + n)); R.set(inR.subarray(off, off + n));
    ctx.ppq = (off / SR) * ctx.bpm / 60; ctx.time = off;
    const t0 = performance.now();
    fx.process(L, R, n, params, ctx);
    ms += performance.now() - t0;
    for (let i = 0; i < n; i++) {
      const a = L[i], b = R[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) { bad = true; break; }
      const m = Math.max(Math.abs(a), Math.abs(b)); if (m > peak) peak = m;
      if (outL) { outL[off + i] = a; outR[off + i] = b; }
    }
    if (bad) break;
    t += n;
  }
  return { ms, bad, peak };
}

function makeCtx() {
  const key = new KeyHelper(); key.set(9, 'MINOR', 0, 0);
  return { sr: SR, bpm: 120, spb: SR * 60 / 120, ppq: 0, playing: true, time: 0, blockSize: BLOCK, key, sidechain: null };
}

const seconds = quick ? 1 : 2;
const LEN = SR * seconds;
const signals = makeSignals(LEN);
let failures = 0;
const ids = new Set();
const rows = [];
for (const cls of REG) {
  if (only && cls.id !== only) continue;
  const errs = [], warns = [];
  if (!cls.id || !/^[a-z0-9_]+$/.test(cls.id)) errs.push('bad id');
  if (ids.has(cls.id)) errs.push('duplicate id'); ids.add(cls.id);
  if (!cls.label) errs.push('no label');
  if (!cls.cat) errs.push('no cat');
  if (!Array.isArray(cls.params) || !cls.params.length) errs.push('no params');
  const pids = new Set();
  for (const d of cls.params || []) {
    try { prepParam(d); } catch (e) { errs.push('param ' + d.id + ': ' + e.message); continue; }
    if (pids.has(d.id)) errs.push('dup param ' + d.id); pids.add(d.id);
    if (['mix', 'gain', 'on'].includes(d.id)) errs.push(`param id "${d.id}" is reserved by the host`);
    if (!/^[a-z0-9_]+$/.test(d.id)) errs.push('bad param id ' + d.id);
    if (d.kind === 'num' && !(d.max > d.min)) errs.push('param range ' + d.id);
    if (d.kind === 'div' && (!d.options.length)) errs.push('div range ' + d.id);
  }
  if ((cls.params || []).length > 12) warns.push(`${cls.params.length} params (keep ≤ 12)`);
  let fx;
  try { fx = new cls(SR); } catch (e) { errs.push('ctor: ' + e.message); }
  let worstMs = 0, worstPeak = 0;
  if (fx && !errs.length) {
    const defP = {}; for (const d of cls.params) defP[d.id] = normToValue(d, d.defN);
    const runs = [['default', defP]];
    let seed = 99; const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let k = 0; k < (quick ? 6 : 16); k++) { const p = {}; for (const d of cls.params) p[d.id] = normToValue(d, k === 0 ? 1 : k === 1 ? 0 : r()); runs.push(['rand' + k, p]); }
    for (const [name, p] of runs) {
      for (const sname of ['drums', 'pad', 'noise', 'sine']) {
        if (name !== 'default' && sname === 'sine' && !quick) continue;
        try {
          fx.reset();
          const ctx = makeCtx();
          const res = render(fx, p, signals[sname][0], signals[sname][1], ctx);
          if (res.bad) { errs.push(`NaN/Inf (${name}/${sname})`); break; }
          worstMs = Math.max(worstMs, res.ms / seconds); worstPeak = Math.max(worstPeak, res.peak);
          if (res.peak > 16) errs.push(`peak ${res.peak.toFixed(1)} (${name}/${sname})`);
          else if (res.peak > 4 && name === 'default') warns.push(`default peak ${res.peak.toFixed(2)} on ${sname}`);
        } catch (e) { errs.push(`throw (${name}/${sname}): ${e.message}`); break; }
      }
      if (errs.length) break;
    }
    // silence after signal: feed 1s drums then 3s silence with defaults, check tail decays (warn only)
    if (!errs.length) {
      fx.reset(); const ctx = makeCtx();
      const len = SR * 4, inL = new Float32Array(len), inR = new Float32Array(len);
      inL.set(signals.drums[0].subarray(0, SR)); inR.set(signals.drums[1].subarray(0, SR));
      const oL = new Float32Array(len), oR = new Float32Array(len);
      render(fx, defP, inL, inR, ctx, oL, oR);
      let tail = 0; for (let i = len - SR / 2; i < len; i++) tail = Math.max(tail, Math.abs(oL[i]), Math.abs(oR[i]));
      if (tail > 0.05) warns.push(`tail after 3s silence = ${tail.toFixed(3)} (ok only for drones/self-osc)`);
      // pass-through sanity: default should not be silent on drums
      fx.reset(); const c2 = makeCtx(); const o2L = new Float32Array(SR), o2R = new Float32Array(SR);
      render(fx, defP, signals.drums[0].subarray(0, SR), signals.drums[1].subarray(0, SR), c2, o2L, o2R);
      let e = 0; for (let i = 0; i < SR; i++) e += o2L[i] * o2L[i] + o2R[i] * o2R[i];
      if (e / SR < 1e-5) warns.push('default output near-silent on drums');
    }
  }
  const cpu = worstMs / 10; // ms per second → % of realtime
  if (cpu > (cls.latency ? 6 : 3)) warns.push(`CPU ${cpu.toFixed(2)}% realtime (budget ${cls.latency ? 6 : 3}%)`);
  if (errs.length) failures++;
  rows.push({ id: cls.id, label: cls.label, cat: cls.cat, cpu: cpu.toFixed(2) + '%', peak: worstPeak.toFixed(2), status: errs.length ? 'FAIL' : warns.length ? 'warn' : 'ok', notes: [...errs, ...warns].join('; ') });
}
console.table(rows);
console.log(`${rows.length} effects, ${failures} failed`);
process.exit(failures ? 1 : 0);
