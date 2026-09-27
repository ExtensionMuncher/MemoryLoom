import { captureChatGuard } from "../lib/chatGuard.js";
/**
 * embed/retriever.js — Memory retrieval pipeline
 *
 * Runs after each sidecar keyword extraction:
 *   1. Builds query text from sidecar keywords
 *   2. POSTs to /api/vector/query for server-side similarity search
 *   3. Maps results back to entry IDs
 *   4. Applies stickiness, cooldown, and decay rules
 *   5. Returns final candidates for injection
 *
 * Pattern: follows VectFox's queryCollection() in core-vector-api.js.
 */

import { getRequestHeaders, chat, name1 } from "../../../../../script.js";
import { getSetting } from "../settings.js";
import { getEntry } from "../data/entries.js";
import { getEntries, getStickinessMap, saveStickinessMap, getCooldownsMap, saveCooldownsMap, getFolders } from "../data/storage.js";
import { getCollectionId, prepareVectorRequestFields } from "./embedder.js";
import { dlog, publishRetrievalTrace } from "../lib/debug.js";
import { rerankCandidates } from "../llm/reranker.js";
import { narrativeMessages } from "../lib/chatMessages.js";
import { getChain, getOrderedChainEntries, entryBelongsToChainCharacter } from "../data/chains.js";
import { isEffectivelySuppressed } from "../data/suppression.js";


/** Build the provider settings object used for vector queries — shared with the recall tool. */
export function buildVectorSettings() {
    return {
        source:                   getSetting("embedding.source", "transformers"),
        ollama_model:             getSetting("embedding.ollama_model", ""),
        ollama_use_alt_endpoint:  getSetting("embedding.ollama_use_alt_endpoint", false),
        ollama_alt_endpoint_url:  getSetting("embedding.ollama_alt_endpoint_url", ""),
        koboldcpp_use_alt_endpoint: getSetting("embedding.koboldcpp_use_alt_endpoint", false),
        koboldcpp_alt_endpoint_url: getSetting("embedding.koboldcpp_alt_endpoint_url", ""),
        vllm_model:               getSetting("embedding.vllm_model", ""),
        vllm_use_alt_endpoint:    getSetting("embedding.vllm_use_alt_endpoint", false),
        vllm_alt_endpoint_url:    getSetting("embedding.vllm_alt_endpoint_url", ""),
        openrouter_model:         getSetting("embedding.openrouter_model", ""),
        openai_model:             getSetting("embedding.openai_model", "text-embedding-3-small"),
        cohere_model:             getSetting("embedding.cohere_model", "embed-english-v3.0"),
        google_model:             getSetting("embedding.google_model", "text-embedding-005"),
        mistral_model:            getSetting("embedding.mistral_model", "mistral-embed"),
    };
}

