/**
 * llm/writer.js — Memory Writer LLM
 *
 * Generates scene summaries and memory entries when the user closes a scene.
 * This is the core "WRITE" layer of Memory Loom.
 *
 * Flow:
 *   1. generateSceneSummary() — Creates an internal narrative summary of the scene
 *   2. generateMemoryEntries() — Identifies significant moments and generates entries
 *
 * Scene summaries are INTERNAL ONLY — never injected into the main ST prompt.
 * Memory entries are shown on the Home tab for user review before commit.
 */

import { makeRequest } from "./connections.js";
import { getSetting } from "../settings.js";
import { chat, name1 } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
import { getScene, getPreviousSceneSummaries, updateSceneSummary } from "../data/scenes.js";
import { getPendingEntries, savePendingEntries } from "../data/storage.js";


import { resolveCanonicalCharacter } from "../data/folders.js";
/**
 * Max tokens for writer/summary responses. Must be large enough to hold a
 * thinking model's reasoning AND its final answer — reasoning counts against
 * the same budget, and when it runs out the answer comes back empty or cut off.
 */
function getMaxResponseTokens() {
    const v = Number(getSetting("connections.maxResponseTokens", 8000));
    return (Number.isFinite(v) && v >= 500) ? v : 8000;
}

// ─── Scene Summary Generation ─────────────────────────────

/**
 * Generate an internal scene summary for a closed scene.
 * Summaries are for the memory writer's internal reference only —
 * they are NEVER injected into the main ST prompt.
 *
 * @param {string} sceneId - The scene to summarize
 * @returns {Promise<string|null>} The generated summary, or null on failure
 */
export async function generateSceneSummary(sceneId) {
    const profileName = getSetting("connections.sceneSummaryLLM", "") || getSetting("connections.memoryWriterLLM", "");
    if (!profileName) {
        console.warn("[ML] Memory Writer LLM not configured");
        toastr?.warning?.("Memory Writer LLM not configured. Check Settings > Connections.");
        return null;
    }

    const scene = getScene(sceneId);
    if (!scene) {
        console.warn(`[ML] Scene not found: ${sceneId}`);
        return null;
    }

    // Get the scene's messages
    const sceneMessages = getSceneMessages(scene);
    // Get previous scene summaries for continuity context
    const previousSummaries = getPreviousSceneSummaries(sceneId);

    const systemPrompt = resolveSceneSummaryPrompt();
    const userPrompt = buildSceneSummaryUserPrompt(sceneMessages, previousSummaries);

    console.log(`[ML] Writer: generating scene summary for ${sceneId}...`);
    // Thinking models burn output budget on reasoning BEFORE the answer — the cap
    // must hold reasoning + answer combined. Configurable in Settings > Connections.
    const summary = await makeRequest(profileName, systemPrompt, userPrompt, getMaxResponseTokens(), 0.7);

    if (summary) {
        updateSceneSummary(sceneId, summary);
        console.log(`[ML] Writer: scene summary generated (${summary.length} chars)`);
    }

    return summary;
}

/**
 * Generate memory entries for a closed scene.
 * Called after the scene summary has been generated.
 *
 * @param {string} sceneId
 * @returns {Promise<object[]|null>} Array of pending entry objects, or null on failure
 */
export async function generateMemoryEntries(sceneId) {
    const profileName = getSetting("connections.memoryWriterLLM", "");
    if (!profileName) return null;

    const scene = getScene(sceneId);
    if (!scene) return null;

    const sceneMessages = getSceneMessages(scene);
    const previousSummaries = getPreviousSceneSummaries(sceneId);

    const systemPrompt = resolveMemoryEntryPrompt();
    const userPrompt = buildMemoryEntryUserPrompt(scene.llmSummary, sceneMessages, previousSummaries);

    console.log(`[ML] Writer: generating memory entries for ${sceneId}...`);
    const response = await makeRequest(profileName, systemPrompt, userPrompt, getMaxResponseTokens(), 0.75);

    if (!response) {
        console.warn("[ML] Writer: no response from LLM");
        return null;
    }

    const entries = parseWriterResponse(response, sceneId);
    if (entries && entries.length > 0) {
        // Append to existing pending entries (don't overwrite during batch scan)
        const existing = getPendingEntries() || [];
        savePendingEntries([...existing, ...entries]);
        console.log(`[ML] Writer: ${entries.length} entries generated, pending review`);
    } else if (response && response.trim().length > 20) {
        // Response had content but nothing parsed — likely a format issue, not [NO MEMORY]
        console.warn(`[ML] Writer: response received but no entries parsed for ${sceneId}. Raw response:`, response.slice(0, 200));
    }

    return entries;
}

