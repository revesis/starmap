(() => {
  'use strict';

  // Uses Tone.js's physically-modeled plucked-string voice, echoing the "particle string" theme:
  // clicking/being called into a particle = plucking a string; entropy drives an ambient noise floor.
  let ready = false;
  let pluck = null;
  let drone = null;
  let droneFilter = null;
  let voices = [];

  const SCALE = ['C3', 'D3', 'E3', 'G3', 'A3', 'C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5'];
  const VOICE_COUNT = 24;

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }

  function noteForNode(n) {
    const extHash = hashStr(n.ext || n.label || '') % 5;
    const normSize = Math.max(0, Math.min(1, (n.radius - 3) / 23));
    const sizeRank = 2 - Math.round(normSize * 2); // the bigger the file, the lower the pitch
    const idx = Math.max(0, Math.min(SCALE.length - 1, sizeRank * 5 + extHash));
    return SCALE[idx];
  }

  function ensureVoices() {
    if (voices.length) return;
    for (let i = 0; i < VOICE_COUNT; i++) {
      const panner = new Tone.Panner(0).toDestination();
      const gain = new Tone.Gain(0).connect(panner);
      const osc = new Tone.Oscillator({ type: 'sine', frequency: 220 }).connect(gain);
      osc.start();
      voices.push({ osc, gain, panner, id: null });
    }
  }

  async function init() {
    if (ready || typeof Tone === 'undefined') return;
    await Tone.start();

    pluck = new Tone.PluckSynth({ attackNoise: 0.5, dampening: 3200, resonance: 0.82 }).toDestination();
    pluck.volume.value = -8;

    drone = new Tone.Noise('pink').start();
    droneFilter = new Tone.Filter(260, 'lowpass').toDestination();
    drone.connect(droneFilter);
    drone.volume.value = -60; // near-silent at start; updateEntropy raises it based on the entropy value

    ensureVoices();
    ready = true;
  }

  function setEnabled(v) {
    if (typeof Tone !== 'undefined' && Tone.Destination) {
      Tone.Destination.mute = !v;
    }
  }

  function pluckNode(n) {
    if (!ready || !pluck) return;
    try {
      pluck.dampening = 1800 + (n.intensity || 0) * 4500;
      pluck.triggerAttack(noteForNode(n));
    } catch {
      // an occasional audio-node glitch shouldn't affect core functionality
    }
  }

  function updateEntropy(avgEntropy) {
    if (!ready || !drone || !droneFilter) return;
    const vol = -60 + avgEntropy * 40; // the higher the entropy, the more prominent the noise floor
    const cutoff = 200 + avgEntropy * 2200;
    drone.volume.rampTo(vol, 3);
    droneFilter.frequency.rampTo(cutoff, 3);
  }

  // A bounded-voice ambient sound field: every particle can sustain a tone, but only the ones
  // "closest to the viewport center" get a voice slot assigned (voice-stealing) — fading out as
  // particles leave and fading in as new ones enter, so thousands of particles never sound at once
  function applyCandidate(v, c, isNew) {
    const targetGain = Math.max(0, Math.min(0.14, c.gain || 0));
    const freq = Tone.Frequency(noteForNode(c)).toFrequency();
    if (isNew) {
      v.osc.frequency.value = freq;
      v.gain.gain.value = 0;
    } else {
      v.osc.frequency.rampTo(freq, 0.4);
    }
    v.gain.gain.rampTo(targetGain, isNew ? 0.9 : 0.4);
    v.panner.pan.rampTo(Math.max(-1, Math.min(1, c.pan || 0)), 0.4);
  }

  function updateAmbient(candidates) {
    if (!ready || !voices.length) return;
    const wantedIds = new Set(candidates.map((c) => c.id));

    // Voice slots no longer needed: fade out and release
    for (const v of voices) {
      if (v.id && !wantedIds.has(v.id)) {
        v.gain.gain.rampTo(0, 0.5);
        v.id = null;
      }
    }

    const unmatched = [];
    for (const c of candidates) {
      const v = voices.find((vv) => vv.id === c.id);
      if (v) applyCandidate(v, c, false);
      else unmatched.push(c);
    }

    const freeVoices = voices.filter((v) => v.id === null);
    for (let i = 0; i < unmatched.length && i < freeVoices.length; i++) {
      const v = freeVoices[i];
      const c = unmatched[i];
      v.id = c.id;
      applyCandidate(v, c, true);
    }
  }

  window.CosmosAudio = { init, setEnabled, pluck: pluckNode, updateEntropy, updateAmbient };
})();
