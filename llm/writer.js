import { captureChatGuard } from "../lib/chatGuard.js";
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

import { makeRequest, getLastRequestDiagnostic } from "./connections.js";
import { getSetting } from "../settings.js";
import { chat, name1 } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
import { getScene, getPreviousSceneSummaries, updateSceneSummary, updateSceneGeneration } from "../data/scenes.js";
import { getPendingEntries, savePendingEntries } from "../data/storage.js";
import { getAllEntries } from "../data/entries.js";
import { getAllChains } from "../data/chains.js";
import { isEffectivelySuppressed } from "../data/suppression.js";


import { resolveCanonicalCharacter } from "../data/folders.js";
import { isNarrativeMessage } from "../lib/chatMessages.js";
/** General output budget for scene summaries and helper-style requests. */
function getGeneralMaxResponseTokens() {
    const v = Number(getSetting("connections.maxResponseTokens", 8000));
    return (Number.isFinite(v) && v >= 500) ? v : 8000;
}

/**
 * Character + world memory writing share a deliberately large completion
 * budget. Reasoning-heavy models such as GLM 5.2 can consume a very large
 * fraction of the completion on private deliberation before emitting the
 * structured answer, so writer jobs must not share the smaller helper budget.
 */
function getMemoryWriterMaxResponseTokens() {
    const v = Number(getSetting("connections.writerMaxResponseTokens", 25000));
    return (Number.isFinite(v) && v >= 500) ? v : 25000;
}

