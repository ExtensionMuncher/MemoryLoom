/**
 * ui/library.js — Library tab renderer
 *
 * The Library tab is the largest UI component in Memory Loom. It renders:
 *   - Segmented control: Memories | Scenes
 *   - New Entry + New Folder buttons (hidden in Scenes view)
 *   - Filter bar: search input, sort dropdown, folder filter
 *   - Folder tree with collapsible folders and character subfolders
 *   - Memory entry cards with expand/collapse, status badges, tags
 *   - Scene summary list with editable textareas
 *
 * All textareas get expand popout buttons (ml-expand-btn with data-for).
 * Modals (New Entry, New Folder, Crop) are rendered inline as overlays.
 *
 * Pattern: matches the mockup's Library tab structure exactly.
 */

import { iconSvg } from "../lib/icons.js";
import { getAllEntries, getEntriesByFolder, getEntry, updateEntry, deleteEntry, moveEntryToFolder, ENTRY_STATUSES } from "../data/entries.js";
import { reEmbedEntry, deleteEntryVector, embedEntry } from "../embed/embedder.js";
import { getAllFolders, getTopLevelFolders, getSubfolders, getFolder, getFolderIcon, getFolderButtons, isCharacterSubfolder, isGroupFolder, initDefaultFolders, setFolderAliases, deleteFolder } from "../data/folders.js";
import { getAllScenes, getScene, deleteScene, updateSceneSummary, markSceneConsolidated } from "../data/scenes.js";
import { getScenes, saveScenes } from "../data/storage.js";
import { getConsolidation, updateConsolidation } from "../data/consolidations.js";

// ─── Main Render ──────────────────────────────────────────

/**
 * Current view mode: "memories" or "scenes".
 * @type {string}
 */
let currentView = "memories";

// ─── Bulk selection state ─────────────────────────────────
// Entry ids the user has check-marked for a bulk move. Survives re-renders
// (checkboxes restore from this set) and clears after a bulk action.
const bulkSelected = new Set();

// Scene ids check-marked for bulk delete on the Scenes tab. Survives re-renders
// (checkboxes restore from this set) and clears after a bulk action.
const sceneBulkSelected = new Set();
// Which folders/subfolders/entry-cards are expanded — persisted across re-renders
// so editing/moving a memory doesn't collapse the whole library and force the
// user to re-open three levels of folders every single time.
const openFolders = new Set();
const openEntries = new Set();

/**
 * Render the complete Library tab.
 * Called on initial load and when the tab is switched to.
 *
 * @param {jQuery} $pane - The Library tab pane element
 */
const LIB_NS = ".ml-lib";

function extractSceneTitle(summary) {
    if (!summary) return "Untitled scene";
    // Our explicit format
    var m = summary.match(/^Title:\s*(.+)/im);
    if (m) return m[1].replace(/\*+/g, "").trim().slice(0, 60);
    // Strip "Scene Context:", "Scene Reference:", etc.
    var PREFIX = /^\*{0,2}(?:Scene\s+(?:Context|Reference|Summary|Setting|Title)|Summary|Context|Setting)\s*[:\-]?\s*\*{0,2}\s*/i;
    var lines = summary.split("\n");
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i].replace(/^#+\s*/, "").replace(/\*+/g, "").trim();
        if (l.length < 3) continue;
        return l.replace(PREFIX, "").trim().slice(0, 60) || l.slice(0, 60);
    }
    return "Scene summary";
}


export function renderLibraryTab($pane) {
    $(document).off(LIB_NS);
    $pane.empty();

    // ── Segmented control + action buttons ──────────────
    renderLibraryHeader($pane);

    // ── View content ────────────────────────────────────
    if (currentView === "memories") {
        renderMemoriesView($pane);
    } else {
        renderScenesView($pane);
    }

    // ── Modals (hidden by default) ──────────────────────
    renderNewEntryModal($pane);
    renderNewFolderModal($pane);
    renderCropModal($pane);
}

// ─── Library Header ───────────────────────────────────────

/**
 * Render the top bar: segmented control + action buttons.
 *
 * @param {jQuery} $pane
 */
function renderLibraryHeader($pane) {
    const $header = $(`
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:10px;flex-wrap:wrap">
            <div class="ml-seg-control">
                <button class="ml-seg-btn ${currentView === 'memories' ? 'on' : ''}" id="ml-seg-memories">Memories</button>
                <button class="ml-seg-btn ${currentView === 'scenes' ? 'on' : ''}" id="ml-seg-scenes">Scenes</button>
            </div>
            <div class="ml-btn-row" id="ml-lib-top-btns" style="display:${currentView === 'memories' ? 'flex' : 'none'}">
                <button class="ml-btn" id="ml-new-entry-btn">
                    ${iconSvg("ico-plus", 12, 12, "#ccc")}
                    New entry
                </button>
                <button class="ml-btn" id="ml-new-folder-btn">
                    ${iconSvg("ico-folder-plus", 12, 12, "#ccc")}
                    New folder
                </button>
            </div>
            <button class="ml-btn" id="ml-consolidate-btn" title="Consolidate selected memories and scenes into an arc">
                ${iconSvg("ico-book", 12, 12, "#ccc")}
                Consolidate
            </button>
        </div>
    `);

    // Wire segmented control
    $header.find("#ml-seg-memories").on("click", () => {
        currentView = "memories";
        renderLibraryTab($pane);
    });
    $header.find("#ml-seg-scenes").on("click", () => {
        currentView = "scenes";
        renderLibraryTab($pane);
    });

    // Wire action buttons
    $header.find("#ml-new-entry-btn").on("click", () => openModal("ml-new-entry-modal"));
    $header.find("#ml-new-folder-btn").on("click", () => {
        // reset to a clean Primary state each open, and refresh parent options
        // so any folders created this session are available as parents
        $("#ml-nf-name").val("");
        $("#ml-nf-pill-primary").addClass("on");
        $("#ml-nf-pill-sub").removeClass("on");
        $("#ml-nf-parent-group").hide();
        openModal("ml-new-folder-modal");
    });
    $header.find("#ml-consolidate-btn").on("click", () => openConsolidateModal($pane));

    $pane.append($header);
}

// ─── Memories View ────────────────────────────────────────

/**
 * Render the memories view: filter bar + folder tree + entry cards.
 *
 * @param {jQuery} $pane
 */
function renderMemoriesView($pane) {
    const $container = $('<div id="ml-mem-view"></div>');

    // ── Filter bar ──────────────────────────────────────
    const $filterBar = $(`
        <div class="ml-filter-bar">
            <input class="ml-filter-input" type="text" id="ml-mem-search" placeholder="Search memories…">
            <select class="ml-filter-select" id="ml-mem-sort">
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="az">A–Z</option>
                <option value="za">Z–A</option>
            </select>
            <select class="ml-filter-select" id="ml-mem-folder-filter">
                <option>All folders</option>
            </select>
            <select class="ml-filter-select" id="ml-mem-source-filter" title="Filter by how the memory was created">
                <option value="all">All sources</option>
                <option value="synthesis">Synthesis only</option>
                <option value="consolidated">Consolidated only</option>
                <option value="lorebook">Lorebook import only</option>
                <option value="core">Core (starred) only</option>
                <option value="excluded">Excluded only</option>
            </select>
            <button class="ml-btn" id="ml-select-all-btn" title="Select all currently visible memories">Select all</button>
        </div>
    `);
    $container.append($filterBar);
    // Select All toggles between selecting every visible entry and clearing.
    // Respects the active search/folder filter — only selects what's shown.
    $filterBar.find("#ml-select-all-btn").on("click", function () {
        const $visible = $("#ml-mem-view .ml-bulk-check");
        const allChecked = $visible.length > 0 && $visible.toArray().every(c => c.checked);
        if (allChecked) {
            bulkSelected.clear();
            $visible.prop("checked", false);
        } else {
            $visible.each(function () {
                const id = $(this).data("entry-id");
                if (id) { bulkSelected.add(id); this.checked = true; }
            });
        }
        $(this).text(allChecked ? "Select all" : "Select none");
        updateBulkBar();
    });

    // ── Bulk action bar (hidden until something is selected) ──
    const $bulkBar = $(`
        <div id="ml-bulk-bar" style="display:none;align-items:center;gap:9px;flex-wrap:wrap;padding:8px 10px;margin-bottom:10px;border:1px solid #3a3a3a;border-radius:6px;background:#1d1d1d">
            <span id="ml-bulk-count" style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#ccc"></span>
            <select id="ml-bulk-move-select" class="ml-filter-select" style="min-width:170px"><option value="">Move selected to…</option></select>
            <button class="ml-btn" id="ml-bulk-important" title="Toggle core/important on selected memories">Toggle important</button>
            <button class="ml-btn" id="ml-bulk-exclude" title="Toggle exclude-from-consolidation on selected memories">Toggle exclude</button>
            <button class="ml-btn-danger" id="ml-bulk-delete" title="Delete selected memories">Delete selected</button>
            <button class="ml-btn" id="ml-bulk-clear" style="margin-left:auto">Clear selection</button>
        </div>
    `);
    $container.append($bulkBar);
    populateBulkMoveSelect($bulkBar.find("#ml-bulk-move-select"));
    // restore bar visibility if a selection survived a re-render
    setTimeout(updateBulkBar, 0);
    $bulkBar.find("#ml-bulk-move-select").on("change", async function () {
        const target = $(this).val();
        if (!target) return;
        const ids = [...bulkSelected];
        let moved = 0;
        for (const id of ids) {
            if (moveEntryToFolder(id, target)) moved++;
        }
        bulkSelected.clear();
        toastr?.success?.(`Moved ${moved} ${moved === 1 ? "entry" : "entries"} to ${getFolder(target)?.name || "folder"}.`);
        renderLibraryTab($("#ml-p-library"));
    });
    $bulkBar.find("#ml-bulk-clear").on("click", () => {
        bulkSelected.clear();
        $(".ml-bulk-check").prop("checked", false);
        updateBulkBar();
    });
    $bulkBar.find("#ml-bulk-delete").on("click", async function () {
        const ids = [...bulkSelected];
        if (!ids.length) { toastr?.warning?.("No memories selected."); return; }
        let ok = false;
        try {
            const ctx = window.SillyTavern?.getContext();
            if (ctx?.callGenericPopup) {
                const r = await ctx.callGenericPopup(`Delete <b>${ids.length}</b> selected ${ids.length === 1 ? "memory" : "memories"}? This cannot be undone.`, ctx.POPUP_TYPE?.CONFIRM || "confirm", "");
                ok = r === true || r === 1;
            } else ok = confirm(`Delete ${ids.length} memories?`);
        } catch (e) {}
        if (!ok) return;
        let n = 0;
        for (const id of ids) {
            const e = getEntry(id);
            if (e) { deleteEntryVector(e).catch(err => console.warn("[ML] Vector delete failed:", err)); deleteEntry(id); n++; }
        }
        bulkSelected.clear();
        toastr?.success?.(`Deleted ${n} ${n === 1 ? "memory" : "memories"}.`);
        renderLibraryTab($("#ml-p-library"));
    });
    $bulkBar.find("#ml-bulk-important").on("click", function () {
        const ids = [...bulkSelected];
        if (!ids.length) { toastr?.warning?.("No memories selected."); return; }
        // If any selected is NOT important, turn all ON; else turn all OFF.
        const anyOff = ids.some(id => { const e = getEntry(id); return e && !e.important; });
        for (const id of ids) updateEntry(id, { important: anyOff });
        toastr?.success?.(`${anyOff ? "Marked" : "Unmarked"} ${ids.length} ${ids.length === 1 ? "memory" : "memories"} as core.`);
        renderLibraryTab($("#ml-p-library"));
    });
    $bulkBar.find("#ml-bulk-exclude").on("click", function () {
        const ids = [...bulkSelected];
        if (!ids.length) { toastr?.warning?.("No memories selected."); return; }
        const anyOff = ids.some(id => { const e = getEntry(id); return e && !e.excludeFromConsolidation; });
        for (const id of ids) updateEntry(id, { excludeFromConsolidation: anyOff });
        toastr?.success?.(`${anyOff ? "Excluded" : "Re-included"} ${ids.length} ${ids.length === 1 ? "memory" : "memories"}.`);
        renderLibraryTab($("#ml-p-library"));
    });

    // ── Populate folder filter dropdown ─────────────────
    const folders = getAllFolders();
    const $folderFilter = $filterBar.find("#ml-mem-folder-filter");
    folders.forEach(f => {
        $folderFilter.append(`<option value="${f.id}">${escapeHtml(f.name)}</option>`);
    });

    // ── Render folder tree ──────────────────────────────
    const topFolders = getTopLevelFolders();
    topFolders.forEach(folder => {
        const $folderEl = renderFolder(folder);
        $container.append($folderEl);
    });

    // Empty state
    if (topFolders.length === 0) {
        $container.append(`
            <div style="padding:20px 0;text-align:center;color:#666;font-family:'IBM Plex Mono',monospace;font-size:12px">
                No folders yet.<br>
                <span style="font-size:11px;color:#555">Create a New Folder or add a New Entry to get started.</span>
            </div>
        `);
    }

    // ── Wire search filtering ───────────────────────────
    let searchTimeout;
    $filterBar.find("#ml-mem-search").on("input", function () {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            filterMemoryEntries($container, $(this).val().toLowerCase());
        }, 200);
    });

    // Folder filter: show only the selected folder (and auto-open it)
    $filterBar.find("#ml-mem-folder-filter").on("change", function () {
        const val = $(this).val();
        if (!val || val === "All folders") {
            $container.find(".ml-folder, .ml-char-subfolder").show();
            return;
        }
        const folder = getAllFolders().find(f => f.id === val);
        if (!folder) return;
        if (folder.parentId) {
            // Subfolder (character) — show its parent open, hide sibling subfolders
            $container.find(".ml-folder").hide();
            const $parent = $container.find(`#ml-folder-${folder.parentId}`);
            $parent.show().addClass("open");
            $parent.find(".ml-char-subfolder").hide();
            $parent.find(`#ml-char-${val}`).show().addClass("open");
        } else {
            $container.find(".ml-folder").hide();
            $container.find(`#ml-folder-${val}`).show().addClass("open");
            $container.find(`#ml-folder-${val} .ml-char-subfolder`).show();
        }
    });

    // Sort: re-order entry cards inside every folder/subfolder body
    $filterBar.find("#ml-mem-sort").on("change", function () {
        applySortMode($container, $(this).val());
    });

    // Source filter: show only entries of the chosen creation-source class.
    $filterBar.find("#ml-mem-source-filter").on("change", function () {
        filterMemoryBySource($container, $(this).val());
    });

    $pane.append($container);
}

