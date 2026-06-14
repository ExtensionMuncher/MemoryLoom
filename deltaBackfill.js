/**
 * llm/sidecar.js — Keyword Sidecar LLM
 *
 * Runs on every N messages (configurable). Extracts themes, character references,
 * and event mentions from recent chat context. These keywords are then fed to the
 * embedding model for vector matching against stored memory entries.
 *
 * CRITICAL: Sidecar keywords are ephemeral — they are NOT stored on entries.
 * Entry tags are for library browsing only. These are two completely separate systems.
 */

import { makeRequest } from "./connections.js";
import { getSetting } from "../settings.js";
import { chat, name1 } from "../../../../../script.js";

/**
 * Extract keywords from recent chat context.
 * Called by the sidecar pipeline in index.js.
 *
 * @returns {Promise<{keywords: string[], characters: string[], themes: string[]}>}
 */
export async function extractKeywords() {
    const profileName = getSetting("connections.sidecarLLM", "");
    if (!profileName) {
        console.warn("[ML] Sidecar LLM not configured — skipping keyword extraction");
        return { keywords: [], characters: [], themes: [] };
    }

    // Get recent messages (last 15 by default for sidecar context)
    const recentMessages = getRecentMessages(15);
    if (!recentMessages) {
        console.warn("[ML] No recent messages to extract keywords from");
        return { keywords: [], characters: [], themes: [] };
    }

    const systemPrompt = buildSidecarSystemPrompt();
    const userPrompt = buildSidecarUserPrompt(recentMessages);

    console.log("[ML] Sidecar: extracting keywords...");
    const response = await makeRequest(profileName, systemPrompt, userPrompt, 200, 0.3);

    if (!response) {
        console.warn("[ML] Sidecar: no response from LLM");
        return { keywords: [], characters: [], themes: [] };
    }

    return parseSidecarResponse(response);
}

/**
 * Build the sidecar system prompt.
 * This is hardcoded — it is NOT user-configurable.
 * The sidecar's job is narrow: extract what's being discussed right now
 * so the embedding model can find relevant stored memories.
 *
 * @returns {string}
 */
function buildSidecarSystemPrompt() {
    return `You are a keyword extraction system for a memory archive. Your job is to read recent chat messages and extract:

1. CHARACTER NAMES — Any named characters present or referenced in the conversation. Never include the user persona (${name1 || "the user"}). List only NPC/character names.

2. THEMES — Key themes, topics, emotional dynamics, or relational patterns at play in the recent messages. Be specific: "jealousy masked as indifference" is better than "jealousy".

3. EVENT REFERENCES — Specific events, locations, or situations being discussed or referenced.

Output as JSON:
{
  "characters": ["name1", "name2"],
  "themes": ["theme1", "theme2"],
  "events": ["event reference 1", "event reference 2"]
}

Keep each list concise — 2-5 items per category. Focus on what is most salient RIGHT NOW in the most recent messages.`;
}

/**
 * Build the user prompt with recent message context.
 * @param {string} recentMessages - Formatted recent messages
 * @returns {string}
 */
function buildSidecarUserPrompt(recentMessages) {
    return `Recent chat messages:\n\n${recentMessages}\n\nExtract keywords as JSON.`;
}

/**
 * Get the last N messages from the chat, formatted for the sidecar.
 * @param {number} count
 * @returns {string}
 */
function getRecentMessages(count) {
    if (!chat || !Array.isArray(chat)) return "";
    const recent = chat.slice(-count);
    return recent.map(msg => {
        const speaker = msg.is_user ? (name1 || "User") : (msg.name || "Character");
        const text = String(msg.mes || "").substring(0, 1000); // Truncate long messages
        return `${speaker}: ${text}`;
    }).join("\n");
}

/**
 * Parse the sidecar LLM response into structured keywords.
 * Handles JSON extraction from potentially messy LLM output.
 *
 * @param {string} response
 * @returns {{keywords: string[], characters: string[], themes: string[]}}
 */
function parseSidecarResponse(response) {
    try {
        // Try to extract JSON from the response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn("[ML] Sidecar: no JSON found in response");
            return { keywords: [], characters: [], themes: [] };
        }

        const parsed = JSON.parse(jsonMatch[0]);
        const characters = parsed.characters || [];
        const themes = parsed.themes || [];
        const events = parsed.events || [];

        // Combine themes and events into keywords for the embedding query
        const keywords = [...themes, ...events];

        console.log(`[ML] Sidecar extracted: ${characters.length} chars, ${themes.length} themes, ${events.length} events`);

        return { keywords, characters, themes };
    } catch (err) {
        console.warn("[ML] Sidecar: failed to parse JSON response:", err.message);
        return { keywords: [], characters: [], themes: [] };
    }
}
