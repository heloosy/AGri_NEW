const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { MASTER_PROMPT } = require('./prompts');

const apiKey = process.env.GEMINI_API_KEY;

function getAI() {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
    return new GoogleGenAI({ apiKey });
}

// Fetches a Twilio-hosted media file as base64
async function getMediaPart(url) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN
        }
    });
    return {
        inlineData: {
            data: Buffer.from(response.data).toString('base64'),
            mimeType: response.headers['content-type'] || 'image/jpeg'
        }
    };
}

async function generateQuickQueryResponse(query, lang) {
    if (!apiKey) return lang === 'th-TH' ? 'ระบบไม่พร้อมใช้งาน - กรุณาตรวจสอบ API key' : 'AI not initialized. Check GEMINI_API_KEY.';
    try {
        const ai = getAI();
        // @google/genai v1.x correct usage
        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',   // use 2.0-flash — widely available on free tier
            contents: query,             // simple string shorthand works for single-turn
            config: {
                systemInstruction: MASTER_PROMPT,
                temperature: 0.7
            }
        });
        return response.text;
    } catch (e) {
        console.error('LLM Quick Query Error:', e);
        return lang === 'th-TH' ? `ระบบมีปัญหา: ${e.message}` : `System error: ${e.message}`;
    }
}

async function generateDetailedPlanConversation(params, recentUtterance, lang) {
    if (!apiKey) return { message: 'AI not initialized.', updatedParams: params };
    try {
        const progressContext = `CURRENT COLLECTED DATA:\n${JSON.stringify(params, null, 2)}\n`;
        const contentStr = `
MODE 2: Detailed Planning.
${progressContext}

The user just said: "${recentUtterance}".

Identify any new info (name, location, pastCrop, targetCrop, soilType, terrain).
When all 6 are collected, also add: marketInsight, costStrategy, laborForecast, climateResilience.
Respond in ${lang === 'th-TH' ? 'Thai' : 'English'}.

Return ONLY valid JSON (no markdown fences):
{
  "message": "your conversational response",
  "updatedParams": {
    "name": "...", "location": "...", "pastCrop": "...",
    "targetCrop": "...", "soilType": "...", "terrain": "...",
    "marketInsight": "...", "costStrategy": "...",
    "laborForecast": "...", "climateResilience": "..."
  }
}`;

        const ai = getAI();
        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: contentStr,
            config: {
                systemInstruction: MASTER_PROMPT,
                temperature: 0.7,
                responseMimeType: 'application/json'
            }
        });

        const text = response.text.replace(/```json|```/gi, '').trim();
        return JSON.parse(text);
    } catch (e) {
        console.error('LLM Detailed Plan Error:', e);
        return { message: `System error: ${e.message}`, updatedParams: params };
    }
}

async function generateVisionDiagnostic(textMsg, hasMedia, lang, mediaUrl = null) {
    if (!apiKey) return lang === 'th-TH' ? 'ระบบไม่พร้อมใช้งาน' : 'AI not initialized.';
    try {
        const promptText = hasMedia
            ? `[IMAGE DIAGNOSTICS]. User sent a photo of their crop. Text: "${textMsg}". Give a professional visual diagnostic in ${lang === 'th-TH' ? 'Thai' : 'English'}.`
            : `[TEXT REQUEST]. User asked: "${textMsg}". Answer helpfully in ${lang === 'th-TH' ? 'Thai' : 'English'}.`;

        // Build contents array — text first, image second if present
        const parts = [{ text: promptText }];
        if (hasMedia && mediaUrl) {
            try {
                const imagePart = await getMediaPart(mediaUrl);
                parts.push(imagePart);
            } catch (imgErr) {
                console.error('Failed to fetch WhatsApp image:', imgErr.message);
            }
        }

        const ai = getAI();
        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: [{ role: 'user', parts }],
            config: {
                systemInstruction: MASTER_PROMPT,
                temperature: 0.8
            }
        });

        return response.text;
    } catch (e) {
        console.error('LLM Vision Error:', e);
        return `System Error: ${e.message}`;
    }
}

async function fetchLocalDataMock(location) {
    await new Promise(r => setTimeout(r, 500));
    return {
        weather: 'Partly cloudy, 28°C. Expected heavy rainfall in 48 hours.',
        satellite_agronomy: 'NDVI 0.65 (moderate vigor). Soil moisture slightly deficient.'
    };
}

module.exports = {
    generateQuickQueryResponse,
    generateDetailedPlanConversation,
    generateVisionDiagnostic,
    fetchLocalDataMock
};
