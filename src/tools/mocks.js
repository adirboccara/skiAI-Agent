// Ground Truth mocks: the stand-in for the external tools/APIs the agents will call.
//
// All prices and resort statistics here are FIXED, ILLUSTRATIVE MOCK DATA, not
// real offers. Links are real vendor SEARCH pages for the resort (they open and
// work), not links to a specific offer: the vendor shows live prices, which will
// differ from these mock prices. Every returned record carries `source: 'mock'`
// so tests can trace each price and URL back to this module.
//
// Prices are in EUR. Flight and ski pass prices are per person; accommodation
// is per room for the whole stay; gear is per person for the whole stay.
// nightlifeScore and crowdLevel are on a 1-10 scale (10 = liveliest / most crowded).
// optimalSnowWeeks lists the periods with the best expected snow, in season order.

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
    optimalSnowWeeks: Object.freeze(['Late January', 'Early February', 'Mid February', 'Early March']),
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
    optimalSnowWeeks: Object.freeze(['Mid January', 'Early February', 'Late February', 'Early March', 'Mid March', 'Late March', 'Early April']),
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
    optimalSnowWeeks: Object.freeze(['Mid January', 'Late January', 'Mid February', 'Early March', 'Mid March', 'Late March', 'Early April', 'Mid April']),
  }),
  Object.freeze({
    id: 'bansko',
    name: 'Bansko',
    country: 'Bulgaria',
    vibe: 'young',
    skiInSkiOutAvailable: false,
    skiKm: 75,
    nightlifeScore: 7,
    crowdLevel: 7,
    optimalSnowWeeks: Object.freeze(['Mid January', 'Late January', 'Early February', 'Early March']),
  }),
  Object.freeze({
    id: 'mayrhofen',
    name: 'Mayrhofen',
    country: 'Austria',
    vibe: 'young',
    skiInSkiOutAvailable: true,
    skiKm: 136,
    nightlifeScore: 9,
    crowdLevel: 7,
    optimalSnowWeeks: Object.freeze(['Late January', 'Early February', 'Mid March', 'Late March']),
  }),
  Object.freeze({
    id: 'ischgl',
    name: 'Ischgl',
    country: 'Austria',
    vibe: 'young',
    skiInSkiOutAvailable: true,
    skiKm: 239,
    nightlifeScore: 10,
    crowdLevel: 9,
    optimalSnowWeeks: Object.freeze(['Late January', 'Early February', 'Late February', 'Early March', 'Mid March', 'Early April']),
  }),
]);

// Vendor search links, built from the resort's name and nearest airport.
const flightSearchUrl = (airport) =>
  `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights to ${airport}`)}`;
const hotelSearchUrl = (resortName) =>
  `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(resortName)}`;
const webSearchUrl = (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`;

const FLIGHTS = Object.freeze({
  'la-molina': { airport: 'BCN', pricePerPerson: 180 },
  gudauri: { airport: 'TBS', pricePerPerson: 320 },
  'val-thorens': { airport: 'GVA', pricePerPerson: 250 },
  bansko: { airport: 'SOF', pricePerPerson: 150 },
  mayrhofen: { airport: 'INN', pricePerPerson: 220 },
  ischgl: { airport: 'INN', pricePerPerson: 230 },
});

const ACCOMMODATIONS = Object.freeze({
  'la-molina': [
    { id: 'lm-hotel-1', name: 'Mock La Molina Town Lodge', level: 6, hasSkiInOut: false, pricePerRoom: 700 },
  ],
  gudauri: [
    { id: 'gu-hotel-1', name: 'Mock Gudauri Slope Hotel', level: 7, hasSkiInOut: true, pricePerRoom: 650 },
    { id: 'gu-hotel-2', name: 'Mock Gudauri Village Guesthouse', level: 4, hasSkiInOut: false, pricePerRoom: 350 },
  ],
  'val-thorens': [
    { id: 'vt-hotel-1', name: 'Mock Val Thorens Piste-Side Chalet', level: 9, hasSkiInOut: true, pricePerRoom: 2400 },
    { id: 'vt-hotel-2', name: 'Mock Val Thorens Centre Apartments', level: 6, hasSkiInOut: false, pricePerRoom: 1300 },
  ],
  bansko: [
    { id: 'ba-hotel-1', name: 'Mock Bansko Gondola Hotel', level: 6, hasSkiInOut: false, pricePerRoom: 480 },
    { id: 'ba-hotel-2', name: 'Mock Bansko Old Town Apartments', level: 4, hasSkiInOut: false, pricePerRoom: 300 },
  ],
  mayrhofen: [
    { id: 'ma-hotel-1', name: 'Mock Mayrhofen Penken Lodge', level: 8, hasSkiInOut: true, pricePerRoom: 1900 },
    { id: 'ma-hotel-2', name: 'Mock Mayrhofen Village Pension', level: 5, hasSkiInOut: false, pricePerRoom: 800 },
  ],
  ischgl: [
    { id: 'is-hotel-1', name: 'Mock Ischgl Silvretta Chalet', level: 9, hasSkiInOut: true, pricePerRoom: 2800 },
    { id: 'is-hotel-2', name: 'Mock Ischgl Village Guesthouse', level: 5, hasSkiInOut: false, pricePerRoom: 1100 },
  ],
});

const SKI_PASSES = Object.freeze({
  'la-molina': { pricePerPerson: 250 },
  gudauri: { pricePerPerson: 150 },
  'val-thorens': { pricePerPerson: 380 },
  bansko: { pricePerPerson: 220 },
  mayrhofen: { pricePerPerson: 330 },
  ischgl: { pricePerPerson: 400 },
});

const GEAR_RENTALS = Object.freeze({
  'la-molina': { pricePerPerson: 120 },
  gudauri: { pricePerPerson: 90 },
  'val-thorens': { pricePerPerson: 200 },
  bansko: { pricePerPerson: 70 },
  mayrhofen: { pricePerPerson: 160 },
  ischgl: { pricePerPerson: 190 },
});

// Unknown resorts are an error, never a guessed value (Zero Hallucination Policy).
function lookup(table, resortId, kind) {
  if (!Object.hasOwn(table, resortId)) {
    throw new Error(`No mock ${kind} data for resort "${resortId}"`);
  }
  return table[resortId];
}

function findResort(resortId) {
  const resort = RESORTS.find((r) => r.id === resortId);
  if (!resort) throw new Error(`Unknown resort "${resortId}"`);
  return resort;
}

export function getResort(resortId) {
  const resort = findResort(resortId);
  return { ...resort, optimalSnowWeeks: [...resort.optimalSnowWeeks], source: 'mock' };
}

export function getFlight(resortId) {
  const flight = lookup(FLIGHTS, resortId, 'flight');
  return { resortId, ...flight, url: flightSearchUrl(flight.airport), source: 'mock' };
}

export function getAccommodations(resortId) {
  const { name } = findResort(resortId);
  return lookup(ACCOMMODATIONS, resortId, 'accommodation').map((hotel) => ({
    resortId,
    ...hotel,
    url: hotelSearchUrl(name),
    source: 'mock',
  }));
}

export function getSkiPass(resortId) {
  const { name } = findResort(resortId);
  return { resortId, ...lookup(SKI_PASSES, resortId, 'ski pass'), url: webSearchUrl(`${name} ski pass`), source: 'mock' };
}

export function getGearRental(resortId) {
  const { name } = findResort(resortId);
  return { resortId, ...lookup(GEAR_RENTALS, resortId, 'gear rental'), url: webSearchUrl(`${name} ski rental`), source: 'mock' };
}
