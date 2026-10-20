// Desk-bell "ting", measured off a reference recording: a 2799 Hz strike with one
// inharmonic partial at 2.762x, decaying to a tenth of its peak in 0.72 s.
const BELL_FUNDAMENTAL_HZ = 2799;
const BELL_PARTIAL_RATIO = 2.762;
const BELL_DECAY_SECONDS = 1;
const BELL_TAIL_SECONDS = 1.05;
// Where the exponential decay lands at BELL_DECAY_SECONDS to give that 0.72 s tenth-life.
const BELL_TAIL_FRACTION = 0.0408;
const BELL_ATTACK_SECONDS = 0.004;
const BELL_PARTIAL_GAINS = [0.18, 0.07];

/** Rising pair used for an arriving order, distinct from the bell that means "ready". */
export const ORDER_TONES = [880, 1174];

/** Struck-bell strike, synthesised so no audio asset ships with the app. */
export function playBell(context: AudioContext): void {
  const start = context.currentTime;
  [BELL_FUNDAMENTAL_HZ, BELL_FUNDAMENTAL_HZ * BELL_PARTIAL_RATIO].forEach((frequency, index) => {
    const peak = BELL_PARTIAL_GAINS[index];
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + BELL_ATTACK_SECONDS);
    gain.gain.exponentialRampToValueAtTime(peak * BELL_TAIL_FRACTION, start + BELL_DECAY_SECONDS);
    // Taper to silence rather than cutting the tail, which clicks on most speakers.
    gain.gain.exponentialRampToValueAtTime(0.0001, start + BELL_TAIL_SECONDS);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + BELL_TAIL_SECONDS);
  });
}

/** Short rising tones, synthesised so no audio asset ships with the app. */
export function playChime(context: AudioContext, tones: number[]): void {
  const start = context.currentTime;
  tones.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const at = start + index * 0.18;
    // Ramped rather than switched on/off: a hard gate clicks on most speakers.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.18);
  });
}

/**
 * Plays through a lazily created context, waiting for a resume when autoplay policy
 * has suspended it. Tones scheduled on a suspended context are never rendered, so
 * playing before the resume lands would be silent with no error.
 */
export function playWhenReady(
  getContext: () => AudioContext | null,
  setContext: (context: AudioContext) => void,
  render: (context: AudioContext) => void,
): void {
  try {
    let context = getContext();
    if (!context) {
      context = new AudioContext();
      setContext(context);
    }
    const target = context;
    if (target.state === 'running') {
      render(target);
      return;
    }
    void target
      .resume()
      .then(() => render(target))
      .catch(() => {});
  } catch {
    // A device without Web Audio still gets the on-screen alert.
  }
}
