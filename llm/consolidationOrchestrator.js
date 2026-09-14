import { isEligibleConsolidationSource } from '../data/consolidationSources.js';
import { runChatTransaction } from "../data/storage.js";
import { captureChatGuard } from "../lib/chatGuard.js";
/**
 * llm/consolidationOrchestrator.js — Consolidation flow controller
 *
 * Wires the existing consolidator engine (llm/consolidator.js) into the rest
 * of the extension. Turns one consolidation into TWO concrete outputs, per the
 * approved design:
 *
 *   1. UPDATED CHARACTER MEMORIES — a fresh, compact memory per character
 *      involved, capturing their after-state for the arc. Filed into that
 *      character's folder (or Group for joint), embedded, badged "consolidated"
 *      via tag, and high priority.
 *
 *   2. AN ARC SUMMARY — a single plot-level entry holding the whole arc's
 *      summary + plot/world impact. Filed into the Plot folder.
 *
 * The original source memories are NOT deleted — they're flagged status
 * "consolidated", which the retriever keeps but down-weights, so they remain
 * available to the recall tool and to close keyword matches at reduced
 * priority.
 *
 * Both a MANUAL trigger (library button / bulk selection / folder) and an
 * AUTOMATIC trigger (a character folder crossing a configurable memory count)
 * funnel through runConsolidation().
 */

import { generateConsolidation, generateCharacterConsolidatedMemory } from "./consolidator.js";
import { createConsolidation, getConsolidation, deleteConsolidation } from "../data/consolidations.js";
import { getEntry, getEntriesByFolder, getAllEntries, createEntry, setEntryStatus, updateEntry, deleteEntry } from "../data/entries.js";
import { getScene, getAllScenes, markSceneConsolidated, unmarkSceneConsolidated } from "../data/scenes.js";
import { embedEntry, deleteEntryVector } from "../embed/embedder.js";
import { getSetting } from "../settings.js";
import { dlog } from "../lib/debug.js";
import { getAllFolders, updateFolder, resolveCanonicalCharacter } from "../data/folders.js";

/**
 * Run a consolidation over a set of source entries (+ optional scenes).
 *
 * @param {object} opts
 * @param {string[]} opts.entryIds      - source memory entry ids
 * @param {string[]} [opts.sceneIds]    - source scene ids
 * @param {string}   [opts.mode]        - "selected" | "folder" | "mixed"
 * @param {boolean}  [opts.silent]      - suppress success toast (auto-trigger)
 * @returns {Promise<object|null>} { consolidation, updatedMemories, arcSummary } or null
 */
