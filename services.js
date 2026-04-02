const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { MASTER_PROMPT } = require('./prompts');

// Initialise once — throws clearly if key is missing
function getAI() {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY env var is not set');
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

// @google/genai v1.x correct call — config key, NOT generationConfig
async function callGemini(prompt, opts = {}) {
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: prompt,          // string shorthand for single-turn
        config: {
            systemInstruction: MASTER_PROMPT,
            temperature: opts.temperature ?? 0.7,
            ...(opts.json ? { responseMimeType: 'application/json' } : {})
        }
    });
    // In @google/genai v1.x, response.text is a PROPERTY (string), not a method
    return response.text;
}

// Fetches Twilio media as base64 for vision requests
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
    try {
        return await callGemini(query);
    } catch (e) {
        console.error('[services] generateQuickQueryResponse error:', e.message);
        return lang === 'th-TH' ? `ระบบมีปัญหา: ${e.message}` : `System error: ${e.message}`;
    }
}

async function generateDetailedPlanConversation(params, recentUtterance, lang) {
    try {
        const prompt = `
MODE 2: Detailed Planning.
CURRENT DATA: ${JSON.stringify(params)}

User just said: "${recentUtterance}"

Collect missing fields one at a time: name, location, pastCrop, targetCrop, soilType, terrain.
When all 6 collected, add: marketInsight, costStrategy, laborForecast, climateResilience.
Respond in ${lang === 'th-TH' ? 'Thai' : 'English'}.

Return ONLY valid JSON (no markdown):
{"message":"...","updatedParams":{"name":"","location":"","pastCrop":"","targetCrop":"","soilType":"","terrain":"","marketInsight":"","costStrategy":"","laborForecast":"","climateResilience":""}}`;

        const text = await callGemini(prompt, { json: true });
        const cleaned = text.replace(/```json|```/gi, '').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        console.error('[services] generateDetailedPlanConversation error:', e.message);
        return { message: `Error: ${e.message}`, updatedParams: params };
    }
}

async function generateVisionDiagnostic(textMsg, hasMedia, lang, mediaUrl = null) {
    try {
        const ai = getAI();
        const promptText = hasMedia
            ? `[IMAGE DIAGNOSTICS] User photo of crop. Text: "${textMsg}". Diagnose in ${lang === 'th-TH' ? 'Thai' : 'English'}.`
            : `[TEXT] User asked: "${textMsg}". Answer in ${lang === 'th-TH' ? 'Thai' : 'English'}.`;

        const parts = [{ text: promptText }];

        if (hasMedia && mediaUrl) {
            try {
                parts.push(await getMediaPart(mediaUrl));
            } catch (imgErr) {
                console.error('[services] image fetch failed:', imgErr.message);
            }
        }

        // Multi-part needs the full contents array format
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
        console.error('[services] generateVisionDiagnostic error:', e.message);
        return lang === 'th-TH' ? `ระบบมีปัญหา: ${e.message}` : `System error: ${e.message}`;
    }
}

async function fetchLocalDataMock() {
    return {
        weather: 'Partly cloudy, 28°C. Heavy rainfall in 48 hours.',
        satellite_agronomy: 'NDVI 0.65. Soil moisture slightly deficient.'
    };
}

module.exports = { generateQuickQueryResponse, generateDetailedPlanConversation, generateVisionDiagnostic, fetchLocalDataMock };
