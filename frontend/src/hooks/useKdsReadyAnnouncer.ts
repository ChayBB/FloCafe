'use client';

import { useEffect, useRef } from 'react';
import { playBell, playWhenReady } from '@/lib/alert-sounds';
import {
  markStatuses,
  selectNewlyReady,
  type ReadyTransition,
  type TrackedOrder,
} from '@/lib/ready-transitions';
import { SPEECH_DELAY_MS, speakAlert } from '@/lib/speech';

/**
 * Rings the ready bell on the kitchen screen when a line is marked ready, then
 * reads it out.
 *
 * The waiter's app already announces this, but the cook who tapped the button
 * gets no confirmation that the tap registered, and a cook working a second
 * station hears nothing at all. Same bell and same sentence on both screens, so
 * the two never disagree about what was said.
 */
export function useKdsReadyAnnouncer({
  orders,
  enabled,
  locale,
  describeReady,
}: {
  orders: TrackedOrder[];
  enabled: boolean;
  locale: string;
  /** The already-translated sentence to speak, or nothing to stay silent. */
  describeReady: (transition: ReadyTransition) => string;
}) {
  const statusesRef = useRef<Map<number, string>>(new Map());
  const seededRef = useRef(false);
  const audioRef = useRef<AudioContext | null>(null);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const describeRef = useRef(describeReady);
  const localeRef = useRef(locale);
  useEffect(() => {
    describeRef.current = describeReady;
    localeRef.current = locale;
  }, [describeReady, locale]);

  // Autoplay policies keep a context suspended until the document is interacted
  // with; unlocking on the first touch means the first ready of a shift is heard.
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

  useEffect(
    () => () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* not supported */
      }
      void audioRef.current?.close();
    },
    [],
  );

  useEffect(() => {
    if (!enabled) {
      statusesRef.current.clear();
      seededRef.current = false;
      return;
    }
    if (!seededRef.current) {
      // The first board is the state of the kitchen, not news from it.
      markStatuses(orders, statusesRef.current);
      seededRef.current = true;
      return;
    }

    const transitions = selectNewlyReady(orders, statusesRef.current);
    markStatuses(orders, statusesRef.current);
    if (transitions.length === 0) return;

    playWhenReady(
      () => audioRef.current,
      (context) => {
        audioRef.current = context;
      },
      playBell,
    );

    for (const [index, transition] of transitions.entries()) {
      const sentence = describeRef.current(transition);
      if (!sentence) continue;
      // Held until the bell has rung out, and spaced apart when several land at
      // once so the voice does not talk over itself.
      const timer = setTimeout(
        () => {
          timersRef.current.delete(timer);
          speakAlert(sentence, localeRef.current);
        },
        SPEECH_DELAY_MS + index * 1800,
      );
      timersRef.current.add(timer);
    }
  }, [orders, enabled]);
}
