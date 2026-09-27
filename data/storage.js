/**
 * storage.js — ST storage API wrapper for Memory Loom
 *
 * All Memory Loom data is stored in two places:
 *   1. extension_settings.ml — Global settings (survives chat switches)
 *   2. chat_metadata.ml — Per-chat data (entries, folders, scenes, etc.)
 *
 * This file provides get/set wrappers that handle initialization of
 * the ml namespace in both storage locations, and debounced saves.
 *
 * Pattern: follows relationship-stat-tracker's data/storage.js exactly.
 */

import { chat_metadata, saveSettingsDebounced, saveChatDebounced, name1 } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
import { extension_settings } from "../../../../../scripts/extensions.js";

// ─── Constants ────────────────────────────────────────────

/** Extension namespace — used as key in extension_settings and chat_metadata */
const NAMESPACE = "ml";

/**
 * Guard wrapper — only persists to chat when a chat is actually open.
 * Calling saveChatDebounced() before a chat is loaded causes ST to throw
 * "saveChat called without chat_name". We check name1 (the active character
 * name) as the reliable signal — it's empty string when no chat is open.
 */
function saveChat() {
    if (getContext()?.chatId) {
        saveChatDebounced();
    }
}

// ─── Global Settings (extension_settings.ml) ──────────────

/**
 * Ensure the ml namespace exists in extension_settings.
 * Called automatically by every getter — callers never need to call this directly.
 */
function ensureSettingsNamespace() {
    if (!extension_settings[NAMESPACE]) {
        extension_settings[NAMESPACE] = {
            settings: getDefaultSettings(),
        };
    }
    if (!extension_settings[NAMESPACE].settings) {
        extension_settings[NAMESPACE].settings = getDefaultSettings();
    }
}

/**
 * Get all Memory Loom extension settings.
 * @returns {object} The full settings object
 */
export function getSettings() {
    ensureSettingsNamespace();
    return extension_settings[NAMESPACE].settings;
}

/**
 * Save a single setting value using dot-notation path.
 * Example: saveSetting("injection.placement", "above_card")
 *
 * @param {string} key - Dot-notation path (e.g. "connections.memoryWriterLLM")
 * @param {*} value - Value to save
 */
export function saveSetting(key, value) {
    ensureSettingsNamespace();
    const parts = key.split(".");
    let obj = extension_settings[NAMESPACE].settings;
    // Walk down the path, creating intermediate objects if needed
    for (let i = 0; i < parts.length - 1; i++) {
        if (obj[parts[i]] === undefined) obj[parts[i]] = {};
        obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
    saveSettingsDebounced();
}

/**
 * Replace all settings at once.
 * Used during initialization to merge defaults.
 * @param {object} newSettings
 */
export function saveAllSettings(newSettings) {
    ensureSettingsNamespace();
    extension_settings[NAMESPACE].settings = newSettings;
    saveSettingsDebounced();
}

/**
 * Persist extension settings to disk immediately.
 * Calls ST's debounced save — change is queued, not instant.
 */
export function persistSettings() {
    saveSettingsDebounced();
}

// ─── Per-Chat Data (chat_metadata.ml) ─────────────────────

/**
 * Ensure the ml namespace exists in chat_metadata.
 * Initialises all per-chat data structures if this is the first access
 * for the current chat.
 */
function ensureChatNamespace() {
    if (!chat_metadata[NAMESPACE]) {
        chat_metadata[NAMESPACE] = {
            entries: {},           // All committed memory entries, keyed by entry ID
            folders: [],           // All folders (top-level and subfolders)
            scenes: [],            // All scene records
            consolidations: {},    // All consolidation entries, keyed by consolidation ID
            chains: {},            // Developmental memory chains, keyed by chain ID
            pendingChainProposals: [], // Preview-only historical chain scan results
            chainBatches: [],      // Reversible applied proposal batches
            postBatchChainScans: [], // Batch scans waiting for their pending character memories to be resolved
            pendingEntries: null,  // Pending review entries from the memory writer (null = none)
            messageCounter: 0,     // Live narrative-message count at the last sidecar scan/baseline
            sidecarPauseCadence: null, // Frozen {liveCount, baseline} while the sidecar is paused
            lastSidecarRun: null,   // Latest diagnostic run summary (no prompt content)
            openSceneId: null,     // ID of the currently open scene (null = none open)
            stickiness: {},        // Tracks which entries are currently "sticky" { entryId: messagesRemaining }
            cooldowns: {},         // Tracks cooldown timers { entryId: messagesRemaining }
            worldScale: "",        // Per-chat free-text describing the world's scale/scope, read by the world writer to anchor world-EVENT detection altitude
        };
    }
}

/**
 * Get the full ml chat data object.
 * @returns {object}
 */
export function getChatData() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE];
}

