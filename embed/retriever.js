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

import { getRequestHeaders } from "../../../../../script.js";
import { textgen_types, textgenerationwebui_settings } from "../../../../textgen-settings.js";
import { getSetting } from "../settings.js";
import { getEntry } from "../data/entries.js";
import { getEntries, getStickinessMap, saveStickinessMap, getCooldownsMap, saveCooldownsMap } from "../data/storage.js";
import { getCollectionId } from "./embedder.js";
import { dlog } from "../lib/debug.js";


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
    if (!queryText) return [];

    const mlSettings = buildVectorSettings();

    const threshold = getSetting("vectorization.similarityThreshold", 0.75);
    const maxEntries = getSetting("injection.maxEntriesPerMessage", 3);
    const topK = getSetting("vectorization.raw.topK", 10);

    dlog(`Retriever query: "${queryText}" (collection ${collectionId}, topK ${topK}, threshold ${threshold})`);
    const rawResults = await queryCollection(collectionId, queryText, topK, threshold, mlSettings);
    if (!rawResults || !rawResults.hashes || rawResults.hashes.length === 0) { dlog("Retriever: no vector hits above threshold"); return []; }
    dlog(`Retriever: ${rawResults.hashes.length} raw vector hit(s)`);

    const candidates = mapHashesToEntries(rawResults);
    const filtered = applyFilters(candidates);
    const final = filtered.slice(0, maxEntries);

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
    // keywords already contains themes + events (sidecar folds them together);
    // appending themes again double-weighted them in the similarity query
    const parts = [];
    if (sidecarResult.keywords?.length) parts.push(sidecarResult.keywords.join(" "));
    if (sidecarResult.characters?.length) parts.push(sidecarResult.characters.join(" "));
    return parts.join(" ").trim();
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
