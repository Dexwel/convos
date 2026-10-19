'use strict';
// End-to-end API test. Usage: BASE=http://localhost:3000 ADMIN_PASSWORD=... node test/e2e.js
const assert = require('assert');
const BASE = process.env.BASE || 'http://localhost:3000';
const PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
let cookie = '';

async function call(method, path, body, { form, raw } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const ok = (label) => console.log('  ok  ' + label);

(async () => {
  console.log('Admin');
  let r = await call('GET', '/api/admin/surveys');
  assert.equal(r.status, 401); ok('admin API rejects anonymous');
  r = await call('POST', '/api/admin/login', { password: 'wrong' });
  assert.equal(r.status, 401); ok('wrong password rejected');
  r = await call('POST', '/api/admin/login', { password: PASSWORD });
  assert.equal(r.status, 200); ok('login');

  r = await call('POST', '/api/admin/surveys', { title: '', questions: [] });
  assert.equal(r.status, 400); ok('empty survey rejected');

  r = await call('POST', '/api/admin/surveys', {
    title: 'Clinic access study', consent: 'Your answers are anonymous.', maxFollowups: 1,
    questions: [
      { type: 'open', text: 'What stopped you from returning to the clinic?', inputMode: 'both' },
      { type: 'choice', text: 'How do you usually travel?', options: ['Walk', 'Bus', 'Motorbike'] },
      { type: 'multi', text: 'What would help?', options: ['Closer clinic', 'Cheaper transport', 'Evening hours'] },
      { type: 'rating', text: 'Rate the service', scaleMax: 5 },
      { type: 'yesno', text: 'Would you return?', required: false },
    ],
  });
  assert.equal(r.status, 201); const survey = r.data; ok('survey created');

  console.log('Respondent');
  r = await call('POST', `/api/s/${survey.slug}/sessions`, {});
  assert.equal(r.status, 403); ok('draft survey not open to respondents');
  r = await call('PATCH', `/api/admin/surveys/${survey.id}/status`, { status: 'live' });
  assert.equal(r.status, 200); ok('published');

  r = await call('POST', `/api/s/${survey.slug}/sessions`, {});
  assert.equal(r.status, 400); ok('consent required');
  r = await call('POST', `/api/s/${survey.slug}/sessions`, { consent: true });
  assert.equal(r.status, 201);
  let st = r.data; const sid = st.sid;
  assert.equal(st.current.type, 'open'); ok('session started, first question is open');

  r = await call('POST', `/api/sessions/${sid}/answer`, { value: '' });
  assert.equal(r.status, 400); ok('empty open answer rejected');

  // short answer triggers a follow-up (with mock or with Groq)
  r = await call('POST', `/api/sessions/${sid}/answer`, { value: 'Too far.' });
  assert.equal(r.status, 200); st = r.data;
  const followedUp = !!st.current.followup;
  ok(followedUp ? 'AI follow-up asked' : 'no follow-up (AI off or declined)');
  if (followedUp) {
    r = await call('POST', `/api/sessions/${sid}/answer`, { value: 'The bus fare is 1500 naira each way.' });
    assert.equal(r.status, 200); st = r.data;
    assert.ok(!st.current.followup || st.current.qid); ok('follow-up answered');
  }
  assert.equal(st.current.type, 'choice'); ok('advanced to choice question');

  r = await call('POST', `/api/sessions/${sid}/answer`, { value: 'Helicopter' });
  assert.equal(r.status, 400); ok('invalid option rejected');
  r = await call('POST', `/api/sessions/${sid}/answer`, { value: 'Bus' }); st = r.data;
  r = await call('POST', `/api/sessions/${sid}/answer`, { value: ['Closer clinic', 'Evening hours'] }); st = r.data;
  assert.equal(st.current.type, 'rating');
  r = await call('POST', `/api/sessions/${sid}/answer`, { value: 9 });
  assert.equal(r.status, 400); ok('out-of-range rating rejected');
  r = await call('POST', `/api/sessions/${sid}/answer`, { value: 4 }); st = r.data;
  assert.equal(st.current.type, 'yesno');
  r = await call('POST', `/api/sessions/${sid}/answer`, { skip: true }); st = r.data;
  assert.equal(st.status, 'completed'); ok('optional question skipped, survey completed');
  assert.ok(st.messages.some((m) => m.kind === 'closing')); ok('closing message present');
  r = await call('POST', `/api/sessions/${sid}/answer`, { value: 'x' });
  assert.equal(r.status, 409); ok('no answers after completion');

  console.log('Audio');
  r = await call('POST', `/api/s/${survey.slug}/sessions`, { consent: true });
  const sid2 = r.data.sid;
  const form = new FormData();
  form.append('audio', new Blob([Buffer.alloc(4000, 1)], { type: 'audio/webm;codecs=opus' }), 'answer.webm');
  form.append('durationMs', '5200');
  r = await call('POST', `/api/sessions/${sid2}/audio`, undefined, { form });
  assert.equal(r.status, 200); ok('voice answer accepted: ' + JSON.stringify(r.data.messages.find((m) => m.role === 'user').content.slice(0, 50)));
  const badForm = new FormData();
  badForm.append('audio', new Blob([Buffer.alloc(100)], { type: 'application/x-evil' }), 'a.exe');
  r = await call('POST', `/api/sessions/${sid2}/audio`, undefined, { form: badForm });
  assert.equal(r.status, 415); ok('non-audio upload rejected');

  console.log('Voice choices');
  const audio = (say) => { const f = new FormData(); f.append('audio', new Blob([Buffer.from('SAY:' + say + '\0'.repeat(3000))], { type: 'audio/webm' }), 'a.webm'); return f; };
  r = await call('POST', `/api/s/${survey.slug}/sessions`, { consent: true });
  const sid3 = r.data.sid;
  await call('POST', `/api/sessions/${sid3}/answer`, { value: 'Too far and expensive for me every single time I try to go there, honestly it is hard.' });
  st = (await call('GET', `/api/sessions/${sid3}`)).data;
  assert.equal(st.current.type, 'choice'); ok('reached choice question');
  r = await call('POST', `/api/sessions/${sid3}/interpret`, undefined, { form: audio('I usually take the bus') });
  assert.equal(r.status, 200); assert.equal(r.data.match.value, 'Bus'); assert.equal(r.data.via, 'rules'); ok('spoken choice matched by rules');
  r = await call('POST', `/api/sessions/${sid3}/interpret`, undefined, { form: audio('by public transport') });
  assert.equal(r.data.via, 'ai'); assert.equal(r.data.match.value, 'Bus'); assert.ok(r.data.match.confidence < 0.9); ok('fuzzy phrase falls back to AI, low confidence => needs confirmation');
  r = await call('POST', `/api/sessions/${sid3}/interpret`, undefined, { form: audio('blue elephant') });
  assert.equal(r.data.match, null); ok('unrelated speech yields no match');
  r = await call('POST', `/api/sessions/${sid3}/interpret`, undefined, { form: audio('option three') });
  assert.equal(r.data.match.value, 'Motorbike'); ok('"option three" resolved by position');
  r = await call('POST', `/api/sessions/${sid3}/answer`, { value: 'Motorbike', viaVoice: true, transcript: 'option three' });
  assert.equal(r.status, 200); assert.equal(r.data.current.type, 'multi'); ok('confirmed voice answer submitted through the validated path');
  const stored = (await call('GET', `/api/admin/surveys/${survey.id}/responses`)).data.responses.find((x) => x.id === sid3);
  const voiced = stored.answers.find((a) => a.value === 'Motorbike');
  assert.ok(voiced.audio); ok('audio kept with the structured answer');
  r = await call('POST', `/api/sessions/${sid3}/answer`, { value: ['Evening hours', 'Closer clinic'] });
  const formOpen = audio('x');
  r = await call('POST', `/api/sessions/${sid3}/interpret`, undefined, { form: audio('four') });
  assert.equal(r.data.match.value, 4); ok('rating by spoken number');
  r = await call('POST', `/api/sessions/${sid3}/answer`, { value: 99, viaVoice: true });
  assert.equal(r.status, 400); ok('invalid voice value still rejected by server validation');

  console.log('AI form designer');
  r = await call('POST', '/api/admin/surveys/generate', { brief: 'x' });
  assert.equal(r.status, 400); ok('too-short brief rejected');
  r = await call('POST', '/api/admin/surveys/generate', { brief: 'A short survey for market traders about getting to the clinic.', count: 5 });
  assert.equal(r.status, 200); assert.equal(r.data.draft.questions.length, 5); ok('draft generated and validated');
  assert.ok(r.data.draft.questions.every((x) => x.id && x.text)); ok('every question has an id and text');
  r = await call('POST', '/api/admin/surveys/generate', { brief: 'REPAIR: market traders and clinic access please', count: 5 });
  assert.equal(r.status, 200); assert.equal(new Set(r.data.draft.questions.map((x) => x.text)).size, 5); ok('invalid first draft repaired by the retry loop');
  const base = r.data.draft;
  r = await call('POST', '/api/admin/surveys/generate', { current: base, instruction: 'add a recommend question' });
  assert.equal(r.status, 200); assert.equal(r.data.draft.questions.length, 6); ok('revision applied to existing form');
  const noAuth = cookie; cookie = '';
  r = await call('POST', '/api/admin/surveys/generate', { brief: 'A short survey for market traders about clinics.' });
  assert.equal(r.status, 401); cookie = noAuth; ok('designer requires admin login');

  console.log('Preview');
  const draftSurvey = (await call('POST', '/api/admin/surveys', { title: 'Draft only', questions: [{ type: 'open', text: 'Hello?' }] })).data;
  let anon = cookie; cookie = '';
  r = await call('POST', `/api/s/${draftSurvey.slug}/sessions`, { preview: true });
  assert.equal(r.status, 403); ok('anonymous cannot start a preview'); cookie = anon;
  r = await call('POST', `/api/s/${draftSurvey.slug}/sessions`, { preview: true });
  assert.equal(r.status, 201); ok('owner previews an unpublished survey');
  await call('POST', `/api/sessions/${r.data.sid}/answer`, { value: 'test answer' });
  r = await call('GET', `/api/admin/surveys/${draftSurvey.id}/stats`);
  assert.equal(r.data.started, 0); ok('preview sessions are excluded from stats');
  r = await call('GET', `/api/admin/surveys/${draftSurvey.id}/responses`);
  assert.equal(r.data.responses.length, 0); ok('preview sessions are excluded from responses');
  await call('DELETE', `/api/admin/surveys/${draftSurvey.id}`);

  console.log('Results');
  r = await call('GET', `/api/admin/surveys/${survey.id}/responses`);
  assert.equal(r.data.responses.length, 3); ok('3 responses stored');
  const withAudio = r.data.responses.flatMap((x) => x.answers).find((a) => a.audio);
  assert.ok(withAudio); ok('audio file recorded against answer');
  const audioRes = await call('GET', `/api/admin/audio/${withAudio.audio}`, undefined, { raw: true });
  assert.equal(audioRes.status, 200); ok('admin can fetch audio');
  r = await call('GET', `/api/admin/surveys/${survey.id}/stats`);
  assert.equal(r.data.started, 3); assert.equal(r.data.completed, 1); ok('stats: 3 started, 1 completed');
  const csv = await (await call('GET', `/api/admin/surveys/${survey.id}/export.csv`, undefined, { raw: true })).text();
  assert.ok(csv.includes('Clinic') === false && csv.includes('response_id') && csv.includes('Bus')); ok('CSV export');

  const savedCookie = cookie; cookie = '';
  const anonAudio = await call('GET', `/api/admin/audio/${withAudio.audio}`, undefined, { raw: true });
  assert.equal(anonAudio.status, 401); ok('audio is private without login');
  cookie = savedCookie;

  r = await call('POST', `/api/admin/surveys/${survey.id}/summarize`);
  console.log('  ..  summarize →', r.status, r.status === 200 ? '' : r.data.error);

  r = await call('DELETE', `/api/admin/surveys/${survey.id}`);
  assert.equal(r.status, 200); ok('survey deleted');
  console.log('\nAll checks passed.');
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
