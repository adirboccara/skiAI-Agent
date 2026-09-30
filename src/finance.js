// Deterministic finance and constraint logic.
//
// All arithmetic lives here. Tools and LLM agents only supply base unit costs;
// this module does every multiplication and sum.

// Thrown when a candidate violates a hard user constraint.
export class ConstraintViolationError extends Error {
  constructor(constraint, message) {
    super(message);
    this.name = 'ConstraintViolationError';
    this.constraint = constraint;
  }
}

function assertNonNegativePrice(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite, non-negative number (got ${value})`);
  }
}

function assertPositiveInteger(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer (got ${value})`);
  }
}

// Total package cost:
//   flight, ski pass and gear are priced per person -> x groupSize
//   accommodation is priced per room for the whole stay -> x roomCount
export function calculateTotal({
  flightUnitPrice,
  accommodationPerRoom,
  passUnitPrice,
  gearUnitPrice,
  groupSize,
  roomCount,
}) {
  assertNonNegativePrice('flightUnitPrice', flightUnitPrice);
  assertNonNegativePrice('accommodationPerRoom', accommodationPerRoom);
  assertNonNegativePrice('passUnitPrice', passUnitPrice);
  assertNonNegativePrice('gearUnitPrice', gearUnitPrice);
  assertPositiveInteger('groupSize', groupSize);
  assertPositiveInteger('roomCount', roomCount);

  return (
    flightUnitPrice * groupSize +
    accommodationPerRoom * roomCount +
    passUnitPrice * groupSize +
    gearUnitPrice * groupSize
  );
}

// Enforces hard constraints. Returns true when all are satisfied; throws
// ConstraintViolationError naming the first violated constraint otherwise.
// Missing data is treated as a violation, never assumed to be satisfied.
export function validateConstraints(userConstraints, resortData, hotelData) {
  if (userConstraints.requiresSkiInOut === true) {
    if (resortData?.skiInSkiOutAvailable !== true) {
      throw new ConstraintViolationError(
        'requiresSkiInOut',
        `Resort "${resortData?.name ?? resortData?.id ?? 'unknown'}" does not offer ski-in/ski-out`,
      );
    }
    if (hotelData?.hasSkiInOut !== true) {
      throw new ConstraintViolationError(
        'requiresSkiInOut',
        `Hotel "${hotelData?.name ?? hotelData?.id ?? 'unknown'}" is not ski-in/ski-out`,
      );
    }
  }
  return true;
}
