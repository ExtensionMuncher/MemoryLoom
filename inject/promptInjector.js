/**
 * inject/promptInjector.js — System prompt injection for Memory Loom
 *
 * Injects matched memory entries into ST's system prompt using setExtensionPrompt().
 * Handles placement (above/below card, top/bottom), formatting, and cleanup.
 *
 * Also manages an internal generation guard to prevent self-injection during
 * Memory Loom's own LLM API calls.
 *
 * Pattern: follows relationship-stat-tracker's inject/promptInjector.js exactly.
 */

import { setExtensionPrompt } from "../../../../../script.js";
import { getSetting } from "../settings.js";
import { isMLInternalGen } from "../llm/connections.js";
import { dlog } from "../lib/debug.js";

// ─── Constants ────────────────────────────────────────────

/** Extension prompt tag — unique identifier for ML's injection */
const PROMPT_ID = "ml-memory-injection";
const ROLE_SYSTEM = 0;

/**
 * Placement mapping to ST's injection position/depth.
 * Only ST-standard positions: top(0), above character card(1), below character card(2)
 * bottom maps to depth 4 (after character card).
 */
const PLACEMENT_MAP = {
    above_card: 1,
    below_card: 2,
    top: 0,
    bottom: 4,
};

// ─── Main Injection Function ──────────────────────────────

/**
 * Update the injected memory block in the system prompt.
 * Called by the retrieval pipeline when candidates are found.
 *
 * @param {object[]} candidates - Array of { entry, score } objects
 */
export function updateInjection(candidates) {
    const settings = getSetting("injection", {});
    if (!settings.enabled) {
        removeInjection();
        return;
    }

    if (!candidates || candidates.length === 0) {
        removeInjection();
        return;
    }

    // Build the injection block
    const content = buildInjectionBlock(candidates);
    if (!content) {
        removeInjection();
        return;
    }

    const position = PLACEMENT_MAP[settings.placement] || 2;

    // Register the injection
    setExtensionPrompt(PROMPT_ID, content, position, 0, false, ROLE_SYSTEM);
    console.log(`[ML] Injection updated: ${candidates.length} entries`);
    dlog("Injection block now in system prompt:", candidates.map(c => `"${c.entry.title}"`).join(", "));
}

/**
 * Remove the injected memory block from the system prompt.
 */
export function removeInjection() {
    setExtensionPrompt(PROMPT_ID, "", 0, 0, false, ROLE_SYSTEM);
}

// ─── Injection Block Builder ──────────────────────────────

/**
 * Build the formatted injection block from candidate entries.
 * Groups entries by primary character and formats as markdown.
 *
 * @param {Array<{entry: object, score: number}>} candidates
 * @returns {string}
 */
/**
 * Format entries as CORE MEMORY blocks — shared by passive injection and the
 * memory recall tool, so the model sees one consistent memory format.
 */
export function formatMemoriesAsBlocks(entries) {
    return buildInjectionBlock(entries.map(e => ({ entry: e })));
}

function buildInjectionBlock(candidates) {
    // One block per memory, in the user-specified CORE MEMORY format:
    //   ---
    //   # CORE MEMORY
    //   **Title** / **Date/Time** / **Content** / **Primary Character**
    //   **Key Character(s)** only when there are key characters
    //   ---
    const parts = [];
    for (const { entry } of candidates) {
        const primaries = (entry.primaryCharacters && entry.primaryCharacters.length)
            ? entry.primaryCharacters
            : (entry.primaryCharacter ? [entry.primaryCharacter] : []);
        parts.push("---");
        parts.push("");
        parts.push("# CORE MEMORY");
        parts.push("");
        parts.push(`**Title**: ${entry.title || "Untitled"}`);
        parts.push(`**Date/Time**: ${entry.datetime || "Unknown"}`);
        parts.push("");
        parts.push("**Content**:");
        parts.push(entry.content || "");
        parts.push("");
        parts.push(`**Primary Character**: ${primaries.join(", ") || "Unknown"}`);
        if (entry.keyCharacters && entry.keyCharacters.length > 0) {
            parts.push(`**Key Character(s)**: ${entry.keyCharacters.join(", ")}`);
        }
        parts.push("");
    }
    parts.push("---");
    return parts.join("\n");
}
