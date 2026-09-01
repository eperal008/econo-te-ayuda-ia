const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { WebSocketServer } = require("ws"); // Correctly declared once
const { SpeechClient } = require("@google-cloud/speech").v1p1beta1;
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const { Pool } = require("pg");
const { OpenAI } = require("openai");
const dotenv = require("dotenv");
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
let dynamicProductCategories = [];
const axios = require('axios');
const PDFDocument = require('pdfkit');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Google Cloud clients
let speechClient;
let ttsClient;
try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    speechClient = new SpeechClient({ credentials });
    ttsClient = new TextToSpeechClient({ credentials });
    console.log("Google Cloud STT and TTS clients initialized.");
} catch (err) {
    console.error("FATAL ERROR during Google Cloud client setup:", err.message);
    process.exit(1);
}

// Initialize PostgreSQL client
const dbClient = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const loadDynamicCategories = async () => {
    try {
        console.log("Loading dynamic product categories from database...");
        // This SQL query selects every unique category from your products table.
        const { rows } = await dbClient.query("SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category ASC;");

        // We extract just the category name from each row and store it in our variable.
        dynamicProductCategories = rows.map(row => row.category);

        console.log(`Successfully loaded ${dynamicProductCategories.length} unique categories.`);
    } catch (err) {
        console.error("FATAL ERROR: Could not load dynamic categories from database. The bot will not have category knowledge.", err);
        // In a production environment, you might want the server to stop if this fails.
        // For now, we just log a fatal error.
        // process.exit(1);
    }
};

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- CLOUDINARY CONFIGURATION ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure multer storage for Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'product_ads', // A folder name in your Cloudinary account to keep things organized
    allowed_formats: ['jpg', 'png', 'jpeg', 'gif'],
    transformation: [{ width: 500, height: 500, crop: 'limit' }] // Optional: resize images
  },
});

const parser = multer({ storage: storage });

// CORS configuration
// CORS configuration
const corsOptions = {
    origin: (origin, callback) => {
        const allowedOrigins = [
            "http://localhost:3000",
            "http://localhost:3001",
            "https://kiosk-trial.netlify.app",
            "https://capriteayuda.com",
            "https://capriteayuda-admin.netlify.app",
            "http://127.0.0.1:5500",
            "http://localhost:5500"
            
        ];
        // The '|| !origin' part allows requests with no origin (like Postman or mobile apps)
        if (allowedOrigins.includes(origin) || !origin) {
            callback(null, true);
        } else {
            console.error(`CORS check: Origin '${origin}' NOT ALLOWED.`);
            callback(new Error("Not allowed by CORS"));
        }
    },
    methods: ["GET", "POST", "DELETE", "PUT", "OPTIONS"],
    // START: ADD 'x-api-key' TO THE LIST OF ALLOWED HEADERS
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
    // END: ADD 'x-api-key'
    credentials: true,
    optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Middleware
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));


// --- STORE INFO TOPICS FOR LLM1 (MUST MATCH 'info_key's IN YOUR 'store_general_info' TABLE) ---
const STORE_INFO_TYPES_FOR_LLM1 = [
    "store_hours",        // From your DB screenshot
    "bathroom_location",  // From your DB screenshot (singular)
    "detergent_info",     // From your DB screenshot (was detergents_location)
    "pillows_cushions",   // From your DB screenshot (was pillows_cushions_location)
    "kitchen_towels",     // From your DB screenshot (was kitchen_towels_location)
    "gym_towels",         // From your DB screenshot (was gym_towels_location)
    "bath_towels",        // From your DB screenshot (was bath_towels_location)
    "curtains",           // From your DB screenshot (was curtains_location)
    "bedspreads",         // From your DB screenshot (was bedspreads_location)
    "bed_sheets",         // From your DB screenshot (was bed_sheets_location)
    "bath_mats"           // From your DB screenshot (was bath_mats_location)
];

