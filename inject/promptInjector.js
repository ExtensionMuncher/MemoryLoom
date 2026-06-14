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
import { recordInjection } from "../embed/retriever.js";
import { dlog } from "../lib/debug.js";

// ─── Constants ────────────────────────────────────────────

/** Extension prompt tag — unique identifier for ML's injection */
const PROMPT_ID = "ml-memory-injection";
const ROLE_SYSTEM = 0;

// ST extension_prompt_types: IN_PROMPT=0 (story string / before main),
// IN_CHAT=1 (inserted into chat at a given depth), BEFORE_PROMPT=2.
// extension_prompt_roles: SYSTEM=0, USER=1, ASSISTANT=2.
// Placement → { position, depth, role }, mirroring the approach used in the
// World State / Relationship trackers so behavior is consistent across them.
function resolvePlacement(placement) {
    switch (placement) {
        case "before_main": return { position: 2, depth: 0, role: ROLE_SYSTEM }; // BEFORE_PROMPT
        case "after_main":  return { position: 0, depth: 0, role: ROLE_SYSTEM }; // IN_PROMPT (story string)
        case "top_an":      return { position: 1, depth: 0, role: ROLE_SYSTEM };   // author's-note top
        case "bottom_an":   return { position: 1, depth: 999, role: ROLE_SYSTEM }; // author's-note bottom
        case "at_depth": {
            const depth = Number(getSetting("injection.depth", 4));
            const roleSel = getSetting("injection.depthRole", "system");
            const role = roleSel === "user" ? 1 : roleSel === "assistant" ? 2 : 0;
            return { position: 1, depth: Number.isFinite(depth) ? depth : 4, role };
        }
        // legacy values kept working
        case "above_card": return { position: 2, depth: 0, role: ROLE_SYSTEM };
        case "below_card": return { position: 0, depth: 0, role: ROLE_SYSTEM };
        case "top":        return { position: 2, depth: 0, role: ROLE_SYSTEM };
        case "bottom":     return { position: 1, depth: 999, role: ROLE_SYSTEM };
        default:           return { position: 2, depth: 0, role: ROLE_SYSTEM };
    }
}

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

    const place = resolvePlacement(settings.placement);

    // Register the injection through ST's extension-prompt API. This is the same
    // mechanism the built-in Vector Storage uses, so the block participates in
    // prompt assembly and is visible/inspectable in ST's prompt itinerary.
    setExtensionPrompt(PROMPT_ID, content, place.position, place.depth, false, place.role);

    // Start stickiness for each injected entry so it stays active for a few
    // messages after firing. Per-entry overrides take precedence over the
    // global default. Without this, the sticky map was never populated and
    // stickiness/cooldown did nothing.
    try {
        for (const c of candidates) {
            const e = c.entry;
            if (!e) continue;
            const perEntry = Number(e.stickiness);
            recordInjection(e.id, Number.isFinite(perEntry) && perEntry > 0 ? perEntry : 0);
        }
    } catch (err) { console.warn("[ML] recordInjection failed:", err); }

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
