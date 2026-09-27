import {
    getChains, saveChains, getPendingChainProposals, savePendingChainProposals,
    getChainBatches, saveChainBatches, runChatTransaction, getEntries, saveEntries, getFolders,
} from "./storage.js";
import { getEntry, getAllEntries } from "./entries.js";

export const MAX_HISTORICAL_CHAIN_NODES = 8;

function normalizedCharacterNameKey(name) {
    return String(name || "")
        .replace(/\*+/g, "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(" ");
}

function folderCharacterName(folderId) {
    const folder = (getFolders() || []).find(item => item?.id === folderId);
    return String(folder?.characterName || "").trim();
}

export function getEntryPrimaryCharacterKeys(entry) {
    if (!entry) return new Set();
    const keys = new Set();
    const names = [...new Set([
        ...(Array.isArray(entry.primaryCharacters) ? entry.primaryCharacters : []),
        entry.primaryCharacter,
        folderCharacterName(entry.folderId),
    ].filter(Boolean))];
    for (const name of names) {
        const key = normalizedCharacterNameKey(name);
        if (key) keys.add(`name:${key}`);
    }
    if (String(entry.folderId || "").startsWith("ml_folder_char_")) keys.add(`folder:${entry.folderId}`);
    return keys;
}

function displayNameForOwnerKey(ownerKey, memoryIds = []) {
    if (String(ownerKey || "").startsWith("folder:")) {
        const folderId = ownerKey.slice(7);
        const fromFolder = folderCharacterName(folderId);
        if (fromFolder) return fromFolder;
    }
    const wantedNameKey = String(ownerKey || "").startsWith("name:") ? ownerKey.slice(5) : "";
    for (const id of memoryIds || []) {
        const entry = getEntry(id);
        const names = [...(entry?.primaryCharacters || []), entry?.primaryCharacter].filter(Boolean);
        for (const name of names) if (normalizedCharacterNameKey(name) === wantedNameKey) return String(name).trim();
        const fromFolder = folderCharacterName(entry?.folderId);
        if (normalizedCharacterNameKey(fromFolder) === wantedNameKey) return fromFolder;
    }
    return "";
}

export function resolveChainPrimaryCharacter(memoryIds = [], requestedPrimaryCharacter = "", requestedPrimaryCharacterKey = "") {
    const entries = sortMemoryIds(memoryIds).map(getEntry).filter(Boolean);
    if (!entries.length) return null;
    let shared = null;
    for (const entry of entries) {
        const keys = getEntryPrimaryCharacterKeys(entry);
        shared = shared === null ? keys : new Set([...shared].filter(key => keys.has(key)));
    }
    const requestedNameKey = normalizedCharacterNameKey(requestedPrimaryCharacter);
    const requestedKeys = [requestedPrimaryCharacterKey, requestedNameKey ? `name:${requestedNameKey}` : ""].filter(Boolean);
    let ownerKey = requestedKeys.find(key => shared?.has(key)) || "";
    if ((requestedPrimaryCharacter || requestedPrimaryCharacterKey) && !ownerKey) return null;
    if (!ownerKey) {
        const nameKey = [...(shared || [])].find(key => key.startsWith("name:"));
        const folderKey = [...(shared || [])].find(key => key.startsWith("folder:"));
        // Prefer the canonical character-name identity so a genuinely joint
        // memory can still participate in each owner's separate chain. Character
        // folders are also folded into this name key, so name-order variants and
        // older typoed primary fields do not split one character into two.
        ownerKey = nameKey || folderKey || "";
    }
    if (!ownerKey) return null;
    const primaryCharacter = requestedPrimaryCharacter || displayNameForOwnerKey(ownerKey, memoryIds);
    return { primaryCharacter: primaryCharacter || "Character", primaryCharacterKey: ownerKey };
}

export function entryBelongsToChainCharacter(entry, chain) {
    if (!entry || !chain) return false;
    const owner = resolveChainPrimaryCharacter(chain.memoryIds || [], chain.primaryCharacter || "", chain.primaryCharacterKey || "");
    if (!owner) return false;
    return getEntryPrimaryCharacterKeys(entry).has(owner.primaryCharacterKey);
}

function makeId(prefix = "ml_chain") {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function chronology(entry) {
    const parsed = Date.parse(String(entry?.datetime || ""));
    if (Number.isFinite(parsed)) return parsed;
    return Number(entry?.createdAt || entry?.updatedAt || 0);
}

export function sortMemoryIds(memoryIds) {
    const unique = [...new Set((memoryIds || []).filter(Boolean))];
    return unique.sort((a, b) => {
        const left = getEntry(a), right = getEntry(b);
        const delta = chronology(left) - chronology(right);
        return delta || Number(left?.createdAt || 0) - Number(right?.createdAt || 0) || a.localeCompare(b);
    });
}

export function getAllChains() {
    return Object.values(getChains() || {});
}

export function getChain(id) {
    return getChains()?.[id] || null;
}

export function getOrderedChainEntries(chainOrId) {
    const chain = typeof chainOrId === "string" ? getChain(chainOrId) : chainOrId;
    return sortMemoryIds(chain?.memoryIds || []).map(getEntry).filter(Boolean);
}

function syncMembership(chainId, oldIds, newIds) {
    const oldSet = new Set(oldIds || []), nextSet = new Set(newIds || []);
    const entries = getEntries();
    let changed = false;
    for (const id of new Set([...oldSet, ...nextSet])) {
        const entry = entries[id];
        if (!entry) continue;
        const memberships = new Set(Array.isArray(entry.chainIds) ? entry.chainIds : []);
        if (nextSet.has(id)) memberships.add(chainId); else memberships.delete(chainId);
        const next = [...memberships];
        if (JSON.stringify(next) !== JSON.stringify(entry.chainIds || [])) {
            entry.chainIds = next;
            changed = true;
        }
    }
    if (changed) saveEntries(entries);
}

export function createChain({ label, description = "", memoryIds = [], id = null, primaryCharacter = "", primaryCharacterKey = "", source = "manual" } = {}) {
    const ordered = sortMemoryIds(memoryIds);
    if (ordered.length < 2) throw new Error("A memory chain requires at least two existing memories.");
    if (ordered.some(memoryId => !getEntry(memoryId))) throw new Error("A proposed chain contains a missing memory.");
    const owner = resolveChainPrimaryCharacter(ordered, primaryCharacter, primaryCharacterKey);
    if (!owner) throw new Error("A memory chain must be character-specific: every chained memory must belong to the same Primary Character. Key Characters do not qualify.");
    const chains = getChains();
    const chainId = id || makeId();
    if (chains[chainId]) throw new Error("That chain already exists.");
    const now = Date.now();
    const normalizedLabel = String(label || "").trim() || "Developmental thread";
    const chain = {
        id: chainId,
        label: normalizedLabel,
        description: String(description || "").trim(),
        primaryCharacter: owner.primaryCharacter,
        primaryCharacterKey: owner.primaryCharacterKey,
        memoryIds: ordered,
        source: String(source || "manual").trim() || "manual",
        createdAt: now,
        updatedAt: now,
    };
    chains[chainId] = chain;
    saveChains(chains);
    syncMembership(chainId, [], ordered);
    return chain;
}

/**
 * Update chain metadata and/or membership atomically. The same single-owner
 * invariant used for automatic chains is enforced for manual editing too.
 */
export function updateChain(chainId, { label, description, memoryIds, primaryCharacter, primaryCharacterKey } = {}) {
    const chains = getChains();
    const chain = chains?.[chainId];
    if (!chain) throw new Error("Chain no longer exists.");

    const oldIds = [...(chain.memoryIds || [])];
    const nextIds = memoryIds === undefined ? oldIds : sortMemoryIds(memoryIds);
    if (nextIds.length < 2) throw new Error("A memory chain requires at least two existing memories.");
    if (nextIds.some(memoryId => !getEntry(memoryId))) throw new Error("A proposed chain contains a missing memory.");

    const requestedPrimaryCharacter = primaryCharacter === undefined ? (chain.primaryCharacter || "") : primaryCharacter;
    const requestedPrimaryCharacterKey = primaryCharacterKey === undefined ? (chain.primaryCharacterKey || "") : primaryCharacterKey;
    const owner = resolveChainPrimaryCharacter(nextIds, requestedPrimaryCharacter, requestedPrimaryCharacterKey);
    if (!owner) throw new Error("A memory chain must be character-specific: every chained memory must belong to the same Primary Character. Key Characters do not qualify.");

    if (label !== undefined) chain.label = String(label || "").trim() || "Developmental thread";
    if (description !== undefined) chain.description = String(description || "").trim();
    chain.primaryCharacter = owner.primaryCharacter;
    chain.primaryCharacterKey = owner.primaryCharacterKey;
    chain.memoryIds = nextIds;
    chain.updatedAt = Date.now();
    chains[chainId] = chain;
    saveChains(chains);
    syncMembership(chainId, oldIds, nextIds);
    return chain;
}

/**
 * Character choices that can own a chain. Only Primary Character identity is
 * considered; Key Characters never appear here as chain owners.
 */
export function getChainCharacterOptions() {
    const options = new Map();
    for (const entry of getAllEntries()) {
        if (!entry || entry.category !== "character") continue;
        const names = [...new Set([
            ...(Array.isArray(entry.primaryCharacters) ? entry.primaryCharacters : []),
            entry.primaryCharacter,
            folderCharacterName(entry.folderId),
        ].filter(Boolean).map(name => String(name).trim()).filter(Boolean))];
        for (const name of names) {
            const nameKey = normalizedCharacterNameKey(name);
            if (!nameKey) continue;
            const key = `name:${nameKey}`;
            if (!getEntryPrimaryCharacterKeys(entry).has(key)) continue;
            const current = options.get(key) || { key, name, count: 0 };
            current.count += 1;
            // Prefer the longer/canonical-looking spelling when aliases differ
            // only by token order/case.
            if (name.length > String(current.name || "").length) current.name = name;
            options.set(key, current);
        }
    }
    return [...options.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function addMemoryToChain(chainId, memoryId) {
    const chain = getChain(chainId), entry = getEntry(memoryId);
    if (!chain || !entry) throw new Error("Chain or memory no longer exists.");
    const owner = resolveChainPrimaryCharacter(chain.memoryIds || [], chain.primaryCharacter || "", chain.primaryCharacterKey || "");
    if (!owner || !getEntryPrimaryCharacterKeys(entry).has(owner.primaryCharacterKey)) {
        throw new Error("This memory belongs to a different Primary Character and cannot be added to this chain.");
    }
    chain.primaryCharacter = owner.primaryCharacter;
    chain.primaryCharacterKey = owner.primaryCharacterKey;
    const oldIds = [...(chain.memoryIds || [])];
    chain.memoryIds = sortMemoryIds([...oldIds, memoryId]);
    chain.updatedAt = Date.now();
    saveChains(getChains());
    syncMembership(chainId, oldIds, chain.memoryIds);
    return chain;
}

export function removeMemoryFromChain(chainId, memoryId) {
    const chain = getChain(chainId);
    if (!chain) throw new Error("Chain no longer exists.");
    const oldIds = [...(chain.memoryIds || [])];
    const nextIds = oldIds.filter(id => id !== memoryId);
    if (nextIds.length < 2) return deleteChain(chainId);
    chain.memoryIds = sortMemoryIds(nextIds);
    chain.updatedAt = Date.now();
    saveChains(getChains());
    syncMembership(chainId, oldIds, chain.memoryIds);
    return chain;
}

export function deleteChain(chainId) {
    const chains = getChains(), chain = chains[chainId];
    if (!chain) return false;
    delete chains[chainId];
    saveChains(chains);
    syncMembership(chainId, chain.memoryIds || [], []);
    return true;
}

export function rebuildChainMembership() {
    const chains = getChains(), entries = getEntries();
    const memberships = new Map(Object.keys(entries).map(id => [id, []]));
    let links = 0;
    for (const [storedId, chain] of Object.entries(chains)) {
        // Treat the map key as authoritative. Imported/hand-edited metadata can
        // otherwise leave a chain whose inner id differs from the key used by
        // every membership reference.
        if (!chain || typeof chain !== "object") {
            delete chains[storedId];
            continue;
        }
        chain.id = storedId;
        const valid = sortMemoryIds(Array.isArray(chain.memoryIds) ? chain.memoryIds : []).filter(id => getEntry(id));
        const owner = resolveChainPrimaryCharacter(valid, chain.primaryCharacter || "", chain.primaryCharacterKey || "")
            || resolveChainPrimaryCharacter(valid);
        if (valid.length < 2 || !owner) {
            delete chains[storedId];
            continue;
        }
        chain.memoryIds = valid;
        chain.primaryCharacter = owner.primaryCharacter;
        chain.primaryCharacterKey = owner.primaryCharacterKey;
        chain.updatedAt = chain.updatedAt || Date.now();
        for (const id of valid) memberships.get(id).push(storedId);
        links += valid.length;
    }
    for (const [id, entry] of Object.entries(entries)) entry.chainIds = memberships.get(id) || [];
    saveEntries(entries);
    saveChains(chains);
    return { chains: Object.keys(chains).length, links };
}

export function validateChains({ repair = false } = {}) {
    const chains = getChains(), entries = new Map(getAllEntries().map(entry => [entry.id, entry]));
    const issues = [];
    for (const [storedId, chain] of Object.entries(chains)) {
        if (!chain || typeof chain !== "object") {
            issues.push({ type: "invalid-chain-record", chainId: storedId });
            continue;
        }
        if (!chain.id || chain.id !== storedId) issues.push({ type: "invalid-chain-id", chainId: storedId });
        const ids = Array.isArray(chain.memoryIds) ? chain.memoryIds : [];
        if (!Array.isArray(chain.memoryIds)) issues.push({ type: "invalid-memory-list", chainId: storedId });
        const owner = resolveChainPrimaryCharacter(ids, chain.primaryCharacter || "", chain.primaryCharacterKey || "");
        if (!owner) issues.push({ type: "mixed-primary-characters", chainId: storedId });
        else {
            if (!chain.primaryCharacter || !chain.primaryCharacterKey) issues.push({ type: "missing-chain-primary", chainId: storedId });
            for (const id of ids) {
                const entry = entries.get(id);
                if (entry && !getEntryPrimaryCharacterKeys(entry).has(owner.primaryCharacterKey)) {
                    issues.push({ type: "mixed-primary-characters", chainId: storedId, memoryId: id });
                }
            }
        }
        for (const id of ids) {
            if (!entries.has(id)) issues.push({ type: "dangling-memory", chainId: storedId, memoryId: id });
            else if (!(entries.get(id).chainIds || []).includes(storedId)) issues.push({ type: "missing-membership", chainId: storedId, memoryId: id });
        }
        if (new Set(ids).size !== ids.length) issues.push({ type: "duplicate-memory", chainId: storedId });
        if (ids.filter(id => entries.has(id)).length < 2) issues.push({ type: "too-short", chainId: storedId });
    }
    for (const entry of entries.values()) for (const chainId of (entry.chainIds || [])) {
        if (!chains[chainId] || !(chains[chainId].memoryIds || []).includes(entry.id)) issues.push({ type: "dangling-membership", chainId, memoryId: entry.id });
    }
    if (repair) {
        // Rebuild also canonicalizes mismatched ids, drops malformed records,
        // removes dangling nodes, and deletes chains that can no longer meet
        // the two-memory invariant.
        rebuildChainMembership();
    }
    return { valid: issues.length === 0, issues };
}

function normalizeHistoricalProposal(item = {}) {
    const memoryIds = sortMemoryIds(item.memoryIds).filter(id => getEntry(id));
    if (memoryIds.length > MAX_HISTORICAL_CHAIN_NODES) {
        throw new Error(`Historical chain proposals are limited to ${MAX_HISTORICAL_CHAIN_NODES} sparse milestones; received ${memoryIds.length}. No proposals were changed.`);
    }
    const owner = resolveChainPrimaryCharacter(memoryIds, item.primaryCharacter || "", item.primaryCharacterKey || "");
    if (memoryIds.length >= 2 && !owner) {
        throw new Error("Historical chain proposals must be character-specific: every memory must belong to the same Primary Character. Key Characters do not qualify.");
    }
    return {
        id: item.id || makeId("ml_chain_proposal"),
        label: String(item.label || "").trim() || "Developmental thread",
        description: String(item.description || "").trim(),
        primaryCharacter: owner?.primaryCharacter || String(item.primaryCharacter || "").trim(),
        primaryCharacterKey: owner?.primaryCharacterKey || String(item.primaryCharacterKey || "").trim(),
        memoryIds,
        approved: item.approved === true,
        source: "historical_scan",
        createdAt: item.createdAt || Date.now(),
    };
}

export function saveChainProposals(proposals, { skipInvalid = false } = {}) {
    // Validate the whole preview batch before replacing the stored proposals.
    // This is deliberately duplicated below at apply-time so imported or stale
    // proposal state cannot bypass the historical-scan size contract.
    const valid = [];
    for (const proposal of (proposals || [])) {
        try {
            const normalized = normalizeHistoricalProposal(proposal);
            if (normalized.memoryIds.length >= 2) valid.push(normalized);
        } catch (error) {
            if (!skipInvalid) throw error;
            console.warn("[ML] Skipping invalid chain proposal:", error.message);
        }
    }
    savePendingChainProposals(valid);
    return valid;
}

export function setChainProposalApproval(proposalId, approved) {
    const proposals = getPendingChainProposals();
    const proposal = proposals.find(item => item.id === proposalId);
    if (!proposal) return false;
    proposal.approved = approved === true;
    savePendingChainProposals(proposals);
    return true;
}

export function applyApprovedChainProposals() {
    const approvedRaw = getPendingChainProposals().filter(item => item.approved);
    if (!approvedRaw.length) return { applied: 0 };
    // Revalidate before the first mutation. Imported exports, hand-edited chat
    // metadata, or a stale scanner must not be able to create an exhaustive
    // historical mega-chain through the apply path. Organic scene-close growth
    // remains unbounded because only this historical proposal path is capped.
    const approved = approvedRaw.map(normalizeHistoricalProposal).filter(item => item.memoryIds.length >= 2);
    return runChatTransaction(() => {
        const created = approved.map(({ id: _proposalId, approved: _approved, createdAt: _proposalCreatedAt, ...item }) => createChain(item));
        const batches = getChainBatches();
        batches.push({ id: makeId("ml_chain_batch"), createdAt: Date.now(), chainIds: created.map(chain => chain.id) });
        saveChainBatches(batches.slice(-10));
        savePendingChainProposals(getPendingChainProposals().filter(item => !item.approved));
        return { applied: created.length, chains: created };
    });
}

export function undoLastChainBatch() {
    const batches = [...getChainBatches()];
    const batch = batches.at(-1);
    if (!batch) return false;
    return runChatTransaction(() => {
        // Applying a proposal batch only creates chains, so undo only those
        // chain IDs. Restoring the entire old snapshot would erase unrelated
        // manual edits or chains created after the batch.
        for (const chainId of (batch.chainIds || [])) deleteChain(chainId);
        saveChainBatches(batches.slice(0, -1));
        return true;
    });
}

/** Apply one validated writer proposal after its new pending memory receives an ID. */
export function applyWriterChainAction(newEntry, action) {
    if (!newEntry || !action || action.action === "none") return null;
    if (action.action === "append") {
        const chain = action.chainId ? getChain(action.chainId) : null;
        if (!chain) throw new Error("Writer referenced an invalid chain.");
        const updates = { memoryIds: [...(chain.memoryIds || []), newEntry.id] };
        const revisedDescription = String(action.revisedDescription || "").trim();
        const revisedLabel = String(action.revisedLabel || "").trim();
        if (revisedDescription) updates.description = revisedDescription;
        if (revisedLabel) updates.label = revisedLabel;
        return updateChain(action.chainId, updates);
    }
    if (action.action === "create") {
        const existing = [...new Set(action.memoryIds || [])];
        if (existing.some(id => !getEntry(id) || id === newEntry.id)) throw new Error("Writer referenced an invalid memory for a new chain.");
        return createChain({ label: action.label, description: action.description, memoryIds: [...existing, newEntry.id], source: "organic" });
    }
    throw new Error("Writer returned an unsupported chain action.");
}

/**
 * Apply zero or more independent organic chain actions for one new memory.
 * Multi-membership is intentional: one episode may advance several distinct
 * developmental threads for the same Primary Character.
 */
export function applyWriterChainActions(newEntry, actions) {
    const list = Array.isArray(actions) ? actions : (actions ? [actions] : []);
    const results = [];
    for (const action of list) {
        if (!action || action.action === "none") continue;
        results.push(applyWriterChainAction(newEntry, action));
    }
    return results;
}
