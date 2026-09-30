import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calculateTotal, validateConstraints, ConstraintViolationError } from '../src/finance.js';

test('Gate A (Budget Integrity): calculateTotal sums tool-provided costs exactly', () => {
  const pkg = { flight: 400, hotel: 800, pass: 300, gear: 150 };

  assert.equal(calculateTotal(pkg), 1650);
});

test('Gate B (Hard Constraint Enforcement): ski-in/ski-out requirement rejects a hotel without it', () => {
  const constraints = { requiresSkiInOut: true };
  const hotel = { hasSkiInOut: false };

  // The only acceptable outcomes: an explicit `false`, or a ConstraintViolationError
  // naming the violated constraint. Any other result or error fails the gate.
  let result;
  try {
    result = validateConstraints(constraints, hotel);
  } catch (err) {
    assert.ok(
      err instanceof ConstraintViolationError,
      `expected ConstraintViolationError, got ${err?.name}: ${err?.message}`,
    );
    assert.equal(err.constraint, 'requiresSkiInOut');
    return;
  }
  assert.equal(result, false);
});
