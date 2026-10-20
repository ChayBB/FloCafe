'use client';

import { useEffect, useRef } from 'react';
import { ORDER_TONES, playChime, playWhenReady } from '@/lib/alert-sounds';
import { markSeen, selectArrivals, type AnnouncedOrder } from '@/lib/kds-arrivals';
import { SPEECH_DELAY_MS, speakAlert, splitByScript } from '@/lib/speech';
export { splitByScript };

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export type { AnnouncedItem, AnnouncedOrder } from '@/lib/kds-arrivals';

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
      const parts: string[] = [];
      const tableName = order.table?.name;
      if (tableName) parts.push(formatTableRef.current(String(tableName)));
      for (const item of order.items || []) {
        parts.push(`${item.product_name} ${item.quantity}`);
      }
      if (parts.length === 0) return;
      speakAlert(parts.join(', '), locale);
    }
  }, [orders, enabled, locale]);
}
