/**
 * data/entries.js — Memory entry CRUD and management
 *
 * Provides all create, read, update, and delete operations for memory entries.
 * Entries are stored in chat_metadata.ml.entries as a map keyed by entry ID.
 *
 * Also handles:
 *   - Status management (active, consolidated, archived, pinned, superseded)
 *   - Delta block management
 *   - Tag management (for library browsing only — NOT used in embedding pipeline)
 *   - Entry routing (determining which folder an entry belongs in)
 *   - ID generation
 */


import { getEntries, saveEntries, getFolders, saveFolders, getConsolidations } from "./storage.js";
import { resolveCanonicalCharacter, incrementEntryCount, decrementEntryCount } from "./folders.js";

// ─── Constants ────────────────────────────────────────────

/**
 * Valid entry statuses.
 * active:       Normal injection priority. Default for all new entries. No badge.
 * consolidated: Lower default injection priority. A consolidation entry now carries its meaning.
 * archived:     Searchable in library but never injected by default.
 * pinned:       Always injects at full priority regardless of similarity, stickiness, or decay.
 * superseded:   Kept as historical record. A newer memory or consolidation overrides it.
 */
export const ENTRY_STATUSES = ["active", "consolidation", "consolidated", "archived", "pinned", "superseded"];

/**
 * Entry categories — determines which top-level folder the entry routes to.
 */
export const ENTRY_CATEGORIES = ["character", "world", "plot"];

/**
 * Delta type vocabulary (fixed list — NOT user-configurable).
 * Used by the memory writer to classify what kind of change a memory represents.
 */
export const DELTA_TYPES = [
    "relationship_shift",
    "knowledge_change",
    "secret_created",
    "secret_revealed",
    "secret_concealed",
    "promise_created",
    "threat_created",
    "trust_change",
    "suspicion_change",
    "character_state_change",
    "world_state_change",
    "faction_state_change",
    "plot_progression",
    "conflict_escalation",
    "conflict_resolution",
    "item_state_change",
    "location_state_change",
    "status_change",
    "self_restraint",
    "public_alignment",
];

// ─── ID Generation ────────────────────────────────────────

/**
 * Generate a unique entry ID.
 * Format: ml_entry_{timestamp}_{random8}
 * Example: ml_entry_1718234567890_a3f9c2b1
 *
 * @returns {string}
 */
export function generateEntryId() {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 10);
    return `ml_entry_${ts}_${rand}`;
}

// ─── CRUD Operations ──────────────────────────────────────

/**
 * Create a new memory entry and save it to storage.
 *
 * @param {object} data - Entry data (see Memory Entry data structure in the plan)
 * @param {string} data.title - Entry title
 * @param {string} data.datetime - Narrative date/time string
 * @param {string} data.content - Full narrative prose body
 * @param {string|string[]} data.primaryCharacter - Single character name or array of names
 * @param {string[]} [data.keyCharacters] - Supporting character names
 * @param {string} data.category - "character", "world", or "plot"
 * @param {string} [data.folderId] - Destination folder ID (auto-routed if not provided)
 * @param {string[]} [data.tags] - Descriptive tags for library browsing
 * @param {string} [data.status] - Entry status (defaults to "active")
 * @param {object} [data.delta] - Delta block (before_state, after_state, delta, delta_type[], low_delta_flag)
 * @param {string} [data.source] - "llm_generated" or "manual"
 * @param {string} [data.sceneId] - Scene that generated this entry (null if manual)
 * @returns {object} The created entry object
 */
