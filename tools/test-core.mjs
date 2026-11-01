// Core engine smoke test: node tools/test-core.mjs [fx files...]
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fxFiles = process.argv.slice(2);
for (const f of ['src/dsp/lib.js', 'src/dsp/params.js', 'src/dsp/units.js', ...fxFiles, 'src/dsp/time-engines.js', 'src/dsp/core.js'])
  vm.runInThisContext(fs.readFileSync(path.resolve(root, f), 'utf8') + '\n', { filename: f });
const E = vm.runInThisContext('DebacleEngine');
const SR = 48000, msgs = [];
const eng = new E(SR, (m) => msgs.push(m));
// 2-bar drum + chord source at 120 bpm
const len = SR * 4; const L = new Float32Array(len), R = new Float32Array(len);
let s = 1; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
for (let i = 0; i < len; i++) { const t = i / SR, b = (t * 2) % 1; L[i] = R[i] = 0.6 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-b * 30)) * b) * Math.exp(-b * 7) + 0.1 * Math.sin(2 * Math.PI * 330 * t) + ((Math.floor(t * 4) % 2) ? rnd() * Math.exp(-((t * 4) % 1) * 20) * 0.3 : 0); }
eng.handle({ type: 'source', L, R }); eng.handle({ type: 'bpm', bpm: 120 }); eng.handle({ type: 'play', on: true });
const out = [new Float32Array(128), new Float32Array(128)];
function run(label, secs, setup) {
  for (const [k, n] of setup) eng.handle({ type: 'param', k, n });
  let peak = 0, rms = 0, bad = false; const t0 = performance.now(); const N = Math.floor(secs * SR / 128);
  for (let b = 0; b < N; b++) { eng.process(null, null, out[0], out[1], 128); for (let i = 0; i < 128; i++) { const v = out[0][i]; if (!Number.isFinite(v)) bad = true; peak = Math.max(peak, Math.abs(v)); rms += v * v; } }
  const ms = performance.now() - t0;
  console.log(label.padEnd(28), 'peak', peak.toFixed(2), 'rms', Math.sqrt(rms / (N * 128)).toFixed(3), 'cpu', (ms / secs / 10).toFixed(2) + '%', bad ? 'NaN!' : '');
}
const off = (u) => [[u + '.on', 0]];
run('dry', 2, []);
run('vari', 3, [['vari.on', 1]]);
run('vari stop', 2, [['vari.stop', 1]]);
run('vari scratch', 1, [['vari.stop', 0], ['vari.scratch', 0.1]]);
run('vari rev crush comp', 2, [['vari.scratch', 0.5], ['vari.mode', 1], ['vari.dist', 1], ['vari.comp', 0.8]]);
run('stutter', 3, [...off('vari'), ['stutter.on', 1]]);
run('stutter pitch ramp pattern', 3, [['stutter.ramp', 0.8], ['stutter.pattern', 0.8], ['stutter.gate', 0.5], ['stutter.pan', 1], ['stutter.retrig', 0.3], ['stutter.rev', 1]]);
run('stutter seq', 3, [['stutter.seq', 1]]);
run('stutter link', 2, [['stutter.seq', 0], ['stutter.link', 1]]);
run('bendit', 4, [['stutter.bend', 1], ['bend.warp', 0.3], ['bend.brk', 0.4]]);
run('bendit lurch drop', 4, [['bend.warp', 0.5], ['bend.brk', 0.85], ['bend.width', 1], ['bend.duck', 0.2]]);
run('bendit scratch', 4, [['bend.warp', 0.78]]);
run('bendit havoc freeze', 4, [['bend.warp', 0.95], ['bend.freeze', 1], ['bend.tsync', 0]]);
run('stretch', 3, [...off('stutter'), ['stutter.bend', 0], ['stretch.on', 1]]);
run('stretch freeze pitch', 3, [['stretch.freeze', 1], ['stretch.pitch', 1], ['stretch.scatter', 0.6], ['stretch.speed', 0]]);
run('stretch seq free', 3, [['stretch.freeze', 0], ['stretch.seq', 1], ['stretch.sync', 0], ['stretch.rev', 1]]);
run('all parallel', 3, [['vari.on', 1], ['stutter.on', 1], ['time.order', 1]]);
eng.handle({ type: 'slots', slots: [{ src: 'lfo1', target: 'vari.speed', min: 0.2, max: 1 }, { src: 'lfo2', target: 'stutter.pitch', min: 0, max: 1 }, { src: 'm1', target: 'main.gain', min: 0.5, max: 0.75 }] });
run('mods', 2, [['lfo2.mode', 0.5], ['perform.m1', 0.5]]);
run('main comp auto eq', 2, [['main.comp', 0.8], ['main.auto', 1], ['main.low', 1], ['main.high', 0], ['main.pan', 0.2], ['main.mix', 0.5]]);
eng.handle({ type: 'print', len: SR * 2 });
run('print', 5, []);
console.log('ticks', msgs.filter((m) => m.type === 'tick').length, 'printed', msgs.some((m) => m.type === 'printed'));
const last = msgs.filter((m) => m.type === 'tick').pop(); console.log(JSON.stringify(last).slice(0, 400));

