const { GoogleGenerativeAI } = require("@google/generative-ai");

const API_KEY = "AIzaSyD7OCh4_RMe4-aIxLrBQ3ecRYyx1Qnjv-4";
const genAI = new GoogleGenerativeAI(API_KEY);

async function listModels() {
    try {
        // For the Node SDK, we might not have a direct 'listModels' method exposed easily on the top level 
        // in older versions, but let's try the standard way if available or just test a few.
        // Actually, the SDK doesn't always expose listModels directly in the main helper.
        // Let's try a direct fetch to the REST API to be sure, as it's dependency-free logic-wise.

        // Using fetch (Node 18+)
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
        const data = await response.json();

        if (data.error) {
            console.error("API Error:", data.error);
        } else {
            console.log("Available Models:");
            if (data.models) {
                data.models.forEach(m => {
                    if (m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent")) {
                        console.log(`- ${m.name}`);
                    }
                });
            } else {
                console.log("No models found in response.");
            }
        }
    } catch (error) {
        console.error("Network Error:", error);
    }
}

listModels();