/**
 * Full writer flow: generate summary → generate entries.
 * Called from index.js when a scene is closed.
 *
 * @param {string} sceneId
 * @returns {Promise<object[]|null>}
 */
export async function runWriterFlow(sceneId) {
    // Capture chat at start — if the user switches chats while the LLM is generating,
    // abort before writing, or we'd save this chat's results into the other chat's data.
    const flowChatId = getContext().chatId;

    const summary = await generateSceneSummary(sceneId);
    if (getContext().chatId !== flowChatId) {
        console.warn("[ML] Writer flow aborted — chat changed during generation.");
        return null;
    }
    if (!summary) {
        toastr?.error?.("Failed to generate scene summary. Check LLM connection.");
        return null;
    }

    // Space the two calls out — token-per-minute throttles (GLM Cloud) trip on
    // back-to-back large requests even when the request count is low.
    await new Promise(r => setTimeout(r, 2500));

    const entries = await generateMemoryEntries(sceneId);
    if (getContext().chatId !== flowChatId) {
        console.warn("[ML] Writer flow aborted — chat changed during generation.");
        return null;
    }
    if (!entries) {
        toastr?.error?.("Failed to generate memory entries. Check LLM connection.");
        return null;
    }

    return entries;
}

// ─── Regeneration ─────────────────────────────────────────

/**
 * Regenerate a single pending entry with optional user guidance.
 *
 * @param {object} entry - The existing entry data
 * @param {string} [guidance] - Optional user-provided guidance for regeneration
 * @returns {Promise<object|null>}
 */
export async function regenerateEntry(entry, guidance = "") {
    const profileName = getSetting("connections.memoryWriterLLM", "");
    if (!profileName) return null;

    const systemPrompt = resolveMemoryEntryPrompt();
    const userPrompt = buildRegenerationPrompt(entry, guidance);

    const response = await makeRequest(profileName, systemPrompt, userPrompt, getMaxResponseTokens(), 0.8);
    if (!response) return null;

    const entries = parseWriterResponse(response, entry.sceneId);
    return entries?.[0] || null;
}

// ─── Prompt Builders ──────────────────────────────────────

function buildDefaultSceneSummaryPrompt() {
    return `[MLv4] Write a factual scene reference note. Start with:

Title: [3-6 word evocative title]

Then 2-3 paragraphs reporting what happened, in the exact order it occurred. Include key dialogue when it drives the scene. Report only events actually present in the scene text — do not rearrange the sequence, fuse separate moments, or add details that are not there. Past tense, plain prose. No bullets, no bold, no "Scene Context:" prefix.`;
}

