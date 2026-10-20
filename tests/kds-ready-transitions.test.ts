/**
 * Spotting the moment a line turns ready, on a board that is resent in full.
 *
 * The kitchen screen receives the whole board on every change anywhere on it, so
 * "just turned ready" only exists as a difference against the previous payload.
 * Three ways to get that wrong, all pinned here: announcing lines that were
 * already ready when the screen connected, announcing the same line again on the
 * next unrelated update, and missing a transition because some other line moved
 * in the same payload.
 */
import assert from 'node:assert/strict';
import { markStatuses, selectNewlyReady } from '../frontend/src/lib/ready-transitions';

function board(...orders: [number, string, [number, string, string][]][]): {
  id: number;
  table: { name: string };
  items: { id: number; product_name: string; status: string }[];
}[] {
  return orders.map(([id, table, items]) => ({
    id,
    table: { name: table },
    items: items.map(([itemId, name, status]) => ({ id: itemId, product_name: name, status })),
  }));
}

function main() {
  console.log('KDS ready transitions');
  console.log('='.repeat(32));

  const statuses = new Map<number, string>();

  // A screen connecting to a board that already holds ready lines says nothing.
  const first = board([
    33,
    '9',
    [
      [148, 'ข้าวเกรียบ', 'ready'],
      [149, 'ต้มยำ', 'preparing'],
    ],
  ]);
  markStatuses(first, statuses);
  assert.deepEqual(
    selectNewlyReady(first, statuses),
    [],
    'lines already ready on connect are not news',
  );
  console.log('  ✓ an already-ready board is silent');

  // The cook taps ready: that is the announcement.
  const second = board([
    33,
    '9',
    [
      [148, 'ข้าวเกรียบ', 'ready'],
      [149, 'ต้มยำ', 'ready'],
    ],
  ]);
  const announced = selectNewlyReady(second, statuses);
  assert.equal(announced.length, 1, 'only the line that changed is announced');
  assert.deepEqual(
    announced[0],
    { itemId: 149, productName: 'ต้มยำ', tableName: '9' },
    'with the dish and the table the waiter needs',
  );
  console.log('  ✓ a line turning ready is announced, with its table');

  // The board is resent when anything else changes; the same line must stay quiet.
  markStatuses(second, statuses);
  const unrelated = board(
    [
      33,
      '9',
      [
        [148, 'ข้าวเกรียบ', 'ready'],
        [149, 'ต้มยำ', 'ready'],
        [150, 'ส้มตำ', 'pending'],
      ],
    ],
    [34, '4', [[160, 'ลาเต้', 'preparing']]],
  );
  assert.deepEqual(selectNewlyReady(unrelated, statuses), [], 'a resent board repeats nothing');
  console.log('  ✓ the same line is not announced twice');

  // Two lines crossing together are both reported.
  markStatuses(unrelated, statuses);
  const together = board(
    [
      33,
      '9',
      [
        [148, 'ข้าวเกรียบ', 'ready'],
        [149, 'ต้มยำ', 'ready'],
        [150, 'ส้มตำ', 'ready'],
      ],
    ],
    [34, '4', [[160, 'ลาเต้', 'ready']]],
  );
  const both = selectNewlyReady(together, statuses);
  assert.deepEqual(
    both.map((t) => t.itemId),
    [150, 160],
    'every line that crossed is reported, across orders',
  );
  console.log('  ✓ two lines crossing together are both announced');

  // Going back the other way is not a ready event.
  markStatuses(together, statuses);
  const reverted = board([33, '9', [[150, 'ส้มตำ', 'preparing']]]);
  assert.deepEqual(selectNewlyReady(reverted, statuses), [], 'leaving ready announces nothing');
  markStatuses(reverted, statuses);
  const again = board([33, '9', [[150, 'ส้มตำ', 'ready']]]);
  assert.equal(
    selectNewlyReady(again, statuses).length,
    1,
    'but returning to ready announces again',
  );
  console.log('  ✓ only the move into ready counts');

  // A line seen for the first time already ready is the board catching up, not a
  // tap: announcing those would read out everything after a reconnect.
  const unseenReady = board([35, '7', [[180, 'ผัดไทย', 'ready']]]);
  assert.deepEqual(
    selectNewlyReady(unseenReady, statuses),
    [],
    'a line first seen already ready is not announced',
  );
  console.log('  ✓ a line first seen already ready stays silent');

  // A line with no table still announces; the sentence just has no table in it.
  const noTable = [{ id: 40, items: [{ id: 170, product_name: 'ชาเย็น', status: 'ready' }] }];
  const fresh = new Map<number, string>([[170, 'preparing']]);
  assert.equal(
    selectNewlyReady(noTable, fresh)[0].tableName,
    '',
    'a missing table is empty, not a crash',
  );
  console.log('  ✓ a takeaway line without a table is handled');

  console.log('\nAll KDS ready transition assertions passed.');
}

main();
