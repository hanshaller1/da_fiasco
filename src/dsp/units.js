// ============================================================================
// DEBACLE — non-FX units: time engines, main, modulators, perform, key, chain.
// Shared by worklet and UI. Param descriptors follow params.js.
// ============================================================================

const LFO_SHAPES = ['SINE', 'TRIANGLE', 'SAW UP', 'SAW DOWN', 'SQUARE', 'PULSE 25', 'PULSE 10', 'EXP', 'LOG',
  'PEAK', 'VALLEY', 'BUMP', 'DOUBLE', 'SKEW', 'STAIRS 4', 'STAIRS 8', 'HALF SINE', 'BOUNCE', 'TRAPEZOID'];

const LINK_PRESETS = [
  ['1/4', '1/1'], ['1/8', '1/2'], ['1/8', '1/1'], ['1/8T', '1/2'], ['1/16', '1/4'], ['1/16', '1/2'], ['1/16', '1/1'],
  ['1/16T', '1/4'], ['1/16D', '1/2'], ['1/32', '1/8'], ['1/32', '1/4'], ['1/32', '1/2'], ['1/64', '1/8'], ['1/64', '1/4'],
];
const STUTTER_PATTERNS = ['EVEN', 'DOTTED', 'TRIPLET', 'SWING', 'RAMP UP', 'RAMP DOWN'];
const WARP_ZONES = [[0, 0.10, 'OFF'], [0.10, 0.25, 'WOBBLE'], [0.25, 0.40, 'SLIP'], [0.40, 0.55, 'LURCH'], [0.55, 0.70, 'STALL'], [0.70, 0.85, 'SCRATCH'], [0.85, 1.01, 'HAVOC']];
const BREAK_ZONES = [[0, 0.10, 'OFF'], [0.10, 0.25, 'NUDGE'], [0.25, 0.50, 'SKIP'], [0.50, 0.70, 'SCATTR'], [0.70, 1.01, 'DRPOUT']];
const zoneOf = (zones, v) => { for (let i = 0; i < zones.length; i++) if (v < zones[i][1]) return i; return zones.length - 1; };

const MOD_SOURCES = [
  ['lfo1', 'MOD 1', 'LFO'], ['lfo2', 'MOD 2', 'LFO'], ['lfo3', 'MOD 3', 'LFO'], ['lfo4', 'MOD 4', 'LFO'],
  ['graph1', 'GRAPH 1', 'GRA'], ['graph2', 'GRAPH 2', 'GRA'], ['graph3', 'GRAPH 3', 'GRA'],
  ['m1', 'MACRO 1', 'M1'], ['m2', 'MACRO 2', 'M2'], ['m3', 'MACRO 3', 'M3'], ['m4', 'MACRO 4', 'M4'],
  ['x', 'PAD X', 'X'], ['y', 'PAD Y', 'Y'],
];
const MOD_SOURCE_IDS = MOD_SOURCES.map((s) => s[0]);
const SLOT_SHAPES = ['RAMP', 'TRI', 'S-CURVE'];

const pct = (id, label, def = 50, extra = {}) => Object.assign({ id, label, min: 0, max: 100, def, unit: '%' }, extra);
const tog = (id, label, def = 0, extra = {}) => Object.assign({ id, label, toggle: true, def }, extra);