/**
 * Persist chat data to disk.
 */
export function persistChatData() {
    saveChat();
}

/** Clear every per-chat Memory Loom collection while preserving global settings. */
export function clearCurrentChatData() {
    const data = getChatData();
    const removedEntries = Object.values(data.entries || {}).map(entry => structuredClone(entry));
    const clean = {
        entries: {}, folders: [], scenes: [], consolidations: {}, chains: {},
        pendingChainProposals: [], chainBatches: [], postBatchChainScans: [], pendingEntries: null,
        messageCounter: 0, sidecarPauseCadence: null, lastSidecarRun: null,
        openSceneId: null, stickiness: {}, cooldowns: {}, worldScale: "",
    };
    for (const key of Object.keys(data)) delete data[key];
    Object.assign(data, clean);
    saveChat();
    return removedEntries;
}

// ─── Entries (committed memory entries) ───────────────────

/**
 * Get all committed memory entries for this chat.
 * @returns {object} Map of entry ID → entry object
 */
export function getEntries() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].entries;
}

/**
 * Replace all entries at once.
 * @param {object} entries - Map of entry ID → entry object
 */
export function saveEntries(entries) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].entries = entries;
    saveChat();
}

// ─── World scale (per-chat setting context) ───────────────

/**
 * Get the per-chat world scale / setting description. Anchors how the world
 * writer judges what counts as a world EVENT (town-scale vs cosmic).
 * @returns {string}
 */
export function getWorldScale() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].worldScale || "";
}

/**
 * Save the per-chat world scale description.
 * @param {string} text
 */
export function saveWorldScale(text) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].worldScale = String(text || "");
    saveChat();
}

// ─── Folders ──────────────────────────────────────────────


/**
 * Get all folders for this chat.
 * @returns {Array} Array of folder objects
 */
export function getFolders() {
    ensureChatNamespace();
    if (!chat_metadata[NAMESPACE].folders) {
        chat_metadata[NAMESPACE].folders = [];
    }
    return chat_metadata[NAMESPACE].folders;
}

/**
 * Save the folders array.
 * @param {Array} folders
 */
export function saveFolders(folders) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].folders = folders;
    saveChat();
}

// ─── Scenes ───────────────────────────────────────────────

/**
 * Get all scene records for this chat.
 * @returns {Array} Array of scene objects
 */
export function getScenes() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].scenes;
}

/**
 * Save the scenes array.
 * @param {Array} scenes
 */
export function saveScenes(scenes) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].scenes = scenes;
    saveChat();
}

// ─── Consolidations ───────────────────────────────────────

/**
 * Get all consolidation entries for this chat.
 * @returns {object} Map of consolidation ID → consolidation object
 */
export function getConsolidations() {
    ensureChatNamespace();
    if (!chat_metadata[NAMESPACE].consolidations) {
        chat_metadata[NAMESPACE].consolidations = {};
    }
    return chat_metadata[NAMESPACE].consolidations;
}

/**
 * Save the consolidations map.
 * @param {object} consolidations
 */
export function saveConsolidations(consolidations) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].consolidations = consolidations;
    saveChat();
}

// ─── Memory chains ────────────────────────────────────────

