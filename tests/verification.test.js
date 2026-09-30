import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calculateTotal, validateConstraints, ConstraintViolationError } from '../src/finance.js';

test('Gate A (Budget Integrity): calculateTotal multiplies unit costs by group size and room count', () => {
  const pkg = {
    flightUnitPrice: 400,
    accommodationPerRoom: 800,
    passUnitPrice: 300,
    gearUnitPrice: 150,
    groupSize: 2,
    roomCount: 1,
  };

  // (400 * 2) + (800 * 1) + (300 * 2) + (150 * 2) = 2500
  assert.equal(calculateTotal(pkg), 2500);
});

test('Gate B (Hard Constraint Enforcement): ski-in/ski-out requirement rejects a hotel without it', () => {
  const constraints = { requiresSkiInOut: true };
  const resort = { skiInSkiOutAvailable: true };
  const hotel = { hasSkiInOut: false };

  // The only acceptable outcomes: an explicit `false`, or a ConstraintViolationError
  // naming the violated constraint. Any other result or error fails the gate.
  let result;
  try {
    result = validateConstraints(constraints, resort, hotel);
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