function lfoUnit(i) {
  return {
    label: 'MOD ' + i, group: 'ANIMATE', params: [
      { id: 'mode', label: 'MODE', options: ['LFO', 'RANDOM', 'ENV'], def: 0 },
      { id: 'shape', label: 'SHAPE', options: LFO_SHAPES, def: i === 1 ? 0 : i === 2 ? 1 : i === 3 ? 2 : 4 },
      { id: 'rate', label: 'RATE', div: ['16/1', '1/64'], straight: true, def: ['1/1', '2/1', '1/2', '4/1'][i - 1] },
      tog('free', 'FREE', 0),
      { id: 'hz', label: 'HZ', min: 0.02, max: 30, def: 0.5, curve: 'exp', unit: 'Hz' },
      { id: 'phase', label: 'PHASE', min: 0, max: 360, def: 0, unit: '°' },
      pct('jitter', 'JITTER', 0),
      pct('smooth', 'SMOOTH', 0),
      tog('bin', 'BIN', 1),
      { id: 'egain', label: 'GAIN', min: -12, max: 24, def: 6, unit: 'dB' },
      { id: 'rise', label: 'RISE', min: 1, max: 500, def: 10, curve: 'exp', unit: 'ms' },
      { id: 'fall', label: 'FALL', min: 10, max: 3000, def: 250, curve: 'exp', unit: 'ms' },
      { id: 'tone', label: 'TONE', min: -100, max: 100, def: 0, bipolar: true },
      { id: 'esrc', label: 'SOURCE', options: ['INTERNAL', 'DRY IN'], def: 0 },
    ],
  };
}
function graphUnit(i) {
  return {
    label: 'GRAPH ' + i, group: 'ANIMATE', params: [
      { id: 'len', label: 'LENGTH', div: ['16/1', '1/4'], straight: true, def: ['1/1', '2/1', '4/1'][i - 1] },
      { id: 'dir', label: 'DIRECTION', options: ['FORWARD', 'REVERSE', 'PINGPONG'], def: 0 },
      { id: 'speed', label: 'SPEED', options: ['×1/4', '×1/2', '×1', '×2', '×4'], def: 2 },
    ],
  };
}

