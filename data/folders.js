/**
 * data/folders.js — Folder and subfolder CRUD
 *
 * Manages the folder tree structure for Memory Loom's library.
 * Folders are stored as an array in chat_metadata.ml.folders.
 *
 * Folder types:
 *   - world/characters/plot: The three mandatory top-level folders (always present)
 *   - primary: User-created folders at the top level
 *   - subfolder: Folders inside other folders
 *
 * Characteristics:
 *   - Top-level folders: World, Characters, Plot are auto-created and cannot be deleted
 *   - Character subfolders: Under Characters, one per character, get image upload + new entry buttons
 *   - Group subfolder: Under Characters, for entries with 2+ primary characters, + button only
 *   - User primary folders: Sit alongside the top three, get + new entry button only
 *   - User subfolders: Can be created under any folder
 */


import { getFolders, saveFolders } from "./storage.js";

// ─── Constants ────────────────────────────────────────────

/**
 * The three mandatory top-level folder IDs. These are always present and cannot be deleted.
 */
export const DEFAULT_FOLDER_IDS = [
    "ml_folder_world",
    "ml_folder_characters",
    "ml_folder_plot",
];

/**
 * Valid folder types.
 */
export const FOLDER_TYPES = ["world", "characters", "plot", "primary", "subfolder"];

// ─── ID Generation ────────────────────────────────────────

/**
 * Generate a unique folder ID.
 * Format: ml_folder_{timestamp}_{random6}
 *
 * @returns {string}
 */
export function generateFolderId() {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    return `ml_folder_${ts}_${rand}`;
}

// ─── CRUD Operations ──────────────────────────────────────

/**
 * Create a new folder.
 *
 * @param {object} data
 * @param {string} data.name - Display name
 * @param {string} data.type - "world", "characters", "plot", "primary", or "subfolder"
 * @param {string|null} data.parentId - null for top-level, folder ID for subfolders
 * @param {string|null} [data.characterName] - Character name (only for character subfolders)
 * @returns {object} The created folder
 */
export function createFolder(data) {
    const folders = getFolders();

    const folder = {
        id: generateFolderId(),
        name: data.name || "Untitled",
        type: data.type || "primary",
        parentId: data.parentId || null,
        characterName: data.characterName || null,
        hasImage: false,
        imagePath: null,
        entryCount: 0,
        createdAt: Date.now(),
    };

    folders.push(folder);
    saveFolders(folders);
    console.log(`[ML] Folder created: ${folder.id} — "${folder.name}"`);
    return folder;
}

/**
 * Get a folder by ID.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getFolder(id) {
    const folders = getFolders();
    return folders.find(f => f.id === id);
}

/**
 * Get all folders as a flat array.
 * @returns {object[]}
 */
export function getAllFolders() {
    return getFolders();
}

/**
 * Get only top-level folders (parentId is null).
 * @returns {object[]}
 */
export function getTopLevelFolders() {
    const folders = getFolders();
    return folders.filter(f => f.parentId === null);
}

/**
 * Get subfolders of a given parent folder.
 * @param {string} parentId
 * @returns {object[]}
 */
export function getSubfolders(parentId) {
    const folders = getFolders();
    return folders.filter(f => f.parentId === parentId);
}

/**
 * Update a folder's properties.
 * @param {string} id
 * @param {object} updates - Fields to update
 * @returns {object|null} Updated folder or null if not found
 */
export function updateFolder(id, updates) {
    const folders = getFolders();
    const index = folders.findIndex(f => f.id === id);
    if (index === -1) return null;

    folders[index] = { ...folders[index], ...updates };
    saveFolders(folders);
    console.log(`[ML] Folder updated: ${id}`);
    return folders[index];
}

/**
 * Delete a folder.
 * Cannot delete the three default folders (World, Characters, Plot).
 *
 * @param {string} id
 * @returns {boolean} True if deleted
 */
export function deleteFolder(id) {
    // Prevent deletion of default folders
    if (DEFAULT_FOLDER_IDS.includes(id)) {
        console.warn(`[ML] Cannot delete default folder: ${id}`);
        return false;
    }

    const folders = getFolders();
    const index = folders.findIndex(f => f.id === id);
    if (index === -1) return false;

    // Also delete all subfolders of this folder
    const childIds = folders
        .filter(f => f.parentId === id)
        .map(f => f.id);
    for (const childId of childIds) {
        deleteFolder(childId);
    }

    folders.splice(index, 1);
    saveFolders(folders);
    console.log(`[ML] Folder deleted: ${id}`);
    return true;
}

// ─── Character Subfolder Helpers ──────────────────────────

// ─── Name Aliases & Canonical Resolution ──────────────────

/**
 * Set the alias list for a character folder.
 * Aliases are alternate names/nicknames the writer LLM might use for the same
 * character ("Jane", "Janey", "JD"). All of them resolve to
 * this folder's canonical character name, so memories never land in a
 * duplicate folder spawned by a name variant.
 */
export function setFolderAliases(folderId, aliases) {
    const list = Array.isArray(aliases) ? aliases : String(aliases || "").split(",");
    const clean = list.map(a => a.trim()).filter(Boolean);
    updateFolder(folderId, { aliases: clean });
    console.log(`[ML] Aliases for "${getFolder(folderId)?.name}": ${clean.join(", ") || "(none)"}`);
}

