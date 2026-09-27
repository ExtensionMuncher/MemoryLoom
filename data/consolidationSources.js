import { isEffectivelySuppressed } from './suppression.js';

export function isEligibleConsolidationSource(entry) {
    return !!entry && ['active', 'consolidation'].includes(entry.status)
        && !isEffectivelySuppressed(entry)
        && !entry.excludeFromConsolidation && !entry.consolidatedSourceOf
        && (entry.category !== 'world' || entry.worldEvent === true);
}

/** True when an entry still belongs to a consolidation source set. */
export function isConsolidationSource(entry) {
    return !!entry && (entry.status === 'consolidated' || !!entry.consolidatedSourceOf);
}