const UNITS = {
  time: {
    label: 'TIME', group: 'TIME', params: [
      { id: 'order', label: 'ORDER', options: ['STRETCH › VARI › STUTTER', 'VARI › STRETCH › STUTTER', 'STUTTER › STRETCH › VARI', 'PARALLEL'], def: 0 },
    ],
  },
  stretch: {
    label: 'STRETCH', group: 'TIME', params: [
      tog('on', 'ON', 0),
      pct('speed', 'SPEED', 50),
      { id: 'tempo', label: 'TEMPO', div: ['1/1', '1/8'], straight: true, def: '1/2' },
      { id: 'grain', label: 'GRAIN', div: ['1/16', '1/512'], straight: true, def: '1/64' },
      { id: 'grain_hz', label: 'GRAIN HZ', min: 5, max: 100, def: 24, curve: 'exp', unit: 'Hz' },
      { id: 'pitch', label: 'PITCH', min: -12, max: 12, def: 0, unit: 'st', bipolar: true },
      pct('spread', 'SPREAD', 30),
      pct('scatter', 'SCATTER', 0),
      pct('mix', 'MIX', 100),
      tog('rev', 'REVERSE', 0),
      tog('sync', 'SYNC', 1),
      tog('freeze', 'FREEZE', 0),
      tog('link', 'LINKED', 0),
      tog('seq', 'SEQ', 0),
    ],
  },
  vari: {
    label: 'VARISPEED', group: 'TIME', params: [
      tog('on', 'ON', 0),
      pct('speed', 'SPEED', 72),
      { id: 'tempo', label: 'TEMPO', div: ['1/1', '1/64'], straight: true, def: '1/2' },
      { id: 'mode', label: 'MODE', options: ['FORWARD', 'FWD-REV', 'REVERSE'], def: 0 },
      pct('wow', 'WOW/FLUT', 20),
      tog('stop', 'STOP', 0),
      { id: 'scratch', label: 'SCRATCH', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
      pct('sat', 'SATURATION', 25),
      { id: 'dist', label: 'DISTORT', options: ['HEAT', 'BITCRUSH'], def: 0 },
      pct('comp', 'COMPRESS', 0),
      pct('mix', 'MIX', 100),
    ],
  },
  stutter: {
    label: 'STUTTER', group: 'TIME', params: [
      tog('on', 'ON', 0),
      { id: 'rate', label: 'RATE', div: ['1/4', '1/256'], def: '1/16' },
      { id: 'rate_ms', label: 'RATE MS', min: 10, max: 500, def: 90, curve: 'exp', unit: 'ms' },
      { id: 'capture', label: 'CAPTURE', div: ['1/1', '1/64'], straight: true, def: '1/2' },
      { id: 'pitch', label: 'PITCH', min: -12, max: 12, def: 0, unit: 'st', bipolar: true },
      { id: 'ramp', label: 'PITCH RAMP', min: -12, max: 12, def: 0, unit: 'st', bipolar: true },
      pct('gate', 'GATE', 0),
      { id: 'gcurve', label: 'GATE CURVE', options: ['LINEAR', 'LOG', 'EXP'], def: 0 },
      pct('decay', 'DECAY', 0),
      pct('pan', 'PAN', 0),
      pct('prob', 'PROBABILITY', 100),
      pct('retrig', 'RETRIGGER', 0),
      { id: 'smooth', label: 'SMOOTH', min: 5, max: 50, def: 8, unit: 'ms' },
      pct('mix', 'MIX', 100),
      tog('rev', 'REVERSE', 0),
      tog('sync', 'SYNC', 1),
      tog('link', 'LINK', 0),
      { id: 'lpreset', label: 'LINK RATE', options: LINK_PRESETS.map((p) => p[0] + ' : ' + p[1]), def: 4 },
      { id: 'pattern', label: 'PATTERN', options: STUTTER_PATTERNS, def: 0 },
      tog('bend', 'BEND', 0),
      tog('seq', 'SEQ', 0),
    ],
  },
  bend: {
    label: 'BENDIT', group: 'TIME', params: [
      pct('warp', 'WARP', 0),
      pct('brk', 'BREAK', 0),
      { id: 'reps', label: 'REPS', min: 1, max: 32, def: 4, curve: 'int' },
      { id: 'time', label: 'TIME', div: ['4/1', '1/32'], straight: true, def: '1/1' },
      { id: 'time_ms', label: 'TIME MS', min: 10, max: 18000, def: 1000, curve: 'exp', unit: 'ms' },
      { id: 'width', label: 'WIDTH', min: 1, max: 4, def: 1, unit: '×' },
      pct('window', 'WINDOW', 10),
      { id: 'duck', label: 'DUCK', min: -100, max: 100, def: 0, unit: '%', bipolar: true },
      tog('tsync', 'SYNC', 1),
      tog('freeze', 'FREEZE', 0),
    ],
  },
  sseq: {
    label: 'STUTTER SEQ', group: 'ANIMATE', params: [
      { id: 'rate', label: 'STEP', div: ['1/1', '1/16'], straight: true, def: '1/16' },
      { id: 'chain', label: 'PATTERNS', min: 1, max: 4, def: 1, curve: 'int' },
    ],
  },
  tseq: {
    label: 'STRETCH SEQ', group: 'ANIMATE', params: [
      { id: 'rate', label: 'STEP', div: ['1/1', '1/16'], straight: true, def: '1/8' },
      { id: 'chain', label: 'PATTERNS', min: 1, max: 4, def: 1, curve: 'int' },
    ],
  },
  chain: {
    label: 'FX CHAIN', group: 'FX', params: [
      { id: 'mode', label: 'ROUTING', options: ['SERIAL', 'PARALLEL'], def: 0 },
    ],
  },
  main: {
    label: 'MAIN', group: 'MAIN', params: [
      { id: 'gain', label: 'GAIN', min: -36, max: 12, def: 0, unit: 'dB', bipolar: true },
      { id: 'low', label: 'LOW', min: -15, max: 15, def: 0, unit: 'dB', bipolar: true },
      { id: 'mid', label: 'MID', min: -15, max: 15, def: 0, unit: 'dB', bipolar: true },
      { id: 'high', label: 'HIGH', min: -15, max: 15, def: 0, unit: 'dB', bipolar: true },
      { id: 'pan', label: 'PAN', min: -100, max: 100, def: 0, bipolar: true },
      pct('comp', 'COMP', 0),
      pct('auto', 'AUTO-GAIN', 0),
      pct('mix', 'MIX', 100),
      tog('bypass', 'BYPASS ALL', 0),
    ],
  },
  key: {
    label: 'KEY', group: 'MAIN', params: [
      { id: 'root', label: 'ROOT', options: NOTE_NAMES, def: 9 },
      { id: 'scale', label: 'SCALE', options: SCALE_NAMES, def: 1 },
      { id: 'chord', label: 'CHORD', options: CHORD_NAMES, def: 0 },
      { id: 'csize', label: 'VOICING', options: CHORD_SIZES, def: 0 },
    ],
  },
  perform: {
    label: 'PERFORM', group: 'PERFORM', params: [
      pct('m1', 'MACRO 1', 0), pct('m2', 'MACRO 2', 0), pct('m3', 'MACRO 3', 0), pct('m4', 'MACRO 4', 0),
      pct('x', 'PAD X', 50), pct('y', 'PAD Y', 50),
    ],
  },
  lfo1: lfoUnit(1), lfo2: lfoUnit(2), lfo3: lfoUnit(3), lfo4: lfoUnit(4),
  graph1: graphUnit(1), graph2: graphUnit(2), graph3: graphUnit(3),
};
for (const u of Object.values(UNITS)) for (const d of u.params) prepParam(d);

// Default graph curves (points: x 0..1, y 0..1, c = curvature of the segment to the next point, -1..1)
const DEFAULT_GRAPHS = [
  [{ x: 0, y: 0, c: 0.5 }, { x: 0.5, y: 1, c: -0.5 }],
  [{ x: 0, y: 1, c: 0.7 }, { x: 0.25, y: 0, c: 0 }, { x: 0.5, y: 0.7, c: 0.7 }, { x: 0.75, y: 0.1, c: 0 }],
  [{ x: 0, y: 0, c: 0 }, { x: 0.125, y: 0.85, c: 0.6 }, { x: 0.375, y: 0.3, c: -0.3 }, { x: 0.5, y: 1, c: 0.6 }, { x: 0.8, y: 0.15, c: 0 }],
];
function evalGraph(points, x) {
  // closed curve over [0,1)
  const n = points.length;
  if (!n) return 0;
  x = x - Math.floor(x);
  let i = n - 1;
  for (let k = 0; k < n; k++) { if (points[k].x <= x) i = k; else break; }
  if (x < points[0].x) i = n - 1;
  const a = points[i], b = points[(i + 1) % n];
  let x0 = a.x, x1 = b.x; let xx = x;
  if (i === n - 1) { x1 = b.x + 1; if (xx < x0) xx += 1; }
  const span = x1 - x0;
  let t = span > 1e-9 ? (xx - x0) / span : 0;
  t = clamp(t, 0, 1);
  const c = a.c || 0;
  // curvature via power curve: c>0 bows toward start value ("fast"), c<0 slow
  const e = Math.pow(2, -c * 3);
  t = Math.pow(t, e);
  return a.y + (b.y - a.y) * t;
}

// Default 16-step sequencer patterns (4 patterns each); step = {on, v (0..1)}
function defaultSeq(kind) {
  const pats = [];
  for (let p = 0; p < 4; p++) {
    const steps = [];
    for (let s = 0; s < 16; s++) {
      if (kind === 'stutter') steps.push({ on: [0, 3, 6, 8, 10, 12, 14].includes(s) ? 1 : 0, v: [0.55, 0.7, 0.4, 0.85][(s + p) % 4] });
      else steps.push({ on: 1, v: [0.5, 0.25, 1, 0.0, 0.5, 0.75, 0.1, 1][s % 8] });
    }
    pats.push(steps);
  }
  return pats;
}
