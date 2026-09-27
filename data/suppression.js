import { getEntry, updateEntry } from "./entries.js";

// Consolidation is a reduced-priority retrieval state, never a suppression.
export const SUPPRESSION_REASONS = ["superseded", "manual"];

function makeId() {
    return `ml_suppression_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getStoredSuppressions(entry) {
    return Array.isArray(entry?.suppressions) ? entry.suppressions.filter(item => item?.reason) : [];
}

export function getEffectiveSuppressions(entry) {
    if (!entry) return [];
    // Ignore legacy consolidation records: they are migrated away on load, but
    // filtering here too keeps retrieval safe if an old object is seen first.
    const records = getStoredSuppressions(entry).filter(item => item.reason !== "consolidation");
    if (entry.status === "superseded" && !records.some(item => item.reason === "superseded")) {
        records.push({ id: "legacy-status-superseded", reason: "superseded", by: "legacy", timestamp: entry.updatedAt || entry.createdAt || 0, legacy: true });
    }
    if (entry.status === "archived") {
        records.push({ id: "status-archived", reason: "archived", by: "system", timestamp: entry.updatedAt || entry.createdAt || 0, locked: true });
    }
    return records;
}

export function isEffectivelySuppressed(entry) {
    return getEffectiveSuppressions(entry).length > 0;
}

function unsuppressedStatus(entry, removed = null) {
    const previous = removed?.previousStatus;
    if (previous && !["superseded", "archived"].includes(previous)) return previous;
    if (entry.consolidationId) return "consolidation";
    if (entry.consolidatedSourceOf && !entry.important) return "consolidated";
    return "active";
}

export function addSuppression(entryId, { reason = "manual", by = "user", timestamp = Date.now(), successorId = null, contextId = null } = {}) {
    const entry = getEntry(entryId);
    if (!entry) throw new Error("Suppression target no longer exists.");
    if (!SUPPRESSION_REASONS.includes(reason)) throw new Error(`Unsupported suppression reason: ${reason}`);
    if (successorId) {
        if (successorId === entryId) throw new Error("A memory cannot supersede itself.");
        if (!getEntry(successorId)) throw new Error("Suppression successor no longer exists.");
    }
    const suppressions = getStoredSuppressions(entry);
    const duplicate = suppressions.find(item => item.reason === reason
        && (item.successorId || null) === (successorId || null)
        && (item.contextId || null) === (contextId || null));
    if (duplicate) {
        if (reason === "superseded" && !["superseded", "archived"].includes(entry.status)) return updateEntry(entryId, { status: "superseded" });
        return entry;
    }
    const record = {
        id: makeId(), reason, by: String(by || "user"), timestamp: Number(timestamp) || Date.now(),
        successorId: successorId || null, contextId: contextId || null,
    };
    if (reason === "superseded") record.previousStatus = entry.status || unsuppressedStatus(entry);
    const updates = { suppressions: [...suppressions, record] };
    if (reason === "superseded" && entry.status !== "archived") updates.status = "superseded";
    return updateEntry(entryId, updates);
}

export function releaseSuppression(entryId, selector = null) {
    const entry = getEntry(entryId);
    if (!entry) throw new Error("Suppressed memory no longer exists.");
    if (entry.status === "archived") throw new Error("Archived memories must be restored through archive controls.");
    const stored = getStoredSuppressions(entry);
    const index = stored.findIndex(item => item.reason !== "consolidation" && (!selector || item.id === selector || item.reason === selector));
    if (index >= 0) {
        const next = stored.slice();
        const [removed] = next.splice(index, 1);
        const updates = { suppressions: next };
        if (entry.status === "superseded" && removed.reason === "superseded" && !next.some(item => item?.reason === "superseded")) {
            updates.status = unsuppressedStatus(entry, removed);
        }
        return updateEntry(entryId, updates);
    }
    if (entry.status === "superseded" && (!selector || selector === "superseded" || selector === "legacy-status-superseded")) {
        return updateEntry(entryId, { status: unsuppressedStatus(entry) });
    }
    throw new Error("That suppression reason is no longer present.");
}

export function getSuppressionSuccessors(entry) {
    return getEffectiveSuppressions(entry).map(item => item.successorId).filter(Boolean).map(getEntry).filter(Boolean);
}
