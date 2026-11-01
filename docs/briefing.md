# Tape Fiasco 2 (Phase Fiasco) – Recherche-Briefing für den Programmier-Agenten

Stand der Recherche: 2026-10-31. Dokumentierte Produktversion: **2.0.4.974** (Release 23. Okt 2026).
Sprache: Beschreibungen deutsch, UI-Bezeichnungen und Parameternamen wie im Original (englisch, GROSSBUCHSTABEN).

> **Wie du dieses Dokument benutzt:** Es beschreibt Funktionsumfang, Signalfluss, Parameter und Modulationssystem des Plugins *Tape Fiasco 2*. Der DSP-Quellcode ist nicht öffentlich – alles unten ist aus Hersteller-Texten, Handbuch-Auszügen, Release-Notes, Reviews und Forendiskussionen rekonstruiert. Die konkreten Algorithmen musst du selbst entwerfen. Abschnitt 9 listet Widersprüche und Lücken der Quellen, Abschnitt 11 ist für die zusätzlichen Wünsche des Nutzers reserviert.

---

## 1. Überblick

- **Hersteller/Autor:** Phase Fiasco (Jonas Eriksson). iPad-Version veröffentlicht unter Creative Parade AB.
- **Idee:** „Most audio plugins process your sound. Tape Fiasco performs it." – ein einzelner Audio-Loop wird zum Performance-Instrument. Gedacht für Loop-/Sample-Produzenten, Sounddesigner, Live-Performer, Ambient/Experimental.
- **Aufbau:** Eine Kette aus **Time-Engines** (Stretch, Varispeed, Stutter, BendIt) → **FX-Kette** (62 Effekte, frei umsortierbar) → **MAIN**-Zeile → Soft-Limiter. Darüber ein **Modulationssystem** (ANIMATE) und eine **Performance-Ebene** (PERFORM: 4 Macros + X/Y-Pad).
- **Formate/Preis:** Windows VST3; macOS (Apple Silicon + Intel) VST3 + AU; Linux VST3 laut Herstellerseite; iPadOS Standalone + AUv3 ($19.99). Desktop $29, kostenlose Updates für Käufer. Vorgänger *Tape Fiasco 1* ist kostenlos und deutlich kleiner.
- **Versionshistorie (Kurzform):** Launch Juni 2026 (21 Effekte) → Juni-Update (+CLANG, AETHER, ORBIT, TREMOR, L/R-Lock, free/clocked FX-Rate, unbegrenzte Modulation) → 2.0.0.814 Juli (+PITCH SHIFT, SCATTER, GATE, MANGLE, EQ; Mod-moduliert-Mod; externer Sidechain) → 2.0.1.894 Sep (+FORMANT SHIFT, MANGLE-MELT) → 2.0.2.937 Okt (SERIAL/PARALLEL, Gain-Comp, PITCH-SHIFT-Modi) → **2.0.4.974** Okt (+31 Effekte = 62, FFT-Latenzkompensation).
- **Allgemeiner Charakter laut Rezensionen:** „Utterly insane sound mangler"; rewards careful listening; kann in Default-Einstellungen „überkomprimiert" klingen (Hersteller setzte Master-Compressor/Auto-Gain daraufhin auf Default 0). Stärken: Tape-Effekte ohne Latenz, riesige Modulationsvielfalt, hohe Update-Frequenz. Schwächen laut Reviews: UI gewöhnungsbedürftig, Sequencer-Step-Editing umständlich, anfangs LFO nur tempo-synchron.

---

## 2. Architektur und Signalfluss

```
Input (Stereo)
  → TIME-ENGINES  (Reihenfolge wählbar, s. EFFECT ORDER)
  → FX-KETTE      (bis zu 62 Effekte, jeder nur 1× vorhanden, Drag-Reorder, SERIAL oder PARALLEL)
  → MAIN          (Gain / 3-Band-EQ / Pan / Master-Mix, + Compressor / Auto-Gain laut Hersteller)
  → Soft-Limiter
  → Output
```

- **EFFECT ORDER (TIME-Seite)**, vier Routings der Time-Engines:
  1. Stretch › Vari › Stutter (Default)
  2. Vari › Stretch › Stutter
  3. Stutter › Stretch › Vari
  4. **Parallel** – alle drei Zweige verarbeiten das Dry-Signal unabhängig, Summe am Ende.
- Seit 2.0.2.937: FX-Kette **SERIAL/PARALLEL** umschaltbar; **Gain-Kompensation pro Effekt** −12…+12 dB.
- `MAIN_MIX` = globaler Dry/Wet. Er blendet das Originaleingangssignal zurück.
- Effekte, die **OFF** sind, kosten null CPU (komplett umgangen). Schwerste Effekte: CRYSTAL, SQUASH, MODAL, DRIP, SIEVE.
- **Specs:** Stereo; 44.1–192 kHz; Puffer pro Time-Engine bis 2 s, **Stutter bis 10 s**; Latenz 0 Samples, außer FFT-Effekte (s. 5.4).
- **Host-Integration:** Alle musikalischen Zeiten (Capture-Fenster, Stutter-Divisionen, Delay-Raten, LFO-Raten, Graph-Perioden, Sequencer-Steps) rasten auf Host-Transport/PPQ ein, wenn vorhanden. Ohne Transport laufen Modulatoren und synchronisierte Raten über einen Sample-Zähler weiter. Transport-Restart „re-armt" Sequencer und Dry-Passthrough-Fenster, damit der Ausgang nicht in Stille öffnet. Jeder Parameter ist eine normale Automationsspur.
- **Anti-Click-Design (vom Hersteller genannt, gutes Vorbild):**
  - Jeder Effekt: State wird beim Einschalten gelöscht, weicher Wet/Dry-Blend, Transport-Restart-Hooks, NaN/Inf-Guards, **10 ms Wet/Dry-Bypass-Fade**.
  - Stretch: *per-grain latching* – Reverse kann mitten im Grain umgeschaltet werden.
  - Stutter: *lineare* Capture-Crossfades statt Equal-Power (korrelierte, taktgenaue Slices trieben sonst den Limiter am Mittelpunkt).
  - BendIt: **Tukey-Loop-Fenster**, damit Pitch-/Richtungssprünge in der Stille landen.
  - Stutter-Sequencer-Schritte landen sample-genau (nicht auf Blockgrenzen).

