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
import { textgen_types, textgenerationwebui_settings } from "../../../../textgen-settings.js";
import { getSetting } from "../settings.js";
import { getEntry } from "../data/entries.js";
import { getEntries, getStickinessMap, saveStickinessMap, getCooldownsMap, saveCooldownsMap, getFolders } from "../data/storage.js";
import { getCollectionId } from "./embedder.js";
import { dlog } from "../lib/debug.js";
import { rerankCandidates } from "../llm/reranker.js";


/** Build the provider settings object used for vector queries — shared with the recall tool. */
export function buildVectorSettings() {
    return {
        source:                   getSetting("embedding.source", "transformers"),
        ollama_model:             getSetting("embedding.ollama_model", ""),
        ollama_use_alt_endpoint:  getSetting("embedding.ollama_use_alt_endpoint", false),
        ollama_alt_endpoint_url:  getSetting("embedding.ollama_alt_endpoint_url", ""),
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
    const collectionId = getCollectionId();
    if (!collectionId) return [];

    const queryText = buildQueryText(sidecarResult);
    if (!queryText) { dlog("Retriever skipped — empty query text"); return []; }

    const mlSettings = buildVectorSettings();

    const threshold = getSetting("vectorization.similarityThreshold", 0.75);
    const maxEntries = getSetting("injection.maxEntriesPerMessage", 3);
    const topK = getSetting("vectorization.raw.topK", 10);

    dlog(`Retriever query: "${queryText}" (collection ${collectionId}, topK ${topK}, threshold ${threshold})`);
    const rawResults = await queryCollection(collectionId, queryText, topK, threshold, mlSettings);

    // IMPORTANT: Passive recall must not die just because vector search returns
    // no hits above threshold. Direct event/title references like "Yūji's first
    // kill" should still be able to surface "The First Kill" through lexical
    // fallback. The previous version returned here, so the fallback was never
    // reached — exactly the failure seen in F12 logs.
    let candidates = [];
    if (!rawResults || !rawResults.hashes || rawResults.hashes.length === 0) {
        dlog("Retriever: no vector hits above threshold; trying lexical fallback");
    } else {
        dlog(`Retriever: ${rawResults.hashes.length} raw vector hit(s)`);
        candidates = mapHashesToEntries(rawResults);
    }

    candidates = addLexicalFallbacks(candidates, sidecarResult, queryText);
    if (!candidates.length) {
        dlog("Retriever: no vector or lexical candidates");
        return [];
    }

    let filtered = applyFilters(candidates);
    if (!filtered.length) {
        dlog(`Retriever: ${candidates.length} candidate(s) found but all were filtered by threshold/cooldown/status`);
        return [];
    }

    // Optional LLM rerank: after vector/lexical retrieval and normal filters,
    // before category/global caps choose the final injection set. Disabled by
    // default because it adds one extra LLM call only when there are more
    // candidates than injection slots. Uses the Keyword sidecar profile.
    filtered = await rerankCandidates(filtered, sidecarResult, queryText, maxEntries);

    // Per-category caps: limit how many of each category inject, then apply the
    // global cap as an overall ceiling. Filtered is score/rerank-sorted, so we
    // keep the highest-ranked entries within each category's allowance.
    const perCat = getSetting("injection.maxPerCategory", {}) || {};
    const catCounts = {};
    const catLimited = [];
    for (const c of filtered) {
        const cat = categoryOfEntry(c.entry);
        const limit = Number.isFinite(perCat[cat]) ? perCat[cat] : Infinity;
        const used = catCounts[cat] || 0;
        if (used < limit) { catLimited.push(c); catCounts[cat] = used + 1; }
    }
    const final = catLimited.slice(0, maxEntries);

    if (final.length > 0) {
        console.log(`[ML] Retriever: ${final.length} entries selected for injection`);
    }
    return final;
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

        // Resolve model and URL per provider — mirrors getVectorsRequestBody() in embedder.js
        switch (mlSettings.source) {
            case 'openrouter':
                body.model = mlSettings.openrouter_model;
                break;
            case 'ollama':
                body.model = mlSettings.ollama_model;
                // Same fallback chain as the embedder. Without it, queries 500'd
                // for anyone not using Ollama as their ST TEXT-GEN backend —
                // memories embedded fine but could never be retrieved.
                body.apiUrl = (mlSettings.ollama_use_alt_endpoint && mlSettings.ollama_alt_endpoint_url)
                    ? mlSettings.ollama_alt_endpoint_url
                    : (textgenerationwebui_settings?.server_urls?.[textgen_types.OLLAMA]
                        || mlSettings.ollama_alt_endpoint_url
                        || 'http://localhost:11434');
                break;
            case 'vllm':
                body.apiUrl = (mlSettings.vllm_use_alt_endpoint
                    ? mlSettings.vllm_alt_endpoint_url
                    : textgenerationwebui_settings.server_urls[textgen_types.VLLM])
                    ?.replace(/\/$/, '')
                    .replace(/\/v1\/embeddings$/, '')
                    .replace(/\/embeddings$/, '');
                body.model = mlSettings.vllm_model;
                break;
            case 'openai':
                body.model = mlSettings.openai_model;
                break;
            case 'cohere':
                body.model = mlSettings.cohere_model;
                break;
            case 'palm':
                body.model = mlSettings.google_model;
                break;
            case 'mistral':
                body.model = mlSettings.mistral_model;
                break;
            default:
                break;
        }

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
    const recent = chat.slice(-depth);
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
        .replace(/[^a-z0-9\s-]/g, " ")
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
        // Preserve useful title-like tails, e.g. "memory of janes first kill" → "first kill".
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
        if (!entry || entry.status === "archived" || entry.status === "superseded") continue;
        const hay = entrySearchText(entry);
        const title = normalizeText(entry.title);
        let lexicalScore = 0;
        for (const term of terms) {
            if (!term || term.length < 3) continue;
            if (title && (title === term || title.includes(term) || term.includes(title))) lexicalScore = Math.max(lexicalScore, 0.95);
            else if (hay.includes(term)) lexicalScore = Math.max(lexicalScore, term.includes(" ") ? 0.82 : 0.62);
        }
        if (lexicalScore <= 0) continue;
        const existing = byId.get(entry.id);
        if (existing) existing.score = Math.max(existing.score || 0, lexicalScore);
        else { byId.set(entry.id, { entry, score: lexicalScore }); added++; }
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
        const score = results.metadata[i]?.score || 0;
        const entry = Object.values(entries).find(e => e.vectorHash === hash);
        if (entry) candidates.push({ entry, score });
    }
    return candidates;
}

