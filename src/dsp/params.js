// ============================================================================
// Parameter descriptors: normalized (0..1) <-> real value mapping.
// Shared by the worklet, the UI (main thread) and the test tool.
//
// Descriptor forms:
//   { id, label, min, max, def, unit?, curve?: 'lin'|'exp'|'sq'|'int', bipolar? }
//   { id, label, options: ['A','B',...], def: 0 | 'A' }        -> value = index
//   { id, label, toggle: true, def: 0|1 }                       -> value = 0/1
//   { id, label, div: ['1/1','1/64'], def: '1/8' }              -> value = beats
// ============================================================================

function prepParam(d) {
  if (d._prepped) return d;
  if (d.toggle) { d.kind = 'toggle'; d.options = d.options || ['OFF', 'ON']; }
  else if (d.div) { d.kind = 'div'; d.options = divRange(d.div[0], d.div[1], !!d.straight); }
  else if (d.options) d.kind = 'enum';
  else d.kind = 'num';
  if (d.kind === 'num') {
    if (d.min === undefined) d.min = 0;
    if (d.max === undefined) d.max = 1;
    if (d.def === undefined) d.def = d.min;
    d.curve = d.curve || 'lin';
    if (d.curve === 'exp' && d.min <= 0) d.curve = 'sq';
    d.defN = valueToNorm(d, d.def);
  } else {
    let di = typeof d.def === 'string' ? d.options.indexOf(d.def) : (d.def | 0);
    if (di < 0) di = 0;
    d.defIndex = di;
    d.defN = d.options.length > 1 ? di / (d.options.length - 1) : 0;
  }
  d._prepped = true;
  return d;
}

function normToIndex(d, n) { return Math.round(clamp(n, 0, 1) * (d.options.length - 1)); }

function normToValue(d, n) {
  n = clamp(n, 0, 1);
  switch (d.kind) {
    case 'toggle': return n >= 0.5 ? 1 : 0;
    case 'enum': return normToIndex(d, n);
    case 'div': return DIV_BEATS[d.options[normToIndex(d, n)]];
    default:
      switch (d.curve) {
        case 'exp': return d.min * Math.pow(d.max / d.min, n);
        case 'sq': return d.min + (d.max - d.min) * n * n;
        case 'int': return Math.round(d.min + (d.max - d.min) * n);
        default: return d.min + (d.max - d.min) * n;
      }
  }
}

function valueToNorm(d, v) {
  switch (d.kind) {
    case 'toggle': return v ? 1 : 0;
    case 'enum': case 'div': {
      let i = typeof v === 'string' ? d.options.indexOf(v) : v;
      if (d.kind === 'div' && typeof v === 'number') { i = d.options.findIndex((o) => Math.abs(DIV_BEATS[o] - v) < 1e-9); }
      return d.options.length > 1 ? clamp(i, 0, d.options.length - 1) / (d.options.length - 1) : 0;
    }
    default:
      switch (d.curve) {
        case 'exp': return clamp(Math.log(v / d.min) / Math.log(d.max / d.min), 0, 1);
        case 'sq': return clamp(Math.sqrt(Math.max(0, (v - d.min) / (d.max - d.min))), 0, 1);
        default: return clamp((v - d.min) / (d.max - d.min), 0, 1);
      }
  }
}

function formatValue(d, n) {
  if (d.kind === 'toggle' || d.kind === 'enum' || d.kind === 'div') return d.options[normToIndex(d, n)];
  const v = normToValue(d, n);
  if (d.fmt) return d.fmt(v);
  const u = d.unit || '';
  const a = Math.abs(v);
  let s;
  if (u === 'Hz' && a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 1 : 2) + ' kHz';
  if (u === 'ms' && a >= 1000) return (v / 1000).toFixed(2) + ' s';
  if (d.curve === 'int' || Number.isInteger(d.step)) s = String(Math.round(v));
  else if (a >= 100) s = v.toFixed(0);
  else if (a >= 10) s = v.toFixed(1);
  else s = v.toFixed(2);
  if (d.bipolar && v > 0) s = '+' + s;
  return u ? s + (u === '%' || u === '°' || u === '×' ? '' : ' ') + u : s;
}
