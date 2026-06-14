/**
 * llm/deltaBackfill.js — Backfill missing deltas
 *
 * Scans every committed memory entry, finds those whose delta block is blank
 * or missing (before_state / after_state / delta all empty), and asks the
 * Memory Writer LLM to write the appropriate delta for each — using the
 * memory's own content (plus its scene summary for context, when available).
 *
 * Deltas are generated in the SAME shape fresh entries use:
 *   { before_state, after_state, delta, delta_type[], low_delta_flag }
 * so a backfilled delta is indistinguishable from one written at scene close.
 *
 * Processes in small batches with a pause between, so a long archive doesn't
 * hammer a cloud provider's rate limit.
 */

import { makeRequest } from "./connections.js";
import { getAllEntries, updateDelta } from "../data/entries.js";
import { getScene } from "../data/scenes.js";
import { getSetting } from "../settings.js";
import { dlog } from "../lib/debug.js";

/** True if an entry has no usable delta. */
function isDeltaBlank(entry) {
    const d = entry.delta;
    if (!d || typeof d !== "object") return true;
    const b = String(d.before_state || "").trim();
    const a = String(d.after_state || "").trim();
    const x = String(d.delta || "").trim();
    return !b && !a && !x;
}

function buildSystemPrompt() {
    return `You analyze a single roleplay memory and produce its "delta" — the change it represents for the primary character. Output ONLY a JSON object, no prose, no markdown fences:
{
  "before_state": "One sentence: the character's relevant state/belief/stance BEFORE this moment.",
  "after_state": "One sentence: what is true for them AFTER this moment.",
  "delta": "One short sentence naming the shift between before and after.",
  "low_delta_flag": false
}

Rules:
- Express everything as present/past state, never as open questions.
- Base it strictly on the memory content provided — do not invent events.
- If the memory genuinely reflects little or no change (a quiet beat), still fill the fields with the best reading and set "low_delta_flag": true.
- Keep each field to one concise sentence.`;
}

function buildUserPrompt(entry, scene) {
    let p = `MEMORY TITLE: ${entry.title || "Untitled"}\n`;
    const who = (entry.primaryCharacters && entry.primaryCharacters.length)
        ? entry.primaryCharacters.join(", ")
        : (entry.primaryCharacter || "Unknown");
    p += `PRIMARY CHARACTER: ${who}\n`;
    if (entry.datetime) p += `WHEN: ${entry.datetime}\n`;
    p += `\nMEMORY CONTENT:\n${entry.content || ""}\n`;
    if (scene && scene.llmSummary) {
        p += `\nSCENE CONTEXT (for reference only — the delta is about the memory above):\n${scene.llmSummary}\n`;
    }
    p += `\nWrite the delta JSON for the PRIMARY CHARACTER of this memory.`;
    return p;
}

function parseDelta(response) {
    if (!response) return null;
    try {
        const raw = String(response).replace(/```json\s*|```/g, "").trim();
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start === -1 || end === -1) return null;
        const parsed = JSON.parse(raw.slice(start, end + 1));
        const before = String(parsed.before_state || "").trim();
        const after = String(parsed.after_state || "").trim();
        const delta = String(parsed.delta || "").trim();
        if (!before && !after && !delta) return null; // nothing usable
        return {
            before_state: before,
            after_state: after,
            delta: delta,
            delta_type: Array.isArray(parsed.delta_type) ? parsed.delta_type : [],
            low_delta_flag: !!parsed.low_delta_flag,
        };
    } catch (err) {
        console.warn("[ML] Delta backfill: parse failed:", err.message);
        return null;
    }
}

/**
 * Backfill deltas for all entries that lack one.
 *
 * @param {(done:number, total:number)=>void} [onProgress] - per-entry callback
 * @returns {Promise<{total:number, filled:number, failed:number, skipped:number}>}
 */
export async function backfillMissingDeltas(onProgress) {
    const profileName = getSetting("connections.memoryWriterLLM", "");
    if (!profileName) {
        toastr?.warning?.("No Memory Writer LLM configured. Set one in Settings > Connections.", "Memory Loom");
        return { total: 0, filled: 0, failed: 0, skipped: 0 };
    }

    const all = getAllEntries();
    const targets = all.filter(isDeltaBlank);
    const total = targets.length;
    if (total === 0) {
        toastr?.info?.("All memories already have deltas — nothing to backfill.", "Memory Loom");
        return { total: 0, filled: 0, failed: 0, skipped: 0 };
    }

    dlog(`Delta backfill: ${total} entries missing deltas (of ${all.length} total)`);
    const maxTokens = Number(getSetting("connections.maxResponseTokens", 8000)) || 8000;

    let filled = 0, failed = 0;
    const BATCH = 5;        // entries per burst
    const PAUSE_MS = 2500;  // pause between bursts (rate-limit friendly)

    for (let i = 0; i < targets.length; i++) {
        const entry = targets[i];
        const scene = entry.sceneId ? getScene(entry.sceneId) : null;
        try {
            const resp = await makeRequest(
                profileName,
                buildSystemPrompt(),
                buildUserPrompt(entry, scene),
                maxTokens,
                0.4
            );
            const delta = parseDelta(resp);
            if (delta) {
                updateDelta(entry.id, delta);
                filled++;
                dlog(`Delta backfill: "${entry.title}" → ${delta.delta || "(filled)"}`);
            } else {
                failed++;
                console.warn(`[ML] Delta backfill: no usable delta for "${entry.title}"`);
            }
        } catch (err) {
            failed++;
            console.error(`[ML] Delta backfill: request failed for "${entry.title}":`, err);
        }
        if (onProgress) onProgress(i + 1, total);
        // pause between bursts
        if ((i + 1) % BATCH === 0 && i + 1 < targets.length) {
            await new Promise(r => setTimeout(r, PAUSE_MS));
        }
    }

    return { total, filled, failed, skipped: all.length - total };
}
