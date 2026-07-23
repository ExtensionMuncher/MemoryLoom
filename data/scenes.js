/**
 * data/scenes.js — Scene open/close and summary management
 *
 * Scenes track contiguous message ranges in the chat. The user opens a scene
 * by clicking the fa-book-open button on a message, and closes it by clicking
 * the fa-feather button (which triggers the memory writer flow).
 *
 * Scene records are stored as an array in chat_metadata.ml.scenes.
 *
 * Key rules:
 *   - Only one scene can be open at a time
 *   - Scene summaries are INTERNAL ONLY — never injected into the main ST prompt
 *   - Closed scenes cannot be reopened (they are historical records)
 */


import { getScenes, saveScenes, getOpenSceneId, saveOpenSceneId, getConsolidations as getConsolidationsForScenes, getPendingEntries, savePendingEntries } from "./storage.js";
import { getAllEntries, deleteEntry } from "./entries.js";
import { deleteEntryVector } from "../embed/embedder.js";
import { getSetting, setSetting } from "../settings.js";

// ─── ID Generation ────────────────────────────────────────

/**
 * Generate a scene ID based on the starting message index.
 * Format: ml_scene_{messageStart}
 *
 * @param {number} messageStart
 * @returns {string}
 */
export function generateSceneId(messageStart) {
    return `ml_scene_${messageStart}`;
}

// ─── Scene CRUD ───────────────────────────────────────────

/**
 * Open a new scene starting at the given message index.
 * Closes any currently open scene first.
 *
 * @param {number} messageStart - The ST message ID where the scene begins
 * @returns {object} The created scene object
 */
export function createScene(messageStart) {
    // Close any currently open scene first (a scene without an end is invalid)
    const currentOpenId = getOpenSceneId();
    if (currentOpenId) {
        console.warn(`[ML] Auto-closing open scene ${currentOpenId} before opening new scene`);
        // Mark the old scene as closed without a proper end — user will need to fix manually
        closeSceneSilent(currentOpenId);
    }

    const scenes = getScenes();

    // Prevent creating a scene on a message that's already part of a closed scene
    const alreadyInClosed = scenes.some(s =>
        s.status === "closed" &&
        messageStart >= s.messageStart &&
        (s.messageEnd === null || messageStart <= s.messageEnd)
    );
    if (alreadyInClosed) {
        console.warn(`[ML] Message ${messageStart} is already part of a closed scene`);
        return null;
    }

    const scene = {
        id: generateSceneId(messageStart),
        status: "open",
        messageStart: messageStart,
        messageEnd: null,
        llmSummary: "",
        consolidatedInto: null,
        createdAt: Date.now(),
    };

    scenes.push(scene);
    saveScenes(scenes);
    saveOpenSceneId(scene.id);

    console.log(`[ML] Scene opened: ${scene.id} at message ${messageStart}`);
    return scene;
}

/**
 * Close a scene at the given message index.
 * Sets the scene's end message and triggers the memory writer flow.
 *
 * @param {string} sceneId
 * @param {number} messageEnd - The ST message ID where the scene ends
 * @returns {object|null} The closed scene, or null if not found
 */
export function closeScene(sceneId, messageEnd) {
    const scenes = getScenes();
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) {
        console.warn(`[ML] Scene not found: ${sceneId}`);
        return null;
    }

    if (scene.status !== "open") {
        console.warn(`[ML] Scene ${sceneId} is not open (status: ${scene.status})`);
        return null;
    }

    // Prevent closing on a message before the scene started
    if (messageEnd < scene.messageStart) {
        console.warn(`[ML] Scene end message ${messageEnd} is before start ${scene.messageStart}`);
        return null;
    }

    scene.status = "closed";
    scene.messageEnd = messageEnd;
    saveScenes(scenes);
    saveOpenSceneId(null);

    console.log(`[ML] Scene closed: ${sceneId} (messages ${scene.messageStart}–${messageEnd})`);
    return scene;
}

/**
 * Silently close a scene without an end message.
 * Used when a new scene is opened while another is still open.
 *
 * @param {string} sceneId
 * @returns {object|null}
 */
function closeSceneSilent(sceneId) {
    const scenes = getScenes();
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) return null;

    scene.status = "closed";
    scene.messageEnd = scene.messageStart; // Mark same start/end to indicate orphaned
    saveScenes(scenes);
    saveOpenSceneId(null);
    return scene;
}

/**
 * Get the currently open scene.
 * @returns {object|null}
 */
export function getOpenScene() {
    const openId = getOpenSceneId();
    if (!openId) return null;

    const scenes = getScenes();
    const scene = scenes.find(s => s.id === openId && s.status === "open");
    if (!scene && openId) {
        // Open scene ID points to a scene that's no longer open — clean up
        saveOpenSceneId(null);
    }
    return scene || null;
}

/**
 * Get a scene by ID.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getScene(id) {
    const scenes = getScenes();
    return scenes.find(s => s.id === id);
}

/**
 * Get all scenes, sorted by messageStart ascending.
 * @returns {object[]}
 */
export function getAllScenes() {
    const scenes = getScenes();
    return [...scenes].sort((a, b) => a.messageStart - b.messageStart);
}

/**
 * Delete a scene record.
 * @param {string} id
 * @returns {boolean} True if deleted
 */
export function deleteScene(id) {
    const scenes = getScenes();
    const index = scenes.findIndex(s => s.id === id);
    if (index === -1) return false;

    // If this was the open scene, clear the open scene ID
    if (getOpenSceneId() === id) {
        saveOpenSceneId(null);
    }

    scenes.splice(index, 1);
    saveScenes(scenes);
    console.log(`[ML] Scene deleted: ${id}`);
    return true;
}

// ─── Scene Summary Management ─────────────────────────────

