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
    if (name1) {
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
            pendingEntries: null,  // Pending review entries from the memory writer (null = none)
            messageCounter: 0,     // How many messages have passed (for scan frequency)
            openSceneId: null,     // ID of the currently open scene (null = none open)
            stickiness: {},        // Tracks which entries are currently "sticky" { entryId: messagesRemaining }
            cooldowns: {},         // Tracks cooldown timers { entryId: messagesRemaining }
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

// ─── Pending Entries ──────────────────────────────────────

/**
 * Get pending review entries (shown on the Home tab).
 * @returns {object|null} Pending entries object or null
 */
export function getPendingEntries() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].pendingEntries;
}

/**
 * Save pending review entries.
 * @param {object|null} pending
 */
export function savePendingEntries(pending) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].pendingEntries = pending;
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
    return chat_metadata[NAMESPACE].messageCounter || 0;
}

/**
 * Increment the message counter and save.
 * Called once per new message event.
 * @returns {number} New counter value
 */
export function incrementMessageCounter() {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].messageCounter = (chat_metadata[NAMESPACE].messageCounter || 0) + 1;
    saveChat();
    return chat_metadata[NAMESPACE].messageCounter;
}

/**
 * Reset the message counter to zero.
 * Called when the user changes scan frequency or on chat switch.
 */
export function resetMessageCounter() {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].messageCounter = 0;
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
            memoryWriterLLM: "",       // Generates entries on scene close
            consolidationLLM: "",      // Generates arc/sub-arc consolidation summaries
            sidecarLLM: "",            // Extracts themes from context every N messages
        },

        // ── Embedding Settings ────────────────────────────
        // Field names mirror VectFox/ST vector API exactly so getVectorsRequestBody()
        // works without translation. Do NOT rename these fields.
        embedding: {
            source: "transformers",         // Provider: transformers, ollama, vllm, openai, cohere, palm, openrouter, mistral
            // Ollama
            ollama_model: "",
            ollama_use_alt_endpoint: false,
            ollama_alt_endpoint_url: "",
            ollama_keep: false,
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
            maxEntriesPerMessage: 3,   // Cap on simultaneous injections per message
        },

        // ── Vectorization ─────────────────────────────────
        vectorization: {
            similarityThreshold: 0.75, // Minimum cosine similarity to trigger injection (0.0–1.0)
            querySource: "keywords",   // "keywords" = use sidecar output, "raw" = use recent messages directly
            raw: {                     // Only used when querySource is "raw"
                scanDepth: 10,         // Number of recent messages to include in query
                chunkSize: 256,        // Token size per text chunk sent to embedding model
                overlapTokens: 32,     // Token overlap between consecutive chunks
                topK: 10,              // Max candidates returned before threshold filtering
                distanceMetric: "cosine", // cosine, dot_product, or euclidean
                rerank: false,         // Apply a second-pass sort on top-k before injecting
            },
            defaultStickiness: 0,      // Messages to stay injected after firing (0 = no stickiness)
            defaultCooldown: 0,        // Messages before entry can fire again (0 = no cooldown)
        },

        // ── Memory Writing ────────────────────────────────
        memoryWriting: {
            folderSuggestions: false,  // Memory writer suggests a folder for new entries
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