export function getChains() {
    ensureChatNamespace();
    if (!chat_metadata[NAMESPACE].chains || Array.isArray(chat_metadata[NAMESPACE].chains)) {
        const raw = chat_metadata[NAMESPACE].chains || [];
        chat_metadata[NAMESPACE].chains = Object.fromEntries(raw.filter(item => item?.id).map(item => [item.id, item]));
    }
    return chat_metadata[NAMESPACE].chains;
}

export function saveChains(chains) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].chains = chains && typeof chains === "object" && !Array.isArray(chains) ? chains : {};
    saveChat();
}

export function getPendingChainProposals() {
    ensureChatNamespace();
    const value = chat_metadata[NAMESPACE].pendingChainProposals;
    return Array.isArray(value) ? value.filter(Boolean) : [];
}

export function savePendingChainProposals(proposals) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].pendingChainProposals = Array.isArray(proposals) ? proposals.filter(Boolean) : [];
    saveChat();
}

export function getChainBatches() {
    ensureChatNamespace();
    const value = chat_metadata[NAMESPACE].chainBatches;
    return Array.isArray(value) ? value.filter(Boolean) : [];
}

export function saveChainBatches(batches) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].chainBatches = Array.isArray(batches) ? batches.filter(Boolean) : [];
    saveChat();
}


export function getPostBatchChainScans() {
    ensureChatNamespace();
    const value = chat_metadata[NAMESPACE].postBatchChainScans;
    return Array.isArray(value) ? value.filter(Boolean) : [];
}

export function savePostBatchChainScans(scans) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].postBatchChainScans = Array.isArray(scans) ? scans.filter(Boolean) : [];
    saveChat();
}

export function queuePostBatchChainScan(scan) {
    if (!scan?.id) return false;
    const scans = getPostBatchChainScans();
    if (scans.some(item => item.id === scan.id)) return false;
    scans.push({
        id: String(scan.id),
        createdAt: Number(scan.createdAt || Date.now()),
        label: String(scan.label || "Batch scan"),
    });
    savePostBatchChainScans(scans.slice(-20));
    return true;
}

export function removePostBatchChainScan(scanId) {
    const scans = getPostBatchChainScans();
    const next = scans.filter(item => item.id !== scanId);
    if (next.length === scans.length) return false;
    savePostBatchChainScans(next);
    return true;
}

// ─── Pending Entries ──────────────────────────────────────

/**
 * Get pending review entries (shown on the Home tab).
 * @returns {object[]|null} Pending entries array or null
 */
export function getPendingEntries() {
    ensureChatNamespace();
    const pending = chat_metadata[NAMESPACE].pendingEntries;
    if (!pending) return null;
    // Older exports and early builds stored pending cards in an object map.
    // Canonicalize at the storage boundary so every runtime workflow (writer,
    // world writer, undo, and review UI) receives the same iterable shape.
    return (Array.isArray(pending) ? pending : Object.values(pending)).filter(Boolean);
}

/**
 * Save pending review entries.
 * @param {object[]|Record<string, object>|null} pending
 */
export function savePendingEntries(pending) {
    ensureChatNamespace();
    if (!pending) {
        chat_metadata[NAMESPACE].pendingEntries = null;
    } else {
        const list = (Array.isArray(pending) ? pending : Object.values(pending)).filter(Boolean);
        chat_metadata[NAMESPACE].pendingEntries = list.length ? list : null;
    }
    saveChat();
}

// ─── Open Scene ───────────────────────────────────────────

/**
 * Get the ID of the currently open scene.
 * @returns {string|null}
 */
export function getOpenSceneId() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].openSceneId;
}

/**
 * Save the open scene ID.
 * @param {string|null} sceneId
 */
export function saveOpenSceneId(sceneId) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].openSceneId = sceneId;
    saveChat();
}

// ─── Message Counter (for scan frequency) ─────────────────

/**
 * Get the current message counter value.
 * @returns {number}
 */
export function getMessageCounter() {
    ensureChatNamespace();
    return typeof chat_metadata[NAMESPACE].messageCounter === "number" ? chat_metadata[NAMESPACE].messageCounter : 0;
}

