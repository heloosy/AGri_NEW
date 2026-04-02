require('dotenv').config();
const express = require('express');
const path = require('path');
const twilio = require('twilio');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ── Safe lazy-load of Twilio client ─────────────────────────
function getTwilioClient() {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// ── Safe lazy-load of AI services ───────────────────────────
let services = null;
function getServices() {
    if (!services) {
        try {
            services = require('./services');
        } catch (e) {
            console.error('[AgriSpark] Failed to load services.js:', e.message);
        }
    }
    return services;
}

// ── Debug endpoint — visit this first to confirm server is up ─
app.get('/debug', (req, res) => {
    let sdkVersion = 'unknown';
    try {
        sdkVersion = require('@google/genai/package.json').version;
    } catch (_) {
        try { sdkVersion = require('@google/generative-ai/package.json').version; } catch (_2) {}
    }

    res.json({
        status: 'ok',
        gemini_key: process.env.GEMINI_API_KEY ? `set (${process.env.GEMINI_API_KEY.slice(0,6)}...)` : 'MISSING',
        twilio_sid: process.env.TWILIO_ACCOUNT_SID ? 'set' : 'MISSING',
        twilio_token: process.env.TWILIO_AUTH_TOKEN ? 'set' : 'MISSING',
        twilio_number: process.env.TWILIO_PHONE_NUMBER || 'MISSING',
        google_sdk_version: sdkVersion,
        base_url: BASE_URL,
        node_version: process.version,
        time: new Date().toISOString()
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ════════════════════════════════════════════════════════════
//  WHATSAPP — bulletproof, can never return 500
// ════════════════════════════════════════════════════════════
app.post('/whatsapp/chat', async (req, res) => {
    // Log raw body to Vercel logs so you can see exactly what Twilio sent
    console.log('[WA] body:', JSON.stringify(req.body));

    // Always send TwiML back — if AI fails, send a fallback message
    const respond = (text) => {
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(text);
        return res.type('text/xml').status(200).send(twiml.toString());
    };

    const textMsg  = (req.body.Body || '').trim();
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const hasMedia = numMedia > 0;
    const isThai   = /[\u0E00-\u0E7F]/.test(textMsg);
    const lang     = isThai ? 'th-TH' : 'en-US';
    const mediaUrl = hasMedia ? req.body.MediaUrl0 : null;

    // If no GEMINI key — still reply so Twilio gets a 200
    if (!process.env.GEMINI_API_KEY) {
        return respond('AgriSpark: GEMINI_API_KEY is not configured on the server. Please set it in Vercel environment variables.');
    }

    const svc = getServices();
    if (!svc) {
        return respond('AgriSpark: Failed to load AI module. Check Vercel function logs for import errors.');
    }

    try {
        const answer = await svc.generateVisionDiagnostic(textMsg, hasMedia, lang, mediaUrl);
        return respond(answer || 'AgriSpark received your message but got an empty response.');
    } catch (err) {
        console.error('[WA] generateVisionDiagnostic threw:', err.message, err.stack);
        return respond(`AgriSpark error: ${err.message}`);
    }
});

// ════════════════════════════════════════════════════════════
//  VOICE ROUTES
// ════════════════════════════════════════════════════════════
const callMemory = {};
function getSession(callSid) {
    if (!callMemory[callSid]) callMemory[callSid] = { params: {}, mode: null, lang: 'en-US' };
    return callMemory[callSid];
}

app.post('/voice/entry', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const g = twiml.gather({ numDigits: 1, action: '/voice/language-selection', method: 'POST' });
    g.say('Welcome to AgriSpark. For English, press 1. สำหรับภาษาไทย กด 2.');
    twiml.redirect('/voice/entry');
    res.type('text/xml').send(twiml.toString());
});

app.post('/voice/language-selection', (req, res) => {
    const langCode = req.body.Digits === '2' ? 'th-TH' : 'en-US';
    getSession(req.body.CallSid).lang = langCode;
    const twiml = new twilio.twiml.VoiceResponse();
    const g = twiml.gather({ numDigits: 1, action: '/voice/mode-selection', method: 'POST' });
    g.say({ language: langCode }, langCode === 'th-TH'
        ? 'สำหรับคำถามด่วน กด 1. สำหรับแผนงานเพาะปลูกแบบละเอียด กด 2.'
        : 'For a quick query, press 1. For a detailed farming plan, press 2.');
    twiml.redirect('/voice/language-selection');
    res.type('text/xml').send(twiml.toString());
});

app.post('/voice/mode-selection', (req, res) => {
    const session = getSession(req.body.CallSid);
    const twiml = new twilio.twiml.VoiceResponse();
    if (req.body.Digits === '1') {
        session.mode = 'quick';
        twiml.gather({ input: 'speech', action: '/voice/quick-query-answer', language: session.lang, speechTimeout: 'auto' })
            .say({ language: session.lang }, session.lang === 'th-TH' ? 'กรุณาพูดคำถามค่ะ' : 'Please say your farming question.');
    } else if (req.body.Digits === '2') {
        session.mode = 'detailed';
        twiml.gather({ input: 'speech', action: '/voice/detailed-plan-process', language: session.lang, speechTimeout: 'auto' })
            .say({ language: session.lang }, session.lang === 'th-TH' ? 'กรุณาบอกชื่อของคุณค่ะ' : 'Great! Please tell me your name.');
    } else {
        twiml.say('Invalid choice.'); twiml.redirect('/voice/entry');
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/voice/quick-query-answer', async (req, res) => {
    const session = getSession(req.body.CallSid);
    const speech  = req.body.SpeechResult;
    const twiml   = new twilio.twiml.VoiceResponse();
    const voiceFallback = session.lang === 'th-TH' ? 'ระบบมีปัญหา กรุณาลองใหม่อีกครั้ง' : 'Sorry, there was an error. Please try again.';
    if (speech) {
        let answer = voiceFallback;
        try {
            const svc = getServices();
            if (svc) answer = await svc.generateQuickQueryResponse(speech, session.lang);
        } catch (e) { console.error('[VOICE-Q]', e.message); }
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
    let msg = session.lang === 'th-TH' ? 'ระบบมีปัญหา กรุณาลองใหม่' : 'Sorry, there was an error.';
    try {
        const svc = getServices();
        if (svc) {
            const result = await svc.generateDetailedPlanConversation(session.params, speech, session.lang);
            if (result.updatedParams) session.params = { ...session.params, ...result.updatedParams };
            msg = result.message || msg;
        }
    } catch (e) { console.error('[VOICE-D]', e.message); }

    if (msg.toLowerCase().includes('whatsapp') || msg.toLowerCase().includes('pdf')) {
        twiml.say({ language: session.lang }, msg);
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
    const client = getTwilioClient();
    if (!client) return res.status(500).json({ success: false, error: 'Twilio not configured.' });
    try {
        const call = await client.calls.create({ url: `${BASE_URL}/voice/entry`, to: phoneNumber, from: process.env.TWILIO_PHONE_NUMBER });
        res.json({ success: true, callSid: call.sid });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`AgriSpark on http://localhost:${PORT}`));
}
module.exports = app;