// WebSocket for STT (This section should be correct from previous iterations)
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
    const connectionTime = new Date().toISOString();
    console.log(`[${connectionTime}] Client connected via WebSocket ip:`, req.socket.remoteAddress);
    let recognizeStream = null;
    let languageCode = "en-US"; 

    ws.isAlive = true;
    const pingInterval = setInterval(() => {
        if (ws.isAlive === false) {
            console.log(`[${new Date().toISOString()}] Terminating WebSocket due to missed pong.`);
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        ws.ping();
    }, 30000);

    ws.on("pong", () => { ws.isAlive = true; });

    const initializeSTTStream = () => {
        const creationTime = new Date().toISOString();
        console.log(`[${creationTime}] Attempting to initialize STT stream with language: ${languageCode}`);
        if (recognizeStream) {
            console.warn(`[${creationTime}] initializeSTTStream called when recognizeStream already exists. Ending previous stream first.`);
            recognizeStream.removeAllListeners(); 
            recognizeStream.destroy(); 
            recognizeStream = null;
        }
        recognizeStream = speechClient.streamingRecognize({
            config: {
                encoding: "WEBM_OPUS",
                sampleRateHertz: 48000,
                languageCode: languageCode,
                enableAutomaticPunctuation: true,

                // --- Recommended STT Enhancements for Grocery Store Use Case ---

                // Option 1: Try this first by itself. Often very effective.
                useEnhanced: true,

                // Option 2: If useEnhanced (on default model) isn't enough,
                // you might try specifying a model. 'command_and_search' is a strong candidate.
                // Comment out 'useEnhanced: true' if you specify a model like 'command_and_search'
                // unless the documentation for that specific model indicates compatibility.
                // model: 'command_and_search', // OR 'latest_short'

                // Option 3: Add metadata to help Google's model selection and processing.
                // This can be used WITH useEnhanced: true OR with a specified model.
                metadata: {
                    interactionType: 'VOICE_SEARCH', // Most relevant for your app
                    microphoneDistance: 'NEARFIELD', // User speaking close to the phone
                    recordingDeviceType: 'SMARTPHONE',
                    // originalMediaType: 'audio/webm', // Optional, but can be helpful
                    // audioTopic: 'Grocery product search query' // Free-form description
                },

                // Option 4: Speech Adaptation (more advanced, but powerful)
                // Create phrase sets for common product categories, brands, or difficult terms.
                // You would define these phraseSet resources in your Google Cloud project
                // or provide them inline if they are small and dynamic.
                // Example of inline (for small, less frequently changing lists):
                /*
                adaptation: {
                    phraseSets: [{
                        phraseSet: {
                            boost: 10, // How much more likely these phrases are
                            phrases: [
                                { value: "air freshener" },
                                { value: "Aromatizantes en spray" },
                                { value: "toothpaste" },
                                { value: "Pasta dental" },
                                // Add more key terms, brand names, product categories
                                // Consider adding the items from your PRODUCT_CATEGORIES_FOR_LLM1 here
                            ]
                        }
                    }]
                    // To use pre-configured PhraseSet resources:
                    // phraseSetReferences: ["projects/YOUR_PROJECT_ID/locations/global/phraseSets/YOUR_PHRASE_SET_ID"]
                },
                */

                // --- End STT Enhancements ---
            },
            interimResults: true,
        })
        .on("error", (err) => {
            const errorTime = new Date().toISOString();
            console.error(`[${errorTime}] STT recognizeStream Error: Code ${err.code || 'N/A'}, Message: ${err.message}`);
            if (ws.readyState === 1) { // 1 means WebSocket.OPEN
                ws.send(JSON.stringify({ type: "error", message: `STT Service Error: ${err.message} (Code: ${err.code || 'N/A'})` }));
            }
            if (recognizeStream) {
                recognizeStream.removeAllListeners();
                recognizeStream.destroy();
            }
            recognizeStream = null;
        })
        .on("data", (data) => {
            const dataTime = new Date().toISOString();
            if (data.results[0]?.isFinal) {
                const transcript = data.results[0].alternatives[0].transcript;
                console.log(`[${dataTime}] STT Final Transcript: ${transcript}`);
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: "final_transcript", transcript }));
                }
            } else if (data.results[0]) {
                const transcript = data.results[0].alternatives[0].transcript;
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: "interim_transcript", transcript }));
                }
            }
        })
        .on("end", () => {
            const endTime = new Date().toISOString();
            console.log(`[${endTime}] STT recognizeStream 'end' event received.`);
            recognizeStream = null;
            if (ws && ws.readyState === 1) { // Check ws still exists
                console.log(`[${endTime}] STT stream processing finished. Server is closing WebSocket for this client (Code 1000).`);
                ws.close(1000, "STT_PROCESSING_COMPLETE");
            }
        });
        console.log(`[${creationTime}] STT stream initialized and handlers attached.`);
    };

    initializeSTTStream();

    ws.on("message", async (message) => {
        const currentTime = new Date().toISOString();
        console.log(`[${currentTime}] Raw message received. Type: ${typeof message}, Is Buffer: ${Buffer.isBuffer(message)}, Length: ${message.length}`);
        if (Buffer.isBuffer(message) && message.length < 200 && message.length > 0) {
            try {
                const potentialString = message.toString('utf8');
                if ((potentialString.startsWith('{') && potentialString.endsWith('}')) || (potentialString.startsWith('[') && potentialString.endsWith(']'))) {
                     console.log(`[${currentTime}] Raw Buffer message (decoded as string): ${potentialString}`);
                }
            } catch (e) { /* ignore logging error */ }
        }

        let parsedJsonMessage;
        let isStringControlMessage = false;

        if (Buffer.isBuffer(message)) {
            const receivedString = message.toString('utf8');
            try {
                parsedJsonMessage = JSON.parse(receivedString);
                if (typeof parsedJsonMessage.type === 'string') {
                     isStringControlMessage = true;
                     console.log(`[${currentTime}] Successfully parsed Buffer as JSON control message:`, parsedJsonMessage);
                } else {
                    console.log(`[${currentTime}] Buffer parsed as JSON but not a known control type. Treating as binary. Size: ${message.length}`);
                }
            } catch (e) { /* Not a JSON string, assume binary audio */ }
        } else if (typeof message === "string") {
            try {
                parsedJsonMessage = JSON.parse(message);
                isStringControlMessage = true;
                console.log(`[${currentTime}] Successfully parsed String as JSON control message:`, parsedJsonMessage);
            } catch (e) {
                console.error(`[${currentTime}] Error parsing incoming string message directly as JSON: "${message}". Error: ${e.message}`);
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: "error", message: "Malformed JSON command received from client." }));
                }
                return; 
            }
        } else {
            console.warn(`[${currentTime}] Received message of unexpected type: ${typeof message}. Discarding.`);
            return;
        }

        if (isStringControlMessage) {
            if (parsedJsonMessage.type === "config" && typeof parsedJsonMessage.language === 'string') {
                console.log(`[${currentTime}] Processing 'config' message:`, parsedJsonMessage);
                const newLangCode = parsedJsonMessage.language === "es" ? "es-US" : "en-US";
                if (newLangCode !== languageCode) {
                    console.log(`[${currentTime}] Language change detected to: ${newLangCode}. Re-initializing STT stream.`);
                    languageCode = newLangCode;
                    initializeSTTStream();
                } else {
                    console.log(`[${currentTime}] Config message received, language unchanged: ${languageCode}`);
                }
            } else if (parsedJsonMessage.type === "EOS") {
                console.log(`[${currentTime}] Processing 'EOS' signal.`);
                if (recognizeStream) {
                    console.log(`[${currentTime}] Calling recognizeStream.end() due to client EOS.`);
                    recognizeStream.end(); 
                } else {
                    console.warn(`[${currentTime}] EOS received, but no active STT stream.`);
                }
            } else {
                console.warn(`[${currentTime}] Received and parsed JSON message with unknown 'type':`, parsedJsonMessage);
            }
        } else if (Buffer.isBuffer(message)) { 
            if (recognizeStream) {
                try {
                    recognizeStream.write(message);
                } catch (writeError) {
                    console.error(`[${currentTime}] Error writing audio to STT recognizeStream:`, writeError.message);
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({ type: "error", message: `Server STT Write Error: ${writeError.message}` }));
                    }
                    if (recognizeStream) {
                       recognizeStream.removeAllListeners();
                       recognizeStream.destroy();
                    }
                    recognizeStream = null;
                }
            } else {
                console.warn(`[${currentTime}] Audio data (Buffer, size ${message.length}) received, but NO active STT stream. Discarding audio.`);
            }
        }
    });

    ws.on("close", (code, reason) => {
        const closeTime = new Date().toISOString();
        console.log(`[${closeTime}] WebSocket connection closed. Code: ${code}, Reason: '${reason.toString()}'. recognizeStream active: ${!!recognizeStream}`);
        clearInterval(pingInterval);
        if (recognizeStream) {
            console.log(`[${closeTime}] WebSocket closed. Ending STT stream.`);
            recognizeStream.removeAllListeners();
            recognizeStream.destroy();
            recognizeStream = null;
        }
    });

    ws.on("error", (err) => {
        const errorTime = new Date().toISOString();
        console.error(`[${errorTime}] WebSocket error:`, err.message);
        clearInterval(pingInterval);
        if (recognizeStream) {
            console.error(`[${errorTime}] WebSocket error. Destroying STT stream.`);
            recognizeStream.removeAllListeners();
            recognizeStream.destroy();
            recognizeStream = null;
        }
    });
});


