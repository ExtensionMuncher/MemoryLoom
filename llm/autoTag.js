/**
 * llm/autoTag.js — Auto-tag assist for memory entries
 *
 * Calls the Memory Writer LLM to suggest descriptive tags based on a memory's
 * content. Tags support library browsing/filtering and are included in
 * Memory Loom embedding text for better semantic recall.
 */

import { makeRequest } from "./connections.js";
import { getAllEntries, updateEntry } from "../data/entries.js";
import { getScene } from "../data/scenes.js";
import { reEmbedEntry } from "../embed/embedder.js";
import { getSetting } from "../settings.js";
import { dlog } from "../lib/debug.js";

export const TAG_BATCH_SIZE = 5;
export const TAG_BATCH_PAUSE_MS = 2500;
const MAX_DESCRIPTIVE_TAGS_PER_ENTRY = 8;

// Tags that are bookkeeping/source markers, not descriptive browse tags.
// These should not make the debug auto-tagger think a memory is already tagged.
const NON_DESCRIPTIVE_TAGS = new Set([
    "lorebook_import",
    "lorebook_imported",
    "imported",
    "consolidated",
    "consolidation",
    "arc_summary",
]);

/**
 * Suggest tags for a memory entry based on its content.
 * Uses the same Memory Writer LLM profile used by delta backfill.
 *
 * @param {object} entry - Entry data { title, content, primaryCharacter, keyCharacters }
 * @param {object|null} [scene=null] - Optional scene context for this entry
 * @returns {Promise<string[]>} Array of suggested tag strings
 */
export async function suggestTags(entry, scene = null) {
    const profileName = getSetting("connections.memoryWriterLLM", "");
    if (!profileName) {
        console.warn("[ML] Auto-tag: no Memory Writer LLM configured, cannot suggest tags");
        return [];
    }

    const systemPrompt = buildTagSystemPrompt();
    const userPrompt = buildTagUserPrompt(entry, scene);

    dlog(`[ML] Auto-tag: suggesting tags for \"${entry?.title || entry?.id || "untitled"}\"...`);
    const response = await makeRequest(profileName, systemPrompt, userPrompt, 200, 0.3);

    if (!response) {
        console.warn("[ML] Auto-tag: no response from LLM");
        return [];
    }

    return parseTagResponse(response);
}

function buildTagSystemPrompt() {
    return `You are a tagging assistant for a roleplay memory archive. Given a memory entry, suggest 3-8 descriptive tags that help the user browse and filter entries in a library.

Tags should be:
- lowercase, single words or short compound phrases
- normalized with underscores instead of spaces, e.g. "trust_building", "victorian_era", "secret_revealed"
- descriptive of themes, emotions, relationship dynamics, decisions, reveals, conflicts, or events
- NOT character names, because characters are tracked separately
- NOT generic archive words like "memory", "scene", "roleplay", or "entry"
- NOT source/status markers like "lorebook_import", "consolidated", "consolidation", "synthesis", or "arc_summary"

Output ONLY a JSON array of strings: ["tag1", "tag2", "tag3"]`;
}

function buildTagUserPrompt(entry, scene) {
    const primary = (entry?.primaryCharacters && entry.primaryCharacters.length)
        ? entry.primaryCharacters.join(", ")
        : (entry?.primaryCharacter || "");
    const keyCharacters = Array.isArray(entry?.keyCharacters) ? entry.keyCharacters.join(", ") : "";
    const currentTags = Array.isArray(entry?.tags) && entry.tags.length ? entry.tags.join(", ") : "none";

    let prompt = `Memory entry:\n`;
    prompt += `Title: ${entry?.title || "Untitled"}\n`;
    prompt += `Category: ${entry?.category || "character"}\n`;
    if (primary) prompt += `Primary character(s): ${primary}\n`;
    if (keyCharacters) prompt += `Supporting character(s): ${keyCharacters}\n`;
    prompt += `Existing tags: ${currentTags}\n`;
    if (entry?.delta?.delta) prompt += `Delta: ${entry.delta.delta}\n`;
    prompt += `\nContent:\n${String(entry?.content || "").slice(0, 1600)}\n`;

    if (scene?.llmSummary) {
        prompt += `\nScene context, for reference only:\n${String(scene.llmSummary).slice(0, 900)}\n`;
    }

    prompt += `\nSuggest descriptive browsing tags as a JSON array only. Do not repeat existing source/status tags.`;
    return prompt;
}

/**
 * Parse the tag suggestion response.
 * @param {string} response
 * @returns {string[]}
 */
function parseTagResponse(response) {
    try {
        const raw = String(response).replace(/```json\s*|```/g, "").trim();
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];

        const tags = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(tags)) return [];

        return normalizeTags(tags).slice(0, MAX_DESCRIPTIVE_TAGS_PER_ENTRY);
    } catch (err) {
        console.warn("[ML] Auto-tag: failed to parse response:", err.message);
        return [];
    }
}

