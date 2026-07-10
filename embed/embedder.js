/**
 * embed/embedder.js — Memory entry embedding via ST's vector API
 *
 * Uses ST's native vector API (/api/vector/insert, /api/vector/delete)
 * to embed and store memory entries.
 *
 * getVectorsRequestBody() mirrors VectFox's core-vector-api.js exactly —
 * including URL resolution via textgenerationwebui_settings.server_urls
 * for local providers (Ollama, vLLM) so the correct endpoint is always sent.
 *
 * Collection ID: ml_memory_{chatUUID} — one collection per chat.
 */

import { getRequestHeaders, chat_metadata } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
import { textgen_types, textgenerationwebui_settings } from "../../../../textgen-settings.js";
import { getSetting } from "../settings.js";
import { getEntries } from "../data/storage.js";
import { setEntryVectorHash } from "../data/entries.js";

// ─── Collection ID ────────────────────────────────────────

/**
 * Get the vector collection ID for the current chat.
 * @returns {string|null}
 */
export function getCollectionId() {
    // Per-chat separation is guaranteed two ways:
    //   1. chat_metadata.integrity — a UUID ST stamps into each chat's metadata
    //   2. fallback: the chat's own ID (filename), sanitized — for chats that
    //      predate the integrity field
    // Either way, every chat maps to a DIFFERENT collection (its own folder under
    // data/<user>/vectors/<source>/) — memories from different chats never mix.
    const uuid = chat_metadata?.integrity;
    if (uuid) return `ml_memory_${uuid}`;
    const chatId = getContext()?.chatId;
    if (chatId) {
        const safe = String(chatId).replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80);
        return `ml_memory_${safe}`;
    }
    console.warn("[ML] Embedder: no chat integrity UUID or chatId available — cannot build collection ID");
    return null;
}

// ─── Embedding text builder ───────────────────────────────

/**
 * Build the text to embed for a memory entry.
 * Combines the most searchable fields into a single string.
 * @param {object} entry
 * @returns {string}
 */
export function getEmbeddingText(entry) {
    const parts = [];
    if (entry.title)                   parts.push(entry.title);
    if (entry.datetime)                parts.push(entry.datetime);
    if (entry.content)                 parts.push(entry.content);
    if (entry.primaryCharacter)        parts.push(`Primary: ${entry.primaryCharacter}`);
    if (entry.primaryCharacters?.length) parts.push(`Primaries: ${entry.primaryCharacters.join(", ")}`);
    if (entry.keyCharacters?.length)   parts.push(`Key: ${entry.keyCharacters.join(", ")}`);

    // Descriptive tags are intentionally embedded too. They act as compact
    // semantic labels that help vector recall connect indirect scene language
    // to stored memories (e.g. "abandonment_fear", "hidden_injury").
    const tags = Array.isArray(entry.tags)
        ? entry.tags.map(t => String(t || "").trim()).filter(Boolean)
        : [];
    if (tags.length) parts.push(`Tags: ${tags.join(", ")}`);

    return parts.join("\n");
}

// ─── Hash ─────────────────────────────────────────────────

/**
 * djb2 hash — matches ST's getStringHash behavior.
 * @param {string} text
 * @returns {number}
 */
function hashText(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash) + text.charCodeAt(i);
        hash = hash & hash;
    }
    return Math.abs(hash);
}

// ─── Request body builder — mirrors VectFox exactly ───────

/**
 * Build provider-specific parameters for vector API requests.
 * Mirrors VectFox's getVectorsRequestBody() in core-vector-api.js exactly,
 * including URL resolution via textgenerationwebui_settings.server_urls.
 *
 * @param {object} settings - { source, ollama_model, vllm_model, openrouter_model,
 *                              ollama_use_alt_endpoint, ollama_alt_endpoint_url,
 *                              vllm_use_alt_endpoint, vllm_alt_endpoint_url }
 * @returns {object}
 */
function getVectorsRequestBody(settings) {
    const body = {};
    switch (settings.source) {
        case 'openrouter':
            body.model = settings.openrouter_model;
            break;
        case 'ollama':
            body.model = settings.ollama_model;
            // URL resolution chain: alt endpoint (if enabled AND filled) → alt endpoint
            // (if filled, even when the toggle is off) → ST's stored Ollama text-gen URL
            // → Ollama's standard local address. The old code returned undefined when
            // the user doesn't use Ollama as their ST text-gen backend (server_urls
            // empty), which made ST's server throw TypeError: Invalid URL (500).
            body.apiUrl = (settings.ollama_use_alt_endpoint && settings.ollama_alt_endpoint_url)
                ? settings.ollama_alt_endpoint_url
                : (textgenerationwebui_settings?.server_urls?.[textgen_types.OLLAMA]
                    || settings.ollama_alt_endpoint_url
                    || 'http://localhost:11434');
            body.keep = !!settings.ollama_keep;
            break;
        case 'vllm':
            body.apiUrl = (settings.vllm_use_alt_endpoint
                ? settings.vllm_alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.VLLM])
                ?.replace(/\/$/, '')
                .replace(/\/v1\/embeddings$/, '')
                .replace(/\/embeddings$/, '');
            body.model = settings.vllm_model;
            break;
        case 'openai':
            body.model = settings.openai_model;
            break;
        case 'cohere':
            body.model = settings.cohere_model;
            break;
        case 'palm':
            body.model = settings.google_model;
            break;
        case 'mistral':
            body.model = settings.mistral_model;
            break;
        default:
            // transformers and others — no extra body fields needed
            break;
    }
    return body;
}

