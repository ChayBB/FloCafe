'use client';

import type { AxiosInstance } from 'axios';
import { CreditCard, Plus, ShoppingBag, SquarePen, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { toastApiError } from '@/lib/api-error';
import { TableTurnoverBadge } from '@/components/tables/TableTurnoverBadge';

export interface ServerTable {
  id: string;
  name?: string;
  number?: string;
  status?: string;
  capacity?: number;
  seated_at?: string | null;
  activeOrder?: { id: number; order_number: string; status?: string; type?: string } | null;
  current_order?: { id: number; order_number: string; status?: string; type?: string } | null;
}

export function activeOrderOf(table: ServerTable) {
  return table.activeOrder || table.current_order || null;
}

interface ServerOrderItem {
  id: number;
  product_name: string;
  quantity: number;
  status: string;
  special_instructions?: string | null;
}

type ServerAppKey = keyof AppConfig['Messages']['serverApp'];

/** Item kitchen status to its serverApp label key and badge colours. */
const ITEM_STATUS: Record<string, { labelKey: ServerAppKey; classes: string }> = {
  pending: { labelKey: 'statusWaiting', classes: 'bg-gray-100 text-gray-600 dark:bg-muted dark:text-muted-foreground' },
  preparing: { labelKey: 'statusPreparing', classes: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300' },
  ready: { labelKey: 'statusReady', classes: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' },
  served: { labelKey: 'statusServed', classes: 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300' },
};

export interface ServerTablePickerProps {
  api: AxiosInstance;
  tables: ServerTable[];
  selectedTableId: string;
  onAddOrder: (table: ServerTable) => void;
  onPay: (table: ServerTable) => void;
  onOrderChanged: () => void;
  onClose: () => void;
}

/** Table grid with live status, then a per-table action sheet (add items / take payment). */
export function ServerTablePicker({ api, tables, selectedTableId, onAddOrder, onPay, onOrderChanged, onClose }: ServerTablePickerProps) {
  const t = useTranslations('serverApp');
  const tPos = useTranslations('pos');
  const tTables = useTranslations('tables');
  const tCommon = useTranslations('common');
  const tOrders = useTranslations('orders');
  const [actionTable, setActionTable] = useState<ServerTable | null>(null);
  const [loadedItems, setLoadedItems] = useState<{ tableId: string; items: ServerOrderItem[] } | null>(null);
  const [editItemId, setEditItemId] = useState<number | null>(null);
  const [busyItemId, setBusyItemId] = useState<number | null>(null);
  const [itemAction, setItemAction] = useState<'takeaway' | 'cancel' | null>(null);

  const order = actionTable ? activeOrderOf(actionTable) : null;
  const openTableId = order ? actionTable?.id ?? null : null;

  // Results are keyed by table so a stale list never shows under the next table opened.
  const items = loadedItems && loadedItems.tableId === openTableId ? loadedItems.items : null;

  // The table list carries the order header only, so pull its lines when a table is opened.
  useEffect(() => {
    if (!openTableId) return;
    let cancelled = false;
    api.get('/api/orders', {
      params: { table_id: openTableId, type: 'dine_in', status: 'pending,preparing,ready', per_page: 1 },
    })
      .then(({ data }) => {
        if (!cancelled) setLoadedItems({ tableId: openTableId, items: data.orders?.[0]?.items || [] });
      })
      .catch(() => {
        if (!cancelled) setLoadedItems({ tableId: openTableId, items: [] });
      });
    return () => { cancelled = true; };
  }, [api, openTableId]);

  function closeActionSheet() {
    setActionTable(null);
    setEditItemId(null);
  }

  function isTakeawayItem(item: ServerOrderItem): boolean {
    return (item.special_instructions || '').includes(tPos('takeawayItemNote'));
  }

  /** Keeps the visible lines in sync after a per-item write. */
  function applyOrderResponse(data: { order?: { items?: ServerOrderItem[]; status?: string } }): ServerOrderItem[] {
    const remaining = (data.order?.items || []).filter(
      (line: ServerOrderItem) => !['cancelled', 'voided', 'void_adjustment'].includes(line.status),
    );
    if (openTableId) setLoadedItems({ tableId: openTableId, items: remaining });
    onOrderChanged();
    return remaining;
  }

  async function markItemTakeaway(item: ServerOrderItem) {
    if (!order || busyItemId !== null || isTakeawayItem(item)) return;
    setBusyItemId(item.id);
    setItemAction('takeaway');
    try {
      const note = [tPos('takeawayItemNote'), item.special_instructions?.trim() || null]
        .filter(Boolean)
        .join(' · ');
      const { data } = await api.patch(`/api/orders/${order.id}/items/${item.id}/notes`, { special_instructions: note });
      toast.success(tOrders('orderConvertedTakeaway'));
      applyOrderResponse(data);
      setEditItemId(null);
    } catch (error: unknown) {
      toastApiError(error, tOrders('convertOrderFailed'), (key) => key);
    } finally {
      setBusyItemId(null);
      setItemAction(null);
    }
  }

  async function cancelItem(itemId: number) {
    if (!order || busyItemId !== null) return;
    setBusyItemId(itemId);
    setItemAction('cancel');
    try {
      const { data } = await api.patch(`/api/orders/${order.id}/items/${itemId}/cancel`, {});
      toast.success(tOrders('itemRemoved'));
      setEditItemId(null);
      const remaining = applyOrderResponse(data);
      // Cancelling the last line closes the whole ticket, so the sheet has nothing left to show.
      if (data.order?.status === 'cancelled' || remaining.length === 0) closeActionSheet();
    } catch (error: unknown) {
      toastApiError(error, tOrders('removeItemFailed'), (key) => key);
    } finally {
      setBusyItemId(null);
      setItemAction(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-2xl bg-card p-5 sm:rounded-2xl sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{tPos('selectTable')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={tCommon('close')}
            className="flex h-10 w-10 items-center justify-center rounded-full text-gray-400 hover:text-muted-foreground"
          >
            <X size={20} />
          </button>
        </div>

        {tables.length === 0 ? (
          <p className="py-10 text-center text-muted-foreground">{tPos('noTablesFound')}</p>
        ) : (
          <div className="-mx-1 flex-1 overflow-y-auto px-1">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {tables.map((table) => {
                const tableOrder = activeOrderOf(table);
                const occupied = !!tableOrder;
                const selected = table.id === selectedTableId;
                return (
                  <button
                    key={table.id}
                    type="button"
                    onClick={() => setActionTable(table)}
                    className={`relative min-h-28 rounded-xl border-2 p-3 text-center transition-colors ${
                      selected
                        ? 'border-brand bg-brand/10'
                        : occupied
                          ? 'border-orange-300 bg-orange-50 dark:border-orange-800/40 dark:bg-orange-950/40'
                          : 'border-border hover:border-brand/40'
                    }`}
                  >
                    <span className={`absolute -top-2 end-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white ${occupied ? 'bg-orange-500' : 'bg-emerald-600'}`}>
                      {occupied ? tPos('tableOccupied') : tTables('statusAvailable')}
                    </span>
                    <p className="font-bold text-foreground">{table.name || table.number}</p>
                    {typeof table.capacity === 'number' && (
                      <p className="text-xs text-muted-foreground">{tPos('tableSeats', { count: table.capacity })}</p>
                    )}
                    {tableOrder && (
                      <p className="mt-1 truncate text-xs font-medium text-orange-600 dark:text-orange-400">
                        <Ltr>#{tableOrder.order_number}</Ltr>
                      </p>
                    )}
                    {table.seated_at && <span className="mt-1 block"><TableTurnoverBadge seatedAt={table.seated_at} /></span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {actionTable && (
        <div
          className="absolute inset-0 z-10 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          onClick={closeActionSheet}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-sm flex-col rounded-t-2xl bg-card p-5 sm:rounded-2xl sm:p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between gap-3">
              <h3 className="text-lg font-bold">
                {t('tableLabel', { name: actionTable.name ?? String(actionTable.number) })}
              </h3>
              <button
                type="button"
                onClick={closeActionSheet}
                aria-label={tCommon('close')}
                className="flex h-10 w-10 items-center justify-center rounded-full text-gray-400 hover:text-muted-foreground"
              >
                <X size={20} />
              </button>
            </div>
            <p className="mb-3 text-sm text-muted-foreground">
              {order ? <Ltr as="span">#{order.order_number}</Ltr> : t('noOpenOrder')}
            </p>

            {order && (
              <div className="-mx-1 mb-4 flex-1 overflow-y-auto px-1">
                <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{t('kitchen')}</p>
                {items === null ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">{tCommon('loading')}</p>
                ) : items.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">{t('emptyDraft')}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {items.map((item) => {
                      const status = ITEM_STATUS[item.status] || ITEM_STATUS.pending;
                      return (
                        <li key={item.id} className="rounded-lg border border-border px-2 py-1.5">
                          <div className="flex items-center gap-2">
                            <span className="w-8 shrink-0 text-sm font-bold"><Ltr>{item.quantity}×</Ltr></span>
                            <span className="min-w-0 flex-1 truncate text-sm">{item.product_name}</span>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${status.classes}`}>
                              {t(status.labelKey)}
                            </span>
                            {/* Only a line the kitchen has not started is still editable here;
                                anything further along needs the POS approval-PIN flow. */}
                            {item.status === 'pending' && (
                              <button
                                type="button"
                                aria-label={tCommon('edit')}
                                onClick={() => setEditItemId((current) => current === item.id ? null : item.id)}
                                className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground"
                              >
                                {editItemId === item.id ? <X size={15} /> : <SquarePen size={15} />}
                              </button>
                            )}
                          </div>

                          {editItemId === item.id && (
                            <div className="mt-1.5 flex gap-2 border-t border-border pt-1.5">
                              <button
                                type="button"
                                disabled={busyItemId !== null || isTakeawayItem(item)}
                                onClick={() => markItemTakeaway(item)}
                                className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-semibold disabled:opacity-50"
                              >
                                <ShoppingBag size={14} />
                                {busyItemId === item.id && itemAction === 'takeaway' ? tOrders('converting') : tPos('orderTypeTakeaway')}
                              </button>
                              <button
                                type="button"
                                disabled={busyItemId !== null}
                                onClick={() => cancelItem(item.id)}
                                className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-red-300 text-xs font-semibold text-red-600 disabled:opacity-50 dark:border-red-900"
                              >
                                <XCircle size={14} />
                                {busyItemId === item.id && itemAction === 'cancel' ? tOrders('cancelling') : tCommon('cancel')}
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => { onAddOrder(actionTable); closeActionSheet(); }}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand font-semibold text-white"
              >
                <Plus size={18} />
                {t('addToOrder')}
              </button>
              <button
                type="button"
                disabled={!order}
                onClick={() => { onPay(actionTable); closeActionSheet(); }}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-border font-semibold text-foreground disabled:opacity-50"
              >
                <CreditCard size={18} />
                {tPos('payment')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