// Replace your existing app.post("/ask", ...) with this:
app.post("/ask", cors(corsOptions), async (req, res) => {
    const requestTimestamp = new Date().toISOString();
    // 1. Destructure previousDescription from req.body
    const { query, language, image, previousDescription, conversationHistory = [] } = req.body; //updated to store conversational history
    const effectiveQuery = query?.trim() || ""; // The current spoken question or typed query
    const langCode = language === "es" ? "es" : "en";

    console.log(`[${requestTimestamp}] Received /ask request. Query: "${effectiveQuery}", Language: ${langCode}, Image present: ${!!image}, PreviousDescription received: ${!!previousDescription}`);
    console.log(`[<span class="math-inline">\{requestTimestamp\}\] Received /ask request\. Query\: "</span>{effectiveQuery}", Language: ${langCode}, Image present: ${!!image}, PreviousDescription received: ${!!previousDescription}`);
    if (previousDescription) {
        console.log(`[${requestTimestamp}] PreviousDescription content (first 100 chars): "${String(previousDescription).substring(0, 100)}..."`);
        console.log(`[<span class="math-inline">\{requestTimestamp\}\] PreviousDescription content \(first 100 chars\)\: "</span>{String(previousDescription).substring(0, 100)}..."`);
    }

    // If no current query, no new image, and no previous context, it's an invalid request.
    if (!effectiveQuery && !image && !previousDescription) {
        console.warn(`[${requestTimestamp}] Empty query, no image, and no previous description received.`);
        return res.status(400).json({ 
            reply: langCode === "es" ? "Por favor, haz una pregunta o envía una imagen." : "Please ask a question or send an image.", 
            products: [] 
        });
    }

    let llm1Analysis;
    let relevantProductsData = []; 
    let finalReplyForTTS = "";   

    if (image) {
        // This section handles direct image analysis (when a new 'image' is in the payload).
        // 'previousDescription' is not typically expected here from VisionPage's initial image submission.
        console.log(`[${requestTimestamp}] Image data received for primary analysis. Query with image: "${effectiveQuery}"`);
        const imageDescriptionSystemPrompt = `You are a helpful visual assistant. Describe the provided image in detail, focusing on identifiable products, brands, and their arrangement. If there are multiple prominent items, describe them. Respond in ${langCode === 'es' ? 'Spanish' : 'English'}. Be descriptive and informative. **Do not use any markdown formatting like asterisks or bolding in your response. Provide plain text only.**`;
        
        try {
            const llmImageResponse = await openai.chat.completions.create({
                model: "gpt-4o", 
                messages: [
                    { role: "system", content: imageDescriptionSystemPrompt },
                    {
                        role: "user",
                        content: [
                            { 
                                type: "text", 
                                // Use effectiveQuery here if user can type a question while submitting an image
                                text: effectiveQuery || (langCode === 'es' ? "Describe los elementos principales en esta imagen." : "Please describe the main items in this image.")
                            },
                            {
                                type: "image_url",
                                image_url: {
                                    "url": `data:image/jpeg;base64,${image}`, 
                                    "detail": "auto" 
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 350 
            });
            finalReplyForTTS = llmImageResponse.choices[0].message.content.trim();
            console.log(`[${requestTimestamp}] LLM Image Description (primary analysis):`, finalReplyForTTS);
            // For an image analysis, we return the description directly.
            // The products array would be empty here as this isn't a product search.
            return res.json({ reply: finalReplyForTTS, products: [] }); 
        } catch (err) {
            console.error(`[${requestTimestamp}] LLM Image Analysis error:`, err.message);
            if (err.response && err.response.data) {
                console.error("OpenAI Error Data (Image Analysis):", err.response.data);
            }
            finalReplyForTTS = langCode === 'es' ? "Lo siento, no pude analizar la imagen en este momento." : "Sorry, I couldn't analyze the image right now.";
            return res.status(500).json({ reply: finalReplyForTTS, products: [] });
        }
    } else { 
        // This block handles text-based queries, including those with 'previousDescription' context from VisionPage voice follow-ups.
        // 'effectiveQuery' here is the current spoken/typed question.
        console.log(`[${requestTimestamp}] Text-based query received: "${effectiveQuery}"`);
        if (previousDescription) {
            console.log(`[${requestTimestamp}] This text query includes 'previousDescription' context for LLM2.`);
        }
        
        // --- LLM1: Intent/Entity Extraction from the current 'effectiveQuery' ---
        // ... (your existing code) ...

const systemPromptLLM1 = `You are an intelligent assistant for a retail store kiosk.
Your primary goal is to identify the user's intent and extract entities from their **CURRENT QUERY** in ${langCode === 'es' ? 'Spanish' : 'English'}.
**CRITICAL RULE:** If the CURRENT QUERY is a follow-up question or seems incomplete (e.g., "what about for kids?", "how much are they?", "which brands?"), you MUST use the provided **CONVERSATION HISTORY** to understand the original subject (like "toothpaste") and include that subject in your extracted entities.
Use the provided conversation history for context if the current query is ambiguous.

**CONVERSATION HISTORY (for context):**
${JSON.stringify(conversationHistory)}

**USER'S CURRENT QUERY:**
"${effectiveQuery}"
Your primary task is to map the user's phrasing in their CURRENT QUERY to the official categories or information topics provided in the reference lists.
The user may use colloquial Spanish terms (Puerto Rican Spanish) or English, and might use synonyms or descriptive phrases for products. Your key task is to map their phrasing to the official categories or information topics provided in the reference lists.

Crucially, even if the user's exact term is not in the list, you MUST infer the closest matching category or topic from the provided lists based on semantic meaning and common usage. For example, if the user asks for "insect killer", you should map it to "Insecticidas en spray" or "Trampas e insecticidas". If they ask for "laundry soap", map it to a relevant "detergent" category.

Intents:
- product_location: User is asking where a specific product or product category is located. This typically includes phrases like "Where is X?", "I'm looking for Y", "Do you have Z and where is it?", "Can you tell me the aisle for A?". IMPORTANT: Asking for the location of a product should be product_location.
- product_availability: User is asking if a product or product category is available in stock.
- specific_store_info: User is asking about general store information, services, or non-product physical areas of the store (e.g., "What are your store hours?", "Where are the bathrooms?", "Which aisle are the detergents?", "Where is the pet section?"). IMPORTANT: Asking for the location of a general store area should be specific_store_info.
- general_greeting: User is saying hi, hello, thank you, etc.
- other_inquiry: User is asking for other information not covered above (this might include questions about a previously described image if no specific product or store info intent is found).
- unclear_or_ambiguous: The user's query is too vague or unclear.

Entities to Extract:
- category_name: For product-related queries, this is the most important entity. You MUST map the user's product description (e.g., "toothpaste," "pasta pa' los dientes," "shampoo y rinse," "spray pa’ hormigas", "insect killer", "laundry soap", "baby wipes", "toallitas húmedas para bebés") to one of the official category names provided in the 'Product Categories' list, even if it's a synonym. **You MUST map the user's topic to an official category from the list.** If the current query is "which brands?" and the history is about "toothpaste", you MUST extract "Pasta dental".
- brand_name: Specific brand names if mentioned by the user (e.g., "Colgate," "Raid," "Pantene").
- store_info_topic: If the intent is 'specific_store_info', map the user's query (e.g., "what time do you close?", "dónde están los baños?", "busco detergentes", "where are pillows?") to one of the keys provided in the 'Store Info Topics' list. For example, "horario" or "store hours" should map to "store_hours". "Baños" or "restrooms" should map to "bathroom_location". "Detergentes" or "detergents" should map to "detergent_info". "Almohadas" or "pillows" should map to "pillows_cushions". "Toallas para la cocina" or "kitchen towels" should map to "kitchen_towels". "Toallas de gimnasio" or "gym towels" should map to "gym_towels". "Toallas de baño" or "bath towels" should map to "bath_towels". "Cortinas" or "curtains" should map to "curtains". "Colchas" or "bedspreads" should map to "bedspreads". "Sábanas" or "bed sheets" should map to "bed_sheets". "Alfombras de baño" or "bath mats" should map to "bath_mats".
- product_name: Use this only if the user asks for something extremely specific that clearly does not fit any listed category and isn't a general store topic. Generally, prefer 'category_name'.

Reference Lists (These are CRITICAL for your mapping):
Product Categories: ${JSON.stringify(dynamicProductCategories)}
Store Info Topics: ${JSON.stringify(STORE_INFO_TYPES_FOR_LLM1)}

Output Rules & Examples:
- Respond strictly in JSON format as specified below.
- **Example of using history:**
  - HISTORY: [{ user: "Where is toothpaste?" }]
  - CURRENT QUERY: "which brands do you have?"
  - CORRECT JSON OUTPUT: { "intent": "product_availability", "entities": { "category_name": ["Pasta dental"] }, "requires_clarification": false, "clarification_question_for_user": "" }
- **Example of NOT using history:**
  - HISTORY: []
  - CURRENT QUERY: "which brands do you have?"
  - CORRECT JSON OUTPUT: { "intent": "unclear_or_ambiguous", "entities": { "category_name": [] }, "requires_clarification": true, "clarification_question_for_user": "Which product are you asking about?" }
- Prioritize 'category_name' extraction for products, using semantic understanding for mapping to the provided list.
- Correct Intent Examples (CRITICAL!):
  - User (English): "Where is toothpaste?" -> "intent": "product_location", "entities": { "category_name": ["Pasta dental"] }
  - User (Spanish): "¿Dónde están las toallitas húmedas para bebés?" -> "intent": "product_location", "entities": { "category_name": ["Toallitas húmedas para bebé"] }
  - User (English): "Do you have shampoo?" -> "intent": "product_availability", "entities": { "category_name": ["Shampoo y acondicionadores"] }
  - User (English): "Where is the bathroom?" -> "intent": "specific_store_info", "entities": { "store_info_topic": ["bathroom_location"] }
  - User (Spanish): "¿Cuál es el horario de la tienda?" -> "intent": "specific_store_info", "entities": { "store_info_topic": ["store_hours"] }
- If a query is too general for any listed category or topic (e.g., "I need stuff"), set "requires_clarification" to true and formulate a polite "clarification_question_for_user" in ${langCode === 'es' ? 'Spanish' : 'English'}.
- If intent is 'unclear_or_ambiguous', set "requires_clarification" to true.
- If the query seems to be about a previously discussed image (especially if no clear product or store info intent is found), the intent might be 'other_inquiry'.

JSON Output Structure:
{
  "intent": "intent_name",
  "entities": {
    "product_name": [],
    "category_name": ["ValueFromProductCategoriesList"],
    "brand_name": ["MentionedBrand"],
    "store_info_topic": ["ValueFromStoreInfoTopicsList"]
  },
  "requires_clarification": boolean,
  "clarification_question_for_user": "Polite question in the user's language if clarification is needed, otherwise an empty string."
}`;

        
        try {
            console.log(`[${requestTimestamp}] LLM1 (Text Query): "${effectiveQuery}"`);
            const llm1Response = await openai.chat.completions.create({
                model: "gpt-3.5-turbo", 
                messages: [
                    { role: "system", content: systemPromptLLM1 },
                    { role: "user", content: effectiveQuery },
                ],
                temperature: 0.3,
            });
            llm1Analysis = JSON.parse(llm1Response.choices[0].message.content);
            console.log(`[${requestTimestamp}] LLM1 Result:`, JSON.stringify(llm1Analysis));
        } catch (err) {
            console.error(`[${requestTimestamp}] LLM1 (Text Query) error:`, err.message);
            return res.status(500).json({ reply: langCode === "es" ? "Error procesando su consulta de texto." : "Error processing your text query.", products: [] });
        }

        if (llm1Analysis.requires_clarification) {
            console.log(`[${requestTimestamp}] LLM1 clarification needed:`, llm1Analysis.clarification_question_for_user);
            return res.json({ reply: llm1Analysis.clarification_question_for_user, products: [] });
        }

        let infoFetchedAndReturned = false;
        if (llm1Analysis.intent === "specific_store_info" && llm1Analysis.entities.store_info_topic?.length > 0) {
            const topicKey = llm1Analysis.entities.store_info_topic[0];
            try {
                const descriptionColumn = langCode === 'es' ? 'description_es' : 'description_en';
                const infoQuery = `SELECT ${descriptionColumn} AS description, notes FROM store_general_info WHERE info_key = $1;`;
                console.log(`[${requestTimestamp}] Executing Store Info SQL: ${infoQuery.replace(/\s+/g, ' ')} | Params: [${topicKey}]`);
                const infoRes = await dbClient.query(infoQuery, [topicKey]);

                if (infoRes.rows.length > 0 && infoRes.rows[0].description) {
                    finalReplyForTTS = infoRes.rows[0].description;
                    if (infoRes.rows[0].notes && infoRes.rows[0].notes.trim() !== "") {
                        finalReplyForTTS += ` (${infoRes.rows[0].notes})`;
                    }
                    console.log(`[${requestTimestamp}] Store Info found in DB (direct use): "${finalReplyForTTS}"`);
                    infoFetchedAndReturned = true; 
                } else {
                    console.log(`[${requestTimestamp}] No specific info found in DB for topic_key: ${topicKey}. LLM2 will generate a response if needed.`);
                }
            } catch (dbInfoError) {
                console.error(`[${requestTimestamp}] Store Info SQL error for key ${topicKey}:`, dbInfoError.message);
            }
        } 
        
        if (!infoFetchedAndReturned && (["product_location", "product_availability"].includes(llm1Analysis.intent))) {
            const entities = llm1Analysis.entities;
            const sqlWhereClauses = [];
            const queryParams = [];

            if (entities.product_name?.length > 0) {
                entities.product_name.forEach((prodName) => {
                    sqlWhereClauses.push(`(name_en ILIKE $${queryParams.length + 1} OR name_es ILIKE $${queryParams.length + 1})`);
                    queryParams.push(`%${prodName}%`);
                });
            }
            if (entities.category_name?.length > 0) {
                entities.category_name.forEach((cat) => {
                    sqlWhereClauses.push(`category ILIKE $${queryParams.length + 1}`);
                    queryParams.push(`%${cat}%`);
                });
            }
            if (entities.brand_name?.length > 0) {
                entities.brand_name.forEach((brandName) => {
                    sqlWhereClauses.push(`brand ILIKE $${queryParams.length + 1}`);
                    queryParams.push(`%${brandName}%`);
                });
            }

            if (sqlWhereClauses.length > 0) {
                
                
                const locMainEntranceCol = langCode === 'es' ? 'loc_main_entrance_es' : 'loc_main_entrance_en';
                const locRearEntranceCol = langCode === 'es' ? 'loc_rear_entrance_es' : 'loc_rear_entrance_en';

                const productQueryText = `
                    SELECT 
                        id, name_en, name_es, category, brand, aisle, side, 
                        shelf_area_en, shelf_area_es,
                        loc_main_entrance_en, loc_main_entrance_es,
                        loc_rear_entrance_en, loc_rear_entrance_es,
                        ad_offer_text_en, ad_offer_text_es, 
                        ad_offer_image_url
                    FROM products 
                    WHERE ${sqlWhereClauses.join(" OR ")}
                    ORDER BY category, name_es
                    LIMIT 5;`;
                
                try {
                    console.log(`[${requestTimestamp}] Executing Product SQL: ${productQueryText.replace(/\s+/g, ' ')} | Params:`, queryParams);
                    const productRes = await dbClient.query(productQueryText, queryParams);
                    relevantProductsData = productRes.rows;
                    console.log(`[${requestTimestamp}] Found ${relevantProductsData.length} products.`);
                } catch (dbQueryError) {
                    console.error(`[${requestTimestamp}] Product SQL error:`, dbQueryError.message);
                    relevantProductsData = [];
                }
            } else {
                console.log(`[${requestTimestamp}] No SQL WHERE clauses built for product query based on LLM1 entities.`);
                relevantProductsData = [];
            }
        }
        
        // --- LLM2: Generate Final Response (incorporating previousDescription if present) ---
        if (!infoFetchedAndReturned) { 
            let systemPromptLLM2 = `You are Yoly, a helpful retail store kiosk AI, assisting in ${langCode === 'es' ? 'Spanish' : 'English'}.
           

CONVERSATION HISTORY:
${JSON.stringify(conversationHistory)}
User's CURRENT Question: "${effectiveQuery}".
Identified Intent (from current question): "${llm1Analysis.intent}".
Identified Entities (from current question): ${JSON.stringify(llm1Analysis.entities)}.
${previousDescription ? `\nIMPORTANT CONTEXT from a previous image analysis: "${String(previousDescription).replace(/"/g, "'")}". Your response should primarily relate to this image context when answering the user's current question. If the current question is vague (e.g., "What about it?", "Tell me more", "Can you provide more details?"), assume it refers to this image context.` : ""}
Your task is to provide a concise, helpful, and friendly response (1-2 sentences) in ${langCode === 'es' ? 'Spanish' : 'English'}.
Base your response on the 'Found Data' (if any, from product database lookup based on current question's entities) AND the 'IMPORTANT CONTEXT from previous image analysis' (if provided).
**Do not use any markdown formatting like asterisks or bolding in your response. Provide plain text only.**

If providing product location (based on 'Found Data' from the current question's entities):
- Generate the response in the requested language: ${langCode === 'es' ? 'Spanish' : 'English'}.
- For the product name, use 'name_es' for Spanish or 'name_en' for English.
- For the location description, use 'loc_main_entrance_es' (or '_en') if available. If not, use 'shelf_area_es' (or '_en').
- Format (English): "[name_en], Aisle [aisle] ".
- Format (Spanish): "[name_es], Pasillo [aisle]".
- Examples:
  - "Product A, Aisle 1"
  - "Product B, Aisle 2"
  - "Product C, Aisle 3." (If side/specific location is not clear/available)
- Focus on the first product in 'Found Data'.
- DO NOT use any conversational phrases like "You can find..." or "It is located...". Output the information directly.
- If 'Found Data' is empty and no 'IMPORTANT CONTEXT' for the query, respond with (in ${langCode === 'es' ? 'Spanish' : 'English'}): "Sorry, I could not find that item." (Spanish: "Lo siento, no pude encontrar ese artículo.")

If the intent (from current question) was "specific_store_info" AND 'Found Data' from 'store_general_info' provided that information:
- Respond very concisely with just the information.
- Example (English): "Store hours are 9 AM to 9 PM."
- Example (Spanish): "El baño está al final del pasillo 3."
- DO NOT use conversational phrases.

If the user's current question is general or seems to directly ask about the image context (e.g., "What color is it?"):
- Use the "IMPORTANT CONTEXT from previous image analysis" to form your answer directly and concisely (1-2 sentences).

**Crucially, for all response types, do not use any markdown formatting like asterisks or bolding. Provide plain text only.**

Found Data (from product database lookup, based on current question's entities):
`;

            if (relevantProductsData && relevantProductsData.length > 0) {
                systemPromptLLM2 += `Product Data:\n`;
                relevantProductsData.forEach((prod, index) => {
                    let productDetails = `Product ${index + 1}:`;
                    productDetails += ` Name (English): ${prod.name_en || 'N/A'}`;
                    productDetails += `, Name (Spanish): ${prod.name_es || 'N/A'}`;
                    productDetails += `, Category: ${prod.category || 'N/A'}`;
                    productDetails += `, Brand: ${prod.brand || 'N/A'}`;
                    productDetails += `, Aisle: ${prod.aisle || 'N/A'}`;
                    productDetails += `, Side: ${prod.side || 'N/A'}`;
                    productDetails += `, Shelf Area (English): ${prod.shelf_area_en || 'N/A'}`;
                    productDetails += `, Shelf Area (Spanish): ${prod.shelf_area_es || 'N/A'}`;
                    productDetails += `, From Main Entrance (English): ${prod.loc_main_entrance_en || 'N/A'}`;
                    productDetails += `, From Main Entrance (Spanish): ${prod.loc_main_entrance_es || 'N/A'}`;
                    productDetails += `, From Rear Entrance (English): ${prod.loc_rear_entrance_en || 'N/A'}`;
                    productDetails += `, From Rear Entrance (Spanish): ${prod.loc_rear_entrance_es || 'N/A'}`;
                    systemPromptLLM2 += productDetails + "\n";
                });
            } else if ((llm1Analysis.intent === "product_location" || llm1Analysis.intent === "product_availability") && !previousDescription) {
                // Only add this if no products found AND no image context to fall back on
                systemPromptLLM2 += `No specific product data was found in the database for "${effectiveQuery}".\n`;
            } else if (llm1Analysis.intent === "specific_store_info" && !previousDescription) {
                // Only add this if no store info found AND no image context
                systemPromptLLM2 += `I currently do not have the specific details for "${llm1Analysis.entities.store_info_topic?.[0] || effectiveQuery}". You might want to ask a store associate.\n`;
            } else if (!previousDescription && relevantProductsData.length === 0) {
                // If no products, no store info, and no previous description, it's a general query LLM2 has to handle based on effectiveQuery.
                systemPromptLLM2 += `No specific data found in the product database. Please answer the user's current question generally: "${effectiveQuery}".\n`;
            }
            // If previousDescription is present, LLM2 is already instructed to use it.
            // If relevantProductsData is also present, LLM2 will have both to consider.
            
            console.log(`[${requestTimestamp}] --- FULL systemPromptLLM2 (Snippet with context awareness) ---`);
            console.log(systemPromptLLM2.substring(0, 2000) + (systemPromptLLM2.length > 2000 ? "..." : "")); // Increased snippet length
            console.log(`[${requestTimestamp}] --- END systemPromptLLM2 ---`);

            try {
                console.log(`[${requestTimestamp}] LLM2: Generating response for query "${effectiveQuery}" (contextual if previousDescription exists).`);
                const llm2OpenAIResponse = await openai.chat.completions.create({
                    model: "gpt-4o", 
                    messages: [
                        { role: "system", content: systemPromptLLM2 },
                        { role: "user", content: effectiveQuery }, 
                    ],
                    temperature: 0.5,
                });
                finalReplyForTTS = llm2OpenAIResponse.choices[0].message.content.trim();
                console.log(`[${requestTimestamp}] LLM2 Reply (potentially contextual):`, finalReplyForTTS);
            } catch (err) {
                console.error(`[${requestTimestamp}] LLM2 error:`, err.message);
                finalReplyForTTS = langCode === "es" ? "Lo siento, no pude generar una respuesta detallada en este momento." : "Sorry, I couldn't generate a detailed response right now.";
            }
        }
        const updatedHistory = [
            ...conversationHistory,
            { role: 'user', content: effectiveQuery },
            { role: 'assistant', content: finalReplyForTTS }
        ];
        // Send the final reply (either from direct DB lookup/infoFetchedAndReturned or from LLM2)
        res.json({
            reply: finalReplyForTTS,
            products: relevantProductsData, 
            conversationHistory: updatedHistory // Add this property
        });
    } // End of else block for text-based/contextual queries
});


// Text-to-Speech Endpoint 
app.post("/text-to-speech", cors(corsOptions), async (req, res) => {
    console.log(`[${new Date().toISOString()}] Received /text-to-speech request:`, req.body);
    const { text, language } = req.body;
    if (!text || !language) {
        console.warn(`[${new Date().toISOString()}] Missing text/language in TTS request.`);
        return res.status(400).json({ error: "Missing 'text' or 'language'" });
    }
    const langCodeTTS = language === "es" ? "es-US" : "en-US";
    try {
        const request = {
            input: { text: text.slice(0, 500) }, 
            voice: { languageCode: langCodeTTS, name: langCodeTTS === "es-US" ? "es-US-Standard-A" : "en-US-Standard-A" },
            audioConfig: { audioEncoding: "MP3" },
        };
        const [response] = await ttsClient.synthesizeSpeech(request);
        const audioContent = response.audioContent.toString("base64");
        console.log(`[${new Date().toISOString()}] TTS generated, audio size:`, audioContent.length);
        res.json({ audio: audioContent, format: "mp3" });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] TTS error:`, error.message);
        res.status(500).json({ error: "Failed to generate speech" });
    }
});

app.post("/speech-to-text", cors(corsOptions), async (req, res) => {
    const requestTimestamp = new Date().toISOString();
    console.log(`[${requestTimestamp}] Received /speech-to-text request.`);

    const { audio, language } = req.body; // audio is expected to be a base64 encoded string

    if (!audio || !language) {
        console.warn(`[${requestTimestamp}] Missing audio data or language in /speech-to-text request.`);
        return res.status(400).json({ error: "Missing 'audio' (base64 string) or 'language' in request body." });
    }

    const langCodeStt = language === "es" ? "es-US" : "en-US"; 

    const recognitionConfig = {
        // encoding: 'WEBM_OPUS', // Google can often infer this for WebM/Opus
        // sampleRateHertz: 48000, // Usually inferred for WebM/Opus
        languageCode: langCodeStt,
        enableAutomaticPunctuation: true,
    };

    const audioRequest = {
        audio: {
            content: audio, 
        },
        config: recognitionConfig,
    };

    try {
        console.log(`[${requestTimestamp}] Sending audio to Google STT. Language: ${langCodeStt}. Audio length (base64): ${audio.length}`);
        const [sttApiResponse] = await speechClient.recognize(audioRequest);
        
        if (sttApiResponse.results && sttApiResponse.results.length > 0 && sttApiResponse.results[0].alternatives && sttApiResponse.results[0].alternatives.length > 0) {
            const transcript = sttApiResponse.results[0].alternatives[0].transcript;
            console.log(`[${requestTimestamp}] STT successful. Transcript: "${transcript}"`);
            res.json({ transcript: transcript });
        } else {
            console.warn(`[${requestTimestamp}] STT did not return a transcript for the provided audio.`);
            res.json({ transcript: "" }); 
        }
    } catch (error) {
        console.error(`[${requestTimestamp}] Google STT API error for /speech-to-text:`, error.message);
        if (error.code) console.error(`[${requestTimestamp}] Google STT API error code: ${error.code}`);
        if (error.details) console.error(`[${requestTimestamp}] Google STT API error details: ${error.details}`);
        
        res.status(500).json({ 
            error: "Failed to process speech-to-text.",
            details: error.message 
        });
    }
});
// ***** END: NEW /speech-to-text ENDPOINT *****


// START: ADMIN API ENDPOINTS

// --- Admin Security Middleware ---
// This function checks for a secret key on protected routes.
const requireAdminAuth = (req, res, next) => {
    // Make sure you have ADMIN_API_KEY="your-secret-key" in your .env file!
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === process.env.ADMIN_API_KEY) {
        next(); // Key is valid, proceed to the route handler.
    } else {
        console.warn(`[${new Date().toISOString()}] Unauthorized admin API attempt.`);
        res.status(401).json({ error: 'Unauthorized: Missing or invalid API key.' });
    }
};

// --- GET /api/admin/products ---
// Fetches all products to display in the dashboard table.
app.get("/api/admin/products", cors(corsOptions), requireAdminAuth, async (req, res) => {
    try {
        console.log(`[${new Date().toISOString()}] Admin request: Fetching all products.`);
        // Select only the columns needed for the main table view to keep it fast.
        const query = "SELECT * FROM products ORDER BY id DESC";
        const { rows } = await dbClient.query(query);
        res.json(rows);
    } catch (err) {
        console.error("Admin API - Error fetching products:", err.message);
        res.status(500).json({ error: "Failed to fetch products from database." });
    }
});

// --- POST /api/admin/products ---
// Adds a new product to the database from the form.
app.post("/api/admin/products", requireAdminAuth, async (req, res) => {
    try {
        const {
            name_es, name_en, category, brand, aisle, side,
            shelf_area_es, shelf_area_en, loc_main_entrance_es,
            loc_main_entrance_en, loc_rear_entrance_es, loc_rear_entrance_en,
            ad_offer_text_es, ad_offer_text_en, // Correctly named from form
            ad_offer_image_url
        } = req.body;

        console.log(`[${new Date().toISOString()}] Admin request: Adding new product "${name_es}".`);

        if (!name_es || !category || !aisle) {
            return res.status(400).json({ error: "Name (ES), Category, and Aisle are required fields." });
        }

        // The number of columns here (15) now perfectly matches the number of VALUES ($1...$15)
        const query = `
            INSERT INTO products (
                name_es, name_en, category, brand, aisle, side, shelf_area_es,
                shelf_area_en, loc_main_entrance_es, loc_main_entrance_en,
                loc_rear_entrance_es, loc_rear_entrance_en,
                ad_offer_text_es, ad_offer_text_en, ad_offer_image_url
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING *;
        `;

        // The number of parameters here (15) also perfectly matches.
        const params = [
            name_es, name_en || null, category, brand || null, aisle, side || null,
            shelf_area_es || null, shelf_area_en || null, loc_main_entrance_es || null,
            loc_main_entrance_en || null, loc_rear_entrance_es || null, loc_rear_entrance_en || null,
            ad_offer_text_es || null, ad_offer_text_en || null, ad_offer_image_url || null
        ];

        const { rows } = await dbClient.query(query, params);
        console.log(`Admin API - Product added successfully with ID: ${rows[0].id}`);
        res.status(201).json(rows[0]);

    } catch (err) {
        // This will now give us a more specific error if something is still wrong
        console.error("Admin API - CRITICAL ERROR adding product:", err);
        res.status(500).json({ error: "Failed to add product to database.", details: err.message });
    }
});


// --- DELETE /api/admin/products/:id ---
// Deletes a product by its ID.
app.delete("/api/admin/products/:id", cors(corsOptions), requireAdminAuth, async (req, res) => {
    const { id } = req.params;
    try {
        console.log(`[${new Date().toISOString()}] Admin request: Deleting product with ID: ${id}.`);
        const query = "DELETE FROM products WHERE id = $1 RETURNING *;";
        const { rows } = await dbClient.query(query, [id]);

        if (rows.length === 0) {
            console.warn(`Admin API - Product with ID ${id} not found for deletion.`);
            return res.status(404).json({ error: "Product not found." });
        }
        console.log(`Admin API - Product deleted successfully:`, rows[0].name_es);
        res.status(200).json({ message: "Product deleted successfully", product: rows[0] });
    } catch (err) {
        console.error(`Admin API - Error deleting product with ID ${id}:`, err.message);
        res.status(500).json({ error: "Failed to delete product from database." });
    }
});

// END: ADMIN API ENDPOINTS

// Updates an existing product in the database.
// --- PUT /api/admin/products/:id --- (IMPROVED VERSION)
// Updates an existing product in the database.
app.put("/api/admin/products/:id", requireAdminAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const productData = req.body;
        console.log(`[${new Date().toISOString()}] Admin request: Updating product ID: ${id}.`);

        // The list of all possible columns that can be updated
        const columns = [
            'name_es', 'name_en', 'category', 'brand', 'aisle', 'side',
            'shelf_area_es', 'shelf_area_en', 'loc_main_entrance_es',
            'loc_main_entrance_en', 'loc_rear_entrance_es', 'loc_rear_entrance_en',
            // START: Add the two missing ad text columns
            'ad_offer_text_es', 'ad_offer_text_en',
            // END: Add the two missing ad text columns
            'ad_offer_image_url'
        ];

        // Build the query dynamically
        const setClauses = [];
        const queryParams = [id];

        columns.forEach(col => {
            if (productData[col] !== undefined) {
                queryParams.push(productData[col]);
                setClauses.push(`${col} = $${queryParams.length}`);
            }
        });
        
        if (setClauses.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update provided.' });
        }

        const query = `UPDATE products SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *;`;
        
        const { rows } = await dbClient.query(query, queryParams);

        if (rows.length === 0) return res.status(404).json({ error: "Product not found." });

        console.log(`Admin API - Product updated successfully: ID ${rows[0].id}`);
        res.status(200).json(rows[0]);

    } catch (err) {
        console.error(`Admin API - Error updating product ID ${id}:`, err.message, err.stack);
        res.status(500).json({ error: "Failed to update product." });
    }
});

// --- POST /api/admin/upload-image ---
// Receives an image file, uploads it to Cloudinary, and returns the URL.
app.post('/api/admin/upload-image', requireAdminAuth, parser.single('ad_image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }
    // The 'parser' middleware has already uploaded the file to Cloudinary.
    // The secure URL is available in req.file.path
    console.log(`[${new Date().toISOString()}] Cloudinary upload successful. URL: ${req.file.path}`);
    res.status(200).json({ imageUrl: req.file.path });
  } catch (error) {
    console.error("Cloudinary upload error:", error);
    res.status(500).json({ error: 'Image upload failed.' });
  }
});

// --- POST /api/admin/restart-bot ---
// Securely restarts the Heroku application dynos.
app.post('/api/admin/restart-bot', requireAdminAuth, async (req, res) => {
    try {
        console.log(`[${new Date().toISOString()}] Admin request: Restarting Heroku dynos.`);

        const appName = process.env.HEROKU_APP_NAME;
        const apiToken = process.env.HEROKU_API_TOKEN;

        if (!appName || !apiToken) {
            throw new Error("Heroku app name or API token is not configured on the server.");
        }

        // This is the Heroku Platform API endpoint for restarting dynos
        const herokuApiUrl = `https://api.heroku.com/apps/${appName}/dynos`;

        await axios.delete(herokuApiUrl, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.heroku+json; version=3',
                'Authorization': `Bearer ${apiToken}`
            }
        });

        console.log("Successfully triggered Heroku dyno restart.");
        res.status(200).json({ message: "Application restart initiated successfully. The bot will be updated in about a minute." });

    } catch (error) {
        console.error("Heroku API restart error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to restart the application.' });
    }
});

// --- POST /api/auth/login ---
// Verifies admin credentials and returns the API key as a session token.
app.post("/api/auth/login", cors(corsOptions), async (req, res) => {
    const { username, password } = req.body;

    const adminUser = process.env.ADMIN_USERNAME;
    const adminPass = process.env.ADMIN_PASSWORD;

    if (username === adminUser && password === adminPass) {
        // If credentials are correct, send back the API key.
        // The frontend will store this key to make other API requests.
        console.log(`[${new Date().toISOString()}] Successful login for user: ${username}`);
        res.status(200).json({ token: process.env.ADMIN_API_KEY });
    } else {
        // If credentials are bad, send an unauthorized error.
        console.log(`[${new Date().toISOString()}] Failed login attempt for user: ${username}`);
        res.status(401).json({ error: "Invalid username or password" });
    }
});


app.post("/generate-recipe", cors(corsOptions), async (req, res) => {
    const requestTimestamp = new Date().toISOString();
    // 1. Get the request body, providing a default for conversationHistory
    const { query, language, conversationHistory = [] } = req.body;
    const langCode = language === "es" ? "es" : "en";
    console.log(`[${requestTimestamp}] Received /generate-recipe request. Query: "${query}"`);

    try {
        // 2. Get Product Context: Fetch all product names from the database.
        // This provides the AI with its knowledge base of what's available.
        console.log(`[${requestTimestamp}] Fetching available products from DB...`);
        const productsResult = await dbClient.query("SELECT name_en, name_es, category, aisle, side FROM products WHERE name_es IS NOT NULL OR name_en IS NOT NULL");
        const availableProducts = productsResult.rows;
        console.log(`[${requestTimestamp}] Loaded ${availableProducts.length} products for context.`);

        // 3. Craft the "Recipe Bot" System Prompt
        // This is the core instruction set for the AI.
        const systemPromptLLM_Recipes = `You are a creative culinary assistant named 'Yoly' inside a retail store kiosk. Your goal is to generate delicious recipes based on user requests, using ONLY the products available in the store. You must be conversational and remember the user's previous questions from the history.

**CONTEXT: AVAILABLE STORE PRODUCTS**
You can only use ingredients from this list. Do not invent ingredients. If a user asks for something you don't have, politely state that and suggest an alternative using ingredients you DO have.
AVAILABLE: ${JSON.stringify(availableProducts.map(p => p.name_en || p.name_es))}

**TASK**
1. Analyze the user's latest query: "${query}".
2. Consider the entire CONVERSATION HISTORY to understand follow-up questions.
3. Address the user's constraints (e.g., 'low-carb', 'vegetarian', 'quick meal').
4. Formulate one relevant recipe that fits the request.
5. Respond ONLY in the specified JSON format. Do not add any text, greetings, or explanations outside the JSON structure.

**CONVERSATION HISTORY**
${JSON.stringify(conversationHistory)}

**JSON OUTPUT FORMAT (MANDATORY)**
{
  "recipeName": "A creative name for the recipe in ${langCode}",
  "description": "A brief, friendly, one-sentence description of the recipe in ${langCode}.",
  "ingredients": [
    { "name": "Exact Product Name from Available List", "quantity": "e.g., 200g or 2 units" }
  ],
  "instructions": "Step-by-step cooking instructions in ${langCode}. Keep it concise and clear.",
  "spokenReply": "A friendly, conversational summary to be read aloud in ${langCode}. Announce the recipe name and briefly what it is. Example: 'Sure! Here is a lovely recipe for Grilled Lemon Herb Chicken.'"
}`;

        // 4. Call the OpenAI API
        console.log(`[${requestTimestamp}] Sending prompt to OpenAI...`);
        const llmResponse = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemPromptLLM_Recipes }
                // We no longer need a separate user message as the query is embedded in the system prompt
            ],
            response_format: { type: "json_object" } // Enforce JSON output for reliable parsing
        });

        let recipeData = JSON.parse(llmResponse.choices[0].message.content);
        console.log(`[${requestTimestamp}] Received recipe data from AI:`, recipeData.recipeName);

        // 5. Post-Process: Augment ingredients with location data from our database
        recipeData.ingredients.forEach(ingredient => {
            const productInfo = availableProducts.find(p => (p.name_en === ingredient.name || p.name_es === ingredient.name));
            if (productInfo) {
                ingredient.aisle = productInfo.aisle;
                ingredient.side = productInfo.side;
            } else {
                // The AI might occasionally hallucinate an ingredient. We'll nullify its location.
                ingredient.aisle = null;
                ingredient.side = null;
            }
        });
        console.log(`[${requestTimestamp}] Augmented recipe ingredients with store location data.`);

        // 6. Update history for the next turn
        const finalHistory = [
            ...conversationHistory,
            { role: 'user', content: query },
            { role: 'assistant', content: recipeData.spokenReply } // Store the conversational part
        ];

        // 7. Send the complete, augmented response back to the frontend
        res.json({
            reply: recipeData.spokenReply, // For TTS
            recipe: recipeData,             // For UI display
            updatedHistory: finalHistory    // For the next conversation turn
        });

    } catch (err) {
        console.error(`[${new Date().toISOString()}] /generate-recipe ERROR:`, err);
        res.status(500).json({ 
            reply: langCode === 'es' ? "Lo siento, tuve un problema al crear la receta en este momento." : "I'm sorry, I had trouble coming up with a recipe right now." 
        });
    }
});



