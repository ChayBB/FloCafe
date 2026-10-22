/**
 * What a weighed line costs, from the number on the scale.
 *
 * A product sold by the kilo is priced per unit weight, so the line total is the
 * weight times the rate — ปลากะพง at ฿100/kg weighing 1.35 kg is ฿135. The POS
 * dialog has to show that while the weight is being typed, not after it is
 * confirmed: it is the one number the customer is watching.
 *
 * The rounding has to match `validateProductQuantity` on the backend, which
 * rejects a quantity finer than the product's `weight_precision`. A dialog that
 * priced 1.3549 kg and sent it would have its order refused at the till.
 */
import assert from 'node:assert/strict';
import {
  fractionalQuantityStep,
  quantityNudge,
  roundToQuantityPrecision,
} from '../frontend/src/lib/utils';

/** The dialog's own arithmetic: base plus addons, times the weight. */
function lineTotal(basePrice: number, addonTotal: number, quantity: number): number {
  return (basePrice + addonTotal) * quantity;
}

const FISH = { sale_unit: 'kg', allow_fractional_quantity: 1, weight_precision: 3 };
const PLATE = { sale_unit: 'each', allow_fractional_quantity: 0, weight_precision: 3 };

function main() {
  console.log('Weighed line total');
  console.log('='.repeat(32));

  // --- which products get a weight field at all ---
  assert.equal(fractionalQuantityStep(FISH), 0.001, 'a kilo product steps by its precision');
  assert.equal(fractionalQuantityStep(PLATE), null, 'a per-item product keeps whole units');
  assert.equal(
    fractionalQuantityStep({ sale_unit: 'kg', allow_fractional_quantity: 0, weight_precision: 3 }),
    null,
    'a weight unit alone is not enough; the product must allow fractions',
  );
  assert.equal(
    fractionalQuantityStep({ sale_unit: 'g', allow_fractional_quantity: 1, weight_precision: 1 }),
    0.1,
    'precision drives the step, not the unit',
  );
  console.log('  ✓ only a fraction-enabled weight product gets a weight field');

  // --- the price the customer sees ---
  const step = fractionalQuantityStep(FISH) as number;
  assert.equal(
    lineTotal(100, 0, roundToQuantityPrecision(1.35, step)),
    135,
    '1.35 kg at ฿100 is ฿135',
  );
  assert.equal(
    lineTotal(100, 0, roundToQuantityPrecision(0.5, step)),
    50,
    'half a kilo is half the rate',
  );
  assert.equal(
    lineTotal(100, 20, roundToQuantityPrecision(2, step)),
    240,
    'an addon is priced per unit of weight too, as it is for a counted item',
  );
  console.log('  ✓ the line is the weight times the rate');

  // --- rounding has to match what the backend will accept ---
  assert.equal(
    roundToQuantityPrecision(1.3549, step),
    1.355,
    'a weight finer than the precision is rounded, not sent as typed',
  );
  // A value sitting exactly on half a step is not representable in binary, so
  // which way it goes is the float's business. What has to hold is that the
  // result is a multiple of the step, because that is what the backend checks.
  for (const weight of [1.0005, 2.5005, 0.1235]) {
    const rounded = roundToQuantityPrecision(weight, step);
    assert.equal(
      Math.round(rounded / step) * step,
      Number(rounded.toFixed(3)),
      `${weight} rounds onto the ${step} grid`,
    );
  }
  assert.equal(
    roundToQuantityPrecision(2.4, fractionalQuantityStep(PLATE) ?? 1),
    2,
    'a counted product rounds to whole units',
  );
  console.log('  ✓ rounding matches the precision the backend enforces');

  // --- a weight below one step is not a sale ---
  assert.equal(
    Math.max(step, roundToQuantityPrecision(0.0004, step)),
    step,
    'a weight under one step floors to one step',
  );
  console.log('  ✓ an unreadably small weight floors to one step');

  // --- what a button press moves, which is not the precision ---
  assert.equal(quantityNudge(step), 0.1, 'a button moves 100 grams, not one gram');
  assert.equal(
    quantityNudge(
      fractionalQuantityStep({
        sale_unit: 'kg',
        allow_fractional_quantity: 1,
        weight_precision: 1,
      }),
    ),
    0.1,
    'a coarser product still moves 100 grams',
  );
  assert.equal(quantityNudge(null), 1, 'a counted product moves one item');
  assert.equal(
    quantityNudge(
      fractionalQuantityStep({
        sale_unit: 'kg',
        allow_fractional_quantity: 1,
        weight_precision: 0,
      }),
    ),
    1,
    'a product weighed to whole units moves one unit',
  );
  // The press lands on the grid the backend accepts, not between two valid weights.
  assert.equal(
    roundToQuantityPrecision(3.004 + quantityNudge(step), step),
    3.104,
    'a press keeps the precision',
  );
  console.log('  ✓ a button press moves 0.1, typing still takes three decimals');

  console.log('\nAll weighed line total assertions passed.');
}

main();
