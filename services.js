const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { MASTER_PROMPT } = require('./prompts');

const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

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
    if (!ai) return lang === 'th-TH' ? 'ระบบไม่พร้อมใช้งาน - กรุณาตรวจสอบ API key' : 'AI not initialized. Check GEMINI_API_KEY.';
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            systemInstruction: { parts: [{ text: MASTER_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: query }] }],
            generationConfig: { temperature: 0.7 }
        });


        return response.text;

    } catch (e) {
        console.error("LLM Quick Query Error:", e);
        return lang === 'th-TH' ? `ระบบมีปัญหา: ${e.message}` : `System error: ${e.message}`;
    }

}

async function generateDetailedPlanConversation(params, recentUtterance, lang) {
    if (!ai) return { message: lang === 'th-TH' ? 'ระบบไม่พร้อมใช้งาน' : 'AI not initialized.', updatedParams: params };
    try {
        let progressContext = `CURRENT COLLECTED DATA:\n${JSON.stringify(params, null, 2)}\n`;
        const contentStr = `
MODE 2: Detailed Planning.
${progressContext}

The user just explicitly said: "${recentUtterance}".

Identify if any new information was shared (Name, Location, Past Crop, Current Idea, Soil, Terrain). Update the JSON parameters.

When you have collected all 6 pieces of data, also generate the following fields for the PDF:
- "marketInsight": A professional strategy based on crop and location.
- "costStrategy": A specific tip to reduce input costs (fertilizers, etc).
- "laborForecast": Dates for upcoming labor needs.
- "climateResilience": Specific mitigation advice based on injected data.

Then, generate your natural, human-like response in ${lang === 'th-TH' ? 'Thai' : 'English'}.

Output your response in valid JSON format ONLY:
{
  "message": "your conversational response string here",
  "updatedParams": { "name": "...", "location": "...", "pastCrop": "...", "currentIdea": "...", "soil": "...", "terrain": "...", "marketInsight": "...", "costStrategy": "...", "laborForecast": "...", "climateResilience": "..." }
}
`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            systemInstruction: { parts: [{ text: MASTER_PROMPT }] },

            contents: [{ role: 'user', parts: [{ text: contentStr }] }],

            generationConfig: { 
                temperature: 0.7,
                responseMimeType: "application/json"
            }
        });

        
        const result = JSON.parse(response.text);
        return result;
    } catch (e) {
         console.error("LLM Detailed Plan Error:", e);
         return { message: `System error: ${e.message}`, updatedParams: params };
    }

}

async function generateVisionDiagnostic(textMsg, hasMedia, lang, mediaUrl = null) {
    if (!ai) return lang === 'th-TH' ? 'ระบบไม่พร้อมใช้งาน' : 'AI not initialized.';
    try {
        const promptText = hasMedia 
            ? `[IMAGE DIAGNOSTICS REQUEST]. The user attached a photo of their crop. User text: "${textMsg}". Respond with a professional visual diagnostic and report findings in ${lang === 'th-TH' ? 'Thai' : 'English'}.`
            : `[STANDARD TEXT REQUEST]. The user asked: "${textMsg}". Answer in a highly structured, professional format in ${lang === 'th-TH' ? 'Thai' : 'English'}.`;

        // FIX: build content parts — include the real image if a URL was provided
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

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            systemInstruction: { parts: [{ text: MASTER_PROMPT }] },
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0.8 }
        });

        return response.text;

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