// ---- regression checks (fail the run) ------------------------------------------------------
let fails = 0;
const check = (label, ok, info = '') => { if (!ok) fails++; console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label.padEnd(34), info); };
const hasFx = (id) => !!eng.fx[id];
// steps in the output (second difference), sine source that does not fit the loop
function clicks(sr, setup, events, secs = 6) {
  const e = new E(sr, () => {}); const n = sr * 4, S = new Float32Array(n);
  for (let i = 0; i < n; i++) S[i] = 0.3 * Math.sin(2 * Math.PI * 97.37 * i / sr);
  e.handle({ type: 'source', L: S, R: S.slice() }); e.handle({ type: 'play', on: true });
  for (const m of setup) e.handle(m);
  const o = [new Float32Array(128), new Float32Array(128)]; let p1 = 0, p2 = 0, worst = 0, bad = false;
  for (let b = 0; b < secs * sr / 128; b++) {
    for (const [at, msgs] of events) if (at === b) for (const m of msgs) e.handle(m);
    e.process(null, null, o[0], o[1], 128);
    for (let i = 0; i < 128; i++) { const x = o[0][i]; if (!Number.isFinite(x)) bad = true; if (b > 30) worst = Math.max(worst, Math.abs(x - 2 * p1 + p2)); p2 = p1; p1 = x; }
  }
  return { worst, bad, eng: e };
}
const Pm = (k, n) => ({ type: 'param', k, n }), blk = (s) => Math.round(s * SR / 128);
if (hasFx('smear') && hasFx('eq') && hasFx('clip')) {
  let r = clicks(SR, [{ type: 'chain', ids: ['smear'] }, Pm('fx.smear.on', 1), Pm('fx.smear.mix', 0.5)], [[blk(2.1), [Pm('fx.smear.on', 0)]], [blk(4.1), [Pm('fx.smear.on', 1)]]]);
  check('fft fx on/off (serial, mix 50)', r.worst < 0.02, 'worst step ' + r.worst.toFixed(3));
  r = clicks(SR, [{ type: 'chain', ids: ['smear'] }, Pm('fx.smear.on', 1)], [[blk(2.1), [Pm('fx.smear.on', 0)]]]);
  check('fft fx off (serial, mix 100)', r.worst < 0.02, 'worst step ' + r.worst.toFixed(3));
  r = clicks(SR, [{ type: 'chain', ids: ['eq', 'clip', 'smear'] }, Pm('chain.mode', 1), Pm('fx.eq.on', 1)], [[blk(1.6), [Pm('fx.clip.on', 1)]], [blk(3.1), [Pm('fx.smear.on', 1)]], [blk(4.6), [Pm('fx.eq.on', 0)]]]);
  check('parallel chain toggles + fft', r.worst < 0.05 && !r.bad, 'worst step ' + r.worst.toFixed(3));
  r = clicks(SR, [{ type: 'chain', ids: ['smear'] }, Pm('main.mix', 0.5)], [[blk(2.1), [Pm('fx.smear.on', 1)]], [blk(4.1), [Pm('fx.smear.on', 0)]]]);
  check('main mix 50 + fft latency change', r.worst < 0.02, 'worst step ' + r.worst.toFixed(3));
  r = clicks(SR, [{ type: 'chain', ids: ['eq', 'smear', 'clip'] }, Pm('fx.eq.on', 1), Pm('fx.smear.on', 1), Pm('fx.clip.on', 1)], [[blk(2.1), [Pm('chain.mode', 1)]], [blk(3.6), [Pm('chain.mode', 0)]], [blk(5.1), [Pm('chain.mode', 1)]]], 7);
  check('serial <-> parallel with fft on', r.worst < 0.02, 'worst step ' + r.worst.toFixed(3));
  r = clicks(SR, [{ type: 'chain', ids: ['eq', 'clip', 'chorus'] }, Pm('fx.eq.on', 1), Pm('fx.clip.on', 1), Pm('fx.chorus.on', 1)], [[blk(2.1), [{ type: 'chain', ids: ['clip', 'chorus', 'eq'] }]], [blk(3.6), [{ type: 'chain', ids: ['chorus', 'eq'] }]], [blk(5.1), [{ type: 'chain', ids: ['chorus', 'eq', 'clip'] }]]], 7);
  check('reorder / remove / add while on', r.worst < 0.02, 'worst step ' + r.worst.toFixed(3));
  r = clicks(SR, [{ type: 'chain', ids: ['smear'] }, Pm('fx.smear.on', 1), Pm('fx.smear.mix', 0.5)], [[blk(2.1), [Pm('fx.smear.size', 1)]]]);
  check('fft size 4K: latency follows', r.eng.fx.smear.lat() === 4096 && r.worst < 0.02, 'latency ' + r.eng.fx.smear.lat() + ', worst step ' + r.worst.toFixed(3));
}
{ // malformed messages must not poison the engine
  const r = clicks(SR, [Pm('stutter.on', 1), Pm('stutter.seq', 1), Pm('sseq.chain', 1), Pm('vari.speed', NaN), { type: 'bpm', bpm: NaN },
    { type: 'seq', which: 'stutter', pats: [[{ on: 1 }]] }, { type: 'graph', i: 0, points: [{ x: 'a' }] }, { type: 'source', L: new Float32Array(0) },
    { type: 'slots', slots: [{ src: 'lfo1', target: 'vari.wow', min: 'x', max: null }, { src: 'nope', target: 'main.gain' }] }], []);
  check('malformed messages', !r.bad && r.eng.ctx.spb > 0, 'finite output, bpm ' + r.eng.ctx.bpm);
}
{ // the beat clock follows tempo changes without jumping; stop continues from the play position
  const e = new E(SR, () => {}); e.handle({ type: 'play', on: true });
  const o = [new Float32Array(128), new Float32Array(128)]; let prev = 0, maxJump = 0;
  for (let b = 0; b < 3000; b++) {
    if (b === 1000) e.handle({ type: 'bpm', bpm: 300 }); if (b === 1500) e.handle({ type: 'bpm', bpm: 30 }); if (b === 2000) e.handle({ type: 'play', on: false });
    e.process(null, null, o[0], o[1], 128);
    if (b > 0) maxJump = Math.max(maxJump, Math.abs(e.ctx.ppq - prev)); prev = e.ctx.ppq;
  }
  check('ppq continuous (bpm 30/300, stop)', maxJump < 128 / (SR * 60 / 300) + 1e-6, 'max step ' + maxJump.toFixed(4) + ' beats/block');
}
for (const sr of [44100, 96000]) { // everything on at other sample rates and extreme tempi
  for (const bpm of [30, 300]) {
    const r = clicks(sr, [{ type: 'bpm', bpm }, Pm('vari.on', 1), Pm('stutter.on', 1), Pm('stretch.on', 1), Pm('bend.warp', 0.6), Pm('time.order', 1)], [[Math.round(1.5 * sr / 128), [Pm('stutter.bend', 1)]]], 3);
    check(`engines @${sr} Hz, ${bpm} bpm`, !r.bad && r.worst < 0.05, 'worst step ' + r.worst.toFixed(3));
  }
}
console.log(fails ? fails + ' regression checks failing' : 'regression checks ok');
process.exit(fails ? 1 : 0);
