'use client';

import type { AxiosInstance } from 'axios';
import { Banknote, CreditCard, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { toastApiError } from '@/lib/api-error';
import { createPaymentIdempotencyKey } from '@/lib/payment-idempotency';

interface Bill {
  id: number | string;
  total: number;
  balance: number;
  payment_status?: string;
}

interface OpenOrder {
  id: number;
  order_number: string;
}

interface TicketBill {
  order: OpenOrder;
  bill: Bill;
}

interface CustomPaymentMethod {
  id: number;
  name: string;
  is_active?: boolean;
}

export interface ServerPaymentSheetProps {
  api: AxiosInstance;
  tableId: string;
  tableName: string;
  formatMoney: (value: number | string) => string;
  onClose: () => void;
  onPaid: () => void;
}

/**
 * Settles every open ticket on the table at once. A table carrying a second, older
 * ticket never reads as free, so paying only the newest one strands the rest.
 * Split payments stay on the POS.
 */
export function ServerPaymentSheet({
  api, tableId, tableName, formatMoney, onClose, onPaid,
}: ServerPaymentSheetProps) {
  const t = useTranslations('serverApp');
  const tPos = useTranslations('pos');
  const tCommon = useTranslations('common');
  const apiErrorT = (key: string): string => key;

  const [tickets, setTickets] = useState<TicketBill[]>([]);
  const [methods, setMethods] = useState<CustomPaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  // One key per bill, reused across retries so a timed-out retry cannot double-charge.
  const idempotencyKeysRef = useRef<Map<string, string>>(new Map());

  const balanceDue = tickets.reduce((sum, ticket) => sum + (Number(ticket.bill.balance) || 0), 0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ordersRes, methodsRes] = await Promise.all([
          api.get('/api/orders', {
            params: { table_id: tableId, status: 'pending,preparing,ready', per_page: 50 },
          }),
          api.get('/api/payment-methods').catch(() => ({ data: { payment_methods: [] } })),
        ]);
        if (cancelled) return;
        const orders: OpenOrder[] = (ordersRes.data.orders || [])
          .map((order: { id: number; order_number: string }) => ({ id: order.id, order_number: order.order_number }));
        // Generated one at a time: each call recalculates totals for its own order.
        const loaded: TicketBill[] = [];
        for (const order of orders) {
          const { data } = await api.post('/api/bills/generate', { order_id: order.id });
          if (cancelled) return;
          loaded.push({ order, bill: data.bill });
        }
        setTickets(loaded);
        setMethods((methodsRes.data.payment_methods || []).filter((method: CustomPaymentMethod) => method.is_active !== false));
      } catch (error: unknown) {
        if (cancelled) return;
        toastApiError(error, t('billLoadFailed'), apiErrorT);
        onClose();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tableId]);

  async function pay(line: { method: string; payment_method_id?: number }) {
    if (tickets.length === 0 || paying) return;
    if (balanceDue <= 0) {
      toast.error(tPos('noBalance'));
      return;
    }
    setPaying(true);
    const settledBillIds = new Set<string>();
    try {
      for (const ticket of tickets) {
        const balance = Number(ticket.bill.balance) || 0;
        const billKey = String(ticket.bill.id);
        if (balance <= 0) {
          settledBillIds.add(billKey);
          continue;
        }
        const idempotencyKey = idempotencyKeysRef.current.get(billKey) || createPaymentIdempotencyKey();
        idempotencyKeysRef.current.set(billKey, idempotencyKey);
        const { data } = await api.post(
          `/api/bills/${ticket.bill.id}/payments`,
          { payments: [{ ...line, amount: balance }] },
          { headers: { 'Idempotency-Key': idempotencyKey } },
        );
        const updated = data?.bill as Bill | undefined;
        if (!updated || updated.payment_status !== 'paid') {
          // A partial settlement committed, so this bill's next attempt is a new request.
          idempotencyKeysRef.current.delete(billKey);
          setTickets((current) => current
            .filter((row) => !settledBillIds.has(String(row.bill.id)))
            .map((row) => String(row.bill.id) === billKey && updated ? { ...row, bill: updated } : row));
          toast.error(tPos('paymentIncomplete', { amount: formatMoney(Number(updated?.balance) || 0) }));
          return;
        }
        idempotencyKeysRef.current.delete(billKey);
        settledBillIds.add(billKey);
        // Backgrounded: an unreachable printer must not block closing the table.
        void api.post('/api/printers/print-bill', { orderId: ticket.order.id }).catch(() => {});
      }
      toast.success(tPos('paymentRecorded'));
      onPaid();
    } catch (error: unknown) {
      // Keep the unpaid remainder on screen so a retry only charges what is still owed.
      if (settledBillIds.size > 0) {
        setTickets((current) => current.filter((row) => !settledBillIds.has(String(row.bill.id))));
      }
      toastApiError(error, tPos('paymentFailed'), apiErrorT);
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[88vh] w-full max-w-sm flex-col rounded-t-2xl bg-card p-5 sm:rounded-2xl sm:p-6">
        <div className="mb-1 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">{tPos('payment')}</h2>
            <p className="truncate text-sm text-muted-foreground">{tableName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tCommon('close')}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-gray-400 hover:text-muted-foreground"
          >
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{tCommon('loading')}</p>
        ) : tickets.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('noOpenOrder')}</p>
        ) : (
          <>
            {/* Every open ticket on the table is listed so the total is never a surprise. */}
            <ul className="mt-3 space-y-1">
              {tickets.map((ticket) => (
                <li key={ticket.bill.id} className="flex items-center justify-between gap-2 text-sm">
                  <Ltr as="span" className="truncate text-muted-foreground">#{ticket.order.order_number}</Ltr>
                  <Ltr as="span" className="shrink-0 font-medium">{formatMoney(ticket.bill.balance)}</Ltr>
                </li>
              ))}
            </ul>

            <div className="my-4 flex items-baseline justify-between border-y border-border py-3">
              <span className="text-sm text-muted-foreground">{tPos('balanceDue')}</span>
              <span className="text-2xl font-bold"><Ltr>{formatMoney(balanceDue)}</Ltr></span>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto">
              <button
                type="button"
                disabled={paying}
                onClick={() => pay({ method: 'cash' })}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl border-2 border-border px-4 font-semibold disabled:opacity-50"
              >
                <Banknote size={20} className="text-emerald-600" />
                {tPos('methodCash')}
              </button>
              <button
                type="button"
                disabled={paying}
                onClick={() => pay({ method: 'card' })}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl border-2 border-border px-4 font-semibold disabled:opacity-50"
              >
                <CreditCard size={20} className="text-blue-600" />
                {tPos('methodCard')}
              </button>
              {methods.map((method) => (
                <button
                  key={method.id}
                  type="button"
                  disabled={paying}
                  onClick={() => pay({ method: 'custom', payment_method_id: method.id })}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl border-2 border-border px-4 font-semibold disabled:opacity-50"
                >
                  <CreditCard size={20} className="text-muted-foreground" />
                  {method.name}
                </button>
              ))}
            </div>

            {paying && <p className="pt-3 text-center text-sm text-muted-foreground">{tPos('processingPayment')}</p>}
          </>
        )}
      </div>
    </div>
  );
}
