/**
 * Tiny in-process bus for Server App push notifications.
 *
 * Keeps `main/routes` free of any dependency on the Server App HTTP module, which
 * would otherwise be a cycle: server-app imports routes, routes would import server-app.
 */

export interface OrderItemStatusEvent {
  itemId: number | string;
  productName: string;
  orderId: number | string;
  tableId: string | null;
  status: string;
}

type Listener = (event: OrderItemStatusEvent) => void;

const listeners = new Set<Listener>();

export function onOrderItemStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitOrderItemStatus(event: OrderItemStatusEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('[ServerApp] Item status listener failed:', error);
    }
  }
}

/**
 * A customer placed an order from their own phone.
 *
 * The existing KDS broadcast only says "orders changed", which is enough to
 * make a list refetch and useless for telling a waiter *what* happened. This
 * carries the table, so the Server App can say "T7 ordered" and the staff
 * covering that table can react without watching a screen.
 *
 * `appended` distinguishes a second round on an open ticket from a new one:
 * the first needs someone to notice, the second is routine.
 */
export interface GuestOrderEvent {
  orderId: number | string;
  orderNumber: string;
  tableId: string | null;
  tableName: string;
  itemCount: number;
  appended: boolean;
}

type GuestOrderListener = (event: GuestOrderEvent) => void;

const guestOrderListeners = new Set<GuestOrderListener>();

export function onGuestOrder(listener: GuestOrderListener): () => void {
  guestOrderListeners.add(listener);
  return () => { guestOrderListeners.delete(listener); };
}

export function emitGuestOrder(event: GuestOrderEvent): void {
  for (const listener of guestOrderListeners) {
    try {
      listener(event);
    } catch (error) {
      // A failed listener must never break the order that triggered it.
      console.error('[ServerApp] Guest order listener failed:', error);
    }
  }
}