export async function runRetrievalPipeline(sidecarResult) {
    const assertChat = captureChatGuard();
    const collectionId = getCollectionId();
    const queryText = buildQueryText(sidecarResult);
    const threshold = Number(getSetting("vectorization.similarityThreshold", 0.75));
    const maxEntries = Math.max(1, Number(getSetting("injection.maxEntriesPerMessage", 3)) || 3);
    const topK = Math.max(1, Number(getSetting("vectorization.raw.topK", 10)) || 10);
    const querySource = getSetting("vectorization.querySource", "keywords");
    const recordById = new Map();
    let discoveryIndex = 0;

    const trace = {
        timestamp: Date.now(),
        collectionId: collectionId || "",
        queryText: queryText || "",
        querySource,
        threshold,
        topK,
        maxEntries,
        status: "running",
        note: "",
        vectorHitCount: 0,
        lexicalAddedCount: 0,
        chainExpansion: { enabled: false, seeds: 0, considered: 0, added: 0, maxAdditions: 0 },
        reranker: {
            enabled: false,
            attempted: false,
            applied: false,
            skipReason: "",
            poolSize: 0,
        },
        candidates: [],
        summary: { matched: 0, eligible: 0, selected: 0, filtered: 0 },
    };

    const ensureRecord = (candidate) => {
        const entry = candidate?.entry;
        if (!entry?.id) return null;
        let record = recordById.get(entry.id);
        if (!record) {
            record = {
                id: entry.id,
                title: entry.title || "Untitled memory",
                status: entry.status || "active",
                category: categoryOfEntry(entry),
                discoveryIndex: discoveryIndex++,
                vectorScore: null,
                lexicalScore: null,
                lexicalTerms: [],
                initialScore: null,
                adjustedScore: null,
                finalScore: null,
                rerankScore: null,
                rerankRank: null,
                finalRank: null,
                stickyRemaining: 0,
                cooldownRemaining: 0,
                flags: [],
                decision: "Matched",
                reason: "",
            };
            recordById.set(entry.id, record);
        }
        if (Number.isFinite(candidate.vectorScore)) record.vectorScore = candidate.vectorScore;
        if (Number.isFinite(candidate.lexicalScore)) record.lexicalScore = candidate.lexicalScore;
        if (Array.isArray(candidate.lexicalTerms) && candidate.lexicalTerms.length) {
            record.lexicalTerms = [...new Set([...record.lexicalTerms, ...candidate.lexicalTerms])].slice(0, 6);
        }
        if (Number.isFinite(candidate.score)) record.initialScore = candidate.score;
        if (candidate.chainExpanded && !record.flags.includes("chain-expanded")) record.flags.push("chain-expanded");
        return record;
    };

    const finish = (status, note, result = []) => {
        trace.status = status;
        trace.note = note || "";
        trace.finishedAt = Date.now();
        trace.candidates = [...recordById.values()].sort((a, b) => a.discoveryIndex - b.discoveryIndex);
        trace.summary = {
            matched: trace.candidates.length,
            eligible: trace.candidates.filter(c => c.decision === "Eligible" || c.decision === "Selected").length,
            selected: trace.candidates.filter(c => c.decision === "Selected").length,
            filtered: trace.candidates.filter(c => c.decision === "Filtered" || c.decision === "Capped").length,
        };
        publishRetrievalTrace(trace);
        return result;
    };

    if (!collectionId) {
        dlog("Retriever skipped — no active vector collection");
        return finish("skipped", "No active vector collection was available.");
    }
    if (!queryText) {
        dlog("Retriever skipped — empty query text");
        return finish("skipped", "The sidecar produced no usable retrieval query.");
    }

    const mlSettings = buildVectorSettings();
    dlog(`Retriever query: "${queryText}" (collection ${collectionId}, topK ${topK}, threshold ${threshold})`);
    const rawResults = await queryCollection(collectionId, queryText, topK, threshold, mlSettings);

    assertChat();

    // IMPORTANT: Passive recall must not die just because vector search returns
    // no hits above threshold. Direct event/title references like "Yūji's first
    // kill" should still be able to surface "The First Kill" through lexical
    // fallback. The previous version returned here, so the fallback was never
    // reached — exactly the failure seen in F12 logs.
    let candidates = [];
    if (!rawResults || !rawResults.hashes || rawResults.hashes.length === 0) {
        dlog("Retriever: no vector hits above threshold; trying lexical fallback");
    } else {
        trace.vectorHitCount = rawResults.hashes.length;
        dlog(`Retriever: ${rawResults.hashes.length} raw vector hit(s)`);
        candidates = mapHashesToEntries(rawResults);
    }

    const beforeLexical = candidates.length;
    candidates = addLexicalFallbacks(candidates, sidecarResult, queryText);
    trace.lexicalAddedCount = Math.max(0, candidates.length - beforeLexical);
    candidates.forEach(ensureRecord);

    if (!candidates.length) {
        dlog("Retriever: no vector or lexical candidates");
        return finish("completed", "No stored memory matched the current query.");
    }

    let filtered = applyFilters(candidates, recordById);
    if (!filtered.length) {
        dlog(`Retriever: ${candidates.length} candidate(s) found but all were filtered by threshold/cooldown/status`);
        return finish("completed", "Candidates matched, but none survived the retrieval filters.");
    }

    const initialFiltered = [...filtered];
    filtered = expandChainCandidates(initialFiltered, queryText, recordById, trace.chainExpansion);

    // Optional LLM rerank: after vector/lexical retrieval, one-hop chain
    // expansion, and normal filters,
    // before category/global caps choose the final injection set. Disabled by
    // default because it adds one extra LLM call only when there are more
    // candidates than injection slots. Uses the Keyword sidecar profile.
    filtered = await rerankCandidates(filtered, sidecarResult, queryText, maxEntries, trace.reranker);
    assertChat();
    // The reranker can await a remote model. Rebind every result to the live
    // store afterwards so a memory suppressed/deleted during that wait cannot
    // slip into the next prompt from this stale candidate snapshot.
    const beforeRevalidation = [...filtered];
    filtered = revalidateLiveCandidates(filtered);
    const liveIds = new Set(filtered.map(candidate => candidate.entry.id));
    for (const candidate of beforeRevalidation) {
        if (liveIds.has(candidate.entry?.id)) continue;
        const record = ensureRecord(candidate);
        if (record) {
            record.decision = "Filtered";
            record.reason = "Memory was deleted or suppressed while retrieval was running.";
        }
    }
    filtered.forEach((candidate, index) => {
        const record = ensureRecord(candidate);
        if (!record) return;
        record.finalScore = Number.isFinite(candidate.score) ? candidate.score : record.adjustedScore;
        if (Number.isFinite(candidate.rerankScore)) record.rerankScore = candidate.rerankScore;
        if (Number.isFinite(candidate.rerankRank)) record.rerankRank = candidate.rerankRank;
        record.postRerankPosition = index + 1;
    });

    // Per-category caps: limit how many of each category inject, then apply the
    // global cap as an overall ceiling. Filtered is score/rerank-sorted, so we
    // keep the highest-ranked entries within each category's allowance.
    const perCat = getSetting("injection.maxPerCategory", {}) || {};
    const catCounts = {};
    const catLimited = [];
    for (const candidate of filtered) {
        const cat = categoryOfEntry(candidate.entry);
        const limit = Number.isFinite(perCat[cat]) ? perCat[cat] : Infinity;
        const used = catCounts[cat] || 0;
        const record = ensureRecord(candidate);
        if (used < limit) {
            catLimited.push(candidate);
            catCounts[cat] = used + 1;
        } else if (record) {
            record.decision = "Capped";
            record.reason = `${capitalize(cat)} category cap (${limit}) was already filled.`;
        }
    }

    const final = catLimited.slice(0, maxEntries);
    const selectedIds = new Set(final.map(c => c.entry?.id).filter(Boolean));
    for (const candidate of catLimited) {
        const record = ensureRecord(candidate);
        if (!record || record.decision === "Capped") continue;
        if (selectedIds.has(candidate.entry.id)) {
            record.decision = "Selected";
            record.finalRank = final.findIndex(c => c.entry?.id === candidate.entry.id) + 1;
            record.reason = `Selected for injection within the global cap of ${maxEntries}.`;
        } else {
            record.decision = "Capped";
            record.reason = `Global injection cap (${maxEntries}) was already filled by higher-ranked memories.`;
        }
    }

    if (final.length > 0) {
        console.log(`[ML] Retriever: ${final.length} entries selected for injection`);
    }
    return finish("completed", final.length
        ? `${final.length} memory entr${final.length === 1 ? "y was" : "ies were"} selected for injection.`
        : "No memory survived the final injection caps.", final);
}

