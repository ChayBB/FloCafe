'use client';

import type { AxiosInstance } from 'axios';
import { useEffect, useRef } from 'react';

export interface ReadyAlertTable {
  id: string;
  name?: string;
  number?: string;
}

interface PolledItem {
  id: number;
  product_name: string;
  status: string;
}

interface PolledOrder {
  id: number;
  table_id?: string | null;
  items?: PolledItem[];
}

// The socket carries alerts within a second; the poll is only a safety net for a
// dropped connection, so it runs far less often than it did before the socket existed.
const POLL_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;
const TOKEN_KEY = 'flocafe:server-app-token';

/** Two short rising tones, synthesised so no audio asset ships with the app. */
function playChime(context: AudioContext) {
  const start = context.currentTime;
  [880, 1174].forEach((frequency, index) => {
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
 * Polls the tables this device is allowed to see and fires a chime the moment the
 * kitchen flips one of their lines to "ready". Table scoping is inherited from the
 * caller's table list, so an assigned server is only alerted for their own section.
 */
export function useServerReadyAlerts({
  api,
  tables,
  enabled,
  muted,
  onReady,
  onGuestOrder,
}: {
  api: AxiosInstance | null;
  tables: ReadyAlertTable[];
  enabled: boolean;
  muted: boolean;
  onReady: (item: { productName: string; tableName: string }) => void;
  /** A customer ordered from their own phone on one of this user's tables. */
  onGuestOrder?: (order: { tableName: string; itemCount: number; appended: boolean }) => void;
}) {
  const statusesRef = useRef<Map<number, string>>(new Map());
  const seededRef = useRef(false);
  const audioRef = useRef<AudioContext | null>(null);
  // Read inside the interval so toggling mute or reloading tables never restarts the poll.
  const mutedRef = useRef(muted);
  const tablesRef = useRef(tables);
  const onReadyRef = useRef(onReady);
  const onGuestOrderRef = useRef(onGuestOrder);
  useEffect(() => {
    mutedRef.current = muted;
    tablesRef.current = tables;
    onReadyRef.current = onReady;
    onGuestOrderRef.current = onGuestOrder;
  }, [muted, tables, onReady, onGuestOrder]);

  function chime() {
    if (mutedRef.current) return;
    try {
      if (!audioRef.current) audioRef.current = new AudioContext();
      // Autoplay policies suspend the context until a gesture; resume is a no-op otherwise.
      void audioRef.current.resume();
      playChime(audioRef.current);
    } catch {
      // A device without Web Audio still gets the on-screen alert.
    }
  }

  function raiseAlert(alert: { productName: string; tableName: string }) {
    chime();
    onReadyRef.current(alert);
  }

  useEffect(() => {
    if (!api || !enabled) {
      statusesRef.current.clear();
      seededRef.current = false;
      return;
    }
    let cancelled = false;

    async function poll() {
      const visible = new Map(tablesRef.current.map((table) => [table.id, table.name || table.number || table.id]));
      if (visible.size === 0) return;
      try {
        const { data } = await api!.get('/api/orders', {
          params: { type: 'dine_in', status: 'pending,preparing,ready', per_page: 100 },
        });
        if (cancelled) return;
        const next = new Map<number, string>();
        const alerts: { productName: string; tableName: string }[] = [];
        for (const order of (data.orders || []) as PolledOrder[]) {
          const tableName = order.table_id ? visible.get(String(order.table_id)) : undefined;
          if (!tableName) continue;
          for (const item of order.items || []) {
            next.set(item.id, item.status);
            const previous = statusesRef.current.get(item.id);
            if (seededRef.current && previous && previous !== 'ready' && item.status === 'ready') {
              alerts.push({ productName: item.product_name, tableName });
            }
          }
        }
        statusesRef.current = next;
        seededRef.current = true;
        alerts.forEach((alert) => raiseAlert(alert));
      } catch {
        // A failed poll is not worth surfacing; the next tick retries.
      }
    }

    void poll();
    const timer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);

    // Live push: the same alert, without waiting for the next poll.
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      const token = window.localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      try {
        socket = new WebSocket(`${scheme}://${window.location.host}/server-app?token=${encodeURIComponent(token)}`);
      } catch {
        return;
      }
      socket.onmessage = (message) => {
        let payload: {
          type?: string; item_id?: number; product_name?: string; table_id?: string; status?: string;
          table_name?: string; item_count?: number; appended?: boolean;
        };
        try {
          payload = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (payload.type === 'guest_order') {
          // Already scoped server-side to this user's tables; the local lookup
          // is only for a nicer display name.
          const table = tablesRef.current.find((row) => row.id === String(payload.table_id));
          chime();
          onGuestOrderRef.current?.({
            tableName: table?.name || table?.number || String(payload.table_name ?? payload.table_id ?? ''),
            itemCount: Number(payload.item_count ?? 0),
            appended: payload.appended === true,
          });
          return;
        }
        if (payload.type !== 'item_status' || typeof payload.item_id !== 'number') return;
        const previous = statusesRef.current.get(payload.item_id);
        statusesRef.current.set(payload.item_id, String(payload.status));
        if (payload.status !== 'ready' || previous === 'ready') return;
        const table = tablesRef.current.find((row) => row.id === String(payload.table_id));
        // The server already scoped this push to the tables this user covers; the
        // lookup is only for the display name.
        raiseAlert({
          productName: payload.product_name || '',
          tableName: table?.name || table?.number || String(payload.table_id ?? ''),
        });
      };
      socket.onclose = () => {
        socket = null;
        if (!cancelled) reconnect = setTimeout(connect, RECONNECT_DELAY_MS);
      };
      socket.onerror = () => { socket?.close(); };
    }

    connect();

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (reconnect) clearTimeout(reconnect);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [api, enabled]);

  useEffect(() => () => { void audioRef.current?.close(); }, []);
}
