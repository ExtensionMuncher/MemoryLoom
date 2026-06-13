/**
 * llm/consolidator.js — Consolidation LLM
 *
 * Generates consolidation summaries that combine multiple memory entries
 * and/or scene summaries into higher-level carry-forward context.
 *
 * CRITICAL RULES:
 *   - Consolidation output must NOT contain open_threads, future_questions,
 *     or suggested_next_steps. Unresolved context must be expressed as
 *     present state only.
 *   - Example of what NOT to do: "Will Sachiko forgive Rukia?"
 *   - Example of correct approach: "Sachiko has not forgiven Rukia and
 *     remains guarded around her."
 *   - Consolidation does not delete source memories — it reduces their
 *     injection priority, not removes them.
 */

import { makeRequest } from "./connections.js";
import { getSetting } from "../settings.js";

/** Max tokens for a consolidation response. A consolidation fuses many memories
 *  and emits a large structured JSON object — 1500 truncated it mid-output
 *  ("finish_reason: length"), which left the JSON unterminated and unparseable.
 *  Default 30000; configurable in Settings > Consolidation. */
function getConsolidationTokens() {
    const v = Number(getSetting("consolidation.maxResponseTokens", 30000));
    return (Number.isFinite(v) && v >= 1000) ? v : 30000;
}

// ─── Consolidation Generation ─────────────────────────────

/**
 * Generate a consolidation draft from selected sources.
 *
 * @param {object} params
 * @param {string} params.mode - "selected", "folder", or "mixed"
 * @param {object[]} params.sourceEntries - Memory entries being consolidated
 * @param {object[]} [params.sourceScenes] - Scene summaries being consolidated
 * @param {string[]} [params.folderIds] - Folder IDs (for folder/mixed mode)
 * @returns {Promise<object|null>} Consolidation draft, or null on failure
 */
export async function generateConsolidation({ mode, sourceEntries, sourceScenes = [], folderIds = [] }) {
    const profileName = getSetting("connections.consolidationLLM", "");
    if (!profileName) {
        console.warn("[ML] Consolidation LLM not configured");
        toastr?.warning?.("Consolidation LLM not configured. Check Settings > Connections.");
        return null;
    }

    if (!sourceEntries || sourceEntries.length === 0) {
        console.warn("[ML] No source entries provided for consolidation");
        return null;
    }

    const systemPrompt = buildConsolidationSystemPrompt();
    const userPrompt = buildConsolidationUserPrompt(sourceEntries, sourceScenes, mode, folderIds);

    console.log(`[ML] Consolidator: generating consolidation (${sourceEntries.length} entries, ${sourceScenes.length} scenes)...`);
    const response = await makeRequest(profileName, systemPrompt, userPrompt, getConsolidationTokens(), 0.4);

    if (!response) {
        console.warn("[ML] Consolidator: no response from LLM");
        return null;
    }

    return parseConsolidationResponse(response, sourceEntries, sourceScenes);
}

// ─── Prompt Builders ──────────────────────────────────────

function buildConsolidationSystemPrompt() {
    return `You are a memory consolidation system for a long-running roleplay. Your job is to combine multiple related memory entries and scene summaries into a single, higher-level "carry-forward" summary.

RULES:
1. DO NOT include open_threads, future_questions, or suggested_next_steps in your output.
2. Express all unresolved context as present state — what IS true now, not what MIGHT happen.
3. The consolidation should be compact enough for system prompt injection but comprehensive enough to convey the full arc.
4. Use neutral, clinical language. This is reference material for the AI, not narrative prose.

Example of WRONG output:
  "Will Sachiko forgive Rukia for the betrayal?"

Example of CORRECT output:
  "Sachiko has not forgiven Rukia for the betrayal and remains guarded around her."

Output as JSON with these fields:
{
  "title": "Consolidation title",
  "timeRange": "Narrative time period covered",
  "before_state": "What was true before this arc",
  "after_state": "What is true now, after this arc",
  "summary": "Full consolidation text for library review",
  "preferred_injection": "Compact version for system prompt injection (2-3 sentences max)",
  "carry_forward_context": ["present-tense fact 1", "present-tense fact 2"],
  "key_changes": ["change 1", "change 2"],
  "character_impact": ["impact on character 1", "impact on character 2"],
  "relationship_impact": ["relationship change 1"],
  "plot_impact": ["plot development 1"],
  "world_impact": ["world change 1"],
  "tags": ["tag1", "tag2"]
}`;
}

