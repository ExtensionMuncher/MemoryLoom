/**
 * llm/reranker.js — optional second-pass LLM ranking for vector recall
 *
 * Vector search is fast and broad, but embedding similarity can confuse nearby
 * themes. The reranker runs only after vector/lexical candidates already exist,
 * uses the Keyword sidecar LLM profile, and returns a reordered candidate list.
 * It is intentionally optional because it adds one extra LLM call on turns where
 * there are more candidates than Memory Loom can inject.
 */

import { chat, name1 } from "../../../../../script.js";
import { makeRequest } from "./connections.js";
import { getSetting } from "../settings.js";
import { dlog } from "../lib/debug.js";

function getRerankSettings() {
    const cfg = getSetting("vectorization.rerank", {}) || {};
    const legacyRaw = getSetting("vectorization.raw.rerank", false);
    return {
        enabled: cfg.enabled !== undefined ? !!cfg.enabled : !!legacyRaw,
        // Keep this intentionally small. The reranker runs inside the generation
        // path, so huge candidate pools can stall the sidecar before the reply
        // even starts. Users can still lower it further from Scanning settings.
        maxCandidates: Math.min(6, Math.max(2, Number(cfg.maxCandidates) || 5)),
        contextDepth: Math.min(8, Math.max(1, Number(cfg.contextDepth) || 3)),
        maxResponseTokens: Math.min(700, Math.max(200, Number(cfg.maxResponseTokens) || 450)),
        timeoutMs: Math.min(30000, Math.max(5000, Number(cfg.timeoutMs) || 12000)),
        maxPromptChars: Math.min(14000, Math.max(5000, Number(cfg.maxPromptChars) || 9000)),
    };
}

function stripHtml(text) {
    return String(text || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function buildRecentContext(depth) {
    if (!Array.isArray(chat) || !chat.length) return "";
    return chat.slice(-depth).map(msg => {
        const speaker = msg?.is_user ? (name1 || "User") : (msg?.name || "Character");
        const text = stripHtml(msg?.mes).slice(0, 420);
        return `${speaker}: ${text}`;
    }).filter(Boolean).join("\n");
}

function summarizeCandidate(candidate, index) {
    const entry = candidate.entry || {};
    const delta = entry.delta || {};
    const primaries = Array.isArray(entry.primaryCharacters) && entry.primaryCharacters.length
        ? entry.primaryCharacters.join(", ")
        : (entry.primaryCharacter || "");
    const keyCharacters = Array.isArray(entry.keyCharacters) ? entry.keyCharacters.join(", ") : "";
    const tags = Array.isArray(entry.tags) ? entry.tags.join(", ") : "";
    const flags = [];
    if (entry.status) flags.push(`status=${entry.status}`);
    if (entry.important) flags.push("important");

    const lines = [
        `Candidate ${index + 1}`,
        `id: ${entry.id}`,
        `vector_score: ${Number(candidate.score || 0).toFixed(3)}`,
        `title: ${entry.title || "Untitled"}`,
    ];
    if (primaries) lines.push(`primary: ${primaries}`);
    if (keyCharacters) lines.push(`key_characters: ${keyCharacters}`);
    if (tags) lines.push(`tags: ${tags}`);
    if (flags.length) lines.push(`flags: ${flags.join(", ")}`);
    if (delta.delta) lines.push(`delta: ${stripHtml(delta.delta).slice(0, 180)}`);
    if (delta.after_state) lines.push(`after_state: ${stripHtml(delta.after_state).slice(0, 140)}`);
    lines.push(`content: ${stripHtml(entry.content).slice(0, 320)}`);
    return lines.join("\n");
}

function buildSystemPrompt() {
    return `Rerank Memory Loom candidates for the current roleplay moment.
Prefer memories that directly affect active characters, unresolved tension, promises, secrets, injuries, reveals, relationship shifts, or required continuity. Lower vague theme/name matches.
Return ONLY JSON: {"ranked":[{"id":"memory_id_here","score":0-100}]}
Use each candidate id once. No prose.`;
}

function buildUserPrompt(candidates, sidecarResult, queryText, contextDepth) {
    const recent = buildRecentContext(contextDepth);
    const sidecar = sidecarResult ? JSON.stringify({
        keywords: sidecarResult.keywords || [],
        characters: sidecarResult.characters || [],
        themes: sidecarResult.themes || [],
        events: sidecarResult.events || [],
    }, null, 2) : "{}";

    return `Current retrieval query:\n${queryText || "(empty)"}\n\nRecent chat context:\n${recent || "(unavailable)"}\n\nSidecar signal:\n${sidecar}\n\nCandidate memories to rerank:\n\n${candidates.map(summarizeCandidate).join("\n\n---\n\n")}\n\nReturn the JSON ranking only.`;
}

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

function extractJson(text) {
    const raw = String(text || "").replace(/```json\s*|```/g, "").trim();
    const objStart = raw.indexOf("{");
    const objEnd = raw.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) return JSON.parse(raw.slice(objStart, objEnd + 1));
    const arrStart = raw.indexOf("[");
    const arrEnd = raw.lastIndexOf("]");
    if (arrStart >= 0 && arrEnd > arrStart) return JSON.parse(raw.slice(arrStart, arrEnd + 1));
    throw new Error("No JSON object or array found");
}

function parseRanking(response) {
    const parsed = extractJson(response);
    const list = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed?.ranked) ? parsed.ranked : []);

    const scores = new Map();
    const order = [];
    for (const item of list) {
        let id = null;
        let score = null;
        if (typeof item === "string") {
            id = item;
        } else if (item && typeof item === "object") {
            id = item.id || item.entry_id || item.memory_id;
            score = clamp01(item.score ?? item.relevance ?? item.rank_score);
        }
        id = String(id || "").trim();
        if (!id || order.includes(id)) continue;
        order.push(id);
        if (score !== null) scores.set(id, score);
    }
    return { order, scores };
}