export async function runConsolidation({ entryIds = [], sceneIds = [], mode = "selected", silent = false }) {
    const assertChat = captureChatGuard();
    const sourceEntries = [...new Set(entryIds)].map(getEntry).filter(Boolean);
    if (sourceEntries.length !== new Set(entryIds).size || sourceEntries.some(e => !isEligibleConsolidationSource(e)))
        throw new Error("Selection includes missing or ineligible memories. Reopen the consolidation menu.");
    const sourceScenes = sceneIds.map(getScene).filter(Boolean);
    // Consolidation performs several awaited LLM calls and folder-routing saves.
    // Preserve identity metadata independently so no stale save can erase aliases.
    const aliasSnapshot = snapshotCharacterAliases();
    const sourceSnapshot = JSON.stringify([sourceEntries, sourceScenes]);
    const foldersSnapshot = JSON.stringify(getAllFolders());
    const assertSources = () => {
        assertChat();
        if (JSON.stringify(getAllFolders()) !== foldersSnapshot) throw new Error("Consolidation cancelled: folders or aliases changed. Run it again.");
        if (JSON.stringify([sourceEntries.map(e => getEntry(e.id)), sourceScenes.map(s => getScene(s.id))]) !== sourceSnapshot)
            throw new Error("Consolidation cancelled: source memories or scenes changed. Run it again.");
    };

    if (sourceEntries.length < 2) {
        if (!silent) toastr?.warning?.("Select at least 2 memories to consolidate.", "Memory Loom");
        return null;
    }

    dlog(`Consolidation: ${sourceEntries.length} entries, ${sourceScenes.length} scenes, mode=${mode}`);
    if (!silent) toastr?.info?.("Consolidating — this may take a moment...", "Memory Loom");

    const draft = await generateConsolidation({ mode, sourceEntries, sourceScenes });
    assertSources();
    if (!draft) {
        if (!silent) toastr?.error?.("Consolidation failed — check the Consolidation LLM in Settings > Connections.", "Memory Loom");
        return null;
    }
    assertSources();

    // Save the exact source state so undo can restore both retrieval priority
    // and consolidation-picker eligibility without guessing.
    draft.source_entry_states = Object.fromEntries(sourceEntries.map(e => [e.id, {
        status: e.status || "active",
        consolidatedSourceOf: e.consolidatedSourceOf || null,
        consolidationReleased: e.consolidationReleased || false,
    }]));
    draft.source_scene_states = Object.fromEntries(sourceScenes.map(s => [s.id, {
        consolidatedInto: s.consolidatedInto || null,
    }]));

    // Persist the consolidation record itself (for the library/audit trail)
    // Generate every character output before changing any stored state.
    const staged = [];

    // ── 1. Updated character memories ────────────────────
    // ONE PER CHARACTER, each WRITTEN INDIVIDUALLY by the LLM from that
    // character's perspective, using only the source memories that character
    // actually appears in. (The old code pasted the same arc summary into every
    // folder — that produced identical, doubled, generically-titled entries.)
    const updatedMemories = [];
    const charNames = collectPrimaryCharacters(sourceEntries);
    for (const charName of charNames) {
        // memories this character is involved in (primary OR key)
        const relevant = sourceEntries.filter(e => characterInEntry(e, charName));
        if (relevant.length === 0) continue;

        if (!silent) {
            const msg = `Writing ${charName}'s consolidated memory…`;
            try { const { showPanelLoading, setProcessingStatus } = await import("../ui/panel.js"); showPanelLoading(msg); setProcessingStatus(msg); } catch (e) {}
        }

        assertSources();
        const written = await generateCharacterConsolidatedMemory(charName, relevant, draft);
        assertSources();
        if (!written) throw new Error(`Consolidation cancelled: no synthesis for ${charName}. Sources were not changed.`);
        if (!written.delta) throw new Error(`Consolidation cancelled: incomplete delta for ${charName}. Sources were not changed.`);
        staged.push({ charName, written });
    }
    assertSources();
    // Input provenance belongs to the caller, not model-returned IDs.
    draft.source_memories = sourceEntries.map(e => e.id);
    const { consolidation, arcSummary } = runChatTransaction(() => {
    const consolidation = createConsolidation(draft);
    for (const { charName, written } of staged) {
        const mem = createEntry({
            title: written.title,
            datetime: written.datetime || draft.timeRange || "",
            content: written.content,
            primaryCharacter: charName,
            primaryCharacters: [charName],
            keyCharacters: [],
            category: "character",
            status: "consolidation",
            delta: written.delta,
            // Per-character tags specific to THIS character's arc experience.
            // Fall back to arc-level tags only if the model returned none.
            tags: (written.tags && written.tags.length) ? written.tags : [...(draft.tags || [])],
            consolidationId: consolidation.id,
        });
        updatedMemories.push(mem);

    }

    // ── 2. Arc summary → Plot folder ─────────────────────
    const arcBody = buildArcSummaryBody(draft);
    const arcSummary = createEntry({
        title: `Arc: ${draft.title}`,
        datetime: draft.timeRange || "",
        content: arcBody,
        primaryCharacter: "",
        primaryCharacters: [],
        keyCharacters: [],
        category: "plot",                            // routeEntry files category "plot" into the Plot folder
        status: "consolidation",
        delta: buildArcDelta(draft, sourceEntries),
        tags: [...(draft.tags || []), "arc-summary"],
        consolidationId: consolidation.id,
    });


    // ── 3. Demote source memories (non-destructive) ──────
    // Important/core memories are NEVER demoted — the user flagged them as
    // pivotal and they keep full priority even after being folded into an arc.
    // But ALL sources (starred included) get stamped with consolidatedSourceOf so
    // they don't reappear in the consolidate modal as if never consolidated.
    for (const e of sourceEntries) {
        updateEntry(e.id, { consolidatedSourceOf: consolidation.id });
        if (e.important) continue;
        setEntryStatus(e.id, "consolidated");
    }

    // ── 3b. Mark source scenes consolidated ──────────────
    // Stamps consolidatedInto on each scene so it drops out of the consolidate
    // modal AND moves into the consolidated-scenes folder under the Scenes tab.
    dlog(`Consolidation: marking ${sourceScenes.length} scene(s) as consolidated into ${consolidation.id}`);
    for (const s of sourceScenes) {
        markSceneConsolidated(s.id, consolidation.id);
    }

    // Routing preserves folder objects; retain aliases through the synchronous commit.
    restoreCharacterAliases(aliasSnapshot);
    return { consolidation, arcSummary };
    });
    for (const output of [...updatedMemories, arcSummary]) {
        assertChat();
        await embedEntry(output).catch(err => console.warn("[ML] Consolidation embed failed:", err));
    }
    assertChat();

    dlog(`Consolidation done: ${updatedMemories.length} updated memories + 1 arc summary; ${sourceEntries.length} sources demoted`);
    if (!silent) {
        toastr?.success?.(
            `Consolidated ${sourceEntries.length} memories → ${updatedMemories.length} updated ${updatedMemories.length === 1 ? "memory" : "memories"} + 1 arc summary.`,
            "Memory Loom", { timeOut: 6000 }
        );
    }
    return { consolidation, updatedMemories, arcSummary };
}

