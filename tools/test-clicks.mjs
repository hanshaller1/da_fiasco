// Click detector for the time engines: feeds a 110 Hz sine and counts sample-to-sample jumps
// larger than a sine of that level can produce. Usage: node tools/test-clicks.mjs
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['lib.js', 'params.js', 'units.js', 'time-engines.js', 'core.js']) vm.runInThisContext(fs.readFileSync(path.join(root, 'src/dsp', f), 'utf8'), { filename: f });
const E = vm.runInThisContext('DebacleEngine'); const SR = 48000;
let fails = 0;
function test(label, params, allow = 0) {
  const eng = new E(SR, () => {});
  const L = new Float32Array(SR * 4); for (let i = 0; i < L.length; i++) L[i] = 0.3 * Math.sin(2 * Math.PI * 110 * i / SR);
  eng.handle({ type: 'source', L, R: L }); eng.handle({ type: 'play', on: true });
  for (const [k, n] of params) eng.handle({ type: 'param', k, n });
  const o = [new Float32Array(128), new Float32Array(128)]; let prev = 0, worst = 0, cnt = 0;
  for (let b = 0; b < SR * 8 / 128; b++) { eng.process(null, null, o[0], o[1], 128); for (let i = 0; i < 128; i++) { const d = Math.abs(o[0][i] - prev); if (b > 400 && d > 0.03) { cnt++; worst = Math.max(worst, d); } prev = o[0][i]; } }
  const ok = cnt <= allow; if (!ok) fails++;
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label.padEnd(24), 'jumps', String(cnt).padStart(4), 'worst', worst.toFixed(3));
}
const S = [['stutter.on', 1]], B = [['stutter.on', 1], ['stutter.bend', 1]], T = [['stretch.on', 1]], V = [['vari.on', 1]];
test('dry', []);
test('vari', V); test('vari fwd-rev', [...V, ['vari.mode', 0.5]]); test('vari rev 1/8', [...V, ['vari.mode', 1], ['vari.tempo', 0.5]]);
test('stutter', S); test('stutter prob 50', [...S, ['stutter.prob', 0.5]]); test('stutter pitch ramp', [...S, ['stutter.pitch', 0.8], ['stutter.ramp', 0.6]]);
test('stutter gate', [...S, ['stutter.gate', 0.6]]); test('stutter reverse', [...S, ['stutter.rev', 1]]); test('stutter retrig', [...S, ['stutter.retrig', 0.5]]); test('stutter seq', [...S, ['stutter.seq', 1]]);
test('bend', B); test('bend lurch', [...B, ['bend.warp', 0.5]]); test('bend scratch', [...B, ['bend.warp', 0.78]]);
test('stretch', T); test('stretch freeze', [...T, ['stretch.freeze', 1]]); test('stretch pitch scatter', [...T, ['stretch.pitch', 0.9], ['stretch.scatter', 0.5]]);
test('stretch reverse', [...T, ['stretch.rev', 1]]); test('stretch rev freeze', [...T, ['stretch.rev', 1], ['stretch.freeze', 1]]); test('stretch rev slow', [...T, ['stretch.rev', 1], ['stretch.speed', 0.2]]);
test('stretch seq', [...T, ['stretch.seq', 1]]);
console.log(fails ? fails + ' failing' : 'all click-free'); process.exit(fails ? 1 : 0);