function buildDefaultMemoryEntryPrompt() {
    return `[MLv4] Pause and review the scene. Create a Core Memory using this exact format. Memories belong ONLY to NPCs. {{user}} is the human player: NEVER write an entry whose Primary Character is {{user}}, and never write an unattributed entry or one labelled "Unknown" as a workaround. If a moment matters only to {{user}} with no NPC present, skip it entirely — it is not a Core Memory, and you must output nothing for it rather than inventing a placeholder or explanatory Primary Character. This restriction applies ONLY to the Primary Character field — to who OWNS the memory. Within the Content, Before, After, and Delta, write about {{user}} freely, naturally, and BY NAME, exactly as you would any other character. Never avoid, soften, or talk around {{user}}'s name — a memory about an NPC's bond with {{user}} should name {{user}} as plainly as it names anyone else:

**Title**:
**Date/Time**:

**Content**:

**Primary Character**: (one name — or, ONLY for a genuinely joint memory shared equally by two or more characters, comma-separated names; joint memories are rare)
**Key Character**:

**Before**:
**After**:
**Delta**:

Every field must be filled in — including Before, After, and Delta on every entry — with ONE exception: Key Character. Primary Character is the full name of the NPC this memory belongs to — never blank, never "Unknown", never {{user}}. If no present NPC can own the memory, do not write the entry at all. Key Character lists OTHER characters who are ACTIVELY present and participating in the moment (including the human player's character by name). It is the only optional field: if the memory is a private moment — the Primary Character alone with their thoughts, reflecting, observing, or acting unwitnessed — leave Key Character empty. Being the SUBJECT of the Primary Character's reflection does not make someone a Key Character: a character who is asleep, absent, or merely being thought about is not a participant in the memory. In the Content, use a character's FULL name at most once — the first time they appear, and only if it reads naturally for the viewpoint character (e.g. a first meeting). After that first mention, use their given name or a pronoun. Never repeat a full name in entry after entry or sentence after sentence; it reads robotic. For the player character especially, a single natural full-name introduction is plenty, then just the given name.

Write in THIRD PERSON LIMITED, past tense — never first person (no I/me/my) and never second person (no you/your) anywhere, including Before, After, and Delta. The narration is limited to the Primary Character's knowledge: never state what the human player's character feels or realizes — the Primary Character can only observe what they outwardly say and do.

End the Content with what this moment became for the character — the dynamic it established, the private reminder it left, the desire or unease it planted, the view it changed. The final sentence should carry the lasting consequence, the way a person privately understands why a memory stuck with them. Without this, it is a summary, not a memory.

This is a multi-character roleplay with no narrator — characters come and go, so the character in the chat title may be absent here. Choose a Primary Character who is actually present in the scene.

A scene may yield more than one Core Memory, if narratively necessary:
- Several characters sharing a pivotal moment can each walk away with their own memory of it — same event, different perspective, different takeaway.
- A SINGLE character can form multiple Core Memories from one scene when they experience more than one defining moment within it. Do not merge distinct defining moments into one entry — give each its own.
Write one complete entry per memory. Every entry must fill in ALL fields, including Before, After, and Delta — no entry may omit them. Separate entries with a line containing only: ---

Just as a scene can yield several memories, it can also yield none. If no meaningful Core Memory exists for any present character, reply with only: [NO MEMORY]`;
}

function buildSceneSummaryUserPrompt(messages, previousSummaries) {
    let prompt = "Scene messages:\n\n" + messages;
    if (previousSummaries.length > 0) {
        // Only the most recent 3 summaries, truncated — including every past summary
        // in full made the request grow unboundedly and trip provider token throttles.
        const recent = previousSummaries.slice(-3);
        prompt += "\n\nRecent scene context (for continuity):\n\n";
        recent.forEach((s, i) => {
            prompt += `--- Earlier Scene ---\n${String(s).substring(0, 400)}\n\n`;
        });
    }
    prompt += "\n\nWrite the scene reference note now. Your first line must be: Title: [short title].";
    return prompt;
}


function buildMemoryEntryUserPrompt(sceneSummary, messages, previousSummaries) {
    let prompt = "Scene summary:\n" + (sceneSummary || "N/A") + "\n\n";
    prompt += "Scene messages:\n" + messages + "\n\n";
    if (previousSummaries.length > 0) {
        prompt += "Previous scene summaries:\n";
        previousSummaries.forEach((s, i) => {
            prompt += `Scene ${i + 1}: ${s.substring(0, 200)}...\n`;
        });
    }
    prompt += "\nReview the scene above and create the Core Memory.";
    const banned = getBannedPrimaries();
    if (banned.length > 0) {
        prompt += ` FINAL RULE, overriding everything else: never create a memory whose Primary Character is ${banned.join(" or ")}. This governs ONLY the Primary Character field — inside a memory's Content, refer to them freely and by full name like any other character; never avoid or dance around their names. They are valid Key Characters. If a defining moment belongs solely to them — with no NPC present — that is not a memory: SKIP it and output nothing for it. Do NOT write an entry with an empty, placeholder, "Unknown", or explanatory Primary Character (for example, never write something like "(No NPC present...)" in the name field). The Primary Character field must contain a real NPC name or the entry must not exist.`;
    }
    return prompt;
}

