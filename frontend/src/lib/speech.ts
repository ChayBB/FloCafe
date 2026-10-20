/** Reading alerts out loud, shared by the kitchen display and the server app. */

// The chime has to finish and the room has to register it before the voice starts,
// or the first word is lost under the tail of the tone.
export const SPEECH_DELAY_MS = 1500;

const THAI_PATTERN = /[฀-๿]/;
/** Digits, spaces and punctuation carry no script, so they join the run before them. */
const NEUTRAL_PATTERN = /[\s\d\p{P}\p{S}]/u;

export type Segment = { text: string; thai: boolean };

/**
 * Splits mixed text into Thai and non-Thai runs.
 *
 * A menu reads "ต้มยำ" and "ICE Amerigano" in one breath, and no single voice
 * pronounces both, so each run is spoken by a voice that matches its script.
 */
export function splitByScript(text: string): Segment[] {
  const segments: Segment[] = [];
  for (const character of Array.from(text)) {
    const neutral = NEUTRAL_PATTERN.test(character);
    const thai = THAI_PATTERN.test(character);
    const last = segments[segments.length - 1];
    if (last && (neutral || last.thai === thai)) {
      last.text += character;
      continue;
    }
    segments.push({ text: character, thai });
  }
  // A run of only spaces or punctuation has nothing to pronounce.
  return segments.filter((segment) => /[\p{L}\p{N}]/u.test(segment.text));
}

/** Picks the best available voice for a list of language prefixes, in order of preference. */
export function pickVoice(
  voices: SpeechSynthesisVoice[],
  prefixes: string[],
): SpeechSynthesisVoice | null {
  for (const prefix of prefixes) {
    const wanted = prefix.toLowerCase();
    const exact = voices.find((voice) => voice.lang.toLowerCase().replace('_', '-') === wanted);
    if (exact) return exact;
    const language = wanted.split('-')[0];
    const loose = voices.find((voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === language);
    if (loose) return loose;
  }
  return null;
}

/**
 * An em dash reads as a pause the synthesiser does not take, and some voices
 * pronounce it. A comma gives the same beat and is spoken by none of them.
 */
export function speakableText(text: string): string {
  return text.replace(/\s*[—–-]\s*/g, ', ').trim();
}

let warned = false;

/**
 * Speaks `text`, one voice per script run.
 *
 * Returns false when the device has no usable voice: the browser would otherwise
 * read the text with the wrong one and report no error, so silence looks like
 * success and nobody finds out until service.
 */
export function speakAlert(text: string, locale: string): boolean {
  const synthesis = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synthesis) return false;
  const voices = synthesis.getVoices();
  const thaiVoice = pickVoice(voices, ['th-TH', 'th']);
  // Latin runs prefer the UI language when it is itself Latin-script, else English.
  const latinVoice = pickVoice(
    voices,
    THAI_PATTERN.test(locale) ? ['en-US', 'en'] : [locale, 'en-US', 'en'],
  );
  if (!thaiVoice && !latinVoice) {
    if (!warned) {
      warned = true;
      console.warn('[Alerts] No speech voice installed; announcements stay silent.');
    }
    return false;
  }

  try {
    for (const segment of splitByScript(speakableText(text))) {
      // Falls back to the other voice rather than dropping the run: a mangled
      // word still tells the room something, silence does not.
      const voice = (segment.thai ? thaiVoice : latinVoice) || thaiVoice || latinVoice;
      if (!voice) continue;
      const utterance = new SpeechSynthesisUtterance(segment.text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      synthesis.speak(utterance);
    }
    return true;
  } catch {
    // A refused utterance must never break the screen it was announcing on.
    return false;
  }
}
