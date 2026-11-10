(function () {
  'use strict';

  const STORAGE_KEY = 'neo_sound_enabled';
  const ringLog = [];
  let audioCtx = null;
  let unlocked = false;
  let lastKindAt = {};

  function isEnabled() {
    try {
      return localStorage.getItem(STORAGE_KEY) !== '0';
    } catch (_) {
      return true;
    }
  }

  function setEnabled(flag) {
    try {
      localStorage.setItem(STORAGE_KEY, flag ? '1' : '0');
    } catch (_) {}
  }

  function ensureContext() {
    if (audioCtx) return audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      audioCtx = new Ctx();
    } catch (_) {
      return null;
    }
    return audioCtx;
  }

  function unlockAudio() {
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    if (!unlocked) {
      unlocked = true;
      try {
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
      } catch (_) {}
    }
  }

  ['pointerdown', 'touchstart', 'keydown'].forEach(ev => {
    document.addEventListener(ev, unlockAudio, { passive: true, capture: true });
  });

  function playNote(ctx, freq, startOffset, duration, type = 'sine', peakGain = 0.16, endFreq = null) {
    const t0 = ctx.currentTime + startOffset;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq && endFreq !== freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, endFreq), t0 + duration);
    }

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  const VIBRATE_PATTERNS = {
    filled: [35, 35, 55],
    tp: [45, 35, 45, 35, 95],
    sl: [120, 60, 120],
    closed: [45],
  };

  function play(kind) {
    const cleanKind = ['filled', 'tp', 'sl', 'closed'].includes(kind) ? kind : 'filled';
    const now = Date.now();
    if (lastKindAt[cleanKind] && now - lastKindAt[cleanKind] < 180) {
      return false;
    }
    lastKindAt[cleanKind] = now;

    const enabled = isEnabled();
    let vibrated = false;

    if (enabled && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        vibrated = Boolean(navigator.vibrate(VIBRATE_PATTERNS[cleanKind]));
      } catch (_) {}
    }

    if (enabled) {
      const ctx = ensureContext();
      if (ctx) {
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        try {
          if (cleanKind === 'filled') {
            // Crisp Order Executed double-note ascending fill ping (G5 -> C6)
            playNote(ctx, 783.99, 0.00, 0.13, 'triangle', 0.16);
            playNote(ctx, 1046.50, 0.075, 0.22, 'sine', 0.19);
            playNote(ctx, 1567.98, 0.075, 0.16, 'sine', 0.06);
          } else if (cleanKind === 'tp') {
            // Winning Take-Profit chime: bright celebratory C major triad arpeggio (C5 -> E5 -> G5 -> C6)
            playNote(ctx, 523.25, 0.00, 0.16, 'sine', 0.15);
            playNote(ctx, 659.25, 0.075, 0.17, 'sine', 0.16);
            playNote(ctx, 783.99, 0.15, 0.19, 'sine', 0.17);
            playNote(ctx, 1046.50, 0.225, 0.34, 'triangle', 0.20);
            playNote(ctx, 1567.98, 0.225, 0.28, 'sine', 0.07);
          } else if (cleanKind === 'sl') {
            // Losing Stop-Loss chime: clear somber descending drop (F4 -> Bb3)
            playNote(ctx, 349.23, 0.00, 0.17, 'triangle', 0.18, 311.13);
            playNote(ctx, 233.08, 0.145, 0.32, 'triangle', 0.21, 196.00);
          } else if (cleanKind === 'closed') {
            // Neutral Manual Close chime: clean settlement fifth down cadence (D5 -> A4)
            playNote(ctx, 587.33, 0.00, 0.14, 'sine', 0.14);
            playNote(ctx, 440.00, 0.09, 0.25, 'sine', 0.16);
          }
        } catch (_) {}
      }
    }

    ringLog.push({ kind: cleanKind, enabled, vibrated, ts: now });
    if (ringLog.length > 30) ringLog.shift();
    window.__neoSoundLog = ringLog;
    return enabled;
  }

  function toggle() {
    const next = !isEnabled();
    setEnabled(next);
    if (next) {
      unlockAudio();
      play('filled');
    }
    return next;
  }

  window.__neoSoundLog = ringLog;
  window.NeoSoundFX = {
    play,
    isEnabled,
    setEnabled,
    toggle,
    unlock: unlockAudio,
  };
})();