function applyFilters(candidates) {
    const stickyMap = getStickinessMap();
    const cooldownMap = getCooldownsMap();
    const decaySettings = getSetting("decay", {});
    const decayEnabled = decaySettings.enabled === true;
    const threshold = getSetting("vectorization.similarityThreshold", 0.75);
    const filtered = [];

    for (const { entry, score } of candidates) {
        const stickyRemaining = stickyMap[entry.id];
        if (stickyRemaining && stickyRemaining > 0) {
            filtered.push({ entry, score: Math.max(score, 0.9) });
            continue;
        }
        const cooldownRemaining = cooldownMap[entry.id];
        if (cooldownRemaining && cooldownRemaining > 0) continue;
        if (entry.status === "pinned") { filtered.push({ entry, score: 1.0 }); continue; }
        if (entry.status === "archived" || entry.status === "superseded") continue;

        // Core/important memories bypass decay AND consolidation suppression — the
        // user has flagged them as pivotal (e.g. childhood memories) and they
        // must not be pushed down the priority order over time.
        if (entry.important) {
            filtered.push({ entry, score: Math.max(score, 0.95) });
            continue;
        }
        let adjustedScore = score;
        if (decayEnabled && entry.status !== "pinned") {
            adjustedScore = applyDecay(entry, score, decaySettings);
        }
        // Consolidated source memories stay retrievable but at reduced priority —
        // the consolidation that replaced them carries the meaning now. They
        // still surface for the recall tool and for close keyword matches.
        if (entry.status === "consolidated") {
            const mult = Number(getSetting("vectorization.consolidatedPriorityMultiplier", 0.5));
            adjustedScore *= (Number.isFinite(mult) && mult > 0 ? mult : 0.5);
        }
        if (adjustedScore >= threshold) filtered.push({ entry, score: adjustedScore });
    }
    filtered.sort((a, b) => b.score - a.score);
    return filtered;
}

function applyDecay(entry, score, settings) {
    const ageMs = Date.now() - entry.createdAt;
    // Age proxy in DAYS (was mislabeled "scenes" but computed hours). Scene
    // count isn't tracked per-entry, so age-since-creation in days is the stable
    // proxy: decayStart and decay windows are interpreted in days.
    const ageScenes = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const decayStart = settings.decayStart || 5;
    if (ageScenes < decayStart) return score;
    const minPriority = settings.minimumPriority || 0.3;
    const mode = settings.mode || "linear";
    const effectiveAge = ageScenes - decayStart;
    let factor;
    switch (mode) {
        case "exponential": factor = Math.exp(-0.1 * effectiveAge); break;
        case "step": factor = effectiveAge < 10 ? 1.0 : effectiveAge < 20 ? 0.7 : 0.4; break;
        default: factor = Math.max(0, 1.0 - effectiveAge * 0.05); break;
    }
    return score * Math.max(minPriority, factor);
}

export function recordInjection(entryId, stickiness = 0) {
    const effective = stickiness > 0 ? stickiness : getSetting("vectorization.defaultStickiness", 0);
    if (effective <= 0) return;
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
    for (const id of Object.keys(cooldownMap)) {
        cooldownMap[id]--;
        if (cooldownMap[id] <= 0) delete cooldownMap[id];
        cooldownChanged = true;
    }
    if (stickyChanged) saveStickinessMap(stickyMap);
    if (cooldownChanged) saveCooldownsMap(cooldownMap);
}
