require('dotenv').config();
const readline = require('readline');
const { generateQuickQueryResponse, generateDetailedPlanConversation, fetchLocalDataMock } = require('./services');
const { generatePlanPDF } = require('./pdf');
const path = require('path');
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const session = {
    lang: 'en-US',
    mode: null,
    params: {} // Mock memory context
};

console.log("==================================================");
console.log("      AgriSpark Call Simulator (CLI Testing)      ");
console.log("==================================================");

function promptUser(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function startCall() {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key') {
        console.log("\n[!] ERROR: Please set your actual GEMINI_API_KEY inside the .env file before running the simulator.");
        process.exit(1);
    }

    console.log("\n[Ringing... AgriSpark Answers]");
    const langChoice = await promptUser("▶ AgriSpark Voice: Welcome. For English press 1. สำหรับภาษาไทย กด 2.\n▶ You Dial: ");
    session.lang = langChoice === '2' ? 'th-TH' : 'en-US';

    const modePrompt = session.lang === 'en-US' 
        ? "▶ AgriSpark Voice: For a quick query, press 1. For a detailed farming plan, press 2." 
        : "▶ AgriSpark Voice: สำหรับคำถามด่วน กด 1. สำหรับแผนงานเพาะปลูกแบบละเอียด กด 2.";
        
    const modeChoice = await promptUser(modePrompt + "\n▶ You Dial: ");
    
    if (modeChoice === '1') {
        session.mode = 'quick';
        console.log(session.lang === 'en-US' ? '▶ AgriSpark Voice: Please say your question.' : '▶ AgriSpark Voice: กรุณาพูดคำถามค่ะ');
        await loopQuickQuery();
    } else if (modeChoice === '2') {
        session.mode = 'detailed';
        console.log(session.lang === 'en-US' ? '▶ AgriSpark Voice: Let us create a detailed plan. Please tell me your name.' : '▶ AgriSpark Voice: เราจะมาสร้างแผนการเพาะปลูกให้คุณนะคะ กรุณาบอกชื่อของคุณค่ะ');
        await loopDetailedPlan();
    } else {
        console.log("▶ [Call Dropped - Invalid Input]");
        process.exit();
    }
}

async function loopQuickQuery() {
    const userInput = await promptUser("\n> [Speak your question / Type 'hangup' to end call]: ");
    if (!userInput || userInput.toLowerCase() === 'hangup') {
        console.log("▶ [Call Ended]");
        process.exit(0);
    }
    
    console.log(`\n... (AgriSpark AI Generates Audio) ...`);
    const response = await generateQuickQueryResponse(userInput, session.lang);
    console.log(`▶ AgriSpark Synthesized Voice:\n"${response}"`);
    
    console.log(`\n▶ AgriSpark Voice: ${session.lang === 'en-US' ? 'Do you have another question?' : 'มีคำถามอื่นอีกไหมคะ'}`);
    await loopQuickQuery();
}

async function loopDetailedPlan() {
    const userInput = await promptUser("\n> [Your Reply / Type 'hangup' to end call]: ");
    if (!userInput || userInput.toLowerCase() === 'hangup') {
        console.log("▶ [Call Ended]");
        process.exit(0);
    }

    console.log(`\n... (AgriSpark AI Analyzing...) ...`);
    
    // Simulate injecting API data to give LLM hyper-local context
    if (!session.params.locationData) {
        session.params.locationData = await fetchLocalDataMock("Simulator GPS Trace Context");
    }

    const result = await generateDetailedPlanConversation(session.params, userInput, session.lang);
    const nextAgentResponse = result.message;
    
    // Persist the updated params in the session!
    if (result.updatedParams) {
        session.params = { ...session.params, ...result.updatedParams };
    }

    console.log(`▶ AgriSpark Synthesized Voice:\n"${nextAgentResponse}"`);

    // Check if the LLM outputted the trigger to send the PDF / whatsapp summary
    if (nextAgentResponse.toLowerCase().includes('whatsapp') || nextAgentResponse.toLowerCase().includes('pdf') || nextAgentResponse.toLowerCase().includes('sending')) {
        console.log("\n▶ [BACKGROUND EVENT]: Generating the professional AgriSpark 2.0 Master Plan PDF...");
        const pdfFile = path.join(__dirname, 'agrispark_master_plan.pdf');
        await generatePlanPDF(session.params, pdfFile);
        console.log(`▶ [SUCCESS]: PDF Master Plan generated at: ${pdfFile}`);
        console.log("▶ [BACKGROUND EVENT]: Simulated dispatching to Twilio WhatsApp and SMS...");
        console.log("▶ [Call Completing]");
        process.exit(0);
    } else {
        await loopDetailedPlan();
    }
}

startCall();
