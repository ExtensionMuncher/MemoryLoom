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
import { createConsolidation } from "../data/consolidations.js";
import { getEntry, getEntriesByFolder, getAllEntries, createEntry, setEntryStatus } from "../data/entries.js";
import { getScene, markSceneConsolidated } from "../data/scenes.js";
import { embedEntry } from "../embed/embedder.js";
import { getSetting } from "../settings.js";
import { dlog } from "../lib/debug.js";

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
    const sourceEntries = entryIds.map(getEntry).filter(Boolean);
    const sourceScenes = sceneIds.map(getScene).filter(Boolean);

    if (sourceEntries.length < 2) {
        if (!silent) toastr?.warning?.("Select at least 2 memories to consolidate.", "Memory Loom");
        return null;
    }

    dlog(`Consolidation: ${sourceEntries.length} entries, ${sourceScenes.length} scenes, mode=${mode}`);
    if (!silent) toastr?.info?.("Consolidating — this may take a moment...", "Memory Loom");

    const draft = await generateConsolidation({ mode, sourceEntries, sourceScenes });
    if (!draft) {
        if (!silent) toastr?.error?.("Consolidation failed — check the Consolidation LLM in Settings > Connections.", "Memory Loom");
        return null;
    }

    // Persist the consolidation record itself (for the library/audit trail)
    const consolidation = createConsolidation(draft);

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

        const written = await generateCharacterConsolidatedMemory(charName, relevant, draft);
        if (!written) {
            console.warn(`[ML] Consolidation: no per-character memory produced for ${charName} — skipping`);
            continue;
        }
        const mem = createEntry({
            title: written.title,
            datetime: written.datetime || draft.timeRange || "",
            content: written.content,
            primaryCharacter: charName,
            primaryCharacters: [charName],
            keyCharacters: [],
            category: "character",
            status: "consolidation",
            tags: [...(draft.tags || [])],
            consolidationId: consolidation.id,
        });
        updatedMemories.push(mem);
        await embedEntry(mem).catch(err => console.warn("[ML] Consolidation embed failed:", err));
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
        tags: [...(draft.tags || []), "arc-summary"],
        consolidationId: consolidation.id,
    });
    await embedEntry(arcSummary).catch(err => console.warn("[ML] Arc summary embed failed:", err));

    // ── 3. Demote source memories (non-destructive) ──────
    // Important/core memories are NEVER demoted — the user flagged them as
    // pivotal and they keep full priority even after being folded into an arc.
    for (const e of sourceEntries) {
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

    dlog(`Consolidation done: ${updatedMemories.length} updated memories + 1 arc summary; ${sourceEntries.length} sources demoted`);
    if (!silent) {
        toastr?.success?.(
            `Consolidated ${sourceEntries.length} memories → ${updatedMemories.length} updated ${updatedMemories.length === 1 ? "memory" : "memories"} + 1 arc summary.`,
            "Memory Loom", { timeOut: 6000 }
        );
    }
    return { consolidation, updatedMemories, arcSummary };
}

/**
 * AUTOMATIC trigger check. Called after a scene-close writer flow commits new
 * entries. If any character folder's ACTIVE memory count crosses the
 * configured threshold, auto-consolidate that folder's active memories.
 */
export async function maybeAutoConsolidate() {
    if (!getSetting("consolidation.autoEnabled", false)) return;
    const threshold = Math.max(2, Number(getSetting("consolidation.autoThreshold", 12)) || 12);

    // group active entries by folder
    const byFolder = new Map();
    for (const e of getAllEntries()) {
        if (e.status !== "active") continue;
        if (e.excludeFromConsolidation) continue;  // user opted this memory out
        if (e.category !== "character") continue; // auto only over character folders
        if (!e.folderId) continue;
        if (!byFolder.has(e.folderId)) byFolder.set(e.folderId, []);
        byFolder.get(e.folderId).push(e);
    }

    for (const [folderId, entries] of byFolder) {
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
    const lower = String(charName).toLowerCase();
    const prims = (entry.primaryCharacters && entry.primaryCharacters.length)
        ? entry.primaryCharacters
        : (entry.primaryCharacter ? [entry.primaryCharacter] : []);
    const keys = entry.keyCharacters || [];
    return [...prims, ...keys].some(n => String(n).toLowerCase() === lower);
}

function collectPrimaryCharacters(entries) {
    const set = new Set();
    for (const e of entries) {
        const prims = (e.primaryCharacters && e.primaryCharacters.length)
            ? e.primaryCharacters
            : (e.primaryCharacter ? [e.primaryCharacter] : []);
        for (const p of prims) if (p) set.add(p);
    }
    return [...set];
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
