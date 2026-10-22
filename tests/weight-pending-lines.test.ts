/**
 * Lines sent to the kitchen before anyone weighed them.
 *
 * The waiter takes the order in the dining room; the scale is at the till. So a
 * fish goes to the kitchen with no weight, and the cashier has to be told which
 * lines are still unpriced — the order list turns orange for exactly these.
 *
 * A flag rather than a sentinel quantity, because one kilogram is a real weight
 * and any number chosen to mean "not yet" would be wrong the day someone sells
 * precisely that much.
 */
import assert from 'node:assert/strict';
import { weightPendingItems } from '../frontend/src/lib/utils';

type Line = { id: number; status?: string | null; weight_pending?: boolean | number | null };

function main() {
  console.log('Weight-pending lines');
  console.log('='.repeat(32));

  // SQLite stores the flag as 0/1; the API may hand it back either way.
  assert.deepEqual(
    weightPendingItems([{ id: 1, weight_pending: 1, status: 'pending' }]).map((l) => l.id),
    [1],
    'an integer 1 from SQLite counts',
  );
  assert.deepEqual(
    weightPendingItems([{ id: 2, weight_pending: true, status: 'pending' }]).map((l) => l.id),
    [2],
    'a JSON boolean counts too',
  );
  console.log('  ✓ the flag is read in either form');

  const mixed: Line[] = [
    { id: 10, weight_pending: 0, status: 'pending' },
    { id: 11, weight_pending: 1, status: 'preparing' },
    { id: 12, status: 'ready' },
    { id: 13, weight_pending: null, status: 'ready' },
  ];
  assert.deepEqual(
    weightPendingItems(mixed).map((l) => l.id),
    [11],
    'only a line actually awaiting a weight is reported',
  );
  console.log('  ✓ lines already weighed are left alone');

  // A cancelled fish is not owed a weight, and must not keep the order orange.
  const withDead: Line[] = [
    { id: 20, weight_pending: 1, status: 'cancelled' },
    { id: 21, weight_pending: 1, status: 'voided' },
    { id: 22, weight_pending: 1, status: 'void_adjustment' },
    { id: 23, weight_pending: 1, status: 'refunded' },
  ];
  assert.deepEqual(weightPendingItems(withDead), [], 'a dead line is not owed a weight');
  assert.deepEqual(
    weightPendingItems([...withDead, { id: 24, weight_pending: 1, status: 'pending' }]).map(
      (l) => l.id,
    ),
    [24],
    'but a live one beside it still is',
  );
  console.log('  ✓ cancelled and voided lines do not hold the order orange');

  assert.deepEqual(weightPendingItems([]), [], 'an empty order reports nothing');
  assert.deepEqual(weightPendingItems(null), [], 'a missing item list is not a crash');
  assert.deepEqual(weightPendingItems(undefined), [], 'nor is an absent one');
  console.log('  ✓ an order with no lines is handled');

  console.log('\nAll weight-pending assertions passed.');
}

main();
