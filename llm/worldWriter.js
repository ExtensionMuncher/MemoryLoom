/**
 * llm/worldWriter.js — World memory generation
 *
 * World memories capture facts about the SETTING — organizations, locations,
 * power structures, world-state shifts, significant events as they affect the
 * world — NOT a character's personal experience. They are generated from a
 * closed scene, but under DELIBERATELY STRICTER criteria than character
 * memories: most scenes should produce ZERO world memories. The model is told
 * to reconcile against prior world entries and scene summaries so it only
 * records genuinely NEW or CHANGED world facts, never restating known lore.
 *
 * Kept entirely separate from the character writer so the two never tangle:
 * world pending entries carry category "world" and are reviewed in their own
 * section of the Home tab.
 */

import { makeRequest } from "./connections.js";
import { getScene, getPreviousSceneSummaries } from "../data/scenes.js";
import { getAllEntries } from "../data/entries.js";
import { getPendingEntries, savePendingEntries } from "../data/storage.js";
import { getSetting } from "../settings.js";
import { getSceneMessages } from "./writer.js";
import { dlog } from "../lib/debug.js";

function getMaxResponseTokens() {
    const v = Number(getSetting("connections.maxResponseTokens", 8000));
    return (Number.isFinite(v) && v >= 500) ? v : 8000;
}

/** Pull existing world memories so the model can reconcile against known lore. */
function getKnownWorldFacts() {
    return getAllEntries()
        .filter(e => e.category === "world")
        .map(e => `- ${e.title}: ${(e.content || "").slice(0, 200)}`);
}

function buildWorldSystemPrompt() {
    return `[MLWORLDv1] You record WORLD MEMORIES — standing facts about the SETTING of a roleplay, written from a neutral, world-level vantage. NOT a character's feelings or personal arc. You capture how the world itself is structured and how it changes.

POV — ALWAYS THIRD-PERSON OMNISCIENT:
- Write every world memory in third-person omniscient narration. Refer to ALL people — including the player character — by name and third-person pronouns (he/she/they). Never use "I", "me", "my", "we", or "us".
- This is the one place the player character is fully welcome: if a world fact genuinely involves or centers on them (their actions changed the world, an organization now tracks them, they are the source of a world-altering signature), name them and feature them as prominently as the facts support. There is NO restriction on mentioning the player character here — only the requirement that the entry be a SETTING-level fact, not their private feelings.

WHAT QUALIFIES (record ONLY these):
- Organizations, factions, institutions and their goals/structure (e.g. "The Paranormal Research Society monitors spiritual activity in the city")
- Locations of significance and what they are
- Power structures, alliances, territorial control, hierarchies
- Rules of how the world works (its systems, magic/tech, laws, supernatural mechanics)
- World-altering EVENTS and their consequences for the setting (not a character's reaction — the structural fallout)
- Shifts: when a previously-recorded world fact CHANGES (an organization exposed, a leader toppled, a barrier broken)

STRICTNESS — THIS IS CRITICAL:
- World memories are RARE. Most scenes produce NONE. A scene full of personal drama with no new world fact produces ZERO world memories. Do not force one.
- You will be given the world facts ALREADY KNOWN. Do NOT restate, rephrase, or lightly expand on anything already recorded. Record only what is genuinely NEW, or a genuine CHANGE to a known fact.
- A detail that only matters to one character's emotional state is NOT a world memory — that belongs to character memory. Ask: "Would this fact still be true and relevant if these specific characters were swapped out?" If no, do not record it.
- When in doubt, record NOTHING. A missed world fact can be added later; a flood of trivial ones is noise.

If there is nothing new or changed at the world level, output exactly: [NO WORLD MEMORY]

Otherwise, for EACH genuinely new/changed world fact, output a block in this exact format:

---

# WORLD MEMORY

**Title**: (3-6 word evocative title for the fact)
**Date/Time**: (when this became true/known, if applicable)

**Content**: (The world fact, stated neutrally and concretely. Include what changed if this revises a known fact.)

**Type**: (one of: organization, location, structure, rule, event, shift)

---

Output nothing else — no preamble, no commentary.`;
}

