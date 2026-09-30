import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RESORTS, getResort, getFlight, getAccommodations, getSkiPass, getGearRental } from '../src/tools/mocks.js';

const MONTH = /\b(January|February|March|April|December)\b/;

test('the Ground Truth covers at least 6 resorts with unique ids', () => {
  assert.ok(RESORTS.length >= 6);
  assert.equal(new Set(RESORTS.map((r) => r.id)).size, RESORTS.length);
});

for (const { id } of RESORTS) {
  test(`${id}: every tool returns complete, traceable data`, () => {
    const resort = getResort(id);
    assert.ok(resort.optimalSnowWeeks.length > 0, 'optimalSnowWeeks must not be empty');
    for (const week of resort.optimalSnowWeeks) assert.match(week, MONTH);

    const hotels = getAccommodations(id);
    assert.ok(hotels.length > 0, 'at least one hotel');
    for (const record of [getFlight(id), getSkiPass(id), getGearRental(id), ...hotels]) {
      assert.equal(record.source, 'mock');
      assert.equal(record.resortId, id);
      assert.equal(new URL(record.url).protocol, 'https:');
      const price = record.pricePerPerson ?? record.pricePerRoom;
      assert.ok(Number.isFinite(price) && price > 0, `positive price for ${record.id ?? id}`);
    }
    for (const hotel of hotels) {
      assert.ok(!hotel.hasSkiInOut || resort.skiInSkiOutAvailable, `${hotel.id} cannot be ski-in/ski-out in a resort without it`);
    }
  });
}

test('links follow the vendor search formats', () => {
  assert.match(getFlight('bansko').url, /^https:\/\/www\.google\.com\/travel\/flights\?q=Flights%20to%20SOF$/);
  assert.match(getAccommodations('val-thorens')[0].url, /^https:\/\/www\.booking\.com\/searchresults\.html\?ss=Val%20Thorens$/);
  assert.match(getSkiPass('ischgl').url, /^https:\/\/www\.google\.com\/search\?q=Ischgl%20ski%20pass$/);
  assert.match(getGearRental('mayrhofen').url, /^https:\/\/www\.google\.com\/search\?q=Mayrhofen%20ski%20rental$/);
});

test('an unknown resort is an error, never a guessed value', () => {
  for (const tool of [getResort, getFlight, getAccommodations, getSkiPass, getGearRental]) {
    assert.throws(() => tool('chamonix'), /chamonix/);
  }
});

test('callers cannot modify the Ground Truth through a returned record', () => {
  getResort('gudauri').optimalSnowWeeks.push('Midsummer');
  assert.ok(!getResort('gudauri').optimalSnowWeeks.includes('Midsummer'));
});
