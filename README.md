# ConvoSurvey

Conversational survey platform. Respondents answer one question at a time in a chat, by typing or by voice.
Every question and every answer option can be read aloud, and structured answers can be spoken ("option two",
"the bus", "four out of five", "yes"). The form owner can have AI design the whole form, then test it as a respondent.

## Run it
Requires Node 22.13+.

    npm install
    cp .env.example .env     # add GROQ_API_KEY (free, console.groq.com) and ADMIN_PASSWORD
    npm start                # http://localhost:3000

- Admin: `/admin`   - Respondent link: `/s/<slug>`   - Test as the owner: `/s/<slug>?preview=1` (or the "Test" buttons)

## For the form owner
1. **Design with AI**: describe the study, pick length and language, and the AI drafts the questions, answer options,
   consent text and tone. Refine in plain words ("make it shorter", "add a question about cost").
2. Edit anything by hand: open, single choice, multiple choice, rating (5/7/10), yes/no; required or optional;
   follow-up guidance; typing and/or voice; voice language.
3. **Test as respondent** (never counted in stats or exports, auto-deleted after 24 h), then Publish and share the link.
4. Results: per-question charts, full transcripts with audio playback, AI theme summaries, CSV/JSON export.

## For respondents
- **Read aloud**: questions, then the options ("Option 1. Walk. Option 2. Bus...") using the device voice. Replay any time.
- **Say your answer** on choice, multi, yes/no and rating questions. Clear matches are applied immediately; uncertain
  ones are read back ("Did you mean Bus?") and need a yes before anything is saved. Tapping always works.
- **Hands-free**: the app reads each question, listens, understands, confirms when unsure, and moves on by itself.
- Open questions: type, or record a voice answer. It is transcribed (Groq Whisper) and the audio is kept.
- AI follow-up on vague open answers (0 to 3 per question). Resume after refresh. Optional consent step.

## How it is built (harness principles)
- **Rules first, model second.** Spoken choices go through a deterministic, unit-tested matcher (ordinals, number words,
  fuzzy text, Yoruba/Pidgin yes/no). The model is asked only when rules fail, is limited to the question's own options,
  and its answer is validated and capped at "needs confirmation".
- **Model proposes, code disposes.** The form designer's output is coerced, schema-validated, checked for spoken-form
  rules (length, option count, duplicates) and repaired in a bounded 3-try loop. The owner always reviews before saving.
- **Human in the loop** on uncertainty (confirm step) and on AI drafts (editor review).
- **Single validated write path.** Voice answers are submitted through the same `/answer` validation as taps.
- **Untrusted text stays data.** Respondent and owner text is wrapped as data in prompts; instructions inside are ignored.
- **Graceful degradation.** No Groq key: plain acknowledgements, voice saved untranscribed. No speech voice: silent
  fallback. Mic blocked: tap and type still work.
- **Observable.** Every model call is timed and logged as JSON; counters are on the admin status endpoint.
- **Bounded and private.** Rate limits, upload limits, signed admin cookie, audio only via admin login, CSV formula
  neutralisation, strict CSP, preview data purged.

## Deploy
Needs a host that runs Node with a persistent disk (Render, Railway, Fly.io, a VPS). Mount the disk at `DATA_DIR`, set
`NODE_ENV=production` and `TRUST_PROXY=1`, serve over HTTPS (browsers only allow the microphone on HTTPS). Back up `DATA_DIR`.

## Tests
    npm test                 # matcher unit tests
    node test/mock-groq.js & # offline Groq stand-in
    GROQ_BASE_URL=http://localhost:4010/v1 GROQ_API_KEY=x ADMIN_PASSWORD=pw PORT=3100 npm start &
    BASE=http://localhost:3100 ADMIN_PASSWORD=pw npm run test:e2e

## Notes
- Browser voices vary by device. Reading aloud works best in Chrome, Edge and Safari; some devices have no voice for
  Yoruba or Pidgin, so the spoken text uses the voice language you pick in the editor.
- Spoken answers rely on Groq transcription. Accuracy on accented or noisy audio varies, which is why uncertain matches
  are confirmed and tapping is always available.
- Respondent data is personal data. Tell respondents how it is used and check local rules (e.g. NDPA in Nigeria) and ethics approval.