/**
 * Re-order memory cards inside every folder body by the chosen mode.
 * Operates on whatever body containers hold .ml-mem-entry-wrap cards, so it
 * works for character subfolders, World, Plot, and custom folders alike.
 */
function applySortMode($container, mode) {
    $container.find(".ml-folder-body, .ml-char-subfolder-body, .ml-scene-archive-members").each(function () {
        const $body = $(this);
        // direct entry cards only (don't yank cards out of nested subfolders)
        const items = $body.children(".ml-mem-entry-wrap").get();
        if (items.length < 2) return;
        items.sort((a, b) => {
            const ca = Number(a.dataset.created || 0), cb = Number(b.dataset.created || 0);
            const ta = (a.dataset.title || "").toLowerCase(), tb = (b.dataset.title || "").toLowerCase();
            if (mode === "oldest") return ca - cb;
            if (mode === "az") return ta.localeCompare(tb);
            if (mode === "za") return tb.localeCompare(ta);
            return cb - ca; // newest (default)
        });
        items.forEach(el => $body.append(el));
    });
}





// ─── Folder consolidation ─────────────────────────────────

/** Open the consolidation modal scoped to a single folder, so the user can pick
 *  which of that folder's memories to consolidate (rather than auto-selecting all). */
async function consolidateFolderFlow(folder) {
    const eligible = getEntriesByFolder(folder.id).filter(e => (e.status === "active" || e.status === "consolidation") && !e.excludeFromConsolidation && (e.category !== "world" || e.worldEvent === true));
    if (eligible.length < 2) {
        toastr?.warning?.(`${folder.name || folder.characterName || "This folder"} has fewer than 2 eligible memories — nothing to consolidate.`);
        return;
    }
    openConsolidateModal($("#ml-p-library"), folder.id);
}

// ─── Folder rename ────────────────────────────────────────

/**
 * Rename a folder via ST's native input popup.
 *
 * For CHARACTER folders, renaming means correcting the character's canonical
 * name, so three extra things happen:
 *   1. folder.characterName updates (future routing matches the new name)
 *   2. every entry owned by the old name is updated to the new name
 *   3. the OLD name is added as an alias automatically — if the writer LLM
 *      keeps using the old name, those memories still route here
 */
async function renameFolderFlow(folder) {
    // Custom folders get a combined name + icon picker. A folder is "custom" if
    // it isn't a character folder (no characterName) and isn't one of the three
    // default roots (world/characters/plot). Custom folders are type "primary"
    // (or a non-character "subfolder").
    const isCustom = !folder.characterName
        && !["world", "characters", "plot"].includes(folder.type);
    if (isCustom) { return editCustomFolderFlow(folder); }

    let newName = "";
    try {
        const ctx = window.SillyTavern?.getContext();
        if (ctx?.callGenericPopup) {
            const res = await ctx.callGenericPopup(`Rename folder "${escapeHtml(folder.name)}"`, ctx.POPUP_TYPE?.INPUT || "input", folder.name);
            if (typeof res === "string") newName = res.trim();
        } else {
            newName = (prompt(`Rename folder "${folder.name}"`, folder.name) || "").trim();
        }
    } catch (e) { console.warn("[ML] Rename popup failed:", e); }
    if (!newName || newName === folder.name) return;

    const oldName = folder.name;
    const updates = { name: newName };

    if (folder.characterName) {
        updates.characterName = newName;
        // old name becomes an alias so future writer output still routes here
        const aliases = [...(folder.aliases || [])];
        if (!aliases.some(a => a.toLowerCase() === oldName.toLowerCase())) aliases.push(oldName);
        updates.aliases = aliases.filter(a => a.toLowerCase() !== newName.toLowerCase());
        // migrate entry ownership to the new canonical name
        const owned = getEntriesByFolder(folder.id);
        let migrated = 0;
        for (const e of owned) {
            const prims = (e.primaryCharacters && e.primaryCharacters.length) ? [...e.primaryCharacters] : (e.primaryCharacter ? [e.primaryCharacter] : []);
            const idx = prims.findIndex(p => p.toLowerCase() === oldName.toLowerCase());
            if (idx !== -1) {
                prims[idx] = newName;
                updateEntry(e.id, {
                    primaryCharacters: prims,
                    primaryCharacter: prims.length === 1 ? prims[0] : "",
                });
                migrated++;
            }
        }
        if (migrated) console.log(`[ML] Rename: migrated ${migrated} entries from "${oldName}" to "${newName}"`);
    }

    const { updateFolder } = await import("../data/folders.js");
    updateFolder(folder.id, updates);
    toastr?.success?.(`Folder renamed to "${newName}".${folder.characterName ? ` "${oldName}" kept as an alias.` : ""}`);
    renderLibraryTab($("#ml-p-library"));
}

// Curated icon set for custom folders.
const ML_FOLDER_ICONS = ["\ud83d\udcc1","\ud83d\udcd6","\u2694\ufe0f","\ud83d\udd2e","\ud83c\udff0","\ud83d\udddd\ufe0f","\ud83c\udf0d","\u2728","\ud83d\udd25","\u2744\ufe0f","\ud83c\udf19","\u2600\ufe0f","\ud83c\udf3f","\ud83d\udc80","\ud83e\udde0","\u2764\ufe0f","\ud83d\udca5","\u26a1","\ud83d\udd17","\ud83d\udd11","\ud83c\udfad","\ud83c\udfb5","\ud83d\udcdc","\ud83e\ude99","\ud83c\udf52","\ud83d\udc31","\ud83d\udc09","\ud83d\udc7b","\ud83c\udf08","\u26d3\ufe0f","\ud83e\ude78","\ud83d\udee1\ufe0f"];

async function editCustomFolderFlow(folder) {
    const $host = $("#ml-popout").length ? $("#ml-popout") : $("body");
    const current = folder.customIcon || "";
    const iconGrid = ML_FOLDER_ICONS.map(ic =>
        `<button type="button" class="ml-icon-pick ${ic === current ? "sel" : ""}" data-icon="${ic}">${ic}</button>`
    ).join("");

    const $modal = $(`
        <div class="ml-modal-overlay open" id="ml-folder-edit-modal">
            <div class="ml-modal" style="max-width:420px">
                <div class="ml-modal-title">Edit folder</div>
                <div>
                    <div class="ml-field-label" style="font-size:11px;color:#999;margin-bottom:4px">Name</div>
                    <input type="text" id="ml-folder-edit-name" class="ml-folder-edit-input" value="${escapeHtml(folder.name)}" style="width:100%">
                </div>
                <div>
                    <div class="ml-field-label" style="font-size:11px;color:#999;margin:8px 0 4px">Icon</div>
                    <div class="ml-icon-grid">
                        <button type="button" class="ml-icon-pick ${!current ? "sel" : ""}" data-icon="">Default</button>
                        ${iconGrid}
                    </div>
                </div>
                <div class="ml-btn-row">
                    <button class="ml-btn-confirm" id="ml-folder-edit-save">Save</button>
                    <button class="ml-btn-danger" id="ml-folder-edit-cancel">Cancel</button>
                </div>
            </div>
        </div>
    `);

    let pickedIcon = current;
    $modal.on("click", ".ml-icon-pick", function () {
        pickedIcon = $(this).data("icon");
        $modal.find(".ml-icon-pick").removeClass("sel");
        $(this).addClass("sel");
    });
    const close = () => { $modal.removeClass("open"); setTimeout(() => $modal.remove(), 150); };
    $modal.find("#ml-folder-edit-cancel").on("click", close);
    $modal.on("click", function (e) { if (e.target === this) close(); });
    $modal.find("#ml-folder-edit-save").on("click", async () => {
        const newName = ($modal.find("#ml-folder-edit-name").val() || "").trim();
        const updates = {};
        if (newName && newName !== folder.name) updates.name = newName;
        updates.customIcon = pickedIcon || null;   // null clears back to default
        const { updateFolder } = await import("../data/folders.js");
        updateFolder(folder.id, updates);
        close();
        renderLibraryTab($("#ml-p-library"));
    });

    $host.append($modal);
}

// ─── Subfolder deletion ───────────────────────────────────

/**
 * Delete a subfolder via ST's native confirmation popup, with an explicit
 * choice for the memories inside: delete them too, or move them to another
 * folder first. Without this choice, deleting a folder would silently orphan
 * its entries — alive in storage but invisible in the library.
 */
async function confirmDeleteSubfolder(folder) {
    const entries = getEntriesByFolder(folder.id);
    const all = getAllFolders();
    let optionsHtml = "";
    for (const top of all.filter(f => !f.parentId)) {
        if (top.id !== folder.id) optionsHtml += `<option value="${top.id}">${escapeHtml(top.name)}</option>`;
        for (const sub of all.filter(f => f.parentId === top.id)) {
            if (sub.id === folder.id) continue;
            optionsHtml += `<option value="${sub.id}">&nbsp;&nbsp;— ${escapeHtml(sub.name)}</option>`;
        }
    }
    const html = `
        <div style="text-align:left">
            <h3 style="margin-top:0">Delete folder "${escapeHtml(folder.name)}"?</h3>
            ${entries.length === 0 ? `<p>This folder is empty.</p>` : `
            <p>It contains <b>${entries.length}</b> ${entries.length === 1 ? "memory" : "memories"}. What should happen to them?</p>
            <label class="checkbox_label" style="display:flex;gap:8px;align-items:center;margin:8px 0">
                <input type="radio" name="ml-del-mode" value="delete" checked> Delete the memories too
            </label>
            <label class="checkbox_label" style="display:flex;gap:8px;align-items:center;margin:8px 0">
                <input type="radio" name="ml-del-mode" value="move"> Move them to:
                <select id="ml-del-move-target" class="text_pole" style="flex:1" disabled>${optionsHtml}</select>
            </label>`}
        </div>
    `;
    // Capture choices while the popup is open — the DOM is gone once it resolves
    let mode = "delete", target = "";
    $(document).off("change.mldelpop").on("change.mldelpop", "input[name='ml-del-mode']", function () {
        mode = $(this).val();
        $("#ml-del-move-target").prop("disabled", mode !== "move");
        if (mode === "move") target = $("#ml-del-move-target").val() || "";
    }).on("change.mldelpop", "#ml-del-move-target", function () {
        target = $(this).val() || "";
    });

    let ok = false;
    try {
        const ctx = window.SillyTavern?.getContext();
        if (ctx?.callGenericPopup) {
            const res = await ctx.callGenericPopup(html, ctx.POPUP_TYPE?.CONFIRM || "confirm", "");
            ok = res === true || res === 1;
        } else {
            ok = confirm(`Delete folder "${folder.name}" and its ${entries.length} memories?`);
        }
    } finally {
        $(document).off("change.mldelpop");
    }
    if (!ok) return;

    if (entries.length > 0 && mode === "move") {
        if (!target) { toastr?.warning?.("No destination folder chosen — nothing was deleted."); return; }
        let moved = 0;
        for (const e of entries) { if (moveEntryToFolder(e.id, target)) moved++; }
        toastr?.info?.(`Moved ${moved} ${moved === 1 ? "memory" : "memories"} to ${getFolder(target)?.name || "folder"}.`);
    } else if (entries.length > 0) {
        for (const e of entries) {
            deleteEntryVector(e).catch(err => console.warn("[ML] Vector delete failed:", err));
            deleteEntry(e.id);
        }
        toastr?.info?.(`Deleted ${entries.length} ${entries.length === 1 ? "memory" : "memories"}.`);
    }
    const deleted = deleteFolder(folder.id);
    if (deleted) toastr?.success?.(`Folder "${folder.name}" deleted.`);
    else toastr?.warning?.(`"${folder.name}" is a protected folder and cannot be deleted.`);
    renderLibraryTab($("#ml-p-library"));
}

// ─── Bulk selection helpers ───────────────────────────────

/** Show/hide the bulk action bar and keep its count current. */
function updateBulkBar() {
    const $bar = $("#ml-bulk-bar");
    if (!$bar.length) return;
    if (bulkSelected.size > 0) {
        $bar.css("display", "flex");
        $bar.find("#ml-bulk-count").text(`${bulkSelected.size} selected`);
    } else {
        $bar.hide();
        $bar.find("#ml-bulk-move-select").val("");
    }
}

/** Fill the bulk-move dropdown with every folder and subfolder. */
function populateBulkMoveSelect($sel) {
    const all = getAllFolders();
    for (const top of all.filter(f => !f.parentId)) {
        $sel.append(`<option value="${top.id}">${escapeHtml(top.name)}</option>`);
        for (const sub of all.filter(f => f.parentId === top.id)) {
            $sel.append(`<option value="${sub.id}">&nbsp;&nbsp;— ${escapeHtml(sub.name)}</option>`);
        }
    }
}

/**
 * Render a single folder as a collapsible block.
 *
 * @param {object} folder
 * @returns {jQuery}
 */
