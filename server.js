require('dotenv').config();
const express = require('express');
const path = require('path');
const twilio = require('twilio');
const bodyParser = require('body-parser');

const { MASTER_PROMPT } = require('./prompts');
const {
    generateQuickQueryResponse,
    generateDetailedPlanConversation,
    generateVisionDiagnostic,
    fetchLocalDataMock
} = require('./services');

// ── Startup guard ────────────────────────────────────────────
const REQUIRED_ENV = ['GEMINI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
    console.error(`[AgriSpark] FATAL: Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
}

const app = express();

// Twilio sends urlencoded — this MUST come before routes
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ── In-memory call sessions ──────────────────────────────────
const callMemory = {};
function getSession(callSid) {
    if (!callMemory[callSid]) callMemory[callSid] = { params: {}, mode: null, lang: 'en-US' };
    return callMemory[callSid];
}

// ── Health / debug check — open in browser to confirm server is up ──
app.get('/debug', (req, res) => {
    res.json({
        status: 'ok',
        gemini: !!process.env.GEMINI_API_KEY,
        twilio_sid: !!process.env.TWILIO_ACCOUNT_SID,
        base_url: BASE_URL,
        time: new Date().toISOString()
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ════════════════════════════════════════════════════════════
//  WHATSAPP WEBHOOK
// ════════════════════════════════════════════════════════════
app.post('/whatsapp/chat', async (req, res) => {
    console.log('[WA] Webhook hit');
    console.log('[WA] Body:', JSON.stringify(req.body));

    const textMsg  = req.body.Body || '';
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const hasMedia = numMedia > 0;
    const isThai   = /[\u0E00-\u0E7F]/.test(textMsg);
    const lang     = isThai ? 'th-TH' : 'en-US';
    const mediaUrl = hasMedia ? req.body.MediaUrl0 : null;

    console.log(`[WA] text="${textMsg}" lang=${lang} media=${hasMedia}`);

    // Always respond 200 with TwiML — never 4xx/5xx or Twilio shows error 11200
    try {
        const answer = await generateVisionDiagnostic(textMsg, hasMedia, lang, mediaUrl);
        console.log(`[WA] AI replied: ${answer.slice(0, 100)}`);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(answer);
        res.type('text/xml').status(200).send(twiml.toString());
    } catch (err) {
        console.error('[WA] Error:', err.message);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message('AgriSpark is having trouble. Please try again shortly.');
        res.type('text/xml').status(200).send(twiml.toString());
    }
});

// ════════════════════════════════════════════════════════════
//  VOICE ROUTES
// ════════════════════════════════════════════════════════════
app.post('/voice/entry', (req, res) => {
    console.log('[VOICE] /entry, SID:', req.body.CallSid);
    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({ numDigits: 1, action: '/voice/language-selection', method: 'POST' });
    gather.say('Welcome to AgriSpark. For English, press 1. สำหรับภาษาไทย กด 2.');
    twiml.redirect('/voice/entry');
    res.type('text/xml').send(twiml.toString());
});

app.post('/voice/language-selection', (req, res) => {
    const { Digits: digits, CallSid: callSid } = req.body;
    const langCode = digits === '2' ? 'th-TH' : 'en-US';
    getSession(callSid).lang = langCode;
    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({ numDigits: 1, action: '/voice/mode-selection', method: 'POST' });
    gather.say({ language: langCode }, langCode === 'th-TH'
        ? 'สำหรับคำถามด่วน กด 1. สำหรับแผนงานเพาะปลูกแบบละเอียด กด 2.'
        : 'For a quick query, press 1. For a detailed farming plan, press 2.');
    twiml.redirect('/voice/language-selection');
    res.type('text/xml').send(twiml.toString());
});

app.post('/voice/mode-selection', (req, res) => {
    const { Digits: digits, CallSid: callSid } = req.body;
    const session = getSession(callSid);
    const twiml = new twilio.twiml.VoiceResponse();
    if (digits === '1') {
        session.mode = 'quick';
        twiml.gather({ input: 'speech', action: '/voice/quick-query-answer', language: session.lang, speechTimeout: 'auto' })
            .say({ language: session.lang }, session.lang === 'th-TH' ? 'กรุณาพูดคำถามค่ะ' : 'Please say your farming question.');
    } else if (digits === '2') {
        session.mode = 'detailed';
        twiml.gather({ input: 'speech', action: '/voice/detailed-plan-process', language: session.lang, speechTimeout: 'auto' })
            .say({ language: session.lang }, session.lang === 'th-TH'
                ? 'กรุณาบอกชื่อของคุณค่ะ'
                : 'Great! Let us build your plan. Please tell me your name.');
    } else {
        twiml.say('Invalid choice.'); twiml.redirect('/voice/entry');
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/voice/quick-query-answer', async (req, res) => {
    const session = getSession(req.body.CallSid);
    const speech = req.body.SpeechResult;
    const twiml = new twilio.twiml.VoiceResponse();
    if (speech) {
        const answer = await generateQuickQueryResponse(speech, session.lang);
        const g = twiml.gather({ input: 'speech', action: '/voice/quick-query-answer', language: session.lang, speechTimeout: 'auto' });
        g.say({ language: session.lang }, answer);
        g.say({ language: session.lang }, session.lang === 'th-TH' ? 'มีคำถามอื่นอีกไหมคะ?' : 'Do you have another question?');
    } else {
        twiml.gather({ input: 'speech', action: '/voice/quick-query-answer', language: session.lang, speechTimeout: 'auto' })
            .say({ language: session.lang }, session.lang === 'th-TH' ? 'กรุณาพูดคำถามค่ะ' : 'Please say your question.');
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/voice/detailed-plan-process', async (req, res) => {
    const session = getSession(req.body.CallSid);
    const speech  = req.body.SpeechResult || '';
    const twiml   = new twilio.twiml.VoiceResponse();
    const result  = await generateDetailedPlanConversation(session.params, speech, session.lang);
    if (result.updatedParams) session.params = { ...session.params, ...result.updatedParams };
    const msg = result.message || '';
    if (msg.toLowerCase().includes('whatsapp') || msg.toLowerCase().includes('pdf')) {
        twiml.say({ language: session.lang }, msg);
        twiml.say({ language: session.lang }, session.lang === 'th-TH' ? 'ขอบคุณค่ะ ลาก่อน' : 'Thank you. Goodbye!');
        twiml.hangup();
    } else {
        twiml.gather({ input: 'speech', action: '/voice/detailed-plan-process', language: session.lang, speechTimeout: 'auto' })
            .say({ language: session.lang }, msg);
    }
    res.type('text/xml').send(twiml.toString());
});

// ── Outbound call trigger ────────────────────────────────────
app.post('/api/call', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ success: false, error: 'Phone number required.' });
    try {
        const call = await client.calls.create({
            url: `${BASE_URL}/voice/entry`,
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER
        });
        res.json({ success: true, callSid: call.sid });
    } catch (err) {
        console.error('[CALL] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`\n✅ AgriSpark on port ${PORT}`);
        console.log(`🔗 WhatsApp webhook → ${BASE_URL}/whatsapp/chat`);
        console.log(`🔗 Voice webhook    → ${BASE_URL}/voice/entry`);
        console.log(`🔍 Debug            → ${BASE_URL}/debug\n`);
    });
}

module.exports = app;