/**
 * Set and save the message counter.
 *
 * Historically this value was an ever-incrementing sidecar trigger counter. It
 * is now treated as the live chat message count at the last sidecar scan/baseline.
 * Keeping the same field name preserves old chat metadata while allowing the
 * scheduler to recover when messages are deleted and SillyTavern renumbers the chat.
 *
 * @param {number} value
 * @returns {number} Saved counter value
 */
export function setMessageCounter(value) {
    ensureChatNamespace();
    const parsed = Number(value);
    const safeValue = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    chat_metadata[NAMESPACE].messageCounter = safeValue;
    saveChat();
    return chat_metadata[NAMESPACE].messageCounter;
}

/**
 * Increment the message counter and save.
 * Retained for compatibility with older internal callers/exports. New sidecar
 * scheduling should prefer setMessageCounter()/syncMessageCounterToLiveCount().
 * @returns {number} New counter value
 */
export function incrementMessageCounter() {
    ensureChatNamespace();
    const current = typeof chat_metadata[NAMESPACE].messageCounter === "number" ? chat_metadata[NAMESPACE].messageCounter : 0;
    chat_metadata[NAMESPACE].messageCounter = current + 1;
    saveChat();
    return chat_metadata[NAMESPACE].messageCounter;
}

/**
 * Clamp the sidecar message counter to the current live chat size.
 *
 * This prevents deleted messages from stranding the sidecar scheduler in the
 * future. Example: a chat grows to message 170, then OOC messages are deleted
 * and the visible/live chat returns to 143. The saved counter must not remain
 * at 170, or the sidecar will act like it has already processed messages that
 * no longer exist.
 *
 * @param {number} liveMessageCount Current chat.length / mesId + 1
 * @returns {{counter:number, previous:number, changed:boolean}}
 */
export function syncMessageCounterToLiveCount(liveMessageCount) {
    ensureChatNamespace();
    const parsed = Number(liveMessageCount);
    const live = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    const previous = typeof chat_metadata[NAMESPACE].messageCounter === "number"
        ? chat_metadata[NAMESPACE].messageCounter
        : 0;

    if (previous > live) {
        chat_metadata[NAMESPACE].messageCounter = live;
        saveChat();
        return { counter: live, previous, changed: true };
    }

    return { counter: previous, previous, changed: false };
}

/**
 * Get the persisted sidecar pause snapshot for this chat.
 * The snapshot stores the live narrative-message count and cadence baseline at
 * the instant pause began so resume can preserve exact progress.
 * @returns {{liveCount:number, baseline:number}|null}
 */
export function getSidecarPauseCadence() {
    ensureChatNamespace();
    const state = chat_metadata[NAMESPACE].sidecarPauseCadence;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;

    const liveCount = Number(state.liveCount);
    const baseline = Number(state.baseline);
    if (!Number.isFinite(liveCount) || !Number.isFinite(baseline)) return null;

    const safeLiveCount = Math.max(0, Math.floor(liveCount));
    const safeBaseline = Math.max(0, Math.min(Math.floor(baseline), safeLiveCount));
    return { liveCount: safeLiveCount, baseline: safeBaseline };
}

/**
 * Persist the exact cadence position at the moment of pause.
 * @param {number} liveMessageCount
 * @param {number} baseline
 * @returns {{liveCount:number, baseline:number}}
 */
export function saveSidecarPauseCadence(liveMessageCount, baseline) {
    ensureChatNamespace();
    const parsedLive = Number(liveMessageCount);
    const parsedBaseline = Number(baseline);
    const safeLiveCount = Number.isFinite(parsedLive) ? Math.max(0, Math.floor(parsedLive)) : 0;
    const safeBaseline = Number.isFinite(parsedBaseline)
        ? Math.max(0, Math.min(Math.floor(parsedBaseline), safeLiveCount))
        : 0;
    const state = { liveCount: safeLiveCount, baseline: safeBaseline };
    chat_metadata[NAMESPACE].sidecarPauseCadence = state;
    saveChat();
    return state;
}

/** Clear the persisted pause snapshot after cadence has been restored. */
export function clearSidecarPauseCadence() {
    ensureChatNamespace();
    if (chat_metadata[NAMESPACE].sidecarPauseCadence !== null) {
        chat_metadata[NAMESPACE].sidecarPauseCadence = null;
        saveChat();
    }
}

