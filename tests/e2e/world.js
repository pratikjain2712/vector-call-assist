// The test world shared by both e2e modes: the local Supabase stack (global-setup seeds it) and the
// in-test fake backend (fake-backend.js serves it). Test-only values; never used against the live project.
const EMAIL_DOMAIN = '@e2e.example.com';
const PASSWORD = 'E2e-local-test-password-1';

// A small published script for institute B: two questions and two end cards.
const STEPS = [
  { id: 'hello', start: true, stage: 0, say: ['E2E script: hello {name}, is this a good time?'], opts: [{ label: 'Yes', to: 'pitch' }, { label: 'No', to: 'later' }] },
  { id: 'pitch', stage: 2, say: ['E2E script: here is the offer.'], opts: [{ label: 'Yes', to: 'keen' }, { label: 'No', to: 'later' }] },
  { id: 'keen', title: 'Keen to join' },
  { id: 'later', title: 'Not now' },
];

// who -> [email name, seat label, role, institute key]; noseat and reset have no seat.
const PEOPLE = {
  admin: ['e2e-admin', 'E2E Admin', 'admin', 'a'],
  rep1: ['e2e-rep1', 'Rep 1', 'rep', 'a'],
  rep2: ['e2e-rep2', 'Rep 2', 'rep', 'a'],
  rep3: ['e2e-rep3', 'Rep 3', 'rep', 'b'],
  noseat: ['e2e-noseat', null, null, null],
  reset: ['e2e-reset', null, null, null],
};

module.exports = { EMAIL_DOMAIN, PASSWORD, STEPS, PEOPLE };
