/**
 * llm/autoTag.js — Auto-tag assist for manually created entries
 *
 * Calls the Memory Writer LLM (or a smaller model) to suggest descriptive tags
 * based on the entry's content. Tags are for library browsing only —
 * they are NOT used in the embedding pipeline.
 *
 * User can accept or modify suggested tags before saving.
 */

import { makeRequest } from "./connections.js";
import { getSetting } from "../settings.js";

/**
 * Suggest tags for a memory entry based on its content.
 * Uses the Memory Writer LLM profile.
 *
 * @param {object} entry - Entry data { title, content, primaryCharacter, keyCharacters }
 * @returns {Promise<string[]>} Array of suggested tag strings
 */
export async function suggestTags(entry) {
    const profileName = getSetting("connections.memoryWriterLLM", "");
    if (!profileName) {
        console.warn("[ML] Auto-tag: no LLM configured, cannot suggest tags");
        return [];
    }

    const systemPrompt = buildTagSystemPrompt();
    const userPrompt = buildTagUserPrompt(entry);

    console.log("[ML] Auto-tag: suggesting tags...");
    const response = await makeRequest(profileName, systemPrompt, userPrompt, 100, 0.3);

    if (!response) {
        console.warn("[ML] Auto-tag: no response from LLM");
        return [];
    }

    return parseTagResponse(response);
}

function buildTagSystemPrompt() {
    return `You are a tagging assistant for a memory archive. Given a memory entry, suggest 3-8 descriptive tags that would help a user browse and filter entries in a library.

Tags should be:
- Lowercase, single words or short compound phrases (e.g. "victorian_era", "trust_building", "betrayal")
- Descriptive of content, themes, emotions, relationships, or events
- NOT character names (characters are tracked separately)

Output as a JSON array of strings: ["tag1", "tag2", "tag3"]`;
}

function buildTagUserPrompt(entry) {
    return `Memory entry:
Title: ${entry.title || ""}
Character: ${entry.primaryCharacter || (entry.primaryCharacters || []).join(", ")}
Content: ${(entry.content || "").substring(0, 800)}

Suggest tags as a JSON array.`;
}

/**
 * Parse the tag suggestion response.
 * @param {string} response
 * @returns {string[]}
 */
function parseTagResponse(response) {
    try {
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];

        const tags = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(tags)) return [];

        // Clean and deduplicate
        return [...new Set(tags.map(t => String(t).toLowerCase().trim()).filter(Boolean))];
    } catch (err) {
        console.warn("[ML] Auto-tag: failed to parse response:", err.message);
        return [];
    }
}
