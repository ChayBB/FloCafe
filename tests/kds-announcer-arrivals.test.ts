/**
 * A line added to an open ticket is announced; the rest of the board is not.
 *
 * The announcer used to track which *orders* it had seen. A dine-in ticket grows
 * by appending to an order that is already on the board, so its id was always
 * already known and every append arrived in silence — the kitchen got new work
 * with no chime and no voice. Tracking lines instead fixes that, and must not
 * reintroduce the thing the order-level check was protecting: a reconnect must
 * not read the whole board aloud.
 */
import assert from 'node:assert/strict';
import { markSeen, selectArrivals } from '../frontend/src/lib/kds-arrivals';

type Order = {
  id: number;
  items?: { id: number; product_name: string; quantity: number }[] | null;
};

function order(id: number, items: [number, string][]): Order {
  return {
    id,
    items: items.map(([itemId, name]) => ({ id: itemId, product_name: name, quantity: 1 })),
  };
}

function names(orders: Order[]): string[] {
  return orders.flatMap((o) => (o.items || []).map((i) => i.product_name));
}

function main() {
  console.log('KDS announcer arrivals');
  console.log('='.repeat(32));

  // A fresh board is seeded silently; nothing on it is news.
  const seen = new Set<number>();
  const board = [order(33, [[151, 'Japanese Macha']]), order(34, [[148, 'ต้มแซ่บ']])];
  markSeen(board, seen);
  assert.deepEqual(selectArrivals(board, seen), [], 'the seeded board announces nothing');
  console.log('  ✓ seeded board announces nothing');

  // The case from the field: a waiter appends to an order already on the board.
  const appended = [
    order(33, [
      [151, 'Japanese Macha'],
      [152, 'ICE Amerigano'],
    ]),
    order(34, [[148, 'ต้มแซ่บ']]),
  ];
  const arrived = selectArrivals(appended, seen);
  assert.equal(arrived.length, 1, 'only the order that gained a line is announced');
  assert.equal(arrived[0].id, 33, 'and it is the order that gained it');
  assert.deepEqual(
    names(arrived),
    ['ICE Amerigano'],
    'only the new line is read out, not the ones already on the board',
  );
  console.log('  ✓ an appended line is announced, alone');

  markSeen(arrived, seen);
  assert.deepEqual(selectArrivals(appended, seen), [], 'the same board does not announce twice');
  console.log('  ✓ the same line is not announced twice');

  // A brand-new ticket still announces all of its lines.
  const withNewOrder = [
    ...appended,
    order(40, [
      [160, 'ข้าวเกรียบ'],
      [161, 'ต้มยำ'],
    ]),
  ];
  const newTicket = selectArrivals(withNewOrder, seen);
  assert.equal(newTicket.length, 1, 'a new order is announced');
  assert.deepEqual(names(newTicket), ['ข้าวเกรียบ', 'ต้มยำ'], 'with every line it arrived with');
  console.log('  ✓ a new ticket announces all of its lines');

  // Two orders changing in one payload are both reported, in board order.
  markSeen(newTicket, seen);
  const both = [
    order(33, [
      [151, 'Japanese Macha'],
      [152, 'ICE Amerigano'],
      [170, 'ลาเต้'],
    ]),
    order(34, [
      [148, 'ต้มแซ่บ'],
      [171, 'ส้มตำ'],
    ]),
  ];
  const twoAtOnce = selectArrivals(both, seen);
  assert.deepEqual(
    twoAtOnce.map((o) => o.id),
    [33, 34],
    'both changed orders are returned, in board order',
  );
  assert.deepEqual(names(twoAtOnce), ['ลาเต้', 'ส้มตำ'], 'each contributing only its new line');
  console.log('  ✓ two orders changing together are both announced');

  // An order with no items at all must not produce an empty announcement.
  assert.deepEqual(
    selectArrivals([{ id: 50 }, { id: 51, items: null }], seen),
    [],
    'an order with no lines announces nothing',
  );
  console.log('  ✓ an order with no lines announces nothing');

  console.log('\nAll KDS announcer arrival assertions passed.');
}

main();
