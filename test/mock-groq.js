'use strict';
// Minimal stand-in for the Groq API so the platform can be tested offline.
//  - Transcription returns whatever follows "SAY:" inside the uploaded audio bytes (default: a sentence).
//  - Chat handles: interviewer review, spoken-choice interpretation, form designer (with a forced repair
//    round when the brief contains "REPAIR"), and theme summaries.
const http = require('http');
const port = Number(process.env.MOCK_PORT || 4010);
const stats = { design: 0, interpret: 0, review: 0 };

const GOOD_FORM = {
  title: 'Clinic access study',
  description: 'How people get to their nearest clinic.',
  welcome: 'Hello! I have a few short questions about visiting your clinic.',
  consent: 'Your answers are private and used only for this study. You can stop at any time.',
  closing: 'Thank you for your time.',
  persona: 'Warm and brief.',
  maxFollowups: 1,
  questions: [
    { type: 'yesno', text: 'Have you visited a clinic in the last year?', required: true },
    { type: 'choice', text: 'How do you usually get there?', options: ['Walk', 'Bus', 'Motorbike', 'Car'], required: true },
    { type: 'multi', text: 'What would make visits easier?', options: ['Closer clinic', 'Cheaper transport', 'Evening hours', 'Other'], required: true },
    { type: 'rating', text: 'How would you rate the service?', scaleMax: 5, lowLabel: 'Poor', highLabel: 'Excellent', required: true },
    { type: 'open', text: 'Tell us about the last time you went.', inputMode: 'both', probe: true, required: true },
  ],
};

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/__stats') return res.end(JSON.stringify(stats));
    if (req.url.endsWith('/audio/transcriptions')) {
      const m = raw.toString('latin1').match(/SAY:([^\r\n\u0000]*)/);
      return res.end(JSON.stringify({ text: m ? m[1].trim() : 'The clinic is far and transport costs a lot for me.' }));
    }
    if (req.url.endsWith('/chat/completions')) {
      const body = JSON.parse(raw.toString() || '{}');
      const sys = body.messages.find((m) => m.role === 'system')?.content || '';
      const userMsgs = body.messages.filter((m) => m.role === 'user');
      const user = userMsgs[0]?.content || '';
      const reply = (content) => res.end(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));

      if (sys.includes('survey and interview designer')) {
        stats.design++;
        if (/REPAIR/.test(user) && userMsgs.length === 1) {
          // first attempt breaks the rules (duplicate question) so the harness must repair it
          return reply({ ...GOOD_FORM, questions: [GOOD_FORM.questions[0], GOOD_FORM.questions[0]] });
        }
        if (/<instruction>/.test(user)) {
          const m = user.match(/<current_form>([\s\S]*?)<\/current_form>/);
          const cur = JSON.parse(m[1]);
          cur.questions.push({ type: 'yesno', text: 'Would you recommend this clinic?', required: false });
          return reply(cur);
        }
        return reply(GOOD_FORM);
      }
      if (sys.includes('map a respondent')) {
        stats.interpret++;
        const t = (user.match(/<reply>([\s\S]*?)<\/reply>/) || [])[1] || '';
        // pretend the model understands one fuzzy paraphrase: "by road public transport" -> option 2
        if (/public transport/i.test(t)) return reply({ selected: [2], confidence: 0.7 });
        return reply({ selected: [], confidence: 0.1 });
      }
      if (sys.includes('analyse open-ended survey answers')) return reply('- Distance and transport cost (about 2 of 3)\n- Waiting times (about 1 of 3)');
      stats.review++;
      const short = user.length < 160;
      return reply({ ack: 'That makes sense, thank you for explaining.', followup: short ? 'Could you say a bit more about that?' : null });
    }
    res.statusCode = 404; res.end('{}');
  });
}).listen(port, () => console.log('mock groq on ' + port));
