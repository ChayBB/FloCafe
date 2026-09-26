'use client';

import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  STATUS_CONFIG,
  STATUS_ORDER,
  normalizeKitchenStatus,
  type KitchenStatus,
} from '@/hooks/useKdsConnection';

export interface KdsStatusSwitchProps {
  status: KitchenStatus;
  updating: boolean;
  onAdvance: (next: Exclude<KitchenStatus, 'voided'>) => void;
}

export function nextKitchenStatus(status: KitchenStatus): Exclude<KitchenStatus, 'voided'> | null {
  const current = normalizeKitchenStatus(status);
  if (current === 'voided') return null;
  return STATUS_ORDER[STATUS_ORDER.indexOf(current) + 1] ?? null;
}

/** One-tap control that moves an item to the next kitchen stage. */
export function KdsStatusSwitch({ status, updating, onAdvance }: KdsStatusSwitchProps) {
  const t = useTranslations('kds');
  const current = normalizeKitchenStatus(status);
  const next = nextKitchenStatus(current);
  if (!next) return null;

  const label = t('markAs', { status: t(STATUS_CONFIG[next].labelKey) });

  return (
    <button
      type="button"
      data-testid="kds-status-switch"
      title={label}
      aria-label={label}
      disabled={updating}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onAdvance(next);
      }}
      className={`shrink-0 relative h-9 w-16 rounded-full border-2 ${STATUS_CONFIG[next].border} ${STATUS_CONFIG[current].bg} transition-all active:scale-95 hover:brightness-95 disabled:opacity-50`}
    >
      <span
        className={`absolute top-1/2 start-1 -translate-y-1/2 w-6 h-6 rounded-full ${STATUS_CONFIG[current].color} shadow transition-transform ${
          updating ? 'translate-x-4 rtl:-translate-x-4' : ''
        }`}
      />
      <ChevronRight
        size={16}
        className={`absolute top-1/2 end-2 -translate-y-1/2 rtl-flip ${STATUS_CONFIG[next].text}`}
      />
    </button>
  );
}
