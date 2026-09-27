import { makeRequest } from "./connections.js";
import { getSetting } from "../settings.js";
import { getAllEntries } from "../data/entries.js";
import { getAllChains, saveChainProposals, MAX_HISTORICAL_CHAIN_NODES } from "../data/chains.js";
import { getEffectiveSuppressions } from "../data/suppression.js";
import { captureChatGuard } from "../lib/chatGuard.js";
import { getPendingEntries, getPendingChainProposals, getPostBatchChainScans, removePostBatchChainScan } from "../data/storage.js";

const ELIGIBLE_STATUSES = new Set(["active", "consolidation", "consolidated", "pinned"]);
const CHAIN_SCAN_TIMEOUT_MS = 30 * 60 * 1000;

function getChainScanResponseTokens(usesConsolidationProfile) {
    // Historical scans can cover a large corpus. When the Consolidation profile
    // is selected, use its larger structured-output budget so mandatory-thinking
    // models still have room to emit the final JSON after their reasoning.
    const setting = usesConsolidationProfile ? "consolidation.maxResponseTokens" : "connections.maxResponseTokens";
    const fallback = usesConsolidationProfile ? 30000 : 8000;
    const minimum = usesConsolidationProfile ? 1000 : 500;
    const value = Number(getSetting(setting, fallback));
    return Number.isFinite(value) && value >= minimum ? value : fallback;
}

export function isChainScanEligible(entry) {
    if (!entry || !ELIGIBLE_STATUSES.has(entry.status || "active")) return false;
    // Consolidated reduced-priority sources remain valuable historical stages, but
    // memories suppressed as erroneous/manual/superseded must not seed new
    // backfill proposals.
    return getEffectiveSuppressions(entry).every(item => item.reason === "consolidation");
}

function extractJson(text) {
    const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return JSON.parse(raw); } catch {}
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("The chain scan did not return valid JSON.");
}

function compactEntry(entry) {
    return {
        id: entry.id,
        title: String(entry.title || "").slice(0, 160),
        datetime: entry.datetime || "",
        createdAt: Number(entry.createdAt || 0),
        category: entry.category || "",
        primaryCharacter: entry.primaryCharacter || "",
        primaryCharacters: Array.isArray(entry.primaryCharacters) ? entry.primaryCharacters : (entry.primaryCharacter ? [entry.primaryCharacter] : []),
        content: String(entry.content || "").slice(0, 900),
        delta: entry.delta || null,
        consolidatedSourceOf: entry.consolidatedSourceOf || null,
        chainIds: Array.isArray(entry.chainIds) ? entry.chainIds : [],
    };
}

export function parseChainScanResponse(response, eligibleIds) {
    const parsed = extractJson(response);
    const allowed = eligibleIds instanceof Set ? eligibleIds : new Set(eligibleIds || []);
    const proposals = Array.isArray(parsed) ? parsed : parsed.proposals;
    if (!Array.isArray(proposals)) throw new Error("The chain scan response is missing proposals.");
    const normalized = proposals.map(item => ({
        label: String(item?.label || "Developmental thread").trim().slice(0, 120),
        description: String(item?.description || "").trim().slice(0, 600),
        primaryCharacter: String(item?.primaryCharacter || item?.primary_character || "").trim().slice(0, 120),
        memoryIds: [...new Set(Array.isArray(item?.memoryIds) ? item.memoryIds : [])].filter(id => allowed.has(id)),
    }));
    const oversized = normalized.filter(item => item.memoryIds.length > MAX_HISTORICAL_CHAIN_NODES);
    if (oversized.length) {
        const largest = Math.max(...oversized.map(item => item.memoryIds.length));
        throw new Error(`The chain scan proposed an over-broad ${largest}-memory chain. Historical proposals are limited to ${MAX_HISTORICAL_CHAIN_NODES} sparse developmental milestones. No proposals were changed.`);
    }
    return normalized.filter(item => item.memoryIds.length >= 2);
}

