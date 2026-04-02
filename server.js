require('dotenv').config();
const express = require('express');
const path = require('path');
const twilio = require('twilio');
const bodyParser = require('body-parser');

// Import from local files
const { MASTER_PROMPT } = require('./prompts');
const {
    generateQuickQueryResponse,
    generateDetailedPlanConversation,
    generateVisionDiagnostic,
    fetchLocalDataMock
} = require('./services');

// ============================================================
// STARTUP GUARD — fail fast with a clear message
// ============================================================
const REQUIRED_ENV = ['GEMINI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'BASE_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
    console.error(`\n[AgriSpark] FATAL: Missing required environment variables:\n  ${missing.join(', ')}\n`);
    console.error(`For local dev: BASE_URL should be your ngrok URL, e.g. https://abc123.ngrok.io`);
    console.error(`For Vercel: BASE_URL should be https://your-app.vercel.app\n`);
    process.exit(1);
}

const app = express();

// FIX: Twilio sends both urlencoded (voice/whatsapp) and JSON (API calls).
// Parse BOTH — order matters: urlencoded first so Twilio webhooks always work.
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PORT = process.env.PORT || 3000;

// FIX: Use a single BASE_URL env var — set to ngrok URL locally, Vercel URL in prod.
// This avoids the fragile VERCEL_URL conditional that broke call webhooks.
const BASE_URL = process.env.BASE_URL.replace(/\/$/, ''); // strip trailing slash

// Simple in-memory session store
const callMemory = {};

function getSession(callSid) {
    if (!callMemory[callSid]) {
        callMemory[callSid] = {
            params: {},
            mode: null,
            lang: 'en-US'
        };
    }
    return callMemory[callSid];
}

// ============================================
// TWILIO VOICE ROUTES
// ============================================