function buildConsolidationUserPrompt(entries, scenes, mode, folderIds) {
    let prompt = `Consolidation mode: ${mode}\n\n`;

    prompt += "SOURCE MEMORY ENTRIES:\n\n";
    entries.forEach((e, i) => {
        prompt += `--- Entry ${i + 1}: ${e.title} ---\n`;
        prompt += `Character: ${e.primaryCharacter || (e.primaryCharacters || []).join(", ")}\n`;
        prompt += `Date: ${e.datetime}\n`;
        prompt += `Content: ${e.content}\n`;
        if (e.delta?.delta) prompt += `Delta: ${e.delta.delta}\n`;
        prompt += "\n";
    });

    if (scenes && scenes.length > 0) {
        prompt += "SOURCE SCENE SUMMARIES:\n\n";
        scenes.forEach((s, i) => {
            prompt += `--- Scene ${i + 1} (msgs ${s.messageStart}–${s.messageEnd || "?"}) ---\n`;
            prompt += `${s.llmSummary}\n\n`;
        });
    }

    prompt += "Generate a consolidation covering these sources. Output as JSON.";
    return prompt;
}

// ─── Response Parsing ─────────────────────────────────────

/**
 * Parse the consolidator LLM response into a consolidation draft object.
 *
 * @param {string} response
 * @param {object[]} sourceEntries
 * @param {object[]} sourceScenes
 * @returns {object|null}
 */
function parseConsolidationResponse(response, sourceEntries, sourceScenes) {
    try {
        // Strip markdown fences if present
        let raw = response.replace(/```json\s*|```/g, "").trim();
        const firstBrace = raw.indexOf("{");
        if (firstBrace === -1) {
            console.warn("[ML] Consolidator: no JSON found in response");
            return null;
        }
        let jsonText = raw.slice(firstBrace);
        let parsed;
        try {
            // Normal case: complete JSON
            const end = jsonText.lastIndexOf("}");
            parsed = JSON.parse(jsonText.slice(0, end + 1));
        } catch (e) {
            // Repair backstop: if the response was cut off (finish_reason: length),
            // the JSON is unterminated. Salvage it by closing any open string/array
            // and brace so the completed fields survive instead of losing everything.
            console.warn("[ML] Consolidator: JSON looks truncated — attempting repair");
            parsed = repairTruncatedJson(jsonText);
            if (!parsed) {
                console.warn("[ML] Consolidator: repair failed, no usable JSON");
                return null;
            }
            console.log("[ML] Consolidator: repaired truncated JSON — some trailing fields may be missing");
        }

        // Build status updates: all source entries → consolidated
        const statusUpdates = sourceEntries.map(e => ({
            sourceId: e.id,
            newStatus: "consolidated",
        }));

        // Also mark source scenes as consolidated
        sourceScenes.forEach(s => {
            statusUpdates.push({
                sourceId: s.id,
                newStatus: "consolidated",
            });
        });

        return {
            id: `ml_consolidation_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            title: parsed.title || "Untitled Consolidation",
            type: determineConsolidationType(sourceEntries, sourceScenes),
            scope: {
                folders: [],
                sourceIds: [
                    ...sourceEntries.map(e => e.id),
                    ...sourceScenes.map(s => s.id),
                ],
            },
            timeRange: parsed.timeRange || "",
            before_state: parsed.before_state || "",
            after_state: parsed.after_state || "",
            summary: parsed.summary || "",
            preferred_injection: parsed.preferred_injection || parsed.summary || "",
            carry_forward_context: parsed.carry_forward_context || [],
            key_changes: parsed.key_changes || [],
            character_impact: parsed.character_impact || [],
            relationship_impact: parsed.relationship_impact || [],
            plot_impact: parsed.plot_impact || [],
            world_impact: parsed.world_impact || [],
            source_memories: sourceEntries.map(e => e.id),
            status_updates: statusUpdates,
            tags: parsed.tags || [],
            status: "active",
            vectorHash: null,
            stickiness: 0,
            cooldown: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
    } catch (err) {
        console.warn("[ML] Consolidator: failed to parse JSON:", err.message);
        return null;
    }
}


/**
 * Best-effort salvage of a truncated JSON object (model cut off mid-output).
 * Trims to the last complete top-level field, then closes open structures.
 */
function repairTruncatedJson(text) {
    // Walk the string tracking depth and string state; remember the index just
    // after the last COMPLETE key:value pair at depth 1.
    let inStr = false, esc = false, depth = 0, lastComplete = -1;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") depth--;
        else if (c === "," && depth === 1) lastComplete = i;
    }
    if (lastComplete === -1) return null;
    let salvaged = text.slice(0, lastComplete) + "}";
    try { return JSON.parse(salvaged); }
    catch (e) { return null; }
}

/**
 * Determine the consolidation type based on source composition.
 * @param {object[]} entries
 * @param {object[]} scenes
 * @returns {string}
 */
function determineConsolidationType(entries, scenes) {
    const hasEntries = entries.length > 0;
    const hasScenes = scenes.length > 0;

    if (hasEntries && hasScenes) return "mixed_consolidation";
    if (entries.every(e => e.category === "character")) return "character_consolidation";
    if (entries.every(e => e.category === "plot")) return "plot_subarc_consolidation";
    return "arc_consolidation";
}
