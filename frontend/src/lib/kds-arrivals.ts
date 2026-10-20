/** What the kitchen screen announces, and what it has already announced. */

export interface AnnouncedItem {
  id: number;
  product_name: string;
  quantity: number;
}

export interface AnnouncedOrder {
  id: number;
  items?: AnnouncedItem[] | null;
  table?: { name: string } | null;
}

/** Records every line on these orders as already announced. */
export function markSeen(orders: AnnouncedOrder[], seen: Set<number>): void {
  for (const order of orders) {
    for (const item of order.items || []) seen.add(item.id);
  }
}

/**
 * The lines that are new since the last board, grouped by the order they belong to.
 *
 * Tracked per item rather than per order. A waiter adding to an open ticket is new
 * work for the kitchen, but the order has been seen already, so keying on the order
 * id left every append silent — which is the normal way a dine-in ticket grows.
 *
 * Each returned order carries only its new lines: the rest have been on the board
 * for a while and are not what changed.
 */
export function selectArrivals(orders: AnnouncedOrder[], seen: Set<number>): AnnouncedOrder[] {
  const arrived: AnnouncedOrder[] = [];
  for (const order of orders) {
    const items = (order.items || []).filter((item) => !seen.has(item.id));
    if (items.length > 0) arrived.push({ ...order, items });
  }
  return arrived;
}