export function createEntry(data) {
    const entries = getEntries();

    // Normalize primaryCharacter: always store as primaryCharacters array internally,
    // but also keep primaryCharacter as a string for backward compatibility
    const primaryCharArray = Array.isArray(data.primaryCharacters) && data.primaryCharacters.length
        ? data.primaryCharacters
        : Array.isArray(data.primaryCharacter)
            ? data.primaryCharacter
            : (data.primaryCharacter ? [data.primaryCharacter] : []);

    const entry = {
        id: generateEntryId(),
        title: data.title || "",
        datetime: data.datetime || "",
        content: data.content || "",
        primaryCharacter: primaryCharArray.length === 1 ? primaryCharArray[0] : "",
        primaryCharacters: primaryCharArray,
        keyCharacters: data.keyCharacters || [],
        category: data.category || "character",
        worldEvent: data.worldEvent || false,  // true = setting-altering world event (consolidation-eligible); false = static fact
        folderId: data.folderId || "",
        tags: data.tags || [],
        status: data.status || "active",
        delta: data.delta || {
            before_state: "",
            after_state: "",
            delta: "",
            delta_type: [],
            low_delta_flag: false,
        },
        vectorHash: null,          // Hash of the embedded text (set by embedder.js after embedding)
        stickiness: data.stickiness || 0,   // 0 = use global default
        cooldown: data.cooldown || 0,       // 0 = use global default
        sceneId: data.sceneId || null,
        consolidationId: data.consolidationId || null,  // links a consolidation-produced memory back to its consolidation record
        important: data.important || false,  // core/pivotal memory — exempt from decay and consolidation suppression
        excludeFromConsolidation: data.excludeFromConsolidation || false,  // never used as a consolidation source
        source: data.source || "manual",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    entries[entry.id] = entry;
    saveEntries(entries);

    // Auto-route the entry to its destination folder if no folderId was provided
    if (!entry.folderId) {
        routeEntry(entry);
    }

    console.log(`[ML] Entry created: ${entry.id} — "${entry.title}"`);
    return entry;
}

/**
 * Get a single entry by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getEntry(id) {
    const entries = getEntries();
    return entries[id] || null;
}

/**
 * Get all committed entries as an array.
 * @returns {object[]}
 */
export function getAllEntries() {
    repairStuckPendingStatus();
    backfillConsolidatedSources();
    const entries = getEntries();
    return Object.values(entries);
}

/**
 * One-time repair: any entry living in the committed store but still flagged
 * status "pending" was committed with the wrong status (an old world-memory
 * commit bug). Being in this store means it IS committed, so flip it to active.
 * Idempotent and cheap; runs once per load via a guard flag.
 */
let _pendingStatusRepaired = false;
let _consolidatedSourcesBackfilled = false;

/**
 * Reset the one-time migration guards. Called on chat change so per-chat
 * migrations (pending-status repair, consolidatedSource backfill) run for the
 * newly-loaded chat too — otherwise they'd only ever run for the first chat
 * loaded after a page refresh, silently skipping every chat switched to after.
 */
export function resetEntryMigrationGuards() {
    _pendingStatusRepaired = false;
    _consolidatedSourcesBackfilled = false;
}

function repairStuckPendingStatus() {
    if (_pendingStatusRepaired) return;
    _pendingStatusRepaired = true;
    try {
        const entries = getEntries();
        let changed = false;
        for (const id of Object.keys(entries)) {
            if (entries[id] && entries[id].status === "pending") {
                entries[id].status = "active";
                changed = true;
            }
        }
        if (changed) { saveEntries(entries); console.log("[ML] Repaired entries stuck at 'pending' → 'active'."); }
    } catch (e) { console.warn("[ML] pending-status repair skipped:", e); }
}

/**
 * One-time backfill: mark every entry that was a source in any past
 * consolidation with consolidatedSourceOf, so it stops reappearing in the
 * consolidate modal. Needed because starred sources keep "active" status and
 * older consolidations (pre-marker) never stamped them. Reconstructs from each
 * consolidation's stored source_memories list.
 */
function backfillConsolidatedSources() {
    if (_consolidatedSourcesBackfilled) return;
    _consolidatedSourcesBackfilled = true;
    try {
        const cons = getConsolidations();
        if (!cons) return;
        const list = Array.isArray(cons) ? cons : Object.values(cons);
        if (!list.length) return;
        const entries = getEntries();
        let changed = false;
        for (const c of list) {
            const srcIds = c && Array.isArray(c.source_memories) ? c.source_memories : [];
            for (const sid of srcIds) {
                if (entries[sid] && !entries[sid].consolidatedSourceOf) {
                    entries[sid].consolidatedSourceOf = c.id || true;
                    changed = true;
                }
            }
        }
        if (changed) { saveEntries(entries); console.log("[ML] Backfilled consolidatedSourceOf markers on past consolidation sources."); }
    } catch (e) { console.warn("[ML] consolidated-source backfill skipped:", e); }
}

/**
 * Get entries belonging to a specific folder.
 * @param {string} folderId
 * @returns {object[]}
 */
export function getEntriesByFolder(folderId) {
    const entries = getEntries();
    return Object.values(entries).filter(e => e.folderId === folderId);
}

/**
 * Get entries where the given character is a primary.
 * Checks both primaryCharacter (string) and primaryCharacters (array).
 * @param {string} charName
 * @returns {object[]}
 */
export function getEntriesByCharacter(charName) {
    const entries = getEntries();
    const lower = charName.toLowerCase();
    return Object.values(entries).filter(e => {
        if (e.primaryCharacter && e.primaryCharacter.toLowerCase() === lower) return true;
        if (e.primaryCharacters && e.primaryCharacters.some(n => n.toLowerCase() === lower)) return true;
        return false;
    });
}

/**
 * Update an existing entry. Merges the provided updates into the entry.
 * @param {string} id
 * @param {object} updates - Fields to update
 * @returns {object|null} The updated entry, or null if not found
 */
export function updateEntry(id, updates) {
    const entries = getEntries();
    const entry = entries[id];
    if (!entry) return null;

    // Merge updates
    Object.assign(entry, updates, {
        updatedAt: Date.now(),
    });

    // If primaryCharacters changed, update primaryCharacter for backward compat
    if (updates.primaryCharacters) {
        entry.primaryCharacter = entry.primaryCharacters.length === 1
            ? entry.primaryCharacters[0]
            : "";
    }

    saveEntries(entries);
    console.log(`[ML] Entry updated: ${id}`);
    return entry;
}

/**
 * Delete an entry from storage.
 * @param {string} id
 * @returns {boolean} True if deleted, false if not found
 */
export function deleteEntry(id) {
    const entries = getEntries();
    if (!entries[id]) return false;

    // Decrement the folder's entry count
    const entry = entries[id];
    if (entry.folderId) {
        decrementFolderEntryCount(entry.folderId);
    }

    delete entries[id];
    saveEntries(entries);
    console.log(`[ML] Entry deleted: ${id}`);
    return true;
}

// ─── Status Management ────────────────────────────────────

/**
 * Set an entry's status.
 * @param {string} id
 * @param {string} status - One of ENTRY_STATUSES
 * @returns {object|null}
 */
export function setEntryStatus(id, status) {
    if (!ENTRY_STATUSES.includes(status)) {
        console.warn(`[ML] Invalid status: ${status}`);
        return null;
    }
    return updateEntry(id, { status });
}

/**
 * Get entries filtered by status.
 * @param {string} status
 * @returns {object[]}
 */
export function getEntriesByStatus(status) {
    const entries = getEntries();
    return Object.values(entries).filter(e => e.status === status);
}

/**
 * Pin an entry (always injects at full priority).
 * @param {string} id
 * @returns {object|null}
 */
export function pinEntry(id) {
    return setEntryStatus(id, "pinned");
}

/**
 * Unpin an entry (returns to active status).
 * @param {string} id
 * @returns {object|null}
 */
export function unpinEntry(id) {
    return setEntryStatus(id, "active");
}

/**
 * Archive an entry (searchable but never injected).
 * @param {string} id
 * @returns {object|null}
 */
export function archiveEntry(id) {
    return setEntryStatus(id, "archived");
}

// ─── Tag Management ───────────────────────────────────────

/**
 * Add tags to an entry.
 * @param {string} id
 * @param {string[]} tags - Tags to add (duplicates are ignored)
 * @returns {object|null}
 */
export function addTags(id, tags) {
    const entry = getEntry(id);
    if (!entry) return null;

    const currentTags = new Set(entry.tags || []);
    for (const tag of tags) {
        currentTags.add(tag);
    }
    return updateEntry(id, { tags: [...currentTags] });
}

/**
 * Remove tags from an entry.
 * @param {string} id
 * @param {string[]} tags - Tags to remove
 * @returns {object|null}
 */
export function removeTags(id, tags) {
    const entry = getEntry(id);
    if (!entry) return null;

    const removeSet = new Set(tags);
    const newTags = (entry.tags || []).filter(t => !removeSet.has(t));
    return updateEntry(id, { tags: newTags });
}

// ─── Delta Management ─────────────────────────────────────

/**
 * Update an entry's delta block.
 * @param {string} id
 * @param {object} delta - { before_state, after_state, delta, delta_type[], low_delta_flag }
 * @returns {object|null}
 */
export function updateDelta(id, delta) {
    return updateEntry(id, { delta });
}

/**
 * Flag an entry as low-delta (meaningful change was minimal).
 * @param {string} id
 * @param {boolean} [flag=true]
 * @returns {object|null}
 */
export function flagLowDelta(id, flag = true) {
    const entry = getEntry(id);
    if (!entry) return null;
    const delta = { ...entry.delta, low_delta_flag: flag };
    return updateEntry(id, { delta });
}

// ─── Folder Routing ───────────────────────────────────────

/**
 * Move an entry to a different folder, keeping folder entry counts in sync.
 * Used by the Move control on library entry cards — fixes a memory that
 * landed in the wrong character's folder without recreate-and-delete.
 */
export function moveEntryToFolder(entryId, targetFolderId) {
    const entry = getEntry(entryId);
    if (!entry || !targetFolderId || entry.folderId === targetFolderId) return false;
    const oldFolderId = entry.folderId;
    updateEntry(entryId, { folderId: targetFolderId });
    if (oldFolderId) decrementEntryCount(oldFolderId);
    incrementEntryCount(targetFolderId);
    console.log(`[ML] Entry ${entryId} moved to folder ${targetFolderId}`);
    return true;
}

/**
 * Auto-route an entry to its correct folder based on category and primary characters.
 *
 * Routing rules:
 *   - "world" category → World folder (id: ml_folder_world)
 *   - "plot" category → Plot folder (id: ml_folder_plot)
 *   - "character" category:
 *     - Single primary → that character's subfolder under Characters (auto-created)
 *     - 2+ primaries → Group subfolder under Characters
 *
 * @param {object} entry - The entry to route
 * @returns {string} The destination folder ID
 */
export function routeEntry(entry) {
    const folders = getFolders();
    let folderId = "";

    if (entry.category === "world") {
        folderId = "ml_folder_world";
    } else if (entry.category === "plot") {
        folderId = "ml_folder_plot";
    } else if (entry.category === "character") {
        const primaries = entry.primaryCharacters || [];
        if (primaries.length >= 2) {
            // Multiple primary characters → Group subfolder
            folderId = getOrCreateGroupFolder(folders);
        } else if (primaries.length === 1) {
            // Single primary → that character's subfolder
            folderId = getOrCreateCharacterFolder(folders, primaries[0]);
        } else {
            // No primary characters — put in Characters folder root
            folderId = "ml_folder_characters";
        }
    }

    if (folderId) {
        updateEntry(entry.id, { folderId });
        incrementFolderEntryCount(folderId);
    }

    return folderId;
}

/**
 * Find or create a character subfolder under the Characters folder.
 * @param {Array} folders - Current folders array
 * @param {string} charName
 * @returns {string} Folder ID
 */
function getOrCreateCharacterFolder(folders, charName) {
    // (alias + name-order resolution happens below — stops duplicate folders)
    const normalized = resolveCanonicalCharacter(charName.trim());
    // Look for an existing subfolder with this character name
    const existing = folders.find(f =>
        f.parentId === "ml_folder_characters" &&
        f.characterName === normalized
    );
    if (existing) return existing.id;

    // Create a new character subfolder
    const newFolder = {
        id: `ml_folder_char_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: normalized,
        type: "subfolder",
        parentId: "ml_folder_characters",
        characterName: normalized,
        hasImage: false,
        imagePath: null,
        entryCount: 0,
        createdAt: Date.now(),
    };
    folders.push(newFolder);
    saveFolders(folders);
    console.log(`[ML] Auto-created character subfolder: "${normalized}"`);
    return newFolder.id;
}

/**
 * Find or create the Group subfolder under Characters.
 * The Group folder holds entries with 2+ primary characters.
 * @param {Array} folders - Current folders array
 * @returns {string} Folder ID
 */
function getOrCreateGroupFolder(folders) {
    const existing = folders.find(f =>
        f.parentId === "ml_folder_characters" &&
        f.name === "Group"
    );
    if (existing) return existing.id;

    const newFolder = {
        id: "ml_folder_group",
        name: "Group",
        type: "subfolder",
        parentId: "ml_folder_characters",
        characterName: null,
        hasImage: false,
        imagePath: null,
        entryCount: 0,
        createdAt: Date.now(),
    };
    folders.push(newFolder);
    saveFolders(folders);
    console.log("[ML] Auto-created Group subfolder");
    return newFolder.id;
}

/**
 * Increment the entry count on a folder.
 * @param {string} folderId
 */
function incrementFolderEntryCount(folderId) {
    const folders = getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
        folder.entryCount = (folder.entryCount || 0) + 1;
        saveFolders(folders);
    }
}

/**
 * Decrement the entry count on a folder.
 * @param {string} folderId
 */
function decrementFolderEntryCount(folderId) {
    const folders = getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
        folder.entryCount = Math.max(0, (folder.entryCount || 0) - 1);
        saveFolders(folders);
    }
}

// ─── Embedding Helpers ────────────────────────────────────

/**
 * Get entries that need embedding (have no vectorHash and are active/pinned).
 * @returns {object[]}
 */
export function getEntriesNeedingEmbedding() {
    const entries = getEntries();
    return Object.values(entries).filter(e =>
        !e.vectorHash &&
        (e.status === "active" || e.status === "pinned")
    );
}

/**
 * Set the vector hash on an entry after embedding.
 * @param {string} id
 * @param {number} hash - The text hash used as the vector key
 * @returns {object|null}
 */
export function setEntryVectorHash(id, hash) {
    return updateEntry(id, { vectorHash: hash });
}

// ─── Search ───────────────────────────────────────────────

/**
 * Search entries by title or content (case-insensitive substring match).
 * @param {string} query
 * @returns {object[]}
 */
export function searchEntries(query) {
    const entries = getEntries();
    const lower = query.toLowerCase();
    return Object.values(entries).filter(e =>
        e.title.toLowerCase().includes(lower) ||
        e.content.toLowerCase().includes(lower) ||
        (e.tags || []).some(t => t.toLowerCase().includes(lower))
    );
}
