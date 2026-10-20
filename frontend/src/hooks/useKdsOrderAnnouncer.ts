'use client';

import { useEffect, useRef } from 'react';
import { ORDER_TONES, playChime, playWhenReady } from '@/lib/alert-sounds';
import { markSeen, selectArrivals, type AnnouncedOrder } from '@/lib/kds-arrivals';
export type { AnnouncedItem, AnnouncedOrder } from '@/lib/kds-arrivals';

// The chime has to finish and the room has to register it before the voice starts,
// or the first word is lost under the second tone.
const SPEECH_DELAY_MS = 1500;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const THAI_PATTERN = /[฀-๿]/;
/** Digits, spaces and punctuation carry no script, so they join the run before them. */
const NEUTRAL_PATTERN = /[\s\d\p{P}\p{S}]/u;

type Segment = { text: string; thai: boolean };

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
function pickVoice(
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
 * Announces orders arriving on a kitchen screen: a chime, a pause, then the table
 * and what was ordered. Seeds silently on first load so reconnecting does not read
 * out the entire board.
 */
export function useKdsOrderAnnouncer({
  orders,
  enabled,
  locale,
  formatTable,
}: {
  orders: AnnouncedOrder[];
  enabled: boolean;
  locale: string;
  formatTable: (name: string) => string;
}) {
  const seenRef = useRef<Set<number>>(new Set());
  const seededRef = useRef(false);
  const audioRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const cancelledRef = useRef(false);
  const warnedRef = useRef(false);
  const formatTableRef = useRef(formatTable);
  useEffect(() => {
    formatTableRef.current = formatTable;
  }, [formatTable]);

  // Autoplay policies keep a context suspended until the document is interacted
  // with; unlocking on the first touch means the first order of a shift is heard.
  useEffect(() => {
    function unlock() {
      try {
        if (!audioRef.current) audioRef.current = new AudioContext();
        void audioRef.current.resume().catch(() => {});
      } catch {
        // No Web Audio on this device.
      }
    }
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* not supported */
      }
    };
  }, []);

  useEffect(
    () => () => {
      void audioRef.current?.close();
    },
    [],
  );

  useEffect(() => {
    if (!enabled) {
      seenRef.current.clear();
      seededRef.current = false;
      return;
    }
    if (!seededRef.current) {
      // First payload is the existing board, not news.
      markSeen(orders, seenRef.current);
      seededRef.current = true;
      return;
    }

    const arrived = selectArrivals(orders, seenRef.current);
    if (arrived.length === 0) return;
    markSeen(arrived, seenRef.current);

    for (const order of arrived) {
      // Chained so two orders landing together are announced one after the other
      // rather than talking over each other.
      queueRef.current = queueRef.current.then(() => announce(order)).catch(() => {});
    }

    async function announce(order: AnnouncedOrder) {
      if (cancelledRef.current) return;
      playWhenReady(
        () => audioRef.current,
        (context) => {
          audioRef.current = context;
        },
        (context) => playChime(context, ORDER_TONES),
      );
      await wait(SPEECH_DELAY_MS);
      if (cancelledRef.current) return;
      speak(order);
    }

    function speak(order: AnnouncedOrder) {
      const synthesis = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
      if (!synthesis) return;
      const voices = synthesis.getVoices();
      const thaiVoice = pickVoice(voices, ['th-TH', 'th']);
      // Latin runs prefer the UI language when it is itself Latin-script, else English.
      const latinVoice = pickVoice(
        voices,
        THAI_PATTERN.test(locale) ? ['en-US', 'en'] : [locale, 'en-US', 'en'],
      );
      if (!thaiVoice && !latinVoice) {
        if (!warnedRef.current) {
          warnedRef.current = true;
          // Worth saying out loud: with no matching voice the browser reads the text
          // with the wrong one and reports no error, so silence looks like success.
          console.warn(`[KDS] No speech voice installed; announcements stay silent.`);
        }
        return;
      }

      const parts: string[] = [];
      const tableName = order.table?.name;
      if (tableName) parts.push(formatTableRef.current(String(tableName)));
      for (const item of order.items || []) {
        parts.push(`${item.product_name} ${item.quantity}`);
      }
      if (parts.length === 0) return;

      try {
        for (const segment of splitByScript(parts.join(', '))) {
          // Falls back to the other voice rather than dropping the run: a mangled
          // word still tells the kitchen something, silence does not.
          const voice = (segment.thai ? thaiVoice : latinVoice) || thaiVoice || latinVoice;
          if (!voice) continue;
          const utterance = new SpeechSynthesisUtterance(segment.text);
          utterance.voice = voice;
          utterance.lang = voice.lang;
          synthesis.speak(utterance);
        }
      } catch {
        // A refused utterance must never break the board.
      }
    }
  }, [orders, enabled, locale]);
}
