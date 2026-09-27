import { captureChatGuard } from "../lib/chatGuard.js";
/**
 * embed/embedder.js — Memory entry embedding via ST's vector API
 *
 * Uses ST's native vector API (/api/vector/insert, /api/vector/delete)
 * to embed and store memory entries.
 *
 * Provider request preparation mirrors SillyTavern's core Vector Storage extension,
 * including URL resolution via textgenerationwebui_settings.server_urls and
 * KoboldCpp's required pre-embedding handshake through /api/backends/kobold/embed.
 *
 * Collection ID: ml_memory_{chatUUID} — one collection per chat.
 */

import { getRequestHeaders, chat_metadata } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
import { textgen_types, textgenerationwebui_settings } from "../../../../textgen-settings.js";
import { getSetting } from "../settings.js";
import { getEntries } from "../data/storage.js";
import { setEntryVectorHash } from "../data/entries.js";

export const VECTOR_REQUEST_TIMEOUT_MS = 20000;

async function vectorFetch(url, options = {}) {
    let timer;
    const Controller = globalThis.AbortController;
    const controller = typeof Controller === "function" ? new Controller() : null;
    const request = fetch(url, controller ? { ...options, signal: controller.signal } : options);
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller?.abort();
            reject(new Error(`Vector request timed out after ${VECTOR_REQUEST_TIMEOUT_MS}ms`));
        }, VECTOR_REQUEST_TIMEOUT_MS);
    });
    try {
        return await Promise.race([request, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

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
 * @param {object} settings - provider settings resolved from Memory Loom.
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
            // transformers, KoboldCpp, and others — no synchronous fields.
            // KoboldCpp's model + vectors are prepared asynchronously below.
            break;
    }
    return body;
}

/**
 * Resolve the KoboldCpp server exactly the way SillyTavern's Vector Storage
 * extension does: explicit Memory Loom alt endpoint when enabled, otherwise
 * the URL configured for ST's KoboldCpp Text Completion backend.
 * @param {object} settings
 * @returns {string}
 */
export function getKoboldCppServer(settings) {
    const server = settings.koboldcpp_use_alt_endpoint
        ? settings.koboldcpp_alt_endpoint_url
        : textgenerationwebui_settings?.server_urls?.[textgen_types.KOBOLDCPP];
    return String(server || '').trim();
}

/**
 * Ask SillyTavern's own KoboldCpp bridge to generate embeddings. This mirrors
 * public/scripts/extensions/vectors/index.js:createKoboldCppEmbeddings(), so
 * auth/additional headers and KoboldCpp response normalization remain owned by ST.
 * @param {string[]} items
 * @param {object} settings
 * @returns {Promise<{embeddings: Record<string, number[]>, model: string}>}
 */
export async function createKoboldCppEmbeddings(items, settings) {
    const server = getKoboldCppServer(settings);
    if (!server) {
        throw new Error("KoboldCpp URL is not configured. Set it in ST Text Completion API settings or enable Memory Loom's alt endpoint.");
    }

    const response = await vectorFetch('/api/backends/kobold/embed', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ items, server }),
    });
    if (!response.ok) throw new Error(`Failed to get KoboldCpp embeddings (${response.status})`);

    const data = await response.json();
    if (!Array.isArray(data?.embeddings) || !data?.model || data.embeddings.length !== items.length) {
        throw new Error('Invalid response from KoboldCpp embeddings');
    }

    const embeddings = {};
    for (let i = 0; i < data.embeddings.length; i++) {
        const vector = data.embeddings[i];
        if (!Array.isArray(vector) || vector.length === 0) {
            throw new Error('KoboldCpp returned an empty embedding. Reduce the embedded text size and try again.');
        }
        embeddings[items[i]] = vector;
    }
    return { embeddings, model: String(data.model) };
}

/**
 * Build all provider-specific fields needed by ST's /api/vector endpoints.
 * KoboldCpp is special: ST's vector backend expects the browser extension to
 * precompute vectors through /api/backends/kobold/embed and include both the
 * returned model name and an embeddings map in the vector request body.
 * @param {object} settings
 * @param {string[]} [items=[]]
 * @returns {Promise<object>}
 */
export async function prepareVectorRequestFields(settings, items = []) {
    const body = getVectorsRequestBody(settings);
    if (settings.source === 'koboldcpp') {
        const { embeddings, model } = await createKoboldCppEmbeddings(items, settings);
        body.embeddings = embeddings;
        body.model = model;
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

// ─── Public API ───────────────────────────────────────────

/**
 * Embed a single memory entry into the vector collection.
 * @param {object} entry
 * @returns {Promise<boolean>}
 */
export async function embedEntry(entry) {
    const assertChat = captureChatGuard();
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
            ...await prepareVectorRequestFields(settings, [text]),
            collectionId,
            items: [{ hash, text }],
            source: settings.source,
        };

        const response = await vectorFetch('/api/vector/insert', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            console.warn(`[ML] Embedder: insert failed for entry ${entry.id} — ${response.status}`);
            return false;
        }

        assertChat();
        const current = getEntries()[entry.id];
        if (!current || getEmbeddingText(current) !== text) return false;
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
            ...await prepareVectorRequestFields(settings, []),
            collectionId,
            hashes: [entry.vectorHash],
            source: settings.source,
        };

        const response = await vectorFetch('/api/vector/delete', {
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
    const assertChat = captureChatGuard();
    const oldHash = entry.vectorHash;
    // Insert the replacement first. Delete-then-insert could leave a memory
    // pointing at a vector that had already been deleted when the new request
    // failed.
    const inserted = await embedEntry(entry);
    if (!inserted) return false;
    assertChat();
    const current = getEntries()[entry.id];
    if (oldHash && current?.vectorHash && oldHash !== current.vectorHash) {
        await deleteEntryVector({ ...entry, vectorHash: oldHash });
    }
    return true;
}

/**
 * Embed all entries that don't have a vectorHash yet.
 * Used after import or batch operations.
 * @param {Function} [onProgress] - (done, total) callback
 * @returns {Promise<number>} Number of entries embedded
 */
export async function embedAllPending(onProgress = null) {
    const assertChat = captureChatGuard();
    const entries = getEntries();
    const pending = Object.values(entries).filter(e => !e.vectorHash);
    if (pending.length === 0) return 0;

    const batchSize = Math.max(1, Math.floor(Number(getSetting("embedding.insertBatchSize", 10))) || 10);
    let embedded = 0;

    for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        for (const entry of batch) {
            assertChat();
            const ok = await embedEntry(entry);
            if (ok) embedded++;
        }
        if (onProgress) onProgress(Math.min(i + batchSize, pending.length), pending.length);
    }

    console.log(`[ML] Embedder: embedded ${embedded}/${pending.length} pending entries`);
    return embedded;
}
