/** Spotting the moment a line becomes ready, from a board that is resent in full. */

export interface TrackedItem {
  id: number;
  product_name: string;
  status?: string;
}

export interface TrackedOrder {
  id: number;
  items?: TrackedItem[] | null;
  table?: { name: string } | null;
}

export interface ReadyTransition {
  itemId: number;
  productName: string;
  tableName: string;
}

const READY = 'ready';

/** Records the status every line currently holds. */
export function markStatuses(orders: TrackedOrder[], statuses: Map<number, string>): void {
  for (const order of orders) {
    for (const item of order.items || []) statuses.set(item.id, String(item.status ?? ''));
  }
}

/**
 * The lines that have just turned ready.
 *
 * The board arrives complete on every update, so "just turned ready" is only
 * visible by comparing against the previous status. A line already ready when
 * the screen connected is not news, and one that stays ready across updates must
 * not be announced again — the board is resent on every change anywhere on it.
 */
export function selectNewlyReady(
  orders: TrackedOrder[],
  statuses: Map<number, string>,
): ReadyTransition[] {
  const transitions: ReadyTransition[] = [];
  for (const order of orders) {
    for (const item of order.items || []) {
      if (String(item.status ?? '') !== READY) continue;
      const previous = statuses.get(item.id);
      // No previous status means the line appeared already ready, which is the
      // kitchen catching up rather than something happening now.
      if (previous === undefined || previous === READY) continue;
      transitions.push({
        itemId: item.id,
        productName: item.product_name,
        tableName: order.table?.name ? String(order.table.name) : '',
      });
    }
  }
  return transitions;
}