---

## 3. Time-Engines (TIME-Seite)

Gemeinsame Controls je Engine: ON/OFF (ein Klick auf irgendeinen Regler einer ausgeschalteten Engine schaltet sie ein), MIX, Mode/Reverse, Würfel (Randomize) + Zahnrad „Random Setup" (Wahrscheinlichkeit/Stärke pro Parameter). Info-Fenster zeigt Name+Wert des Parameters unter dem Cursor. Drag nach oben/unten ändert Werte; Shift-Drag = Feinjustage; Rechtsklick auf Parameter = Modulator zuweisen.

### 3.1 STRETCH – Dual-Grain-Stretcher / Freezer
Nimmt Audio in einen Puffer und spielt überlappende Grains. **Kein Pitch-Shifter, keine Formanterhaltung** (laut Hersteller). Kann verlangsamen, einfrieren, scrubben.

| Parameter | Bereich / Verhalten |
|---|---|
| ON/OFF | |
| SPEED | 0–100 %; 0 = Freeze an aktueller Position, 50 = halbe Geschwindigkeit, 100 = Echtzeit |
| TEMPO | 4/4 … 1/8: wie oft neue Input-Chunks in den Puffer kommen (host-synced) |
| GRAIN | SYNC: 1/16…1/512; FREE: 5–100 Hz → Grain-Start-Rate und Scatter-Sprünge |
| PITCH | ±12 st (pro Grain) |
| SPREAD | 0–100 %, abwechselnd L/R gepannte Grains |
| SCATTER | 0–100 %, randomisiert die Leseposition (sehr quellenabhängig; Hersteller riet Default 0) |
| MIX | 0–100 % |
| REVERSE | Toggle |
| SYNC/FREE | SYNC = Grid-Timing + Split-Size-Offsets (Default; fällt ohne Host-Clock auf FREE zurück), FREE = ursprünglicher kontinuierlicher Grain-Scheduler |
| FREEZE | stoppt Capture, Puffer loopt endlos, Modulation läuft weiter |
| LINKED/INDEPENDENT | koppelt/entkoppelt SPEED und PITCH (seit 2.0.2.937) |
| SEQ | schaltet den Stretch-Sequencer (steuert SPEED pro Step) |

Geplant laut Hersteller: längere Grains, granulare Engine.

### 3.2 VARISPEED – Tape-Maschinen-Emulation
Kontinuierliche Aufnahme in **2-s-Ringpuffer**, **ein Lesekopf** mit variabler Rate. **Pitch und Speed sind gekoppelt** wie auf Band. Charakter: „rebased-read crossfade per tempo window" + Sättigung/Kompressor-Paar.

| Parameter | Bereich / Verhalten |
|---|---|
| SPEED | 0–100 %; 100 = normal, kleiner = langsamer + tiefer, 0 = Stop |
| TEMPO | 4/4 … 1/64: Capture-Fenster |
| MODE | FORWARD / FWD-REV (wechselt jeden Capture-Zyklus; in einer Quelle auch als bipolarer Speed-Knob beschrieben: Mitte = Stop, links = rückwärts, rechts = vorwärts) / REVERSE |
| WOW/FLUTTER | 0–100 %; **zwei rekursive Sinus-Oszillatoren, 0.5 Hz (Wow) und 6 Hz (Flutter)** |
| STOP | momentan: halten = gradueller Tape-Stop, loslassen = Hochlaufen |
| SCRATCH | ±100 %, DJ-artiger Pitch-Bend-Rad-Effekt, federt auf Mitte zurück; **Richtungswechsel an Nulldurchgängen** |
| SATURATION | 0–100 %; DISTORT TYPE: **HEAT** (`tanh`-Tape-Sättigung) oder **BITCRUSH** |
| COMPRESS | 0–100 %, Wet-Path-Kompression (Peak-Envelope) mit Make-up-Gain |
| MIX | 0–100 % |

### 3.3 STUTTER – rhythmischer Capture-and-Repeat-Slicer
Fängt Audio auf dem Host-Beat-Grid ein und loopt es. Einschalten ist beat-aligned (springt zum Anfang des aktuellen Capture-Zyklus). Puffer bis 10 s.

| Parameter | Bereich / Verhalten |
|---|---|
| SYNC | an: RATE rastet auf Notenwerte; aus: RATE in ms |
| RATE | 1/256…1/4 (sync) oder 10–500 ms (free): Slice-Länge |
| CAPTURE | 4/4…1/64: wie oft ein neuer Slice aufgenommen wird (Default seit 2.0.0.825: 2/4) |
| PITCH | ±12 st |
| PITCH RAMP | ±12 st kumulativ **pro Wiederholung** (auf-/absteigende Kaskade) |
| GATE | 0–100 % Lautstärkehüllkurve pro Wiederholung; GATE CURVE: LINEAR / LOG / EXP |
| DECAY | 0–100 %, Lautstärkeabfall über die Wiederholungen |
| PAN | 0–100 %, Stereo-Ping-Pong pro Wiederholung |
| PROBABILITY | 0–100 %, Chance dass ein Zyklus triggert; < 100 → zufällige Dry-Lücken |
| RETRIGGER | 0–100 %, Chance auf Neu-Capture mitten im Zyklus |
| SMOOTH | 5–50 ms Crossfade an Loop-Punkten |
| MIX, REVERSE | |
| LINK | RATE-Knob wählt aus **14 Presets** gekoppelter RATE:CAPTURE-Paare |
| PATTERN | EVEN / DOTTED / TRIPLET / SWING / RAMP UP / RAMP DOWN |
| BEND | schaltet die Sektion auf BendIt um |
| SEQ | 16-Step-Sequencer gated Stutter (s. 6.3) |