function renderFolder(folder) {
    const icon = getFolderIcon(folder.type);
    // Custom folders can have a user-picked emoji icon (folder.customIcon).
    const iconHtml = folder.customIcon
        ? `<span class="ml-folder-emoji" style="font-size:15px;line-height:1;width:15px;display:inline-flex;justify-content:center">${folder.customIcon}</span>`
        : iconSvg(icon, 15, 15, "#888");
    const subfolders = getSubfolders(folder.id);
    const entries = getEntriesByFolder(folder.id);
    // Count = direct entries in this folder + number of subfolders
    // Subfolders show their own entry counts individually
    const count = entries.length + subfolders.length;

    const $folder = $(`
        <div class="ml-folder" id="ml-folder-${folder.id}">
            <div class="ml-folder-hdr">
                ${iconHtml}
                <span class="ml-folder-name">${escapeHtml(folder.name)}</span>
                <span class="ml-folder-count">${subfolders.length > 0 && entries.length === 0
                    ? `${subfolders.length} ${subfolders.length === 1 ? "subfolder" : "subfolders"}`
                    : subfolders.length > 0
                        ? `${subfolders.length} ${subfolders.length === 1 ? "subfolder" : "subfolders"}, ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`
                        : `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`
                }</span>
                ${(folder.parentId && !["ml_folder_world","ml_folder_characters","ml_folder_plot"].includes(folder.id)) ? `
                <button class="ml-icon-btn ml-subfolder-img-btn" title="Upload folder image" data-folder-id="${folder.id}" style="width:22px;height:22px">
                    ${iconSvg("ico-image", 12, 12, "#888")}
                </button>
                <button class="ml-icon-btn ml-rename-folder-btn" title="Rename this folder" data-folder-id="${folder.id}" style="width:22px;height:22px">
                    ${iconSvg("ico-edit", 12, 12, "#888")}
                </button>
                <button class="ml-icon-btn ml-del-folder-btn" title="Delete this folder" data-folder-id="${folder.id}" style="color:#b05b5b;width:22px;height:22px">
                    ${iconSvg("ico-trash", 12, 12, "#b05b5b")}
                </button>` : ""}
                ${iconSvg("ico-chevron-down", 14, 14, "#666")}
            </div>
            <div class="ml-folder-body"></div>
        </div>
    `);

    // Folder delete (user folders / subfolders only — the three defaults are protected)
    $folder.find(".ml-del-folder-btn").on("click", function (e) {
        e.stopPropagation();
        confirmDeleteSubfolder(folder);
    });

    // Folder rename
    $folder.find(".ml-rename-folder-btn").on("click", function (e) {
        e.stopPropagation();
        renameFolderFlow(folder);
    });

    // Custom subfolder image upload (header button on subfolders)
    $folder.find(".ml-subfolder-img-btn").on("click", function (e) {
        e.stopPropagation();
        $("#ml-img-upload").data("target-folder-id", folder.id);
        $("#ml-img-upload").click();
    });

    const $body = $folder.find(".ml-folder-body");

    // Toggle expand/collapse on header click (persist open state)
    if (openFolders.has(folder.id)) $folder.addClass("open");
    $folder.find(".ml-folder-hdr").on("click", function () {
        const isOpen = $folder.toggleClass("open").hasClass("open");
        if (isOpen) openFolders.add(folder.id); else openFolders.delete(folder.id);
    });

    // Custom subfolder banner (if image set) — mirrors character banner
    if (folder.parentId && folder.hasImage && folder.imagePath) {
        $body.append(`
            <div class="ml-char-banner">
                <img src="${folder.imagePath}" alt="${escapeHtml(folder.name)}">
                <div class="ml-char-banner-gradient"></div>
            </div>
        `);
    }

    // In-body menu bar for top-level folders (World / Plot / custom) — mirrors
    // the character-subfolder info row, tucked INTO the folder rather than
    // crammed into the header line.
    if (!folder.parentId && folder.id !== "ml_folder_characters") {
        const cat = folder.id === "ml_folder_world" ? "world" : folder.id === "ml_folder_plot" ? "plot" : folder.id;
        const isCustom = !["ml_folder_world", "ml_folder_plot"].includes(folder.id);
        const $infoRow = $(`
            <div class="ml-char-info-row">
                <div style="flex:1;min-width:0">
                    <div class="ml-char-name">${escapeHtml(folder.name)}</div>
                    <div class="ml-char-stats-line">${entries.length} ${entries.length === 1 ? "entry" : "entries"} · updated ${relativeTime(folderLastUpdated(folder.id))}</div>
                </div>
                <div class="ml-btn-row">
                    <button class="ml-icon-btn ml-folder-new-entry-btn" title="Add an entry to this folder" data-folder-cat="${cat}">
                        ${iconSvg("ico-plus", 14, 14, "#888")}
                    </button>
                    <button class="ml-icon-btn ml-folder-consolidate-btn" title="Consolidate this folder's entries only">
                        ${iconSvg("ico-book", 14, 14, "#888")}
                    </button>
                    ${isCustom ? `
                    <button class="ml-icon-btn ml-folder-img-bar-btn" title="Upload folder image">
                        ${iconSvg("ico-image", 14, 14, "#888")}
                    </button>
                    <button class="ml-icon-btn ml-folder-rename-bar-btn" title="Rename this folder">
                        ${iconSvg("ico-edit", 14, 14, "#888")}
                    </button>
                    <button class="ml-icon-btn ml-folder-del-bar-btn" title="Delete this folder" style="color:#b05b5b">
                        ${iconSvg("ico-trash", 14, 14, "#b05b5b")}
                    </button>` : ""}
                </div>
            </div>
        `);
        $infoRow.find(".ml-folder-new-entry-btn").on("click", (e) => {
            e.stopPropagation();
            openModal("ml-new-entry-modal");
            const $c = $("#ml-ne-category");
            if ($c.length) { $c.val(cat).trigger("change"); }
        });
        $infoRow.find(".ml-folder-consolidate-btn").on("click", (e) => {
            e.stopPropagation();
            consolidateFolderFlow(folder);
        });
        $infoRow.find(".ml-folder-img-bar-btn").on("click", (e) => {
            e.stopPropagation();
            $("#ml-img-upload").data("target-folder-id", folder.id);
            $("#ml-img-upload").click();
        });
        $infoRow.find(".ml-folder-rename-bar-btn").on("click", (e) => {
            e.stopPropagation();
            renameFolderFlow(folder);
        });
        $infoRow.find(".ml-folder-del-bar-btn").on("click", (e) => {
            e.stopPropagation();
            confirmDeleteSubfolder(folder);
        });
        $body.append($infoRow);
    }

    // Render subfolders (character subfolders, group, etc.)
    if (folder.id === "ml_folder_characters") {
        // Characters folder — render each character subfolder
        subfolders.forEach(sub => {
            const $subEl = renderCharacterSubfolder(sub);
            $body.append($subEl);
        });
    } else {
        // Other folders — render subfolders generically
        subfolders.forEach(sub => {
            const $subEl = renderFolder(sub);
            $body.append($subEl);
        });
    }

    // Render direct entries (for World, Plot, and primary folders)
    entries.forEach(entry => {
        const $entryEl = renderMemoryEntry(entry);
        $body.append($entryEl);
    });

    return $folder;
}

/**
 * Render a character subfolder with banner, info row, and entry list.
 *
 * @param {object} folder
 * @returns {jQuery}
 */
function renderCharacterSubfolder(folder) {
    const entries = getEntriesByFolder(folder.id);
    const buttons = getFolderButtons(folder);
    const count = entries.length; // Always recalculate from actual entries

    const $sub = $(`
        <div class="ml-char-subfolder" id="ml-char-${folder.id}">
            <div class="ml-char-subfolder-hdr">
                ${iconSvg("ico-chevron-right", 12, 12, "#666")}
                <span class="ml-char-subfolder-name">${escapeHtml(folder.name)}</span>
                <span class="ml-char-subfolder-count">${count} ${count === 1 ? "entry" : "entries"}</span>
            </div>
            <div class="ml-char-subfolder-body"></div>
        </div>
    `);

    const $body = $sub.find(".ml-char-subfolder-body");

    // Toggle expand/collapse (persist open state)
    if (openFolders.has(folder.id)) $sub.addClass("open");
    $sub.find(".ml-char-subfolder-hdr").on("click", function () {
        const isOpen = $sub.toggleClass("open").hasClass("open");
        if (isOpen) openFolders.add(folder.id); else openFolders.delete(folder.id);
    });

    // ── Character banner (if image is set) ──────────────
    if (folder.hasImage && folder.imagePath) {
        const $banner = $(`
            <div class="ml-char-banner">
                <img src="${folder.imagePath}" alt="${escapeHtml(folder.name)}">
                <div class="ml-char-banner-gradient"></div>
            </div>
        `);
        $body.append($banner);
    }

    // ── Character info row with action buttons ──────────
    const $infoRow = $(`
        <div class="ml-char-info-row">
            <div style="flex:1;min-width:0">
                <div class="ml-char-name">${escapeHtml(folder.name)}</div>
                <div class="ml-char-stats-line">${count} ${count === 1 ? "memory" : "memories"} · updated ${relativeTime(folderLastUpdated(folder.id))}</div>
            </div>
            <div class="ml-btn-row">
                ${buttons.showImageUpload ? `
                    <button class="ml-icon-btn ml-crop-open-btn" title="Upload character image" data-folder-id="${folder.id}">
                        ${iconSvg("ico-image", 14, 14, "#888")}
                    </button>
                ` : ""}
                ${buttons.showNewEntry ? `
                    <button class="ml-icon-btn ml-char-new-entry-btn" title="Add memory entry" data-folder-id="${folder.id}">
                        ${iconSvg("ico-plus", 14, 14, "#888")}
                    </button>
                ` : ""}
                <button class="ml-icon-btn ml-consolidate-folder-btn" title="Consolidate this character's active memories" data-folder-id="${folder.id}">
                    ${iconSvg("ico-book", 14, 14, "#888")}
                </button>
                <button class="ml-icon-btn ml-rename-folder-btn" title="Rename this folder" data-folder-id="${folder.id}">
                    ${iconSvg("ico-edit", 14, 14, "#888")}
                </button>
                <button class="ml-icon-btn ml-del-folder-btn" title="Delete this folder" data-folder-id="${folder.id}" style="color:#b05b5b">
                    ${iconSvg("ico-trash", 14, 14, "#b05b5b")}
                </button>
            </div>
        </div>
    `);

    // Wire image upload button
    $infoRow.find(".ml-crop-open-btn").on("click", () => {
        // Trigger hidden file input for image upload
        $("#ml-img-upload").data("target-folder-id", folder.id);
        $("#ml-img-upload").click();
    });

    // Wire new entry button
    $infoRow.find(".ml-char-new-entry-btn").on("click", () => {
        openModal("ml-new-entry-modal");
    });

    // Wire folder delete button
    $infoRow.find(".ml-del-folder-btn").on("click", (e) => {
        e.stopPropagation();
        confirmDeleteSubfolder(folder);
    });

    // Wire folder rename button
    $infoRow.find(".ml-rename-folder-btn").on("click", (e) => {
        e.stopPropagation();
        renameFolderFlow(folder);
    });

    // Wire folder consolidate button
    $infoRow.find(".ml-consolidate-folder-btn").on("click", (e) => {
        e.stopPropagation();
        consolidateFolderFlow(folder);
    });

    $body.append($infoRow);

    // ── Name aliases ─────────────────────────────────────
    // Alternate names the writer LLM might use for this character. Anything
    // listed here (plus automatic name-order flips) routes to THIS folder
    // instead of spawning a duplicate.
    const aliasVal = (folder.aliases || []).join(", ");
    const $aliasRow = $(`
        <div class="ml-alias-row">
            <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Name aliases</div>
            <input type="text" class="ml-alias-input" placeholder="e.g. Jane, Janey, JD" value="${escapeHtml(aliasVal)}">
            <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#666;margin-top:3px">Comma-separated · memories written under these names file into this folder</div>
        </div>
    `);
    $aliasRow.find(".ml-alias-input").on("change", function () {
        setFolderAliases(folder.id, $(this).val());
        toastr?.success?.(`Aliases saved for ${folder.name}.`);
    });
    $body.append($aliasRow);

    // ── Memory entries ──────────────────────────────────
    entries.forEach(entry => {
        const $entryEl = renderMemoryEntry(entry);
        $body.append($entryEl);
    });

    return $sub;
}

// ─── Memory Entry Rendering ───────────────────────────────

/** Human-friendly relative time from a timestamp (ms). */
function relativeTime(ts) {
    if (!ts) return "never";
    const diff = Date.now() - ts;
    if (diff < 0) return "just now";
    const s = Math.floor(diff / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d} ${d === 1 ? "day" : "days"} ago`;
    const w = Math.floor(d / 7);
    if (w < 5) return `${w} ${w === 1 ? "week" : "weeks"} ago`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo} ${mo === 1 ? "month" : "months"} ago`;
    const y = Math.floor(d / 365);
    return `${y} ${y === 1 ? "year" : "years"} ago`;
}

/** Most recent updatedAt/createdAt across a folder's direct entries (ms), or 0. */
function folderLastUpdated(folderId) {
    const entries = getEntriesByFolder(folderId);
    let latest = 0;
    for (const e of entries) {
        const t = e.updatedAt || e.createdAt || 0;
        if (t > latest) latest = t;
    }
    return latest;
}

/** Rough token estimate (~4 chars/token) for a memory entry's injected text. */
function estimateTokens(entry) {
    const text = `${entry.title || ""}\n${entry.datetime || ""}\n${entry.content || ""}\n${(entry.primaryCharacters||[entry.primaryCharacter]).join(", ")}\n${(entry.keyCharacters||[]).join(", ")}`;
    return Math.max(1, Math.round(text.length / 4));
}

/**
 * Render a single memory entry as an expandable card.
 *
 * @param {object} entry
 * @returns {jQuery}
 */
function hasDelta(entry) {
    var d = entry.delta;
    return d && (d.before_state || d.after_state || d.delta || (d.delta_type && d.delta_type.length > 0));
}

function buildDeltaDisplay(entry) {
    if (!hasDelta(entry)) return "";
    var d = entry.delta;
    var html = '<div class="ml-delta-display">';
    html += '<div class="ml-delta-header">Impact</div>';
    if (d.before_state) html += '<div class="ml-delta-row"><span class="ml-delta-label">Before</span>' + escapeHtml(d.before_state) + '</div>';
    if (d.after_state) html += '<div class="ml-delta-row"><span class="ml-delta-label">After</span>' + escapeHtml(d.after_state) + '</div>';
    if (d.delta) html += '<div class="ml-delta-row"><span class="ml-delta-label">Shift</span>' + escapeHtml(d.delta) + '</div>';
    if (d.delta_type && d.delta_type.length > 0) {
        html += '<div class="ml-delta-tags">';
        d.delta_type.forEach(function(t) { html += '<span class="ml-tag">' + escapeHtml(t) + '</span>'; });
        html += '</div>';
    }
    html += '</div>';
    return html;
}