/** Manual, preview-only historical scan. It never mutates chains directly. */
export async function scanForMemoryChains(options = {}) {
    const assertChat = captureChatGuard();
    const consolidationProfile = getSetting("connections.consolidationLLM", "");
    const profile = consolidationProfile || getSetting("connections.memoryWriterLLM", "");
    if (!profile) throw new Error("Configure a Memory Writer or Consolidation LLM first.");
    const entries = getAllEntries().filter(isChainScanEligible);
    if (entries.length < 2) return saveChainProposals([]);
    const eligibleIds = new Set(entries.map(entry => entry.id));
    const existingChains = getAllChains().map(chain => ({ id: chain.id, label: chain.label, description: chain.description || "", primaryCharacter: chain.primaryCharacter || "", memoryIds: chain.memoryIds }));
    const system = `You identify rare developmental chains among rich episodic memories. A chain is a sparse sequence of major state-changing milestones in one narrowly defined developmental thread: establishment, development, escalation, reversal, complication, resolution, or recontextualization.

THREAD BOUNDARIES — ABSOLUTE:
- A CHARACTER IS NOT A CHAIN. The same character can have multiple independent chains when different beliefs, fears, promises, conflicts, relationship dimensions, goals, or recurring psychological questions develop separately.
- EVERY CHAIN IS OWNED BY ONE PRIMARY CHARACTER. Set primaryCharacter to that memory owner and include ONLY memories whose Primary Character / Primary Characters field contains that same character. A Key Character, mentioned character, relationship target, or story protagonist does NOT qualify.
- Never build a chain "about Alex" (or any other target) by combining Morgan's, Riley's, Jordan's, Casey's, etc. separate memories. If several characters react to the same person or event, those are separate character-specific developmental threads.
- Do NOT force all memories for one character or relationship into one umbrella chain. Labels such as "X's bond with Y", "X's relationship with Y", "X's journey", or "X's growth" are too broad unless every included memory advances one precise named dimension.
- When the corpus supports several narrow developmental threads for the same Primary Character, return separate proposals for those threads. One memory MAY appear in more than one proposal when it genuinely advances more than one distinct thread for that same Primary Character.
- EXISTING MEMBERSHIP DOES NOT MAKE A MEMORY UNAVAILABLE. A memory already present in an existing chain MAY also appear in a new proposal when it independently advances a DIFFERENT developmental thread for that same Primary Character. Do not duplicate an existing thread; reuse of the memory itself is allowed.
- Many memories should remain unchained. Shared Key Characters, locations, relationships, topics, tone, chronology, or arc membership alone are insufficient.
- It is NOT an entire story arc, character history, folder, chronological run, or every memory involving the same character.

Include only memories whose before/after state materially advances that exact thread. Each proposal must contain 2-${MAX_HISTORICAL_CHAIN_NODES} memories; select the strongest milestones instead of exhaustive coverage. If a single narrow thread has more than ${MAX_HISTORICAL_CHAIN_NODES} plausible nodes, omit marginal episodes rather than splitting it into arbitrary chronological chunks. Do not use the node limit as a reason to create arbitrary "part 1 / part 2" chains. Preserve every distinct episode; never merge or suppress memories. Default strongly to no proposal. Do not output analysis or reasoning. Return one final JSON object only: {"proposals":[{"primaryCharacter":"exact Primary Character owner","label":"specific developmental thread, not an arc name","description":"the concrete state progression shared by every included memory","memoryIds":["exact id"]}]}. Use only supplied IDs and omit weak proposals.`;
    const user = `EXISTING CHAINS (do not duplicate):\n${JSON.stringify(existingChains)}\n\nACTIVE AND CONSOLIDATED MEMORIES:\n${JSON.stringify(entries.map(compactEntry))}`;
    const maxTokens = getChainScanResponseTokens(!!consolidationProfile);
    // This is a manually initiated, corpus-wide maintenance operation. Its
    // deadline must accommodate slow local hardware, queued remote providers,
    // mandatory-reasoning models, and large archives without model-specific
    // heuristics. Fast providers still return immediately.
    const timeoutMs = CHAIN_SCAN_TIMEOUT_MS;
    const requestOptions = {
        requestLabel: "the memory chaining scan",
        // Best-effort only. Models with mandatory thinking may ignore this;
        // correctness relies on the larger budget and final-answer validation.
        preferNoThink: true,
        maxRetries: 0,
        timeoutMs,
        throwOnTimeout: true,
        throwOnReasoningOnly: true,
        suppressReasoningOnlyToast: true,
    };
    let response;
    try {
        response = await makeRequest(profile, system, user, maxTokens, 0.2, requestOptions);
    } catch (error) {
        if (error?.code === "ML_REQUEST_TIMEOUT") {
            const minutes = Math.round(timeoutMs / 60000);
            throw new Error(`The memory chaining scan timed out after ${minutes} minutes. No proposals were changed. The selected model did not finish the corpus-wide scan in time.`);
        }
        if (error?.code !== "ML_REASONING_ONLY") throw error;
        // Some reasoning models ignore the first soft directive. Retry this
        // manual, preview-only operation once with an explicit final-answer
        // correction. Never parse or persist the private reasoning itself.
        assertChat();
        const retryUser = `${user}\n\nYour previous attempt returned reasoning without a final answer. Return the requested final JSON object now, with no analysis or commentary.`;
        try {
            response = await makeRequest(profile, system, retryUser, maxTokens, 0.1, requestOptions);
        } catch (retryError) {
            if (retryError?.code === "ML_REQUEST_TIMEOUT") {
                const minutes = Math.round(timeoutMs / 60000);
                throw new Error(`The memory chaining scan retry timed out after ${minutes} minutes. No proposals were changed.`);
            }
            if (retryError?.code === "ML_REASONING_ONLY") {
                throw new Error("The memory chaining scan returned reasoning without a final JSON answer twice. No proposals were changed. Try raising the Consolidation max response tokens for this profile.");
            }
            throw retryError;
        }
    }
    assertChat();
    if (!response) throw new Error("The chain scan returned no response.");
    // The model may still occasionally propose a cross-character thematic arc.
    // Skip those proposals rather than letting one bad item discard otherwise
    // valid character-specific proposals; the data layer revalidates again at
    // approval/apply time.
    const parsed = parseChainScanResponse(response, eligibleIds);
    if (!options.mergeExisting) return saveChainProposals(parsed, { skipInvalid: true });

    // Automatic post-batch reconciliation must never erase proposals the user
    // was already reviewing. Merge by owner + exact member set + label, while
    // preserving the existing proposal's approval state and stable id.
    const existing = getPendingChainProposals() || [];
    const keyOf = item => JSON.stringify([
        String(item?.primaryCharacterKey || item?.primaryCharacter || "").toLowerCase(),
        [...new Set(item?.memoryIds || [])].sort(),
        String(item?.label || "").trim().toLowerCase(),
    ]);
    const merged = [...existing];
    const seen = new Set(existing.map(keyOf));
    for (const proposal of parsed) {
        const key = keyOf(proposal);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(proposal);
    }
    return saveChainProposals(merged, { skipInvalid: true });
}

