// Deterministic finance and constraint logic.
//
// STUBS ONLY: these exist so the Verification Gates can import them. They are
// intentionally unimplemented, so the gates in tests/verification.test.js fail
// (red) until the real logic is written.

// Thrown when a candidate violates a hard user constraint.
export class ConstraintViolationError extends Error {
  constructor(constraint, message) {
    super(message);
    this.name = 'ConstraintViolationError';
    this.constraint = constraint;
  }
}

export function calculateTotal(_pkg) {
  throw new Error('Not implemented: calculateTotal');
}

export function validateConstraints(_constraints, _hotel) {
  throw new Error('Not implemented: validateConstraints');
}