function renderMemoryEntry(entry) {
    const statusBadge = getStatusBadge(entry.status);

    // Build tags HTML
    const tagsHtml = (entry.tags || []).map(t =>
        `<span class="ml-tag">${escapeHtml(t)}</span>`
    ).join("");

    // Classify the entry's source for the library source-filter:
    //   synthesis    → per-character consolidated memory (has consolidationId, character)
    //   consolidated → arc summary / any consolidation-status entry
    //   lorebook     → imported from a lorebook
    //   normal       → everything else
    let srcClass = "normal";
    if (entry.source === "lorebook_import" || (entry.tags || []).includes("lorebook-import")) srcClass = "lorebook";
    else if (entry.consolidationId && entry.category === "character") srcClass = "synthesis";
    else if (entry.consolidationId || entry.status === "consolidation" || entry.source === "consolidation") srcClass = "consolidated";

    const $entry = $('<div class="ml-mem-entry-wrap"></div>')
        .attr('data-created', entry.createdAt || 0)
        .attr('data-title', entry.title || '')
        .attr('data-srcclass', srcClass)
        .attr('data-core', entry.important ? "1" : "0")
        .attr('data-excluded', entry.excludeFromConsolidation ? "1" : "0");
    $entry.html(`
        <div class="ml-mem-entry" id="ml-mem-${entry.id}">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
                <div style="display:flex;align-items:flex-start;gap:8px;min-width:0">
                    <input type="checkbox" class="ml-bulk-check" data-entry-id="${entry.id}" title="Select for bulk move" ${bulkSelected.has(entry.id) ? "checked" : ""} style="margin-top:2px;flex-shrink:0">
                    <div class="ml-mem-entry-title">${entry.important ? '<span class="ml-star" title="Core memory">★</span> ' : ''}${entry.excludeFromConsolidation ? '<span class="ml-excl-mark" title="Excluded from consolidation">⊘</span> ' : ''}${escapeHtml(entry.title)}</div>
                </div>
                ${statusBadge}
            </div>
            <div class="ml-mem-entry-date">${escapeHtml(entry.datetime)}<span class="ml-token-count" title="Estimated injection tokens">~${estimateTokens(entry)} tok</span></div>
            <div class="ml-mem-entry-preview">${escapeHtml(truncateText(entry.content, 200))}</div>
            ${tagsHtml ? `<div class="ml-mem-entry-tags">${tagsHtml}</div>` : ""}
        </div>
        <div class="ml-mem-full" id="ml-mem-full-${entry.id}">
            <div class="ml-mem-full-title">${escapeHtml(entry.title)}</div>
            <div class="ml-mem-full-date">${escapeHtml(entry.datetime)}</div>
            <div class="ml-mem-full-rule"></div>
            <div class="ml-mem-full-prose">${escapeHtml(entry.content)}</div>
            ${entry.category === "character" ? `
            <div class="ml-mem-full-chars">
                ${entry.primaryCharacter ? `<span>Primary</span> · ${escapeHtml(entry.primaryCharacter)}<br>` : ""}
                ${entry.keyCharacters && entry.keyCharacters.length > 0 ? `<span>Key</span> · ${escapeHtml(entry.keyCharacters.join(", "))}` : ""}
            </div>
            ${buildDeltaDisplay(entry)}` : ""}
            <div class="ml-btn-row">
                <button class="ml-btn ml-edit-entry-btn" data-entry-id="${entry.id}">Edit</button>
                ${entry.category === "character" && hasDelta(entry) ? '<button class="ml-btn ml-impact-btn" data-entry-id="' + entry.id + '">Show Impact</button>' : ''}
                <button class="ml-btn ml-important-entry-btn" data-entry-id="${entry.id}">${entry.important ? "★ Core" : "☆ Mark core"}</button>
                <button class="ml-btn ml-exclude-entry-btn" data-entry-id="${entry.id}">${entry.excludeFromConsolidation ? "⊘ Excluded" : "Exclude from consld."}</button>
                <button class="ml-btn ml-move-entry-btn" data-entry-id="${entry.id}">Move</button>
                <button class="ml-btn-danger ml-delete-entry-btn" data-entry-id="${entry.id}">Delete</button>
            </div>
            <div class="ml-move-row" style="display:none;margin-top:8px">
                <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Move to folder</div>
                <select class="ml-move-select ml-setting-select" style="width:100%"></select>
            </div>
        </div>
    `);

    // Restore open state across re-renders
    if (openEntries.has(entry.id)) $entry.find(`#ml-mem-full-${entry.id}`).addClass("open");
    // Click on entry → expand
    $entry.find(".ml-mem-entry").on("click", function () {
        const opened = $(`#ml-mem-full-${entry.id}`).toggleClass("open").hasClass("open");
        if (opened) openEntries.add(entry.id); else openEntries.delete(entry.id);
    });

    // Bulk-select checkbox — must not toggle the card open
    $entry.find(".ml-bulk-check").on("click", function (e) {
        e.stopPropagation();
    }).on("change", function (e) {
        e.stopPropagation();
        if (this.checked) bulkSelected.add(entry.id);
        else bulkSelected.delete(entry.id);
        updateBulkBar();
    });

    // Edit button
    $entry.find(".ml-edit-entry-btn").on("click", (e) => {
        e.stopPropagation();
        toggleEntryEdit(entry.id);
    });

    // Quick Important toggle (no edit mode needed)
    $entry.find(".ml-important-entry-btn").on("click", (e) => {
        e.stopPropagation();
        const now = !entry.important;
        updateEntry(entry.id, { important: now });
        toastr?.success?.(now ? `"${entry.title}" marked as core.` : `"${entry.title}" no longer core.`);
        renderLibraryTab($("#ml-p-library"));
    });

    // Quick Exclude-from-consolidation toggle
    $entry.find(".ml-exclude-entry-btn").on("click", (e) => {
        e.stopPropagation();
        const now = !entry.excludeFromConsolidation;
        updateEntry(entry.id, { excludeFromConsolidation: now });
        toastr?.success?.(now ? `"${entry.title}" excluded from consolidation.` : `"${entry.title}" can be consolidated again.`);
        renderLibraryTab($("#ml-p-library"));
    });

    // Show Impact toggle
    $entry.find(".ml-impact-btn").on("click", function(e) {
        e.stopPropagation();
        const $delta = $entry.find(".ml-delta-display");
        $delta.toggleClass("open");
        $(this).text($delta.hasClass("open") ? "Hide Impact" : "Show Impact");
    });

    // Move button — toggles a folder picker; choosing a folder moves the entry
    $entry.find(".ml-move-entry-btn").on("click", function (e) {
        e.stopPropagation();
        const $row = $entry.find(".ml-move-row");
        if ($row.is(":visible")) { $row.hide(); return; }
        // Build the folder list fresh each open (folders may have changed)
        const $sel = $row.find(".ml-move-select");
        $sel.empty().append('<option value="">Choose a folder…</option>');
        const all = getAllFolders();
        const tops = all.filter(f => !f.parentId);
        for (const top of tops) {
            $sel.append(`<option value="${top.id}"${top.id === entry.folderId ? " disabled" : ""}>${escapeHtml(top.name)}${top.id === entry.folderId ? " (current)" : ""}</option>`);
            for (const sub of all.filter(f => f.parentId === top.id)) {
                $sel.append(`<option value="${sub.id}"${sub.id === entry.folderId ? " disabled" : ""}>&nbsp;&nbsp;— ${escapeHtml(sub.name)}${sub.id === entry.folderId ? " (current)" : ""}</option>`);
            }
        }
        $row.show();
        $sel.off("change").on("change", function () {
            const target = $(this).val();
            if (!target) return;
            const ok = moveEntryToFolder(entry.id, target);
            if (ok) {
                toastr?.success?.(`Moved "${entry.title}" to ${getFolder(target)?.name || "folder"}.`);
                renderLibraryTab($("#ml-p-library"));
            }
        });
    });

    // Delete button
    $entry.find(".ml-delete-entry-btn").on("click", async (e) => {
        e.stopPropagation();
        const ok = await popup(`Delete "${entry.title}"?`);
        if (ok) {
            deleteEntryVector(entry).catch(err => console.warn("[ML] Vector delete failed:", err));
            deleteEntry(entry.id);
            // Re-render the Library tab
            const $pane = $("#ml-p-library");
            if ($pane.length) renderLibraryTab($pane);
        }
    });

    return $entry;
}

// ─── Inline Entry Editing ─────────────────────────────────

/**
 * Toggle a committed memory entry into edit mode, replacing static text with inputs.
 * @param {string} entryId
 */
function toggleEntryEdit(entryId) {
    const $full = $(`#ml-mem-full-${entryId}`);
    if (!$full.length) return;
    
    // If already in edit mode, cancel
    if ($full.hasClass("editing")) {
        $full.removeClass("editing");
        const $pane = $("#ml-p-library");
        if ($pane.length) renderLibraryTab($pane);
        return;
    }
    
    const entry = getEntry(entryId);
    if (!entry) return;
    
    $full.addClass("editing").addClass("open");
    
    // Replace static content with editable fields
    $full.html(`
        <div class="ml-mem-full-title-edit">
            <input class="ml-form-input" id="ml-edit-title-${entryId}" value="${escapeHtml(entry.title)}" placeholder="Title">
        </div>
        <div class="ml-mem-full-date-edit">
            <input class="ml-form-input" id="ml-edit-datetime-${entryId}" value="${escapeHtml(entry.datetime)}" placeholder="Date / Time">
        </div>
        <div class="ml-mem-full-rule"></div>
        <div class="ml-mem-full-prose-edit">
            <div class="ml-field-hdr" style="display:flex;align-items:center"><span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#666">Memory context</span><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-edit-content-${entryId}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer"></i></div>
            <textarea class="ml-form-textarea" id="ml-edit-content-${entryId}" rows="6">${escapeHtml(entry.content)}</textarea>
            ${entry.category === "character" ? `
            <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#666;margin-top:6px">Before</div>
            <textarea class="ml-form-textarea" id="ml-edit-before-${entryId}" rows="2">${escapeHtml(entry.delta?.before_state || "")}</textarea>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#666;margin-top:6px">After</div>
            <textarea class="ml-form-textarea" id="ml-edit-after-${entryId}" rows="2">${escapeHtml(entry.delta?.after_state || "")}</textarea>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#666;margin-top:6px">Delta</div>
            <textarea class="ml-form-textarea" id="ml-edit-delta-${entryId}" rows="2">${escapeHtml(entry.delta?.delta || "")}</textarea>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#666;margin-top:6px">Primary character(s) · comma-separate · 2+ routes to Group</div>
            <input class="ml-form-input" id="ml-edit-primary-${entryId}" value="${escapeHtml((entry.primaryCharacters && entry.primaryCharacters.length ? entry.primaryCharacters : (entry.primaryCharacter ? [entry.primaryCharacter] : [])).join(", "))}" placeholder="Who this memory belongs to">
            <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#666;margin-top:6px">Key characters · comma-separate · optional</div>
            <input class="ml-form-input" id="ml-edit-key-${entryId}" value="${escapeHtml((entry.keyCharacters || []).join(", "))}" placeholder="Supporting cast (optional)">` : ""}
        </div>
        <label class="ml-important-row" style="display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer">
            <input type="checkbox" id="ml-edit-important-${entryId}" ${entry.important ? "checked" : ""}>
            <span style="font-size:12px;color:#ddd">Mark as core/important memory <span style="color:#888;font-size:11px">(exempt from priority decay &amp; consolidation suppression)</span></span>
        </label>
        <label class="ml-important-row" style="display:flex;align-items:center;gap:8px;margin-top:6px;cursor:pointer">
            <input type="checkbox" id="ml-edit-exclude-${entryId}" ${entry.excludeFromConsolidation ? "checked" : ""}>
            <span style="font-size:12px;color:#ddd">Exclude from consolidation <span style="color:#888;font-size:11px">(never used as a consolidation source)</span></span>
        </label>
        <div style="display:flex;gap:14px;margin-top:10px;flex-wrap:wrap">
            <div>
                <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#666">Stickiness override</div>
                <input type="number" id="ml-edit-stickiness-${entryId}" value="${Number(entry.stickiness) || 0}" min="0" max="50" style="width:80px">
            </div>
            <div>
                <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#666">Cooldown override</div>
                <input type="number" id="ml-edit-cooldown-${entryId}" value="${Number(entry.cooldown) || 0}" min="0" max="50" style="width:80px">
            </div>
            <div style="flex:1;min-width:140px;align-self:flex-end;font-size:11px;color:#888;line-height:1.4">0 = use the global default. Set a value to override this memory's persistence individually.</div>
        </div>
        <div class="ml-btn-row" style="margin-top:10px">
            <button class="ml-btn-confirm ml-save-edit-btn" data-entry-id="${entryId}">Save</button>
            <button class="ml-btn-danger ml-cancel-edit-btn" data-entry-id="${entryId}">Cancel</button>
        </div>
    `);
    
    // Wire save
    $full.find(".ml-save-edit-btn").on("click", async () => {
        const title = $(`#ml-edit-title-${entryId}`).val().trim();
        const datetime = $(`#ml-edit-datetime-${entryId}`).val().trim();
        const content = $(`#ml-edit-content-${entryId}`).val().trim();
        const isChar = entry.category === "character";
        const delta = isChar ? Object.assign({}, entry.delta || {}, {
            before_state: ($(`#ml-edit-before-${entryId}`).val() || "").trim(),
            after_state:  ($(`#ml-edit-after-${entryId}`).val() || "").trim(),
            delta:        ($(`#ml-edit-delta-${entryId}`).val() || "").trim(),
        }) : (entry.delta || {});
        const primaries = isChar ? ($(`#ml-edit-primary-${entryId}`).val() || "").split(",").map(s => s.trim()).filter(Boolean) : [];
        const keyChars  = isChar ? ($(`#ml-edit-key-${entryId}`).val() || "").split(",").map(s => s.trim()).filter(Boolean) : (entry.keyCharacters || []);
        const important = $(`#ml-edit-important-${entryId}`).prop("checked");
        const excludeFromConsolidation = $(`#ml-edit-exclude-${entryId}`).prop("checked");
        const stickiness = Math.max(0, parseInt($(`#ml-edit-stickiness-${entryId}`).val(), 10) || 0);
        const cooldown = Math.max(0, parseInt($(`#ml-edit-cooldown-${entryId}`).val(), 10) || 0);

        const update = {
            title, datetime, content, delta, important, excludeFromConsolidation,
            stickiness, cooldown,
            keyCharacters: keyChars,
        };
        if (isChar) {
            update.primaryCharacters = primaries;
            update.primaryCharacter = primaries.length === 1 ? primaries[0] : "";
        }

        // Re-routing rule: editing characters does NOT move the memory, with one
        // exception — going from single to multiple primaries routes to Group;
        // and dropping from multiple back to one routes to that character's folder.
        // A single-primary edit (e.g. fixing a name) keeps it where it is.
        const wasMulti = (entry.primaryCharacters || []).length >= 2;
        const nowMulti = primaries.length >= 2;
        let reroute = false;
        if (entry.category === "character") {
            if (nowMulti && !wasMulti) reroute = true;        // → Group
            else if (!nowMulti && wasMulti && primaries.length === 1) reroute = true; // → character folder
        }

        updateEntry(entryId, update);
        if (reroute) {
            const { routeEntry } = await import("../data/entries.js");
            updateEntry(entryId, { folderId: "" });   // clear so routeEntry reassigns
            routeEntry(getEntry(entryId));
        }
        const updatedEntry = getEntry(entryId);
        if (updatedEntry) reEmbedEntry(updatedEntry).catch(err => console.warn("[ML] Re-embed failed:", err));
        toastr?.success?.("Entry updated.");
        const $pane = $("#ml-p-library");
        if ($pane.length) renderLibraryTab($pane);
    });
    
    // Wire cancel
    $full.find(".ml-cancel-edit-btn").on("click", () => {
        const $pane = $("#ml-p-library");
        if ($pane.length) renderLibraryTab($pane);
    });
}