### 3.4 BENDIT – „circuit-bent" Buffer-Mangler (Stutter-Sektion im BEND-Modus)
Inspiriert von Qu-Bit *Data Bender*. Viele Stutter-Regler behalten ihre Namen, ändern aber die Funktion.

**WARP** (ersetzt PITCH) – 7-Zonen-Makro, beeinflusst Pitch/Richtung pro Stutter-Loop:

| Zone | Bereich | Name | Verhalten |
|---|---|---|---|
| 0 | 0–10 % | OFF | keine Pitch-Änderung |
| 1 | 10–25 % | WOBBLE | leichte Zufalls-Pitchschwankung (±50 %) |
| 2 | 25–40 % | SLIP | zufällige Sprünge zwischen 2×, 0.5×, 1× |
| 3 | 40–55 % | LURCH | größere Sprünge 4×, 2×, 0.5×, 0.25×, 1× |
| 4 | 55–70 % | STALL | extreme Sprünge (0.1×, 4×, 2×, 1×); Slew wird nahe Scratch-Zone langsamer |
| 5 | 70–85 % | SCRATCH | DJ-Scratch-Patterns *Baby, Transformer, Tear, Scribble* als eingebaute **4-Takt-Patterns, gelockt auf Host-PPQ** |
| 6 | 85–100 % | HAVOC | Pitch beliebig innerhalb ±3 Oktaven |

Scratch-Engine wird laut Hersteller auf dem 8tel-Raster **host-quantisiert ein-/ausgeblendet** und würfelt Rate, Shape und Depth pro Beat neu. Pitch-Makro ist auf das Host-Grid quantisiert.

**BREAK** (in Marketing-Texten **FRACTURE**) – 5-Zonen-Makro (ersetzt DECAY), Sub-Section-Sprünge und Stille-Drops:

| Zone | Bereich | Name | Verhalten |
|---|---|---|---|
| 0 | 0–10 % | OFF | durchgehende Wiedergabe |
| 1 | 10–25 % | NUDGE | spielt aufeinanderfolgende Sub-Abschnitte |
| 2 | 25–50 % | SKIP | je Loop 15–50 % Chance auf Sprung zu zufälligem Sub-Abschnitt |
| 3 | 50–70 % | SCATTR | zufällige Sprünge mit 50–80 % Wahrscheinlichkeit |
| 4 | 70–100 % | DRPOUT | zufällige Stille + zufällige Sub-Abschnitt-Sprünge |

Weitere BendIt-Controls: **REPS** 1–32 (Anzahl Sub-Abschnitte; bei aktivem SCRATCH auf 1 gesperrt), **TIME** (Capture-Länge: 1/32…4 Takte synced; 10 ms…18 s free), **WIDTH** 1×–4× (Mid/Side), WINDOW, MIX, FREEZE, **DUCK** (Mitte = aus; links = Dry ducked Wet; rechts = Wet ducked Dry).

---

## 4. Skalen-/Tonart-System („SNAP")

Viele Effekte haben einen kleinen **SNAP-Punkt**: Klick rastet den jeweiligen Parameter (Frequenz/Pitch/Intervall) auf die globale **SCALE/ROOT** (bei einigen auch **CHORD**) ein – z. B. CRYSTAL, MODAL, STRINGS, TOOTH, MAGNET, WARP, CHROMA, SEPARATE, PITCH SHIFT, MIRROR, UNDERTOW, FREQ SHIFT, SCANNER, STRUM, WENDY, GRANUVERB, CHOPPER, SPECTRAL DELAY, FISSION, HOWL. Wo genau die globale Tonart eingestellt wird, ließ sich in den verfügbaren Quellen **nicht** verifizieren (Abschnitt 9).

---

## 5. FX-Kette (62 Effekte)

Bedienung: linke Spalte listet die Effekte (zehn einklappbare Kategorien); per Klick/Drag in die Kette einfügen, per Drag umsortieren, per **X** entfernen. Jeder Effekt hat eigenes ON/OFF, meist 5–7 Regler, kleinen Visualizer, Würfel + Random-Setup, Mute/Delete/Reorder-Pfeile. Jeder Effekt nur einmal. Seit Juni: **L/R-Lock** und **free vs. clocked FX-Rate** (Details nicht dokumentiert).

Hinweis: „(D)" = nur Desktop (nicht iPad). Wo nur eine Kurzbeschreibung verfügbar war, steht „Details unbekannt".

