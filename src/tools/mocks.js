// Ground Truth mocks: the stand-in for the external tools/APIs the agents will call.
//
// All values here are FIXED, ILLUSTRATIVE MOCK DATA. They are not real prices or
// real resort statistics. Links point to example.com so they can never be
// mistaken for real booking pages. Every returned record carries `source: 'mock'`
// so tests can trace each price and URL back to this module.
//
// Prices are in EUR. Flight and ski pass prices are per person; accommodation
// is per room for the whole stay; gear is per person for the whole stay.
// nightlifeScore and crowdLevel are on a 1-10 scale (10 = liveliest / most crowded).

export const RESORTS = Object.freeze([
  Object.freeze({
    id: 'la-molina',
    name: 'La Molina',
    country: 'Spain',
    vibe: 'family',
    skiInSkiOutAvailable: false,
    skiKm: 70,
    nightlifeScore: 3,
    crowdLevel: 6,
  }),
  Object.freeze({
    id: 'gudauri',
    name: 'Gudauri',
    country: 'Georgia',
    vibe: 'young',
    skiInSkiOutAvailable: true,
    skiKm: 75,
    nightlifeScore: 6,
    crowdLevel: 3,
  }),
  Object.freeze({
    id: 'val-thorens',
    name: 'Val Thorens',
    country: 'France',
    vibe: 'young',
    skiInSkiOutAvailable: true,
    skiKm: 600,
    nightlifeScore: 9,
    crowdLevel: 8,
  }),
]);

const FLIGHTS = Object.freeze({
  'la-molina': { pricePerPerson: 180, url: 'https://example.com/mock/flights/la-molina' },
  gudauri: { pricePerPerson: 320, url: 'https://example.com/mock/flights/gudauri' },
  'val-thorens': { pricePerPerson: 250, url: 'https://example.com/mock/flights/val-thorens' },
});

const ACCOMMODATIONS = Object.freeze({
  'la-molina': [
    { id: 'lm-hotel-1', name: 'Mock La Molina Town Lodge', level: 6, hasSkiInOut: false, pricePerRoom: 700, url: 'https://example.com/mock/hotels/lm-hotel-1' },
  ],
  gudauri: [
    { id: 'gu-hotel-1', name: 'Mock Gudauri Slope Hotel', level: 7, hasSkiInOut: true, pricePerRoom: 650, url: 'https://example.com/mock/hotels/gu-hotel-1' },
    { id: 'gu-hotel-2', name: 'Mock Gudauri Village Guesthouse', level: 4, hasSkiInOut: false, pricePerRoom: 350, url: 'https://example.com/mock/hotels/gu-hotel-2' },
  ],
  'val-thorens': [
    { id: 'vt-hotel-1', name: 'Mock Val Thorens Piste-Side Chalet', level: 9, hasSkiInOut: true, pricePerRoom: 2400, url: 'https://example.com/mock/hotels/vt-hotel-1' },
    { id: 'vt-hotel-2', name: 'Mock Val Thorens Centre Apartments', level: 6, hasSkiInOut: false, pricePerRoom: 1300, url: 'https://example.com/mock/hotels/vt-hotel-2' },
  ],
});

const SKI_PASSES = Object.freeze({
  'la-molina': { pricePerPerson: 250, url: 'https://example.com/mock/passes/la-molina' },
  gudauri: { pricePerPerson: 150, url: 'https://example.com/mock/passes/gudauri' },
  'val-thorens': { pricePerPerson: 380, url: 'https://example.com/mock/passes/val-thorens' },
});

const GEAR_RENTALS = Object.freeze({
  'la-molina': { pricePerPerson: 120, url: 'https://example.com/mock/gear/la-molina' },
  gudauri: { pricePerPerson: 90, url: 'https://example.com/mock/gear/gudauri' },
  'val-thorens': { pricePerPerson: 200, url: 'https://example.com/mock/gear/val-thorens' },
});

// Unknown resorts are an error, never a guessed value (Zero Hallucination Policy).
function lookup(table, resortId, kind) {
  if (!Object.hasOwn(table, resortId)) {
    throw new Error(`No mock ${kind} data for resort "${resortId}"`);
  }
  return table[resortId];
}

export function getResort(resortId) {
  const resort = RESORTS.find((r) => r.id === resortId);
  if (!resort) throw new Error(`Unknown resort "${resortId}"`);
  return { ...resort, source: 'mock' };
}

export function getFlight(resortId) {
  return { resortId, ...lookup(FLIGHTS, resortId, 'flight'), source: 'mock' };
}

export function getAccommodations(resortId) {
  return lookup(ACCOMMODATIONS, resortId, 'accommodation').map((hotel) => ({
    resortId,
    ...hotel,
    source: 'mock',
  }));
}

export function getSkiPass(resortId) {
  return { resortId, ...lookup(SKI_PASSES, resortId, 'ski pass'), source: 'mock' };
}

export function getGearRental(resortId) {
  return { resortId, ...lookup(GEAR_RENTALS, resortId, 'gear rental'), source: 'mock' };
}