// ─── Scenes View ──────────────────────────────────────────


/**
 * Render the scenes view: info notice + scene list with editable summaries.
 *
 * @param {jQuery} $pane
 */
function renderScenesView($pane) {
    const $container = $('<div id="ml-scene-view"></div>');

    // Info notice
    $container.append(`
        <div class="ml-scene-info">
            Private narrative notes used by the memory writer to maintain continuity between sessions. Never injected into your main ST prompt.
        </div>
    `);

    const scenes = getAllScenes();

    if (scenes.length === 0) {
        $container.append(`
            <div style="padding:20px 0;text-align:center;color:#666;font-family:'IBM Plex Mono',monospace;font-size:12px">
                No scenes yet.<br>
                <span style="font-size:11px;color:#555">Open a scene from a message to get started.</span>
            </div>
        `);
        $pane.append($container);
        return;
    }

    // Split: live (not consolidated) scenes vs consolidated ones.
    const liveScenes = scenes.filter(s => !s.consolidatedInto);
    const consolidatedScenes = scenes.filter(s => s.consolidatedInto);

    // ── Bulk selection toolbar (live scenes only) ──
    if (liveScenes.length > 0) {
        const $sceneBar = $(`
            <div class="ml-scene-bulk-bar">
                <label class="ml-scene-bulk-all">
                    <input type="checkbox" id="ml-scene-select-all"> Select all
                </label>
                <button class="ml-btn-danger" id="ml-scene-delete-selected" disabled style="opacity:0.5;pointer-events:none">Delete selected (0)</button>
            </div>
        `);
        $container.append($sceneBar);

        function refreshSceneBulkBar() {
            const n = sceneBulkSelected.size;
            const $del = $sceneBar.find("#ml-scene-delete-selected");
            $del.text(`Delete selected (${n})`);
            if (n > 0) $del.prop("disabled", false).css({ opacity: "", pointerEvents: "" });
            else $del.prop("disabled", true).css({ opacity: "0.5", pointerEvents: "none" });
            const total = $container.find(".ml-scene-select").length;
            const checked = $container.find(".ml-scene-select:checked").length;
            $sceneBar.find("#ml-scene-select-all").prop("checked", total > 0 && checked === total);
        }

        $sceneBar.find("#ml-scene-select-all").on("change", function () {
            const on = this.checked;
            $container.find(".ml-scene-select").each(function () {
                this.checked = on;
                const id = $(this).data("scene-id");
                if (on) sceneBulkSelected.add(id); else sceneBulkSelected.delete(id);
            });
            refreshSceneBulkBar();
        });

        $sceneBar.find("#ml-scene-delete-selected").on("click", async function () {
            const n = sceneBulkSelected.size;
            if (n === 0) return;
            let ok = false;
            const ctx = window.SillyTavern?.getContext?.();
            if (ctx?.callGenericPopup) {
                const r = await ctx.callGenericPopup(`Delete <b>${n}</b> selected scene${n > 1 ? "s" : ""}? This cannot be undone.`, ctx.POPUP_TYPE?.CONFIRM || "confirm", "");
                ok = r === true || r === 1;
            } else ok = confirm(`Delete ${n} scenes?`);
            if (!ok) return;
            for (const id of sceneBulkSelected) { try { deleteScene(id); } catch (e) { console.error("[ML] scene delete failed:", e); } }
            sceneBulkSelected.clear();
            $pane.empty();
            renderScenesView($pane);
        });

        // expose for the per-entry checkbox handler
        $container.data("refreshSceneBulkBar", refreshSceneBulkBar);
    }

    liveScenes.forEach((scene, idx) => {
        $container.append(renderSceneEntry(scene, idx));
    });
    // restore checkbox state + bar after entries render
    $container.find(".ml-scene-select").each(function () {
        const id = $(this).data("scene-id");
        if (sceneBulkSelected.has(id)) this.checked = true;
    });
    {
        const fn = $container.data("refreshSceneBulkBar");
        if (typeof fn === "function") fn();
    }

    // ── Consolidated scenes: grouped into per-consolidation folders ──
    if (consolidatedScenes.length > 0) {
        // group by the consolidation they were folded into
        const groups = new Map();
        for (const s of consolidatedScenes) {
            if (!groups.has(s.consolidatedInto)) groups.set(s.consolidatedInto, []);
            groups.get(s.consolidatedInto).push(s);
        }
        $container.append(`<div class="ml-scene-archive-hdr">Consolidated scene archive</div>`);
        for (const [consId, members] of groups) {
            $container.append(renderConsolidatedSceneFolder(consId, members));
        }
    }

    $pane.append($container);
}

/**
 * Render a folder grouping all scenes that were folded into one consolidation.
 * Title + summary come from the consolidation record and are BOTH editable
 * (the LLM mislabels sometimes). Inside, each member scene is shown read-only-ish
 * (still editable via its own card) so the user can verify what was grouped.
 */
function renderConsolidatedSceneFolder(consolidationId, scenes) {
    const cons = getConsolidation(consolidationId);
    const folderTitle = (cons && cons.title) ? cons.title : "Consolidated scenes";
    const folderSummary = (cons && (cons.summary || cons.preferred_injection)) || "";
    const fid = `consfold-${consolidationId}`;

    const $folder = $(`
        <div class="ml-scene-archive-folder" id="ml-${fid}">
            <div class="ml-scene-archive-folder-hdr">
                ${iconSvg("ico-chevron-right", 12, 12, "#888")}
                <span class="ml-scene-archive-folder-name">${escapeHtml(folderTitle)}</span>
                <span class="ml-scene-archive-folder-count">${scenes.length} ${scenes.length === 1 ? "scene" : "scenes"}</span>
            </div>
            <div class="ml-scene-archive-folder-body">
                <div class="ml-field-hdr"><span class="ml-lbl" style="margin-bottom:0">Folder title · editable</span><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-${fid}-title" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i></div>
                <input class="ml-form-input" id="ml-${fid}-title" value="${escapeHtml(folderTitle)}" style="margin-bottom:8px">
                <div class="ml-field-hdr"><span class="ml-lbl" style="margin-bottom:0">Folder summary · editable</span><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-${fid}-summary" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i></div>
                <textarea class="ml-form-textarea" id="ml-${fid}-summary" rows="4" style="margin-bottom:8px">${escapeHtml(folderSummary)}</textarea>
                <div class="ml-btn-row" style="margin-bottom:10px">
                    <button class="ml-btn ml-${fid}-save">Save folder</button>
                </div>
                <div class="ml-scene-archive-members"></div>
            </div>
        </div>
    `);

    // restore open state
    if (openFolders.has(fid)) $folder.addClass("open");
    $folder.find(".ml-scene-archive-folder-hdr").on("click", function () {
        const isOpen = $folder.toggleClass("open").hasClass("open");
        if (isOpen) openFolders.add(fid); else openFolders.delete(fid);
    });

    // save edited title/summary back onto the consolidation record
    $folder.find(`.ml-${fid}-save`).on("click", function (e) {
        e.stopPropagation();
        const newTitle = $(`#ml-${fid}-title`).val().trim();
        const newSummary = $(`#ml-${fid}-summary`).val().trim();
        if (consolidationId && getConsolidation(consolidationId)) {
            updateConsolidation(consolidationId, { title: newTitle, summary: newSummary });
            toastr?.success?.("Consolidated scene folder updated.");
        } else {
            toastr?.warning?.("Consolidation record not found — changes not saved.");
        }
    });

    // member scenes (each rendered as its normal card, still individually editable)
    const $members = $folder.find(".ml-scene-archive-members");
    scenes.forEach((scene, idx) => {
        $members.append(renderSceneEntry(scene, idx));
    });

    return $folder;
}

/**
 * Render a single scene entry as a collapsible card.
 *
 * @param {object} scene
 * @returns {jQuery}
 */
function renderSceneEntry(scene, sceneIndex) {
    const mesRange = scene.messageEnd
        ? `msgs ${scene.messageStart}–${scene.messageEnd}`
        : `msg ${scene.messageStart}+`;
    const titleText = scene.sceneTitle || extractSceneTitle(scene.llmSummary);

    const $scene = $(`
        <div class="ml-scene-entry" id="ml-scene-${scene.id}">
            <div class="ml-scene-hdr">
                <input type="checkbox" class="ml-scene-select" data-scene-id="${scene.id}" title="Select for bulk delete" onclick="event.stopPropagation()" style="margin:0 4px 0 0;cursor:pointer">
                <span class="ml-scene-num">Scene ${typeof sceneIndex === "number" ? sceneIndex + 1 : scene.id.replace("ml_scene_", "")}</span>
                <input class="ml-scene-title-input" id="ml-scene-title-${scene.id}" value="${escapeHtml(titleText)}" title="Click to edit scene title" onclick="event.stopPropagation()">
                <span class="ml-scene-badge">${mesRange}</span>
                ${iconSvg("ico-chevron-down", 14, 14, "#666")}
            </div>
            <div class="ml-scene-body">
                <div class="ml-field-hdr">
                    <span class="ml-lbl" style="margin-bottom:0">Summary · editable</span>
                    <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-scene-summary-${scene.id}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i>
                </div>
                <textarea id="ml-scene-summary-${scene.id}" rows="5" style="margin-bottom:10px">${escapeHtml(scene.llmSummary || "")}</textarea>
                <div class="ml-btn-row">
                    <button class="ml-btn ml-save-scene-btn" data-scene-id="${scene.id}">Save summary</button>
                    <button class="ml-btn-danger ml-delete-scene-btn" data-scene-id="${scene.id}">Delete scene</button>
                </div>
            </div>
        </div>
    `);

    // Toggle expand/collapse
    $scene.find(".ml-scene-hdr").on("click", function () {
        $scene.toggleClass("open");
    });

    // Bulk-select checkbox
    $scene.find(".ml-scene-select").on("change", function () {
        const id = $(this).data("scene-id");
        if (this.checked) sceneBulkSelected.add(id); else sceneBulkSelected.delete(id);
        // walk up to the scenes container that holds the refresh fn
        let $c = $scene.parent();
        while ($c.length && !$c.data("refreshSceneBulkBar")) $c = $c.parent();
        const fn = $c.data("refreshSceneBulkBar");
        if (typeof fn === "function") fn();
    });



    // Save summary (also saves the editable title)
    $scene.find(".ml-save-scene-btn").on("click", (e) => {
        e.stopPropagation();
        const summary = $(`#ml-scene-summary-${scene.id}`).val();
        const title = $(`#ml-scene-title-${scene.id}`).val().trim();
        updateSceneSummary(scene.id, summary);
        // Store editable title directly on the scene object
        const scenes = getScenes();
        const sc = scenes.find(s => s.id === scene.id);
        if (sc) { sc.sceneTitle = title || null; saveScenes(scenes); }
        toastr?.success?.("Scene summary saved.");
    });

    // Delete scene
    $scene.find(".ml-delete-scene-btn").on("click", async (e) => {
        e.stopPropagation();
        const ok = await popup(`Delete Scene ${typeof sceneIndex === "number" ? sceneIndex + 1 : scene.id.replace("ml_scene_", "")}?`);
        if (ok) {
            deleteScene(scene.id);
            $(document).trigger("ml:scene-state-changed");
            const $pane = $("#ml-p-library");
            if ($pane.length) renderLibraryTab($pane);
        }
    });

    return $scene;
}

// ─── Modals ───────────────────────────────────────────────

// ─── Consolidation modal ──────────────────────────────────

// Selection state for the consolidate popout (memories + scenes in ONE flow)
const consolidateSelEntries = new Set();
const consolidateSelScenes = new Set();

/**
 * Open the unified Consolidate popout: pick any mix of memories AND scenes,
 * Select All within each list, then one confirm runs a SINGLE consolidation
 * over the combined selection — so memories and scenes are fused together
 * into one arc, not split into separate runs.
 *
 * @param {jQuery} $pane - the library pane (for re-render after consolidation)
 */
