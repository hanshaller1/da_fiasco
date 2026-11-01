# DEBACLE — Effect API (for FX authors)

DEBACLE is a browser (Web Audio) loop-mangling instrument inspired by the functional
spec in `docs/briefing.md`. All DSP runs in **one AudioWorklet** written in plain
JavaScript. Effects are classes registered into a global registry. The host (core
processor) builds the FX chain, routes audio, and handles common chores.

## Files

- `src/dsp/lib.js` — shared helpers (globals): `TAU clamp lerp dbToGain gainToDb mtof ftom
  semisToRatio fastTanh softClip hann tukey Rng Smoother EnvFollower OnePole Biquad SVF
  Allpass1 DCBlock DelayLine SchroederAP FFT STFT princArg DIV_TABLE DIV_BEATS divRange
  KeyHelper SCALES FX registerFX`. **Read it before writing code** and reuse it.
- `src/dsp/params.js` — parameter descriptor mapping (normalized ↔ value).
- `src/dsp/fx-<bank>.js` — your file. Plain script, no `import`/`export`, no DOM, no
  `window`, no `setTimeout`. Everything top-level becomes a global in the worklet scope,
  so **wrap your helpers in an IIFE or prefix their names** with your bank name
  (e.g. `const SPC_grainWin = ...`) to avoid collisions with other banks.
- `tools/test-fx.mjs` — test harness: `node tools/test-fx.mjs src/dsp/fx-<bank>.js`
  (`--only <id>` for one effect, `--quick` for faster runs). Must report 0 FAIL.

## Effect class

```js
registerFX(class extends FX {
  static id = 'crush';              // unique, [a-z0-9_]
  static label = 'CRUSH';           // UI name, UPPERCASE, ≤ 10 chars
  static cat = 'DISTORTION';        // category (see list below)
  static desc = 'Bitcrusher with sample-rate reduction and odd converter models.'; // one sentence
  static latency = 0;               // samples of added latency (FFT effects: N of the STFT)
  // optional, for a latency that changes at run time (e.g. a SIZE param): set this.latency in the
  // instance (≤ maxLatency) and the host's dry compensation follows it (crossfaded)
  static maxLatency = 0;
  static params = [ /* descriptors, ≤ 12, see below */ ];

  init() { /* allocate buffers; this.sr is the sample rate */ }
  reset() { /* clear state; default calls init() */ }
  process(L, R, n, p, ctx) { /* in place on L/R (Float32Array, length n ≤ 128) */ }
});
```

### Parameter descriptors (`static params`)
- Number: `{ id:'drive', label:'DRIVE', min:0, max:100, def:30, unit:'%' }`
  - `curve: 'lin' | 'exp' | 'sq' | 'int'` (exp needs min > 0, e.g. frequencies, times)
  - `unit`: `'%' 'Hz' 'ms' 'dB' 'st' 's' '×' '°'` or omit. `bipolar:true` for ±ranges (UI hint).
- Enum: `{ id:'model', label:'MODEL', options:['CLASSIC','MU-LAW'], def:0 }` → `p.model` is the **index**.
- Toggle: `{ id:'rev', label:'REVERSE', toggle:true, def:0 }` → `p.rev` is 0/1.
- Tempo division: `{ id:'rate', label:'RATE', div:['1/1','1/64'], def:'1/8' }` → `p.rate` is
  in **beats** (quarter notes). Convert with `p.rate * ctx.spb` samples. Labels available
  in `DIV_TABLE` (`'16/1' … '1/512'`, with `D`otted and `T`riplet). `straight:true`
  drops dotted/triplet.
- **Reserved ids — do not use:** `on`, `mix`, `gain`. The host adds **MIX** (dry/wet)
  and **GAIN** (−12…+12 dB) to every effect automatically, plus ON/OFF with a 10 ms
  fade, NaN/Inf guard and state reset on enable. So your `process` should output
  **100 % wet**. Exception: if your effect is inherently parallel (exciter, sub
  generator, "blend"-type), mix internally and design the wet output to sound good at
  host MIX = 100 %.
- Snap to key: add `{ id:'snap', label:'SNAP', toggle:true, def:0 }` and, when on, use
  `ctx.key` to quantize the relevant frequency/pitch/interval.
- Keep ≤ 12 params, ordered most important first (first 6 are the "front panel").
- `p` values arrive **once per block** (128 samples). Smooth anything that would zipper
  (gains, delay times, cutoff) per sample with `Smoother` or a one-pole.

### `ctx` (shared, read-only)
```
ctx.sr        sample rate
ctx.bpm       tempo
ctx.spb       samples per beat (quarter note)
ctx.ppq       beat position (float, quarter notes) at the start of this block; sample i is at
              ppq + i / spb. Use it to lock rhythmic things to the grid (e.g. new slice when
              Math.floor(pos / div) changes).
ctx.playing   transport running (bool). ppq keeps advancing even when not playing.
ctx.time      running sample counter
ctx.key       KeyHelper: root, intervals, snapMidi(m), snapHz(hz), snapSemis(s),
              degreeSemis(d), degreeMidi(d, oct), chordSemis(), chordMidi(oct), snapChordMidi(m)
ctx.sidechain null or [Float32Array L, Float32Array R] external sidechain for this block
```

### Categories (`static cat`)
`DISTORTION`, `DYNAMICS`, `FILTER`, `MODULATION`, `SPECTRAL`, `PITCH`, `RESONATOR`,
`GRANULAR`, `DELAY`, `REVERB`, `GLITCH`

## Quality bar
- **No allocation inside `process`** (no `new`, no array literals, no closures per sample).
  Preallocate in `init`. Max buffer sizes: assume sr up to 96 kHz.
- Output must stay finite and roughly unity-loudness at defaults (peak ≲ 1.5 on a 0 dBFS-ish
  drum loop; the test fails above 16, warns above 4 at defaults). Use `fastTanh` /
  `softClip` on feedback paths. Feedback params must never blow up at max.
- Defaults should sound good and clearly audible immediately when the effect is switched on.
- CPU: test harness budget ≈ 3 % realtime per effect (6 % for FFT effects) in node.
- Anti-click: avoid hard discontinuities when params jump (crossfade grain/slice switches,
  ramp gains, use windows on grains).
- Must work with **both channels** independently (stereo), no mono collapse unless intended.
- Original names from the briefing must **not** be copied verbatim where they are distinctive
  product names — use the labels given in your assignment.

## Deliverable
One file `src/dsp/fx-<bank>.js` registering all assigned effects, passing
`node tools/test-fx.mjs src/dsp/fx-<bank>.js` with 0 FAIL (warnings about tails on
reverbs/drones are fine). Do not edit `lib.js`/`params.js`/other banks — if you need a
helper, put it in your own file (prefixed). Do not commit; the lead integrates.