/** Fully reverse a consolidation, including its suppression markers. */
export async function undoConsolidation(consolidationId) {
    const assertChat = captureChatGuard();
    const consolidation = getConsolidation(consolidationId);
    if (!consolidation) return null;

    const outputs = getAllEntries().filter(e => e.consolidationId === consolidationId);
    if (outputs.some(e => e.consolidatedSourceOf && e.consolidatedSourceOf !== consolidationId))
        throw new Error("Undo the newer consolidation first; it still uses these outputs.");
    const sourceIds = new Set([
        ...Object.keys(consolidation.source_entry_states || {}),
        ...(Array.isArray(consolidation.source_memories) ? consolidation.source_memories : []),
        ...(Array.isArray(consolidation.status_updates)
            ? consolidation.status_updates.filter(u => u?.sourceId && u?.newStatus === "consolidated").map(u => u.sourceId)
            : []),
    ]);
    const savedStates = consolidation.source_entry_states || {};
    let restoredEntries = 0;
    let restoredScenes = 0;
    let removedOutputs = 0;

    runChatTransaction(() => {
        // Remove only memories generated by this consolidation. Inputs created
        // by an earlier consolidation carry a different consolidationId and survive.
        for (const entry of getAllEntries()) {
            if (entry.consolidationId !== consolidationId) continue;
            if (deleteEntry(entry.id)) removedOutputs++;
        }

        for (const sourceId of sourceIds) {
            const entry = getEntry(sourceId);
            if (!entry) continue;
            if (entry.consolidatedSourceOf && entry.consolidatedSourceOf !== consolidationId) continue;
            const saved = savedStates[sourceId];
            const fallbackStatus = entry.consolidationId ? "consolidation" : "active";
            updateEntry(sourceId, {
                status: saved?.status || fallbackStatus,
                // Clearing this backlink is essential: status alone does not lift
                // the consolidation-picker suppression.
                consolidatedSourceOf: saved?.consolidatedSourceOf || null,
                consolidationReleased: saved?.consolidationReleased || false,
            });
            restoredEntries++;
        }

        for (const scene of getAllScenes()) {
            if (scene.consolidatedInto !== consolidationId) continue;
            const previous = consolidation.source_scene_states?.[scene.id]?.consolidatedInto;
            if (previous) { markSceneConsolidated(scene.id, previous); restoredScenes++; }
            else if (unmarkSceneConsolidated(scene.id)) restoredScenes++;
        }

        if (!deleteConsolidation(consolidationId)) throw new Error("Undo consolidation failed: consolidation record changed.");
    });
    for (const output of outputs) {
        assertChat();
        await deleteEntryVector(output).catch(err => console.warn("[ML] Undo vector cleanup failed:", err));
    }
    dlog(`Undid consolidation ${consolidationId}: restored ${restoredEntries} memories and ${restoredScenes} scenes; removed ${removedOutputs} outputs`);
    return { restoredEntries, restoredScenes, removedOutputs };
}

/**
 * AUTOMATIC trigger check. Called after a scene-close writer flow commits new
 * entries. If any character folder's ACTIVE memory count crosses the
 * configured threshold, auto-consolidate that folder's active memories.
 */
export async function maybeAutoConsolidate() {
    const assertChat = captureChatGuard();
    if (!getSetting("consolidation.autoEnabled", false)) return;
    const threshold = Math.max(2, Number(getSetting("consolidation.autoThreshold", 12)) || 12);

    // group active entries by folder
    const byFolder = new Map();
    for (const e of getAllEntries()) {
        if (e.status !== "active") continue;
        if (e.consolidatedSourceOf || e.consolidationReleased) continue;
        if (e.excludeFromConsolidation) continue;  // user opted this memory out
        if (e.category !== "character") continue; // auto only over character folders
        if (!e.folderId) continue;
        if (!byFolder.has(e.folderId)) byFolder.set(e.folderId, []);
        byFolder.get(e.folderId).push(e);
    }

    for (const [folderId, entries] of byFolder) {
        assertChat();
        if (entries.length < threshold) continue;
        dlog(`Auto-consolidate: folder ${folderId} has ${entries.length} active memories (threshold ${threshold})`);
        toastr?.info?.(`Auto-consolidating a character arc (${entries.length} memories)...`, "Memory Loom");
        // consolidate the OLDEST ones, leaving the most recent few uncompressed
        const keepRecent = Math.max(2, Number(getSetting("consolidation.autoKeepRecent", 4)) || 4);
        const sorted = entries.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const toConsolidate = sorted.slice(0, Math.max(2, sorted.length - keepRecent));
        await runConsolidation({
            entryIds: toConsolidate.map(e => e.id),
            mode: "folder",
            silent: true,
        });
    }
}