function openConsolidateModal($pane, scopeFolderId = null) {
    consolidateSelEntries.clear();
    consolidateSelScenes.clear();

    // Eligible memory sources: ACTIVE (never consolidated) OR "consolidation"
    // (products of a PRIOR consolidation — foldable into a higher-level arc).
    // EXCLUDES "consolidated" (already-demoted). Newest first.
    let entries = getAllEntries()
        .filter(e => (e.status === "active" || e.status === "consolidation") && !e.excludeFromConsolidation)
        // Exclude entries already used as a consolidation source. Starred sources
        // keep "active" status (never demoted) so they'd otherwise reappear here
        // every time — this marker keeps them out once consolidated.
        .filter(e => !e.consolidatedSourceOf)
        // World memories: only EVENTS (setting-altering, narrative) are worth
        // consolidating. Static world FACTS are reference material with no arc to
        // synthesize, so they're excluded from consolidation entirely.
        .filter(e => e.category !== "world" || e.worldEvent === true)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // Folder-scoped consolidation: restrict to memories in this folder (or, for a
    // parent folder, its subfolders too).
    let scopeName = "";
    if (scopeFolderId) {
        const folder = getAllFolders().find(f => f.id === scopeFolderId);
        scopeName = folder ? (folder.name || folder.characterName || "") : "";
        const childIds = getAllFolders().filter(f => f.parentId === scopeFolderId).map(f => f.id);
        const allowed = new Set([scopeFolderId, ...childIds]);
        entries = entries.filter(e => allowed.has(e.folderId));
    }

    // Scenes are only relevant for global consolidation, not folder-scoped.
    const scenes = scopeFolderId ? [] : getAllScenes().filter(s => s.status === "closed" && !s.consolidatedInto);

    // ── Group memory rows by category: Plot, Character, World, Custom ──
    const DEFAULT_FOLDER_IDS = new Set(["characters", "world", "plot"]);
    function getRootFolder(folder) {
        let cur = folder, guard = 0;
        while (cur && cur.parentId && guard++ < 10) cur = getAllFolders().find(ff => ff.id === cur.parentId);
        return cur || folder;
    }
    // Returns a group KEY for an entry. Default categories use fixed keys
    // (World/Plot/Character); custom-folder memories use the root custom folder's
    // own name so each custom folder becomes its own named section.
    function categoryOf(e) {
        const f = getAllFolders().find(ff => ff.id === e.folderId);
        if (f) {
            const root = getRootFolder(f);
            const t = root.type;
            if (t === "world") return "World";
            if (t === "plot") return "Plot";
            if (t === "characters") return "Character";
            // custom folder → its own section, keyed by the custom folder's name
            return "custom:" + root.id;
        }
        if (e.category === "world") return "World";
        if (e.category === "plot") return "Plot";
        if (e.category === "character") return "Character";
        return "Character";
    }

    // Build groups. Default categories are fixed; custom folders are added
    // dynamically, each keyed by its root folder id, labelled with its name.
    const groups = {};                 // key -> array of entries
    const customMeta = {};             // "custom:<id>" -> { name, icon }
    for (const e of entries) {
        const key = categoryOf(e);
        (groups[key] = groups[key] || []).push(e);
        if (key.startsWith("custom:") && !customMeta[key]) {
            const root = getRootFolder(getAllFolders().find(ff => ff.id === e.folderId) || {});
            customMeta[key] = { name: root.name || "Custom", icon: root.customIcon || "\ud83d\udcc1" };
        }
    }

    function rowHtml(e) {
        const who = (e.category === "world")
            ? "\ud83c\udf10 World"
            : (e.primaryCharacters && e.primaryCharacters.length)
                ? e.primaryCharacters.join(", ")
                : (e.primaryCharacter || "—");
        return `
            <label class="ml-consld-row">
                <input type="checkbox" class="ml-consld-entry" data-id="${e.id}">
                <span class="ml-consld-row-title">${escapeHtml(e.title || "Untitled")}</span>
                <span class="ml-consld-row-meta">${escapeHtml(who)}${e.datetime ? " · " + escapeHtml(e.datetime) : ""}</span>
            </label>`;
    }

    // Build grouped sections. Fixed default categories first (in order), then
    // each custom folder as its own named section.
    const CATEGORY_EMOJI = { Plot: "\ud83d\udcd6", Character: "\ud83d\udc64", World: "\ud83c\udf10" };
    const fixedOrder = ["Plot", "Character", "World"];
    const customKeys = Object.keys(groups).filter(k => k.startsWith("custom:"))
        .sort((a, b) => (customMeta[a]?.name || "").localeCompare(customMeta[b]?.name || ""));

    const renderGroup = (key, label, emoji) => {
        if (!groups[key] || !groups[key].length) return "";
        const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");  // CSS-safe selector token
        return `
        <div class="ml-consld-group" data-group="${safe}">
            <div class="ml-consld-group-hdr">
                <span>${emoji ? emoji + " " : ""}${escapeHtml(label)} <span class="ml-consld-group-count">(${groups[key].length})</span></span>
                <button class="ml-btn ml-consld-group-all" data-group="${safe}" type="button">Select all</button>
            </div>
            ${groups[key].map(rowHtml).join("")}
        </div>`;
    };

    const entryRows = [
        ...fixedOrder.map(g => renderGroup(g, g, CATEGORY_EMOJI[g])),
        ...customKeys.map(k => renderGroup(k, customMeta[k].name, customMeta[k].icon)),
    ].join("");

    const sceneRows = scenes.map((s, i) => {
        const range = s.messageEnd ? `msgs ${s.messageStart}–${s.messageEnd}` : `msg ${s.messageStart}+`;
        const title = s.sceneTitle || extractSceneTitle(s.llmSummary) || `Scene ${i + 1}`;
        return `
            <label class="ml-consld-row">
                <input type="checkbox" class="ml-consld-scene" data-id="${s.id}">
                <span class="ml-consld-row-title">${escapeHtml(title)}</span>
                <span class="ml-consld-row-meta">${range}</span>
            </label>`;
    }).join("");

    const titleText = scopeFolderId ? `Consolidate: ${escapeHtml(scopeName || "folder")}` : "Consolidate an arc";
    const subText = scopeFolderId
        ? "Select which memories in this folder to fuse into one arc. Originals are kept at reduced priority, not deleted."
        : "Select any mix of memories and scenes. They're fused into ONE arc: updated character memories + a single arc summary in Plot. Originals are kept at reduced priority, not deleted.";

    const scenesCol = scopeFolderId ? "" : `
                    <div class="ml-consld-col">
                        <div class="ml-consld-col-hdr">
                            <span>Scenes</span>
                            <button class="ml-btn ml-consld-all" data-target="scene" type="button">Select all</button>
                        </div>
                        <div class="ml-consld-list" id="ml-consld-scenes">
                            ${sceneRows || '<div class="ml-consld-empty">No scenes.</div>'}
                        </div>
                    </div>`;

    const $modal = $(`
        <div class="ml-modal-overlay" id="ml-consolidate-modal">
            <div class="ml-modal ml-modal-consolidate">
                <div>
                    <div class="ml-modal-title">${titleText}</div>
                    <div class="ml-modal-sub">${subText}</div>
                </div>

                <div class="ml-consld-cols">
                    <div class="ml-consld-col">
                        <div class="ml-consld-col-hdr">
                            <span>Memories</span>
                            <button class="ml-btn ml-consld-all" data-target="entry" type="button">Select all</button>
                        </div>
                        <div class="ml-consld-list" id="ml-consld-entries">
                            ${entryRows || '<div class="ml-consld-empty">No eligible memories.</div>'}
                        </div>
                    </div>
                    ${scenesCol}
                </div>

                <div class="ml-consld-count" id="ml-consld-count">Nothing selected</div>

                <div class="ml-btn-row">
                    <button class="ml-btn-confirm" id="ml-consld-confirm" disabled>Consolidate selection</button>
                    <button class="ml-btn-danger" id="ml-consld-cancel">Cancel</button>
                </div>
            </div>
        </div>
    `);

    function refreshCount() {
        const n = consolidateSelEntries.size + consolidateSelScenes.size;
        const $c = $modal.find("#ml-consld-count");
        $c.text(n === 0
            ? "Nothing selected"
            : `${consolidateSelEntries.size} ${consolidateSelEntries.size === 1 ? "memory" : "memories"} · ${consolidateSelScenes.size} ${consolidateSelScenes.size === 1 ? "scene" : "scenes"} selected`);
        $modal.find("#ml-consld-confirm").prop("disabled", n < 2);
    }

    $modal.on("change", ".ml-consld-entry", function () {
        const id = $(this).data("id");
        if (this.checked) consolidateSelEntries.add(id); else consolidateSelEntries.delete(id);
        refreshCount();
    });
    $modal.on("change", ".ml-consld-scene", function () {
        const id = $(this).data("id");
        if (this.checked) consolidateSelScenes.add(id); else consolidateSelScenes.delete(id);
        refreshCount();
    });

    // Per-category "Select all"
    $modal.on("click", ".ml-consld-group-all", function (e) {
        e.preventDefault();
        const g = $(this).data("group");
        const $checks = $modal.find(`.ml-consld-group[data-group="${g}"] .ml-consld-entry`);
        const allChecked = $checks.length > 0 && $checks.toArray().every(c => c.checked);
        $checks.each(function () {
            const id = $(this).data("id");
            this.checked = !allChecked;
            if (!allChecked) consolidateSelEntries.add(id); else consolidateSelEntries.delete(id);
        });
        $(this).text(allChecked ? "Select all" : "Select none");
        refreshCount();
    });

    // Column-level "Select all" (Memories = all groups, or Scenes)
    $modal.find(".ml-consld-all").on("click", function () {
        const target = $(this).data("target");
        const sel = target === "entry" ? "#ml-consld-entries .ml-consld-entry" : "#ml-consld-scenes .ml-consld-scene";
        const set = target === "entry" ? consolidateSelEntries : consolidateSelScenes;
        const $checks = $modal.find(sel);
        const allChecked = $checks.length > 0 && $checks.toArray().every(c => c.checked);
        $checks.each(function () {
            const id = $(this).data("id");
            this.checked = !allChecked;
            if (!allChecked) set.add(id); else set.delete(id);
        });
        $(this).text(allChecked ? "Select all" : "Select none");
        refreshCount();
    });

    $modal.on("click", function (e) { if (e.target === this) closeConsolidateModal(); });
    $modal.find("#ml-consld-cancel").on("click", closeConsolidateModal);

    $modal.find("#ml-consld-confirm").on("click", async function () {
        const entryIds = [...consolidateSelEntries];
        const sceneIds = [...consolidateSelScenes];
        // Scenes also contribute their own member memories as entry sources, so a
        // scene-heavy selection still surfaces the underlying memories. Dedup
        // against explicitly-picked memories.
        const sceneMemberIds = getAllEntries()
            .filter(e => sceneIds.includes(e.sceneId))
            .map(e => e.id);
        const mergedEntryIds = [...new Set([...entryIds, ...sceneMemberIds])];
        if (mergedEntryIds.length + sceneIds.length < 2) {
            toastr?.warning?.("Select at least 2 sources to consolidate.");
            return;
        }
        $(this).prop("disabled", true).text("Consolidating…");
        const { runConsolidation } = await import("../llm/consolidationOrchestrator.js");
        await runConsolidation({ entryIds: mergedEntryIds, sceneIds, mode: "mixed" });
        closeConsolidateModal();
        renderLibraryTab($pane);
    });

    // Append the modal INSIDE the Memory Loom popout if it's open, so it renders
    // within the extension rather than as a detached body-level overlay (which on
    // mobile showed through to the chat behind the popout). Fall back to body
    // when running in the docked extensions drawer.
    const $host = $("#ml-popout").length ? $("#ml-popout") : $("body");
    $host.append($modal);
    requestAnimationFrame(() => $modal.addClass("open"));
}

function closeConsolidateModal() {
    const $m = $("#ml-consolidate-modal");
    $m.removeClass("open");
    setTimeout(() => $m.remove(), 200);
}

/**
 * Render the New Entry modal (hidden by default).
 *
 * @param {jQuery} $pane
 */