/**
 * Reset the message counter to zero.
 * Called when the user changes scan frequency or on chat switch.
 */
export function resetMessageCounter() {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].messageCounter = 0;
    chat_metadata[NAMESPACE].sidecarPauseCadence = null;
    saveChat();
}

// ─── Stickiness & Cooldown Tracking ───────────────────────

/**
 * Get the stickiness tracking map.
 * Maps entryId → messages remaining before stickiness expires.
 * @returns {object}
 */
export function getStickinessMap() {
    ensureChatNamespace();
    if (!chat_metadata[NAMESPACE].stickiness) {
        chat_metadata[NAMESPACE].stickiness = {};
    }
    return chat_metadata[NAMESPACE].stickiness;
}

/**
 * Save the stickiness tracking map.
 * @param {object} map
 */
export function saveStickinessMap(map) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].stickiness = map;
    saveChat();
}

/**
 * Get the cooldown tracking map.
 * Maps entryId → messages remaining before entry can fire again.
 * @returns {object}
 */
export function getCooldownsMap() {
    ensureChatNamespace();
    if (!chat_metadata[NAMESPACE].cooldowns) {
        chat_metadata[NAMESPACE].cooldowns = {};
    }
    return chat_metadata[NAMESPACE].cooldowns;
}

/**
 * Save the cooldown tracking map.
 * @param {object} map
 */
export function saveCooldownsMap(map) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].cooldowns = map;
    saveChat();
}

// ─── Default Settings ─────────────────────────────────────

/**
 * Returns the complete default settings object.
 * This is the single source of truth for all Memory Loom settings.
 * Any new setting fields should be added here so initSettings()
 * can merge them into existing user settings automatically.
 *
 * @returns {object}
 */
