// Deterministic finance and constraint logic.
//
// All arithmetic lives here. Tools and LLM agents only supply base unit costs;
// this module does every multiplication and sum. Money is handled in integer
// cents internally so binary floating-point never leaks into a total.

// Thrown when a candidate violates a hard user constraint.
export class ConstraintViolationError extends Error {
  constructor(constraint, message) {
    super(message);
    this.name = 'ConstraintViolationError';
    this.constraint = constraint;
  }
}

// Converts a currency amount to integer cents. Rejects anything that is not a
// finite, non-negative amount with at most two decimal places: a sub-cent price
// would have to be silently rounded, and we never silently alter tool data.
export function toCents(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite, non-negative number (got ${value})`);
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) {
    throw new RangeError(`${name} must have at most two decimal places (got ${value})`);
  }
  return cents;
}

export function fromCents(cents) {
  return cents / 100;
}

export function assertPositiveInteger(name, value) {
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
  const flight = toCents('flightUnitPrice', flightUnitPrice);
  const accommodation = toCents('accommodationPerRoom', accommodationPerRoom);
  const pass = toCents('passUnitPrice', passUnitPrice);
  const gear = toCents('gearUnitPrice', gearUnitPrice);
  assertPositiveInteger('groupSize', groupSize);
  assertPositiveInteger('roomCount', roomCount);

  const totalCents =
    flight * groupSize + accommodation * roomCount + pass * groupSize + gear * groupSize;
  return fromCents(totalCents);
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
