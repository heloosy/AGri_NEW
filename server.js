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
const REQUIRED_ENV = ['GEMINI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
    console.error(`\n[AgriSpark] FATAL: Missing required environment variables:\n  ${missing.join(', ')}\nPlease copy .env.example to .env and fill in your values.\n`);
    process.exit(1);
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PORT = process.env.PORT || 3000;

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
    let langCode = digits === '2' ? 'th-TH' : 'en-US';
    getSession(callSid).lang = langCode;
    const gather = twiml.gather({ numDigits: 1, action: `/voice/mode-selection`, method: 'POST' });
    if (langCode === 'th-TH') {
        gather.say({ language: langCode }, 'สำหรับคำถามด่วน กด 1. สำหรับแผนงานเพาะปลูกแบบละเอียด กด 2.');
    } else {
        gather.say({ language: langCode }, 'For a quick query, press 1. For a detailed farming plan, press 2.');
    }
    twiml.redirect(`/voice/language-selection`);
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
        twiml.say({ language: session.lang }, session.lang === 'th-TH' ? 'กรุณาพูดคำถามของคุณหลังเสียงสัญญาณค่ะ' : 'Please say your question after the beep.');
        twiml.record({ action: `/voice/quick-query-process`, maxLength: 30, playBeep: true, transcribe: true });
    } else if (digits === '2') {
        session.mode = 'detailed';
        twiml.say({ language: session.lang }, session.lang === 'th-TH' ? 'เราจะมาสร้างแผนการเพาะปลูกให้คุณนะคะ กรุณาบอกชื่อของคุณค่ะ' : 'Let us create a detailed plan. Please tell me your name.');
        twiml.record({ action: `/voice/detailed-plan-process`, maxLength: 15, playBeep: true, transcribe: true });
    } else {
        twiml.say({ language: session.lang }, 'Invalid choice.');
        twiml.redirect('/voice/entry');
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/quick-query-process', async (req, res) => {
    const session = getSession(req.body.CallSid);
    const twiml = new twilio.twiml.VoiceResponse();
    // FIX: use the correct language for this message
    const analyzingMsg = session.lang === 'th-TH' ? 'กรุณารอสักครู่ กำลังวิเคราะห์คำถามของคุณค่ะ' : 'Analyzing your question, please wait.';
    twiml.say({ language: session.lang }, analyzingMsg);
    twiml.redirect('/voice/quick-query-gather');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/quick-query-gather', (req, res) => {
    const session = getSession(req.body.CallSid);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.gather({
        input: 'speech',
        action: '/voice/quick-query-answer',
        language: session.lang,
        speechTimeout: 'auto'
    }).say({ language: session.lang }, session.lang === 'th-TH' ? 'กรุณาพูดคำถามค่ะ' : 'I am listening.');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/quick-query-answer', async (req, res) => {
    const session = getSession(req.body.CallSid);
    const speechResult = req.body.SpeechResult;
    const twiml = new twilio.twiml.VoiceResponse();
    if (speechResult) {
        const answer = await generateQuickQueryResponse(speechResult, session.lang);
        twiml.say({ language: session.lang }, answer);
        twiml.gather({
            input: 'speech',
            action: '/voice/quick-query-answer',
            language: session.lang,
            speechTimeout: 'auto'
        }).say({ language: session.lang }, session.lang === 'th-TH' ? 'มีคำถามอื่นอีกไหมคะ?' : 'Do you have another question?');
    } else {
        twiml.redirect('/voice/quick-query-gather');
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/detailed-plan-process', async (req, res) => {
    const session = getSession(req.body.CallSid);
    const speechResult = req.body.SpeechResult || 'Unknown response';
    const twiml = new twilio.twiml.VoiceResponse();
    const result = await generateDetailedPlanConversation(session.params, speechResult, session.lang);

    // FIX: persist the updated farmer params back into the session so data
    // is not lost between turns (this was the main reason collection never completed)
    if (result.updatedParams) {
        session.params = { ...session.params, ...result.updatedParams };
    }

    if (result.message.toLowerCase().includes('whatsapp') || result.message.toLowerCase().includes('pdf')) {
        twiml.say({ language: session.lang }, result.message);
        twiml.say({ language: session.lang }, session.lang === 'th-TH' ? 'ขอบคุณที่ใช้บริการ ลาก่อนค่ะ' : 'Thank you for using AgriSpark. Goodbye.');
        twiml.hangup();
    } else {
        const gather = twiml.gather({
            input: 'speech',
            action: '/voice/detailed-plan-process',
            language: session.lang,
            speechTimeout: 'auto'
        });
        gather.say({ language: session.lang }, result.message);
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/whatsapp/chat', async (req, res) => {
    const textMsg = req.body.Body || '';
    const numMedia = parseInt(req.body.NumMedia || 0);
    const hasMedia = numMedia > 0;
    const isThai = /[\u0E00-\u0E7F]/.test(textMsg);
    const lang = isThai ? 'th-TH' : 'en-US';

    // FIX: pass the actual media URL so Gemini can analyse the real image
    // Twilio provides MediaUrl0, MediaUrl1, etc. for each attachment
    const mediaUrl = hasMedia ? req.body.MediaUrl0 : null;
    
    try {
        const answer = await generateVisionDiagnostic(textMsg, hasMedia, lang, mediaUrl);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(answer);
        res.type('text/xml');
        res.send(twiml.toString());
    } catch (err) {
        console.error("WA Error:", err);
        res.status(500).send("Error");
    }
});

app.post('/api/call', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ success: false, error: 'Phone number required.' });
    try {
        const call = await client.calls.create({
            url: `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/voice/entry`,
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER
        });
        res.json({ success: true, callSid: call.sid });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Export for Vercel, listen for Local
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`AgriSpark running on port ${PORT}`));
}
module.exports = app;