export function getDefaultSettings() {
    return {
        // ── Master enable/disable ─────────────────────────
        enabled: true,

        // ── LLM Connection Profiles ───────────────────────
        // These are profile names from ST's connection manager,
        // NOT API keys. The user selects which of their existing
        // ST connection profiles to use for each ML role.
        connections: {
            memoryWriterLLM: "",       // Generates both character/episodic and setting/world memories
            sceneSummaryLLM: "",       // Optional separate scene-summary profile
            consolidationLLM: "",      // Generates arc/sub-arc consolidation summaries
            sidecarLLM: "",            // Extracts themes from context every N messages
            writerMaxResponseTokens: 25000, // Shared character + world writer output budget
            maxResponseTokens: 8000,    // General summary/helper output budget
            noThink: false,             // Legacy blanket fallback
            noThinkHard: false,         // Legacy blanket hard fallback
            noThinkProfiles: {},        // Per-profile soft suppression, keyed by UUID
            noThinkHardProfiles: {},    // Per-profile hard suppression, keyed by UUID
        },

        // ── Embedding Settings ────────────────────────────
        // Field names mirror VectFox/ST vector API exactly so getVectorsRequestBody()
        // works without translation. Do NOT rename these fields.
        embedding: {
            source: "transformers",         // Provider: transformers, koboldcpp, ollama, vllm, openai, cohere, palm, openrouter, mistral
            // Ollama
            ollama_model: "",
            ollama_use_alt_endpoint: false,
            ollama_alt_endpoint_url: "",
            ollama_keep: false,
            // KoboldCpp — uses ST's configured Text Completion URL unless alt endpoint is enabled
            koboldcpp_use_alt_endpoint: false,
            koboldcpp_alt_endpoint_url: "",
            // vLLM
            vllm_model: "",
            vllm_use_alt_endpoint: false,
            vllm_alt_endpoint_url: "",
            // Cloud — API keys handled server-side by ST
            openai_model: "text-embedding-3-small",
            cohere_model: "embed-english-v3.0",
            google_model: "text-embedding-005",
            openrouter_model: "",
            mistral_model: "mistral-embed",
            insertBatchSize: 10,
        },


        // ── Scan Frequency ────────────────────────────────
        scanFrequency: 1,              // How often the keyword sidecar runs (1 = every message)

        // ── Injection ─────────────────────────────────────
        injection: {
            enabled: true,             // Whether matched memories are injected at all
            placement: "below_card",   // Where in the system prompt: above_card, below_card, top, bottom
            maxEntriesPerMessage: 3,   // Global cap on simultaneous injections per message
            // Per-category caps. Each limits how many of that category's memories
            // can inject in one message. The global cap above still applies as an
            // overall ceiling across all categories combined.
            maxPerCategory: {
                character: 3,
                world: 2,
                plot: 1,
                custom: 2,
            },
        },

        // ── Vectorization ─────────────────────────────────
        vectorization: {
            similarityThreshold: 0.75, // Minimum cosine similarity to trigger injection (0.0–1.0)
            querySource: "keywords",   // "keywords" = use sidecar output, "raw" = use recent messages directly
            raw: {                     // Only used when querySource is "raw"
                scanDepth: 10,         // Number of recent messages to include in query
                chunkSize: 256,        // Token size per text chunk sent to embedding model (reserved/future)
                overlapTokens: 32,     // Token overlap between consecutive chunks (reserved/future)
                topK: 10,              // Max candidates returned before threshold filtering
                distanceMetric: "cosine", // reserved/future; ST vector query currently controls similarity internally
                rerank: false,         // Legacy flag; vectorization.rerank.enabled is the active setting
            },
            rerank: {
                enabled: false,        // Optional LLM second pass after vector search; uses the Keyword sidecar LLM profile
                maxCandidates: 5,      // Max filtered candidates to send to the reranker prompt
                contextDepth: 3,       // Recent chat messages included as reranker context
                maxResponseTokens: 450,
                timeoutMs: 12000,      // Reranker is optional; skip quickly if the sidecar model stalls
            },
            chainExpansion: {
                enabled: true,         // Local, one-hop expansion after normal retrieval
                maxAdditions: 2,       // Hard cap per retrieval cycle
                candidatePool: 6,      // Small neighbour pool scored against the same query
                relationshipBonus: 0.08,
                chronologyBonus: 0.04,
                minimumSemanticScore: 0.15,
            },
            consolidatedPriorityMultiplier: 0.5, // Ranking demotion after a consolidated source passes semantic eligibility
            defaultStickiness: 0,      // Messages to stay injected after firing (0 = no stickiness)
            defaultCooldown: 0,        // Messages before entry can fire again (0 = no cooldown)
        },

        // ── Memory Writing ────────────────────────────────
        memoryWriting: {
            folderSuggestions: false,  // Memory writer suggests a folder for new entries
            autoTagOnCommit: false,    // After accepting a pending memory, tag it before embedding it
            sceneSummaryPrompt: "Write a detailed scene summary for internal narrative reference. Include: key events, emotional turning points, psychological shifts, characters present, unresolved tensions, and any significant relationship developments. Write in a clinical but narratively aware voice — this is a note for future memory generation, not a retelling.",
            memoryEntryPrompt: "Write a core memory entry from the perspective of the primary character. Use rich, specific, sensory and emotionally precise prose. Capture the psychological significance of the moment. Format: bold Title, bold Date, narrative body, Primary Character, Key Characters. Never write memories for {{user}}.",
        },

        // ── Memory Decay (optional, off by default) ───────
        decay: {
            enabled: false,            // Master toggle for decay system
            mode: "linear",            // linear, exponential, or step
            decayStart: 5,             // Number of scenes before decay begins
            minimumPriority: 0.3,      // Entries never drop below this floor (0.0–1.0)
            exemptPinned: true,        // Pinned memories always inject at full priority
        },
    };
}

/** Group synchronous data mutations; roll back in-memory state if any step fails.
 * Saves use the host debounce, so only the completed state is left queued.
 */
export function runChatTransaction(commit) {
    const data = getChatData();
    const before = structuredClone(data);
    try { return commit(); }
    catch (error) {
        for (const key of Object.keys(data)) delete data[key];
        Object.assign(data, before);
        saveChat();
        throw error;
    }
}
