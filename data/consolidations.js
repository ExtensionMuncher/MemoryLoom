/**
 * data/consolidations.js — Consolidation entry CRUD
 *
 * Consolidations combine multiple memory entries and scene summaries
 * into higher-level carry-forward context. They are stored in the Plot
 * folder and can be injected like regular entries.
 *
 * IMPORTANT: Consolidation does not delete source memories. Source entries
 * remain searchable but have reduced injection priority.
 */


import { getConsolidations, saveConsolidations } from "./storage.js";

// ─── ID Generation ────────────────────────────────────────

export function generateConsolidationId() {
    return `ml_consolidation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── CRUD ─────────────────────────────────────────────────

export function createConsolidation(data) {
    const consolidations = getConsolidations();
    const id = data.id || generateConsolidationId();

    consolidations[id] = {
        id,
        title: data.title || "Untitled Consolidation",
        type: data.type || "mixed_consolidation",
        scope: data.scope || { folders: [], sourceIds: [] },
        timeRange: data.timeRange || "",
        before_state: data.before_state || "",
        after_state: data.after_state || "",
        summary: data.summary || "",
        preferred_injection: data.preferred_injection || "",
        carry_forward_context: data.carry_forward_context || [],
        key_changes: data.key_changes || [],
        character_impact: data.character_impact || [],
        relationship_impact: data.relationship_impact || [],
        plot_impact: data.plot_impact || [],
        world_impact: data.world_impact || [],
        source_memories: data.source_memories || [],
        status_updates: data.status_updates || [],
        tags: data.tags || [],
        status: data.status || "active",
        vectorHash: data.vectorHash || null,
        stickiness: data.stickiness || 0,
        cooldown: data.cooldown || 0,
        createdAt: data.createdAt || Date.now(),
        updatedAt: Date.now(),
    };

    saveConsolidations(consolidations);
    console.log(`[ML] Consolidation created: ${id}`);
    return consolidations[id];
}

export function getConsolidation(id) {
    const consolidations = getConsolidations();
    return consolidations[id] || null;
}

export function getAllConsolidations() {
    return Object.values(getConsolidations());
}

export function updateConsolidation(id, updates) {
    const consolidations = getConsolidations();
    if (!consolidations[id]) return null;
    consolidations[id] = { ...consolidations[id], ...updates, updatedAt: Date.now() };
    saveConsolidations(consolidations);
    return consolidations[id];
}

export function deleteConsolidation(id) {
    const consolidations = getConsolidations();
    if (!consolidations[id]) return false;
    delete consolidations[id];
    saveConsolidations(consolidations);
    return true;
}

/**
 * Apply status updates from a consolidation to source entries.
 * Typically sets source entries from "active" → "consolidated".
 *
 * @param {Array<{sourceId: string, newStatus: string}>} statusUpdates
 */
export function applyStatusUpdates(statusUpdates) {
    if (!statusUpdates || statusUpdates.length === 0) return;

    // Dynamic import to avoid circular dependency
    import("./entries.js").then(({ updateEntry }) => {
        for (const update of statusUpdates) {
            updateEntry(update.sourceId, { status: update.newStatus });
        }
        console.log(`[ML] Applied ${statusUpdates.length} status updates from consolidation`);
    });
}
