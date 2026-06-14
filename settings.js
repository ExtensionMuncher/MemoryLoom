/**
 * settings.js — Settings management for Memory Loom
 *
 * Provides a clean API for reading and writing extension settings.
 * Settings are stored globally (survive chat switches) in
 * extension_settings.ml.settings.
 *
 * Pattern: follows relationship-stat-tracker's settings.js exactly.
 */

import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../../scripts/extensions.js";
import {
    getSettings,
    getDefaultSettings,
    saveSetting as storageSaveSetting,
    saveAllSettings as storageSaveAllSettings,
    persistSettings,
} from "./data/storage.js";

const NAMESPACE = "ml";

// ─── Initialization ───────────────────────────────────────

/**
 * Initialize Memory Loom settings.
 * Called ONCE on extension load. Merges any new default fields
 * into the user's existing saved settings so they don't lose
 * their configuration when we add new options.
 */
export async function initSettings() {
    const current = getSettings();
    const defaults = getDefaultSettings();

    // Deep merge: user values are preserved, new default fields are added
    const merged = deepMerge(defaults, current);

    // Reset any saved prompt that isn't our current versioned format.
    // We embed "[MLv4]" in our defaults — anything without it is stale.
    const _ep = merged?.memoryWriting?.memoryEntryPrompt || "";
    const _sp = merged?.memoryWriting?.sceneSummaryPrompt || "";
    if (_ep && !_ep.includes("[MLv4]")) {
        if (merged.memoryWriting) merged.memoryWriting.memoryEntryPrompt = "";
        console.log("[ML] Cleared stale memory entry prompt");
    }
    if (_sp && !_sp.includes("[MLv4]")) {
        if (merged.memoryWriting) merged.memoryWriting.sceneSummaryPrompt = "";
        console.log("[ML] Cleared stale scene summary prompt");
    }
    storageSaveAllSettings(merged);

    console.log("[ML] Settings initialized");
}

// ─── Public API ───────────────────────────────────────────

/**
 * Get a setting value by dot-notation key path.
 * Example: getSetting("injection.placement") → "below_card"
 *
 * @param {string} key - Dot-notation path (e.g. "connections.memoryWriterLLM")
 * @param {*} [defaultValue] - Fallback if the key is not found
 * @returns {*}
 */
export function getSetting(key, defaultValue = undefined) {
    const settings = getSettings();
    const parts = key.split(".");
    let obj = settings;
    for (const part of parts) {
        if (obj === undefined || obj === null) return defaultValue;
        obj = obj[part];
    }
    return obj !== undefined ? obj : defaultValue;
}

/**
 * Set a setting value and persist.
 * Example: setSetting("injection.maxEntriesPerMessage", 5)
 *
 * @param {string} key - Dot-notation path
 * @param {*} value
 */
export function setSetting(key, value) {
    storageSaveSetting(key, value);
}

/**
 * Check if the Memory Loom extension is currently enabled.
 * @returns {boolean}
 */
export function isEnabled() {
    return getSetting("enabled", true);
}

/**
 * Toggle the extension on or off.
 * @param {boolean} [enabled] - Force a specific state; omitting toggles
 * @returns {boolean} The new state
 */
export function toggleEnabled(enabled) {
    const newState = enabled !== undefined ? enabled : !isEnabled();
    storageSaveSetting("enabled", newState);
    return newState;
}

/**
 * Check if the keyword sidecar is currently paused.
 * Tracks pause state in extension_settings directly
 * (not per-chat — pause survives chat switches).
 * @returns {boolean}
 */
/**
 * Reset all Memory Loom settings to their defaults.
 * Does not touch per-chat data (entries, scenes, folders).
 */
export function resetSettingsToDefaults() {
    const defaults = getDefaultSettings();
    storageSaveAllSettings(defaults);
    console.log("[ML] Settings reset to defaults.");
}

export function isSidecarPaused() {
    return extension_settings[NAMESPACE]?.sidecarPaused === true;
}

/**
 * Pause or resume the keyword sidecar.
 * @param {boolean} paused
 */
export function setSidecarPaused(paused) {
    if (!extension_settings[NAMESPACE]) {
        extension_settings[NAMESPACE] = {};
    }
    extension_settings[NAMESPACE].sidecarPaused = paused;
    saveSettingsDebounced();
}

// ─── Connection Profile Helpers ───────────────────────────

/**
 * Get the configured LLM connection profile names.
 * @returns {{memoryWriterLLM: string, consolidationLLM: string, sidecarLLM: string}}
 */
export function getConnectionNames() {
    return getSetting("connections", {
        memoryWriterLLM: "",
        consolidationLLM: "",
        sidecarLLM: "",
    });
}

/**
 * Get injection settings as a convenience object.
 * @returns {object}
 */
export function getInjectionSettings() {
    return getSetting("injection", {
        enabled: true,
        placement: "below_card",
        maxEntriesPerMessage: 3,
    });
}

/**
 * Get vectorization settings as a convenience object.
 * @returns {object}
 */
export function getVectorizationSettings() {
    return getSetting("vectorization", {});
}

/**
 * Get embedding settings as a convenience object.
 * @returns {object}
 */
export function getEmbeddingSettings() {
    return getSetting("embedding", {});
}

