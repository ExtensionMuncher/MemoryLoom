import { getEntry, updateEntry } from './entries.js';
import { captureChatGuard } from '../lib/chatGuard.js';

export function isEligibleConsolidationSource(entry) {
    return !!entry && ['active', 'consolidation'].includes(entry.status)
        && !entry.excludeFromConsolidation && !entry.consolidatedSourceOf
        && !entry.consolidationReleased
        && (entry.category !== 'world' || entry.worldEvent === true);
}

/** True when an entry still belongs to a consolidation source set. */
export function isConsolidationSource(entry) {
    return !!entry && (entry.status === 'consolidated' || !!entry.consolidatedSourceOf);
}

/** True when consolidation priority reduction is currently applied. */
export function isSourceSuppressed(entry) {
    return isConsolidationSource(entry) && entry.status === 'consolidated';
}

/**
 * Consolidation sources can be released or suppressed without losing their
 * provenance. This deliberately includes important/starred sources: older
 * builds kept those active after consolidation, so they need a direct path to
 * retirement even when consolidationReleased was never written.
 */
export function canToggleSourceSuppression(entry) {
    return isConsolidationSource(entry)
        && ['active', 'consolidation', 'consolidated'].includes(entry.status);
}

/** Change retrieval status without erasing consolidation provenance or outputs. */
export function setSourceReleased(id, released) {
    captureChatGuard()();
    const entry = getEntry(id);
    if (!entry) throw new Error('This memory no longer exists.');
    if (!canToggleSourceSuppression(entry))
        throw new Error('This memory is not a consolidation source that can be suppressed.');
    if (released) {
        if (!isSourceSuppressed(entry)) throw new Error('This consolidation source is already unsuppressed.');
        return updateEntry(id, {
            status: entry.consolidationId ? 'consolidation' : 'active',
            consolidationReleased: true,
        });
    }
    if (isSourceSuppressed(entry)) throw new Error('This consolidation source is already suppressed.');
    return updateEntry(id, { status: 'consolidated', consolidationReleased: false });
}