export function resolveMemoryEntryPrompt() {
    const saved = getSetting("memoryWriting.memoryEntryPrompt", "");
    const prompt = (saved && saved.includes("[MLv4]")) ? saved : buildDefaultMemoryEntryPrompt();
    return substituteUserMacro(prompt);
}

export function resolveSceneSummaryPrompt() {
    const saved = getSetting("memoryWriting.sceneSummaryPrompt", "");
    const prompt = (saved && saved.includes("[MLv4]")) ? saved : buildDefaultSceneSummaryPrompt();
    return substituteUserMacro(prompt);
}

// The {{user}} macro is only substituted by ST inside the chat pipeline — raw API
// calls send it as literal text, so the model has no idea who "{{user}}" is and
// keeps writing memories for the player, wasting tokens. Substitute it ourselves.
function substituteUserMacro(text) {
    const playerName = (typeof name1 !== "undefined" && name1) ? name1 : "the human player";
    return String(text).replace(/\{\{user\}\}/gi, playerName);
}

function buildRegenerationPrompt(entry, guidance) {
    let prompt = "Regenerate this memory entry:\n\n";
    prompt += `Title: ${entry.title}\n`;
    prompt += `Content: ${entry.content}\n`;
    if (guidance) {
        prompt += `\nUser guidance: ${guidance}\n`;
    }
    prompt += "\nWrite the Core Memory entry using the exact format from your instructions. Usually ONE entry — only if something genuinely pivotal happened.";
    return prompt;
}

// ─── Helpers ──────────────────────────────────────────────



/**
 * Sanitize a raw Key Character value. Models love to dodge "leave it blank" by
 * writing an explanatory sentence into the field — e.g.
 * "(None—Rin is alone in her chambers, reflecting on secondhand information)".
 * That is noise the user then has to delete by hand. This drops any token that
 * is a "none"-style placeholder or reads like prose rather than a name, and
 * returns a clean array (often empty, which is valid for Key Characters).
 */
function sanitizeKeyCharacters(list) {
    const out = [];
    for (let raw of (list || [])) {
        let n = String(raw || "").replace(/\*+/g, "").trim();
        if (!n) continue;
        const low = n.toLowerCase();
        // placeholder / "no one present" phrasing → drop
        if (["none", "n/a", "na", "nobody", "no one", "unknown", "-"].includes(low)) continue;
        if (/\bnone\b|\bno\s+(one|npc|character)\b|\balone\b|reflect|secondhand|present\b/i.test(n)) continue;
        // prose, not a name → drop (sentences/punctuation/over-long)
        if (n.length > 40 || /[.!?;:]|—|--|\(|\)/.test(n)) continue;
        out.push(resolveCanonicalCharacter(n));
    }
    return out;
}

/**
 * Normalize a raw Primary Character value into a clean array.
 * Splits joint memories ("A & B", "A, B"), resolves each name to its canonical
 * folder name, and drops banned/unknown names individually. An entry survives
 * as long as at least one valid NPC remains. 2+ survivors = a joint memory,
 * which routeEntry files into the Group subfolder automatically.
 */
function normalizePrimaries(raw) {
    const names = Array.isArray(raw) ? raw : String(raw || "").split(/\s*[,&]\s*|\s+and\s+/i);
    const out = [];
    for (let n of names) {
        n = String(n || "").replace(/\*+/g, "").trim();
        if (!n) continue;
        if (isPlayerOrUnknownEntry(n)) {
            console.warn(`[ML] Writer: dropped banned/unknown primary "${n}" from joint memory`);
            continue;
        }
        const canon = resolveCanonicalCharacter(n);
        if (!out.includes(canon)) out.push(canon);
    }
    return out;
}

/**
 * Get the text of messages within a scene's range.
 * @param {object} scene
 * @returns {string}
 */