function isReasoningStarvedDraft(response, entries, diagnostic) {
    if (entries?.length) return false;
    const visible = String(response || "").trim();
    if (!visible) return false;

    // [NO MEMORY] is a legitimate short final answer, never a truncation signal.
    const normalized = visible.replace(/[\[\]*_`#]/g, "").trim().toLowerCase();
    if (/^(no memory|no core memory|no entry|none)\b/.test(normalized) && normalized.length < 120) return false;

    const reasoningChars = Number(diagnostic?.reasoningChars || 0);
    const visibleChars = Number(diagnostic?.responseChars || visible.length);
    if (!reasoningChars) return false;

    // SillyTavern 1.18's Connection Manager intentionally returns extracted
    // content/reasoning without finish_reason or token-usage metadata. We cannot
    // assert "length" from the extension alone. What we CAN detect reliably is
    // the failure shape from reasoning models: thousands of reasoning characters
    // and only a tiny, unparsable visible fragment such as "**Title".
    return visibleChars < 500 &&
        reasoningChars >= Math.max(2000, visibleChars * 12) &&
        diagnostic?.reasoningHeavy === true;
}

function buildReasoningStarvationRecoveryPrompt(originalUserPrompt) {
    return `RECOVERY PASS — OUTPUT THE FINAL MEMORY BLOCKS IMMEDIATELY.

Your previous attempt produced extensive private reasoning but only a tiny, unusable visible fragment. Do not re-analyze the scene, do not draft alternatives, and do not explain your choices. Use the scene and rules below only to emit the final required memory blocks. If no Core Memory qualifies, output exactly [NO MEMORY].

${originalUserPrompt}`;
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
    const assertChat = captureChatGuard();
    const profileName = getSetting("connections.sceneSummaryLLM", "")
        || getSetting("connections.memoryWriterLLM", "");
    if (!profileName) {
        console.warn("[ML] No scene-summary-capable LLM configured");
        toastr?.warning?.("No Scene Summary or Memory Writer LLM configured. Check Settings > Connections.");
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
    const summary = await makeRequest(profileName, systemPrompt, userPrompt, getGeneralMaxResponseTokens(), 0.7, {
        requestLabel: "the scene summary",
    });
    updateSceneGeneration(sceneId, { lastRequest: getLastRequestDiagnostic() });

    assertChat();
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
export async function generateMemoryEntries(sceneId, options = {}) {
    const assertChat = captureChatGuard();
    const profileName = getSetting("connections.memoryWriterLLM", "");
    if (!profileName) return null;

    const scene = getScene(sceneId);
    if (!scene) return null;

    const sceneMessages = getSceneMessages(scene);
    const previousSummaries = getPreviousSceneSummaries(sceneId);
    const memoryContext = selectWriterMemoryContext(sceneMessages);

    const systemPrompt = resolveMemoryEntryPrompt();
    const userPrompt = buildMemoryEntryUserPrompt(scene.llmSummary, sceneMessages, previousSummaries, memoryContext, { allowSupersession: !options.batchChainScanId });

    console.log(`[ML] Writer: generating memory entries for ${sceneId}...`);
    let retryUsed = false;
    let response = await makeRequest(profileName, systemPrompt, userPrompt, getMemoryWriterMaxResponseTokens(), 0.85, {
        requestLabel: "character memory generation",
    });
    let requestDiagnostic = getLastRequestDiagnostic();
    updateSceneGeneration(sceneId, { lastRequest: requestDiagnostic });

    assertChat();
    if (!response && ["empty", "reasoning_only"].includes(requestDiagnostic?.status)) {
        // Empty/reasoning-only provider replies do not throw, so the transport
        // retry loop cannot help. Give this high-value scene-close stage one
        // deliberate second attempt after a short cooldown. A true API error has
        // already exhausted the normal retry policy and is not doubled here.
        retryUsed = true;
        console.warn(`[ML] Writer: ${requestDiagnostic.status} response for ${sceneId}; retrying character memory generation once.`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        assertChat();
        response = await makeRequest(profileName, systemPrompt, userPrompt, getMemoryWriterMaxResponseTokens(), 0.85, {
            requestLabel: "character memory generation retry",
            preferNoThink: requestDiagnostic.status === "reasoning_only",
        });
        requestDiagnostic = getLastRequestDiagnostic();
        updateSceneGeneration(sceneId, { lastRequest: requestDiagnostic });
    }

    assertChat();
    if (!response) {
        console.warn("[ML] Writer: no response from LLM", requestDiagnostic || "");
        return null;
    }

    let entries = parseWriterResponse(response, sceneId);

    // A reasoning model can technically return non-empty visible content while
    // still failing the structured task. The real GLM 5.2 failure that exposed
    // this was a 7998-token reasoning trace followed by only "**Title" before
    // the provider stopped. Connection Manager 1.18 strips finish_reason/usage,
    // so detect the observable shape instead: tiny unparsable visible output +
    // a very large extracted reasoning payload. Retry ONCE with the existing
    // safe /no_think directive and an explicit "final blocks only" recovery cue.
    if (!retryUsed && isReasoningStarvedDraft(response, entries, requestDiagnostic)) {
        retryUsed = true;
        console.warn(`[ML] Writer: reasoning-dominated incomplete visible output for ${sceneId}; retrying once with no-think recovery.`);
        updateSceneGeneration(sceneId, {
            lastRequest: {
                ...(requestDiagnostic || {}),
                status: "reasoning_starved_visible_answer",
            },
        });
        await new Promise(resolve => setTimeout(resolve, 2500));
        assertChat();

        const recoveryPrompt = buildReasoningStarvationRecoveryPrompt(userPrompt);
        response = await makeRequest(profileName, systemPrompt, recoveryPrompt, getMemoryWriterMaxResponseTokens(), 0.75, {
            requestLabel: "character memory generation no-think recovery",
            preferNoThink: true,
        });
        requestDiagnostic = getLastRequestDiagnostic();
        updateSceneGeneration(sceneId, { lastRequest: requestDiagnostic });

        assertChat();
        if (!response) {
            console.warn("[ML] Writer: no-think recovery returned no visible answer", requestDiagnostic || "");
            return null;
        }
        entries = parseWriterResponse(response, sceneId);
    }

    entries = sanitizeWriterSupersessionProposals(entries, { allowSupersession: !options.batchChainScanId });

    // Prompting alone is not reliable across writer models. If the draft contains
    // a long verbatim run from the current scene or its generated reference note,
    // give the model one targeted rewrite pass before it reaches Pending Memories.
    if (entries?.length && hasDirectSourceCopy(entries, scene.llmSummary, sceneMessages)) {
        console.warn(`[ML] Writer: detected source-copy pattern for ${sceneId}; requesting one rewrite pass.`);
        await new Promise(resolve => setTimeout(resolve, 2500));
        assertChat();

        const repairPrompt = buildAntiCopyRepairPrompt(response, sceneMessages, previousSummaries);
        const repaired = await makeRequest(profileName, systemPrompt, repairPrompt, getMemoryWriterMaxResponseTokens(), 0.9, {
            requestLabel: "memory anti-copy rewrite",
        });

        assertChat();
        if (repaired) {
            const repairedEntries = parseWriterResponse(repaired, sceneId);
            if (repairedEntries?.length) {
                response = repaired;
                entries = repairedEntries;
                if (hasDirectSourceCopy(entries, scene.llmSummary, sceneMessages)) {
                    console.warn(`[ML] Writer: rewrite still contains substantial source overlap for ${sceneId}; leaving it for user review.`);
                } else {
                    console.log(`[ML] Writer: anti-copy rewrite passed for ${sceneId}.`);
                }
            }
        }
    }

    entries = sanitizeWriterSupersessionProposals(entries, { allowSupersession: !options.batchChainScanId });

    if (entries && entries.length > 0) {
        if (options.batchChainScanId) {
            for (const entry of entries) entry.batchChainScanId = String(options.batchChainScanId);
        }
        // Append to existing pending entries (don't overwrite during batch scan)
        const existing = getPendingEntries() || [];
        savePendingEntries([...existing, ...entries]);
        console.log(`[ML] Writer: ${entries.length} entries generated, pending review`);
    } else if (entries === null && response) {
        // Visible text existed but did not contain a complete parseable memory
        // block. Persist this distinction so Home/export diagnostics do not call
        // it a generic transport failure.
        requestDiagnostic = {
            ...(requestDiagnostic || {}),
            status: "unparseable_visible_answer",
            responseChars: String(response).trim().length,
            responsePreview: String(response).trim().slice(0, 160),
        };
        updateSceneGeneration(sceneId, { lastRequest: requestDiagnostic });
        console.warn(`[ML] Writer: response received but no complete entries parsed for ${sceneId}. Raw response:`, response.slice(0, 200));
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
const writerFlowsInFlight = new Map();

function hasSceneEntries(sceneId, category) {
    const pending = getPendingEntries() || [];
    const all = [...(getAllEntries() || []), ...(Array.isArray(pending) ? pending : Object.values(pending))];
    return all.some(entry => entry?.sceneId === sceneId &&
        (category === "world" ? entry.category === "world" : entry.category !== "world"));
}

function requestFailureMessage(baseMessage, sceneId = null) {
    const persisted = sceneId ? getScene(sceneId)?.generation?.lastRequest : null;
    const live = getLastRequestDiagnostic();
    // Prefer a persisted writer-level parse diagnostic over a transport-level
    // "success" record; otherwise use the live Connection Manager diagnostic.
    const diagnostic = (persisted?.status && persisted.status !== "success") ? persisted : live;
    if (!diagnostic || !diagnostic.status) return baseMessage;
    const profile = diagnostic.profileName ? ` "${diagnostic.profileName}"` : "";
    if (diagnostic.status === "empty") {
        return `${baseMessage}${profile} returned no visible answer.`;
    }
    if (diagnostic.status === "reasoning_only") {
        return `${baseMessage}${profile} returned reasoning but no final answer.`;
    }
    if (diagnostic.status === "reasoning_starved_visible_answer") {
        return `${baseMessage}${profile} returned extensive reasoning but only an incomplete visible answer.`;
    }
    if (diagnostic.status === "unparseable_visible_answer") {
        const preview = diagnostic.responsePreview ? ` Visible output began: ${JSON.stringify(diagnostic.responsePreview)}.` : "";
        return `${baseMessage}${profile} returned visible text but no complete memory block could be parsed.${preview}`;
    }
    if (diagnostic.status === "configuration_error") {
        const detail = Array.isArray(diagnostic.error) ? diagnostic.error.find(item => item?.message)?.message : "Connection profile configuration error.";
        return `${baseMessage}${profile} ${detail || "Connection profile configuration error."}`;
    }
    if (diagnostic.status === "error") {
        const chain = Array.isArray(diagnostic.error) ? diagnostic.error : [];
        // Connection Manager often wraps the useful backend failure inside
        // Error("API request failed", { cause }). Prefer the deepest concrete
        // cause so Home shows something actionable instead of the wrapper.
        const detail = [...chain].reverse().find(item => item?.message) || chain[0];
        const status = detail?.status ? `HTTP ${detail.status}: ` : "";
        return `${baseMessage}${profile} request error: ${status}${detail?.message || "Unknown provider error."}`;
    }
    return baseMessage;
}

function writerFailure(sceneId, stage, message, entries = [], worldEntries = []) {
    const scene = getScene(sceneId);
    const generation = scene?.generation || {};
    const partial = generation.summary === "complete" || generation.memories === "complete" || generation.world === "complete";
    updateSceneGeneration(sceneId, {
        status: partial ? "partial" : "failed",
        [stage]: "failed",
        error: message,
    });
    return { ok: false, partial, stage, error: message, entries, worldEntries, sceneId };
}

async function executeWriterFlow(sceneId, options = {}) {
    const assertChat = captureChatGuard();
    // Capture chat at start — if the user switches chats while the LLM is generating,
    // abort before writing, or we'd save this chat's results into the other chat's data.
    const flowChatId = getContext().chatId;

    let scene = getScene(sceneId);
    if (!scene) return { ok: false, partial: false, stage: "scene", error: "Scene not found.", entries: [], worldEntries: [], sceneId };

    const retry = options.retry === true;
    updateSceneGeneration(sceneId, { status: "running", error: "" });
    let generation = getScene(sceneId)?.generation || {};
    let entries = [];
    let worldEntries = [];
    const failures = [];

    const ensureSameChat = () => {
        assertChat();
        if (getContext().chatId !== flowChatId) {
            const err = new Error("Chat changed during generation.");
            err.name = "MLStaleChatError";
            throw err;
        }
    };

    // A retry must skip ONLY stages that are explicitly recorded as complete.
    // Older logic used `retry && hasSceneEntries(...)`, which meant one already-
    // accepted memory could make Memory Loom skip the entire writer stage even
    // when that stage had actually failed. That produced the maddening symptom
    // of pressing Retry and seeing no Memory Writer request in the backend log.
    const legacyStageComplete = (stage, category) => {
        if (!retry) return false;
        if (generation?.[stage] !== undefined && generation?.[stage] !== null) return false;
        return hasSceneEntries(sceneId, category);
    };

    // ── Scene summary ───────────────────────────────────────────────
    const summaryAlreadyComplete = generation.summary === "complete" && !!scene.llmSummary;
    if (!summaryAlreadyComplete) {
        updateSceneGeneration(sceneId, { summary: "running", summaryError: "" });
        const summary = await generateSceneSummary(sceneId);
        ensureSameChat();
        if (summary) {
            updateSceneGeneration(sceneId, { summary: "complete", summaryError: "" });
        } else {
            const message = requestFailureMessage("Scene summary generation failed.", sceneId);
            updateSceneGeneration(sceneId, { summary: "failed", summaryError: message });
            failures.push({ stage: "summary", message });
        }
        // The summary is useful metadata, but it is NOT a prerequisite for
        // character/world memory generation. Both downstream writers are grounded
        // directly in the source scene. A flaky summary model must never zero out
        // the user's memory output or prevent the Memory Writer from being called.
        await new Promise(r => setTimeout(r, 2500));
    }

    // ── Character memories ─────────────────────────────────────────
    scene = getScene(sceneId);
    generation = scene?.generation || {};
    const memoriesAlreadyComplete = generation.memories === "complete" || legacyStageComplete("memories", "character");
    if (!memoriesAlreadyComplete) {
        updateSceneGeneration(sceneId, { memories: "running", memoriesError: "" });
        entries = await generateMemoryEntries(sceneId);
        ensureSameChat();
        if (entries === null) {
            const message = requestFailureMessage("Character memory generation failed.", sceneId);
            updateSceneGeneration(sceneId, { memories: "failed", memoriesError: message });
            failures.push({ stage: "memories", message });
        } else {
            updateSceneGeneration(sceneId, { memories: "complete", memoriesError: "" });
        }
        await new Promise(r => setTimeout(r, 2500));
    }

    // ── World memories ─────────────────────────────────────────────
    scene = getScene(sceneId);
    generation = scene?.generation || {};
    if (getSetting("worldMemory.enabled", true)) {
        const worldAlreadyComplete = generation.world === "complete" || legacyStageComplete("world", "world");
        if (!worldAlreadyComplete) {
            updateSceneGeneration(sceneId, { world: "running", worldError: "" });
            try {
                const { generateWorldMemories } = await import("./worldWriter.js");
                ensureSameChat();
                worldEntries = await generateWorldMemories(sceneId);
                ensureSameChat();
                if (worldEntries === null) {
                    const message = requestFailureMessage("World memory generation failed.", sceneId);
                    updateSceneGeneration(sceneId, { world: "failed", worldError: message });
                    failures.push({ stage: "world", message });
                } else {
                    updateSceneGeneration(sceneId, { world: "complete", worldError: "" });
                }
            } catch (e) {
                if (e?.name === "MLStaleChatError") throw e;
                console.error("[ML] World memory generation failed:", e);
                const message = requestFailureMessage("World memory generation failed.", sceneId);
                updateSceneGeneration(sceneId, { world: "failed", worldError: message });
                failures.push({ stage: "world", message });
            }
        }
    } else {
        updateSceneGeneration(sceneId, { world: "skipped", worldError: "" });
    }

    // Include pre-existing failed stages that were skipped because another stage
    // was the one retried. This keeps the overall scene status truthful.
    generation = getScene(sceneId)?.generation || {};
    for (const [stage, field] of [["summary", "summaryError"], ["memories", "memoriesError"], ["world", "worldError"]]) {
        if (generation[stage] === "failed" && !failures.some(item => item.stage === stage)) {
            failures.push({ stage, message: generation[field] || `${stage} generation failed.` });
        }
    }

    if (failures.length > 0) {
        const successfulStage = [generation.summary, generation.memories, generation.world]
            .some(value => value === "complete" || value === "skipped");
        const error = failures.map(item => item.message).filter(Boolean).join(" ");
        updateSceneGeneration(sceneId, {
            status: successfulStage ? "partial" : "failed",
            error,
        });
        return {
            ok: false,
            partial: successfulStage,
            stage: failures[0].stage,
            error,
            entries,
            worldEntries,
            sceneId,
        };
    }

    updateSceneGeneration(sceneId, { status: "complete", error: "" });
    return { ok: true, partial: false, stage: "complete", entries, worldEntries, sceneId };
}

/**
 * Full scene-close writer flow. Concurrent retries for the same scene share one
 * promise so a double click cannot issue duplicate LLM calls or pending cards.
 */
export function runWriterFlow(sceneId, options = {}) {
    const flowKey = `${getContext()?.chatId || "no-chat"}::${sceneId}`;
    if (writerFlowsInFlight.has(flowKey)) return writerFlowsInFlight.get(flowKey);
    const task = executeWriterFlow(sceneId, options).catch((error) => {
        if (error?.name === "MLStaleChatError") throw error;
        console.error(`[ML] Writer flow failed for ${sceneId}:`, error);
        const generation = getScene(sceneId)?.generation || {};
        const stage = ["summary", "memories", "world"].find(key => generation[key] === "running") || "writer";
        return writerFailure(sceneId, stage, error?.message || "Memory generation failed.");
    }).finally(() => {
        if (writerFlowsInFlight.get(flowKey) === task) writerFlowsInFlight.delete(flowKey);
    });
    writerFlowsInFlight.set(flowKey, task);
    return task;
}

// ─── Memory quality guard ─────────────────────────────────

function normalizeOverlapTokens(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[“”"'’`*_~()[\]{}<>]/g, " ")
        .replace(/[^\p{L}\p{N}-]+/gu, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function containsSharedTokenRun(source, candidate, runLength = 14) {
    const src = normalizeOverlapTokens(source);
    const cand = normalizeOverlapTokens(candidate);
    if (src.length < runLength || cand.length < runLength) return false;

    const sourceRuns = new Set();
    for (let i = 0; i <= src.length - runLength; i++) {
        sourceRuns.add(src.slice(i, i + runLength).join(" "));
    }
    for (let i = 0; i <= cand.length - runLength; i++) {
        if (sourceRuns.has(cand.slice(i, i + runLength).join(" "))) return true;
    }
    return false;
}

export function hasDirectSourceCopy(entries, sceneSummary, sceneMessages) {
    for (const entry of (entries || [])) {
        const content = String(entry?.content || "");
        if (!content) continue;
        // The generated summary is short and synthetic, so a 12-word run is
        // suspicious. Raw scenes get a slightly looser 14-word threshold so
        // names and a single memorable phrase do not create false positives.
        if (containsSharedTokenRun(sceneSummary, content, 12)) return true;
        if (containsSharedTokenRun(sceneMessages, content, 14)) return true;
    }
    return false;
}

function buildAntiCopyRepairPrompt(draft, messages, previousSummaries) {
    let prompt = `QUALITY REPAIR REQUIRED. Your previous draft failed because it reproduced source wording and/or followed the source scene like a recap. Rewrite FROM SCRATCH.\n\nABSOLUTE REPAIR RULES:\n- Do not reuse long phrases, sentence structures, or narration from the source.\n- Do not preserve the source scene's chronological sequence.\n- Keep only 1-3 concrete remembered anchors; compress or omit the rest of the external action.\n- Move inward: emphasize what the Primary Character privately made of the moment, including associations, contradictions, judgments, desire, resentment, fear, tenderness, denial, fixation, or uncertainty.\n- A subjective interpretation may be wrong; frame it as the Primary Character's belief rather than objective truth.\n- The result must read like remembered psychological significance, not a polished recap.\n\nFAILED DRAFT (do not copy its prose):\n${draft}\n\nSOURCE SCENE (facts only; do not copy wording):\n${messages}\n`;
    if (previousSummaries?.length) {
        const recent = previousSummaries.slice(-3);
        prompt += "\nOLDER CONTINUITY CONTEXT (background only; do not copy its prose):\n";
        recent.forEach((item, i) => {
            prompt += `Earlier ${i + 1}: ${String(item).substring(0, 220)}\n`;
        });
    }
    prompt += "\nNow output the rewritten Core Memory using the exact required field format.";
    return prompt;
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

    const response = await makeRequest(profileName, systemPrompt, userPrompt, getMemoryWriterMaxResponseTokens(), 0.8, {
        requestLabel: "memory regeneration",
    });
    if (!response) return null;

    const entries = sanitizeWriterSupersessionProposals(parseWriterResponse(response, entry.sceneId), { allowSupersession: !entry.batchChainScanId });
    return entries?.[0] || null;
}

// ─── Prompt Builders ──────────────────────────────────────

function buildSceneGroundingRules() {
    return `SCENE REFERENCE GROUNDING — ABSOLUTE RULES:
- This pass is a factual continuity note, not a Core Memory and not an interpretation exercise.
- Treat explicit narration, dialogue, and stated motives as higher-confidence evidence than dramatic tone, genre convention, or the apparent effectiveness of an action.
- Preserve the difference between what objectively happened and what a character merely believed, feared, suspected, or inferred.
- Do not invent motives, hidden competence, strategy, romance, composure, or emotional certainty that the source does not establish.
- Preserve uncertainty and mixed motives when the scene is uncertain.
- Preserve material FAILURES, wrong turns, breakdowns, injuries, aborted attempts, and mistakes even when the scene later recovers or succeeds. Later success does not erase an earlier failure; report both in causal order when both mattered.
- Preserve causal direction. Do not rewrite a psychological trigger as dangerous power, a trauma response as tactical control, or an accidental success as deliberate mastery unless the source explicitly establishes that cause.
- Track WHO is actually acting or thinking in each section. Do not assume the player character is present merely because the chat belongs to them or because a location header lacks a name. Resolve pronouns from explicit nearby names; if identity is uncertain, say so instead of guessing.`;
}

function buildMemoryGroundingRules() {
    return `CORE MEMORY GROUNDING — SUBJECTIVITY WITHOUT OMNISCIENCE:
- A Core Memory is SUBJECTIVE by design. The Primary Character may interpret, misinterpret, romanticize, resent, fear, idealize, distrust, project onto, or assign meaning to what they experienced. Those private conclusions are often the point of the memory.
- Keep subjective belief separate from objective fact. If the Primary Character thinks another person planned something, write that they suspected, believed, or became convinced of it unless the source actually confirms the plan.
- Never state another character's unstated inner feelings, motives, or realizations as objective truth. The Primary Character may infer them from behavior and may be wrong.
- Explicit narration and stated motives still govern objective scene facts. Do not rewrite panic as tactical brilliance, desperation as dominance, confusion as insight, or reactive survival as calculated control unless the source supports it.
- Preserve FAILURES and setbacks as first-class memory material. If a character fails, dissociates, panics, chooses the wrong approach, gets hurt, misjudges something, or has to recover before later succeeding, do not collapse that sequence into a clean triumph arc. The later success does not retroactively erase the failure.
- Preserve causal direction. If trauma or a chosen emotional anchor triggers the breakdown while power merely spikes alongside it, do not turn that into "the power was destroying them" unless the source actually says so. Likewise, do not turn a mistake into hidden mastery because the eventual outcome was impressive.
- When the failure itself changes what the Primary Character understands, fears, respects, or plans to do next, it may be THE pressure point of the memory even if the scene later ends well.
- Do NOT flatten the Primary Character's own psychology in the name of caution. Their remembered shame, desire, jealousy, tenderness, anger, fascination, dread, rationalization, denial, associations, and private contradictions are valid material when supported by their viewpoint, behavior, established characterization, or a plausible subjective reading of what they perceived.
- Preserve uncertainty when uncertainty itself matters: "he couldn't decide whether..." is better than falsely resolving the character's conflict.`;
}

function buildDefaultSceneSummaryPrompt() {
    return `[MLv6] Write a factual scene reference note. Start with:

Title: [3-6 word evocative title]

Then report what happened in the exact order it occurred. Use enough paragraphs to preserve the scene's major beats: normally 3-6, and more for an unusually long multi-location scene when needed. Do not let the final location or final beat overwrite the scene's central throughline. Include key dialogue when it drives the scene. Explicitly preserve consequential failures, wrong turns, breakdowns, recoveries, and later successes as separate beats when they all occurred. Report only events actually present in the scene text — do not rearrange the sequence, fuse separate moments, or add details that are not there. Track the acting/POV character carefully in each section. Past tense, plain prose. No bullets, no bold, no "Scene Context:" prefix.`;
}

function buildDefaultMemoryEntryPrompt() {
    return `[MLv5] CORE MEMORY WRITER — THIS IS NOT A SCENE SUMMARY.

Pause and review the scene. Create a Core Memory from what the Primary Character would actually RETAIN: the emotionally defining beat, the details that snagged in their attention, the private interpretation they carried away, and the way the moment changed or complicated how they understood someone, themselves, or the situation.

DECISION DISCIPLINE — IMPORTANT:
- Make ONE selection pass over the scene, choose the qualifying memory/memories, then write them.
- Do not repeatedly reconsider the same candidate, repeatedly debate split-vs-merge, or loop over the same chain decision.
- When a chain/supersession decision is uncertain, use the conservative default (- none / blank) and move on.
- Spend the completion on psychologically mature final memories, not repeated meta-deliberation about what you might write.

TRANSFORMATION REQUIREMENT — ABSOLUTE:
- Do NOT retell the scene from beginning to end. Do NOT walk through every action in chronological order.
- Do NOT copy or lightly rewrite source narration, scene-summary prose, or surrounding prose. Never reproduce narration verbatim.
- Dialogue may be quoted only when the exact wording itself is memorable, and then use at most ONE brief line. Otherwise paraphrase it through the Primary Character's recollection.
- Select only 1-3 concrete anchors from the event (a gesture, image, sensation, object, line, silence, expression, etc.). Use those anchors as the doorway into the Primary Character's internal meaning-making.
- The majority of Content should be transformed memory: sensory association, emotional precision, private judgment, rationalization, contradiction, desire, resentment, fear, tenderness, suspicion, embarrassment, fixation, or a changed understanding. It should sound like a person remembering what MATTERED, not a recorder logging what HAPPENED.
- If the Content could substitute for a scene recap, synopsis, or transcript, it has failed. Rewrite it around significance rather than chronology.
- Use rich, specific, sensory and emotionally precise prose. Psychological significance is the priority; factual scene details are supporting evidence.

Memories belong ONLY to NPCs. {{user}} is the human player: NEVER write an entry whose Primary Character is {{user}}, and never write an unattributed entry or one labelled "Unknown" as a workaround. If a moment matters only to {{user}} with no NPC present, skip it entirely. This restriction applies ONLY to who OWNS the memory. Within Content, Before, After, and Delta, write about {{user}} freely, naturally, and BY NAME exactly as you would any other character.

Use this exact format:

**Title**:
**Date/Time**:

**Content**:

**Primary Character**: (one name — or, ONLY for a genuinely joint memory shared equally by two or more characters, comma-separated names; joint memories are rare)
**Key Character**:

**Before**:
**After**:
**Delta**:
**Chain Actions**:
- none
**Supersedes**:

Every field through Delta must be filled in except Key Character. Chain and Supersedes fields are optional metadata. Primary Character is the full name of the NPC this memory belongs to — never blank, never "Unknown", never {{user}}. If no present NPC can own the memory, do not write the entry. Key Character lists OTHER characters who are actively present and participating in the remembered moment. A person merely being thought about is not a Key Character. In Content, use a character's full name at most once, when it reads naturally; afterward use their given name or pronouns so the prose does not become robotic.

CHAINING / SUPERSESSION — CONSERVATIVE:
- Default Chain Actions to one line: - none. Shared characters or topics are never enough.
- Chain Actions is PLURAL. A single new memory may advance zero, one, or multiple DISTINCT developmental threads. Do not force the memory to choose only one valid chain.
- For each justified action, write ONE line under Chain Actions using exactly one of these shapes:
  - append | Chain ID: <existing chain id> | Revised Chain Description: <optional updated progression> | Revised Chain Label: <optional updated label>
  - create | Chain Memory IDs: <existing memory id(s), comma-separated> | Chain Label: <specific thread> | Chain Description: <concrete progression>
- Chains are PRIMARY-CHARACTER-SPECIFIC. Append/create only with memories owned by the SAME Primary Character as this new memory. A Key Character or merely mentioned person does not count. Never combine different characters' viewpoints into one thematic/story chain.
- Existing chain membership NEVER makes a memory unavailable. The same memory may participate in multiple different chains for the same Primary Character when it genuinely advances multiple distinct threads. Do not duplicate the same thread; reuse of the memory itself is allowed.
- Use append with a valid Chain ID only when this memory is a clear successive stage of that exact developmental thread for the same Primary Character.
- Existing-chain descriptions are LIVING MAPS of the thread. When an appended memory merely reinforces an already-described stage, omit Revised Chain Description and Revised Chain Label. When it meaningfully escalates, reverses, complicates, resolves, or recontextualizes the thread, supply a concise Revised Chain Description that preserves the earlier progression and incorporates the new stage. Do NOT turn the description into a scene recap or a list of every memory.
- Revised Chain Label is rarer: provide it only when the old label has become materially too narrow or misleading. Otherwise leave it blank/omit it.
- Use create with at least one valid existing Chain Memory ID only when those same-character memories form establishment → development/escalation/reversal/complication/resolution/recontextualization.
- Multiple actions must represent genuinely different developmental threads, not alternate labels for the same idea. Many memories should still have - none.
- Chaining never replaces, merges, or suppresses an earlier episodic memory.
- Supersedes is a PROPOSAL ONLY. It never executes automatically and it is never a substitute for writing a valid Core Memory. Generate every justified Core Memory first; only then, if an older memory is genuinely erroneous/duplicate/invalid and represents essentially the same information, you may propose its ID. Ordinary evolution, earlier developmental stages, childhood memories, imported/manual memories, consolidation sources, chain milestones, and merely overlapping episodes must NOT be superseded.

Write in THIRD PERSON LIMITED, past tense — never first person and never second person. The narration is limited to the Primary Character's knowledge and subjectivity.

CONTENT SHAPE:
- Open near the remembered pressure point, not with setup copied from the scene.
- Let concrete details appear only where the Primary Character would attach meaning to them.
- Move inward quickly. The entry should reveal why THIS detail or exchange lodged in THIS character.
- End with the private consequence: the dynamic it established, the desire or unease it planted, the belief it changed, the role the character realized they were taking on, or the contradiction they could no longer ignore.

BEFORE / AFTER / DELTA:
- These are psychological-state fields, NOT miniature plot summaries.
- Before: the relevant belief, expectation, emotional posture, or relationship assumption immediately before the defining moment.
- After: what the character now believes, fears, wants, notices, or can no longer dismiss.
- Delta: name the actual internal shift in concise language. Do not repeat the scene chronology.

This is a multi-character roleplay with no narrator. Choose a Primary Character who is actually present in the scene.

A scene may yield more than one Core Memory when genuinely necessary:
- Different present characters can retain the same event differently.
- One character can form multiple memories only when the scene contains distinct defining moments that should not be merged.
Separate complete entries with a line containing only: ---

If no meaningful Core Memory exists for any present character, reply with only: [NO MEMORY]`;
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


function buildMemoryEntryUserPrompt(_sceneSummary, messages, previousSummaries, memoryContext = [], options = {}) {
    const allowSupersession = options.allowSupersession !== false;
    // Do not feed the freshly generated chronological scene summary back into
    // the memory writer. Models were treating it as ready-made prose to remix.
    // The raw scene is evidence; older summaries are continuity context only.
    let prompt = "SOURCE SCENE — EVIDENCE ONLY. Transform it into remembered significance; do not copy its narration or retell it chronologically:\n\n" + messages + "\n\n";
    if (previousSummaries.length > 0) {
        prompt += "OLDER SCENE CONTINUITY (background only; do not copy its wording):\n";
        previousSummaries.slice(-3).forEach((item, i) => {
            prompt += `Earlier ${i + 1}: ${String(item).substring(0, 200)}...\n`;
        });
    }
    if (memoryContext.length > 0) {
        prompt += "\nRELEVANT EXISTING MEMORIES (reference IDs only for optional chaining/supersession; do not copy their prose):\n";
        for (const item of memoryContext) {
            prompt += `- ID ${item.id} | ${item.title} | ${item.datetime || "undated"} | chains: ${item.chains.length ? item.chains.map(chain => `${chain.id} (${chain.label})`).join(", ") : "none"} | ${item.summary}\n`;
        }
        const relevantChains = new Map();
        for (const item of memoryContext) for (const chain of (item.chains || [])) if (chain?.id && !relevantChains.has(chain.id)) relevantChains.set(chain.id, chain);
        if (relevantChains.size > 0) {
            prompt += "\nRELEVANT EXISTING CHAINS (current metadata; use this to judge whether an append should also evolve the chain description):\n";
            for (const chain of relevantChains.values()) {
                prompt += `- Chain ${chain.id} | Primary Character: ${chain.primaryCharacter || "unknown"} | Label: ${chain.label || "Developmental thread"} | Description: ${chain.description || "(no description yet)"}\n`;
            }
            prompt += "If an appended memory substantially changes the shape of an existing thread, return Revised Chain Description on that append action. Preserve the old arc and add the new stage compactly. If it only reinforces what is already described, do not rewrite the description. Revised Chain Label is optional and should be used only when the existing label has become genuinely too narrow or misleading.\n";
        }
        prompt += "Default to Chain Actions: - none and Supersedes: blank unless the strict criteria in your instructions are unmistakably met. Existing chain membership does not make a memory unavailable: the same memory may support another genuinely distinct chain for the same Primary Character.\n";
    }
    if (allowSupersession) {
        prompt += "\nSUPPRESSION SAFETY: Supersedes is only a proposal for separate user review. It never replaces generation of a valid Core Memory. Never use it for ordinary development, childhood history, imported/manual memories, consolidation sources, or chain milestones.";
    } else {
        prompt += "\nBATCH-SCAN SAFETY: Supersedes MUST be blank. This retrofit pass is additive/reconstructive only and may not retire, replace, or suppress any existing memory. Generate every valid Core Memory normally.";
    }
    prompt += "\nCreate the Core Memory now. Do not summarize the scene; select the pressure point and transform it through the Primary Character's subjectivity.";

    // Title-diversity guard: if recent memory titles cluster around a repeated
    // opening (e.g. many "The Weight of…"), tell the model to avoid it. Gated by
    // a setting so it can be turned off. Default on.
    if (getSetting("memoryWriting.titleDiversity", true)) {
        const overused = getOverusedTitleOpenings();
        if (overused.length > 0) {
            prompt += `\n\nTITLE VARIETY: The library already has many titles beginning with ${overused.map(o => `"${o}"`).join(", ")}. Do NOT begin this memory's title with ${overused.length > 1 ? "any of those openings" : "that opening"}. Find a fresh, distinct title — vary the structure (not every title needs to start with "The"). The title should still be evocative and specific to this moment.`;
        }
    }

    const banned = getBannedPrimaries();
    if (banned.length > 0) {
        prompt += ` FINAL RULE, overriding everything else: never create a memory whose Primary Character is ${banned.join(" or ")}. This governs ONLY the Primary Character field — inside a memory's Content, refer to them freely and by full name like any other character; never avoid or dance around their names. They are valid Key Characters. If a defining moment belongs solely to them — with no NPC present — that is not a memory: SKIP it and output nothing for it. Do NOT write an entry with an empty, placeholder, "Unknown", or explanatory Primary Character. The Primary Character field must contain a real NPC name or the entry must not exist.`;
    }
    return prompt;
}

function contextTokens(text) {
    return new Set(String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(word => word.length >= 4));
}

/** Small local pre-writer retrieval: no recursive traversal and no LLM call. */
export function selectWriterMemoryContext(messages, limit = 6) {
    const query = contextTokens(messages);
    if (!query.size) return [];
    const chains = new Map((getAllChains() || []).map(chain => [chain.id, chain]));
    return (getAllEntries() || [])
        .filter(entry => entry && ["active", "consolidation", "consolidated", "pinned"].includes(entry.status) && !isEffectivelySuppressed(entry))
        .map(entry => {
            const hay = contextTokens([entry.title, entry.content, entry.primaryCharacter, ...(entry.primaryCharacters || []), ...(entry.keyCharacters || []), ...(entry.tags || [])].join(" "));
            let overlap = 0;
            for (const token of query) if (hay.has(token)) overlap++;
            const score = overlap / Math.max(1, Math.sqrt(query.size * Math.max(1, hay.size)));
            return { entry, score };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || Number(b.entry.createdAt || 0) - Number(a.entry.createdAt || 0))
        .slice(0, Math.max(1, limit))
        .map(({ entry }) => ({
            id: entry.id,
            title: entry.title || "Untitled",
            datetime: entry.datetime || "",
            summary: String(entry.content || "").replace(/\s+/g, " ").slice(0, 260),
            chains: (entry.chainIds || []).map(id => chains.get(id)).filter(Boolean).map(chain => ({
                id: chain.id,
                label: chain.label,
                description: chain.description || "",
                primaryCharacter: chain.primaryCharacter || "",
                primaryCharacterKey: chain.primaryCharacterKey || "",
                memoryIds: chain.memoryIds || [],
            })),
        }));
}

/**
 * Writer supersession is proposal-only and deliberately narrow. The writer may
 * only propose retiring an ordinary active LLM-generated episodic memory owned
 * by the same Primary Character. Imported/manual memories, consolidation
 * sources, starred memories, and existing chain milestones are protected from
 * automatic proposal noise; users can still suppress those manually.
 */
export function sanitizeWriterSupersessionProposals(entries, { allowSupersession = true } = {}) {
    if (!Array.isArray(entries)) return entries;
    if (!allowSupersession) {
        for (const entry of entries) entry.supersedes = [];
        return entries;
    }
    const existing = new Map((getAllEntries() || []).filter(Boolean).map(entry => [entry.id, entry]));
    for (const entry of entries) {
        const owners = new Set((entry.primaryCharacters?.length ? entry.primaryCharacters : [entry.primaryCharacter]).filter(Boolean).map(name => String(name).trim().toLowerCase()));
        const safe = [];
        for (const id of [...new Set(Array.isArray(entry.supersedes) ? entry.supersedes.filter(Boolean) : [])]) {
            const target = existing.get(id);
            if (!target || target.category !== "character") continue;
            const targetOwners = (target.primaryCharacters?.length ? target.primaryCharacters : [target.primaryCharacter]).filter(Boolean).map(name => String(name).trim().toLowerCase());
            if (!targetOwners.length || !targetOwners.every(name => owners.has(name))) continue;
            if (target.source !== "llm_generated") continue;
            if (target.status !== "active") continue;
            if (target.important || target.excludeFromConsolidation || target.consolidatedSourceOf || target.consolidationId) continue;
            if (Array.isArray(target.chainIds) && target.chainIds.length) continue;
            if (isEffectivelySuppressed(target)) continue;
            safe.push(id);
        }
        entry.supersedes = safe;
    }
    return entries;
}

function normalizeWriterChainAction(raw) {
    const direct = raw?.chainAction || raw?.chain_action;
    const source = direct && typeof direct === "object" ? direct : raw || {};
    const action = String(source.action || direct || source["Chain Action"] || "none").trim().toLowerCase();
    if (!["append", "create"].includes(action)) return { action: "none" };
    const description = String(source.description || source.chainDescription || source["Chain Description"] || "").trim();
    const label = String(source.label || source.chainLabel || source["Chain Label"] || "Developmental thread").trim();
    return {
        action,
        chainId: String(source.chainId || source.chain_id || source["Chain ID"] || "").trim() || null,
        memoryIds: normalizeStringList(source.memoryIds || source.memory_ids || source.chainMemoryIds || source["Chain Memory IDs"] || []),
        label,
        description,
        revisedLabel: String(source.revisedLabel || source.revised_label || source.revisedChainLabel || source["Revised Chain Label"] || "").trim(),
        revisedDescription: String(source.revisedDescription || source.revised_description || source.revisedChainDescription || source["Revised Chain Description"] || (action === "append" ? description : "")).trim(),
    };
}

function normalizeWriterChainActions(raw) {
    const source = raw?.chainActions ?? raw?.chain_actions ?? raw?.["Chain Actions"];
    let items = [];
    if (Array.isArray(source)) items = source;
    else if (source && typeof source === "object") items = [source];
    else if (typeof source === "string" && source.trim()) {
        try {
            const parsed = JSON.parse(source);
            items = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
            items = source.split(/\n|;/).map(parseWriterChainActionLine).filter(Boolean);
        }
    }

    // Backward compatibility with v0.1.29 and older writer/custom prompts.
    if (!items.length) {
        const legacy = normalizeWriterChainAction(raw);
        if (legacy.action !== "none") items = [legacy];
    }

    const normalized = items
        .map(item => typeof item === "string" ? parseWriterChainActionLine(item) : item)
        .filter(Boolean)
        .map(item => normalizeWriterChainAction(item))
        .filter(item => item.action !== "none");
    const seen = new Set();
    return normalized.filter(item => {
        const key = JSON.stringify([item.action, item.chainId || "", [...(item.memoryIds || [])].sort(), item.label || "", item.description || "", item.revisedLabel || "", item.revisedDescription || ""]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function parseWriterChainActionLine(line) {
    const text = String(line || "").trim().replace(/^[-*\d.)\s]+/, "");
    if (!text || /^none\b/i.test(text)) return null;
    const actionMatch = text.match(/^(append|create)\b/i);
    if (!actionMatch) return null;
    const action = actionMatch[1].toLowerCase();
    const read = label => {
        const re = new RegExp(`${label}\\s*:\\s*([^|]+)`, "i");
        return text.match(re)?.[1]?.trim() || "";
    };
    return {
        action,
        chainId: read("Chain ID"),
        memoryIds: read("Chain Memory IDs"),
        label: read("Chain Label"),
        description: read("Chain Description"),
        revisedLabel: read("Revised Chain Label"),
        revisedDescription: read("Revised Chain Description"),
    };
}

export function resolveMemoryEntryPrompt() {
    const saved = String(getSetting("memoryWriting.memoryEntryPrompt", "") || "").trim();
    // A custom prompt is a real override. Do not append hidden house rules to it.
    if (saved) return substituteUserMacro(saved);
    return substituteUserMacro(`${buildDefaultMemoryEntryPrompt()}

${buildMemoryGroundingRules()}`);
}

export function resolveSceneSummaryPrompt() {
    const saved = String(getSetting("memoryWriting.sceneSummaryPrompt", "") || "").trim();
    if (saved) return substituteUserMacro(saved);
    return substituteUserMacro(`${buildDefaultSceneSummaryPrompt()}

${buildSceneGroundingRules()}`);
}

// The {{user}} macro is only substituted by ST inside the chat pipeline — raw API
// calls send it as literal text, so the model has no idea who "{{user}}" is and
// keeps writing memories for the player, wasting tokens. Substitute it ourselves.
function substituteUserMacro(text) {
    const playerName = (typeof name1 !== "undefined" && name1) ? name1 : "the human player";
    return String(text).replace(/\{\{user\}\}/gi, playerName);
}

function buildRegenerationPrompt(entry, guidance) {
    let prompt = "Regenerate this memory entry. The prior draft may contain factual or causal mistakes; SOURCE SCENE below is authoritative. Do not merely polish or paraphrase the old draft. Re-evaluate the remembered pressure point from the source evidence.\n\n";
    prompt += `PRIOR DRAFT TO REPLACE:\nTitle: ${entry.title}\nContent: ${entry.content}\n`;

    const scene = entry?.sceneId ? getScene(entry.sceneId) : null;
    if (scene) {
        const sceneMessages = getSceneMessages(scene);
        if (sceneMessages) {
            prompt += `\nSOURCE SCENE — AUTHORITATIVE EVIDENCE:\n${sceneMessages}\n`;
        }
    }

    if (guidance) {
        prompt += `\nUSER CORRECTION / GUIDANCE — PRIORITIZE THIS WHEN CONSISTENT WITH THE SOURCE:\n${guidance}\n`;
    }
    prompt += "\nWrite the corrected Core Memory entry using the exact format from your instructions. Preserve material failures, mistakes, breakdowns, recoveries, and causal direction. Usually ONE entry — only if something genuinely pivotal happened.";
    return prompt;
}

// ─── Helpers ──────────────────────────────────────────────



/**
 * Sanitize a raw Key Character value. Models love to dodge "leave it blank" by
 * writing an explanatory sentence into the field — e.g.
 * "(None—Alex is alone in their room, reflecting on secondhand information)".
 * That is noise the user then has to delete by hand. This drops any token that
 * is a "none"-style placeholder or reads like prose rather than a name, and
 * returns a clean array (often empty, which is valid for Key Characters).
 */
function sanitizeKeyCharacters(list) {
    if (typeof list === "string") list = list.split(/\s*,\s*|\s+and\s+/i);
    if (!Array.isArray(list)) list = [];
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

function normalizeStringList(value) {
    const values = Array.isArray(value) ? value : String(value || "").split(/\s*,\s*/);
    return values.map(item => String(item || "").trim()).filter(Boolean);
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
 * Get the complete narrative text of messages within a scene's range.
 *
 * IMPORTANT: Memory Loom must not silently shorten, sample, summarize, or
 * excerpt source RP messages before they reach the scene summarizer or memory
 * writers. These messages are the authoritative evidence for attribution,
 * chronology, dialogue, failures, motives, and causal detail. If a selected
 * model cannot fit a scene, the request should fail transparently rather than
 * mutating the evidence behind the user's back.
 *
 * @param {object} scene
 * @returns {string}
 */
export function getSceneMessages(scene, includeHidden = false) {
    if (!chat || !Array.isArray(chat)) return "";
    const end = scene.messageEnd ?? (chat.length - 1);
    let msgs = chat.slice(scene.messageStart, end + 1).map((msg, offset) => ({
        ...msg,
        _mlMessageIndex: Number(scene.messageStart || 0) + offset,
    }));

    // `is_system: true` is also SillyTavern's hidden-message flag. The shared
    // narrative classifier distinguishes hidden RP from real utility/tool/system
    // records, so historical context management cannot erase evidence from a
    // Memory Loom scene. includeHidden is retained for API compatibility.
    msgs = msgs.filter(isNarrativeMessage);

    return msgs.map((msg, localIndex) => {
        const sourceIndex = Number.isFinite(Number(msg?._mlMessageIndex))
            ? Number(msg._mlMessageIndex)
            : localIndex;
        const prefix = msg?.is_user
            ? `[Message ${sourceIndex}] [${name1 || "User"}, human player]:\n`
            : `[Message ${sourceIndex}] [Roleplay narration / NPCs]:\n`;
        return prefix + String(msg?.mes || "");
    }).join("\n\n");
}


// ─── Player/unknown entry filter ──────────────────────────
// Hard backstop: discard any entry that cannot be attributed to a real NPC.
// Catches blank primaries, "Unknown"/"None"/"N/A" placeholders, the literal
// {{user}} macro, the player persona's full name, AND any single token of the
// persona name (so "Alex" alone is caught when the persona is "Morgan
// Alex"). The prompt tells the model not to write these; this guarantees
// none survive even when the model ignores that.
/**
 * Returns title openings (first 2 words) that are over-represented in the
 * library, so the writer can be told to avoid them. Threshold scales a little
 * with library size but stays conservative. Returns up to 3 worst offenders.
 */
function getOverusedTitleOpenings() {
    let entries = [];
    try { entries = getAllEntries() || []; } catch (e) { return []; }
    if (entries.length < 6) return [];   // too small to judge repetition
    const counts = {};
    for (const e of entries) {
        const words = String(e.title || "").trim().split(/\s+/);
        if (words.length < 2) continue;
        const opening = (words[0] + " " + words[1]).toLowerCase();
        // skip trivial openings that aren't really a "style" (e.g. "a the")
        counts[opening] = (counts[opening] || 0) + 1;
    }
    // "overused" = appears in >= 20% of entries, min 3 occurrences
    const threshold = Math.max(3, Math.ceil(entries.length * 0.2));
    const overused = Object.entries(counts)
        .filter(([, c]) => c >= threshold)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        // present in original casing-ish form (Title Case the opening)
        .map(([opening]) => opening.replace(/\b\w/g, ch => ch.toUpperCase()));
    return overused;
}

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
    // solely to Morgan Alex)". Any primary that talks about absence of an
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
    const firstTitle = response.search(/(?:\*\*|__)?\s*Title\s*(?:(?:\*\*|__)\s*:|:\s*(?:\*\*|__)?)/i);
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
    const hasRealEntry = /(?:\*\*|__)?\s*(title|content|primary character)\s*(?:(?:\*\*|__)\s*:|:\s*(?:\*\*|__)?)/i.test(response);
    const noMemExact = cleaned === "no memory" || cleaned === "no memory needed" ||
        cleaned === "none" || cleaned === "no core memory" || cleaned === "no entry";
    const noMemLeading = /^(no memory|no core memory|no entry)\b/.test(cleaned) && cleaned.length < 120;
    if (!hasRealEntry && (noMemExact || noMemLeading)) {
        console.log("[ML] Writer: model returned [NO MEMORY] for " + sceneId + " — no entry created");
        return [];
    }
    try {
        // Only treat as JSON if the response actually STARTS with a JSON array
        // (after optional code fence). Otherwise a stray "[NPC]" or "[NO MEMORY]"
        // token inside prose would be mis-detected as JSON and throw.
        const fenced = response.replace(/^```(?:json)?\s*/i, "").trim();
        if (/^\[\s*\]\s*(?:```)?$/.test(fenced)) return [];
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
        const normalized = entries.map(e => ({
            title: e.title || e.Title || "Untitled",
            datetime: e.datetime || e.date || e.Date || "",
            content: e.content || e.body || e.prose || e.entry || e.memory_entry || e.Memory || e.memory || e.text || "",
            primaryCharacter: e.primaryCharacter || e.primary_character || e["Primary Character"] || e.npc_name || e.npc || e.character || e.name || "",
            primaryCharacters: e.primaryCharacters || e.primary_characters || (e.primaryCharacter ? [e.primaryCharacter] : []),
            keyCharacters: e.keyCharacters || e.key_characters || [],
            category: e.category || "character",
            tags: normalizeStringList(e.tags),
            status: "active",
            delta: {
                before_state: e.delta?.before_state || e.before_state || "",
                after_state: e.delta?.after_state || e.after_state || "",
                delta: e.delta?.delta || e.delta_summary || "",
                delta_type: normalizeStringList(e.delta?.delta_type || e.delta_type),
                low_delta_flag: e.delta?.low_delta_flag || e.low_delta_flag || false,
            },
            source: "llm_generated",
            sceneId: sceneId,
            chainActions: normalizeWriterChainActions(e),
            supersedes: normalizeStringList(e.supersedes || e.Supersedes),
        })).map(e => {
            // Split joint primaries, resolve canonical names, drop banned/unknown
            // names individually ("Alex Morgan" → "Morgan Alex")
            const primaries = normalizePrimaries(e.primaryCharacter || e.primaryCharacters);
            e.primaryCharacter = primaries.length === 1 ? primaries[0] : "";
            e.primaryCharacters = primaries;
            e.keyCharacters = sanitizeKeyCharacters(e.keyCharacters || e.key_characters || []);
            return e;
        }).filter(e => {
            if (e.primaryCharacters.length === 0 || !String(e.content || "").trim()) {
                console.warn(`[ML] Writer: discarded incomplete or player/unknown entry: "${(e.title || "Untitled")}"`);
                return false;
            }
            return true;
        });
        return normalized.length > 0 ? normalized : null;
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
        var chainAction = "none", chainId = "", chainMemoryIds = "", chainLabel = "", chainDescription = "", supersedes = "";
        var chainActionLines = [];
        var inContent = false, inChainActions = false;
        
        for (var j = 0; j < lines.length; j++) {
            var line = lines[j].trim();
            // Tolerate **Title**:, **Title:**, __Title__:, and plain Title:.
            // Restrict labels so a colon in prose does not end Content early.
            var headerMatch = line.match(/^\s*(?:\*\*|__)?\s*(Title|Date(?:\/Time)?|Content|Primary Character|Key Characters?|Before|After|Delta|Delta Type|Chain Actions?|Chain ID|Chain Memory IDs|Chain Label|Chain Description|Supersedes)\s*(?:(?:\*\*|__)\s*:\s*|:\s*(?:\*\*|__)?\s*)(.*)$/i);
            if (headerMatch) {
                var fieldName = headerMatch[1].trim().toLowerCase();
                var fieldVal = headerMatch[2].trim();
                inChainActions = false;
                if (fieldName === "title") { title = fieldVal; inContent = false; }
                else if (fieldName === "date" || fieldName === "date/time") { date = fieldVal; inContent = false; }
                else if (fieldName === "content") { contentLines = [fieldVal]; inContent = true; }
                else if (fieldName.indexOf("primary") !== -1) { primary = fieldVal; inContent = false; }
                else if (fieldName.indexOf("key") !== -1) { keyChar = fieldVal; inContent = false; }
                else if (fieldName === "chain actions") { if (fieldVal) chainActionLines.push(fieldVal); inContent = false; inChainActions = true; }
                else if (fieldName === "chain action") { chainAction = fieldVal; inContent = false; }
                else if (fieldName === "chain id") { chainId = fieldVal; inContent = false; }
                else if (fieldName === "chain memory ids") { chainMemoryIds = fieldVal; inContent = false; }
                else if (fieldName === "chain label") { chainLabel = fieldVal; inContent = false; }
                else if (fieldName === "chain description") { chainDescription = fieldVal; inContent = false; }
                else if (fieldName === "supersedes") { supersedes = fieldVal; inContent = false; }
                else { inContent = false; }
            } else if (inChainActions && line.length > 0) {
                chainActionLines.push(line);
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
        
        if (!narrative) continue;
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
            var dMatch = dline.match(/^\s*(?:\*\*|__)?\s*(Before|After|Delta|Delta Type)\s*(?:(?:\*\*|__)\s*:\s*|:\s*(?:\*\*|__)?\s*)(.*)$/i);
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
            sceneId: sceneId,
            chainActions: chainActionLines.length
                ? normalizeWriterChainActions({ chainActions: chainActionLines })
                : normalizeWriterChainActions({ action: chainAction, chainId, memoryIds: chainMemoryIds, label: chainLabel, description: chainDescription }),
            supersedes: normalizeStringList(supersedes)
        });
    }
    if (results.length > 0) console.log("[ML] Writer: parsed " + results.length + " entries from markdown");
    return results.length > 0 ? results : null;
}
