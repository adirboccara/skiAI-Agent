import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { calculateTotal, validateConstraints, ConstraintViolationError } from '../src/finance.js';

const basePackage = Object.freeze({
  flightUnitPrice: 400,
  accommodationPerRoom: 800,
  passUnitPrice: 300,
  gearUnitPrice: 150,
  groupSize: 2,
  roomCount: 1,
});

// Asserts that `fn` throws a ConstraintViolationError for `constraint` whose
// message matches `messagePattern`.
function assertViolation(fn, constraint, messagePattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ConstraintViolationError, `expected ConstraintViolationError, got ${err?.name}`);
    assert.equal(err.constraint, constraint);
    assert.match(err.message, messagePattern);
    return true;
  });
}

test('Gate A (Budget Integrity): calculateTotal multiplies unit costs by group size and room count', () => {
  // (400 * 2) + (800 * 1) + (300 * 2) + (150 * 2) = 2500
  assert.equal(calculateTotal(basePackage), 2500);
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

describe('calculateTotal: arithmetic', () => {
  test('multiplies accommodation by roomCount independently of groupSize', () => {
    // (400 * 4) + (800 * 2) + (300 * 4) + (150 * 4) = 5000
    assert.equal(calculateTotal({ ...basePackage, groupSize: 4, roomCount: 2 }), 5000);
  });

  test('avoids floating-point drift (0.1 + 0.2 === 0.3)', () => {
    const pkg = { ...basePackage, flightUnitPrice: 0.1, passUnitPrice: 0.2, accommodationPerRoom: 0, gearUnitPrice: 0, groupSize: 1 };
    assert.equal(calculateTotal(pkg), 0.3);
  });

  test('sums cent-precision prices exactly', () => {
    // (19.99 * 3) + (1234.56 * 2) + (45.45 * 3) + (0.01 * 3) = 59.97 + 2469.12 + 136.35 + 0.03 = 2665.47
    const pkg = { flightUnitPrice: 19.99, accommodationPerRoom: 1234.56, passUnitPrice: 45.45, gearUnitPrice: 0.01, groupSize: 3, roomCount: 2 };
    assert.equal(calculateTotal(pkg), 2665.47);
  });

  test('accepts zero-cost items', () => {
    assert.equal(calculateTotal({ ...basePackage, gearUnitPrice: 0 }), 2200);
  });
});

describe('calculateTotal: rejects invalid input instead of guessing', () => {
  const priceFields = ['flightUnitPrice', 'accommodationPerRoom', 'passUnitPrice', 'gearUnitPrice'];

  for (const field of priceFields) {
    test(`missing ${field}`, () => {
      const { [field]: _omitted, ...pkg } = basePackage;
      assert.throws(() => calculateTotal(pkg), { name: 'TypeError', message: new RegExp(field) });
    });

    test(`negative ${field}`, () => {
      assert.throws(() => calculateTotal({ ...basePackage, [field]: -1 }), { name: 'TypeError', message: new RegExp(field) });
    });
  }

  test('price given as a string', () => {
    assert.throws(() => calculateTotal({ ...basePackage, flightUnitPrice: '400' }), TypeError);
  });

  test('NaN and Infinity prices', () => {
    assert.throws(() => calculateTotal({ ...basePackage, passUnitPrice: NaN }), TypeError);
    assert.throws(() => calculateTotal({ ...basePackage, passUnitPrice: Infinity }), TypeError);
  });

  test('sub-cent price is rejected, not silently rounded', () => {
    assert.throws(() => calculateTotal({ ...basePackage, gearUnitPrice: 10.005 }), RangeError);
  });

  for (const field of ['groupSize', 'roomCount']) {
    test(`${field} of 0, negative, fractional or missing`, () => {
      for (const value of [0, -1, 1.5, undefined]) {
        assert.throws(() => calculateTotal({ ...basePackage, [field]: value }), { name: 'TypeError', message: new RegExp(field) });
      }
    });
  }
});

describe('validateConstraints: ski-in/ski-out', () => {
  const requires = { requiresSkiInOut: true };

  test('passes when resort and hotel both offer ski-in/ski-out', () => {
    assert.equal(validateConstraints(requires, { skiInSkiOutAvailable: true }, { hasSkiInOut: true }), true);
  });

  test('passes when ski-in/ski-out is not required, even if unavailable', () => {
    assert.equal(validateConstraints({ requiresSkiInOut: false }, { skiInSkiOutAvailable: false }, { hasSkiInOut: false }), true);
    assert.equal(validateConstraints({}, { skiInSkiOutAvailable: false }, { hasSkiInOut: false }), true);
  });

  test('rejects when the resort lacks it, even if the hotel claims it', () => {
    assertViolation(
      () => validateConstraints(requires, { name: 'La Molina', skiInSkiOutAvailable: false }, { hasSkiInOut: true }),
      'requiresSkiInOut',
      /Resort "La Molina"/,
    );
  });

  test('rejects when the hotel lacks it, naming the hotel', () => {
    assertViolation(
      () => validateConstraints(requires, { skiInSkiOutAvailable: true }, { name: 'Mock Hotel', hasSkiInOut: false }),
      'requiresSkiInOut',
      /Hotel "Mock Hotel"/,
    );
  });

  test('treats a missing resort field as a violation', () => {
    assertViolation(() => validateConstraints(requires, {}, { hasSkiInOut: true }), 'requiresSkiInOut', /Resort/);
  });

  test('treats a missing hotel field as a violation', () => {
    assertViolation(() => validateConstraints(requires, { skiInSkiOutAvailable: true }, {}), 'requiresSkiInOut', /Hotel/);
  });

  test('treats missing resort or hotel data as a violation', () => {
    assertViolation(() => validateConstraints(requires, undefined, { hasSkiInOut: true }), 'requiresSkiInOut', /Resort/);
    assertViolation(() => validateConstraints(requires, { skiInSkiOutAvailable: true }, undefined), 'requiresSkiInOut', /Hotel/);
  });

  test('only strict true counts as available (truthy strings do not)', () => {
    assertViolation(() => validateConstraints(requires, { skiInSkiOutAvailable: 'yes' }, { hasSkiInOut: true }), 'requiresSkiInOut', /Resort/);
  });
});