app.post('/voice/entry', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({ numDigits: 1, action: '/voice/language-selection', method: 'POST' });
    gather.say('Welcome to AgriSpark. For English, press 1. สำหรับภาษาไทย กด 2.');
    twiml.redirect('/voice/entry');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/language-selection', (req, res) => {
    const digits = req.body.Digits;
    const callSid = req.body.CallSid;
    const twiml = new twilio.twiml.VoiceResponse();
    const langCode = digits === '2' ? 'th-TH' : 'en-US';
    getSession(callSid).lang = langCode;
    const gather = twiml.gather({ numDigits: 1, action: '/voice/mode-selection', method: 'POST' });
    if (langCode === 'th-TH') {
        gather.say({ language: langCode }, 'สำหรับคำถามด่วน กด 1. สำหรับแผนงานเพาะปลูกแบบละเอียด กด 2.');
    } else {
        gather.say({ language: langCode }, 'For a quick query, press 1. For a detailed farming plan, press 2.');
    }
    // FIX: redirect back to language-selection (not language-selection again with wrong path)
    twiml.redirect('/voice/language-selection');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/mode-selection', (req, res) => {
    const digits = req.body.Digits;
    const callSid = req.body.CallSid;
    const session = getSession(callSid);
    const twiml = new twilio.twiml.VoiceResponse();
    if (digits === '1') {
        session.mode = 'quick';
        twiml.gather({
            input: 'speech',
            action: '/voice/quick-query-answer',
            language: session.lang,
            speechTimeout: 'auto'
        }).say({ language: session.lang }, session.lang === 'th-TH' ? 'กรุณาพูดคำถามค่ะ' : 'Please say your farming question.');
    } else if (digits === '2') {
        session.mode = 'detailed';
        twiml.gather({
            input: 'speech',
            action: '/voice/detailed-plan-process',
            language: session.lang,
            speechTimeout: 'auto'
        }).say({ language: session.lang }, session.lang === 'th-TH'
            ? 'เราจะมาสร้างแผนการเพาะปลูกให้คุณนะคะ กรุณาบอกชื่อของคุณค่ะ'
            : 'Let us create your personalized farming plan. Please start by telling me your name.');
    } else {
        twiml.say({ language: session.lang }, 'Invalid choice.');
        twiml.redirect('/voice/entry');
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

// FIX: Collapsed the unnecessary /voice/quick-query-process + /voice/quick-query-gather
// into a single gather route. The old design caused an extra round-trip and a
// blank "Analyzing…" message before the user even spoke.
app.post('/voice/quick-query-answer', async (req, res) => {
    const session = getSession(req.body.CallSid);
    const speechResult = req.body.SpeechResult;
    const twiml = new twilio.twiml.VoiceResponse();

    if (speechResult) {
        const answer = await generateQuickQueryResponse(speechResult, session.lang);
        const gather = twiml.gather({
            input: 'speech',
            action: '/voice/quick-query-answer',
            language: session.lang,
            speechTimeout: 'auto'
        });
        gather.say({ language: session.lang }, answer);
        gather.say({ language: session.lang }, session.lang === 'th-TH' ? 'มีคำถามอื่นอีกไหมคะ?' : 'Do you have another question?');
    } else {
        // Nothing recognised — prompt again
        twiml.gather({
            input: 'speech',
            action: '/voice/quick-query-answer',
            language: session.lang,
            speechTimeout: 'auto'
        }).say({ language: session.lang }, session.lang === 'th-TH' ? 'กรุณาพูดคำถามค่ะ' : 'I did not catch that. Please say your question.');
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/detailed-plan-process', async (req, res) => {
    const session = getSession(req.body.CallSid);
    const speechResult = req.body.SpeechResult || 'Unknown response';
    const twiml = new twilio.twiml.VoiceResponse();

    const result = await generateDetailedPlanConversation(session.params, speechResult, session.lang);

    // FIX: persist updated params so data is not lost between turns
    if (result.updatedParams) {
        session.params = { ...session.params, ...result.updatedParams };
    }

    const msg = result.message || '';

    // Detect completion — LLM mentions WhatsApp/PDF dispatch
    if (msg.toLowerCase().includes('whatsapp') || msg.toLowerCase().includes('pdf')) {
        twiml.say({ language: session.lang }, msg);
        twiml.say({ language: session.lang }, session.lang === 'th-TH'
            ? 'ขอบคุณที่ใช้บริการ ลาก่อนค่ะ'
            : 'Thank you for using AgriSpark. Goodbye!');
        twiml.hangup();
    } else {
        twiml.gather({
            input: 'speech',
            action: '/voice/detailed-plan-process',
            language: session.lang,
            speechTimeout: 'auto'
        }).say({ language: session.lang }, msg);
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

// ============================================
// WHATSAPP WEBHOOK
// ============================================

app.post('/whatsapp/chat', async (req, res) => {
    // FIX: Twilio sends urlencoded — bodyParser.urlencoded handles this above
    const textMsg = req.body.Body || '';
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const hasMedia = numMedia > 0;
    const isThai = /[\u0E00-\u0E7F]/.test(textMsg);
    const lang = isThai ? 'th-TH' : 'en-US';
    // FIX: pass the real Twilio media URL so Gemini can analyse the actual image
    const mediaUrl = hasMedia ? req.body.MediaUrl0 : null;

    try {
        const answer = await generateVisionDiagnostic(textMsg, hasMedia, lang, mediaUrl);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(answer);
        res.type('text/xml');
        res.send(twiml.toString());
    } catch (err) {
        console.error("WA Error:", err);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message('Sorry, something went wrong. Please try again.');
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

// ============================================
// REST API — trigger outbound call from UI
// ============================================

app.post('/api/call', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ success: false, error: 'Phone number required.' });
    try {
        const call = await client.calls.create({
            // FIX: BASE_URL is now a dedicated env var — reliable in both local and prod
            url: `${BASE_URL}/voice/entry`,
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER
        });
        res.json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error("Twilio call error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Export for Vercel, listen for local dev
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`\nAgriSpark running on port ${PORT}`);
        console.log(`Make sure BASE_URL in your .env points to your public ngrok/Vercel URL`);
        console.log(`Voice webhook: ${BASE_URL}/voice/entry`);
        console.log(`WhatsApp webhook: ${BASE_URL}/whatsapp/chat\n`);
    });
}

module.exports = app;