function renderNewEntryModal($pane) {
    const $modal = $(`
        <div class="ml-modal-overlay" id="ml-new-entry-modal">
            <div class="ml-modal">
                <div>
                    <div class="ml-modal-title">New memory entry</div>
                    <div class="ml-modal-sub">Manually created entries are auto-embedded on save</div>
                </div>
                <div class="ml-form-row">
                    <div class="ml-form-group">
                        <div class="ml-field-hdr">
                            <label class="ml-form-label">Title</label>
                            <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-ne-title" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i>
                        </div>
                        <input class="ml-form-input" type="text" id="ml-ne-title" placeholder="e.g. The Night of Falling Embers">
                    </div>
                    <div class="ml-form-group">
                        <div class="ml-field-hdr">
                            <label class="ml-form-label">Date / Time</label>
                            <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-ne-datetime" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i>
                        </div>
                        <input class="ml-form-input" type="text" id="ml-ne-datetime" placeholder="e.g. Victorian Era · 1888 · dusk">
                    </div>
                </div>
                <div class="ml-form-group">
                    <div class="ml-field-hdr">
                        <label class="ml-form-label">Content</label>
                        <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-ne-content" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i>
                    </div>
                    <textarea class="ml-form-textarea" id="ml-ne-content" placeholder="Write the memory entry here. Use rich, specific, sensory and emotionally precise prose…"></textarea>
                </div>
                <div class="ml-form-group ml-charonly-field">
                    <div class="ml-field-hdr"><div class="ml-form-label" style="margin-bottom:0">Before</div></div>
                    <textarea class="ml-form-textarea" id="ml-ne-before" rows="2" placeholder="The character's stance before this moment (optional)"></textarea>
                    <div class="ml-field-hdr"><div class="ml-form-label" style="margin-bottom:0">After</div></div>
                    <textarea class="ml-form-textarea" id="ml-ne-after" rows="2" placeholder="What changed for the character (optional)"></textarea>
                    <div class="ml-field-hdr"><div class="ml-form-label" style="margin-bottom:0">Delta</div></div>
                    <textarea class="ml-form-textarea" id="ml-ne-delta" rows="2" placeholder="Short label for the shift (optional)"></textarea>
                </div>
                <div class="ml-form-row">
                    <div class="ml-form-group">
                        <label class="ml-form-label">Category</label>
                        <select class="ml-form-select" id="ml-ne-category">
                            <option value="character">Character</option>
                            <option value="world">World</option>
                            <option value="plot">Plot</option>
                            ${getAllFolders().filter(f => !f.parentId && !["ml_folder_characters","ml_folder_world","ml_folder_plot"].includes(f.id)).map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("")}
                        </select>
                    </div>
                    <div class="ml-form-group">
                        <label class="ml-form-label">Destination</label>
                        <select class="ml-form-select" id="ml-ne-folder"></select>
                        <div class="ml-form-hint">For Characters: pick a specific character, or pick "Characters" and a new subfolder is made from the primary character's name on save.</div>
                    </div>
                </div>
                <div class="ml-form-group ml-charonly-field">
                    <label class="ml-form-label">Primary character(s)</label>
                    <div class="ml-form-hint">Separate multiple names with a comma. 2+ primaries → auto-routes to Group subfolder.</div>
                    <div class="ml-char-tag-input" id="ml-ne-primary-wrap">
                        <input class="ml-char-tag-ghost" id="ml-ne-primary-input" placeholder="Type name(s), separate with comma…">
                    </div>
                </div>
                <div class="ml-form-group ml-charonly-field">
                    <label class="ml-form-label">Key characters</label>
                    <div class="ml-form-hint">Supporting cast — for reference only, no routing effect.</div>
                    <div class="ml-char-tag-input" id="ml-ne-key-wrap">
                        <input class="ml-char-tag-ghost" id="ml-ne-key-input" placeholder="Type a name and press Enter or comma…">
                    </div>
                </div>
                <div class="ml-route-preview" id="ml-ne-route-preview">
                    <span>Destination:</span> fill in category and primary character(s) to preview routing
                </div>
                <div class="ml-btn-row">
                    <button class="ml-btn-confirm" id="ml-save-entry-btn">Save entry</button>
                    <button class="ml-btn-danger" id="ml-cancel-entry-btn">Cancel</button>
                </div>
            </div>
        </div>
    `);

    // Wire close on overlay click
    $modal.on("click", function (e) {
        if (e.target === this) closeModal("ml-new-entry-modal");
    });

    // Category → Destination: rebuild the Destination dropdown to match category.
    // Scoped to $modal so it works even before the modal is appended to the DOM
    // (the previous version queried the live document and ran before append,
    // leaving the dropdown empty until you toggled categories).
    function populateDestination(cat) {
        const all = getAllFolders();
        let opts = [];
        if (cat === "world") {
            // World folder + any custom subfolders under it
            opts = all.filter(f => f.id === "ml_folder_world" || f.parentId === "ml_folder_world");
        } else if (cat === "plot") {
            opts = all.filter(f => f.id === "ml_folder_plot" || f.parentId === "ml_folder_plot");
        } else if (cat === "character") {
            const top = all.filter(f => f.id === "ml_folder_characters");
            const subs = all.filter(f => f.parentId === "ml_folder_characters");
            opts = [...top, ...subs];
        } else {
            // Custom category → the matching custom top-level folder + its subfolders
            const top = all.filter(f => f.id === cat);
            const subs = all.filter(f => f.parentId === cat);
            opts = [...top, ...subs];
        }
        const $sel = $modal.find("#ml-ne-folder");
        $sel.empty();
        for (const f of opts) {
            const indent = f.parentId ? "— " : "";
            $sel.append(`<option value="${f.id}">${indent}${escapeHtml(f.name)}</option>`);
        }
    }
    function updateRoutePreview() {
        const cat = $modal.find("#ml-ne-category").val();
        const $prev = $modal.find("#ml-ne-route-preview");
        if (cat === "character") {
            const primaryRaw = ($modal.find("#ml-ne-primary-input").val() || "").trim();
            const primaries = primaryRaw ? primaryRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
            const destId = ($modal.find("#ml-ne-folder").val() || "").trim();
            if (primaries.length >= 2) {
                $prev.html(`<span>Destination:</span> Group subfolder (${escapeHtml(primaries.join(" & "))})`);
            } else if (destId === "ml_folder_characters" || !destId) {
                if (primaries.length === 1) {
                    $prev.html(`<span>Destination:</span> Characters › ${escapeHtml(primaries[0])} (new subfolder if needed)`);
                } else {
                    $prev.html(`<span>Destination:</span> enter a primary character to route`);
                }
            } else {
                const f = getAllFolders().find(x => x.id === destId);
                $prev.html(`<span>Destination:</span> ${escapeHtml(f ? f.name : "selected folder")}`);
            }
        } else {
            const destId = ($modal.find("#ml-ne-folder").val() || "").trim();
            const f = getAllFolders().find(x => x.id === destId);
            $prev.html(`<span>Destination:</span> ${escapeHtml(f ? f.name : (cat === "world" ? "World" : cat === "plot" ? "Plot" : "selected folder"))}`);
        }
    }

    function applyCategoryUI(cat) {
        populateDestination(cat);
        // Character-only fields (before/after/delta, primary, key) are hidden for
        // world/plot/custom categories — those don't have characters or deltas.
        const showChar = (cat === "character");
        $modal.find(".ml-charonly-field").toggle(showChar);
        updateRoutePreview();
    }
    $modal.find("#ml-ne-category").on("change", function () { applyCategoryUI($(this).val()); });
    $modal.find("#ml-ne-folder").on("change", updateRoutePreview);
    $modal.find("#ml-ne-primary-input").on("input", updateRoutePreview);
    applyCategoryUI("character"); // initial fill (Character is the default category)

    // Wire cancel button
    $modal.find("#ml-cancel-entry-btn").on("click", () => closeModal("ml-new-entry-modal"));

    // Wire save button
    $modal.find("#ml-save-entry-btn").on("click", async () => {
        const { createEntry } = await import("../data/entries.js");
        const title = $("#ml-ne-title").val().trim();
        const datetime = $("#ml-ne-datetime").val().trim();
        const content = $("#ml-ne-content").val().trim();
        const category = $("#ml-ne-category").val();

        if (!title && !content) {
            toastr?.warning?.("Please fill in at least a title or content.");
            return;
        }

        const cat = category || "character";
        const isChar = cat === "character";

        const primaryInput = isChar ? $("#ml-ne-primary-input").val().trim() : "";
        const primaries = primaryInput ? primaryInput.split(",").map(s => s.trim()).filter(Boolean) : [];

        const keyInput = isChar ? $("#ml-ne-key-input").val().trim() : "";
        const keyChars = keyInput ? keyInput.split(",").map(s => s.trim()).filter(Boolean) : [];

        if (isChar && primaries.length === 0) {
            toastr?.warning?.("Character memories need at least one primary character.");
            return;
        }

        // Destination is a folder ID from the dropdown.
        let folderId = ($("#ml-ne-folder").val() || "").trim();

        // If the user left it on the top-level "Characters" folder, route by the
        // primary character instead — reusing the same get-or-create-subfolder
        // path the writer uses, so a brand-new character gets a fresh subfolder.
        if (folderId === "ml_folder_characters" || (isChar && !folderId)) {
            folderId = ""; // let createEntry's routeEntry assign the character subfolder
        }

        const entryData = {
            title,
            datetime,
            content,
            category: cat,
            source: "manual",
            folderId,
        };
        // Character entries carry characters + delta; world/plot/custom do not.
        if (isChar) {
            entryData.primaryCharacter = primaries;
            entryData.primaryCharacters = primaries;
            entryData.keyCharacters = keyChars;
            entryData.delta = {
                before_state: ($("#ml-ne-before").val() || "").trim(),
                after_state:  ($("#ml-ne-after").val() || "").trim(),
                delta:        ($("#ml-ne-delta").val() || "").trim(),
                delta_type: [],
                low_delta_flag: false,
            };
        }
        const entry = createEntry(entryData);

        embedEntry(entry).catch(err => console.warn("[ML] Embed failed:", err));
        toastr?.success?.(`Entry "${title || "Untitled"}" created.`);
        // reset the inputs so the next open is clean
        $("#ml-ne-title,#ml-ne-datetime,#ml-ne-content,#ml-ne-before,#ml-ne-after,#ml-ne-delta,#ml-ne-primary-input,#ml-ne-key-input").val("");
        closeModal("ml-new-entry-modal");
        renderLibraryTab($pane);
    });

    $pane.append($modal);
}

/**
 * Render the New Folder modal (hidden by default).
 *
 * @param {jQuery} $pane
 */
function renderNewFolderModal($pane) {
    const $modal = $(`
        <div class="ml-modal-overlay" id="ml-new-folder-modal">
            <div class="ml-modal">
                <div>
                    <div class="ml-modal-title">New folder</div>
                    <div class="ml-modal-sub">Primary folders sit alongside World / Character / Plot. Subfolders live inside them.</div>
                </div>
                <div class="ml-form-group">
                    <label class="ml-form-label">Folder name</label>
                    <input class="ml-form-input" type="text" id="ml-nf-name" placeholder="e.g. Victorian Era, Side Characters, Arcs…">
                </div>
                <div class="ml-form-group">
                    <label class="ml-form-label">Folder level</label>
                    <div class="ml-pill-row">
                        <button class="ml-pill on" id="ml-nf-pill-primary">Primary</button>
                        <button class="ml-pill" id="ml-nf-pill-sub">Subfolder</button>
                    </div>
                </div>
                <div class="ml-form-group" id="ml-nf-parent-group" style="display:none">
                    <label class="ml-form-label">Place inside</label>
                    <select class="ml-form-select" id="ml-nf-parent"></select>
                </div>
                <div class="ml-route-preview" id="ml-nf-preview">
                    <span>Primary folder</span> · sits at the top level alongside World / Character / Plot · gets a <span>+ New entry</span> button
                </div>
                <div class="ml-btn-row">
                    <button class="ml-btn-confirm" id="ml-create-folder-btn">Create folder</button>
                    <button class="ml-btn-danger" id="ml-cancel-folder-btn">Cancel</button>
                </div>
            </div>
        </div>
    `);

    // Wire close on overlay click
    $modal.on("click", function (e) {
        if (e.target === this) closeModal("ml-new-folder-modal");
    });

    // Wire cancel
    $modal.find("#ml-cancel-folder-btn").on("click", () => closeModal("ml-new-folder-modal"));

    // Populate the "Place inside" dropdown from ALL top-level folders, so custom
    // folders are valid parents too — not just the three defaults. Rebuilt each
    // time Subfolder is chosen, so folders created this session show up.
    function refreshParentOptions() {
        const $sel = $modal.find("#ml-nf-parent");
        const prev = $sel.val();
        $sel.empty();
        const tops = getAllFolders().filter(f => !f.parentId);
        for (const f of tops) {
            $sel.append(`<option value="${f.id}">${escapeHtml(f.name)}</option>`);
        }
        if (prev && tops.some(f => f.id === prev)) $sel.val(prev);
    }

    // Wire level pills
    $modal.find("#ml-nf-pill-primary").on("click", function () {
        $(this).addClass("on");
        $modal.find("#ml-nf-pill-sub").removeClass("on");
        $modal.find("#ml-nf-parent-group").hide();
    });
    $modal.find("#ml-nf-pill-sub").on("click", function () {
        $(this).addClass("on");
        $modal.find("#ml-nf-pill-primary").removeClass("on");
        refreshParentOptions();
        $modal.find("#ml-nf-parent-group").show();
    });

    // Wire create
    $modal.find("#ml-create-folder-btn").on("click", async () => {
        const { createFolder } = await import("../data/folders.js");
        const name = $("#ml-nf-name").val().trim();
        if (!name) {
            toastr?.warning?.("Please enter a folder name.");
            return;
        }

        const isPrimary = $("#ml-nf-pill-primary").hasClass("on");
        const parentId = isPrimary ? null : $("#ml-nf-parent").val();

        createFolder({
            name,
            type: isPrimary ? "primary" : "subfolder",
            parentId,
        });

        toastr?.success?.(`Folder "${name}" created.`);
        closeModal("ml-new-folder-modal");
        renderLibraryTab($pane);
    });

    $pane.append($modal);
}

/**
 * Render the crop modal for character banner images (hidden by default).
 *
 * @param {jQuery} $pane
 */
function renderCropModal($pane) {
    const $modal = $(`
        <div class="ml-crop-overlay" id="ml-crop-modal">
            <div class="ml-crop-modal">
                <div>
                    <div class="ml-crop-title">Crop folder image</div>
                    <div class="ml-crop-sub">Drag to reposition · drag corners to resize · aspect ratio locked to banner</div>
                </div>
                <div class="ml-crop-wrap" id="ml-crop-wrap">
                    <img id="ml-crop-img" src="" alt="" draggable="false">
                    <div class="ml-crop-overlay-box" id="ml-crop-box"></div>
                    <div class="ml-crop-handle nw" id="ml-ch-nw"></div>
                    <div class="ml-crop-handle ne" id="ml-ch-ne"></div>
                    <div class="ml-crop-handle sw" id="ml-ch-sw"></div>
                    <div class="ml-crop-handle se" id="ml-ch-se"></div>
                </div>
                <div class="ml-btn-row" style="margin-bottom:8px">
                    <button class="ml-btn ml-crop-rotate-l" title="Rotate left 90°">⟲ Rotate left</button>
                    <button class="ml-btn ml-crop-rotate-r" title="Rotate right 90°">⟳ Rotate right</button>
                </div>
                <div class="ml-btn-row">
                    <button class="ml-btn" id="ml-crop-skip">Skip crop</button>
                    <button class="ml-btn-confirm" id="ml-crop-apply">Crop & save</button>
                    <button class="ml-btn-danger" id="ml-crop-cancel">Cancel</button>
                </div>
            </div>
        </div>
        <input type="file" id="ml-img-upload" accept="image/*" style="display:none">
    `);

    // Wire file input — load image into crop modal when file is selected
    $(document).off("change.ml-lib", "#ml-img-upload").on("change.ml-lib", "#ml-img-upload", function () {
        const file = this.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (e) {
            const img = document.getElementById("ml-crop-img");
            if (img) {
                img.src = e.target.result;
                // Wait for image to fully load before setting up crop
                img.onload = () => initCrop();
            }
            openModal("ml-crop-modal");
        };
        reader.readAsDataURL(file);
        this.value = "";
    });

    // Wire close buttons — crop & save uses canvas to produce cropped data URL
    $modal.find("#ml-crop-cancel").on("click", () => closeModal("ml-crop-modal"));

    // Rotate buttons — physically rotate the source image 90°, then re-init the
    // crop box. Rotating the data (not just CSS) keeps the crop math simple,
    // since by save time the image is already in its final orientation.
    $modal.find(".ml-crop-rotate-l").on("click", () => rotateCropImage(-90));
    $modal.find(".ml-crop-rotate-r").on("click", () => rotateCropImage(90));
    $modal.find("#ml-crop-skip").on("click", async () => {
        await applyBannerImage();
        toastr?.success?.("Folder image saved (uncropped).");
        closeModal("ml-crop-modal");
        renderLibraryTab($("#ml-p-library"));
    });
    $modal.find("#ml-crop-apply").on("click", async () => {
        await applyCroppedImage();
        toastr?.success?.("Folder image cropped and saved.");
        closeModal("ml-crop-modal");
        renderLibraryTab($("#ml-p-library"));
    });

    $pane.append($modal);
}

