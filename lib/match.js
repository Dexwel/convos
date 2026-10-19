'use strict';
/**
 * Deterministic interpretation of spoken answers.
 * Cheap, predictable and testable: runs BEFORE any LLM is asked to guess.
 * Every function returns { value, confidence } or null. Confidence 1 = exact, 0.8-0.9 = strong partial.
 */

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

function normalize(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics (Yoruba, French…)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (s) => normalize(s).split(' ').filter(Boolean);
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'i', 'it', 'is', 'my', 'me', 'we', 'by', 'in', 'on', 'for', 'with', 'option', 'number', 'choice', 'answer', 'please', 'say', 'would', 'like', 'pick', 'choose', 'select', 'go', 'think']);

/** "option two", "number 3", "the third one", "2" -> 2 ; otherwise null */
function ordinalRef(text, max) {
  const t = normalize(text);
  const m = t.match(/^(?:(?:option|number|choice|answer|the|pick|choose|select|i choose|i pick|my answer is|it is|its)\s+)*([a-z0-9]+)(?:\s+one)?$/);
  if (!m) return null;
  const tok = m[1];
  const n = /^\d+$/.test(tok) ? Number(tok) : NUMBER_WORDS[tok];
  if (!n || n < 1 || n > max) return null;
  return n;
}

function matchChoice(options, text) {
  const t = normalize(text);
  if (!t) return null;
  const norm = options.map(normalize);

  // 1. exact
  const exact = norm.indexOf(t);
  if (exact > -1) return { value: options[exact], confidence: 1 };

  // 2. an option's full text appears in what was said (longest unique wins)
  const contained = norm
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o && new RegExp('(^| )' + o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').test(t))
    .sort((a, b) => b.o.length - a.o.length);
  // one option named, or the longest option swallows the shorter ones ("car park" vs "car")
  if (contained.length === 1 || (contained.length > 1 && contained.slice(1).every((c) => contained[0].o.includes(c.o)))) {
    return { value: options[contained[0].i], confidence: 0.95 };
  }
  if (contained.length > 1) return null; // several distinct options named: let the user decide

  // 3. spoken position ("option two")
  const ord = ordinalRef(text, options.length);
  if (ord) return { value: options[ord - 1], confidence: 0.9 };

  // 4. token overlap, must clearly beat the runner-up
  const said = new Set(tokens(text).filter((w) => !STOP.has(w)));
  if (!said.size) return null;
  const scored = norm.map((o, i) => {
    const ot = o.split(' ').filter((w) => w && !STOP.has(w));
    if (!ot.length) return { i, s: 0 };
    const hit = ot.filter((w) => said.has(w)).length;
    return { i, s: hit / ot.length };
  }).sort((a, b) => b.s - a.s);
  if (scored[0].s >= 0.6 && scored[0].s - (scored[1]?.s ?? 0) >= 0.3) return { value: options[scored[0].i], confidence: 0.75 };
  return null;
}

function matchMulti(options, text) {
  const t = normalize(text);
  if (!t) return null;
  if (/\b(all of (them|these|the above)|all the above|everything|all)\b/.test(t) && !/\bnot all\b/.test(t)) {
    return { value: [...options], confidence: 0.85 };
  }
  const picked = new Set();
  let worst = 1;
  // pieces split on commas / "and" / "also" / "plus" / "as well as"
  const parts = String(text).split(/,|;|\band\b|\balso\b|\bplus\b|\bas well as\b/i).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    const m = matchChoice(options, p);
    if (m) { picked.add(m.value); worst = Math.min(worst, m.confidence); }
  }
  // options named inside the full sentence
  options.forEach((o) => {
    const no = normalize(o);
    if (no && new RegExp('(^| )' + no.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').test(t)) picked.add(o);
  });
  if (!picked.size) return null;
  return { value: options.filter((o) => picked.has(o)), confidence: Math.min(worst, 0.9) };
}

const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'right', 'ok', 'okay', 'absolutely', 'definitely', 'affirmative', 'certainly', 'indeed', 'beeni', 'ee', 'oya']);
const NO = new Set(['no', 'nope', 'nah', 'never', 'wrong', 'negative', 'rara', 'mba', 'incorrect']);

function matchYesNo(text) {
  const toks = tokens(text);
  if (!toks.length) return null;
  const t = toks.join(' ');
  const neg = /\b(not really|dont|do not|didnt|did not|wont|will not|cannot|cant|no way)\b/.test(t);
  const yes = toks.some((w) => YES.has(w));
  const no = toks.some((w) => NO.has(w)) || neg;
  if (yes && no) return null; // "yes... no, wait" -> ambiguous
  if (yes) return { value: 'Yes', confidence: toks.length <= 3 ? 1 : 0.85 };
  if (no) return { value: 'No', confidence: toks.length <= 3 ? 1 : 0.85 };
  return null;
}

function matchRating(text, max, lowLabel = '', highLabel = '') {
  const t = normalize(text);
  if (!t) return null;
  const nums = [];
  for (const tok of t.split(' ')) {
    const n = /^\d+$/.test(tok) ? Number(tok) : NUMBER_WORDS[tok];
    if (n) nums.push(n);
  }
  // "four out of five" -> first number; "i give it a 7" -> 7
  const valid = nums.filter((n) => n >= 1 && n <= max);
  if (valid.length && (nums.length === 1 || /out of|over/.test(t))) return { value: valid[0], confidence: nums.length === 1 ? 1 : 0.9 };
  if (nums.length === 1 && (nums[0] < 1 || nums[0] > max)) return null;
  const lo = normalize(lowLabel), hi = normalize(highLabel);
  if (lo && t === lo) return { value: 1, confidence: 0.85 };
  if (hi && t === hi) return { value: max, confidence: 0.85 };
  return null;
}

/** Entry point used by the server. */
function interpret(question, text) {
  switch (question.type) {
    case 'choice': return matchChoice(question.options, text);
    case 'multi': return matchMulti(question.options, text);
    case 'yesno': return matchYesNo(text);
    case 'rating': return matchRating(text, question.scaleMax, question.lowLabel, question.highLabel);
    default: return null;
  }
}

module.exports = { normalize, matchChoice, matchMulti, matchYesNo, matchRating, interpret };
