(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const preview = params.get('preview') === '1';
  const slug = location.pathname.split('/').filter(Boolean)[1] || '';
  const KEY = 'cs_sess_' + (preview ? 'preview_' : '') + slug;
  const PREF_KEY = 'cs_prefs';
  const $ = (s) => document.querySelector(s);
  const log = $('#log');
  const body = $('#composer-body');
  const errBox = $('#composer-error');

  let survey = null;
  let state = null;
  let busy = false;
  let narrationToken = 0;
  const rendered = new Set();

  // ---------- helpers ----------
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  const svg = (paths) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = paths;
    return s;
  };
  const ICON_MIC = '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>';
  const ICON_SEND = '<path d="M5 12h14M13 6l6 6-6 6"/>';
  const ICON_SPEAKER = '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>';
  const ICON_SPEAKER_OFF = '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6"/>';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const show = (id) => { for (const s of ['screen-error', 'screen-intro', 'screen-chat']) $('#' + s).hidden = s !== id; };
  function fail(title, text) { $('#error-title').textContent = title; $('#error-text').textContent = text; show('screen-error'); }
  function setError(msg) { errBox.hidden = !msg; errBox.textContent = msg || ''; }
  const normalize = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
    if (opts.form) init.body = opts.form;
    let res;
    try { res = await fetch(path, init); } catch { throw new Error('You appear to be offline. Check your connection and try again.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong.'); e.status = res.status; throw e; }
    return data;
  }
  const extOf = (blob) => (/mp4/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm');

  // ---------- read-aloud (speech synthesis) ----------
  const tts = { supported: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window, on: false, hands: false };
  function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } }
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ listen: tts.on, hands: tts.hands })); } catch { /* ignore */ } }

  function pickVoice(lang) {
    const voices = window.speechSynthesis.getVoices();
    const want = lang.toLowerCase();
    return voices.find((v) => v.lang.replace('_', '-').toLowerCase() === want) || voices.find((v) => v.lang.toLowerCase().startsWith(want.slice(0, 2))) || null;
  }
  /** Speaks the texts in order; resolves when the last one ends (or is cancelled). */
  function speakAll(texts, { force = false } = {}) {
    return new Promise((resolve) => {
      const list = texts.filter(Boolean);
      if (!tts.supported || (!tts.on && !force) || !list.length) return resolve();
      window.speechSynthesis.cancel();
      const lang = (survey && survey.voiceLang) || 'en-GB';
      const voice = pickVoice(lang);
      let finished = false;
      const fin = () => { if (!finished) { finished = true; resolve(); } };
      try {
        list.forEach((t, i) => {
          const u = new SpeechSynthesisUtterance(t);
          u.lang = lang; u.rate = 0.95;
          if (voice) u.voice = voice;
          if (i === list.length - 1) { u.onend = fin; u.onerror = fin; }
          window.speechSynthesis.speak(u);
        });
      } catch { fin(); return; } // a browser without a working voice must never block the survey
      setTimeout(fin, 90000);
    });
  }
  const stopSpeaking = () => { narrationToken++; if (tts.supported) window.speechSynthesis.cancel(); };

  function optionsSpeech(cur) {
    if (!cur || cur.followup) return '';
    const how = tts.hands ? 'Say' : 'Tap or say';
    const list = (opts) => opts.map((o, i) => `Option ${i + 1}. ${o}.`).join(' ');
    let t = '';
    switch (cur.type) {
      case 'choice': t = `Your options are. ${list(cur.options)} ${how} your choice, or its number.`; break;
      case 'multi': t = `You can choose more than one. ${list(cur.options)} ${how} everything that applies.`; break;
      case 'yesno': t = `${how} yes or no.`; break;
      case 'rating':
        t = `Rate from 1 to ${cur.scaleMax}.` + (cur.lowLabel ? ` 1 means ${cur.lowLabel}.` : '') + (cur.highLabel ? ` ${cur.scaleMax} means ${cur.highLabel}.` : '') + ` ${how} a number.`;
        break;
      default: return '';
    }
    if (!cur.required) t += ' You can also say skip.';
    return t;
  }

  async function narrate(newMsgs, cur) {
    const token = ++narrationToken;
    const texts = newMsgs.filter((m) => m.role === 'bot').map((m) => m.content);
    const opt = optionsSpeech(cur);
    if (opt) texts.push(opt);
    await speakAll(texts);
    if (token !== narrationToken) return;
    autoListen();
  }
  function replay() {
    const cur = state && state.current;
    const lastBot = [...state.messages].reverse().find((m) => m.role === 'bot' && (m.kind === 'question' || m.kind === 'followup' || m.kind === 'closing'));
    narrationToken++;
    speakAll([lastBot && lastBot.content, optionsSpeech(cur)], { force: true });
  }
  function syncToggle() {
    const b = $('#tts-toggle');
    b.hidden = !tts.supported;
    b.setAttribute('aria-pressed', String(tts.on));
    b.setAttribute('aria-label', tts.on ? 'Turn off reading aloud' : 'Read questions aloud');
    b.title = b.getAttribute('aria-label');
    b.replaceChildren(svg(tts.on ? ICON_SPEAKER : ICON_SPEAKER_OFF));
  }
  $('#tts-toggle').addEventListener('click', () => {
    tts.on = !tts.on;
    if (!tts.on) { tts.hands = false; stopSpeaking(); abortListening(); renderComposer(); } else if (state && state.current) replay();
    savePrefs(); syncToggle();
  });

  // ---------- recording helper (shared by every voice flow) ----------
  let rec = null;
  function abortListening() { if (rec) { rec.stop(true); rec = null; } }

  /** Records until stopped, or (with vad) until the speaker pauses. Resolves {blob, duration, heard}. */
  function recordClip({ vad = false, silenceMs = 1400, maxMs = 15000, noSpeechMs = 8000, canvas = null } = {}) {
    let stopFn = null;
    let early = null;
    const p = new Promise((resolve, reject) => {
      (async () => {
        let st;
        try { st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
        catch { return reject(new Error('mic-blocked')); }
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
        const chunks = [];
        const mr = new MediaRecorder(st, mime ? { mimeType: mime } : undefined);
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = AC ? new AC() : null;
        let an = null;
        if (ctx) { an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(st).connect(an); }
        const buf = new Uint8Array(an ? an.fftSize : 0);
        const c2 = canvas ? canvas.getContext('2d') : null;
        const levels = [];
        const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#0b6e4f';
        const t0 = Date.now();
        let heard = false, lastVoice = t0, raf = 0, cancelled = false;
        const finish = () => { if (mr.state !== 'inactive') mr.stop(); };
        mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onstop = () => {
          cancelAnimationFrame(raf);
          st.getTracks().forEach((t) => t.stop());
          if (ctx) ctx.close().catch(() => {});
          if (cancelled) return reject(new Error('cancelled'));
          resolve({ blob: new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' }), duration: Date.now() - t0, heard });
        };
        stopFn = (cancel) => { cancelled = !!cancel; finish(); };
        const loop = () => {
          raf = requestAnimationFrame(loop);
          let rms = 0;
          if (an) {
            an.getByteTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
            rms = Math.sqrt(sum / buf.length);
          }
          const now = Date.now();
          if (rms > 0.03) { heard = true; lastVoice = now; }
          if (c2) {
            const W = (canvas.width = canvas.clientWidth * 2 || 300), H = (canvas.height = canvas.clientHeight * 2 || 72);
            levels.push(Math.min(1, rms * 6));
            const bars = Math.floor(W / 9);
            while (levels.length > bars) levels.shift();
            c2.clearRect(0, 0, W, H);
            c2.fillStyle = color;
            levels.forEach((v, i) => { const bh = Math.max(4, v * H); c2.fillRect(i * 9, (H - bh) / 2, 5, bh); });
          }
          if (vad && heard && now - lastVoice > silenceMs) finish();
          else if (vad && !heard && now - t0 > noSpeechMs) finish();
          if (now - t0 > maxMs) finish();
        };
        mr.start(250);
        loop();
        if (early !== null) stopFn(early);
      })();
    });
    p.stop = (cancel) => { if (stopFn) stopFn(cancel); else early = !!cancel; };
    return p;
  }

  // ---------- rendering ----------
  function scrollDown() { log.scrollTop = log.scrollHeight; }
  function bubble(m) {
    const cls = ['msg', m.role];
    if (m.role === 'bot') cls.push(m.kind === 'welcome' ? 'welcome' : m.kind);
    if (m.role === 'user' && m.audio) cls.push('voice');
    if (m.role === 'user' && m.content === 'Skipped') cls.push('skipped');
    return h('div', { class: cls.join(' '), text: m.content });
  }
  function typingEl() { return h('div', { class: 'typing', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')); }

  async function renderMessages(msgs, animate) {
    const fresh = msgs.filter((m) => !rendered.has(m.id));
    for (const m of fresh) {
      if (animate && m.role === 'bot') {
        const t = typingEl();
        log.append(t); scrollDown();
        await sleep(m.kind === 'ack' ? 300 : 500);
        t.remove();
      }
      rendered.add(m.id);
      log.append(bubble(m));
      scrollDown();
    }
    return fresh;
  }

  function updateProgress() {
    const { done, total } = state.progress;
    const finished = state.status === 'completed';
    const pct = finished ? 100 : total ? Math.round((done / total) * 100) : 0;
    $('#bar-fill').style.width = pct + '%';
    $('.bar').setAttribute('aria-valuenow', String(pct));
    $('#progress-label').textContent = finished ? 'Complete' : `Question ${Math.min(done + 1, total)} of ${total}`;
  }

  // ---------- composer ----------
  let sayRoot = null;
  function clearComposer() { abortListening(); stopStream(); sayRoot = null; body.replaceChildren(); setError(''); }
  const canListen = () => !!(survey && survey.transcription && navigator.mediaDevices && window.MediaRecorder);

  function renderComposer() {
    clearComposer();
    const cur = state.current;
    if (state.status === 'completed' || !cur) {
      body.append(h('p', { class: 'muted', text: 'Your responses were saved. You can close this page.' }));
      if (tts.supported) body.append(h('div', { class: 'tools' }, replayBtn()));
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
      return;
    }
    const skip = !cur.required || cur.followup ? skipLink(cur.followup ? 'Skip this one' : 'Skip this question') : null;
    let main;
    switch (cur.followup ? 'open' : cur.type) {
      case 'open': main = openComposer(cur); break;
      case 'choice': main = choiceComposer(cur); break;
      case 'multi': main = multiComposer(cur); break;
      case 'yesno': main = yesNoComposer(); break;
      case 'rating': main = ratingComposer(cur); break;
      default: main = h('p', { class: 'error', text: 'Unsupported question.' });
    }
    body.append(main);
    const structured = !cur.followup && cur.type !== 'open';
    if (structured && canListen()) { const say = sayBar(cur); if (say) body.append(say); }
    const tools = h('div', { class: 'tools' }, tts.supported ? replayBtn() : null, skip);
    if (tools.children.length) body.append(tools);
  }
  const replayBtn = () => h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Listen to this question again', onclick: replay }, svg(ICON_SPEAKER), 'Listen');
  const skipLink = (label) => h('button', { class: 'btn ghost sm', type: 'button', onclick: () => send({ skip: true }, 'Skipped') }, label);

  function openComposer(cur) {
    const canVoice = !!(navigator.mediaDevices && window.MediaRecorder);
    const mode = cur.inputMode || 'both';
    const wrap = h('div', { class: 'open-wrap' });
    let voiceFirst = canVoice && mode === 'voice';

    const draw = () => {
      wrap.replaceChildren();
      if (voiceFirst) { wrap.append(voiceComposer(() => { voiceFirst = false; draw(); })); return; }
      const ta = h('textarea', { rows: '1', placeholder: 'Type your answer…', 'aria-label': 'Your answer', maxlength: '4000' });
      const sendBtn = h('button', { class: 'btn primary icon-btn', type: 'button', 'aria-label': 'Send answer', disabled: true }, svg(ICON_SEND));
      const go = () => { const v = ta.value.trim(); if (v) send({ value: v }, v); };
      ta.addEventListener('input', () => { sendBtn.disabled = !ta.value.trim(); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(min-width: 700px)').matches) { e.preventDefault(); go(); }
      });
      sendBtn.addEventListener('click', go);
      const row = h('div', { class: 'row' }, ta);
      if (canVoice && mode !== 'text') {
        row.append(h('button', { class: 'btn icon-btn mic', type: 'button', 'aria-label': 'Answer with your voice', onclick: () => { voiceFirst = true; draw(); } }, svg(ICON_MIC)));
      }
      row.append(sendBtn);
      wrap.append(row);
      if (!busy && !tts.hands) setTimeout(() => ta.focus({ preventScroll: true }), 50);
    };
    draw();
    return wrap;
  }

  const abortThen = (fn) => () => { abortListening(); fn(); };
  function choiceComposer(cur) {
    return h('div', { class: 'options' }, cur.options.map((o) =>
      h('button', { class: 'opt', type: 'button', onclick: abortThen(() => send({ value: o }, o)) }, o)));
  }
  function multiComposer(cur) {
    const picked = new Set();
    const sendBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Send');
    const btns = cur.options.map((o) => {
      const b = h('button', { class: 'opt', type: 'button', 'aria-pressed': 'false' }, h('span', { class: 'tick' }), o);
      b.addEventListener('click', () => {
        abortListening();
        if (picked.has(o)) picked.delete(o); else picked.add(o);
        b.setAttribute('aria-pressed', String(picked.has(o)));
        sendBtn.disabled = picked.size === 0;
      });
      return b;
    });
    sendBtn.addEventListener('click', () => { const arr = cur.options.filter((o) => picked.has(o)); send({ value: arr }, arr.join(', ')); });
    return h('div', { class: 'options' }, h('p', { class: 'hint', text: 'Select all that apply.' }), btns, sendBtn);
  }
  function yesNoComposer() {
    return h('div', { class: 'yn' },
      h('button', { class: 'opt', type: 'button', style: 'justify-content:center', onclick: abortThen(() => send({ value: 'Yes' }, 'Yes')) }, 'Yes'),
      h('button', { class: 'opt', type: 'button', style: 'justify-content:center', onclick: abortThen(() => send({ value: 'No' }, 'No')) }, 'No'));
  }
  function ratingComposer(cur) {
    const row = h('div', { class: 'scale-row' }, Array.from({ length: cur.scaleMax }, (_, i) =>
      h('button', { class: 'opt', type: 'button', 'aria-label': `${i + 1} out of ${cur.scaleMax}`, onclick: abortThen(() => send({ value: i + 1 }, `${i + 1} / ${cur.scaleMax}`)) }, String(i + 1))));
    return h('div', { class: 'scale' }, row, h('div', { class: 'scale-labels' }, h('span', { text: cur.lowLabel || '1' }), h('span', { text: cur.highLabel || String(cur.scaleMax) })));
  }

  // ---------- manual voice answer for open questions ----------
  let stream = null, recorder = null, audioCtx = null, rafId = 0, timerId = 0;
  function stopStream() {
    cancelAnimationFrame(rafId); clearInterval(timerId);
    if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; try { recorder.stop(); } catch { /* ignore */ } }
    recorder = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  }
  const MAX_MS = 3 * 60 * 1000;
  const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  function voiceComposer(backToText) {
    const root = h('div', { class: 'voice' });
    let startedAt = 0;
    const idle = () => {
      stopStream();
      root.replaceChildren(h('div', { class: 'row', style: 'justify-content:center;flex-direction:column;align-items:stretch' },
        h('button', { class: 'btn primary', type: 'button', onclick: begin }, svg(ICON_MIC), 'Tap to record'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: backToText }, 'Type instead')));
    };
    async function begin() {
      setError('');
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch { setError('Microphone access is blocked. Allow it in your browser settings, or type your answer.'); return; }
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
      const chunks = [];
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
        const duration = Date.now() - startedAt;
        stopStream();
        review(blob, duration);
      };
      const canvas = h('canvas', { 'aria-hidden': 'true' });
      const time = h('span', { class: 'time', text: '0:00' });
      const AC = window.AudioContext || window.webkitAudioContext;
      let analyser = null;
      if (AC) { audioCtx = new AC(); analyser = audioCtx.createAnalyser(); analyser.fftSize = 128; audioCtx.createMediaStreamSource(stream).connect(analyser); }
      const ctx = canvas.getContext('2d');
      const data = new Uint8Array(analyser ? analyser.frequencyBinCount : 0);
      const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#0b6e4f';
      const draw = () => {
        rafId = requestAnimationFrame(draw);
        const W = (canvas.width = canvas.clientWidth * 2 || 300), H = (canvas.height = canvas.clientHeight * 2 || 72);
        ctx.clearRect(0, 0, W, H);
        const bars = 36, gap = 6, w = (W - gap * (bars - 1)) / bars;
        if (analyser) analyser.getByteFrequencyData(data);
        ctx.fillStyle = color;
        for (let i = 0; i < bars; i++) {
          const v = analyser ? data[Math.floor((i / bars) * data.length * 0.7)] / 255 : 0.15;
          const bh = Math.max(6, v * H);
          ctx.fillRect(i * (w + gap), (H - bh) / 2, w, bh);
        }
      };
      startedAt = Date.now();
      recorder.start(250);
      draw();
      timerId = setInterval(() => {
        const el = Date.now() - startedAt;
        time.textContent = fmt(el);
        if (el >= MAX_MS && recorder && recorder.state === 'recording') recorder.stop();
      }, 250);
      root.replaceChildren(
        h('div', { class: 'capsule', role: 'group', 'aria-label': 'Recording' }, h('span', { class: 'dot' }), canvas, time,
          h('button', { class: 'btn stop', type: 'button', 'aria-label': 'Stop recording', onclick: () => recorder && recorder.state === 'recording' && recorder.stop() }, 'Stop')),
        h('div', { class: 'voice-actions' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: idle }, 'Cancel')));
    }
    function review(blob, duration) {
      if (blob.size < 1200 || duration < 700) { setError('That recording was too short. Try again.'); idle(); return; }
      const url = URL.createObjectURL(blob);
      root.replaceChildren(
        h('div', { class: 'capsule' }, h('audio', { controls: true, src: url, 'aria-label': 'Preview your recording' })),
        h('div', { class: 'voice-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => { URL.revokeObjectURL(url); idle(); } }, 'Re-record'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => sendAudio(blob, duration, url) }, 'Send recording')));
    }
    idle();
    return root;
  }

  // ---------- say your answer (structured questions) ----------
  function sayBar(cur) {
    const root = h('div', { class: 'say' });
    sayRoot = root;
    idleSay(cur);
    return root;
  }
  function idleSay(cur, note) {
    if (!sayRoot) return;
    sayRoot.replaceChildren(
      h('button', { class: 'btn say-btn', type: 'button', onclick: () => { stopSpeaking(); listenChoice(cur, false, 0); } }, svg(ICON_MIC), 'Say your answer'),
      note ? h('span', { class: 'hint', text: note }) : null);
  }
  async function postInterpret(blob, confirm) {
    const form = new FormData();
    form.append('audio', blob, 'answer.' + extOf(blob));
    form.append('confirm', confirm ? '1' : '0');
    return api(`/api/sessions/${state.sid}/interpret`, { method: 'POST', form });
  }
  function listeningCapsule(label, onDone, onCancel) {
    const canvas = h('canvas', { 'aria-hidden': 'true' });
    return {
      canvas,
      el: [
        h('div', { class: 'capsule', role: 'group', 'aria-label': 'Listening' }, h('span', { class: 'dot' }), canvas, h('span', { class: 'time', text: label }),
          h('button', { class: 'btn stop', type: 'button', onclick: onDone }, 'Done')),
        onCancel ? h('div', { class: 'voice-actions' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: onCancel }, 'Cancel')) : null,
      ],
    };
  }

  function retryOrStop(cur, hands, attempt, msg, spoken) {
    if (hands && attempt < 2) {
      speakAll([spoken || 'Sorry, I did not catch that. Please try again.']).then(() => { if (state && state.current && state.current.qid === cur.qid && !busy) listenChoice(cur, true, attempt + 1); });
      idleSay(cur, msg);
    } else idleSay(cur, msg);
  }

  async function listenChoice(cur, hands, attempt) {
    if (!sayRoot || busy) return;
    const token = narrationToken;
    setError('');
    const cap = listeningCapsule(hands ? 'Listening…' : 'Say it now', () => rec && rec.stop(false), () => { abortListening(); idleSay(cur); });
    sayRoot.replaceChildren(...cap.el);
    let clip;
    try {
      rec = recordClip({ vad: true, silenceMs: 1400, maxMs: 15000, noSpeechMs: 8000, canvas: cap.canvas });
      clip = await rec;
    } catch (e) {
      rec = null;
      if (e.message === 'cancelled') return;
      setError(e.message === 'mic-blocked' ? 'Microphone access is blocked. Tap an option instead.' : 'Could not use the microphone.');
      idleSay(cur); return;
    }
    rec = null;
    if (hands && token !== narrationToken) return;
    if (!sayRoot) return;
    if (!clip.heard || clip.blob.size < 1200) return retryOrStop(cur, hands, attempt, 'I did not hear anything. Try again or tap an option.');
    sayRoot.replaceChildren(h('p', { class: 'hint', text: 'Understanding your answer…' }));
    let r;
    try { r = await postInterpret(clip.blob, false); }
    catch (e) { setError(e.message); idleSay(cur); return; }
    if (!sayRoot) return;
    const m = r.match;
    if (m && m.confidence >= 0.9) return submitVoice(cur, r);
    if (m) return confirmFlow(cur, r, hands);
    if (!cur.required && /^(skip|pass|next|no answer|prefer not to say|i do not know|i dont know)\b/.test(normalize(r.transcript))) { send({ skip: true }, 'Skipped'); return; }
    retryOrStop(cur, hands, attempt, `I heard “${r.transcript}”, but it did not match an option. Try again or tap one.`, 'Sorry, that was not one of the options. Please try again.');
  }

  function submitVoice(cur, r) {
    send({ value: r.match.value, viaVoice: true, transcript: r.transcript }, r.match.display, { voice: true });
  }

  function confirmFlow(cur, r, hands) {
    const yes = () => { stopSpeaking(); abortListening(); submitVoice(cur, r); };
    const no = () => { stopSpeaking(); abortListening(); idleSay(cur); if (hands) listenChoice(cur, true, 1); };
    const question = `I heard “${r.transcript}”. Did you mean ${r.match.display}?`;
    sayRoot.replaceChildren(
      h('p', { class: 'confirm-q', text: question }),
      h('div', { class: 'voice-actions' }, h('button', { class: 'btn', type: 'button', onclick: no }, 'No, try again'), h('button', { class: 'btn primary', type: 'button', onclick: yes }, 'Yes, that is right')));
    if (!hands) return;
    const token = narrationToken;
    (async () => {
      await speakAll([`Did you mean ${r.match.display}? Say yes or no.`]);
      if (token !== narrationToken || !sayRoot) return;
      try {
        rec = recordClip({ vad: true, silenceMs: 1000, maxMs: 8000, noSpeechMs: 6000 });
        const clip = await rec; rec = null;
        if (!clip.heard || token !== narrationToken) return;
        const a = await postInterpret(clip.blob, true);
        if (token !== narrationToken) return;
        if (a.match && a.match.value === 'Yes') yes();
        else if (a.match && a.match.value === 'No') no();
      } catch { rec = null; }
    })();
  }

  // ---------- hands-free ----------
  function autoListen() {
    if (!tts.hands || !state || !state.current || state.status === 'completed' || busy || !canListen()) return;
    const cur = state.current;
    if (cur.followup || cur.type === 'open') handsFreeOpen(cur);
    else listenChoice(cur, true, 0);
  }
  async function handsFreeOpen(cur) {
    const token = narrationToken;
    body.replaceChildren();
    setError('');
    const cap = listeningCapsule('Listening…', () => rec && rec.stop(false), null);
    const typeBtn = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { abortListening(); tts.hands = false; savePrefs(); renderComposer(); } }, 'Switch to typing');
    body.append(...cap.el.filter(Boolean), h('p', { class: 'hint', text: 'Speak your answer. It sends when you pause.' }), typeBtn);
    let clip;
    try {
      rec = recordClip({ vad: true, silenceMs: 2600, maxMs: 120000, noSpeechMs: 10000, canvas: cap.canvas });
      clip = await rec;
    } catch (e) { rec = null; if (e.message !== 'cancelled') { renderComposer(); setError('Microphone access is blocked. Type your answer instead.'); } return; }
    rec = null;
    if (token !== narrationToken) return;
    if (!clip.heard || clip.blob.size < 1200) { renderComposer(); setError('I did not hear anything. Tap the microphone to try again.'); return; }
    sendAudio(clip.blob, clip.duration, null);
  }

  // ---------- sending ----------
  async function send(payload, display, opts = {}) {
    if (busy) return;
    if (!state.current) return;
    stopSpeaking(); abortListening();
    setError('');
    busy = true;
    const temp = h('div', { class: 'msg user' + (payload.skip ? ' skipped' : '') + (opts.voice ? ' voice' : ''), text: display });
    log.append(temp); scrollDown();
    body.style.opacity = '0.6'; body.style.pointerEvents = 'none';
    try {
      const next = await api(`/api/sessions/${state.sid}/answer`, { method: 'POST', json: payload });
      await applyState(next, temp);
    } catch (e) {
      temp.remove();
      setError(e.message);
      if (e.status === 409 || e.status === 404) await reloadState();
    } finally { busy = false; body.style.opacity = ''; body.style.pointerEvents = ''; }
  }

  async function sendAudio(blob, duration, previewUrl) {
    if (busy) return;
    stopSpeaking(); abortListening();
    setError('');
    busy = true;
    const temp = h('div', { class: 'msg user voice', text: 'Transcribing your recording…' });
    log.append(temp); scrollDown();
    body.style.opacity = '0.6'; body.style.pointerEvents = 'none';
    try {
      const form = new FormData();
      form.append('durationMs', String(duration));
      form.append('audio', blob, 'answer.' + extOf(blob));
      const next = await api(`/api/sessions/${state.sid}/audio`, { method: 'POST', form });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      await applyState(next, temp);
    } catch (e) {
      temp.remove();
      renderComposer();
      setError(e.message);
    } finally { busy = false; body.style.opacity = ''; body.style.pointerEvents = ''; }
  }

  async function applyState(next, tempEl) {
    const prev = new Set(rendered);
    state = next;
    const newMsgs = next.messages.filter((m) => !prev.has(m.id));
    const firstUser = newMsgs.find((m) => m.role === 'user');
    if (tempEl) {
      if (firstUser) { tempEl.replaceWith(bubble(firstUser)); rendered.add(firstUser.id); } else tempEl.remove();
    }
    clearComposer();
    updateProgress();
    await renderMessages(next.messages, true);
    renderComposer();
    scrollDown();
    busy = false; // composer is live again; narration may start listening
    narrate(newMsgs, next.current);
  }

  async function reloadState() {
    try {
      const s = await api(`/api/sessions/${state.sid}`);
      state = s;
      updateProgress();
      await renderMessages(s.messages, false);
      renderComposer();
    } catch { /* ignore */ }
  }

  // ---------- boot ----------
  function enterChat() {
    document.title = survey.title;
    $('#chat-title').textContent = survey.title;
    $('#preview-banner').hidden = !preview;
    syncToggle();
    show('screen-chat');
  }

  async function resumeIfPossible() {
    let sid = null;
    try { sid = localStorage.getItem(KEY); } catch { /* ignore */ }
    if (!sid) return false;
    try {
      state = await api('/api/sessions/' + encodeURIComponent(sid));
      const p = loadPrefs();
      tts.on = !!p.listen && tts.supported;
      tts.hands = false; // hands-free needs a fresh tap to start audio
      enterChat();
      updateProgress();
      await renderMessages(state.messages, false);
      renderComposer();
      scrollDown();
      return true;
    } catch {
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
      return false;
    }
  }

  async function startNew(consent) {
    const s = await api(`/api/s/${encodeURIComponent(slug)}/sessions`, { method: 'POST', json: { consent, preview } });
    try { localStorage.setItem(KEY, s.sid); } catch { /* ignore */ }
    state = s;
    enterChat();
    updateProgress();
    const fresh = await renderMessages(s.messages, true);
    renderComposer();
    narrate(fresh, s.current);
  }

  async function boot() {
    try { survey = await api('/api/s/' + encodeURIComponent(slug)); }
    catch (e) { return fail('Survey not found', e.message); }
    document.title = survey.title;
    if (await resumeIfPossible()) return;
    if (survey.status !== 'live' && !preview) {
      return fail(survey.status === 'closed' ? 'This survey has closed' : 'This survey is not open yet', 'Thank you for your interest. Please check back later or contact the person who shared this link.');
    }
    $('#preview-banner-intro').hidden = !preview;
    $('#intro-title').textContent = survey.title;
    $('#intro-desc').textContent = survey.description || survey.welcome;
    const mins = Math.max(1, Math.round(survey.questionCount * 0.5));
    $('#intro-meta').textContent = `${survey.questionCount} question${survey.questionCount === 1 ? '' : 's'} · about ${mins} min`;

    // listening preferences
    const prefs = loadPrefs();
    const listen = $('#pref-listen'), hands = $('#pref-hands');
    if (tts.supported) {
      $('#prefs').hidden = false;
      listen.checked = prefs.listen !== false;
      if (canListen()) {
        $('#pref-hands-wrap').hidden = false;
        hands.checked = !!prefs.hands && listen.checked;
      }
      listen.addEventListener('change', () => { if (!listen.checked) hands.checked = false; });
      hands.addEventListener('change', () => { if (hands.checked) listen.checked = true; });
    }

    const needConsent = !!survey.consent;
    $('#intro-consent').hidden = !needConsent;
    $('#consent-text').textContent = survey.consent;
    const btn = $('#start-btn');
    const check = $('#consent-check');
    if (needConsent) { btn.disabled = true; check.addEventListener('change', () => { btn.disabled = !check.checked; }); }
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      $('#intro-error').hidden = true;
      tts.on = tts.supported && listen.checked;
      tts.hands = tts.on && !hands.closest('label').hidden && hands.checked;
      savePrefs();
      try { await startNew(needConsent ? check.checked : false); }
      catch (e) { const box = $('#intro-error'); box.textContent = e.message; box.hidden = false; btn.disabled = false; }
    });
    show('screen-intro');
  }

  window.addEventListener('beforeunload', () => { stopStream(); if (tts.supported) window.speechSynthesis.cancel(); });
  boot();
})();
