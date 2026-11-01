# DEBACLE

A browser instrument that turns one audio loop into a performance. Built from the
functional research briefing in [`docs/briefing.md`](docs/briefing.md) as an
independent Web Audio implementation with its own name, DSP, UI and presets.

**Open `dist/index.html`** in a current Chromium, Firefox or Safari and press PLAY.
Over `http(s)://` the DSP runs in an AudioWorklet; from `file://` it falls back to a
ScriptProcessor running the same engine on the main thread.

## What it does

| Area | Contents |
|---|---|
| **Source** | Four synthesized demo loops (BREAK, KEYS, ARP, CHOIR), any audio file (button or drag & drop, tempo guessed from length), LIVE IN (microphone, where the browser allows it), PRINT (resample one loop of the output as the new source) |
| **TIME** | **STRETCH** dual-grain stretcher/freezer (speed, tempo-synced capture, sync/free grains, pitch, spread, scatter, reverse, freeze, linked speed+pitch, step sequencer) · **VARISPEED** tape machine (coupled speed/pitch, rebasing capture window, FWD / FWD-REV / REV, wow & flutter oscillators at 0.5 Hz and 6 Hz, momentary tape STOP, spring-loaded SCRATCH, HEAT/BITCRUSH saturation, wet compressor) · **STUTTER** beat-grid capture & repeat (rate/capture, pitch + pitch ramp, gate with curves, decay, ping-pong pan, probability, retrigger, linear crossfades, 14 LINK presets, 6 patterns, beat-aligned switch-on, sequencer) · **BENDIT** circuit-bent buffer mode (7-zone WARP incl. four scratch patterns, 5-zone BREAK, REPS, TIME, WIDTH, Tukey WINDOW, FREEZE, DUCK) · four engine routings including PARALLEL |
| **FX** | 58 effects in 11 categories (distortion, dynamics, filter, modulation, spectral/FFT, pitch, resonator, granular, delay, reverb, glitch). Drag to reorder, serial or parallel chain, per-effect MIX and GAIN (±12 dB), 10 ms on/off fades, state reset on enable, NaN guard, dry-path latency compensation for FFT effects |
| **ANIMATE** | 4 modulators (LFO with 19 shapes, RANDOM stepped/smooth, ENV follower with internal or dry source and tone filter), sync or free rates, jitter, smoothing · 3 drawable curve graphs (¼–16 bars, forward/reverse/ping-pong) · 2 sequencers (16 steps × up to 4 chained patterns) · every source drives up to 6 targets with MIN/MAX (graphs also START/END/SKEW/shape), modulators can modulate modulators |
| **PERFORM** | 4 macros and an X/Y pad, each with up to 5 targets and curve shaping (ramp, triangle three-point crossfade, S-curve, skew) |
| **Global** | Key (root, 17 scales, chord degree, voicing) for every SNAP parameter, dice per unit / TIME / FX with per-parameter dice strength (0 = locked), factory and user presets (browser storage, copy/paste JSON), MAIN row (gain, 3-band EQ, pan, compressor, auto-gain, master dry/wet, bypass all) and soft limiter |

Controls: drag knobs vertically (Shift = fine), double-click resets, right-click
(long-press on touch) opens modulation and dice options, the badge on a modulated knob
jumps to its source. Dragging a modulated knob shifts its modulation window. Space plays
and stops, keys 1–4 switch pages.

## Layout

```
src/dsp/lib.js           DSP helpers: filters, delay lines, FFT/STFT, scales, FX base class
src/dsp/params.js        parameter descriptors (normalized ↔ real values)
src/dsp/units.js         time engines, MAIN, modulators, perform: parameter definitions
src/dsp/fx-*.js          effect banks (drive, motion, space, spectral)
src/dsp/time-engines.js  VARISPEED, STUTTER/BENDIT, STRETCH
src/dsp/core.js          engine host: transport, source, modulation, routing, MAIN, limiter, worklet glue
src/ui/*.js              UI (widgets, pages, audio bootstrap, presets)
src/index.html, style.css
tools/build.mjs          inlines everything into dist/index.html (+ dist/artifact.html fragment)
tools/test-fx.mjs        effect test harness (metadata, NaN/Inf, level, CPU, tails)
tools/test-core.mjs      engine smoke test (time engines, routing, modulation, print)
tools/test-clicks.mjs    click detector for the time engines
docs/FX_API.md           effect authoring contract
```

## Build and test

```bash
node tools/build.mjs
```

```bash
node tools/test-fx.mjs src/dsp/fx-drive.js src/dsp/fx-motion.js src/dsp/fx-space.js src/dsp/fx-spectral.js
```

```bash
node tools/test-core.mjs src/dsp/fx-drive.js src/dsp/fx-motion.js src/dsp/fx-space.js src/dsp/fx-spectral.js
```

No dependencies beyond Node 18+ for the tools. The page itself loads only Google Fonts.

## Notes on the briefing

- Product name, effect names where the original's were distinctive, DSP, artwork and
  presets are original to this project, as the briefing's hygiene section asks.
- Host integration (PPQ, transport restart, automation) maps to an internal transport:
  all musical times lock to its beat clock, and pressing PLAY re-arms engines and
  sequencers. Modulators keep running from a sample counter while stopped.
- Plugin-only details (latency reporting to a host, VST/AU formats, UI themes) do not
  apply in a browser; FFT latency is compensated on the dry paths instead.
