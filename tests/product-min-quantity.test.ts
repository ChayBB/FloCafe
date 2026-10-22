/**
 * A product's minimum sale quantity, enforced where it has to be.
 *
 * A fishmonger pricing by the kilo will not weigh out 20 grams, so a product
 * carries a floor. The dialog opens at that floor and will not go below it, but
 * the dialog is one of several ways an order reaches the backend — a held order,
 * a guest order and an edit all land in `validateProductQuantity`, so the floor
 * is enforced there too.
 *
 * Zero means no floor. Every product that existed before this column did gets
 * zero, because applying a minimum retroactively would start rejecting orders a
 * till already takes.
 */
import assert from 'node:assert/strict';
import { validateProductQuantity } from '../main/routes/orders-validation';
import {
  fractionalQuantityStep,
  maximumQuantity,
  minimumQuantity,
} from '../frontend/src/lib/utils';

const FISH = {
  name: 'ปลากะพง',
  sale_unit: 'kg',
  allow_fractional_quantity: 1,
  weight_precision: 3,
  min_quantity: 0.5,
};
const PLATE = { name: 'จานเปล่า', sale_unit: 'each', weight_precision: 3, min_quantity: 0 };

function rejects(product: Record<string, unknown>, quantity: unknown, why: string): void {
  assert.throws(
    () => validateProductQuantity(product as never, quantity),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 400, 'a rejected quantity is a bad request');
      return true;
    },
    why,
  );
}

function main() {
  console.log('Product minimum quantity');
  console.log('='.repeat(32));

  // --- the backend is the authority ---
  validateProductQuantity(FISH as never, 0.5);
  validateProductQuantity(FISH as never, 1.35);
  console.log('  ✓ a weight at or above the floor is accepted');

  rejects(FISH, 0.4, 'below the floor is refused');
  rejects(FISH, 0.001, 'one gram of fish is refused');
  console.log('  ✓ a weight below the floor is refused');

  // Floating point must not refuse a weight that is exactly the minimum.
  validateProductQuantity({ ...FISH, min_quantity: 0.1 } as never, 0.3 - 0.2 + 0.0 + 0.1);
  console.log('  ✓ a weight equal to the floor is not lost to float error');

  // --- no floor means no change ---
  validateProductQuantity(PLATE as never, 1);
  validateProductQuantity({ ...PLATE, min_quantity: undefined } as never, 1);
  validateProductQuantity({ ...PLATE, min_quantity: null } as never, 1);
  console.log('  ✓ a product with no floor is unaffected');

  // The other rules still apply underneath the new one.
  rejects(FISH, 0, 'zero is still not a quantity');
  rejects(FISH, -1, 'negative is still not a quantity');
  rejects({ ...FISH, min_quantity: 0 }, 1.3549, 'precision is still enforced');
  rejects({ ...PLATE, min_quantity: 0 }, 1.5, 'a counted product still takes whole units');
  console.log('  ✓ the existing quantity rules are unchanged');

  // --- what the dialog opens at ---
  const step = fractionalQuantityStep(FISH) as number;
  assert.equal(minimumQuantity(FISH, step), 0.5, 'the dialog floor is the configured minimum');
  assert.equal(
    minimumQuantity({ min_quantity: 0 }, step),
    step,
    'with no minimum the floor is one step',
  );
  assert.equal(
    minimumQuantity({ min_quantity: null }, null),
    1,
    'a counted product falls back to one whole item',
  );
  assert.equal(
    minimumQuantity({ min_quantity: 0.0001 }, step),
    step,
    'a minimum finer than the precision cannot be entered, so the step wins',
  );
  console.log('  ✓ the dialog opens at the floor the backend enforces');

  // --- the ceiling, the other end of the same decision ---
  const CAPPED = { ...FISH, min_quantity: 0.1, max_quantity: 10 };
  validateProductQuantity(CAPPED as never, 10);
  validateProductQuantity(CAPPED as never, 9.999);
  rejects(CAPPED, 10.001, 'a weight above the cap is refused');
  rejects(CAPPED, 50, 'a misread scale is refused');
  rejects(CAPPED, 0.05, 'the floor still applies under a cap');
  console.log('  ✓ a weight above the cap is refused');

  // Floating point must not refuse a weight that is exactly the cap.
  validateProductQuantity({ ...FISH, min_quantity: 0, max_quantity: 0.3 } as never, 0.1 + 0.2);
  console.log('  ✓ a weight equal to the cap is not lost to float error');

  validateProductQuantity({ ...FISH, max_quantity: 0 } as never, 500);
  validateProductQuantity({ ...FISH, max_quantity: null } as never, 500);
  console.log('  ✓ a product with no cap is unaffected');

  assert.equal(maximumQuantity({ max_quantity: 10 }), 10, 'a configured cap is reported');
  assert.equal(maximumQuantity({ max_quantity: 0 }), null, 'zero means no cap');
  assert.equal(maximumQuantity({ max_quantity: null }), null, 'unset means no cap');
  assert.equal(maximumQuantity({}), null, 'absent means no cap');
  console.log('  ✓ the dialog cap matches the backend cap');

  console.log('\nAll product quantity bound assertions passed.');
}

main();