function getSceneMessages(scene) {
    if (!chat || !Array.isArray(chat)) return "";
    const msgs = chat.slice(scene.messageStart, (scene.messageEnd || chat.length) + 1)
        .filter(msg => !(msg.is_system && msg.extra?.hidden));

    // Total budget so one request can never explode past provider token limits.
    // Normal scenes (under ~12k chars total) pass through with full prose.
    // Longer scenes get a proportionally reduced per-message cap (never below 600).
    const TOTAL_BUDGET = 12000;
    let perMsgCap = 4000;
    const fullTotal = msgs.reduce((s, m) => s + Math.min((m.mes || "").length, perMsgCap), 0);
    if (fullTotal > TOTAL_BUDGET && msgs.length > 0) {
        perMsgCap = Math.max(600, Math.floor(TOTAL_BUDGET / msgs.length));
    }

    return msgs.map(msg => {
        const text = String(msg.mes || "").substring(0, perMsgCap);
        if (msg.is_user) {
            return `[${name1 || "User"}, the human player, writes:]\n${text}`;
        }
        return text;
    }).join("\n\n");
}


// ─── Player/unknown entry filter ──────────────────────────
// Hard backstop: discard any entry that cannot be attributed to a real NPC.
// Catches blank primaries, "Unknown"/"None"/"N/A" placeholders, the literal
// {{user}} macro, the player persona's full name, AND any single token of the
// persona name (so "Sachiko" alone is caught when the persona is "Furukawa
// Sachiko"). The prompt tells the model not to write these; this guarantees
// none survive even when the model ignores that.
function getBannedPrimaries() {
    // Persona is always banned; the user can ban additional characters in
    // Settings > Memory Writing (comma-separated). Banned characters may still
    // appear as Key Characters inside other characters' memories — the ban
    // applies ONLY to memory ownership (Primary Character).
    const names = [];
    const persona = (typeof name1 !== "undefined" && name1) ? String(name1).trim() : "";
    if (persona) names.push(persona);
    const raw = getSetting("memoryWriting.bannedCharacters", "");
    String(raw).split(",").map(s => s.trim()).filter(Boolean).forEach(n => names.push(n));
    return names;
}

function isPlayerOrUnknownEntry(primary) {
    const p = String(primary || "").replace(/\*+/g, "").trim().toLowerCase();
    if (!p) return true;
    if (["unknown", "none", "n/a", "na", "{{user}}", "user", "the human player", "player"].includes(p)) return true;
    // Prose-evasion guard: models try to dodge the ban by writing an explanatory
    // sentence INTO the name field, e.g. "(No NPC present—this moment belongs
    // solely to Furukawa Sachiko)". Any primary that talks about absence of an
    // NPC, or reads like a sentence rather than a name, is rejected outright.
    if (/\bno\s+(npc|character|one)\b|belongs\s+solely|only\s+(the\s+)?(user|player)|solely\s+to\b/i.test(p)) return true;
    if (p.length > 40 || /[.!?;]|—|--/.test(p)) return true; // names aren't sentences
    for (const name of getBannedPrimaries()) {
        const banned = name.toLowerCase();
        if (p === banned) return true;
        // token match: any whole word of a banned name used alone as the primary
        const tokens = banned.split(/\s+/).filter(t => t.length >= 3);
        if (tokens.includes(p)) return true;
        // containment: a banned name appearing ANYWHERE in a longer primary string
        // (catches prose that smuggles the persona name in past the exact checks)
        if (tokens.length && tokens.every(t => p.includes(t))) return true;
    }
    return false;
}

/**
 * Parse the writer LLM response into an array of entry objects.
 * Handles JSON extraction from potentially messy LLM output.
 *
 * @param {string} response
 * @param {string} sceneId
 * @returns {object[]|null}
 */
