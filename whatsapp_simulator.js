require('dotenv').config();
const readline = require('readline');
const { generateVisionDiagnostic } = require('./services');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log("==================================================");
console.log("      AgriSpark WhatsApp Simulator (CLI)         ");
console.log("==================================================");
console.log("Type your message below. To simulate an image, start your message with '[IMAGE]'.");
console.log("Type 'exit' to quit.\n");

function promptUser() {
    rl.question("User: ", async (input) => {
        if (input.toLowerCase() === 'exit') {
            process.exit(0);
        }

        if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key') {
            console.log("\n[!] ERROR: Please set your actual GEMINI_API_KEY inside the .env file.\n");
            return promptUser();
        }

        const hasMedia = input.toUpperCase().startsWith('[IMAGE]');
        const textMsg = hasMedia ? input.substring(7).trim() : input;
        
        // Auto-detect Thai characters
        const isThai = /[\u0E00-\u0E7F]/.test(textMsg);
        const lang = isThai ? 'th-TH' : 'en-US';

        console.log(`... (AgriSpark AI Thinking in ${isThai ? 'Thai' : 'English'}...) ...`);

        try {
            const response = await generateVisionDiagnostic(textMsg, hasMedia, lang);
            console.log("\nAgriSpark WhatsApp Bot:");
            console.log("-----------------------");
            console.log(response);
            console.log("-----------------------\n");
        } catch (e) {
            console.error("WhatsApp Simulation Error:", e);
        }

        promptUser();
    });
}

promptUser();