/**
 * Update a scene's internal LLM summary.
 * These summaries are INTERNAL ONLY — never injected into the main ST prompt.
 * They are used by the memory writer for context when generating entries.
 *
 * @param {string} sceneId
 * @param {string} summary - The LLM-generated scene summary
 * @returns {object|null}
 */
export function updateSceneSummary(sceneId, summary) {
    const scenes = getScenes();
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) return null;

    scene.llmSummary = summary;
    saveScenes(scenes);
    console.log(`[ML] Scene summary updated: ${sceneId}`);
    return scene;
}

/**
 * Get all previous closed scene summaries for context.
 * Used by the memory writer to maintain continuity between scenes.
 *
 * @param {string} [excludeSceneId] - Optional scene ID to exclude (the current one being summarized)
 * @returns {string[]} Array of summary strings
 */
export function getPreviousSceneSummaries(excludeSceneId = null) {
    const scenes = getScenes();
    return scenes
        .filter(s => s.status === "closed" && s.llmSummary && s.id !== excludeSceneId)
        .sort((a, b) => a.messageStart - b.messageStart)
        .map(s => s.llmSummary);
}

// ─── Message Range Checks ─────────────────────────────────

/**
 * Check if a message is within a scene's range.
 * @param {object} scene
 * @param {number} mesId
 * @returns {boolean}
 */
export function isMessageInScene(scene, mesId) {
    if (!scene) return false;
    if (mesId < scene.messageStart) return false;
    if (scene.messageEnd !== null && mesId > scene.messageEnd) return false;
    return true;
}

/**
 * Check if a message is in any closed scene.
 * @param {number} mesId
 * @returns {boolean}
 */
export function isMessageInClosedScene(mesId) {
    const scenes = getScenes();
    return scenes.some(s => s.status === "closed" && isMessageInScene(s, mesId));
}

// ─── Consolidation Helpers ────────────────────────────────

/**
 * Mark a scene as having been consolidated into a consolidation entry.
 * @param {string} sceneId
 * @param {string} consolidationId
 * @returns {object|null}
 */
export function markSceneConsolidated(sceneId, consolidationId) {
    const scenes = getScenes();
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) return null;

    scene.consolidatedInto = consolidationId;
    saveScenes(scenes);
    return scene;
}

// ─── Initialization ───────────────────────────────────────

/**
 * Initialize the scene counter.
 * Called on chat change to ensure the open scene ID is valid.
 * If the open scene is no longer in the scenes array, clear the reference.
 */
export function initSceneCounter() {
    const openId = getOpenSceneId();
    if (!openId) return;

    const scenes = getScenes();
    const stillExists = scenes.some(s => s.id === openId && s.status === "open");
    if (!stillExists) {
        console.warn(`[ML] Open scene ${openId} no longer exists — clearing reference`);
        saveOpenSceneId(null);
    }
}

// ─── Undo Last Scan ───────────────────────────────────────

/**
 * Track the last closed scene for undo functionality.
 * Stored in extension settings (not in the scenes array) so it survives reloads.
 */
let _lastClosedSceneId = null;
let _batchScanPerformed = false;

/**
 * Record the most recently closed scene.
 * Called automatically by closeScene().
 *
 * @param {string} sceneId
 */
export function recordLastClosedScene(sceneId) {
    _lastClosedSceneId = sceneId;
    setSetting("scan.lastClosedSceneId", sceneId);  // persist so undo survives reload
}

/**
 * Check if undo is available.
 * @returns {{available: boolean, reason: string, sceneId: string|null}}
 */
export function getUndoStatus() {
    // Restore persisted marker if the in-memory one was cleared by a page reload
    if (!_lastClosedSceneId) {
        const persisted = getSetting("scan.lastClosedSceneId", null);
        if (persisted) _lastClosedSceneId = persisted;
    }
    if (_batchScanPerformed) {
        return { available: false, reason: "Cannot undo a batch scan", sceneId: null };
    }
    if (!_lastClosedSceneId) {
        return { available: false, reason: "No scan to undo", sceneId: null };
    }
    return { available: true, reason: "", sceneId: _lastClosedSceneId };
}

/**
 * Undo the last scan: removes the last closed scene AND every memory entry
 * (committed or pending) that scan generated. Previously this only deleted the
 * scene record and left all the generated memories behind — a broken "undo".
 * The marker is persisted in storage so it survives a page reload.
 * @returns {boolean} True if undone
 */
export function undoLastScan() {
    const status = getUndoStatus();
    if (!status.available) return false;
    const sceneId = status.sceneId;

    // Remove committed entries created by this scene
    let removed = 0;
    try {
        const all = getAllEntries();
        for (const e of all) {
            if (e.sceneId === sceneId) {
                // Remove the vector too, or undo leaves orphaned embeddings that
                // can still be retrieved after the entry is gone.
                deleteEntryVector(e).catch(err => console.warn("[ML] Undo: vector delete failed:", err));
                deleteEntry(e.id);
                removed++;
            }
        }
    } catch (err) { console.error("[ML] Undo: entry cleanup failed:", err); }

    // Remove pending entries created by this scene (not yet committed)
    try {
        const pending = getPendingEntries() || [];
        const keep = pending.filter(p => p.sceneId !== sceneId);
        if (keep.length !== pending.length) savePendingEntries(keep);
    } catch (err) { console.error("[ML] Undo: pending cleanup failed:", err); }

    // Finally delete the scene itself
    const deleted = deleteScene(sceneId);
    _lastClosedSceneId = null;
    setSetting("scan.lastClosedSceneId", null);
    console.log(`[ML] Undid last scan: scene ${sceneId}, removed ${removed} committed + cleared pending`);
    return deleted || removed > 0;
}
