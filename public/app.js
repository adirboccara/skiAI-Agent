// Frontend for POST /api/plan. It only displays what the server returns: no
// prices are computed here, and model-written text is inserted as plain text.

const form = document.getElementById('plan-form');
const submitButton = document.getElementById('submit');
const formError = document.getElementById('form-error');

const states = {
  empty: document.getElementById('state-empty'),
  loading: document.getElementById('state-loading'),
  error: document.getElementById('state-error'),
  result: document.getElementById('state-result'),
};

const euros = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });

const FAILURE_LABELS = {
  budget: 'Over budget',
  constraint: 'Fails a must-have',
  invalid_agent_output: 'Agent reply unusable',
};

function show(name) {
  for (const [key, el] of Object.entries(states)) el.hidden = key !== name;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Only http(s) links from the tools are rendered as links.
function safeLink(url, label) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const a = el('a', 'items__link', label);
    a.href = parsed.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  } catch {
    return null;
  }
}

// Keep the slider readouts in sync.
for (const output of form.querySelectorAll('output[data-for]')) {
  const input = form.elements[output.dataset.for];
  input.addEventListener('input', () => { output.textContent = input.value; });
}

function readForm() {
  const data = new FormData(form);
  return {
    maxBudget: Number(data.get('maxBudget')),
    groupSize: Number(data.get('groupSize')),
    roomCount: Number(data.get('roomCount')),
    requiresSkiInOut: form.elements.requiresSkiInOut.checked,
    vibe: data.get('vibe'),
    nightlifeImportance: Number(data.get('nightlifeImportance')),
    skiKmImportance: Number(data.get('skiKmImportance')),
    crowdTolerance: Number(data.get('crowdTolerance')),
    accommodationLevel: Number(data.get('accommodationLevel')),
  };
}

// Quick checks for obvious mistakes; the server validates everything again.
function checkForm(request) {
  if (!(request.maxBudget > 0)) return 'Enter a budget above €0.';
  if (!Number.isInteger(request.groupSize) || request.groupSize < 1) return 'Enter at least 1 person.';
  if (!Number.isInteger(request.roomCount) || request.roomCount < 1) return 'Enter at least 1 room.';
  if (request.roomCount > request.groupSize) return 'You need at least as many people as rooms.';
  return null;
}

function renderRun(result) {
  const run = document.getElementById('run');
  run.replaceChildren();
  const failures = result.status === 'success' ? result.previousFailures : result.bottlenecks;

  for (const failure of failures) {
    const stop = el('li', 'stop stop--rejected');
    stop.append(
      el('span', 'stop__marker', '×'),
      el('span', 'stop__round', `Round ${failure.round}`),
      el('span', 'stop__label', FAILURE_LABELS[failure.type] ?? 'Rejected'),
      el('p', 'stop__reason', failure.message),
    );
    run.append(stop);
  }

  if (result.status === 'success') {
    const stop = el('li', 'stop stop--accepted');
    stop.append(
      el('span', 'stop__marker', '✓'),
      el('span', 'stop__round', `Round ${result.negotiationRounds}`),
      el('span', 'stop__label', 'Accepted'),
      el('p', 'stop__reason', `${result.resort.name}: fits your budget and must-haves.`),
    );
    run.append(stop);
  }
}

function itemRow(label, detail, unitPrice, quantity, unit, url) {
  const row = el('tr');
  const name = el('th');
  name.scope = 'row';
  name.append(el('span', 'items__name', label), el('span', 'items__detail', detail));
  const price = el('td', 'items__price', `${euros.format(unitPrice)} × ${quantity} ${unit}`);
  const link = el('td', 'items__action');
  const a = safeLink(url, 'View');
  if (a) link.append(a);
  row.append(name, price, link);
  return row;
}

function renderTicket(result) {
  const { resort, flight, accommodation, skiPass, gear } = result;
  const people = (n) => (n === 1 ? 'person' : 'people');

  document.getElementById('ticket-country').textContent = resort.country;
  document.getElementById('ticket-resort').textContent = resort.name;

  const tags = document.getElementById('ticket-tags');
  tags.replaceChildren(
    el('li', null, resort.vibe === 'young' ? 'Young & lively' : 'Family'),
    el('li', null, `${resort.skiKm} km of pistes`),
    ...(accommodation.hasSkiInOut ? [el('li', null, 'Ski-in/ski-out')] : []),
  );

  document.getElementById('ticket-items').replaceChildren(
    itemRow('Flight', 'Return, per person', flight.pricePerPerson, flight.quantity, people(flight.quantity), flight.url),
    itemRow('Hotel', `${accommodation.name} · level ${accommodation.level}/10`, accommodation.pricePerRoom, accommodation.quantity, accommodation.quantity === 1 ? 'room' : 'rooms', accommodation.url),
    itemRow('Ski pass', 'Whole stay, per person', skiPass.pricePerPerson, skiPass.quantity, people(skiPass.quantity), skiPass.url),
    itemRow('Gear rental', 'Whole stay, per person', gear.pricePerPerson, gear.quantity, people(gear.quantity), gear.url),
  );

  const reasoning = document.getElementById('ticket-reasoning');
  reasoning.textContent = result.destinationReasoning || 'The agent gave no reason.';

  document.getElementById('ticket-total').textContent = euros.format(result.total);
  document.getElementById('ticket-budget').textContent = euros.format(result.maxBudget);
  document.getElementById('ticket-left').textContent = euros.format(result.remainingBudget);
}

function renderFallback(result) {
  document.getElementById('fallback-message').textContent = result.message;
  document.getElementById('fallback-compromises').replaceChildren(
    ...result.compromises.map((text) => el('li', null, text.charAt(0).toUpperCase() + text.slice(1))),
  );
}

function renderResult(result) {
  renderRun(result);
  const isSuccess = result.status === 'success';
  document.getElementById('ticket').hidden = !isSuccess;
  document.getElementById('fallback').hidden = isSuccess;
  if (isSuccess) renderTicket(result);
  else renderFallback(result);
  show('result');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const request = readForm();
  const problem = checkForm(request);
  formError.hidden = !problem;
  formError.textContent = problem ?? '';
  if (problem) return;

  submitButton.disabled = true;
  submitButton.textContent = 'Planning…';
  show('loading');

  try {
    const response = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `The server answered with status ${response.status}.`);
    renderResult(body);
  } catch (err) {
    document.getElementById('error-message').textContent = err.message;
    show('error');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Plan my trip';
  }
});