// ─── Helpers ──────────────────────────────────────────────

/** True if a character appears as a primary OR key character in an entry. */
function characterInEntry(entry, charName) {
    const canonical = resolveCanonicalCharacter(charName).toLocaleLowerCase();
    const prims = (entry.primaryCharacters && entry.primaryCharacters.length)
        ? entry.primaryCharacters
        : (entry.primaryCharacter ? [entry.primaryCharacter] : []);
    const keys = entry.keyCharacters || [];
    return [...prims, ...keys].some(n => resolveCanonicalCharacter(n).toLocaleLowerCase() === canonical);
}

function collectPrimaryCharacters(entries) {
    const set = new Set();
    for (const e of entries) {
        const prims = (e.primaryCharacters && e.primaryCharacters.length)
            ? e.primaryCharacters
            : (e.primaryCharacter ? [e.primaryCharacter] : []);
        for (const p of prims) if (p) set.add(resolveCanonicalCharacter(p));
    }
    return [...set];
}

function snapshotCharacterAliases() {
    return new Map(getAllFolders()
        .filter(f => f?.parentId === "ml_folder_characters" && f.id)
        .map(f => [f.id, Array.isArray(f.aliases) ? [...f.aliases] : []]));
}

/** Merge, rather than replace, so aliases added while an LLM call is pending survive too. */
function restoreCharacterAliases(snapshot) {
    for (const [folderId, savedAliases] of snapshot) {
        const folder = getAllFolders().find(f => f.id === folderId);
        if (!folder) continue;
        const merged = [];
        const seen = new Set();
        for (const alias of [...savedAliases, ...(Array.isArray(folder.aliases) ? folder.aliases : [])]) {
            const clean = String(alias || "").trim();
            const key = clean.toLocaleLowerCase();
            if (!clean || seen.has(key)) continue;
            seen.add(key);
            merged.push(clean);
        }
        const current = Array.isArray(folder.aliases) ? folder.aliases : [];
        if (JSON.stringify(current) !== JSON.stringify(merged)) updateFolder(folderId, { aliases: merged });
    }
}

function buildArcDelta(draft, sourceEntries = []) {
    const sourceDeltas = sourceEntries.map(e => e?.delta || {}).filter(Boolean);
    const firstBefore = sourceDeltas.find(d => String(d.before_state || "").trim())?.before_state;
    const lastAfter = [...sourceDeltas].reverse().find(d => String(d.after_state || "").trim())?.after_state;
    const before = String(draft?.before_state || firstBefore || "Before this arc, the developments summarized here had not yet occurred.").trim();
    const after = String(draft?.after_state || lastAfter || draft?.summary || "The arc's recorded developments now form part of the continuing story state.").trim();
    const changes = Array.isArray(draft?.key_changes) ? draft.key_changes.map(String).map(s => s.trim()).filter(Boolean) : [];
    return {
        before_state: before,
        after_state: after,
        delta: changes.join(" ") || (before && after ? `The arc moved from: ${before} To: ${after}` : String(draft?.summary || "").trim()),
        delta_type: [],
        low_delta_flag: false,
    };
}

/** Find the character_impact line that names this character, else null. */
function pickImpactFor(charName, impactList) {
    if (!Array.isArray(impactList)) return null;
    const lower = charName.toLowerCase();
    const match = impactList.find(line => String(line).toLowerCase().includes(lower));
    return match || null;
}

/** Assemble the Plot-folder arc summary from the consolidation draft. */
function buildArcSummaryBody(draft) {
    const parts = [];
    if (draft.summary) parts.push(draft.summary);
    if (draft.plot_impact?.length) parts.push("\nPlot developments:\n- " + draft.plot_impact.join("\n- "));
    if (draft.world_impact?.length) parts.push("\nWorld changes:\n- " + draft.world_impact.join("\n- "));
    if (draft.carry_forward_context?.length) parts.push("\nCarry-forward:\n- " + draft.carry_forward_context.join("\n- "));
    return parts.join("\n").trim() || draft.preferred_injection || "Arc summary.";
}
