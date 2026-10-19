'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchChoice, matchMulti, matchYesNo, matchRating, normalize } = require('../lib/match');

const travel = ['Walk', 'Bus', 'Motorbike', 'Car'];

test('normalize strips accents and punctuation', () => {
  assert.equal(normalize('Bẹ́ẹ̀ni!'), 'beeni');
  assert.equal(normalize('  Hello,   World '), 'hello world');
});

test('choice: exact, contained, ordinal, fuzzy', () => {
  assert.equal(matchChoice(travel, 'Bus').value, 'Bus');
  assert.equal(matchChoice(travel, 'I usually take the bus.').value, 'Bus');
  assert.equal(matchChoice(travel, 'option two').value, 'Bus');
  assert.equal(matchChoice(travel, 'number 3').value, 'Motorbike');
  assert.equal(matchChoice(travel, 'the third one').value, 'Motorbike');
  assert.equal(matchChoice(travel, 'three').value, 'Motorbike');
});

test('choice: ambiguous or unrelated returns null', () => {
  assert.equal(matchChoice(travel, 'bus or car maybe'), null);
  assert.equal(matchChoice(travel, 'helicopter'), null);
  assert.equal(matchChoice(travel, ''), null);
  assert.equal(matchChoice(travel, 'five'), null); // out of range
});

test('choice: options that contain digits are matched by text first', () => {
  assert.equal(matchChoice(['5 km', '10 km', 'More'], '10 km').value, '10 km');
});

test('multi: lists, conjunctions, all', () => {
  const o = ['Closer clinic', 'Cheaper transport', 'Evening hours'];
  assert.deepEqual(matchMulti(o, 'closer clinic and evening hours').value, ['Closer clinic', 'Evening hours']);
  assert.deepEqual(matchMulti(o, 'one, three').value, ['Closer clinic', 'Evening hours']);
  assert.deepEqual(matchMulti(o, 'all of them').value, o);
  assert.equal(matchMulti(o, 'nothing relevant'), null);
});

test('yes/no incl. Yoruba and ambiguity', () => {
  assert.equal(matchYesNo('Yeah sure').value, 'Yes');
  assert.equal(matchYesNo('Nope').value, 'No');
  assert.equal(matchYesNo('not really').value, 'No');
  assert.equal(matchYesNo('Bẹ́ẹ̀ni').value, 'Yes');
  assert.equal(matchYesNo('rara').value, 'No');
  assert.equal(matchYesNo('yes no wait'), null);
  assert.equal(matchYesNo('maybe'), null);
});

test('rating: digits, words, out of, labels, bounds', () => {
  assert.equal(matchRating('4', 5).value, 4);
  assert.equal(matchRating('I would say four', 5).value, 4);
  assert.equal(matchRating('four out of five', 5).value, 4);
  assert.equal(matchRating('7', 5), null);
  assert.equal(matchRating('excellent', 5, 'Poor', 'Excellent').value, 5);
  assert.equal(matchRating('', 5), null);
});
