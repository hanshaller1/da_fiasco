// Click detector for the time engines: feeds a sine and counts steps in the output, i.e. second
// differences far larger than a sine of that level can produce even when pitched up ~20x
// (a step of size d shows up as a second difference of about d). The sine (97.37 Hz) does not
// fit the 2-beat loop or the 4 s source a whole number of times, so loop seams and wraps are
// not hidden by a zero crossing. Usage: node tools/test-clicks.mjs
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['lib.js', 'params.js', 'units.js', 'time-engines.js', 'core.js']) vm.runInThisContext(fs.readFileSync(path.join(root, 'src/dsp', f), 'utf8'), { filename: f });
const E = vm.runInThisContext('DebacleEngine'); const SR = 48000, HZ = 97.37;
const LIMIT = 0.02;
let fails = 0;
// events: [[block, [messages...]], ...] applied while playing
function test(label, params, allow = 0, events = [], secs = 8, limit = LIMIT) {
  const eng = new E(SR, () => {});
  const L = new Float32Array(SR * 4); for (let i = 0; i < L.length; i++) L[i] = 0.3 * Math.sin(2 * Math.PI * HZ * i / SR);
  eng.handle({ type: 'source', L, R: L }); eng.handle({ type: 'play', on: true });
  for (const [k, n] of params) eng.handle({ type: 'param', k, n });
  const o = [new Float32Array(128), new Float32Array(128)]; let p1 = 0, p2 = 0, worst = 0, cnt = 0;
  for (let b = 0; b < SR * secs / 128; b++) {
    for (const [at, msgs] of events) if (at === b) for (const m of msgs) eng.handle(m);
    eng.process(null, null, o[0], o[1], 128);
    for (let i = 0; i < 128; i++) { const x = o[0][i], d = Math.abs(x - 2 * p1 + p2); if (b > 30 && d > limit) { cnt++; worst = Math.max(worst, d); } p2 = p1; p1 = x; }
  }
  const ok = cnt <= allow; if (!ok) fails++;
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label.padEnd(26), 'jumps', String(cnt).padStart(4), 'worst', worst.toFixed(3));
}
const P = (k, n) => ({ type: 'param', k, n });
const at = (s) => Math.round(s * SR / 128);
const S = [['stutter.on', 1]], B = [['stutter.on', 1], ['stutter.bend', 1]], T = [['stretch.on', 1]], V = [['vari.on', 1]];
test('dry', []);
test('vari', V); test('vari fwd-rev', [...V, ['vari.mode', 0.5]]); test('vari rev 1/8', [...V, ['vari.mode', 1], ['vari.tempo', 0.5]]);
test('stutter', S); test('stutter prob 50', [...S, ['stutter.prob', 0.5]]); test('stutter pitch ramp', [...S, ['stutter.pitch', 0.8], ['stutter.ramp', 0.6]]);
test('stutter gate', [...S, ['stutter.gate', 0.6]]); test('stutter reverse', [...S, ['stutter.rev', 1]]); test('stutter retrig', [...S, ['stutter.retrig', 0.5]]); test('stutter seq', [...S, ['stutter.seq', 1]]);
// repeats shorter than SMOOTH (overlapping crossfades) and pitched-up repeats that outrun the recording
test('stutter 1/256 smooth 50', [...S, ['stutter.rate', 1], ['stutter.smooth', 1], ['stutter.retrig', 0.3]]);
// (+36 st reads 8x: a fading voice that reaches the write head stops there, a corner, not a step)
test('stutter pitch+ramp max', [...S, ['stutter.pitch', 1], ['stutter.ramp', 1]], 0, [], 8, 0.05);
test('bend', B); test('bend lurch', [...B, ['bend.warp', 0.5]]); test('bend scratch', [...B, ['bend.warp', 0.78]]);
test('bend havoc', [...B, ['bend.warp', 0.95]]);
test('bend reps changes', [...B, ['bend.window', 0.5]], 0, Array.from({ length: 20 }, (_, i) => [at(2.2) + i * 37, [P('bend.reps', ((i * 7) % 31) / 31)]]));
test('stretch', T); test('stretch freeze', [...T, ['stretch.freeze', 1]]); test('stretch pitch scatter', [...T, ['stretch.pitch', 0.9], ['stretch.scatter', 0.5]]);
test('stretch reverse', [...T, ['stretch.rev', 1]]); test('stretch rev freeze', [...T, ['stretch.rev', 1], ['stretch.freeze', 1]]); test('stretch rev slow', [...T, ['stretch.rev', 1], ['stretch.speed', 0.2]]);
test('stretch seq', [...T, ['stretch.seq', 1]]);
// switching while playing
test('stutter <-> bend', S, 0, [[at(3.1), [P('stutter.bend', 1)]], [at(5.3), [P('stutter.bend', 0)]]]);
test('engine order switches', [...S, ...V], 0, [[at(3.1), [P('time.order', 1)]], [at(4.4), [P('time.order', 0.67)]], [at(5.6), [P('time.order', 0)]]]);
test('parallel engine toggle', [...V, ['time.order', 1]], 0, [[at(3.1), [P('stretch.on', 1)]], [at(5.1), [P('vari.on', 0)]]]);
test('transport restart', T, 0, [[at(3.3), [{ type: 'play', on: true }]]]);
test('transport stop', S, 0, [[at(3.3), [{ type: 'play', on: false }]]]);
test('bpm change', S, 0, [[at(3), [{ type: 'bpm', bpm: 121 }]], [at(5), [{ type: 'bpm', bpm: 90 }]]]);
console.log(fails ? fails + ' failing' : 'all click-free'); process.exit(fails ? 1 : 0);
