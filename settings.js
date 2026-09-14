import { getChatData, persistChatData } from "./data/storage.js";
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

    // Migrate only the exact legacy built-in prompt value to the dynamic default.
    // Never clear or rewrite an arbitrary custom prompt.
    const _ep = merged?.memoryWriting?.memoryEntryPrompt || "";
    const _sp = merged?.memoryWriting?.sceneSummaryPrompt || "";
    if (_ep === defaults.memoryWriting.memoryEntryPrompt) {
        if (merged.memoryWriting) merged.memoryWriting.memoryEntryPrompt = "";
        console.log("[ML] Cleared stale memory entry prompt");
    }
    if (_sp === defaults.memoryWriting.sceneSummaryPrompt) {
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
    const next = Boolean(paused);
    const previous = extension_settings[NAMESPACE].sidecarPaused === true;
    extension_settings[NAMESPACE].sidecarPaused = next;
    saveSettingsDebounced();

    // Pause/resume changes cadence state in index.js. Keep the setting module
    // storage-only, but publish one guarded event so every UI entry point uses
    // the same freeze/restore transaction.
    if (previous !== next && typeof document !== "undefined") {
        const jq = globalThis.jQuery || globalThis.$;
        if (typeof jq === "function") jq(document).trigger("ml:sidecar-pause-changed", [next]);
    }
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
        version: "0.1.18",
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
    const { settingsMode = "keep", dataMode = "merge" } = options;
    try {
        const data = JSON.parse(jsonString);
        const object = value => value && typeof value === "object" && !Array.isArray(value);
        if (!object(data)) throw new Error("Import must be an object");
        if (!["keep", "overwrite"].includes(settingsMode) || !["merge", "replace"].includes(dataMode)) throw new Error("Invalid import mode");
        // Validate all collections before changing settings or chat data.
        if (data.settings !== undefined && !object(data.settings)) throw new Error("Invalid settings");
        if (data.chatData !== undefined && !object(data.chatData)) throw new Error("Invalid chat data");
        const cd = data.chatData;
        if (cd) {
            for (const key of ["folders", "scenes"]) {
                if (cd[key] !== undefined && (!Array.isArray(cd[key]) || cd[key].some(x => !object(x) || !x.id))) throw new Error(`Invalid ${key}`);
            }
            for (const key of ["entries", "consolidations"]) {
                if (cd[key] !== undefined && (!object(cd[key]) && !Array.isArray(cd[key]))) throw new Error(`Invalid ${key}`);
                if (cd[key] !== undefined && Object.values(cd[key]).some(x => !object(x) || !x.id)) throw new Error(`Invalid ${key} record`);
            }
            if (cd.pendingEntries != null && ((!object(cd.pendingEntries) && !Array.isArray(cd.pendingEntries)) || Object.values(cd.pendingEntries).some(x => !object(x)))) throw new Error("Invalid pending entries");
            for (const key of ["stickiness", "cooldowns"]) {
                if (cd[key] !== undefined && (!object(cd[key]) || Object.values(cd[key]).some(n => !Number.isFinite(n) || n < 0))) throw new Error(`Invalid ${key}`);
            }
            if (cd.messageCounter !== undefined && (!Number.isFinite(Number(cd.messageCounter)) || Number(cd.messageCounter) < 0)) throw new Error("Invalid message counter");
            if (cd.worldScale !== undefined && typeof cd.worldScale !== "string") throw new Error("Invalid world scale");
            if (cd.openSceneId !== undefined && cd.openSceneId !== null && typeof cd.openSceneId !== "string") throw new Error("Invalid open scene id");
            if (cd.sidecarPauseCadence !== undefined && cd.sidecarPauseCadence !== null) {
                if (!object(cd.sidecarPauseCadence)) throw new Error("Invalid sidecar pause cadence");
                const live = Number(cd.sidecarPauseCadence.liveCount);
                const baseline = Number(cd.sidecarPauseCadence.baseline);
                if (!Number.isFinite(live) || !Number.isFinite(baseline) || live < 0 || baseline < 0 || baseline > live) throw new Error("Invalid sidecar pause cadence");
            }
            if (cd.lastSidecarRun !== undefined && cd.lastSidecarRun !== null && !object(cd.lastSidecarRun)) throw new Error("Invalid last sidecar run");
        }
        const target = cd ? getChatData() : null;
        const next = target ? (dataMode === "replace" ? emptyChatData() : structuredClone(target)) : null;
        if (cd) {
            for (const key of ["entries", "consolidations"]) if (cd[key] !== undefined) {
                const incoming = normalizeMap(cd[key]);
                next[key] = dataMode === "replace" ? incoming : mergeById(next[key], incoming);
            }
            for (const key of ["folders", "scenes"]) if (cd[key] !== undefined) next[key] = dataMode === "replace" ? cd[key] : mergeArrayById(next[key], cd[key]);
            if (cd.pendingEntries !== undefined) next.pendingEntries = dataMode === "replace" ? normalizePendingEntries(cd.pendingEntries) : mergePendingEntries(next.pendingEntries, cd.pendingEntries);
            importChatMetaFields(cd, next, dataMode);
            if (next.openSceneId && !(next.scenes || []).some(s => s.id === next.openSceneId)) next.openSceneId = null;
        }
        const settings = data.settings
            ? deepMerge(getDefaultSettings(), settingsMode === "overwrite" ? data.settings : deepMerge(data.settings, getSettings()))
            : null;
        // Everything above is staged; no async gap exists in the commit.
        if (settings) storageSaveAllSettings(settings);
        if (next) { Object.assign(target, next); persistChatData(); }
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

// Pending review entries are intentionally allowed to be id-less: generated
// pending cards receive their real id only when the user commits them. Older
// exports may store this as either an array or an object map, so normalize to
// the array shape the Home tab already handles best.
function normalizePendingEntries(val) {
    if (!val) return null;
    const list = Array.isArray(val) ? val : Object.values(val || {});
    const clean = list.filter(item => item && typeof item === "object");
    return clean.length ? clean : null;
}

// Merge pending entries without requiring ids. When ids exist, use them as the
// stable key; otherwise fall back to a content fingerprint so re-importing the
// same export does not duplicate the same pending cards.
function mergePendingEntries(existing, incoming) {
    const out = [];
    const seen = new Set();
    const add = (item) => {
        if (!item || typeof item !== "object") return;
        const key = item.id
            ? `id:${item.id}`
            : `fp:${item.title || ""}|${item.datetime || ""}|${item.primaryCharacter || (item.primaryCharacters || []).join(",")}|${item.sceneId || ""}|${item.content || ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(item);
    };
    (normalizePendingEntries(existing) || []).forEach(add);
    (normalizePendingEntries(incoming) || []).forEach(add);
    return out.length ? out : null;
}

// Import chat-scoped metadata that exportAllData already writes but the old
// importer silently ignored. In merge mode, current worldScale/openSceneId are
// preserved when already populated; replace mode takes the imported values.
function importChatMetaFields(source, target, mode) {
    if (!source || !target) return;
    const replace = mode === "replace";
    if (source.messageCounter !== undefined) {
        const n = Number(source.messageCounter);
        if (Number.isFinite(n)) target.messageCounter = n;
    }
    if (source.stickiness !== undefined) target.stickiness = mergeById(replace ? {} : (target.stickiness || {}), normalizeMap(source.stickiness));
    if (source.cooldowns !== undefined) target.cooldowns = mergeById(replace ? {} : (target.cooldowns || {}), normalizeMap(source.cooldowns));
    if (source.worldScale !== undefined && (replace || !target.worldScale)) target.worldScale = String(source.worldScale || "");
    if (source.openSceneId !== undefined && (replace || !target.openSceneId)) target.openSceneId = source.openSceneId || null;
    if (source.sidecarPauseCadence !== undefined) {
        target.sidecarPauseCadence = source.sidecarPauseCadence === null
            ? null
            : {
                liveCount: Math.max(0, Math.floor(Number(source.sidecarPauseCadence.liveCount))),
                baseline: Math.max(0, Math.floor(Number(source.sidecarPauseCadence.baseline))),
            };
    }
    if (source.lastSidecarRun !== undefined) target.lastSidecarRun = source.lastSidecarRun === null ? null : structuredClone(source.lastSidecarRun);
}

/** Clean per-chat baseline used by a true Replace import. */
function emptyChatData() {
    return {
        entries: {},
        folders: [],
        scenes: [],
        consolidations: {},
        pendingEntries: null,
        messageCounter: 0,
        sidecarPauseCadence: null,
        lastSidecarRun: null,
        openSceneId: null,
        stickiness: {},
        cooldowns: {},
        worldScale: "",
    };
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
