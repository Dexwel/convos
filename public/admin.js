(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const view = $('#view');

  // ---------- helpers ----------
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
    let res;
    try { res = await fetch('/api/admin' + path, init); } catch { throw new Error('Network error. Check your connection.'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login' && path !== '/signup') { showLogin(); throw new Error('Please sign in.'); }
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }
  const fmtDate = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const fmtDur = (ms) => { if (ms == null) return '—'; const s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };
  const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
  const surveyUrl = (slug) => location.origin + '/s/' + slug;
  const statusBadge = (s) => h('span', { class: 'badge ' + s }, s === 'live' ? 'Live' : s === 'closed' ? 'Closed' : 'Draft');
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Link copied'); }
    catch { toast('Copy failed — select the link and copy it manually'); }
  }

  // ---------- auth ----------
  let mode = 'signin';
  const AUTH_ERRORS = {
    cancelled: 'Sign-in was cancelled.',
    failed: 'Sign-in with that provider failed. Please try again.',
    state: 'That sign-in link expired. Please try again.',
    noemail: 'That account did not share an email address, so we could not sign you in.',
    exists: 'An account with that email already exists. Sign in with your email and password instead, or use Google.',
    unavailable: 'That sign-in method is not available.',
  };
  function setMode(m) {
    mode = m;
    const up = m === 'signup';
    $('#name-field').hidden = !up;
    $('#pw-hint').hidden = !up;
    $('#pw').autocomplete = up ? 'new-password' : 'current-password';
    $('#auth-submit').textContent = up ? 'Create account' : 'Sign in';
    $('#auth-sub').textContent = up ? 'Create an account to start building surveys.' : 'Sign in to build surveys and read responses.';
    $('#switch-text').textContent = up ? 'Already have an account?' : 'New here?';
    $('#switch-mode').textContent = up ? 'Sign in' : 'Create an account';
    $('#login-error').hidden = true;
  }
  async function showLogin(msg) {
    $('#app').hidden = true; $('#login').hidden = false;
    try {
      const me = await fetch('/api/admin/me').then((r) => r.json());
      const { google, microsoft } = me.providers || {};
      $('#btn-google').hidden = !google; $('#btn-microsoft').hidden = !microsoft;
      $('#social').hidden = !(google || microsoft);
    } catch { /* email still works */ }
    if (msg) { const box = $('#login-error'); box.textContent = msg; box.hidden = false; }
    setTimeout(() => $('#em').focus(), 50);
  }
  $('#switch-mode').addEventListener('click', () => setMode(mode === 'signin' ? 'signup' : 'signin'));
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('#login-error'); box.hidden = true;
    const json = { email: $('#em').value, password: $('#pw').value };
    if (mode === 'signup') json.name = $('#nm').value;
    const btn = $('#auth-submit'); btn.disabled = true;
    try { await api(mode === 'signup' ? '/signup' : '/login', { method: 'POST', json }); $('#pw').value = ''; await enterApp(); }
    catch (err) { box.textContent = err.message; box.hidden = false; }
    finally { btn.disabled = false; }
  });
  $('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

  async function enterApp() {
    $('#login').hidden = true; $('#app').hidden = false;
    try {
      const me = await fetch('/api/admin/me').then((r) => r.json());
      if (me.user) $('#who').textContent = me.user.name || me.user.email;
      const st = await api('/status');
      const parts = [];
      if (!st.groq) parts.push(h('span', {}, h('b', {}, 'AI is off: '), 'add GROQ_API_KEY to .env to enable follow-up questions, voice transcription and summaries.'));
      const banner = $('#banner');
      banner.replaceChildren(...parts.flatMap((p, i) => (i ? [h('br'), p] : [p])));
      banner.hidden = parts.length === 0;
    } catch { /* handled */ }
    route();
  }

  // ---------- routing ----------
  window.addEventListener('hashchange', () => { if (!$('#app').hidden) route(); });
  function route() {
    const [, page, id] = (location.hash || '#/').split('/');
    view.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    window.scrollTo(0, 0);
    let p;
    if (page === 'new') p = editor(null);
    else if (page === 'edit' && id) p = editor(id);
    else if (page === 'results' && id) p = results(id);
    else p = list();
    p.catch((e) => view.replaceChildren(h('div', { class: 'panel' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'error' }, e.message), h('a', { class: 'btn', href: '#/' }, 'Back to surveys'))));
  }

  // ---------- survey list ----------
  async function list() {
    const surveys = await api('/surveys');
    const head = h('div', { class: 'page-head' }, h('h1', {}, 'Your surveys'), h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/new' }, 'New survey')));
    if (!surveys.length) {
      view.replaceChildren(head, h('div', { class: 'empty' },
        h('h2', {}, 'No surveys yet'),
        h('p', { class: 'muted' }, 'Create your first conversational survey. Add questions, go live, and share the link.'),
        h('a', { class: 'btn primary', href: '#/new' }, 'Create a survey')));
      return;
    }
    const rows = surveys.map((s) => h('div', { class: 'survey-row' },
      h('div', {}, h('h3', {}, s.title),
        h('div', { class: 'meta' }, statusBadge(s.status), h('span', {}, `${s.questions} questions`), h('span', {}, `${s.completed} of ${s.started} completed`), h('span', {}, 'Updated ' + fmtDate(s.updated_at)))),
      h('div', { class: 'actions' },
        s.status === 'live' ? h('button', { class: 'btn sm', type: 'button', onclick: () => copy(surveyUrl(s.slug)) }, 'Copy link') : null,
        h('a', { class: 'btn sm', href: `/s/${s.slug}?preview=1`, target: '_blank', rel: 'noopener' }, 'Test'),
        h('a', { class: 'btn sm', href: '#/results/' + s.id }, 'Results'),
        h('a', { class: 'btn sm', href: '#/edit/' + s.id }, 'Edit'),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { await api(`/surveys/${s.id}/duplicate`, { method: 'POST' }); toast('Survey duplicated'); route(); } }, 'Duplicate'))));
    view.replaceChildren(head, h('div', { class: 'survey-list' }, rows));
  }

  // ---------- editor ----------
  const TYPE_LABELS = { open: 'Open answer', choice: 'Single choice', multi: 'Multiple choice', rating: 'Rating scale', yesno: 'Yes / No' };
  const newQuestion = (type = 'open') => ({ id: 'q_' + Math.random().toString(36).slice(2, 10), type, text: '', required: true, options: ['', ''], scaleMax: 5, lowLabel: '', highLabel: '', inputMode: 'both', probe: true, probeHint: '' });

  async function editor(id) {
    let S;
    if (id) S = await api('/surveys/' + id);
    else S = {
      title: '', description: '', welcome: 'Hi! Thanks for taking part. I will ask you a few questions, one at a time.',
      consent: '', closing: 'That was the last question. Thank you for your time!', persona: 'Friendly, brief and neutral.', maxFollowups: 1, voiceLang: 'en-GB', status: 'draft',
      questions: [{ ...newQuestion('open'), text: 'What brought you here today?' }, { ...newQuestion('rating'), text: 'How would you rate your experience so far?', lowLabel: 'Poor', highLabel: 'Excellent' }, { ...newQuestion('open'), text: 'Is there anything else you would like to tell us?', required: false }],
    };
    S.questions = S.questions.map((qu) => ({ ...newQuestion(qu.type), ...qu, options: qu.options && qu.options.length ? qu.options : ['', ''] }));

    const field = (label, control, hint) => h('div', { class: 'field' }, h('label', {}, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
    const bind = (key, el) => { el.dataset.bind = key; el.addEventListener('input', () => { S[key] = el.value; }); return el; };

    const qList = h('div', { class: 'q-list' });
    const renderQs = () => {
      qList.replaceChildren(...S.questions.map((qu, i) => questionCard(qu, i)));
    };
    function move(i, d) { const j = i + d; if (j < 0 || j >= S.questions.length) return; [S.questions[i], S.questions[j]] = [S.questions[j], S.questions[i]]; renderQs(); }

    function questionCard(qu, i) {
      const typeSel = h('select', { 'aria-label': 'Question type' }, Object.entries(TYPE_LABELS).map(([v, l]) => h('option', { value: v }, l)));
      typeSel.value = qu.type;
      typeSel.addEventListener('change', () => { qu.type = typeSel.value; renderQs(); });
      const req = h('input', { type: 'checkbox', checked: qu.required });
      req.addEventListener('change', () => { qu.required = req.checked; });
      const text = h('textarea', { rows: '2', maxlength: '600', 'aria-label': `Question ${i + 1} text`, placeholder: 'Type the question as you would ask it out loud' });
      text.value = qu.text;
      text.addEventListener('input', () => { qu.text = text.value; });

      const extra = h('div', { class: 'q-extra' });
      if (qu.type === 'choice' || qu.type === 'multi') {
        const ta = h('textarea', { rows: '4', 'aria-label': 'Options, one per line', placeholder: 'One option per line' });
        ta.value = qu.options.join('\n');
        ta.addEventListener('input', () => { qu.options = ta.value.split('\n'); });
        extra.append(h('div', { class: 'field wide' }, h('label', {}, 'Options'), ta, h('p', { class: 'hint' }, 'One option per line, 2 to 15 options.')));
      }
      if (qu.type === 'rating') {
        const sel = h('select', { 'aria-label': 'Scale size' }, [5, 7, 10].map((n) => h('option', { value: n }, `1 to ${n}`)));
        sel.value = String(qu.scaleMax);
        sel.addEventListener('change', () => { qu.scaleMax = Number(sel.value); });
        const lo = h('input', { type: 'text', maxlength: '40', placeholder: 'e.g. Not at all', value: qu.lowLabel }); lo.addEventListener('input', () => { qu.lowLabel = lo.value; });
        const hi = h('input', { type: 'text', maxlength: '40', placeholder: 'e.g. Very much', value: qu.highLabel }); hi.addEventListener('input', () => { qu.highLabel = hi.value; });
        extra.append(field('Scale', sel), h('div'), field('Label for 1', lo), field('Label for the top rating', hi));
      }
      if (qu.type === 'open') {
        const mode = h('select', { 'aria-label': 'Answer method' }, [['both', 'Typing or voice'], ['text', 'Typing only'], ['voice', 'Voice first (typing allowed)']].map(([v, l]) => h('option', { value: v }, l)));
        mode.value = qu.inputMode;
        mode.addEventListener('change', () => { qu.inputMode = mode.value; });
        const probe = h('input', { type: 'checkbox', checked: qu.probe });
        probe.addEventListener('change', () => { qu.probe = probe.checked; });
        const hint = h('input', { type: 'text', maxlength: '300', placeholder: 'Optional: what should the AI dig into? e.g. reasons, cost, who was involved', value: qu.probeHint });
        hint.addEventListener('input', () => { qu.probeHint = hint.value; });
        extra.append(field('How people answer', mode), h('label', { class: 'inline-check' }, probe, 'Let the AI ask a follow-up when an answer is vague'), h('div', { class: 'field wide' }, h('label', {}, 'Follow-up guidance'), hint));
      }

      return h('div', { class: 'q-card' },
        h('div', { class: 'q-head' },
          h('span', { class: 'num' }, i + 1 + '.'), typeSel,
          h('label', { class: 'inline' }, req, 'Required'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': `Move question ${i + 1} up`, disabled: i === 0, onclick: () => move(i, -1) }, 'Up'),
          h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': `Move question ${i + 1} down`, disabled: i === S.questions.length - 1, onclick: () => move(i, 1) }, 'Down'),
          h('button', { class: 'btn ghost sm danger', type: 'button', 'aria-label': `Delete question ${i + 1}`, onclick: () => { if (S.questions.length === 1) return toast('A survey needs at least one question'); S.questions.splice(i, 1); renderQs(); } }, 'Delete')),
        text, extra);
    }
    renderQs();

    // ----- AI form designer -----
    const keepIds = (draftQs) => draftQs.map((d) => {
      const old = S.questions.find((o) => o.id === d.id);
      return { ...newQuestion(d.type), ...d, options: d.options && d.options.length ? d.options : ['', ''], id: old ? old.id : d.id };
    });
    const applyDraft = (d) => {
      for (const k of ['title', 'description', 'welcome', 'consent', 'closing', 'persona']) if (typeof d[k] === 'string') S[k] = d[k];
      if (Number.isInteger(d.maxFollowups)) S.maxFollowups = d.maxFollowups;
      S.questions = keepIds(d.questions);
    };
    const dBrief = h('textarea', { rows: '4', maxlength: '3000', placeholder: 'Describe your study: who you are asking, what you want to learn, and anything to include or avoid. Example: "A short survey for market traders in Ibadan about how they get to the nearest clinic and what stops them going back."' });
    const dCount = h('select', { 'aria-label': 'Number of questions' }, [5, 8, 10, 12, 15, 20].map((n) => h('option', { value: n }, `About ${n} questions`)));
    dCount.value = '8';
    const dLang = h('select', { 'aria-label': 'Language' }, ['English (plain and simple)', 'Nigerian Pidgin', 'Yoruba', 'French', 'Swahili', 'Spanish', 'Portuguese'].map((l) => h('option', { value: l }, l)));
    const dMsg = h('p', { class: 'hint', role: 'status' });
    const dBtn = h('button', { class: 'btn primary', type: 'button' }, 'Design my form');
    const dTweak = h('input', { type: 'text', maxlength: '800', placeholder: 'Ask for a change, e.g. "make it shorter", "add a question about cost", "translate to Yoruba"' });
    const dTweakBtn = h('button', { class: 'btn', type: 'button' }, 'Apply change');
    const dTweakRow = h('div', { class: 'share' }, dTweak, dTweakBtn);
    const dPreviewNote = h('p', { class: 'hint' }, 'Always read the draft before you publish. The AI can miss context that only you know.');
    const runDesigner = async (payload, btn, label) => {
      btn.disabled = true; btn.textContent = 'Working…'; dMsg.textContent = 'The AI is drafting and checking the form. This takes a few seconds.'; dMsg.className = 'hint';
      try {
        const r = await api('/surveys/generate', { method: 'POST', json: payload });
        applyDraft(r.draft);
        title.value = S.title;
        document.querySelectorAll('[data-bind]').forEach((el) => { el.value = S[el.dataset.bind] || ''; });
        maxF.value = String(S.maxFollowups);
        renderQs();
        dMsg.textContent = `Draft ready: ${S.questions.length} questions. Review and edit below, then save.`;
        dTweak.value = '';
        toast('Draft added to the editor');
      } catch (e) { dMsg.textContent = e.message; dMsg.className = 'error'; }
      btn.disabled = false; btn.textContent = label;
    };
    dBtn.addEventListener('click', () => {
      if (S.questions.some((x) => x.text.trim()) && !confirm('Replace the current questions with an AI draft? Your current questions will be lost.')) return;
      runDesigner({ brief: dBrief.value, count: Number(dCount.value), language: dLang.value }, dBtn, 'Design my form');
    });
    dTweakBtn.addEventListener('click', () => {
      if (!dTweak.value.trim()) { dMsg.textContent = 'Say what you want changed.'; dMsg.className = 'error'; return; }
      const current = { ...S, questions: S.questions.map((qu) => ({ ...qu, options: (qu.options || []).filter((o) => o.trim()) })) };
      delete current.id; delete current.slug; delete current.status;
      runDesigner({ current, instruction: dTweak.value, brief: dBrief.value, language: dLang.value }, dTweakBtn, 'Apply change');
    });
    const voiceLang = h('select', { 'aria-label': 'Voice language' }, [['en-GB', 'English (UK)'], ['en-NG', 'English (Nigeria)'], ['en-US', 'English (US)'], ['en-ZA', 'English (South Africa)'], ['fr-FR', 'French'], ['es-ES', 'Spanish'], ['pt-PT', 'Portuguese'], ['sw-KE', 'Swahili'], ['ar-SA', 'Arabic']].map(([v, l]) => h('option', { value: v }, l)));
    voiceLang.value = S.voiceLang || 'en-GB';
    voiceLang.addEventListener('change', () => { S.voiceLang = voiceLang.value; });

    const maxF = h('select', {}, [0, 1, 2, 3].map((n) => h('option', { value: n }, n === 0 ? 'None — ask each question once' : n === 1 ? 'Up to 1 per open question' : `Up to ${n} per open question`)));
    maxF.value = String(S.maxFollowups);
    maxF.addEventListener('change', () => { S.maxFollowups = Number(maxF.value); });

    const shareBox = h('div');
    const renderShare = () => {
      if (!S.id) { shareBox.replaceChildren(h('p', { class: 'hint' }, 'Save the survey to get a shareable link.')); return; }
      const url = surveyUrl(S.slug);
      shareBox.replaceChildren(
        h('div', { class: 'share' }, h('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Survey link', onfocus: (e) => e.target.select() }), h('button', { class: 'btn', type: 'button', onclick: () => copy(url) }, 'Copy')),
        ...(S.status !== 'live' ? [h('p', { class: 'hint' }, 'The link only works for respondents while the survey is live.')] : []));
    };
    renderShare();

    async function save(newStatus) {
      const payload = { ...S, status: newStatus || S.status };
      payload.questions = S.questions.map((qu) => ({ ...qu, options: (qu.options || []).map((o) => o.trim()).filter(Boolean) }));
      try {
        const saved = S.id ? await api('/surveys/' + S.id, { method: 'PUT', json: payload }) : await api('/surveys', { method: 'POST', json: payload });
        if (newStatus && saved.status !== newStatus) await api(`/surveys/${saved.id}/status`, { method: 'PATCH', json: { status: newStatus } });
        toast(newStatus === 'live' ? 'Published — your survey is live' : 'Saved');
        if (!S.id) { location.hash = '#/edit/' + saved.id; return; }
        route();
      } catch (e) { toast(e.message); }
    }

    const title = bind('title', h('input', { type: 'text', maxlength: '140', placeholder: 'e.g. Community health access study', value: S.title }));
    view.replaceChildren(
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, S.id ? 'Edit survey' : 'New survey'), S.id ? h('div', { class: 'meta', style: 'margin-top:6px' }, statusBadge(S.status)) : null),
        h('div', { class: 'actions' },
          S.id ? h('a', { class: 'btn', href: '#/results/' + S.id }, 'Results') : null,
          S.id ? h('a', { class: 'btn', href: `/s/${S.slug}?preview=1`, target: '_blank', rel: 'noopener' }, 'Test as respondent') : null,
          h('button', { class: 'btn', type: 'button', onclick: () => save() }, 'Save'),
          S.status === 'live'
            ? h('button', { class: 'btn', type: 'button', onclick: () => save('closed') }, 'Close survey')
            : h('button', { class: 'btn primary', type: 'button', onclick: () => save('live') }, S.status === 'closed' ? 'Reopen survey' : 'Publish'))),
      h('section', { class: 'panel designer' }, h('h2', {}, 'Design with AI'),
        h('p', { class: 'muted' }, 'Describe your study and the AI drafts the whole form: questions, answer options, consent and tone. Every question is written to be read aloud and answered by voice.'),
        dBrief, h('div', { class: 'grid2' }, field('Length', dCount), field('Language', dLang)),
        h('div', {}, dBtn), dMsg, S.questions.some((x) => x.text.trim()) ? h('div', { class: 'field' }, h('label', {}, 'Refine the current form'), dTweakRow) : null, dPreviewNote),
      h('section', { class: 'panel' }, h('h2', {}, 'Basics'),
        field('Title', title),
        field('Short description', bind('description', h('textarea', { rows: '2', maxlength: '600', value: S.description })), 'Shown on the start screen.'),
        field('Opening message', bind('welcome', h('textarea', { rows: '2', maxlength: '800', value: S.welcome }))),
        field('Consent statement', bind('consent', h('textarea', { rows: '3', maxlength: '1500', value: S.consent, placeholder: 'Optional. If filled in, respondents must tick a box to agree before starting.' }))),
        field('Closing message', bind('closing', h('textarea', { rows: '2', maxlength: '800', value: S.closing })))),
      h('section', { class: 'panel' }, h('h2', {}, 'Questions'), qList,
        h('div', { class: 'actions', style: 'display:flex;gap:8px;flex-wrap:wrap' },
          Object.entries(TYPE_LABELS).map(([t, l]) => h('button', { class: 'btn sm', type: 'button', onclick: () => { S.questions.push(newQuestion(t)); renderQs(); qList.lastElementChild.querySelector('textarea').focus(); } }, '+ ' + l)))),
      h('section', { class: 'panel' }, h('h2', {}, 'AI interviewer'),
        h('div', { class: 'grid2' },
          field('Follow-up questions', maxF, 'Follow-ups only happen on open answers that are vague or brief.'),
          field('Tone and style', bind('persona', h('input', { type: 'text', maxlength: '400', value: S.persona, placeholder: 'e.g. Warm, plain language, no jargon' })), 'The AI replies in the respondent’s language, including Pidgin.'),
          field('Voice used to read questions aloud', voiceLang, 'Depends on the voices installed on the respondent’s device.'))),
      h('section', { class: 'panel' }, h('h2', {}, 'Share'), shareBox),
      S.id ? h('section', { class: 'panel' }, h('h2', {}, 'Danger zone'),
        h('p', { class: 'muted' }, 'Deleting a survey permanently removes its responses and audio recordings.'),
        h('div', {}, h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (confirm('Delete this survey and all of its responses? This cannot be undone.')) { await api('/surveys/' + S.id, { method: 'DELETE' }); toast('Survey deleted'); location.hash = '#/'; } } }, 'Delete survey'))) : null);
  }

  // ---------- results ----------
  async function results(id) {
    const [{ survey, responses }, stats] = await Promise.all([api(`/surveys/${id}/responses`), api(`/surveys/${id}/stats`)]);
    const url = surveyUrl(survey.slug);

    const tiles = h('div', { class: 'tiles' },
      [['Started', stats.started], ['Completed', stats.completed], ['Completion rate', pct(stats.completionRate)], ['Median time', fmtDur(stats.medianDurationMs)]]
        .map(([k, v]) => h('div', { class: 'tile' }, h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k))));

    const summaries = {};
    const qStats = stats.questions.map((qs) => {
      const box = h('div', { class: 'qstat' }, h('h3', {}, qs.text), h('p', { class: 'hint' }, `${qs.n} answer${qs.n === 1 ? '' : 's'} · ${TYPE_LABELS[qs.type]}`));
      if (qs.counts) {
        const total = Math.max(1, Object.values(qs.counts).reduce((a, b) => a + b, 0));
        const max = Math.max(1, ...Object.values(qs.counts));
        box.append(h('div', { class: 'bars' }, Object.entries(qs.counts).map(([label, n]) =>
          h('div', { class: 'bar-row' }, h('span', { class: 'lbl' }, label), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(n / max) * 100}%` })), h('span', { class: 'n' }, `${n} (${Math.round((n / total) * 100)}%)`)))));
        if (qs.mean != null) box.append(h('p', { class: 'hint' }, `Average: ${qs.mean.toFixed(2)} out of ${qs.scaleMax}`));
      }
      if (qs.type === 'open') { const s = h('div', { class: 'summary', hidden: true }); summaries[qs.id] = s; box.append(s); }
      return box;
    });

    const hasOpen = stats.questions.some((x) => x.type === 'open' && x.n > 1);
    const sumBtn = h('button', { class: 'btn sm', type: 'button' }, 'Summarise open answers with AI');
    sumBtn.addEventListener('click', async () => {
      sumBtn.disabled = true; sumBtn.textContent = 'Summarising…';
      try {
        const r = await api(`/surveys/${id}/summarize`, { method: 'POST' });
        for (const item of r.questions) { const el = summaries[item.id]; if (el) { el.hidden = false; el.textContent = item.summary + '\n\n(AI-generated from up to 80 recent answers. Check against the raw responses.)'; } }
      } catch (e) { toast(e.message); }
      sumBtn.disabled = false; sumBtn.textContent = 'Summarise open answers with AI';
    });

    const resps = responses.length ? responses.map((r) => {
      const first = r.answers.find((a) => a.kind === 'answer' && a.value != null);
      const snippet = first ? (Array.isArray(first.value) ? first.value.join(', ') : String(first.value)) : 'No answers yet';
      const hasAudio = r.answers.some((a) => a.audio);
      return h('details', { class: 'resp' },
        h('summary', {}, h('span', { class: 'when' }, fmtDate(r.started_at)), h('span', { class: 'snippet' }, snippet),
          hasAudio ? h('span', { class: 'badge' }, 'Audio') : null,
          h('span', { class: 'badge ' + (r.status === 'completed' ? 'live' : '') }, r.status === 'completed' ? 'Completed' : 'In progress')),
        h('div', { class: 'transcript' },
          r.answers.length ? r.answers.map((a) => h('div', { class: 't-item ' + a.kind },
            h('div', { class: 'p' }, (a.kind === 'followup' ? 'Follow-up: ' : '') + a.prompt),
            h('div', { class: 'a' }, a.value == null ? 'Skipped' : Array.isArray(a.value) ? a.value.join(', ') : String(a.value)),
            a.audio ? h('audio', { controls: true, preload: 'none', src: '/api/admin/audio/' + encodeURIComponent(a.audio) }) : null)) : h('p', { class: 'muted' }, 'No answers recorded.'),
          h('div', {}, h('button', { class: 'btn sm danger', type: 'button', onclick: async (e) => { if (!confirm('Delete this response and any audio?')) return; await api('/sessions/' + r.id, { method: 'DELETE' }); toast('Response deleted'); route(); } }, 'Delete response'))));
    }) : [h('div', { class: 'empty' }, h('h2', {}, 'No responses yet'), h('p', { class: 'muted' }, survey.status === 'live' ? 'Share your link to start collecting answers.' : 'Publish the survey, then share the link.'),
      survey.status === 'live' ? h('button', { class: 'btn primary', type: 'button', onclick: () => copy(url) }, 'Copy survey link') : h('a', { class: 'btn primary', href: '#/edit/' + id }, 'Open editor'))];

    view.replaceChildren(
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, survey.title), h('div', { class: 'meta', style: 'margin-top:6px' }, statusBadge(survey.status))),
        h('div', { class: 'actions' },
          survey.status === 'live' ? h('button', { class: 'btn', type: 'button', onclick: () => copy(url) }, 'Copy link') : null,
          survey.status === 'live' ? h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, 'Open survey') : null,
          h('a', { class: 'btn', href: '#/edit/' + id }, 'Edit'),
          h('a', { class: 'btn', href: `/api/admin/surveys/${id}/export.csv` }, 'Export CSV'),
          h('a', { class: 'btn', href: `/api/admin/surveys/${id}/export.json` }, 'Export JSON'))),
      tiles,
      h('section', { class: 'panel' }, h('div', { class: 'page-head' }, h('h2', {}, 'Answers by question'), hasOpen ? sumBtn : null), qStats),
      h('section', { class: 'panel' }, h('h2', {}, `Responses (${responses.length})`), h('div', { style: 'display:grid;gap:10px' }, resps)));
  }

  // ---------- boot ----------
  (async () => {
    try {
      const err = new URLSearchParams(location.search).get('auth_error');
      if (err) history.replaceState(null, '', '/admin' + location.hash);
      const me = await fetch('/api/admin/me').then((r) => r.json());
      if (me.authenticated) await enterApp(); else await showLogin(err ? (AUTH_ERRORS[err] || AUTH_ERRORS.failed) : undefined);
    } catch { showLogin(); }
  })();
})();
