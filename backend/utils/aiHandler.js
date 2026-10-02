const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
// Load .env from project root (chatapp/.env), not from chatapp/backend/
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — Regex pre-filter  (instant block, zero API cost)
// ─────────────────────────────────────────────────────────────────────────────
const TROLL_PATTERNS = [
    // Common insults & slurs
    /\b(idiot|idiots|moron|morons|imbecile|retard|stupid|dumb(ass)?|loser|losers)\b/i,
    // Direct verbal attacks
    /\b(shut\s*up|go\s*to\s*hell|drop\s*dead|kill\s*your\s*self|get\s*lost|go\s*away)\b/i,
    // Profanity
    /\b(f+u+c+k+|sh[i1]+t|b[i1]+tch|a+s+s+h+o+l+e|damn\s*you|wtf|stfu)\b/i,
    // Violence / death threats
    /\b(i('ll|'m going to|'m gonna|will)?\s*(kill|hurt|destroy|murder|beat)\s*(you|u|everyone|all)\b)/i,
    /\b(kill|murder|hurt|destroy)\s+(you|u|everyone|all|them)\b/i,
    /\b(you('re|\s*are)\s*(dead|gonna\s*die|toast))\b/i,
    // Degrading / worthlessness
    /\b(nobody\s*(likes|cares\s*(about)?)?\s*you)\b/i,
    /\b(you('re|\s*are)\s*(worthless|trash|garbage|useless|pathetic|disgusting))\b/i,
    /\b(get\s*out\s*of\s*(here|my\s*life|this\s*room))\b/i,
    // All-caps rage (3+ consecutive CAPS words ≥ 3 letters)
    /(\b[A-Z]{3,}\b\s+){3,}/,
    // Repeated character spam (e.g. "AAAAAAA", "!!!!!!!!")
    /(.)\1{5,}/,
    // "You lose / you suck" taunts
    /\b(you\s*(lose|suck|fail|are\s*a\s*(joke|clown|disgrace)))\b/i,
    /\b(haha\s*(you\s*)?(lose|lost|failed|suck))\b/i,
];

/**
 * @param {string} text
 * @returns {{ blocked: boolean }}
 */
function regexTrollCheck(text) {
    for (const pattern of TROLL_PATTERNS) {
        if (pattern.test(text)) return { blocked: true };
    }
    return { blocked: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — Gemini AI post-check  (async, runs after message is broadcast)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {string} message
 * @returns {Promise<{ isTroll: boolean, response?: string }>}
 */
async function checkTrolling(message) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `You are a content moderation assistant for a real-time chat app.
Analyze this chat message: "${message}"

Is it trolling, toxic, hate speech, or overly aggressive?
Reply ONLY with valid JSON — no markdown, no extra text.
Toxic → {"isTroll": true, "response": "A short, calm, empathetic note for the sender."}
Safe  → {"isTroll": false}`;

        const result = await model.generateContent(prompt);
        const raw = result.response.text().replace(/```json|```/g, "").trim();
        return JSON.parse(raw);
    } catch (err) {
        console.error("Gemini error:", err.message);
        return { isTroll: false };
    }
}

module.exports = { regexTrollCheck, checkTrolling };