app.post('/export-list', cors(corsOptions), (req, res) => {
    const requestTimestamp = new Date().toISOString();
    const { shoppingList } = req.body;
    console.log(`[${requestTimestamp}] Received /export-list request for ${shoppingList.length} items.`);

    try {
        const doc = new PDFDocument({ margin: 50 });

        // Set HTTP headers to trigger a file download in the browser
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="shopping-list-${Date.now()}.pdf"`);

        // Pipe the PDF output directly to the HTTP response
        doc.pipe(res);

        // --- Add content to the PDF ---
        
        // Header
        doc.fontSize(22).fillColor('#d32f2f').text('Your Shopping List', { align: 'center' });
        doc.moveDown(2);

        // Table Header
        doc.fontSize(12).fillColor('black');
        doc.text('Item', { continued: true });
        doc.text('Location', { align: 'right' });
        doc.lineCap('round').moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#d32f2f').stroke();
        doc.moveDown();

        // Table Rows
        shoppingList.forEach(item => {
            const location = (item.aisle && item.side) ? `Aisle ${item.aisle}, Side ${item.side}` : 'Location not specified';
            
            doc.fontSize(14).fillColor('black').text(`${item.quantity || ''} ${item.name}`, { 
                width: 400, // Prevent long names from overlapping
                continued: true 
            });
            doc.fontSize(12).fillColor('grey').text(location, { align: 'right' });
            doc.moveDown(1.5);
        });

        // Finalize the PDF and end the stream
        doc.end();
        console.log(`[${requestTimestamp}] Successfully generated and sent PDF.`);

    } catch(err) {
        console.error(`[${new Date().toISOString()}] /export-list ERROR:`, err);
        res.status(500).json({ error: "Failed to generate PDF." });
    }
});

// HTTP server upgrade for WebSocket
const server = app.listen(port, async () => { // Step 1: Add 'async' here
    await loadDynamicCategories(); // Step 2: Call the new function and wait for it to finish
    console.log(`Server running on port ${port}`); // This now runs after categories are loaded
});
server.on("upgrade", (request, socket, head) => {
    if (request.url === "/stream-audio") {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit("connection", ws, request);
        });
    } else {
        socket.destroy();
    }
});