// ─── Crop Engine ──────────────────────────────────────────

/**
 * Rotate the crop image by ±90°. Re-renders the image data to a rotated canvas,
 * swaps it into the <img>, and re-initializes the crop box once the new image
 * loads. Works for both character and custom-subfolder banners (shared modal).
 */
function rotateCropImage(deg) {
    const img = document.getElementById("ml-crop-img");
    if (!img || !img.src) return;
    const tmp = new Image();
    tmp.onload = () => {
        const canvas = document.createElement("canvas");
        const w = tmp.naturalWidth, h = tmp.naturalHeight;
        // 90° rotations swap width/height
        canvas.width = h;
        canvas.height = w;
        const ctx = canvas.getContext("2d");
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(deg * Math.PI / 180);
        ctx.drawImage(tmp, -w / 2, -h / 2);
        const rotated = canvas.toDataURL("image/jpeg", 0.95);
        img.onload = () => initCrop();
        img.src = rotated;
    };
    tmp.src = img.src;
}

// Banner aspect ratio: wide rectangle (4:1)
const BANNER_W = 4, BANNER_H = 1;

let _cropState = null;
let _cropAction = null;
let _dragStartX = 0, _dragStartY = 0;
let _origLeft = 0, _origTop = 0, _origW = 0, _origH = 0;

function getXY(e) {
    if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches && e.changedTouches.length > 0) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: e.clientX, y: e.clientY };
}

function initCrop() {
    const wrap = document.getElementById("ml-crop-wrap");
    const img  = document.getElementById("ml-crop-img");
    const box  = document.getElementById("ml-crop-box");
    if (!wrap || !img || !box) return;

    // Clean up previous listeners
    document.removeEventListener("mousemove", _onCropMove);
    document.removeEventListener("mouseup",   _onCropEnd);
    document.removeEventListener("touchmove", _onCropMove);
    document.removeEventListener("touchend",  _onCropEnd);
    document.removeEventListener("touchcancel", _onCropEnd);

    const dW = wrap.offsetWidth;
    const dH = wrap.offsetHeight;

    // Initial crop box: full width, height constrained by aspect ratio
    let cropW = dW;
    let cropH = Math.round(cropW * BANNER_H / BANNER_W);
    if (cropH > dH) { cropH = dH; cropW = Math.round(cropH * BANNER_W / BANNER_H); }
    let cropL = Math.round((dW - cropW) / 2);
    let cropT = Math.round((dH - cropH) / 2);

    _cropState = { dW, dH, cropW, cropH, cropL, cropT };
    updateCropUI();

    // Drag to move
    function onWrapStart(e) {
        if (e.target.classList.contains("ml-crop-handle")) return;
        const { x, y } = getXY(e);
        _cropAction = "move";
        _dragStartX = x; _dragStartY = y;
        _origLeft = _cropState.cropL; _origTop = _cropState.cropT;
        e.preventDefault();
    }
    wrap.addEventListener("mousedown",  onWrapStart);
    wrap.addEventListener("touchstart", onWrapStart, { passive: false });

    // Corner handles
    const handles = { "ml-ch-nw": "nw", "ml-ch-ne": "ne", "ml-ch-sw": "sw", "ml-ch-se": "se" };
    Object.entries(handles).forEach(([id, corner]) => {
        const el = document.getElementById(id);
        if (!el) return;
        function onHandleStart(e) {
            const { x, y } = getXY(e);
            _cropAction = corner;
            _dragStartX = x; _dragStartY = y;
            _origLeft = _cropState.cropL; _origTop = _cropState.cropT;
            _origW = _cropState.cropW; _origH = _cropState.cropH;
            e.preventDefault(); e.stopPropagation();
        }
        el.addEventListener("mousedown",  onHandleStart);
        el.addEventListener("touchstart", onHandleStart, { passive: false });
    });

    document.addEventListener("mousemove",   _onCropMove);
    document.addEventListener("mouseup",     _onCropEnd);
    document.addEventListener("touchmove",   _onCropMove, { passive: false });
    document.addEventListener("touchend",    _onCropEnd);
    document.addEventListener("touchcancel", _onCropEnd);
}

function _onCropMove(e) {
    if (!_cropAction || !_cropState) return;
    const { x, y } = getXY(e);
    const dx = x - _dragStartX, dy = y - _dragStartY;
    const s = _cropState;
    const ratio = BANNER_W / BANNER_H;
    const minW = 60;

    if (_cropAction === "move") {
        s.cropL = Math.max(0, Math.min(s.dW - s.cropW, _origLeft + dx));
        s.cropT = Math.max(0, Math.min(s.dH - s.cropH, _origTop + dy));
    } else if (_cropAction === "se") {
        let w = Math.max(minW, Math.min(s.dW - _origLeft, _origW + dx));
        let h = Math.round(w / ratio);
        if (_origTop + h > s.dH) { h = s.dH - _origTop; w = Math.round(h * ratio); }
        s.cropW = w; s.cropH = h; s.cropL = _origLeft; s.cropT = _origTop;
    } else if (_cropAction === "sw") {
        let w = Math.max(minW, Math.min(_origLeft + _origW, _origW - dx));
        let h = Math.round(w / ratio);
        if (_origTop + h > s.dH) { h = s.dH - _origTop; w = Math.round(h * ratio); }
        s.cropW = w; s.cropH = h; s.cropL = _origLeft + _origW - w; s.cropT = _origTop;
    } else if (_cropAction === "ne") {
        let w = Math.max(minW, Math.min(s.dW - _origLeft, _origW + dx));
        let h = Math.round(w / ratio);
        let t = _origTop + _origH - h;
        if (t < 0) { t = 0; h = _origTop + _origH; w = Math.round(h * ratio); }
        s.cropW = w; s.cropH = h; s.cropL = _origLeft; s.cropT = t;
    } else if (_cropAction === "nw") {
        let w = Math.max(minW, Math.min(_origLeft + _origW, _origW - dx));
        let h = Math.round(w / ratio);
        let l = _origLeft + _origW - w;
        let t = _origTop + _origH - h;
        if (t < 0) { t = 0; h = _origTop + _origH; w = Math.round(h * ratio); l = _origLeft + _origW - w; }
        s.cropW = w; s.cropH = h; s.cropL = Math.max(0, l); s.cropT = Math.max(0, t);
    }
    updateCropUI();
    if (e.cancelable) e.preventDefault();
}

function _onCropEnd() { _cropAction = null; }

function updateCropUI() {
    const s = _cropState;
    const box = document.getElementById("ml-crop-box");
    if (!box || !s) return;
    box.style.left   = s.cropL + "px";
    box.style.top    = s.cropT + "px";
    box.style.width  = s.cropW + "px";
    box.style.height = s.cropH + "px";
    // Position handles at corners
    const handles = { "ml-ch-nw": [s.cropL, s.cropT], "ml-ch-ne": [s.cropL + s.cropW, s.cropT], "ml-ch-sw": [s.cropL, s.cropT + s.cropH], "ml-ch-se": [s.cropL + s.cropW, s.cropT + s.cropH] };
    Object.entries(handles).forEach(([id, [hx, hy]]) => {
        const el = document.getElementById(id);
        if (el) { el.style.left = (hx - 6) + "px"; el.style.top = (hy - 6) + "px"; }
    });
}

async function applyCroppedImage() {
    const img = document.getElementById("ml-crop-img");
    const s = _cropState;
    if (!img || !img.src || !s) return applyBannerImage();

    const canvas = document.createElement("canvas");
    // Scale crop coordinates to actual image dimensions
    const scaleX = img.naturalWidth / img.offsetWidth;
    const scaleY = img.naturalHeight / img.offsetHeight;
    canvas.width  = Math.round(s.cropW * scaleX);
    canvas.height = Math.round(s.cropH * scaleY);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, s.cropL * scaleX, s.cropT * scaleY, s.cropW * scaleX, s.cropH * scaleY, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);

    const targetFolderId = $("#ml-img-upload").data("target-folder-id");
    if (!targetFolderId) return;
    const { setFolderImage } = await import("../data/folders.js");
    setFolderImage(targetFolderId, dataUrl);
}


// ─── Modal Helpers ────────────────────────────────────────

/**
 * Open a modal overlay.
 * @param {string} id - Modal element ID
 */
export function openModal(id) {
    document.getElementById(id)?.classList.add("open");
}

/**
 * Close a modal overlay.
 * @param {string} id - Modal element ID
 */
export function closeModal(id) {
    document.getElementById(id)?.classList.remove("open");
}

// ─── Crop Helpers ─────────────────────────────────────────

/**
 * Open the crop dialog by triggering the hidden file input.
 */
export function openCrop() {
    $("#ml-img-upload").click();
}

/**
 * Apply the cropped/uploaded image to the target character subfolder.
 */
async function applyBannerImage() {
    const img = document.getElementById("ml-crop-img");
    if (!img || !img.src) return;

    const targetFolderId = $("#ml-img-upload").data("target-folder-id");
    if (!targetFolderId) return;

    const { setFolderImage } = await import("../data/folders.js");
    setFolderImage(targetFolderId, img.src);
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Get the status badge HTML for an entry status.
 * Active entries show no badge (empty string).
 *
 * @param {string} status
 * @returns {string} HTML
 */
function getStatusBadge(status) {
    switch (status) {
        case "pinned":
            return '<span class="ml-status-badge ml-status-pinned">pinned</span>';
        case "consolidation":
            return '<span class="ml-status-badge ml-status-synthesis">synthesis</span>';
        case "consolidated":
            return '<span class="ml-status-badge ml-status-consolidated">consolidated</span>';
        case "archived":
            return '<span class="ml-status-badge ml-status-archived">archived</span>';
        case "superseded":
            return '<span class="ml-status-badge ml-status-superseded">superseded</span>';
        default:
            return ""; // active — no badge
    }
}

/**
 * Truncate text to a maximum length, adding ellipsis if truncated.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncateText(text, maxLen) {
    if (!text) return "";
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + "…";
}

/**
 * Escape HTML entities to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}
async function popup(msg) {
    try {
        const ctx = window.SillyTavern?.getContext();
        if (ctx?.callGenericPopup) {
            return await ctx.callGenericPopup(msg, ctx.POPUP_TYPE?.CONFIRM || "confirm", "");
        }
    } catch (e) {}
    return confirm(msg);
}

/**
 * Filter memory entries in the container by search query.
 * @param {jQuery} $container
 * @param {string} query - Lowercase search query
 */
function filterMemoryBySource($container, srcFilter) {
    const showAll = !srcFilter || srcFilter === "all";
    $container.find(".ml-mem-entry-wrap").each(function () {
        const $wrap = $(this);
        let match = showAll;
        if (!showAll) {
            if (srcFilter === "core") match = $wrap.attr("data-core") === "1";
            else if (srcFilter === "excluded") match = $wrap.attr("data-excluded") === "1";
            else match = ($wrap.attr("data-srcclass") || "normal") === srcFilter;
        }
        $wrap.attr("data-fmatch", match ? "1" : "0");
        $wrap.toggle(match);
    });
    syncContainersToVisibleEntries($container, !showAll);
}

function filterMemoryEntries($container, query) {
    $container.find(".ml-mem-entry").each(function () {
        const $entry = $(this);
        const title = ($entry.find(".ml-mem-entry-title").text() || "").toLowerCase();
        const preview = ($entry.find(".ml-mem-entry-preview").text() || "").toLowerCase();
        const tags = ($entry.find(".ml-tag").map(function () { return $(this).text().toLowerCase(); }).get().join(" "));

        const matches = !query || title.includes(query) || preview.includes(query) || tags.includes(query);
        const $wrap = $entry.closest(".ml-mem-entry-wrap");
        // Flag match state explicitly. We must NOT rely on :visible to count
        // matches per folder, because an entry inside a collapsed folder is not
        // :visible even when it matches — that was hiding every folder.
        $wrap.attr("data-fmatch", matches ? "1" : "0");
        $wrap.toggle(matches);
        $entry.toggle(matches);
        const fullId = $entry.next(".ml-mem-full");
        if (fullId.length) fullId.toggle(matches);
    });

    syncContainersToVisibleEntries($container, !!query);
}

/**
 * Reveal/auto-open containers that hold matches so results show even when every
 * folder was collapsed. Counts matches via the data-fmatch flag (not :visible,
 * which is false inside collapsed folders). When forceOpen is false (filter
 * cleared) folders are shown and collapsed back to their remembered state.
 */
function syncContainersToVisibleEntries($container, forceOpen) {
    const matchCount = ($scope) => {
        if (!forceOpen) return 1; // not filtering — treat as "has content"
        // explicit matches, OR (for the source filter which sets display only)
        // wraps still shown and not flagged as a non-match
        let n = $scope.find('.ml-mem-entry-wrap[data-fmatch="1"]').length;
        if (n === 0) {
            n = $scope.find(".ml-mem-entry-wrap").filter(function () {
                return this.style.display !== "none" && this.getAttribute("data-fmatch") !== "0";
            }).length;
        }
        return n;
    };

    $container.find(".ml-char-subfolder").each(function () {
        const $sub = $(this);
        const n = matchCount($sub);
        if (forceOpen) {
            $sub.toggle(n > 0);
            if (n > 0) $sub.addClass("open");
        } else {
            $sub.show();
            const fid = ($sub.attr("id") || "").replace("ml-char-", "");
            if (fid && !openFolders.has(fid)) $sub.removeClass("open");
        }
    });
    $container.find(".ml-folder").each(function () {
        const $f = $(this);
        const n = matchCount($f);   // includes nested subfolder wraps
        if (forceOpen) {
            $f.toggle(n > 0);
            if (n > 0) $f.addClass("open");
        } else {
            $f.show();
            const fid = ($f.attr("id") || "").replace("ml-folder-", "");
            if (fid && !openFolders.has(fid)) $f.removeClass("open");
        }
    });
}