// ─── Settings helper ──────────────────────────────────────

/**
 * Resolve embedding settings from ML's settings store into the shape
 * that getVectorsRequestBody() and the vector API endpoints expect.
 * @returns {object}
 */
function getEmbeddingSettings() {
    return {
        source:                   getSetting("embedding.source", "transformers"),
        ollama_model:             getSetting("embedding.ollama_model", ""),
        ollama_use_alt_endpoint:  getSetting("embedding.ollama_use_alt_endpoint", false),
        ollama_alt_endpoint_url:  getSetting("embedding.ollama_alt_endpoint_url", ""),
        ollama_keep:              getSetting("embedding.ollama_keep", false),
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

// ─── Public API ───────────────────────────────────────────

/**
 * Embed a single memory entry into the vector collection.
 * @param {object} entry
 * @returns {Promise<boolean>}
 */
export async function embedEntry(entry) {
    const collectionId = getCollectionId();
    if (!collectionId) return false;

    const text = getEmbeddingText(entry);
    if (!text || text.trim().length < 3) {
        console.warn(`[ML] Embedder: entry ${entry.id} has no embeddable text — skipping`);
        return false;
    }
    const hash = hashText(text);
    const settings = getEmbeddingSettings();

    try {
        const body = {
            ...getVectorsRequestBody(settings),
            collectionId,
            items: [{ hash, text }],
            source: settings.source,
        };

        const response = await fetch('/api/vector/insert', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            console.warn(`[ML] Embedder: insert failed for entry ${entry.id} — ${response.status}`);
            return false;
        }

        setEntryVectorHash(entry.id, hash);
        console.log(`[ML] Embedder: entry ${entry.id} embedded into collection "${collectionId}" (hash: ${hash})`);
        return true;
    } catch (err) {
        console.error(`[ML] Embedder: insert error for entry ${entry.id}:`, err);
        return false;
    }
}

/**
 * Delete an entry's vector from the collection.
 * @param {object} entry
 * @returns {Promise<boolean>}
 */
export async function deleteEntryVector(entry) {
    const collectionId = getCollectionId();
    if (!collectionId || !entry.vectorHash) return false;

    const settings = getEmbeddingSettings();

    try {
        const body = {
            ...getVectorsRequestBody(settings),
            collectionId,
            hashes: [entry.vectorHash],
            source: settings.source,
        };

        const response = await fetch('/api/vector/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            console.warn(`[ML] Embedder: delete failed for entry ${entry.id} — ${response.status}`);
            return false;
        }

        console.log(`[ML] Embedder: vector deleted for entry ${entry.id}`);
        return true;
    } catch (err) {
        console.error(`[ML] Embedder: delete error for entry ${entry.id}:`, err);
        return false;
    }
}

/**
 * Re-embed an entry after editing.
 * Deletes the old vector first, then inserts the new one.
 * @param {object} entry
 * @returns {Promise<boolean>}
 */
export async function reEmbedEntry(entry) {
    if (entry.vectorHash) {
        await deleteEntryVector(entry);
    }
    return embedEntry(entry);
}

/**
 * Embed all entries that don't have a vectorHash yet.
 * Used after import or batch operations.
 * @param {Function} [onProgress] - (done, total) callback
 * @returns {Promise<number>} Number of entries embedded
 */
export async function embedAllPending(onProgress = null) {
    const entries = getEntries();
    const pending = Object.values(entries).filter(e => !e.vectorHash);
    if (pending.length === 0) return 0;

    const batchSize = getSetting("embedding.insertBatchSize", 10);
    let embedded = 0;

    for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        for (const entry of batch) {
            const ok = await embedEntry(entry);
            if (ok) embedded++;
        }
        if (onProgress) onProgress(Math.min(i + batchSize, pending.length), pending.length);
    }

    console.log(`[ML] Embedder: embedded ${embedded}/${pending.length} pending entries`);
    return embedded;
}