/**
 * Reorder candidates with an optional LLM rerank pass.
 *
 * @param {{entry:object,score:number}[]} candidates already filtered/sorted candidates
 * @param {object} sidecarResult keyword extraction result
 * @param {string} queryText text used for vector query
 * @param {number} injectionLimit global injection cap; rerank skips when there is no competition
 * @returns {Promise<{entry:object,score:number,rerankScore?:number}[]>}
 */
export async function rerankCandidates(candidates, sidecarResult, queryText, injectionLimit = 3) {
    const cfg = getRerankSettings();
    if (!cfg.enabled) return candidates;
    if (!Array.isArray(candidates) || candidates.length <= 1) return candidates;

    const limit = Math.max(1, Number(injectionLimit) || 3);
    // If every surviving candidate can inject anyway, a second LLM call mostly
    // burns money/time for prompt-order cosmetics. Skip until there is actual
    // competition for limited injection slots.
    if (candidates.length <= limit) {
        dlog(`Reranker skipped — ${candidates.length} candidate(s) fit within injection cap ${limit}`);
        return candidates;
    }

    const profileName = getSetting("connections.sidecarLLM", "");
    if (!profileName) {
        console.warn("[ML] Reranker skipped — no Keyword sidecar LLM configured");
        return candidates;
    }

    const poolSize = Math.min(candidates.length, cfg.maxCandidates);
    const pool = candidates.slice(0, poolSize);
    const tail = candidates.slice(poolSize);

    try {
        const userPrompt = buildUserPrompt(pool, sidecarResult, queryText, cfg.contextDepth);
        if (userPrompt.length > cfg.maxPromptChars) {
            console.warn(`[ML] Reranker skipped — prompt would be too large (${userPrompt.length} chars > ${cfg.maxPromptChars})`);
            return candidates;
        }

        dlog(`Reranker: ranking ${pool.length} candidate(s) via Keyword sidecar profile (timeout ${cfg.timeoutMs}ms)`);
        const response = await makeRequest(
            profileName,
            buildSystemPrompt(),
            userPrompt,
            cfg.maxResponseTokens,
            0.1,
            {
                // Reranking is optional. It must never retry itself into a long
                // generation stall while the turn is waiting on retrieval.
                maxRetries: 0,
                timeoutMs: cfg.timeoutMs,
                suppressToasts: true,
            },
        );
        if (!response) return candidates;

        const { order, scores } = parseRanking(response);
        if (!order.length) {
            console.warn("[ML] Reranker returned no usable ranking; keeping vector order");
            return candidates;
        }

        const byId = new Map(pool.map((candidate, idx) => [String(candidate.entry?.id || ""), { candidate, idx }]));
        const ranked = [];
        const used = new Set();

        for (const id of order) {
            const found = byId.get(id);
            if (!found || used.has(id)) continue;
            const llmScore = scores.get(id);
            const originalScore = Number(found.candidate.score || 0);
            const blendedScore = llmScore === undefined
                ? originalScore
                : (originalScore * 0.35) + (llmScore * 0.65);
            ranked.push({
                ...found.candidate,
                score: blendedScore,
                rerankScore: llmScore,
            });
            used.add(id);
        }

        // Keep any omitted/malformed ids rather than dropping memories because a
        // local model got sloppy. They stay below the explicitly ranked items in
        // their original vector order.
        for (const { candidate } of byId.values()) {
            const id = String(candidate.entry?.id || "");
            if (!used.has(id)) ranked.push(candidate);
        }

        // Preserve the model's explicit output order. Scores are blended into
        // candidate.score for logging/downstream tie-break intuition, but the
        // reranker's ordered list is the source of truth.
        console.log(`[ML] Reranker: reordered ${ranked.length} candidate(s)`);
        return [...ranked, ...tail];
    } catch (err) {
        console.warn("[ML] Reranker failed; keeping vector order:", err);
        return candidates;
    }
}