function parseWriterResponse(response, sceneId) {
    if (!response) {
        console.warn("[ML] Writer: empty response from LLM for " + sceneId);
        return null;
    }
    // Strip <think>...</think> reasoning blocks. Some models (GLM) also dump raw
    // chain-of-thought with no tags; if a clean **Title** entry exists later in the
    // text, isolate from the LAST occurrence so we skip the deliberation preamble.
    response = response.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    // If the FIRST entry header appears deep into the text, everything before it is
    // reasoning preamble — cut it. Using the first occurrence preserves ALL entries
    // (lastIndexOf previously discarded every entry except the final one).
    const firstTitle = response.search(/\*\*\s*Title\s*\*\*\s*:/i);
    if (firstTitle > 200) {
        response = response.slice(firstTitle);
    }

    // Detect explicit "no memory" signal. Two cases:
    //  (a) the cleaned response IS just the no-memory token, or
    //  (b) the response STARTS with [NO MEMORY] / "no memory" followed by a short
    //      explanation (e.g. "[NO MEMORY] - nothing pivotal happened").
    // We must NOT trip on the phrase appearing deep inside a real entry, and we must
    // not trip when a real **Title**/**Content** entry is present.
    const cleaned = response.trim().replace(/[\[\]*_`#]/g, "").toLowerCase().trim();
    const hasRealEntry = /\*\*\s*(title|content|primary)\s*\*\*\s*:/i.test(response);
    const noMemExact = cleaned === "no memory" || cleaned === "no memory needed" ||
        cleaned === "none" || cleaned === "no core memory" || cleaned === "no entry";
    const noMemLeading = /^(no memory|no core memory|no entry)\b/.test(cleaned) && cleaned.length < 120;
    if (!hasRealEntry && (noMemExact || noMemLeading)) {
        console.log("[ML] Writer: model returned [NO MEMORY] for " + sceneId + " — no entry created");
        return null;
    }
    try {
        // Only treat as JSON if the response actually STARTS with a JSON array
        // (after optional code fence). Otherwise a stray "[NPC]" or "[NO MEMORY]"
        // token inside prose would be mis-detected as JSON and throw.
        const fenced = response.replace(/^```(?:json)?\s*/i, "").trim();
        const looksLikeJson = fenced.startsWith("[{") || /^\[\s*\{/.test(fenced);
        const jsonMatch = looksLikeJson ? fenced.match(/\[[\s\S]*\]/) : null;
        if (!jsonMatch) {
            console.log("[ML] Writer: not JSON, using markdown parser...");
            return parseMarkdownMemory(response, sceneId);
        }

        const entries = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(entries)) {
            console.warn("[ML] Writer: parsed response is not an array");
            return parseMarkdownMemory(response, sceneId);
        }

        // Normalize each entry and attach sceneId
        return entries.map(e => ({
            title: e.title || e.Title || "Untitled",
            datetime: e.datetime || e.date || e.Date || "",
            content: e.content || e.body || e.prose || e.entry || e.memory_entry || e.Memory || e.memory || e.text || "",
            primaryCharacter: e.primaryCharacter || e.primary_character || e["Primary Character"] || e.npc_name || e.npc || e.character || e.name || "",
            primaryCharacters: e.primaryCharacters || e.primary_characters || (e.primaryCharacter ? [e.primaryCharacter] : []),
            keyCharacters: e.keyCharacters || e.key_characters || [],
            category: e.category || "character",
            tags: e.tags || [],
            status: "active",
            delta: {
                before_state: e.delta?.before_state || e.before_state || "",
                after_state: e.delta?.after_state || e.after_state || "",
                delta: e.delta?.delta || e.delta_summary || "",
                delta_type: e.delta?.delta_type || e.delta_type || [],
                low_delta_flag: e.delta?.low_delta_flag || e.low_delta_flag || false,
            },
            source: "llm_generated",
            sceneId: sceneId,
        })).map(e => {
            // Split joint primaries, resolve canonical names, drop banned/unknown
            // names individually ("Ichigo Kurosaki" → "Kurosaki Ichigo")
            const primaries = normalizePrimaries(e.primaryCharacter || e.primaryCharacters);
            e.primaryCharacter = primaries.length === 1 ? primaries[0] : "";
            e.primaryCharacters = primaries;
            e.keyCharacters = sanitizeKeyCharacters(e.keyCharacters || e.key_characters || []);
            return e;
        }).filter(e => {
            if (e.primaryCharacters.length === 0) {
                console.warn(`[ML] Writer: discarded entry attributed to player/unknown: "${(e.title || "Untitled")}"`);
                return false;
            }
            return true;
        });
    } catch (err) {
        console.warn("[ML] Writer: JSON parse failed:", err.message);
    }
    // ── Markdown fallback ──
    return parseMarkdownMemory(response, sceneId);
}

function parseMarkdownMemory(text, sceneId) {
    if (!text) return null;
    // Strip code-fence MARKER LINES only. The old pattern /^```[\s\S]*?```$/ matched
    // the markers AND everything between them, deleting entire fenced responses.
    text = text.replace(/^```\w*\s*$/gm, "").trim();
    
    // Split on --- separator; if none, treat whole text as one block
    var blocks = text.split(/^-{3,}\s*$/m);
    blocks = blocks.map(function(b) { return b.trim(); }).filter(function(b) { return b.length > 10; });
    if (blocks.length === 0 && text.length > 10) blocks.push(text.trim());
    
    var results = [];
    
    for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i];
        var lines = block.split("\n");
        var title = "", date = "", primary = "", keyChar = "", contentLines = [];
        var inContent = false;
        
        for (var j = 0; j < lines.length; j++) {
            var line = lines[j].trim();
            // Check for field headers: **FieldName**: value
            var headerMatch = line.match(/^\*\*([^*]+)\*\*\s*:\s*(.*)/);
            if (headerMatch) {
                var fieldName = headerMatch[1].trim().toLowerCase();
                var fieldVal = headerMatch[2].trim();
                if (fieldName === "title") { title = fieldVal; inContent = false; }
                else if (fieldName === "date" || fieldName === "date/time") { date = fieldVal; inContent = false; }
                else if (fieldName === "content") { contentLines = [fieldVal]; inContent = true; }
                else if (fieldName.indexOf("primary") !== -1) { primary = fieldVal; inContent = false; }
                else if (fieldName.indexOf("key") !== -1) { keyChar = fieldVal; inContent = false; }
                else { inContent = false; }
            } else if (inContent && line.length > 0) {
                // Continuation of content field
                contentLines.push(line);
            }
        }
        
        var narrative = contentLines.join(" ").trim();
        // Clean any stray markdown
        primary = primary.replace(/\*+/g, "").trim();
        keyChar = keyChar.replace(/\*+/g, "").trim();
        title = title.replace(/\*+/g, "").trim();
        
        if (!primary && !narrative) continue;
        // Hard-discard player / unknown / unattributed entries. The old check only
        // caught an EXACT persona-name match — blank and "Unknown" primaries (the
        // breakthrough player-memories) sailed straight through it.
        // Split joint primaries, resolve canonical names, drop banned/unknown
        // names individually. Empty result = nothing valid left → discard entry.
        var primaries = normalizePrimaries(primary);
        if (primaries.length === 0) {
            console.warn(`[ML] Writer: discarded entry attributed to player/unknown ("${primary || "blank"}"): "${title || "Untitled"}"`);
            continue;
        }
        
        var keyChars = sanitizeKeyCharacters(keyChar ? keyChar.split(",") : []);
        // Extract delta fields
        var beforeState = "", afterState = "", deltaLabel = "";
        for (var dj = 0; dj < lines.length; dj++) {
            var dline = lines[dj].trim();
            var dMatch = dline.match(/^\*\*([^*]+)\*\*\s*:\s*(.*)/);
            if (dMatch) {
                var dName = dMatch[1].trim().toLowerCase();
                if (dName === "before") beforeState = dMatch[2].trim();
                else if (dName === "after") afterState = dMatch[2].trim();
                else if (dName === "delta") deltaLabel = dMatch[2].trim();
            }
        }
        results.push({
            title: title || "Untitled",
            datetime: date || "",
            content: narrative,
            primaryCharacter: primaries.length === 1 ? primaries[0] : "",
            primaryCharacters: primaries,
            keyCharacters: keyChars,
            category: "character",
            tags: [],
            status: "active",
            delta: {
                before_state: beforeState,
                after_state: afterState,
                delta: deltaLabel,
                delta_type: [],  // tags duplicated the delta text in the UI — leave empty
                low_delta_flag: false
            },
            source: "llm_generated",
            sceneId: sceneId
        });
    }
    if (results.length > 0) console.log("[ML] Writer: parsed " + results.length + " entries from markdown");
    return results.length > 0 ? results : null;
}