/**
 * Resolve any name variant to the canonical character name of an existing
 * character folder. Three matching layers, all case-insensitive:
 *   1. Exact match on a folder's character name
 *   2. Token-set match — "Doe Jane" and "Jane Doe" are the same
 *      words in a different order, so they resolve to the same folder
 *      automatically, no alias needed
 *   3. Alias match — user-defined nicknames stored on the folder
 * If nothing matches, the input is returned unchanged (a genuinely new
 * character should still create a new folder).
 */
export function resolveCanonicalCharacter(name) {
    const raw = String(name || "").replace(/\*+/g, "").trim();
    if (!raw) return raw;
    const lower = raw.toLowerCase();
    const tokenKey = lower.split(/\s+/).sort().join(" ");
    const folders = getFolders();
    for (const f of folders) {
        if (f.parentId !== "ml_folder_characters" || !f.characterName) continue;
        const canon = String(f.characterName).trim();
        const canonLower = canon.toLowerCase();
        if (lower === canonLower) return canon;
        if (tokenKey === canonLower.split(/\s+/).sort().join(" ")) return canon;
        for (const a of (f.aliases || [])) {
            if (lower === String(a).trim().toLowerCase()) return canon;
        }
    }
    return raw;
}

// ─── Entry Count Management ───────────────────────────────

/**
 * Increment the entry count on a folder.
 * Called when an entry is created or moved into this folder.
 *
 * @param {string} folderId
 */
export function incrementEntryCount(folderId) {
    const folders = getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
        folder.entryCount = (folder.entryCount || 0) + 1;
        saveFolders(folders);
    }
}

/**
 * Decrement the entry count on a folder.
 * Called when an entry is deleted or moved out of this folder.
 *
 * @param {string} folderId
 */
export function decrementEntryCount(folderId) {
    const folders = getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
        folder.entryCount = Math.max(0, (folder.entryCount || 0) - 1);
        saveFolders(folders);
    }
}

// ─── Image Management ─────────────────────────────────────

/**
 * Set a character subfolder's banner image.
 * Only applies to subfolders under Characters (character subfolders).
 *
 * @param {string} folderId
 * @param {string} dataUrl - Base64 data URL of the cropped image
 * @returns {object|null}
 */
export function setFolderImage(folderId, dataUrl) {
    const folder = getFolder(folderId);
    if (!folder) return null;

    return updateFolder(folderId, {
        hasImage: true,
        imagePath: dataUrl,
    });
}

// ─── Initialization ───────────────────────────────────────

/**
 * Ensure the three mandatory top-level folders exist.
 * Called once per chat on extension init. Safe to call multiple times.
 *
 * @returns {boolean} True if any folders were created
 */
export function initDefaultFolders() {
    const folders = getFolders();

    const defaults = [
        { id: "ml_folder_world", name: "World", type: "world", parentId: null },
        { id: "ml_folder_characters", name: "Characters", type: "characters", parentId: null },
        { id: "ml_folder_plot", name: "Plot", type: "plot", parentId: null },
    ];

    let changed = false;
    for (const df of defaults) {
        if (!folders.find(f => f.id === df.id)) {
            folders.push({
                ...df,
                characterName: null,
                hasImage: false,
                imagePath: null,
                entryCount: 0,
                createdAt: Date.now(),
            });
            changed = true;
        }
    }

    if (changed) {
        saveFolders(folders);
        console.log("[ML] Default folders initialized");
    }

    return changed;
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Check if a folder is a character subfolder (under Characters, has a characterName).
 * @param {object} folder
 * @returns {boolean}
 */
export function isCharacterSubfolder(folder) {
    return folder.parentId === "ml_folder_characters" && !!folder.characterName;
}

/**
 * Check if a folder is the Group subfolder.
 * @param {object} folder
 * @returns {boolean}
 */
export function isGroupFolder(folder) {
    return folder.id === "ml_folder_group";
}

/**
 * Determine what action buttons a folder should show in the library.
 * @param {object} folder
 * @returns {{showImageUpload: boolean, showNewEntry: boolean}}
 */
export function getFolderButtons(folder) {
    // Character subfolders (not Group) get image upload + new entry
    if (isCharacterSubfolder(folder) && !isGroupFolder(folder)) {
        return { showImageUpload: true, showNewEntry: true };
    }
    // Group subfolder gets new entry only (no image upload)
    if (isGroupFolder(folder)) {
        return { showImageUpload: false, showNewEntry: true };
    }
    // Subfolders under Characters that aren't character-named get image + entry
    if (folder.parentId === "ml_folder_characters" && !folder.characterName) {
        return { showImageUpload: true, showNewEntry: true };
    }
    // Custom subfolders (under World, Plot, or any custom top-level folder) also
    // get image upload + new entry — they're user-curated and may want a banner.
    if (folder.parentId && folder.parentId !== "ml_folder_characters") {
        return { showImageUpload: true, showNewEntry: true };
    }
    // Everything else gets new entry only
    return { showImageUpload: false, showNewEntry: true };
}

/**
 * Get the icon name for a folder type.
 * @param {string} type
 * @returns {string} SVG icon symbol ID
 */
export function getFolderIcon(type) {
    switch (type) {
        case "world": return "ico-globe";
        case "characters": return "ico-users";
        case "plot": return "ico-scroll";
        default: return "ico-folder-plus";
    }
}
