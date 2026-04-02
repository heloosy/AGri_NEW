const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const { MASTER_PROMPT } = require('./prompts');

// NOTE: For @google/genai ^1.x, use GoogleGenerativeAI from '@google/generative-ai'
// OR use the correct method chain from '@google/genai'. This file uses the stable
// '@google/generative-ai' pattern which works reliably with the installed SDK.
// If you are on @google/genai (not @google/generative-ai), see comments below.

const apiKey = process.env.GEMINI_API_KEY;

// Helper: get a configured model instance
function getModel(modelName = 'gemini-2.5-flash', systemInstruction = MASTER_PROMPT) {
    if (!apiKey) return null;
    const genAI = new (require('@google/generative-ai').GoogleGenerativeAI)(apiKey);
    return genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction,
        generationConfig: { temperature: 0.7 }
    });
}

// Fetches a Twilio-hosted media file (image) as base64 so Gemini can see it
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
        const model = getModel('gemini-2.5-flash');
        const result = await model.generateContent(query);
        // FIX: response.text() is a METHOD in the stable SDK, not a property
        return result.response.text();
    } catch (e) {
        console.error("LLM Quick Query Error:", e);
        return lang === 'th-TH' ? `ระบบมีปัญหา: ${e.message}` : `System error: ${e.message}`;
    }
}

async function generateDetailedPlanConversation(params, recentUtterance, lang) {
    if (!apiKey) return { message: lang === 'th-TH' ? 'ระบบไม่พร้อมใช้งาน' : 'AI not initialized.', updatedParams: params };
    try {
        // FIX: key names aligned — we use 'soilType' and 'targetCrop' everywhere
        // so pdf.js and the LLM output agree on the same keys
        const progressContext = `CURRENT COLLECTED DATA:\n${JSON.stringify(params, null, 2)}\n`;
        const contentStr = `
MODE 2: Detailed Planning.
${progressContext}

The user just explicitly said: "${recentUtterance}".

Identify if any new information was shared (Name, Location, Past Crop, Current Idea, Soil Type, Terrain).
Update the JSON parameters accordingly.

When you have collected all 6 pieces of data (name, location, pastCrop, targetCrop, soilType, terrain),
also generate the following fields for the PDF:
- "marketInsight": A professional 2-sentence market strategy based on crop and location.
- "costStrategy": A specific tip to reduce input costs (fertilizers, seeds, etc).
- "laborForecast": Two upcoming dates where extra labor will be needed.
- "climateResilience": Specific mitigation advice based on current weather/satellite context.

Then, generate your natural, human-like response in ${lang === 'th-TH' ? 'Thai' : 'English'}.

IMPORTANT — Output ONLY valid JSON, no extra text or markdown fences:
{
  "message": "your conversational response string here",
  "updatedParams": {
    "name": "...",
    "location": "...",
    "pastCrop": "...",
    "targetCrop": "...",
    "soilType": "...",
    "terrain": "...",
    "marketInsight": "...",
    "costStrategy": "...",
    "laborForecast": "...",
    "climateResilience": "..."
  }
}
`;
        // FIX: use responseMimeType to force JSON output and avoid markdown fences
        const genAI = new (require('@google/generative-ai').GoogleGenerativeAI)(apiKey);
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
            systemInstruction: MASTER_PROMPT,
            generationConfig: {
                temperature: 0.7,
                responseMimeType: 'application/json'
            }
        });

        const result = await model.generateContent(contentStr);
        const text = result.response.text();

        // FIX: strip any accidental markdown fences before parsing
        const cleaned = text.replace(/```json|```/gi, '').trim();
        const parsed = JSON.parse(cleaned);
        return parsed;
    } catch (e) {
        console.error("LLM Detailed Plan Error:", e);
        return { message: `System error: ${e.message}`, updatedParams: params };
    }
}

async function generateVisionDiagnostic(textMsg, hasMedia, lang, mediaUrl = null) {
    if (!apiKey) return lang === 'th-TH' ? 'ระบบไม่พร้อมใช้งาน' : 'AI not initialized.';
    try {
        const promptText = hasMedia
            ? `[IMAGE DIAGNOSTICS REQUEST]. The user attached a photo of their crop. User text: "${textMsg}". Respond with a professional visual diagnostic in ${lang === 'th-TH' ? 'Thai' : 'English'}.`
            : `[STANDARD TEXT REQUEST]. The user asked: "${textMsg}". Answer in a helpful, structured format in ${lang === 'th-TH' ? 'Thai' : 'English'}.`;

        const parts = [{ text: promptText }];

        if (hasMedia && mediaUrl) {
            try {
                const imagePart = await getMediaPart(mediaUrl);
                parts.push(imagePart);
            } catch (imgErr) {
                console.error('Failed to fetch WhatsApp media image:', imgErr.message);
                // Continue with text-only if image fetch fails
            }
        }

        const model = getModel('gemini-2.5-flash');
        // FIX: pass parts array correctly
        const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
        return result.response.text();
    } catch (e) {
        console.error("LLM Vision Error:", e);
        return `System Error: ${e.message}`;
    }
}

async function fetchLocalDataMock(location) {
    await new Promise(r => setTimeout(r, 1200));
    return {
        weather: "Partly cloudy, 28°C. Expected heavy rainfall arriving in 48 hours.",
        satellite_agronomy: "NDVI 0.65 (moderate vigor). Soil moisture index is slightly deficient."
    };
}

module.exports = {
    generateQuickQueryResponse,
    generateDetailedPlanConversation,
    generateVisionDiagnostic,
    fetchLocalDataMock
};