### 5.1 Distortion
- **BITROT** – Bitcrusher. BITS, RATE (Sample-Rate-Reduktion, auch Tempo-Divisionen 1/1–1/512), DRIVE, DITHER, JITTER, MODEL (Classic, Tread, Mu-law, Float, Delta, Glide, Error feedback, Codec, Stochastic), ROT (Capture-Drop), SMOOTH (DAC-Rekonstruktion), WIDTH (Detune rechter Takt), RANGE (zufällige Bittiefe pro Capture), TRACK (Hold-Rate folgt Input-Pitch, überschreibt RATE).
- **CIRCUIT BEND** – Speicherchip-Glitches. CORRUPT (harte Glitch-Artefakte), SHIFT (bitcrusher-artig), STALL (zufällige Stotterer wie springende CD), RATE (1–1/64 Beat, free 2 s–10 ms), HQ (2× Oversampling), BUS (16/8/4-Bit Datenbus), CLOCK (DAC-Clock-Starvation: Pitch-Drop + Sag).
- **DISTORT** – harter Clipper, 12 Wellenform-Modelle (MODEL), DRIVE, BIAS, LOW CUT, HIGH CUT (begrenzen die nichtlineare Bearbeitung auf ein Band).
- **PLASMA** – Chaos-Folder, hysteretische Lichtbogen-Distortion. DRIVE, ARC, FREQ, HOLD (Bogen bleibt bis 2 s „an"), CHAOS.
- **WAVEFOLDER** – West-Coast. DRIVE, FOLDS, SHAPE, BIAS, MODEL (FOLD, 259, SERGE, LOCK, WRAP; außer FOLD/SHAPE morphen sie weich→hart).
- **EXCITE** – Aphex-artiger Aural Exciter (Parallel-Topologie). DRIVE, TONE, ATTACK, RELEASE, SUB.
- **HOWL** – abgestimmtes Feedback. Input regt einen auf NOTE (A1–A6) gestimmten Loop an. REGEN (>70 % selbstoszillierend), COLOR, BITE, DRIFT, DAMP (Howl verschwindet beim Spielen), COUPLE (rechter Loop eine Quinte höher, kreuzgekoppelt), MIX, SNAP.
- **LOSSY** – Codec-Degradierung, echtes MDCT-Encode/Decode. BITRATE 6–256 kbps, SPEED (Frame-Länge; Packet-Division-Clock 1/1–1/64), PACKET (Loss), REPEAT, ARTFCT (Pre-Echo), JITTER, TONE. **+2048 Samples** Latenz.
- **MIRROR** – Shimmer-Folder: FOLD, SHAPE (Sinus→Dreieck), FDBK, TRAIL (±24 st, snap).
- **TAPE** – oversampelter Tape-Saturator. MODE (GENTLY, NORMAL, HARD, HARSH), BASS, TAPE (Drive), NOISE, DULL, WOW, FLUTTER, GAIN (±12 dB), HYST, WIDTH, **AGE** (Kopier-Generationen), **DROPOUT** (Oxid-Dropouts).
- **UNDERTOW** – Subharmonic-Divider: DIVIDE (÷2–÷8), MISFIRE, TONE, LEVEL, BLEND (→ DIVIDE B), LOCK (CYCLE-Counter oder PLL).

### 5.2 Filter / Spektral
- **EQ** – 5 Modi: High-Pass, Low-Shelf, Bell, High-Shelf, Low-Pass (HP/LP anfahrbar mit Drive).
- **PRISM** – analoges Multimode-Filter: TYPE (SVF, Moog-Ladder, 303-Diode-Ladder, „broken" Transistor), MODE (inkl. BP/HP/Notch), CUTOFF, RES, DRIVE, SLOPE (6/12/18/24 dB/Okt), FM (Audio-Rate-Cutoff-Mod aus Input), DRIFT.
- **TOOTH** – Kammfilter (3 Kämme, pitch-tracking). FREQ, OFF1, OFF2, FB, TONE, PLUCK (Noise-Burst pro Transiente), DAMP.
- **COMB** – neu in 2.0.4; Details unbekannt (nicht mit TOOTH zu verwechseln).
- **FORMANT** – 5-Formant-Vokalfilter. VOWEL, Q, SHIFT, SPREAD, VOICE (Male, Female, Child, Robot, Alien), SEQ (A-E-I-O-U pro Division), GLIDE.
- **SIEVE** – Xenakis-Sieb, rhythmisches STFT-Gate. PATTERN (Prime, Fib, Pow2, Odd, Even, KEY, CHORD), RATIO, SMOOTH, SIZE (512/1K/2K/4K). Läuft automatisch mit fester Rate.
- **CHROMA** – STFT-Spektralformung. TILT, CENTER, WIDTH, GAIN, WARP (±1 Oktave), GATE, SIZE, SCAN (CENTER-Sweep über 4 Takte…1/8). +4096 Samples.
- **CONTRAST** – Spektraldynamik. Gains für STRONG/MEDIUM/WEAK-Partials zwischen LOW und HIGH, SUSTAIN (hält Release je Partial bis HOLD), SMOOTH, SIZE. +4096.
- **LIQUIFY** – Phasen-Dispersion via Allpass-Kette um FOCUS. AMOUNT (0–32 Stufen), RESO, SPREAD, DRIVE, TRAIL (Feedback).
- **SEPARATE** – Quellentrennung in TONAL / NOISE / HITS mit je eigenem Gain. PITCH (Tonal ±12 st), SPREAD (Noise breiter), TIGHT (Hits kürzer), SIZE. +4096.
- **SMEAR** – Spektrale Unschärfe. SMEAR, TILT, FB, DIFF (Phasenwolke), SIZE, DIRECTION (auf/ab/beides), HOLD (friert Spektrum pro Division ein). +4096.
- **TRANSMIT** – Funkkanal-Zerfall. FREQ, WIDTH, DRIVE, COMP, NOISE, BURST, SQUELCH, DROPOUT, DIAL (verstimmt von der Station).
- **VESPER** – Dreiphasen-Notch-Netzwerk, „swirling filter". FREQ, SPREAD, TIME, SECTIONS, CASCADE, FDBK, RATE (1/1–1/64), F-/S-/T-MOD-Tiefen, POLARITY, ENV, ATTACK, RELEASE.

### 5.3 Pitch / Resonator / Granular / Time-Effekte
- **PITCH SHIFT** – grain-basiert. Modi Pitch, Frequency, Ring; Fine-Tune, Stereo-Spread, Delay, Feedback-Tone, Scale/Root-Snapping, SPRAY (instabile, bandartige Bewegung); Oktavlagen, harmonisierte Doubles, breite Stereo-Texturen.
- **FORMANT SHIFT** – Spektralhüllkurven-Shifter ohne Pitchänderung. SHIFT, DETAIL, SIZE (512…4K live umschaltbar), MIX; alle 4 Parameter modulierbar. FFT.
- **SCATTER** – granulare Wolke: Grains pitchen, reversen, einfrieren, scramblen; geclockte Size/Density, musikalische Intervalle, synchronisierte Scramble-Reads.
- **MAGNET** – spektrale Pitch-Anziehung: zieht jeden Partial zu FIELD (Scale, Chord, Row-Scale/Root, Sidechain-Peaks). ATTRACT, GLIDE, FOCUS, DRIFT. +4096.
- **STILLS** – spektrale Snapshots: pro SLICE (4 Takte…1/32) friert das Spektrum in eine Oszillatorbank ein. BLUR, VOICES (1–33), WAVE, TENSION, OCTAVE, FDBK.
- **TRIAD** – Skalen-Harmonizer, drei Stimmen V1–V3 (±2 Okt.) auf Skalenstufen, STAGGER (½ CHORD-Clock): FDBK, GLIDE, LOOSE, MICRO.
- **WARP** – Frequenz-Remap um PIVOT entlang CURVE (POWER, LINEAR, MIRROR, FOLD), STRETCH, TILT, GLIDE, SIZE. +4096.
- **CRYSTAL** – harmonischer Resonator, spielbare Bandpassbank, auf Skala gestimmt, bis 60 Stimmen. ROOT, SCALE, OCTAVES, FOCUS, BLOOM, SKEW (inharmonisch), WANDER, SLIP, FLUTTER, COLOR, ARP RATE/MODE, CHORD+PITCH, STRUM, EXCITE, ROTATE, SPREAD. (Review: erinnert an „Colorbass"-Resonatoren wie Bismuth.)
- **FREQ SHIFT** – Bode-SSB-Shifter, L/R unabhängig. SHIFT L/R (±500 Hz), TIME, FDBK, SNAP, TRACK.
- **MODAL** – 24-Moden-Resonator (angeschlagen). TUNE, DECAY, MATERIAL (Holz→Metall→Glas), POSITION, BRIGHT, FOLLOW, STRETCH (Inharmonizität), BOW.
- **STRINGS** – resonante Saiten auf CHORD in SCALE/ROOT. STRINGS (1–6), OCTAVE, DAMP, BRIGHT, COUPLE, BOW, POSITION.
- **CHOPPER (D)** – nimmt eine Bank auf, während die vorherige geschnitten abgespielt wird. SIZE (1/2–8 Beats; free 250 ms–4 s), DIVISION (2–32), je Slice SHUFFLE, REPEAT, PITCH, REVERSE, GATE, RATCHET.
- **LOOP (D)** – akkumulierender Looper: LENGTH (1/32–2/1), SPEED (−2×…2×), HEADS (1–4), OVERDUB, MODE (DROP, SHUF, TRIM, STRCH, ALL), MODIFY, STAMP, SCAN (0.25–20 s Rückschau).
- **SCANNER** – granulares Freeze: zwei Grains lesen gehaltenen Capture. SCAN, SIZE (10 ms–1 s), SHAPE, TRANSIENT (Hits re-capturen), DUCK/FLW, PITCH, SPRAY.
- **STRUM** – Fragment-Sequencer: Hits zerlegen Input in Fragmente. SLOTS (2–16), RATE (1/1–1/64), PATTERN (FWD, REV, SHUF, RANK, EUCL), PITCH, DECAY, SENSE, WIDTH.
- **WENDY (D)** – stereo „Memory Disorder": spielt 16 s Historie in einem SPAN-Fenster (4 Takte…1/32) in CUTS (1–32) Wiederholungen: SLIP, SEEK, WEAR (Lücken), EDGE, WIDTH.

### 5.4 Modulation (Effekte) / Raum / Delay / Dynamik
- **CHORUS** – 4-Voice-Pitch-Doubler: RATE, DEPTH, TIME, FDBK, WIDTH, MODE (CLASSIC, DIM D, JUNO).
- **ENSEMBLE** – BBD: TYPE (Juno, Solina, Dimension, Lush), zwei LFO-Raten, FDBK, WIDTH.
- **FLANGER** – stereo, optional Through-Zero: RATE, DEPTH, FDBK, DELAY, TZF, BARBER (OFF/RISE/FALL Endlos-Sweep).
- **PHASER** – 2–12 Allpass-Stufen: RATE, DEPTH, FDBK, CENTER, STAGES, BARBER.
- **FISSION** – FM über geformte variable Delays, 2× oversampled: FREQUENCY (20 Hz–20 kHz; SLOW 0.05–20 Hz), BITE, DEPTH, SPREAD (0–180°), FEEDBACK, SKEW, RANGE, RETRIG, RATIO (×¼–×8 des getrackten Pitch), CHAOS (Doppelpendel-Modulator).
- **FLYBY** – Doppler-Bewegung: PATH (ORBIT, PASS, FIG-8, BOUNCE, RANDOM, ROTOR/Leslie), SPEED, DISTANCE (2–40 m), DEPTH, AIR, WIDTH, ROTOR.
- **CLANG** – Ringmodulator (mit TRACK-Funktion), **ORBIT** – Auto-Panner, **TREMOR** – Tremolo: Parameter nicht verifiziert.
- **SPIRAL** – Tape-Delay: Stereo mit unabhängigen L/R-Raten, Ping-Pong, Wobble, Hiss, Ducking, Taps, Reverse, AGE, HALO, HEAD (TAPS, Space Echo, Volante, Mimeophon), SPACING.
- **GRANULAR DELAY (D)** – zwei Grains lesen 21 s Historie: TIME, SWING, SPRAY, FREQ, PITCH (−36…+12 st), RANDOM, INTERVALS, TONE, FEEDBACK, REVERSE, RETUNE, CHORD.
- **REEL (D)** – Mehrkopf-Tapeloop (bis 4 Köpfe, alle mit Feedback): TIME (1/32–2/1), SPACING (EVEN, TRIP, GOLD, SILV), HEADS, HALO, SKEW, FDBK, AGE.
- **SPECTRAL DELAY (D)** – jeder FFT-Bin mit eigener Verzögerung: TIME (1/16–1), TILT, FB, BLUR, SHIFT (±12 st), SPREAD, GATE, DAMP, LOCUT, SHAPE (LIN, EXP, LOG, STP, RND, KEY), SIZE, FZ BAND/SPLIT. +4096.
- **CADENCE** – neues Delay (2.0.4); Details unbekannt.
- **DRIP** – Feder-Reverb, 32-stufige Allpass-Dispersion: SIZE, DECAY, DAMP, RIPPLE, CRASH (Input schlägt die Feder an), TENSION, PICKUP.
- **DATTORRO** – Plate-Reverb: SIZE, DECAY, DIFF, PDLY, TONE, MOD, FREEZE.
- **AETHER** – Shimmer-Reverb (Parameter unbekannt).
- **GRANUVERB** – FDN-Reverb gerendert als verstreute, gepitchte Grains: SIZE, GRAIN, SCATTER, DECAY (>99 % friert ein), PITCH (OFF, +5TH, +OCT, −OCT, ±OCT, RND); MIX morpht Dry/Reverb/Grains.
- **SQUASH** – OTT-artiger Multiband-Kompressor: DEPTH, TIME, IN, OUT, BANDS (1/2/3), SOLO (in 2.0.0.814 überarbeitet: „cleaner but more noticeable").
- **GATE** – Noise-Gate (strafft Aufnahmen, entfernt Zwischenklang, formt Drum-Tails; per Modulation rhythmisch nutzbar). Geplant: Trance-Gate mit ADSR.
- **MANGLE** – CLASSIC: 2-Band-Kompressor + Saturator mit BRUTALITY-Regler; **MELT-Engine**: MODE / LIFT / PUMP / GRIT, 3-Band „Upward-Lifting"-Kompressor.
- **TRANSIENT** – Attack/Sustain-Designer, pegelunabhängig: ATTACK/SUSTAIN (±100), TIME (1–80 ms), RELEASE (30 ms–2 s), SWELL, LENGTH, SPLIT (40 Hz–10 kHz oder FULL), BAND.

**FFT-Effekte & Latenz:** SIEVE, FORMANT SHIFT, LOSSY, CHROMA, CONTRAST, SEPARATE, SMEAR, SPECTRAL DELAY, MAGNET, WARP addieren 2048 oder 4096 Samples. Mit **LATENCY COMP** (Default an, Zahnrad-Menü) meldet das Plugin diese Latenz dem Host (bei Parallel-Routing der längste Pfad). Gemutete FFT-Effekte behalten die Verzögerung. Änderungen greifen erst beim nächsten Stop.

---

## 6. MAIN-Zeile (immer aktiv, letzte Stufe)

GAIN (−∞…+12 dB, 0 dB in der Mitte) · LOW (±15 dB Shelf @ 200 Hz) · MID (±15 dB Peak @ 1 kHz) · HIGH (±15 dB Shelf @ 5 kHz) · PAN (konstante Leistung) · MIX (Master Dry/Wet). Laut Hersteller-Texten außerdem Compressor, Soft Limiter, Auto-Gain (Compressor und Auto-Gain Default 0) und ein „Bypass all"-Button.

---

## 7. Modulation und Performance

### 7.1 ANIMATE-Seite – drei unabhängige Systeme
**(a) Vier Modulator-Spalten** mit Modus-Pille **LFO / RAND / ENV**:
- **LFO:** 19 Shapes (u. a. Sinus, Dreieck, Saws, Rechtecke mit verschiedenen Duty-Cycles, EXP, LOG, PEAK, VALLEY, BUMP, DBL, SKEW, STAIRS), Raten 1/64 bis 16 Takte (11 host-synchrone Stufen), JITTER (zufällige Step-Grenzen), SMOOTH (Slew). Frühe Version nur tempo-synchron; der Hersteller arbeitet(e) an freien/ms-Raten (unbestätigt).
- **RANDOM:** gleiche Raten; **BIN** an = gestuft, aus = interpoliert; JITTER, SMOOTH; positionsbasierter, reproduzierbarer Jitter.
- **E.FOLLOWER:** Quelle INTERNAL (nach Time-Engine, vor FX-Kette) oder **EXTERNAL** (Sidechain-Eingang des Plugins); GAIN, RISE, FALL, bipolarer TONE (Tiefpass für Kicks/Bass, Hochpass für Hats/Transienten).

**(b) Drei Graph-Editoren:** geschlossene Bézier-Kurven, Loop-Länge ¼…16 Takte; Klick fügt Punkt hinzu, Drag verschiebt Punkt/Bend-Handle, Rechtsklick löscht; Richtung/Geschwindigkeit einstellbar.

**(c) Zwei Sequencer – STUTTER SEQ (steuert RATE bzw. REPS im BendIt-Modus) und STRETCH SEQ (steuert SPEED):** 16 Steps pro Pattern, **Ketten von 1–4 Patterns (= bis 64 Steps)**, laufen parallel, Step-Übergänge host-quantisiert (RATE 1/16…1/1). Klick = Step an/aus (aus = Dry-Durchlass beim Stutter-Seq), vertikales Ziehen = Wert pro Step, Tools zum Randomisieren/Löschen/Toggeln/Füllen. Reviewer: unterschiedliche Stepzahlen ermöglichen Polyrhythmen. Geplant: weitere Sequencer-Ziele und eigene Sequencer-Länge.

**Ziel-Slots:** je Modulator **6 Slots** (4 Spalten + 3 Graphen = 7 Quellen → **42 Ziele**). Pro Slot: TARGET-Picker (Seitenleiste nach Engine gruppiert: STRETCH, STUTTER, BENDIT, VARISPEED, jede FX, MAIN), **MIN/MAX** (clippen den Modulatorausgang), X zum Entfernen; Graph-Slots zusätzlich **START, END, SKEW** (dreieckige Hüllkurvenformung). Zuweisung auch per **Rechtsklick auf den Parameter**.

**Modulatoren modulieren Modulatoren** (seit 2.0.0.814): über die vier Spalten, den Graph-Editor und die Perform-Seite.

**Anzeige:** modulierte Regler erscheinen gedimmt, ein Badge zeigt die Quelle (LFO, RAN, ENV, GRA, M1–M4, X, Y). Klick auf das Badge entfernt die Modulation oder springt zum Modulator. Automation auf einem zugleich modulierten Parameter hat Vorrang des Modulators, wird aber weiter an die Host-Spur gesendet.

### 7.2 PERFORM-Seite
- **4 MACRO-Knöpfe** (`MACRO_1`–`MACRO_4`, 0–1, host-automatisierbar) und ein **X/Y-Pad** (`PERFORM_X`, `PERFORM_Y`). Jeder der 6 Controller routet zu **bis zu 5 Zielen** (Hersteller/Reviews; das Handbuch-Extrakt nennt 4) → **30 Perform-Ziele**, insgesamt **72** mit Animate.
- Pro Slot Kurven-Editor: **MIN/MAX** (Clamp), **START/END** (Bereich der 0–1-Macro-Bewegung, in dem der Parameter fährt), **SKEW** (linear/log/exp/S-Kurve). Mit Dreieckskurven blendet ein Knopf über seinen Weg zwischen **drei Punkten** (Crossfade-Kurven).
- **Takeover-Modell:** Wurde ein Ziel von anderer Quelle bewegt (Automation/Modulator), springt der Parameter bei Macro-Änderung nicht, bis der Macro-Wert die aktuelle Position kreuzt. Ziehen einer Slot-Kurve wirkt sofort.
- Manuell editierte Knöpfe, die einem Macro zugewiesen sind, werden gedimmt/gesperrt („Dimming-Modell"), damit Macro und Hand nicht kämpfen. Macro-Gesten sind als Host-Automation aufnehmbar. Macro-Assignments etc. funktionieren auch bei geschlossenem Editor (Fix 2.0.0.828).

### 7.3 Randomisierung („Dice")
Würfel global (aufgeteilt auf TIME und FX) und pro Effekt/Engine. **Random Setup** (Zahnrad): pro Parameter bipolare Stärke, **Stärke 0 = Wert gesperrt**.

### 7.4 Presets
Preset-Leiste mit Name, ◀ ▶ und Dropdown. Kategorien: **Init** (hartcodierter Default), Factory (nach Kategorie), User. User-Ordner: macOS `~/Library/Application Support/TapeFiasco2/Presets`, Windows `%APPDATA%/TapeFiasco2/Presets`. Punkt neben dem Namen = ungespeicherte Änderungen. Volle State-Recall im Host-Projekt. Mehrere UI-Themes (Laufzeit wählbar).

---

## 8. Klangmöglichkeiten (abgeleitet aus Parametern und Reviews)

Quellen belegen die Funktionen; die folgenden „Rezepte" sind **Ableitungen des Recherche-Autors**, keine Hersteller-Aussagen.

| Ziel | Mittel |
|---|---|
| Lo-Fi-Tape / Vintage | VARISPEED (SATURATION/HEAT, WOW/FLUTTER, COMPRESS), TAPE-FX (AGE, DROPOUT, NOISE, DULL), SPIRAL (Space Echo/Mimeophon), ENSEMBLE |
| Tape-Stop / DJ-Scratch / Turntablism | VARISPEED STOP + SCRATCH; BENDIT WARP-Zone SCRATCH mit Baby/Transformer/Tear/Scribble-Patterns |
| Rhythmische Glitch-/Stutter-Edits | STUTTER mit LINK-Presets, PATTERN, PROBABILITY, RETRIGGER, Stutter-SEQ; CIRCUIT BEND, STRUM, CHOPPER; BENDIT BREAK (SKIP/SCATTR/DRPOUT) |
| Freeze, Drones, Ambient-Texturen | STRETCH SPEED 0 + FREEZE, SCATTER, SCANNER, STILLS, GRANULAR DELAY, GRANUVERB, AETHER, DATTORRO FREEZE |
| Tonale Veredelung / Harmonik | CRYSTAL, MODAL, STRINGS, TRIAD, MAGNET, WARP, FORMANT/FORMANT SHIFT, alles per SCALE/ROOT-SNAP in Tonart |
| Digitale Zerstörung | BITROT, LOSSY, CIRCUIT BEND, TRANSMIT, MIRROR, PLASMA, WAVEFOLDER |
| Spektral-Weirdness | SIEVE, CHROMA, CONTRAST, SEPARATE, SMEAR, SPECTRAL DELAY, LIQUIFY |
| Bewegung/Raum | FLYBY, ORBIT, VESPER, FLANGER (Barber/Through-Zero), PHASER (Barber), TREMOR |
| Dynamisches Pumpen/Grit | SQUASH, MANGLE MELT/CLASSIC, TRANSIENT, GATE |
| Performance | 4 Macros mit Dreipunkt-Crossfade-Kurven + X/Y-Pad, Takeover, Gesten als Host-Automation aufnehmen |
| Selbstspielende Patches | 4 Modulatoren + 3 Graphen + 2 Sequencer, modulierbar untereinander, E.FOLLOWER mit externem Sidechain (z. B. Kick steuert Filter/Stutter) |

Wichtige Eigenheiten, die den Klang prägen: Speed und Pitch sind in Stretch/Varispeed **gekoppelt**; Effekte werden **in beliebiger Reihenfolge** verkettet (Reihenfolge ändert Klang stark); starke Sättigung/Kompression im Varispeed kann „überkomprimiert" wirken – Dry/Wet und Compress zurücknehmen.

---

## 9. Widersprüche und Wissenslücken der Quellen

1. **Effektanzahl:** 21 (Launch) / 25 (Juni–Juli) / 30 (iPad 2.0.2) / **62 (2.0.4 – aktuell)**. Das Handbuch-Extrakt spricht noch von „21", listet aber 50 der 62 Effekte. Fehlen im Extrakt: EQ, COMB, PITCH SHIFT, FORMANT SHIFT, SCATTER, CLANG, ORBIT, TREMOR, AETHER, GATE, MANGLE, CADENCE.
2. **Time-Engines:** Handbuch-Extrakt: „drei Time-Engines" + BendIt als Modus der Stutter-Sektion. Marketing: „vier Engines". Funktional identisch.
3. **Stretch „granular?"** Marketing: „dual-grain stretcher", Hersteller-Zeile „not a pitch-shifter (no formant preservation, **no granular**)". Praktisch ist es ein Grain-Scheduler (Grain-Rate, Scatter, Spread). Roadmap: „granulare Time-Engine" und „längere Stretch-Grains".
4. **Sequencer-Länge:** „64 Steps" (Marketing) = 4 gekettete 16-Step-Patterns (Handbuch). Ältere Review-Aussage „beliebige Länge pro Sequencer" nicht verifiziert.
5. **Perform-Ziele pro Controller:** 5 (Hersteller, Reviews) vs. 4 (Handbuch-Extrakt). 6 Controller × 5 = 30 → passt zur Rechnung 42 + 30 = 72.
6. **LFO-Shapes:** 19 (Hersteller) vs. 5 gelistet (Handbuch-Extrakt, gekürzt). Raten 1/64…16 Takte.
7. **Plattformen:** Hersteller: Linux-VST3; ältere Forenquelle: Linux nicht gelistet.
8. **BREAK vs. FRACTURE** = derselbe 5-Zonen-Regler (UI-Name vs. Marketing).
9. **Vari-MODE FWD-REV:** einmal „wechselt je Capture-Zyklus", einmal „bipolarer Speed-Knob". Wahrscheinlich Versionsunterschied.
10. **Master-Zeile:** Handbuch nennt nur GAIN/EQ/PAN/MIX + Limiter; Hersteller-Texte nennen zusätzlich Compressor/Auto-Gain.
11. **Nicht auffindbar:** das **englische Original-Handbuch** (~60 Seiten, zur Hälfte Parameterlisten; im Plugin über Zahnrad-Menü → MANUAL online). Das Handbuch-Extrakt oben stammt aus einer japanischen Übersetzung (HackMD), die zusätzlich durch eine automatische Zusammenfassung gelaufen ist → Zahlenwerte sind plausibel, aber nicht 1:1 verifiziert.
12. **Nicht dokumentiert:** konkrete DSP-Algorithmen, Glättungszeiten der Parameter, Filterkoeffizienten, Preset-Inhalte, wo die globale SCALE/ROOT/CHORD-Auswahl sitzt, Details zu COMB, CADENCE, CLANG, ORBIT, TREMOR, AETHER, L/R-Lock und „free vs. clocked FX-Rate", Feinverhalten des Takeover-Modells.
13. **Bekannte Probleme (Forum, ältere Version):** Klicken im Stutter bei Mix 50 % bzw. Wechsel auf FREE-Sync (Ableton Live 12, Win 11); inzwischen laut Release-Notes mehrere Click-Fixes (2.0.0.821 / 2.0.0.825).

---

## 10. Hinweise für die Implementierung (Empfehlungen des Recherche-Autors, nicht aus den Quellen)

- **Rechtliches/Hygiene:** Die Beschreibung soll als *Funktions-Spezifikation* dienen; DSP, UI, Grafiken, Presets und Namen sind selbst zu entwickeln (kein Code/Samples/Presets/Artwork des Originals übernehmen, eigener Produktname).
- **Modulare Kernstruktur:** (1) Host-/Transport-Clock (PPQ, Sample-Zähler-Fallback); (2) Parameter-System mit Automation, Modulationsquellen → Ziele (Min/Max/Start/End/Skew), Takeover und Dimming; (3) Time-Engine-Block (Ring-Puffer, Grain-Scheduler, Capture/Loop-Logik, BendIt-Zonen als Zustandsmaschine); (4) FX-Kette mit gemeinsamer Effekt-Basisklasse (ON/OFF mit 10-ms-Fade, State-Reset, NaN-Guard, Gain-Comp, Oversampling-Option); (5) gemeinsames STFT-/Overlap-Add-Framework für alle Spektraleffekte inkl. Latenzmeldung; (6) Skalen-/Tonart-Modul für alle SNAP-Ziele; (7) Preset/State-Management.
- **Sinnvolle Reihenfolge:** Kern + MAIN + Varispeed → Stutter (+ Sequencer) → Stretch → ANIMATE (LFO/Random/Graph/E.Follower) → PERFORM → BendIt → FX in Wellen (Distortion/Filter/Mod/Delay/Reverb zuerst, Spektral-/Granular-FX zuletzt) → Dice/Presets/Themes.
- **Qualität:** Anti-Click-Maßnahmen aus Abschnitt 2 von Anfang an einplanen; Zeitparameter immer host-quantisiert; Test mit Transport-Start/Stop/Seek mitten im Takt.
- **Offene Entscheidungen** (vom Nutzer zu klären, bevor programmiert wird): Zielplattform/Framework (z. B. JUCE/C++ VST3, Rust/nih-plug, Web Audio, Max/gen~ …), Umfang (MVP oder alle 62 Effekte), Stereo/Mono, UI-Stil, Lizenz/Verwendungszweck.

---

## 11. Zusätzliche Wünsche des Nutzers

*(Platzhalter – hier die eigenen Wünsche einfügen, z. B. gewünschte Zielplattform, Weglassungen, Erweiterungen, andere Effekte, eigenes UI-Konzept.)*

-
-
-

---

## 12. Quellen

- Herstellerseite: https://www.phasefiasco.com/tapefiasco-2 · Entwicklerseite: https://erikssonjonas.com/tapefiasco-2
- Release-Notes (bis 2.0.4.974): https://github.com/everyreasontopanic/tapefiasco-updates/releases
- Handbuch v2.0.4.974 (japanische Übersetzung): https://hackmd.io/@srronin-ja/ByUbBFtnGg
- iPad-App/Versionshistorie: https://apps.apple.com/us/app/tape-fiasco-2/id6796447234
- KVR-Thread mit Entwicklerkommentaren: https://www.kvraudio.com/forum/viewtopic.php?t=630759 · https://www.kvraudio.com/forum/viewtopic.php?p=9253697
- Reviews/News: https://www.audiopluginguy.com/review-tape-fiasco-2-by-phase-fiasco/ · https://www.databroth.com/blog/tape-fiasco-2-review · https://mordio.online/signals/tape-fiasco-2-made-me-love-sound-design · https://synthanatomy.com/2026/09/phase-fiasco-tape-fiasco-2-a-multi-fx-playground-for-audio-stretching-and-warping.html · https://rekkerd.org/phase-fiasco-launched-tape-fiasco-2-creative-audio-effect-plugin/ · https://www.synthtopia.com/?p=153835 · https://www.matrixsynth.com/2026/06/ruin-everything-in-new-tape-fiasco-2.html · https://www.matrixsynth.com/2026/07/tape-fiasco-2-just-got-lot-more-powerful.html