function normalizeTagKey(value) {
    return String(value || "")
        .toLowerCase()
        .trim()
        .replace(/^#+/, "")
        .replace(/[\s-]+/g, "_")
        .replace(/[^a-z0-9_]/g, "")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function normalizeTags(tags) {
    const blocked = new Set([
        "memory", "memories", "scene", "entry", "roleplay", "rp", "chat",
        "lorebook_import", "lorebook_imported", "imported",
        "consolidated", "consolidation", "synthesis", "arc_summary",
    ]);
    const out = [];
    const seen = new Set();

    for (const value of tags || []) {
        const tag = normalizeTagKey(value);

        if (!tag || tag.length < 2 || tag.length > 40) continue;
        if (blocked.has(tag)) continue;
        if (seen.has(tag)) continue;

        seen.add(tag);
        out.push(tag);
    }

    return out;
}

function isSynthesisEntry(entry) {
    const tags = Array.isArray(entry?.tags) ? entry.tags : [];
    if (tags.some(t => normalizeTagKey(t) === "synthesis")) return true;

    // The Library UI classifies per-character consolidation outputs as
    // synthesis based on this shape, even when there is no literal "synthesis"
    // tag. Those entries are already written with meaningful tags.
    return Boolean(entry?.consolidationId && entry?.category === "character");
}

function hasDescriptiveTags(entry) {
    const tags = Array.isArray(entry?.tags) ? entry.tags : [];
    return tags.some(t => {
        const key = normalizeTagKey(t);
        return key && key !== "synthesis" && !NON_DESCRIPTIVE_TAGS.has(key);
    });
}

function needsAutoTags(entry) {
    if (!entry || isSynthesisEntry(entry)) return false;
    return !hasDescriptiveTags(entry);
}

function mergeTags(existing, suggested) {
    const preserved = (Array.isArray(existing) ? existing : [])
        .map(t => String(t || "").trim())
        .filter(Boolean);

    const out = [...preserved];
    const seen = new Set(preserved.map(normalizeTagKey).filter(Boolean));
    let descriptiveCount = preserved.filter(t => {
        const key = normalizeTagKey(t);
        return key && key !== "synthesis" && !NON_DESCRIPTIVE_TAGS.has(key);
    }).length;

    for (const tag of normalizeTags(suggested)) {
        const key = normalizeTagKey(tag);
        if (!key || seen.has(key)) continue;
        if (descriptiveCount >= MAX_DESCRIPTIVE_TAGS_PER_ENTRY) break;
        seen.add(key);
        out.push(tag);
        descriptiveCount++;
    }

    return out;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Auto-tag a single committed memory entry if it lacks descriptive tags.
 * Returns the updated entry when tags were added, otherwise the original entry.
 *
 * @param {object} entry
 * @param {object|null} [scene=null]
 * @returns {Promise<object|null>}
 */
export async function autoTagEntry(entry, scene = null) {
    if (!entry || !entry.id || !needsAutoTags(entry)) return entry || null;

    const resolvedScene = scene || (entry.sceneId ? getScene(entry.sceneId) : null);
    const suggested = await suggestTags(entry, resolvedScene);
    const merged = mergeTags(entry.tags || [], suggested);

    if (merged.length > (entry.tags || []).length) {
        const updated = updateEntry(entry.id, { tags: merged });
        dlog(`Auto-tag: \"${entry.title || entry.id}\" → ${merged.join(", ")}`);
        return updated || Object.assign({}, entry, { tags: merged });
    }

    console.warn(`[ML] Auto-tag: no new usable tags for \"${entry.title || entry.id}\"`);
    return entry;
}

/**
 * Auto-tag committed memories that need descriptive browsing tags.
 *
 * Source/status marker tags like lorebook-import and consolidated are preserved,
 * but they do not count as real browse tags. Synthesis entries are skipped
 * because they are generated with their own tags during consolidation.
 *
 * Uses the Memory Writer LLM profile and the same burst pacing as delta
 * backfill: 5 sequential requests, then a 2.5s pause.
 *
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{total:number, tagged:number, failed:number, skipped:number}>}
 */
export async function autoTagUntaggedEntries(onProgress) {
    const profileName = getSetting("connections.memoryWriterLLM", "");
    if (!profileName) {
        toastr?.warning?.("No Memory Writer LLM configured. Set one in Settings > Connections.", "Memory Loom");
        return { total: 0, tagged: 0, failed: 0, skipped: 0 };
    }

    const all = getAllEntries();
    const targets = all.filter(entry => needsAutoTags(entry));
    const total = targets.length;

    if (total === 0) {
        toastr?.info?.("No taggable memories need descriptive tags. Synthesis memories are skipped.", "Memory Loom");
        return { total: 0, tagged: 0, failed: 0, skipped: all.length };
    }

    dlog(`Auto-tag: ${total} entries need descriptive tags (of ${all.length} total; synthesis skipped)`);

    let tagged = 0;
    let failed = 0;

    for (let i = 0; i < targets.length; i++) {
        const entry = targets[i];
        const scene = entry.sceneId ? getScene(entry.sceneId) : null;

        try {
            const beforeCount = Array.isArray(entry.tags) ? entry.tags.length : 0;
            const updated = await autoTagEntry(entry, scene);
            const afterCount = Array.isArray(updated?.tags) ? updated.tags.length : beforeCount;

            if (afterCount > beforeCount) {
                // Tags are now part of getEmbeddingText(), so newly tagged
                // memories need a fresh vector immediately. Older memories
                // tagged by previous builds still need Debug > Re-embed all.
                try { await reEmbedEntry(updated); }
                catch (embedErr) { console.warn("[ML] Auto-tag: re-embed failed after tagging:", embedErr); }
                tagged++;
            } else {
                failed++;
            }
        } catch (err) {
            failed++;
            console.error(`[ML] Auto-tag: request failed for \"${entry.title || entry.id}\":`, err);
        }

        if (onProgress) onProgress(i + 1, total);

        if ((i + 1) % TAG_BATCH_SIZE === 0 && i + 1 < targets.length) {
            await sleep(TAG_BATCH_PAUSE_MS);
        }
    }

    return { total, tagged, failed, skipped: all.length - total };
}