let queuedBatchChainScanTask = null;

/**
 * Run the corpus-wide chain reconciliation for completed batch scans whose
 * generated character memories have all been committed or discarded. This is
 * deliberately the dead-last phase: it never scans unresolved Pending Review
 * cards, because those cards do not yet have durable memory IDs.
 */
export async function runReadyPostBatchChainScans() {
    if (queuedBatchChainScanTask) return queuedBatchChainScanTask;
    const task = (async () => {
        const queue = getPostBatchChainScans() || [];
        if (!queue.length) return { ran: false, waiting: 0, proposals: [] };
        const pending = getPendingEntries() || [];
        const waitingIds = new Set(pending.map(entry => entry?.batchChainScanId).filter(Boolean));
        const ready = queue.filter(item => !waitingIds.has(item.id));
        if (!ready.length) return { ran: false, waiting: queue.length, proposals: [] };

        const proposals = await scanForMemoryChains({ mergeExisting: true });
        for (const item of ready) removePostBatchChainScan(item.id);
        return { ran: true, waiting: queue.length - ready.length, proposals, completed: ready.map(item => item.id) };
    })();
    queuedBatchChainScanTask = task;
    try { return await task; }
    finally { if (queuedBatchChainScanTask === task) queuedBatchChainScanTask = null; }
}