function buildWorldUserPrompt(sceneSummary, messages, previousSummaries, knownFacts) {
    let p = "Scene summary:\n" + (sceneSummary || "N/A") + "\n\n";
    p += "Scene messages:\n" + messages + "\n\n";
    if (previousSummaries.length > 0) {
        p += "Previous scene summaries (for reconciliation — do not re-record facts already implied here):\n";
        previousSummaries.forEach((s, i) => { p += `Scene ${i + 1}: ${String(s).substring(0, 200)}...\n`; });
        p += "\n";
    }
    if (knownFacts.length > 0) {
        p += "WORLD FACTS ALREADY RECORDED — do NOT restate or lightly rephrase any of these. Only record genuinely NEW facts or genuine CHANGES to these:\n";
        p += knownFacts.join("\n") + "\n\n";
    } else {
        p += "No world facts recorded yet — but still apply strict criteria; record only setting-level facts, not character feelings.\n\n";
    }
    p += "Review the scene at the WORLD level. Record only genuinely new or changed world facts, or output [NO WORLD MEMORY]. Remember: most scenes produce none.";
    return p;
}

/** Parse world-memory blocks out of the LLM response. */
function parseWorldResponse(response, sceneId) {
    if (!response || /\[NO WORLD MEMORY\]/i.test(response)) return [];
    const out = [];
    // split on the WORLD MEMORY header
    const blocks = response.split(/#\s*WORLD MEMORY/i).slice(1);
    for (const block of blocks) {
        const field = (label) => {
            const re = new RegExp(`\\*\\*\\s*(?:${label})\\s*\\*\\*\\s*:\\s*([^\\n]*)`, "i");
            const m = block.match(re);
            return (m && m[1] != null) ? m[1].replace(/\*+/g, "").trim() : "";
        };
        const title = field("Title");
        const datetime = field("Date/?Time|Date|Time");
        const type = field("Type");
        // Content runs from its label to the next ** label or the trailing ---
        let content = "";
        const cm = block.match(/\*\*\s*Content\s*\*\*\s*:\s*([\s\S]*?)(?:\n\*\*\s*\w|\n---|\s*$)/i);
        if (cm) content = cm[1].replace(/\*+/g, "").trim();
        if (!content && !title) continue;
        out.push({
            id: `mlpend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            title: title || "World fact",
            datetime,
            content,
            category: "world",
            primaryCharacter: "",
            primaryCharacters: [],
            keyCharacters: [],
            tags: type ? ["world", type.toLowerCase()] : ["world"],
            sceneId: sceneId || null,
            source: "scene_world",
            status: "pending",
        });
    }
    return out;
}

/**
 * Generate world memories for a closed scene. Strict — usually returns [].
 * @param {string} sceneId
 * @returns {Promise<object[]|null>}
 */
export async function generateWorldMemories(sceneId) {
    if (!getSetting("worldMemory.enabled", true)) {
        dlog("World memory: disabled in settings — skipping");
        return [];
    }
    const profileName = getSetting("connections.memoryWriterLLM", "");
    if (!profileName) return null;

    const scene = getScene(sceneId);
    if (!scene) return null;

    const sceneMessages = getSceneMessages(scene);
    const previousSummaries = getPreviousSceneSummaries(sceneId);
    const knownFacts = getKnownWorldFacts();

    const sys = buildWorldSystemPrompt();
    const user = buildWorldUserPrompt(scene.llmSummary, sceneMessages, previousSummaries, knownFacts);

    dlog(`World memory: scanning scene ${sceneId} against ${knownFacts.length} known world facts…`);
    const response = await makeRequest(profileName, sys, user, getMaxResponseTokens(), 0.5);
    if (!response) return null;

    const entries = parseWorldResponse(response, sceneId);
    dlog(`World memory: ${entries.length} world fact(s) detected`);
    if (entries.length > 0) {
        const existing = getPendingEntries() || [];
        savePendingEntries([...existing, ...entries]);
    }
    return entries;
}