/**
 * Get decay settings as a convenience object.
 * @returns {object}
 */
export function getDecaySettings() {
    return getSetting("decay", {});
}

// ─── Import / Export ──────────────────────────────────────

/**
 * Export all Memory Loom data as a JSON string.
 * Includes global settings plus per-chat data from the current chat.
 *
 * @param {object} chatData - The current chat's ml data (entries, folders, scenes, consolidations)
 * @returns {string} JSON string
 */
export async function exportAllData(chatData) {
    const data = {
        settings: getSettings(),
        chatData: chatData,
        version: "0.1.0",
        exportedAt: new Date().toISOString(),
    };
    return JSON.stringify(data, null, 2);
}

/**
 * Import Memory Loom data from a JSON string.
 * Restores settings globally and chat data into the current chat.
 *
 * @param {string} jsonString
 * @returns {boolean} True if imported successfully
 */
export async function importAllData(jsonString, options = {}) {
    // options:
    //   settingsMode: "overwrite" | "keep"  — replace global settings or leave current ones
    //   dataMode:     "merge" | "replace"   — merge chat data into existing, or wipe + replace
    // Backward-compatible: old exports may omit fields entirely. Anything absent
    // is simply skipped, never assumed; arrays vs object maps are both handled.
    const { settingsMode = "keep", dataMode = "merge" } = options;
    try {
        const data = JSON.parse(jsonString);
        if (!data || typeof data !== "object") throw new Error("Invalid file: not a JSON object");

        // ── Settings (global) ──
        if (data.settings && typeof data.settings === "object") {
            if (settingsMode === "overwrite") {
                storageSaveAllSettings(data.settings);
            } else {
                // keep current settings; only fill in fields the user doesn't have yet
                const current = getSettings();
                storageSaveAllSettings(deepMerge(data.settings, current));
            }
        }

        // ── Chat data (per-chat) ──
        if (data.chatData && typeof data.chatData === "object") {
            const {
                getEntries, saveEntries, getFolders, saveFolders,
                getScenes, saveScenes, getConsolidations, saveConsolidations,
            } = await import("./data/storage.js");
            const cd = data.chatData;

            if (dataMode === "replace") {
                // Wipe + replace each present collection; absent ones left untouched
                if (cd.entries !== undefined)        saveEntries(normalizeMap(cd.entries));
                if (cd.folders !== undefined)        saveFolders(cd.folders || []);
                if (cd.scenes !== undefined)         saveScenes(cd.scenes || []);
                if (cd.consolidations !== undefined) saveConsolidations(normalizeMap(cd.consolidations));
            } else {
                // MERGE: keep everything existing, add/overlay imported items by id.
                // Imported items win on id collision (they're the explicit import).
                if (cd.entries !== undefined) {
                    saveEntries(mergeById(getEntries(), normalizeMap(cd.entries)));
                }
                if (cd.consolidations !== undefined) {
                    saveConsolidations(mergeById(getConsolidations(), normalizeMap(cd.consolidations)));
                }
                if (cd.folders !== undefined) {
                    saveFolders(mergeArrayById(getFolders(), cd.folders || []));
                }
                if (cd.scenes !== undefined) {
                    saveScenes(mergeArrayById(getScenes(), cd.scenes || []));
                }
            }
        }

        console.log(`[ML] Import complete (settings: ${settingsMode}, data: ${dataMode})`);
        return true;
    } catch (err) {
        console.error("[ML] Failed to import data:", err);
        return false;
    }
}

// Some old exports stored entries/consolidations as an array; current code uses
// an id-keyed object map. Accept either and always return a map.
function normalizeMap(val) {
    if (!val) return {};
    if (Array.isArray(val)) {
        const out = {};
        for (const item of val) { if (item && item.id) out[item.id] = item; }
        return out;
    }
    return val;
}

// Merge two id-keyed object maps; imported (source) wins on collision.
function mergeById(existing, incoming) {
    return { ...(existing || {}), ...(incoming || {}) };
}

// Merge two arrays of {id} objects; imported wins on collision, order preserved
// with existing items first, then genuinely new imported ones.
function mergeArrayById(existing, incoming) {
    const map = new Map();
    for (const item of (existing || [])) if (item && item.id) map.set(item.id, item);
    for (const item of (incoming || [])) if (item && item.id) map.set(item.id, item);
    return [...map.values()];
}
// ─── Helpers ──────────────────────────────────────────────

/**
 * Deep merge two objects.
 * Values from `source` override values in `target`.
 * Values only in `target` are preserved (user's existing settings).
 * Values only in `source` are added (new default fields).
 *
 * @param {object} target - The defaults (source of truth for structure)
 * @param {object} source - The user's current values (overrides targets)
 * @returns {object} Merged object
 */
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (
            source[key] &&
            typeof source[key] === "object" &&
            !Array.isArray(source[key]) &&
            target[key] &&
            typeof target[key] === "object" &&
            !Array.isArray(target[key])
        ) {
            // Both sides are plain objects — recurse
            result[key] = deepMerge(target[key], source[key]);
        } else {
            // Primitive, array, or missing in target — source wins
            result[key] = source[key];
        }
    }
    return result;
}