export function revalidateLiveCandidates(candidates) {
    return (candidates || []).map(candidate => {
        const entry = getEntry(candidate?.entry?.id);
        return entry && !isEffectivelySuppressed(entry) ? { ...candidate, entry } : null;
    }).filter(Boolean);
}

function capitalize(value) {
    const text = String(value || "");
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Memory";
}

export async function queryCollection(collectionId, searchText, topK, threshold, mlSettings) {
    try {
        // Build provider-specific fields the same way embedder does
        const body = {
            collectionId,
            searchText,
            topK,
            threshold,
            source: mlSettings.source,
        };

        // Keep insert/delete/query provider preparation on one code path.
        // KoboldCpp requires a pre-embedding call before ST's vector endpoint,
        // and the returned model name scopes the on-disk vector index.
        Object.assign(body, await prepareVectorRequestFields(mlSettings, [searchText]));

        const response = await fetch('/api/vector/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
        if (!response.ok) return null;
        const data = await response.json();
        return { hashes: data.hashes || [], metadata: data.metadata || data.results || [] };
    } catch (err) {
        console.error("[ML] Retriever: query error:", err);
        return null;
    }
}

function buildQueryText(sidecarResult) {
    const querySource = getSetting("vectorization.querySource", "keywords");
    if (querySource === "raw") {
        return getRawRecentMessagesQuery();
    }

    // keywords already contains themes + events (sidecar folds them together);
    // appending themes again double-weighted them in the similarity query
    const parts = [];
    if (sidecarResult.keywords?.length) parts.push(sidecarResult.keywords.join(" "));
    if (sidecarResult.characters?.length) parts.push(sidecarResult.characters.join(" "));
    return parts.join(" ").trim();
}

function getRawRecentMessagesQuery() {
    if (!chat || !Array.isArray(chat)) return "";
    const depth = Math.max(1, Number(getSetting("vectorization.raw.scanDepth", 10)) || 10);
    const recent = narrativeMessages(chat).slice(-depth);
    return recent.map(msg => {
        const speaker = msg.is_user ? (name1 || "User") : (msg.name || "Character");
        const text = String(msg.mes || "").replace(/<[^>]+>/g, " ").slice(0, 1200);
        return `${speaker}: ${text}`;
    }).join("\n").trim();
}

function normalizeText(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/[^\p{L}\p{N}\s-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function buildLexicalTerms(sidecarResult, queryText) {
    const raw = [queryText, ...(sidecarResult.keywords || []), ...(sidecarResult.characters || []), ...(sidecarResult.themes || [])];
    const terms = new Set();
    for (const item of raw) {
        const base = normalizeText(item);
        if (!base || base.length < 3) continue;
        terms.add(base);
        terms.add(base.replace(/^memory of /, "").trim());
        terms.add(base.replace(/^memory about /, "").trim());
        const words = base.split(" ").filter(w => w.length > 2);
        // Preserve useful title-like tails, e.g. "memory of yujis first kill" → "first kill".
        for (let n = 2; n <= Math.min(4, words.length); n++) {
            terms.add(words.slice(-n).join(" "));
        }
    }
    return [...terms].filter(t => t && t.length >= 3);
}

function entrySearchText(entry) {
    const delta = entry.delta || {};
    return normalizeText([
        entry.title, entry.datetime, entry.content, entry.primaryCharacter,
        ...(entry.primaryCharacters || []), ...(entry.keyCharacters || []), ...(entry.tags || []),
        delta.before_state, delta.after_state, delta.delta,
    ].filter(Boolean).join("\n"));
}

function addLexicalFallbacks(candidates, sidecarResult, queryText) {
    const entries = Object.values(getEntries() || {});
    if (!entries.length) return candidates;
    const terms = buildLexicalTerms(sidecarResult || {}, queryText);
    if (!terms.length) return candidates;

    const byId = new Map(candidates.map(c => [c.entry.id, c]));
    let added = 0;
    for (const entry of entries) {
        if (!entry || isEffectivelySuppressed(entry)) continue;
        const hay = entrySearchText(entry);
        const title = normalizeText(entry.title);
        let lexicalScore = 0;
        const matchedTerms = [];
        for (const term of terms) {
            if (!term || term.length < 3) continue;
            let termScore = 0;
            if (title && (title === term || title.includes(term) || term.includes(title))) termScore = 0.95;
            else if (hay.includes(term)) termScore = term.includes(" ") ? 0.82 : 0.62;
            if (termScore > 0) {
                lexicalScore = Math.max(lexicalScore, termScore);
                if (!matchedTerms.includes(term)) matchedTerms.push(term);
            }
        }
        if (lexicalScore <= 0) continue;
        const existing = byId.get(entry.id);
        if (existing) {
            existing.lexicalScore = Math.max(Number(existing.lexicalScore) || 0, lexicalScore);
            existing.lexicalTerms = [...new Set([...(existing.lexicalTerms || []), ...matchedTerms])].slice(0, 6);
            existing.score = Math.max(existing.score || 0, lexicalScore);
        } else {
            byId.set(entry.id, {
                entry,
                score: lexicalScore,
                vectorScore: null,
                lexicalScore,
                lexicalTerms: matchedTerms.slice(0, 6),
            });
            added++;
        }
    }
    if (added > 0) dlog(`Retriever: added ${added} lexical fallback hit(s)`);
    return [...byId.values()];
}

/**
 * Classify an entry into one of the injection-cap categories:
 * "character" | "world" | "plot" | "custom". Folder-driven (matches the
 * consolidation menu logic): resolve the entry's owning folder, walk to its
 * root, and bucket by the root folder's TYPE. Anything not a default root is
 * "custom". Falls back to the entry.category field when there's no folder.
 */
function categoryOfEntry(e) {
    try {
        const folders = getFolders() || [];
        const f = folders.find(ff => ff.id === e.folderId);
        if (f) {
            let root = f, guard = 0;
            while (root && root.parentId && guard++ < 10) root = folders.find(ff => ff.id === root.parentId) || root;
            const t = root.type;
            if (t === "world") return "world";
            if (t === "plot") return "plot";
            if (t === "characters") return "character";
            return "custom";
        }
    } catch (err) { /* fall through to category field */ }
    if (e.category === "world") return "world";
    if (e.category === "plot") return "plot";
    return "character";
}

function mapHashesToEntries(results) {
    const candidates = [];
    const entries = getEntries();
    for (let i = 0; i < results.hashes.length; i++) {
        const hash = results.hashes[i];
        const score = Number(results.metadata[i]?.score) || 0;
        const entry = Object.values(entries).find(e => e.vectorHash === hash);
        if (entry) {
            candidates.push({
                entry,
                score,
                vectorScore: score,
                lexicalScore: null,
                lexicalTerms: [],
            });
        }
    }
    return candidates;
}


function applyFilters(candidates, recordById = new Map(), options = {}) {
    const stickyMap = getStickinessMap();
    const cooldownMap = getCooldownsMap();
    const decaySettings = getSetting("decay", {});
    const decayEnabled = decaySettings.enabled === true;
    const configuredThreshold = Number(getSetting("vectorization.similarityThreshold", 0.75));
    const threshold = Number.isFinite(Number(options.thresholdOverride))
        ? Number(options.thresholdOverride)
        : configuredThreshold;
    const priorityBoost = options.priorityBoost !== false;
    const filtered = [];

    for (const candidate of candidates) {
        const { entry } = candidate;
        const score = Number(candidate.score) || 0;
        const record = recordById.get(entry.id);
        if (record) record.initialScore = score;

        const stickyRemaining = Number(stickyMap[entry.id]) || 0;
        const cooldownRemaining = Number(cooldownMap[entry.id]) || 0;
        if (record) {
            record.stickyRemaining = stickyRemaining;
            record.cooldownRemaining = cooldownRemaining;
        }

        if (isEffectivelySuppressed(entry)) {
            if (record) {
                record.decision = "Filtered";
                record.flags.push("suppressed");
                record.reason = "Memory has an effective suppression reason and is excluded from ordinary retrieval.";
            }
            continue;
        }

        if (stickyRemaining > 0) {
            const adjustedScore = Math.max(score, 0.9);
            if (record) {
                record.adjustedScore = adjustedScore;
                record.flags.push("sticky");
                record.decision = "Eligible";
                record.reason = `Stickiness is active for ${stickyRemaining} more message${stickyRemaining === 1 ? "" : "s"}; similarity was raised to at least 0.900.`;
            }
            filtered.push({ ...candidate, score: adjustedScore, sticky: true });
            continue;
        }

        if (cooldownRemaining > 0) {
            if (record) {
                record.decision = "Filtered";
                record.reason = `Cooldown is active for ${cooldownRemaining} more message${cooldownRemaining === 1 ? "" : "s"}.`;
            }
            continue;
        }

        if (entry.status === "pinned") {
            const adjustedScore = priorityBoost ? 1.0 : score;
            if (record) {
                record.adjustedScore = adjustedScore;
                record.flags.push("pinned");
                record.decision = "Eligible";
                record.reason = priorityBoost
                    ? "Pinned memory; priority was raised to 1.000."
                    : "Pinned chain candidate retained its query-relative score.";
            }
            filtered.push({ ...candidate, score: adjustedScore });
            continue;
        }

        // Effective suppression was already checked above. Consolidation itself is
        // not suppression; important/core sources retain their normal boost.
        if (entry.important && entry.status !== "consolidated") {
            const adjustedScore = priorityBoost ? Math.max(score, 0.95) : score;
            if (record) {
                record.adjustedScore = adjustedScore;
                record.flags.push("important");
                record.decision = "Eligible";
                record.reason = priorityBoost
                    ? "Active starred/important memory; priority was raised to at least 0.950."
                    : "Starred chain candidate retained its query-relative score.";
            }
            filtered.push({ ...candidate, score: adjustedScore });
            continue;
        }

        let adjustedScore = score;
        const reasons = [];
        if (decayEnabled && entry.status !== "pinned") {
            const decay = calculateDecay(entry, score, decaySettings);
            adjustedScore = decay.adjustedScore;
            if (decay.applied) {
                if (record) record.flags.push("decayed");
                reasons.push(`decay ×${decay.factor.toFixed(3)} after ${decay.ageDays} day${decay.ageDays === 1 ? "" : "s"}`);
            }
        }

        // Consolidated source memories remain recallable. First decide whether
        // the memory is relevant enough to be eligible; only then reduce its
        // ranking priority. Applying the default 0.5 multiplier before the 0.75
        // similarity threshold would make consolidated memories mathematically
        // incapable of passing, which would be suppression by another name.
        const eligibilityScore = adjustedScore;
        let rankingScore = adjustedScore;
        if (entry.status === "consolidated") {
            const rawMultiplier = Number(getSetting("vectorization.consolidatedPriorityMultiplier", 0.5));
            const multiplier = Number.isFinite(rawMultiplier) ? Math.max(0.1, Math.min(1, rawMultiplier)) : 0.5;
            rankingScore *= multiplier;
            if (record) record.flags.push("consolidated-priority");
            reasons.push(`consolidated priority ×${multiplier.toFixed(2)}`);
        }

        if (record) record.adjustedScore = rankingScore;
        if (eligibilityScore >= threshold) {
            if (record) {
                record.decision = "Eligible";
                record.reason = reasons.length
                    ? `Passed threshold ${threshold.toFixed(3)}; ranking adjusted by ${reasons.join(" and ")}.`
                    : `Passed similarity threshold ${threshold.toFixed(3)}.`;
            }
            filtered.push({ ...candidate, score: rankingScore });
        } else if (record) {
            record.decision = "Filtered";
            record.reason = `${reasons.length ? `${reasons.join("; ")}; ` : ""}adjusted score ${adjustedScore.toFixed(3)} fell below threshold ${threshold.toFixed(3)}.`;
        }
    }

    filtered.sort((a, b) => b.score - a.score);
    return filtered;
}

function querySimilarity(queryText, entry) {
    const query = new Set(normalizeText(queryText).split(" ").filter(word => word.length >= 3));
    const memory = new Set(entrySearchText(entry).split(" ").filter(word => word.length >= 3));
    if (!query.size || !memory.size) return 0;
    let overlap = 0;
    for (const token of query) if (memory.has(token)) overlap++;
    if (!overlap) return 0;
    // Query coverage is a better document-relevance signal than raw cosine for
    // rich episodic prose: a long memory should not be punished merely for
    // containing more detail. A lone overlap in a broad query remains weak.
    const coverage = overlap / query.size;
    const cosine = overlap / Math.sqrt(query.size * memory.size);
    const loneBroadMatchPenalty = overlap === 1 && query.size >= 4 ? 0.6 : 1;
    return ((coverage * 0.8) + (cosine * 0.2)) * loneBroadMatchPenalty;
}

function chainNeighbourIds(seed, chain) {
    const ordered = getOrderedChainEntries(chain);
    const index = ordered.findIndex(entry => entry.id === seed.id);
    if (index < 0) return [];
    const ids = [];
    if (index > 0) ids.push(ordered[index - 1].id); // causal predecessor
    if (ordered.length > 1) ids.push(ordered[ordered.length - 1].id); // current state
    const turning = ordered.findLast(entry => entry.important || /(reversal|resolution|turning|recontext)/i.test([...(entry.tags || []), ...(entry.delta?.delta_type || [])].join(" ")));
    if (turning) ids.push(turning.id);
    return [...new Set(ids)].filter(id => id !== seed.id);
}

/** One-hop, locally scored expansion. Newly added candidates are never seeds. */
export function expandChainCandidates(initialCandidates, queryText, recordById = new Map(), debugInfo = null) {
    const cfg = getSetting("vectorization.chainExpansion", {}) || {};
    const enabled = cfg.enabled !== false;
    const maxAdditions = Math.min(2, Math.max(0, Number(cfg.maxAdditions ?? 2) || 0));
    const poolLimit = Math.max(maxAdditions, Math.min(12, Number(cfg.candidatePool ?? 6) || 6));
    const minimumSemantic = Math.max(0, Math.min(1, Number(cfg.minimumSemanticScore ?? 0.15)));
    const relationshipBonus = Math.max(0, Math.min(0.25, Number(cfg.relationshipBonus ?? 0.08)));
    const chronologyBonus = Math.max(0, Math.min(0.15, Number(cfg.chronologyBonus ?? 0.04)));
    if (debugInfo) Object.assign(debugInfo, { enabled, seeds: initialCandidates.length, considered: 0, added: 0, maxAdditions });
    if (!enabled || maxAdditions === 0 || !initialCandidates.length) return initialCandidates;

    const directIds = new Set(initialCandidates.map(item => item.entry?.id).filter(Boolean));
    const expanded = new Map();
    for (const seedCandidate of initialCandidates) {
        const seed = seedCandidate.entry;
        for (const chainId of (seed?.chainIds || [])) {
            const chain = getChain(chainId);
            if (!chain || !entryBelongsToChainCharacter(seed, chain)) continue;
            const ordered = getOrderedChainEntries(chain);
            const latestId = ordered.at(-1)?.id;
            for (const memoryId of chainNeighbourIds(seed, chain)) {
                if (directIds.has(memoryId)) continue;
                const entry = getEntry(memoryId);
                if (!entry || isEffectivelySuppressed(entry) || !entryBelongsToChainCharacter(entry, chain)) continue;
                if (debugInfo) debugInfo.considered++;
                const semanticScore = querySimilarity(queryText, entry);
                if (semanticScore < minimumSemantic) continue;
                const score = Math.min(1, semanticScore + relationshipBonus + (memoryId === latestId ? chronologyBonus : 0));
                const current = expanded.get(memoryId);
                if (!current || score > current.score) expanded.set(memoryId, {
                    entry, score, vectorScore: null, lexicalScore: semanticScore,
                    lexicalTerms: [], chainExpanded: true, chainSeedId: seed.id, chainId,
                });
            }
        }
    }
    const proposed = [...expanded.values()].sort((a, b) => b.score - a.score).slice(0, poolLimit);
    // Semantic eligibility was already enforced above. Reuse the ordinary
    // status/cooldown/decay checks, but do not compare this local relevance
    // score to the embedding backend's differently-scaled global threshold.
    const eligible = applyFilters(proposed, recordById, { thresholdOverride: 0, priorityBoost: false }).slice(0, maxAdditions);
    for (const candidate of eligible) {
        const record = recordById.get(candidate.entry.id);
        if (record) record.flags.push("chain-expanded");
    }
    if (debugInfo) debugInfo.added = eligible.length;
    return [...initialCandidates, ...eligible].sort((a, b) => b.score - a.score);
}

function calculateDecay(entry, score, settings) {
    const ageMs = Date.now() - entry.createdAt;
    // Age proxy in DAYS. Scene count isn't tracked per-entry, so age-since-
    // creation in days is the stable proxy used by the existing decay setting.
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const decayStart = Number(settings.decayStart) || 5;
    if (ageDays < decayStart) {
        return { adjustedScore: score, factor: 1, ageDays, applied: false };
    }
    const minPriority = Number(settings.minimumPriority) || 0.3;
    const mode = settings.mode || "linear";
    const effectiveAge = ageDays - decayStart;
    let factor;
    switch (mode) {
        case "exponential": factor = Math.exp(-0.1 * effectiveAge); break;
        case "step": factor = effectiveAge < 10 ? 1.0 : effectiveAge < 20 ? 0.7 : 0.4; break;
        default: factor = Math.max(0, 1.0 - effectiveAge * 0.05); break;
    }
    factor = Math.max(minPriority, factor);
    return { adjustedScore: score * factor, factor, ageDays, applied: factor < 1 };
}


export function recordInjection(entryId, stickiness = 0) {
    if ((getCooldownsMap()[entryId] || 0) > 0) return;
    const effective = stickiness > 0 ? stickiness : getSetting("vectorization.defaultStickiness", 0);
    if (effective <= 0) {
        startCooldown(entryId, getEntry(entryId)?.cooldown || 0);
        return;
    }
    const map = getStickinessMap();
    // Lorebook-style stickiness: set the counter ONCE, when an entry first
    // injects. If it's already in the sticky map it's mid-countdown — do NOT
    // reset it, or it would be force-injected forever (re-recorded every message
    // because it's sticky, never expiring, never reaching cooldown). Leaving it
    // untouched lets tickCounters() count it down to 0 and hand it to cooldown.
    if (map[entryId] && map[entryId] > 0) return;
    map[entryId] = effective;
    saveStickinessMap(map);
}

export function startCooldown(entryId, cooldown = 0) {
    const effective = cooldown > 0 ? cooldown : getSetting("vectorization.defaultCooldown", 0);
    if (effective <= 0) return;
    const map = getCooldownsMap();
    map[entryId] = effective;
    saveCooldownsMap(map);
}

export function tickCounters() {
    const stickyMap = getStickinessMap();
    const cooldownMap = getCooldownsMap();
    let stickyChanged = false, cooldownChanged = false;
    for (const id of Object.keys(cooldownMap)) {
        cooldownMap[id]--;
        if (cooldownMap[id] <= 0) delete cooldownMap[id];
        cooldownChanged = true;
    }
    for (const id of Object.keys(stickyMap)) {
        stickyMap[id]--;
        if (stickyMap[id] <= 0) {
            const entry = getEntry(id);
            const cd = entry?.cooldown || getSetting("vectorization.defaultCooldown", 0);
            if (cd > 0) { cooldownMap[id] = cd; cooldownChanged = true; }
            delete stickyMap[id];
        }
        stickyChanged = true;
    }
    if (stickyChanged) saveStickinessMap(stickyMap);
    if (cooldownChanged) saveCooldownsMap(cooldownMap);
}
