// ============================================================================
// DEBACLE UI — factory presets. Values are given in real units (see P_()).
// Unknown keys or effects are skipped, so presets survive DSP changes.
// ============================================================================

function fxp(id, vals) { const o = {}; for (const [k, v] of Object.entries(vals)) o['fx.' + id + '.' + k] = v; o['fx.' + id + '.on'] = 1; return o; }
function lfo(i, vals) { const o = {}; for (const [k, v] of Object.entries(vals)) o['lfo' + i + '.' + k] = v; return o; }

function definePresets() {
  factory('INIT', 'INIT', P_({}));

  factory('TAPE LULL', 'TAPE', P_({
    'vari.on': 1, 'vari.speed': 64, 'vari.tempo': '1/1', 'vari.wow': 55, 'vari.sat': 35, 'vari.comp': 20, 'vari.mix': 100,
    ...fxp('oxide', { drive: 9, wow: 30, flutter: 25, noise: 20, age: 35, dull: 30 }),
    ...fxp('echotape', { timel: '1/4D', timer: '1/4', fdbk: 45, age: 50, wobble: 35 }), 'fx.echotape.mix': 35,
    ...fxp('plate', { size: 70, decay: 60 }), 'fx.plate.mix': 25,
    ...lfo(1, { shape: 'SINE', rate: '4/1' }),
    'main.low': 2, 'main.high': -3,
  }, {
    chain: ['oxide', 'echotape', 'plate'], loop: 'keys',
    slots: [slot('lfo1', 'vari.speed', 52, 78), slot('m1', 'vari.speed', 100, 30), slot('m1', 'fx.echotape.fdbk', 30, 85)],
  }));

  factory('STUTTER MACHINE', 'RHYTHM', P_({
    'stutter.on': 1, 'stutter.seq': 1, 'stutter.ramp': 3, 'stutter.decay': 25, 'stutter.pan': 60, 'stutter.gate': 25, 'stutter.smooth': 6,
    'sseq.rate': '1/8', 'sseq.chain': 2,
    ...fxp('squeeze', { depth: 45 }),
    ...lfo(2, { mode: 'RANDOM', rate: '1/4', bin: 1 }),
  }, {
    chain: ['squeeze'], loop: 'break',
    slots: [slot('lfo2', 'stutter.ramp', -7, 7), slot('m1', 'stutter.decay', 0, 85), slot('m1', 'stutter.gate', 0, 70), slot('m2', 'stutter.prob', 100, 40)],
  }));

  factory('FREEZE BLOOM', 'AMBIENT', P_({
    'stretch.on': 1, 'stretch.speed': 6, 'stretch.tempo': '1/1', 'stretch.grain': '1/32', 'stretch.spread': 85, 'stretch.scatter': 25, 'stretch.mix': 100,
    ...fxp('halo', { size: 80, decay: 75, shimmer: 45 }), 'fx.halo.mix': 55,
    ...fxp('multifilter', { cutoff: 2400, res: 25 }),
    'graph1.len': '4/1',
  }, {
    chain: ['multifilter', 'halo'], loop: 'choir',
    slots: [slot('graph1', 'stretch.pitch', -5, 7), slot('lfo1', 'fx.multifilter.cutoff', 600, 6000), slot('m1', 'stretch.freeze', 0, 1), slot('m2', 'stretch.speed', 0, 60)],
  }));

  factory('BENT CIRCUIT', 'GLITCH', P_({
    'stutter.on': 1, 'stutter.bend': 1, 'bend.warp': 47, 'bend.brk': 38, 'bend.reps': 8, 'bend.time': '1/1', 'bend.window': 6, 'stutter.capture': '1/1',
    ...fxp('chipglitch', { corrupt: 25, stall: 30 }), 'fx.chipglitch.mix': 70,
    ...fxp('crush', { bits: 10 }), 'fx.crush.mix': 60,
  }, {
    chain: ['chipglitch', 'crush'], loop: 'break',
    slots: [slot('m1', 'bend.warp', 0, 99), slot('m2', 'bend.brk', 0, 99), slot('m3', 'bend.reps', 1, 16), slot('lfo3', 'fx.crush.bits', 4, 14)],
  }));

  factory('SCRATCH TOOL', 'TURNTABLE', P_({
    'stutter.on': 1, 'stutter.bend': 1, 'bend.warp': 78, 'bend.time': '2/1', 'stutter.capture': '1/1', 'bend.window': 0,
    'vari.on': 1, 'vari.speed': 100, 'vari.wow': 10, 'vari.sat': 30, 'time.order': 'STUTTER › STRETCH › VARI',
    ...fxp('sheen', { amount: 40 }),
  }, { chain: ['sheen'], loop: 'break', slots: [slot('m1', 'vari.speed', 100, 0), slot('m2', 'bend.warp', 70, 85)] }));

  factory('HALF-TIME HAZE', 'TAPE', P_({
    'vari.on': 1, 'vari.speed': 50, 'vari.tempo': '1/2', 'vari.mode': 'FORWARD', 'vari.wow': 30, 'vari.sat': 45, 'vari.comp': 40,
    ...fxp('ensemble', { depth: 60 }), 'fx.ensemble.mix': 50,
    ...fxp('spring', { decay: 55 }), 'fx.spring.mix': 30,
  }, { chain: ['ensemble', 'spring'], loop: 'arp', slots: [slot('m1', 'vari.mode', 'FORWARD', 'REVERSE'), slot('lfo1', 'fx.ensemble.depth', 20, 90)] }));

  factory('GRAIN CHOIR', 'AMBIENT', P_({
    'main.gain': 5, 
    'stretch.on': 1, 'stretch.speed': 25, 'stretch.pitch': 7, 'stretch.grain': '1/64', 'stretch.spread': 100, 'stretch.mix': 60,
    ...fxp('harmony', { v1: 2, v2: 4 }), 'fx.harmony.mix': 50,
    ...fxp('plate', { size: 85, decay: 80 }), 'fx.plate.mix': 40,
    'key.root': 'A', 'key.scale': 'MINOR',
  }, { chain: ['harmony', 'plate'], loop: 'keys', slots: [slot('graph2', 'stretch.speed', 5, 60), slot('m1', 'stretch.pitch', 0, 12)] }));

  factory('PUMP & GRIT', 'DYNAMICS', P_({
    'stutter.on': 1, 'stutter.link': 1, 'stutter.lpreset': '1/16 : 1/2', 'stutter.prob': 55, 'stutter.retrig': 20,
    ...fxp('mauler', { brutal: 60, pump: 55 }),
    ...fxp('clip', { drive: 12 }), 'fx.clip.mix': 50,
    ...fxp('multifilter', { cutoff: 900, res: 45, mode: 'LP' }),
    ...lfo(4, { mode: 'ENV', egain: 12, rise: 3, fall: 180 }),
  }, { chain: ['clip', 'mauler', 'multifilter'], loop: 'break', slots: [slot('lfo4', 'fx.multifilter.cutoff', 300, 7000), slot('m1', 'fx.clip.drive', 0, 30)] }));

  factory('SPECTRAL GHOST', 'SPECTRAL', P_({
    'main.gain': 10, 
    'stretch.on': 1, 'stretch.speed': 40, 'stretch.mix': 70,
    ...fxp('smear', { smear: 70 }),
    ...fxp('snapshot', {}), 'fx.snapshot.mix': 55,
    ...fxp('specdelay', { fb: 55 }), 'fx.specdelay.mix': 45,
  }, { chain: ['smear', 'snapshot', 'specdelay'], loop: 'choir', slots: [slot('lfo1', 'fx.smear.smear', 20, 95), slot('m1', 'fx.specdelay.fb', 10, 90)] }));

  factory('BROKEN RADIO', 'GLITCH', P_({
    'vari.on': 1, 'vari.speed': 90, 'vari.wow': 70, 'vari.dist': 'BITCRUSH', 'vari.sat': 30,
    ...fxp('radio', { noise: 30, dropout: 25 }),
    ...fxp('codec', { bitrate: 24 }),
    ...fxp('gate', { mode: 'TRANCE' }), 'fx.gate.mix': 60,
  }, { chain: ['codec', 'radio', 'gate'], loop: 'keys', slots: [slot('lfo2', 'fx.radio.dial', 0, 60), slot('m1', 'fx.codec.packet', 0, 70)] }));

  factory('HARMONIC SHIMMER', 'TONAL', P_({
    'main.gain': 4, 
    'stutter.on': 1, 'stutter.capture': '1/1', 'stutter.rate': '1/8', 'stutter.ramp': 5, 'stutter.decay': 30, 'stutter.mix': 60,
    ...fxp('resonate', { focus: 60 }), 'fx.resonate.mix': 55,
    ...fxp('harp', {}), 'fx.harp.mix': 45,
    ...fxp('halo', { shimmer: 60, decay: 70 }), 'fx.halo.mix': 40,
    'key.root': 'D', 'key.scale': 'DORIAN',
  }, { chain: ['resonate', 'harp', 'halo'], loop: 'arp', slots: [slot('m1', 'key.chord', 'I', 'V'), slot('lfo3', 'fx.resonate.focus', 30, 90)] }));

  factory('MEMORY LEAK', 'GLITCH', P_({
    ...fxp('memory', {}), ...fxp('slicer', {}), 'fx.slicer.mix': 70,
    ...fxp('echotape', { fdbk: 55 }), 'fx.echotape.mix': 30,
  }, { chain: ['slicer', 'memory', 'echotape'], loop: 'break', slots: [slot('m1', 'fx.slicer.shuffle', 0, 100)] }));

  factory('BARBER POLE', 'MOTION', P_({
    'main.gain': 6, 
    'stretch.on': 1, 'stretch.speed': 35, 'stretch.spread': 60, 'stretch.mix': 80,
    ...fxp('phaser', { barber: 'RISE', depth: 70, fdbk: 55, stages: 8 }),
    ...fxp('flanger', { barber: 'FALL', depth: 60, fdbk: 40 }), 'fx.flanger.mix': 45,
    ...fxp('echotape', { timel: '1/8D', timer: '1/4', fdbk: 40 }), 'fx.echotape.mix': 30,
  }, { chain: ['phaser', 'flanger', 'echotape'], loop: 'choir', slots: [slot('m1', 'fx.phaser.fdbk', 20, 85), slot('lfo1', 'stretch.speed', 15, 60)] }));

  factory('FLYBY DUB', 'MOTION', P_({
    'main.gain': 7, 
    'stutter.on': 1, 'stutter.prob': 35, 'stutter.capture': '1/1', 'stutter.rate': '1/8', 'stutter.decay': 40,
    ...fxp('doppler', { path: 'ORBIT', distance: 12, depth: 70 }),
    ...fxp('multihead', { heads: 3, fdbk: 55, halo: 40 }), 'fx.multihead.mix': 40,
    ...fxp('multifilter', { cutoff: 1400, res: 35, mode: 'BP' }), 'fx.multifilter.mix': 70,
    ...fxp('plate', { size: 70, decay: 55 }), 'fx.plate.mix': 25,
  }, { chain: ['multifilter', 'doppler', 'multihead', 'plate'], loop: 'arp', slots: [slot('graph3', 'fx.multifilter.cutoff', 400, 4000), slot('x', 'fx.doppler.depth', 10, 100), slot('y', 'fx.multihead.fdbk', 20, 85)] }));
}
