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
