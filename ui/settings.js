/**
 * ui/settings.js — Settings tab renderer
 *
 * Renders the complete Settings tab with six accordion sections:
 *   1. Connections — LLM profile dropdowns (from ST's connection manager)
 *   2. Scanning — Sidecar scan frequency + optional LLM reranker
 *   3. Memory Writing — Prompts + folder suggestions/auto-tag toggles
 *   4. Injection — Inject toggle, placement, max entries per message
 *   5. Vectorization — Similarity threshold, query source, advanced raw settings,
 *      embedding source/model, stickiness, cooldown
 *   6. Data — Undo last scan, memory decay, batch scan, import/export
 *
 * All textareas get expand popout buttons. Accordion sections are collapsible.
 * Connection profile dropdowns are populated from ST's connection manager.
 */

import { getSetting, setSetting } from "../settings.js";
import { persistSettings } from "../data/storage.js";
import { resolveMemoryEntryPrompt, resolveSceneSummaryPrompt } from "../llm/writer.js";
import { getAllEntries } from "../data/entries.js";
import { reEmbedEntry } from "../embed/embedder.js";
import { getContext } from "../../../../extensions.js";

// ─── Main Render ──────────────────────────────────────────

/**
 * Render the complete Settings tab.
 * @param {jQuery} $pane - The Settings tab pane element
 */
export function renderSettingsTab($pane) {
    // Remove ALL .ml-settings handlers before re-rendering.
    // renderSettingsTab is called on init, tab switch, and CHAT_CHANGED.
    // Without this, document-level handlers accumulate and fire multiple times per click.
    $(document).off(".ml-settings");
    $pane.empty();

    renderConnections($pane);
    renderScanning($pane);
    renderMemoryWriting($pane);
    renderInjection($pane);
    renderConsolidation($pane);
    renderVectorization($pane);
    renderData($pane);
    renderDebug($pane);
}

function renderDebug($pane) {
    const { $section, $body } = createAccordion("Debug");

    // ── Debug F12 toggle ─────────────────────────────────
    const dbgOn = getSetting("debug.enabled", false);
    $body.append(`
        <div class="ml-setting-row">
            <div style="flex:1;min-width:0">
                <div class="ml-setting-label">Debug F12 logging</div>
                <div class="ml-setting-sub">Show Memory Loom activity logs in the browser console · warnings and errors always show</div>
            </div>
            <label class="ml-toggle"><input type="checkbox" id="ml-debug-toggle" ${dbgOn ? "checked" : ""}><span class="ml-slider"></span></label>
        </div>
    `);
    $body.find("#ml-debug-toggle").on("change", function () {
        const on = $(this).prop("checked");
        setSetting("debug.enabled", on);
        window.__ML_DEBUG = on;
        toastr?.info?.(`Debug logging ${on ? "enabled" : "disabled"}.`, "Memory Loom");
    });

    // ── Re-embed all memories ────────────────────────────
    $body.append(`
        <div class="ml-setting-row">
            <div style="flex:1;min-width:0">
                <div class="ml-setting-label">Re-embed all memories</div>
                <div class="ml-setting-sub">Regenerates vector embeddings for every committed entry in this chat</div>
            </div>
            <button class="ml-btn" id="ml-reembed-all-btn">Re-embed</button>
        </div>
    `);
    $body.find("#ml-reembed-all-btn").on("click", async function () {
        const $btn = $(this);
        const entries = getAllEntries();
        const total = entries.length;
        if (!total) { toastr?.info?.("No committed entries to embed.", "Memory Loom"); return; }
        $btn.prop("disabled", true).text("Embedding…");
        let ok = 0, fail = 0;
        for (let i = 0; i < entries.length; i++) {
            try { await reEmbedEntry(entries[i]); ok++; }
            catch (err) { fail++; console.warn("[ML] Re-embed failed for", entries[i].id, err); }
            $btn.text(`Embedding… ${i + 1}/${total}`);
        }
        $btn.prop("disabled", false).text("Re-embed");
        toastr?.success?.(`Re-embedded ${ok}/${total} entries${fail ? ` · ${fail} failed` : ""}.`, "Memory Loom");
    });

    // ── Backfill missing deltas ──────────────────────────
    $body.append(`
        <div class="ml-setting-row">
            <div style="flex:1;min-width:0">
                <div class="ml-setting-label">Backfill missing deltas</div>
                <div class="ml-setting-sub">Memory Writer LLM writes deltas for every memory with a blank/missing delta · uses each memory's content + scene context</div>
            </div>
            <button class="ml-btn" id="ml-backfill-deltas-btn">Backfill</button>
        </div>
    `);
    $body.find("#ml-backfill-deltas-btn").on("click", async function () {
        const $btn = $(this);
        $btn.prop("disabled", true).text("Scanning…");
        const { showPanelLoading, hidePanelLoading, setProcessingStatus } = await import("./panel.js");
        try {
            const { backfillMissingDeltas } = await import("../llm/deltaBackfill.js");
            const result = await backfillMissingDeltas((done, total) => {
                const msg = `Backfilling deltas… ${done}/${total}`;
                $btn.text(`${done}/${total}`);
                showPanelLoading(msg);
                setProcessingStatus(msg);
            });
            if (result.total > 0) {
                toastr?.success?.(
                    `Deltas backfilled: ${result.filled}/${result.total}${result.failed ? ` · ${result.failed} failed` : ""}.`,
                    "Memory Loom", { timeOut: 6000 }
                );
                // refresh library so the new deltas show on the entries
                const { renderLibraryTab } = await import("./library.js");
                const $lib = $("#ml-p-library"); if ($lib.length) renderLibraryTab($lib);
            }
        } catch (err) {
            console.error("[ML] Delta backfill failed:", err);
            toastr?.error?.("Delta backfill failed. Check console.", "Memory Loom");
        } finally {
            hidePanelLoading(); setProcessingStatus(null);
            $btn.prop("disabled", false).text("Backfill");
        }
    });

    // ── Auto-tag memories needing tags ───────────────────────
    $body.append(`
        <div class="ml-setting-row">
            <div style="flex:1;min-width:0">
                <div class="ml-setting-label">Auto-tag memories needing tags</div>
                <div class="ml-setting-sub">Memory Writer LLM suggests browsing tags for memories that only have source/status tags; skips synthesis memories · re-embeds newly tagged entries · uses the same profile and pacing as delta backfill</div>
            </div>
            <button class="ml-btn" id="ml-autotag-btn">Auto-tag</button>
        </div>
    `);
    $body.find("#ml-autotag-btn").on("click", async function () {
        const $btn = $(this);
        $btn.prop("disabled", true).text("Scanning…");
        const { showPanelLoading, hidePanelLoading, setProcessingStatus } = await import("./panel.js");
        try {
            const { autoTagUntaggedEntries } = await import("../llm/autoTag.js");
            const result = await autoTagUntaggedEntries((done, total) => {
                const msg = `Auto-tagging memories… ${done}/${total}`;
                $btn.text(`${done}/${total}`);
                showPanelLoading(msg);
                setProcessingStatus(msg);
            });
            if (result.total > 0) {
                toastr?.success?.(
                    `Auto-tagged memories: ${result.tagged}/${result.total}${result.failed ? ` · ${result.failed} failed` : ""}.`,
                    "Memory Loom", { timeOut: 6000 }
                );
                const { renderLibraryTab } = await import("./library.js");
                const $lib = $("#ml-p-library"); if ($lib.length) renderLibraryTab($lib);
            }
        } catch (err) {
            console.error("[ML] Auto-tag failed:", err);
            toastr?.error?.("Auto-tagging failed. Check console.", "Memory Loom");
        } finally {
            hidePanelLoading(); setProcessingStatus(null);
            $btn.prop("disabled", false).text("Auto-tag");
        }
    });


    // ── Scan for world memories (debug) ──────────────────
    $body.append(`
        <div class="ml-setting-row">
            <div style="flex:1;min-width:0">
                <div class="ml-setting-label">Scan chat for world memories</div>
                <div class="ml-setting-sub">Full world-only batch scan over the raw chat · choose full chat or a message range · ignores hidden-message markers · always runs even when auto world-generation is off (toggle in Scanning)</div>
            </div>
            <button class="ml-btn" id="ml-world-scan-btn">Scan world</button>
        </div>
    `);
    $body.find("#ml-world-scan-btn").on("click", async function () {
        const $btn = $(this);
        const { chat } = await import("../../../../../script.js");
        const total = chat?.length || 0;
        if (!total) { toastr?.warning?.("No messages to scan.", "Memory Loom"); return; }

        // Range popout — full chat or a message range, just like batch / selective scan.
        const html = `
            <div style="text-align:left">
                <h3 style="margin-top:0">Scan for world memories</h3>
                <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#888;margin:6px 0 12px;line-height:1.6">Reads the raw chat (${total} messages, numbered #0–#${total - 1} to match ST), creates scene chunks, and runs the strict world-memory pass. Hidden-message markers are ignored — everything in range is read.</div>
                <label class="checkbox_label" style="display:flex;gap:8px;align-items:center;margin:6px 0">
                    <input type="radio" name="ml-world-range" value="all" checked> Scan everything
                </label>
                <label class="checkbox_label" style="display:flex;gap:8px;align-items:center;margin:6px 0">
                    <input type="radio" name="ml-world-range" value="range"> Message range:
                    <input type="number" id="ml-world-from" placeholder="from" min="0" max="${total - 1}" class="text_pole" style="width:70px" disabled>
                    <span style="color:#888">–</span>
                    <input type="number" id="ml-world-to" placeholder="to" min="0" max="${total - 1}" class="text_pole" style="width:70px" disabled>
                </label>
            </div>`;

        let mode = "all", from = null, to = null;
        $(document).off("change.mlworld").on("change.mlworld", "input[name='ml-world-range']", function () {
            mode = $(this).val();
            const dis = mode !== "range";
            $("#ml-world-from,#ml-world-to").prop("disabled", dis);
        }).on("change.mlworld", "#ml-world-from", function () { from = parseInt($(this).val(), 10); })
          .on("change.mlworld", "#ml-world-to", function () { to = parseInt($(this).val(), 10); });

        let proceed = false;
        try {
            const ctx = window.SillyTavern?.getContext();
            if (ctx?.callGenericPopup) {
                const r = await ctx.callGenericPopup(html, ctx.POPUP_TYPE?.CONFIRM || "confirm", "");
                proceed = r === true || r === 1;
            } else proceed = confirm("Scan for world memories?");
        } finally {
            $(document).off("change.mlworld");
        }
        if (!proceed) return;

        let rangeStart = null, rangeEnd = null;
        if (mode === "range") {
            if (isNaN(from) || isNaN(to)) { toastr?.warning?.("Enter both a start and end message number.", "Memory Loom"); return; }
            if (from < 0) from = 0;              // ST's first message is #0
            if (to > total - 1) to = total - 1;  // last valid 0-based index
            if (from > to) { toastr?.warning?.("Start must be before end.", "Memory Loom"); return; }
            // ST message numbers are already 0-based — use directly, no offset.
            rangeStart = from;
            rangeEnd = to;
        }
        // world-only batch scan (5th arg true)
        runBatchScan($btn, rangeStart, rangeEnd, "Scan world", true);
    });

    // ── Set to default ───────────────────────────────────
    $body.append(`
        <div class="ml-setting-row" style="border-bottom:none">
            <div style="flex:1;min-width:0">
                <div class="ml-setting-label">Set to default</div>
                <div class="ml-setting-sub">Resets ALL Memory Loom settings to their defaults · does not touch entries, scenes, or folders</div>
            </div>
            <button class="ml-btn-danger" id="ml-reset-defaults-btn">Reset</button>
        </div>
    `);
    $body.find("#ml-reset-defaults-btn").on("click", async function () {
        const { resetSettingsToDefaults } = await import("../settings.js");
        if (typeof resetSettingsToDefaults !== "function") { toastr?.error?.("Reset unavailable."); return; }
        resetSettingsToDefaults();
        toastr?.success?.("Settings reset to defaults.", "Memory Loom");
        renderSettingsTab($pane);
    });

    $pane.append($section);
}

// ─── Accordion Helper ─────────────────────────────────────

/**
 * Create a collapsible accordion section.
 *
 * @param {string} title - Section title (uppercase, monospace)
 * @param {boolean} [open=false] - Whether the accordion starts open
 * @returns {{$section: jQuery, $body: jQuery}}
 */
function createAccordion(title, open = false) {
    const $section = $(`
        <div class="ml-accordion${open ? " open" : ""}">
            <div class="ml-acc-hdr">
                <span class="ml-acc-title">${title}</span>
                ${iconSvgChevron()}
            </div>
            <div class="ml-acc-body"></div>
        </div>
    `);

    $section.find(".ml-acc-hdr").on("click", function () {
        $section.toggleClass("open");
    });

    const $body = $section.find(".ml-acc-body");
    return { $section, $body };
}

function iconSvgChevron() {
    return `<svg class="ml-acc-chevron" width="14" height="14" style="color:#777"><use href="#ico-chevron-down"/></svg>`;
}

/**
 * Create a settings row with label and control.
 * @param {string} label - Setting label
 * @param {string} sub - Setting description
 * @param {string|jQuery} control - The control HTML/element
 * @returns {jQuery}
 */
function settingRow(label, sub, control) {
    return $(`
        <div class="ml-setting-row">
            <div>
                <div class="ml-setting-label">${label}</div>
                <div class="ml-setting-sub">${sub}</div>
            </div>
            ${typeof control === "string" ? control : ""}
        </div>
    `).append(typeof control !== "string" ? control : "");
}

// ─── 1. Connections ───────────────────────────────────────

function renderConnections($pane) {
    const { $section, $body } = createAccordion("Connections", false);

    const profiles = getConnectionProfiles();
    const profileOptions = profiles.map(p =>
        `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`
    ).join("");

    function selectFor(key) {
        const current = getSetting(`connections.${key}`, "");
        return `<select class="ml-setting-select" id="ml-setting-${key}">
            <option value="">— select —</option>
            ${profileOptions}
        </select>`;
    }

    $body.append(settingRow("Memory writer LLM", "Generates entries on scene close", selectFor("memoryWriterLLM")));
    $body.append(settingRow("Scene summary LLM", "Writes scene reference notes · falls back to memory writer if unset", selectFor("sceneSummaryLLM")));
    $body.append(settingRow("Consolidation LLM", "Generates arc and sub-arc consolidation summaries", selectFor("consolidationLLM")));
    $body.append(settingRow("Keyword sidecar LLM", "Extracts themes from context every N messages", selectFor("sidecarLLM")));

    // No-think helpers/labels (defined before the dropdown loop so its change
    // handler can reference them).
    const roleLabels = {
        memoryWriterLLM: "Memory writer",
        sceneSummaryLLM: "Scene summary",
        consolidationLLM: "Consolidation",
        sidecarLLM: "Keyword sidecar",
    };
    function readMap(mapKey) { const m = getSetting(`connections.${mapKey}`, null); return (m && typeof m === "object") ? m : {}; }
    function writeMap(mapKey, profileId, val) {
        const m = readMap(mapKey);
        if (val) m[profileId] = true; else delete m[profileId];
        setSetting(`connections.${mapKey}`, m);
    }

    // Set current values and wire change handlers.
    // Use $body.find() — $section is not in the document yet so document-level
    // selectors ($(...)) would find nothing. $body.find() works on detached elements.
    ["memoryWriterLLM", "sceneSummaryLLM", "consolidationLLM", "sidecarLLM"].forEach(key => {
        const current = getSetting(`connections.${key}`, "");
        const $select = $body.find(`#ml-setting-${key}`);
        $select.val(current);
        $select.on("change", function () {
            const newId = $(this).val();
            setSetting(`connections.${key}`, newId);
            // Rebind this role's no-think row to the newly selected profile, and
            // reflect that profile's existing no-think state — no full re-render.
            const $r = $body.find(`.ml-nothink-row[data-role="${key}"]`);
            if ($r.length) {
                const softMap = readMap("noThinkProfiles");
                const hardMap = readMap("noThinkHardProfiles");
                $r.find(".ml-nt-soft").attr("data-pid", newId).prop("checked", !!softMap[newId]).prop("disabled", !newId);
                $r.find(".ml-nt-hard").attr("data-pid", newId).prop("checked", !!hardMap[newId]).prop("disabled", !newId);
                $r.find(".ml-nothink-rolelabel").html(roleLabels[key] + (newId ? "" : ` <span style="color:#a66">(no profile selected)</span>`));
            }
        });
    });

    // ── No-think (per connection profile) ────────────────
    // Each role's selected profile gets its own soft/hard no-think setting,
    // keyed by profile ID. So a local Qwen sidecar can run thinking-off while a
    // cloud writer keeps reasoning. The map is keyed by profile ID, so a profile
    // used in two roles behaves consistently.
    $body.append(`<div class="ml-subhdr" style="margin-top:14px;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#888">No-think (per profile)</div>`);
    $body.append(`<div style="font-size:11px;color:#888;margin:4px 0 8px;line-height:1.4">Soft appends <code>/no_think</code> (safe, ignored if unsupported). Hard also sends API params (<code>think</code>/<code>enable_thinking=false</code>) — turn off if your backend errors.</div>`);

    Object.keys(roleLabels).forEach(roleKey => {
        const profileId = getSetting(`connections.${roleKey}`, "");
        const softMap = readMap("noThinkProfiles");
        const hardMap = readMap("noThinkHardProfiles");
        const disabled = profileId ? "" : "disabled";
        const hint = profileId ? "" : ` <span style="color:#a66">(no profile selected)</span>`;
        const $row = $(`
            <div class="ml-nothink-row" data-role="${roleKey}" style="display:flex;align-items:center;gap:14px;padding:5px 0;border-bottom:0.5px solid #2a2a2a">
                <span class="ml-nothink-rolelabel" style="flex:1;font-size:12px;color:#ccc">${roleLabels[roleKey]}${hint}</span>
                <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#aaa;cursor:pointer"><input type="checkbox" class="ml-nt-soft" data-pid="${profileId}" ${softMap[profileId] ? "checked" : ""} ${disabled}> soft</label>
                <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#aaa;cursor:pointer"><input type="checkbox" class="ml-nt-hard" data-pid="${profileId}" ${hardMap[profileId] ? "checked" : ""} ${disabled}> hard</label>
            </div>
        `);
        $row.find(".ml-nt-soft").on("change", function () {
            const pid = $(this).data("pid"); if (pid) writeMap("noThinkProfiles", pid, this.checked);
        });
        $row.find(".ml-nt-hard").on("change", function () {
            const pid = $(this).data("pid"); if (pid) writeMap("noThinkHardProfiles", pid, this.checked);
        });
        $body.append($row);
    });

    $pane.append($section);
}

// ─── 2. Scanning ──────────────────────────────────────────

function renderScanning($pane) {
    const { $section, $body } = createAccordion("Scanning");

    const current = getSetting("scanFrequency", 1);
    const options = [
        { val: 1, label: "Every message" },
        { val: 3, label: "Every 3 messages" },
        { val: 5, label: "Every 5 messages" },
    ];
    const optsHtml = options.map(o =>
        `<option value="${o.val}" ${current === o.val ? "selected" : ""}>${o.label}</option>`
    ).join("");

    $body.append(settingRow("Scan frequency", "How often the keyword sidecar runs",
        `<select class="ml-setting-select" id="ml-setting-scanFrequency">${optsHtml}</select>`
    ));

    $body.find("#ml-setting-scanFrequency").on("change", function () {
        setSetting("scanFrequency", parseInt($(this).val()));
    });

    // Max response tokens — must hold a thinking model's reasoning + answer
    const maxTok = getSetting("connections.maxResponseTokens", 8000);
    $body.append(settingRow("Max response tokens", "Budget per writer/summary call. Thinking models spend this on reasoning FIRST — raise it if answers come back empty or cut off",
        `<input type="number" class="ml-setting-select" id="ml-setting-maxResponseTokens" value="${Number(maxTok) || 8000}" min="500" max="32000" step="500" style="width:90px;text-align:center">`
    ));
    $body.find("#ml-setting-maxResponseTokens").on("change", function () {
        let v = Number($(this).val());
        if (!Number.isFinite(v) || v < 500) { v = 8000; $(this).val(v); }
        setSetting("connections.maxResponseTokens", v);
    });

    // ── LLM rerank ──────────────────────────────────────
    const rerankSettings = getSetting('vectorization.rerank', {}) || {};
    const legacyRerank = getSetting('vectorization.raw.rerank', false);
    const rerankEnabled = rerankSettings.enabled !== undefined ? !!rerankSettings.enabled : !!legacyRerank;
    const rerankMaxCandidates = Math.min(6, Math.max(2, Number(rerankSettings.maxCandidates) || 5));
    const rerankContextDepth = Math.min(8, Math.max(1, Number(rerankSettings.contextDepth) || 3));
    const rerankTimeoutMs = Math.min(30000, Math.max(5000, Number(rerankSettings.timeoutMs) || 12000));

    $body.append(settingRow('LLM reranker', 'Optional second pass after vector search · uses the Keyword sidecar profile · skips quickly if it stalls',
        `<label class="ml-toggle"><input type="checkbox" id="ml-setting-rerank-enabled" ${rerankEnabled ? 'checked' : ''}><span class="ml-slider"></span></label>`
    ));
    $body.find('#ml-setting-rerank-enabled').on('change', function(){
        const cfg = getSetting('vectorization.rerank', {}) || {};
        cfg.enabled = $(this).prop('checked');
        setSetting('vectorization.rerank', cfg);
        // Preserve backward compatibility for users who already had the old raw.rerank flag saved.
        const raw = getSetting('vectorization.raw', {}) || {};
        raw.rerank = cfg.enabled;
        setSetting('vectorization.raw', raw);
    });

    $body.append(settingRow('Rerank candidate pool', 'Max filtered memories sent to the reranker prompt; keep this small for local sidecar models',
        `<input type="number" id="ml-setting-rerank-maxCandidates" value="${rerankMaxCandidates}" min="2" max="6" step="1">`
    ));
    $body.find('#ml-setting-rerank-maxCandidates').on('change', function(){
        const cfg = getSetting('vectorization.rerank', {}) || {};
        cfg.maxCandidates = Math.min(6, Math.max(2, parseInt($(this).val()) || 5));
        setSetting('vectorization.rerank', cfg);
    });

    $body.append(settingRow('Rerank context depth', 'Recent chat messages included in the reranker prompt',
        `<input type="number" id="ml-setting-rerank-contextDepth" value="${rerankContextDepth}" min="1" max="8" step="1">`
    ));
    $body.find('#ml-setting-rerank-contextDepth').on('change', function(){
        const cfg = getSetting('vectorization.rerank', {}) || {};
        cfg.contextDepth = Math.min(8, Math.max(1, parseInt($(this).val()) || 3));
        setSetting('vectorization.rerank', cfg);
    });

    $body.append(settingRow('Rerank timeout', 'Milliseconds before ML gives up and keeps vector order',
        `<input type="number" id="ml-setting-rerank-timeoutMs" value="${rerankTimeoutMs}" min="5000" max="30000" step="1000">`
    ));
    $body.find('#ml-setting-rerank-timeoutMs').on('change', function(){
        const cfg = getSetting('vectorization.rerank', {}) || {};
        cfg.timeoutMs = Math.min(30000, Math.max(5000, parseInt($(this).val()) || 12000));
        setSetting('vectorization.rerank', cfg);
    });

    $pane.append($section);
}

// ─── 3. Memory Writing ────────────────────────────────────

function renderMemoryWriting($pane) {
    const { $section, $body } = createAccordion("Memory Writing");

    // Folder suggestions toggle
    const folderSuggestions = getSetting("memoryWriting.folderSuggestions", false);
    $body.append(settingRow("Folder suggestions", "Memory writer suggests a folder for new entries",
        `<label class="ml-toggle"><input type="checkbox" id="ml-setting-folderSuggestions" ${folderSuggestions ? "checked" : ""}><span class="ml-slider"></span></label>`
    ));
    $body.find("#ml-setting-folderSuggestions").on("change", function () {
        setSetting("memoryWriting.folderSuggestions", $(this).prop("checked"));
    });

    // Auto-tag on commit toggle
    const autoTagOnCommit = getSetting("memoryWriting.autoTagOnCommit", false);
    $body.append(settingRow("Auto-tag accepted memories", "When a pending memory is accepted, the Memory Writer LLM adds descriptive tags before the entry is embedded · off by default", 
        `<label class="ml-toggle"><input type="checkbox" id="ml-setting-autoTagOnCommit" ${autoTagOnCommit ? "checked" : ""}><span class="ml-slider"></span></label>`
    ));
    $body.find("#ml-setting-autoTagOnCommit").on("change", function () {
        setSetting("memoryWriting.autoTagOnCommit", $(this).prop("checked"));
    });

    // Banned memory owners
    const banned = getSetting("memoryWriting.bannedCharacters", "");
    $body.append(`
        <div style="margin-top:12px">
            <div class="ml-field-hdr">
                <span class="ml-lbl" style="margin-bottom:0">Banned memory owners</span>
            </div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#888;margin-bottom:7px;line-height:1.6">Comma-separated. These characters never own a memory — but can still appear as Key Characters in other characters' memories. Your persona is always banned automatically.</div>
            <textarea id="ml-setting-bannedCharacters" rows="2" placeholder="e.g. Jane Doe, John Doe">${escapeHtml(banned)}</textarea>
        </div>
    `);
    $body.find("#ml-setting-bannedCharacters").on("change", function () {
        setSetting("memoryWriting.bannedCharacters", $(this).val());
    });

    // Scene summary prompt
    const scenePrompt = getSetting("memoryWriting.sceneSummaryPrompt", "") || resolveSceneSummaryPrompt();
    $body.append(`
        <div style="margin-top:12px">
            <div class="ml-field-hdr">
                <span class="ml-lbl" style="margin-bottom:0">Scene summary prompt</span>
                <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-setting-sceneSummaryPrompt" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i>
            </div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#888;margin-bottom:7px;line-height:1.6">Internal use only — never injected into your main prompt.</div>
            <textarea id="ml-setting-sceneSummaryPrompt" rows="4" style="margin-bottom:12px">${escapeHtml(scenePrompt)}</textarea>
        </div>
    `);
    $body.find("#ml-setting-sceneSummaryPrompt").on("change", function () {
        setSetting("memoryWriting.sceneSummaryPrompt", $(this).val());
    });

    // Memory entry prompt
    const memPrompt = getSetting("memoryWriting.memoryEntryPrompt", "") || resolveMemoryEntryPrompt();
    $body.append(`
        <div style="margin-top:12px">
            <div class="ml-field-hdr">
                <span class="ml-lbl" style="margin-bottom:0">Memory entry prompt</span>
                <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-setting-memoryEntryPrompt" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i>
            </div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#888;margin-bottom:7px;line-height:1.6">Do not make memories for {{user}}.</div>
            <textarea id="ml-setting-memoryEntryPrompt" rows="4">${escapeHtml(memPrompt)}</textarea>
        </div>
    `);
    $body.find("#ml-setting-memoryEntryPrompt").on("change", function () {
        setSetting("memoryWriting.memoryEntryPrompt", $(this).val());
    });

    $pane.append($section);
}

// ─── 4b. Consolidation ────────────────────────────────────

function renderConsolidation($pane) {
    const { $section, $body } = createAccordion("Consolidation");

    $body.append(`<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#888;margin-bottom:10px;line-height:1.6">Fuse related memories into updated character memories plus an arc summary in the Plot folder. Manual: select memories (or use a character folder's book icon) in the Library. Below: automatic triggers.</div>`);

    // Auto-consolidate toggle
    const autoOn = getSetting("consolidation.autoEnabled", false);
    $body.append(settingRow("Automatic consolidation", "Auto-consolidate a character folder once it crosses the memory threshold (after a scene closes)",
        `<label class="ml-toggle"><input type="checkbox" id="ml-setting-autoConsolidate" ${autoOn ? "checked" : ""}><span class="ml-slider"></span></label>`
    ));
    $body.find("#ml-setting-autoConsolidate").on("change", function () {
        setSetting("consolidation.autoEnabled", this.checked);
    });

    // Threshold
    const thresh = getSetting("consolidation.autoThreshold", 12);
    $body.append(settingRow("Auto threshold", "Active memories in one character folder before auto-consolidation fires",
        `<input type="number" id="ml-setting-autoThreshold" value="${Number(thresh) || 12}" min="3" max="100">`
    ));
    $body.find("#ml-setting-autoThreshold").on("change", function () {
        setSetting("consolidation.autoThreshold", parseInt($(this).val()) || 12);
    });

    // Keep recent
    const keep = getSetting("consolidation.autoKeepRecent", 4);
    $body.append(settingRow("Keep most recent", "How many recent memories to leave uncompressed when auto-consolidating",
        `<input type="number" id="ml-setting-autoKeep" value="${Number(keep) || 4}" min="0" max="50">`
    ));
    $body.find("#ml-setting-autoKeep").on("change", function () {
        setSetting("consolidation.autoKeepRecent", parseInt($(this).val()) || 4);
    });

    // Max response tokens for consolidation
    const ctok = getSetting("consolidation.maxResponseTokens", 30000);
    $body.append(settingRow("Max response tokens", "Budget per consolidation call — a consolidation emits a large structured object; too low truncates it (default 30000)",
        `<input type="number" id="ml-setting-consolidationTokens" value="${Number(ctok) || 30000}" min="1000" max="100000" step="1000" style="width:90px;text-align:center">`
    ));
    $body.find("#ml-setting-consolidationTokens").on("change", function () {
        let v = parseInt($(this).val());
        if (!Number.isFinite(v) || v < 1000) { v = 30000; $(this).val(v); }
        setSetting("consolidation.maxResponseTokens", v);
    });

    // Consolidated priority multiplier
    const mult = getSetting("vectorization.consolidatedPriorityMultiplier", 0.5);
    $body.append(settingRow("Consolidated memory priority", "Retrieval priority multiplier for source memories after they're consolidated (lower = less likely to inject, but still recallable)",
        `<input type="number" id="ml-setting-consolidatedMult" value="${Number(mult) || 0.5}" min="0.1" max="1" step="0.1">`
    ));
    $body.find("#ml-setting-consolidatedMult").on("change", function () {
        let v = parseFloat($(this).val());
        if (!Number.isFinite(v) || v <= 0) v = 0.5;
        setSetting("vectorization.consolidatedPriorityMultiplier", v);
    });

    $pane.append($section);
}

// ─── 4. Injection ─────────────────────────────────────────

function renderInjection($pane) {
    const { $section, $body } = createAccordion("Injection");

    // Inject toggle
    const injectEnabled = getSetting("injection.enabled", true);
    $body.append(settingRow("Inject matched memories", "Inject entries into system prompt when matched",
        `<label class="ml-toggle"><input type="checkbox" id="ml-setting-injectEnabled" ${injectEnabled ? "checked" : ""}><span class="ml-slider"></span></label>`
    ));
    $body.find("#ml-setting-injectEnabled").on("change", function () {
        setSetting("injection.enabled", $(this).prop("checked"));
    });

    // Placement
    const placement = getSetting("injection.placement", "before_main");
    const placements = ["before_main", "after_main", "top_an", "bottom_an", "at_depth"];
    const placementLabels = [
        "Before main prompt", "After main prompt",
        "Top of author's note", "Bottom of author's note",
        "At chat depth",
    ];
    const placementOpts = placements.map((p, i) =>
        `<option value="${p}" ${placement === p ? "selected" : ""}>${placementLabels[i]}</option>`
    ).join("");
    $body.append(settingRow("Injection placement", "Where in the prompt the memory block is inserted",
        `<select class="ml-setting-select" id="ml-setting-placement">${placementOpts}</select>`
    ));

    // At-depth controls (only meaningful when placement = at_depth)
    const depth = getSetting("injection.depth", 4);
    const depthRole = getSetting("injection.depthRole", "system");
    const $depthRow = $(settingRow("Injection depth", "Messages from the end (only used with 'At chat depth')",
        `<input type="number" id="ml-setting-injdepth" value="${Number(depth) || 4}" min="0" max="100" style="width:70px">`
    ));
    const $roleRow = $(settingRow("Injection role", "Whose turn the block is attributed to at depth",
        `<select class="ml-setting-select" id="ml-setting-injrole">
            <option value="system" ${depthRole === "system" ? "selected" : ""}>System</option>
            <option value="user" ${depthRole === "user" ? "selected" : ""}>User</option>
            <option value="assistant" ${depthRole === "assistant" ? "selected" : ""}>Assistant</option>
        </select>`
    ));
    $body.append($depthRow, $roleRow);
    function toggleDepthRows() {
        const show = $("#ml-setting-placement").val() === "at_depth";
        $depthRow.toggle(show); $roleRow.toggle(show);
    }
    $body.find("#ml-setting-placement").on("change", function () {
        setSetting("injection.placement", $(this).val());
        toggleDepthRows();
    });
    $body.find("#ml-setting-injdepth").on("change", function () {
        setSetting("injection.depth", Math.max(0, parseInt($(this).val(), 10) || 4));
    });
    $body.find("#ml-setting-injrole").on("change", function () {
        setSetting("injection.depthRole", $(this).val());
    });
    toggleDepthRows();

    // Max entries
    const maxEntries = getSetting("injection.maxEntriesPerMessage", 3);
    $body.append(settingRow("Max entries per message", "Cap on simultaneous injections",
        `<input type="number" id="ml-setting-maxEntries" value="${maxEntries}" min="1" max="10">`
    ));
    $body.find("#ml-setting-maxEntries").on("change", function () {
        setSetting("injection.maxEntriesPerMessage", parseInt($(this).val()) || 3);
    });

    // ── Per-category caps ────────────────────────────────
    // Each limits how many of that category inject per message; the global cap
    // above is the overall ceiling across all categories combined.
    $body.append(`<div style="font-size:11px;color:#888;margin:10px 0 2px;line-height:1.4">Per-category caps — how many of each kind can inject at once (the global cap above is the overall ceiling).</div>`);
    const perCat = getSetting("injection.maxPerCategory", {}) || {};
    const catRows = [
        ["character", "Character", 3],
        ["world", "World", 2],
        ["plot", "Plot", 1],
        ["custom", "Custom folders", 2],
    ];
    catRows.forEach(([key, label, def]) => {
        const val = Number.isFinite(perCat[key]) ? perCat[key] : def;
        $body.append(settingRow(`Max ${label.toLowerCase()} entries`, `Cap on ${label} memories per message`,
            `<input type="number" class="ml-setting-maxcat" data-cat="${key}" value="${val}" min="0" max="10">`
        ));
    });
    $body.find(".ml-setting-maxcat").on("change", function () {
        const cat = $(this).data("cat");
        const v = Math.max(0, parseInt($(this).val(), 10));
        const map = getSetting("injection.maxPerCategory", {}) || {};
        map[cat] = Number.isFinite(v) ? v : 0;
        setSetting("injection.maxPerCategory", map);
    });

    // ── Memory recall tool ───────────────────────────────
    const recallOn = getSetting("injection.recallToolEnabled", true);
    $body.append(settingRow("Memory recall tool", "Lets the main LLM actively search the archive mid-reply (function calling) · requires a tool-capable Chat Completion backend",
        `<label class="ml-toggle"><input type="checkbox" id="ml-setting-recallTool" ${recallOn ? "checked" : ""}><span class="ml-slider"></span></label>`
    ));
    $body.find("#ml-setting-recallTool").on("change", function () {
        setSetting("injection.recallToolEnabled", this.checked);
    });

    const maxTool = getSetting("injection.maxToolCallMemories", 5);
    $body.append(settingRow("Max tool-call memories", "Cap on memories one recall search can return · separate from Max entries per message",
        `<input type="number" id="ml-setting-maxToolCall" value="${Number(maxTool) || 5}" min="1" max="20">`
    ));
    $body.find("#ml-setting-maxToolCall").on("change", function () {
        setSetting("injection.maxToolCallMemories", parseInt($(this).val()) || 5);
    });

    // ── Default stickiness ───────────────────────────────
    // (storage key kept as vectorization.* so previously-saved values survive)
    const stickiness = getSetting("vectorization.defaultStickiness", 0);
    $body.append(settingRow("Default stickiness", "Messages an injected memory stays active after firing (0 = off)",
        `<input type="number" id="ml-setting-stickiness" value="${Number(stickiness) || 0}" min="0" max="50">`
    ));
    $body.find("#ml-setting-stickiness").on("change", function () {
        setSetting("vectorization.defaultStickiness", parseInt($(this).val()) || 0);
        persistSettings();  // flush immediately — debounced save could be lost on quick navigation
    });

    // ── Default cooldown ─────────────────────────────────
    const cooldown = getSetting("vectorization.defaultCooldown", 0);
    $body.append(settingRow("Default cooldown", "Messages before an injected memory can re-fire (0 = off)",
        `<input type="number" id="ml-setting-cooldown" value="${Number(cooldown) || 0}" min="0" max="50">`
    ));
    $body.find("#ml-setting-cooldown").on("change", function () {
        setSetting("vectorization.defaultCooldown", parseInt($(this).val()) || 0);
        persistSettings();
    });

    $pane.append($section);
}

// ─── 5. Vectorization ─────────────────────────────────────

function buildEmbedProviderHtml(source) {
    const sv = (key, def) => getSetting(key, def);
    switch (source) {
        case 'transformers':
            return '<div class="ml-setting-row"><div class="ml-setting-sub" style="padding:4px 0">No configuration needed — ST handles Transformers embeddings locally.</div></div>';

        case 'ollama': {
            const useAlt = sv('embedding.ollama_use_alt_endpoint', false);
            return `
                <div class="ml-setting-row">
                    <div><div class="ml-setting-label">Model</div><div class="ml-setting-sub">e.g. mxbai-embed-large, nomic-embed-text, qwen3-embedding</div></div>
                    <input type="text" id="ml-ollama-model" class="ml-setting-select" value="${escapeHtml(sv('embedding.ollama_model',''))}" placeholder="mxbai-embed-large">
                </div>
                <div class="ml-setting-row">
                    <div><div class="ml-setting-label">Use alt endpoint</div><div class="ml-setting-sub">Custom URL instead of Ollama URL in textgen settings</div></div>
                    <label class="ml-toggle"><input type="checkbox" id="ml-ollama-use-alt"${useAlt?' checked':''}><span class="ml-slider"></span></label>
                </div>
                <div id="ml-ollama-alt-url-row" class="ml-setting-row" style="display:${useAlt?'flex':'none'}">
                    <div><div class="ml-setting-label">Ollama URL</div></div>
                    <input type="text" id="ml-ollama-alt-url" class="ml-setting-select" value="${escapeHtml(sv('embedding.ollama_alt_endpoint_url',''))}" placeholder="http://localhost:11434">
                </div>`;
        }

        case 'vllm': {
            const useAlt = sv('embedding.vllm_use_alt_endpoint', false);
            return `
                <div class="ml-setting-row">
                    <div><div class="ml-setting-label">Model</div><div class="ml-setting-sub">e.g. intfloat/e5-mistral-7b-instruct</div></div>
                    <input type="text" id="ml-vllm-model" class="ml-setting-select" value="${escapeHtml(sv('embedding.vllm_model',''))}" placeholder="intfloat/e5-mistral-7b-instruct">
                </div>
                <div class="ml-setting-row">
                    <div><div class="ml-setting-label">Use alt endpoint</div><div class="ml-setting-sub">Custom URL instead of vLLM URL in textgen settings</div></div>
                    <label class="ml-toggle"><input type="checkbox" id="ml-vllm-use-alt"${useAlt?' checked':''}><span class="ml-slider"></span></label>
                </div>
                <div id="ml-vllm-alt-url-row" class="ml-setting-row" style="display:${useAlt?'flex':'none'}">
                    <div><div class="ml-setting-label">vLLM URL</div></div>
                    <input type="text" id="ml-vllm-alt-url" class="ml-setting-select" value="${escapeHtml(sv('embedding.vllm_alt_endpoint_url',''))}" placeholder="http://localhost:8000">
                </div>`;
        }

        case 'openai': {
            const cur = sv('embedding.openai_model','text-embedding-3-small');
            const opts = ['text-embedding-3-small','text-embedding-3-large','text-embedding-ada-002'];
            return `<div class="ml-setting-row"><div><div class="ml-setting-label">Model</div></div>
                <select id="ml-openai-model" class="ml-setting-select">${opts.map(m=>`<option value="${m}"${cur===m?' selected':''}>${m}</option>`).join('')}</select></div>`;
        }

        case 'cohere': {
            const cur = sv('embedding.cohere_model','embed-english-v3.0');
            const opts = ['embed-english-v3.0','embed-multilingual-v3.0','embed-english-light-v3.0','embed-multilingual-light-v3.0','embed-v4.0'];
            return `<div class="ml-setting-row"><div><div class="ml-setting-label">Model</div></div>
                <select id="ml-cohere-model" class="ml-setting-select">${opts.map(m=>`<option value="${m}"${cur===m?' selected':''}>${m}</option>`).join('')}</select></div>`;
        }

        case 'palm': {
            const cur = sv('embedding.google_model','text-embedding-005');
            const opts = ['text-embedding-005','text-embedding-004','gemini-embedding-001'];
            return `<div class="ml-setting-row"><div><div class="ml-setting-label">Model</div></div>
                <select id="ml-palm-model" class="ml-setting-select">${opts.map(m=>`<option value="${m}"${cur===m?' selected':''}>${m}</option>`).join('')}</select></div>`;
        }

        case 'openrouter':
            return `<div class="ml-setting-row">
                <div><div class="ml-setting-label">Model</div><div class="ml-setting-sub">e.g. openai/text-embedding-3-large</div></div>
                <input type="text" id="ml-openrouter-model" class="ml-setting-select" value="${escapeHtml(sv('embedding.openrouter_model',''))}" placeholder="openai/text-embedding-3-large">
            </div>`;

        case 'mistral': {
            const cur = sv('embedding.mistral_model','mistral-embed');
            return `<div class="ml-setting-row"><div><div class="ml-setting-label">Model</div></div>
                <select id="ml-mistral-model" class="ml-setting-select"><option value="mistral-embed"${cur==='mistral-embed'?' selected':''}>mistral-embed</option></select></div>`;
        }

        default: return '';
    }
}

function wireEmbedEvents($c) {
    $c.find('#ml-ollama-model').on('change input', function(){ setSetting('embedding.ollama_model', $(this).val().trim()); });
    $c.find('#ml-ollama-use-alt').on('change', function(){
        const v=$(this).prop('checked'); setSetting('embedding.ollama_use_alt_endpoint',v);
        $c.find('#ml-ollama-alt-url-row').css('display',v?'flex':'none');
    });
    $c.find('#ml-ollama-alt-url').on('change input', function(){ setSetting('embedding.ollama_alt_endpoint_url',$(this).val().trim()); });
    $c.find('#ml-vllm-model').on('change input', function(){ setSetting('embedding.vllm_model',$(this).val().trim()); });
    $c.find('#ml-vllm-use-alt').on('change', function(){
        const v=$(this).prop('checked'); setSetting('embedding.vllm_use_alt_endpoint',v);
        $c.find('#ml-vllm-alt-url-row').css('display',v?'flex':'none');
    });
    $c.find('#ml-vllm-alt-url').on('change input', function(){ setSetting('embedding.vllm_alt_endpoint_url',$(this).val().trim()); });
    $c.find('#ml-openai-model').on('change', function(){ setSetting('embedding.openai_model',$(this).val()); });
    $c.find('#ml-cohere-model').on('change', function(){ setSetting('embedding.cohere_model',$(this).val()); });
    $c.find('#ml-palm-model').on('change', function(){ setSetting('embedding.google_model',$(this).val()); });
    $c.find('#ml-openrouter-model').on('change input', function(){ setSetting('embedding.openrouter_model',$(this).val().trim()); });
    $c.find('#ml-mistral-model').on('change', function(){ setSetting('embedding.mistral_model',$(this).val()); });
}

function renderVectorization($pane) {
    const { $section, $body } = createAccordion('Vectorization');

    const SOURCES = [
        { v:'transformers', l:'Local (Transformers)' },
        { v:'ollama',       l:'Ollama' },
        { v:'vllm',         l:'vLLM' },
        { v:'openai',       l:'OpenAI' },
        { v:'cohere',       l:'Cohere' },
        { v:'palm',         l:'Google AI Studio' },
        { v:'openrouter',   l:'OpenRouter' },
        { v:'mistral',      l:'MistralAI' },
    ];

    const embedSource = getSetting('embedding.source', 'transformers');

    $body.append(settingRow('Embedding source', 'Vector provider for embedding memory entries',
        `<select class="ml-setting-select" id="ml-embed-source">
            ${SOURCES.map(s=>`<option value="${s.v}"${embedSource===s.v?' selected':''}>${s.l}</option>`).join('')}
        </select>`
    ));

    // Container rebuilt dynamically when source changes — no show/hide needed
    const $mc = $('<div id="ml-embed-model-container"></div>');
    $body.append($mc);

    function refresh(src) {
        $mc.html(buildEmbedProviderHtml(src));
        wireEmbedEvents($mc);
    }

    refresh(embedSource);

    $body.find('#ml-embed-source').on('change', function(){
        const src = $(this).val();
        setSetting('embedding.source', src);
        refresh(src);
    });

    // ── Similarity threshold ────────────────────────────
    const threshold = getSetting('vectorization.similarityThreshold', 0.75);
    $body.append(settingRow('Similarity threshold', 'Minimum score to trigger injection (0.0–1.0)',
        `<input type="number" id="ml-setting-threshold" value="${threshold}" min="0" max="1" step="0.05">`
    ));
    $body.find('#ml-setting-threshold').on('change', function(){
        setSetting('vectorization.similarityThreshold', parseFloat($(this).val()) || 0.75);
    });

    // ── Top-k ───────────────────────────────────────────
    const topKSetting = getSetting('vectorization.raw.topK', 10);
    $body.append(settingRow('Top-k results', 'Max candidates returned before Memory Loom filters them',
        `<input type="number" id="ml-setting-topK-global" value="${topKSetting}" min="1" max="50" step="1">`
    ));
    $body.find('#ml-setting-topK-global').on('change', function(){
        const raw = getSetting('vectorization.raw', {});
        raw.topK = Math.max(1, parseInt($(this).val()) || 10);
        setSetting('vectorization.raw', raw);
    });

    // ── Query source ────────────────────────────────────
    const querySource = getSetting('vectorization.querySource', 'keywords');
    $body.append(settingRow('Query source', 'What the embedding model queries against',
        `<select class="ml-setting-select" id="ml-setting-querySource">
            <option value="keywords"${querySource==='keywords'?' selected':''}>Sidecar keywords</option>
            <option value="raw"${querySource==='raw'?' selected':''}>Raw recent messages</option>
        </select>`
    ));
    $body.find('#ml-setting-querySource').on('change', function(){
        setSetting('vectorization.querySource', $(this).val());
        toggleRawAdvanced($(this).val() === 'raw');
    });

    // ── Raw advanced settings ───────────────────────────
    const rawSettings = getSetting('vectorization.raw', {});
    const $rawAdvanced = $(`
        <div id="ml-raw-advanced" style="display:${querySource==='raw'?'block':'none'};width:100%;margin-top:10px;background:#222;border:1px solid #3e3e3e;border-radius:4px;overflow:hidden">
            <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#777;letter-spacing:0.07em;text-transform:uppercase;padding:8px 12px;border-bottom:1px solid #333">Advanced — Raw query settings</div>
        </div>
    `);

    function addRawRow(label, sub, id, value, type='number', extra='') {
        $rawAdvanced.append(`<div class="ml-decay-row"><div><div class="ml-decay-label">${label}</div><div class="ml-decay-sub">${sub}</div></div><input type="${type}" id="${id}" value="${value}" ${extra}></div>`);
    }

    addRawRow('Scan depth',     'Recent messages to include',       'ml-setting-scanDepth',     rawSettings.scanDepth     || 10);
    addRawRow('Chunk size',     'Token size per text chunk',        'ml-setting-chunkSize',     rawSettings.chunkSize     || 256);
    addRawRow('Overlap tokens', 'Token overlap between chunks',     'ml-setting-overlapTokens', rawSettings.overlapTokens || 32);

    const metric = rawSettings.distanceMetric || "cosine";
    $rawAdvanced.append(`
        <div class="ml-decay-row">
            <div><div class="ml-decay-label">Distance metric</div><div class="ml-decay-sub">Similarity function for vector comparison</div></div>
            <select class="ml-setting-select" id="ml-setting-distanceMetric">
                <option value="cosine" ${metric === "cosine" ? "selected" : ""}>Cosine</option>
                <option value="dot_product" ${metric === "dot_product" ? "selected" : ""}>Dot product</option>
                <option value="euclidean" ${metric === "euclidean" ? "selected" : ""}>Euclidean</option>
            </select>
        </div>
    `);


    // Wire raw settings
    $rawAdvanced.find("#ml-setting-scanDepth").on("change", function () { saveRaw("scanDepth", parseInt($(this).val())); });
    $rawAdvanced.find("#ml-setting-chunkSize").on("change", function () { saveRaw("chunkSize", parseInt($(this).val())); });
    $rawAdvanced.find("#ml-setting-overlapTokens").on("change", function () { saveRaw("overlapTokens", parseInt($(this).val())); });
    $rawAdvanced.find("#ml-setting-distanceMetric").on("change", function () { saveRaw("distanceMetric", $(this).val()); });

    function saveRaw(key, value) {
        const raw = getSetting("vectorization.raw", {});
        raw[key] = value;
        setSetting("vectorization.raw", raw);
    }

    $body.append($rawAdvanced);

    $pane.append($section);

    // Export toggle function
    window._mlToggleRawAdvanced = toggleRawAdvanced;
}

function toggleRawAdvanced(show) {
    const el = document.getElementById("ml-raw-advanced");
    if (el) el.style.display = show ? "block" : "none";
}

// ─── 6. Data ──────────────────────────────────────────────

function renderData($pane) {
    const { $section, $body } = createAccordion("Data");

    // ── Undo last scan ──────────────────────────────────
    $body.append(`
        <div class="ml-setting-row" style="flex-wrap:wrap;row-gap:8px">
            <div style="flex:1;min-width:0">
                <div class="ml-setting-label">Undo last scan</div>
                <div class="ml-setting-sub">Reverts the most recent scene scan · cannot undo a batch scan</div>
            </div>
            <button class="ml-btn" id="ml-undo-scan-btn">Undo</button>
            <div style="width:100%;background:#222;border:1px solid #3e3e3e;border-radius:4px;padding:9px 12px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#888;line-height:1.6">
                <span style="color:#aaa">Last scan:</span> no scans performed
            </div>
        </div>
    `);
    $body.find("#ml-undo-scan-btn").on("click", async () => {
        const { undoLastScan } = await import("../data/scenes.js");
        if (undoLastScan()) { toastr?.success?.("Last scan undone."); }
        else { toastr?.warning?.("No scan to undo."); }
    });

    // ── Memory decay ────────────────────────────────────
    const decayEnabled = getSetting("decay.enabled", false);
    $body.append(`
        <div class="ml-setting-row" style="flex-wrap:wrap;row-gap:0">
            <div style="flex:1;min-width:0">
                <div class="ml-setting-label">Memory decay</div>
                <div class="ml-setting-sub">Gradually reduce injection priority of older entries</div>
            </div>
            <label class="ml-toggle">
                <input type="checkbox" id="ml-setting-decayEnabled" ${decayEnabled ? "checked" : ""}>
                <span class="ml-slider"></span>
            </label>
            <div class="ml-decay-settings" id="ml-decay-settings" style="width:100%;display:${decayEnabled ? 'block' : 'none'}">
            </div>
        </div>
    `);
    $body.find("#ml-setting-decayEnabled").on("change", function () {
        const on = $(this).prop("checked");
        setSetting("decay.enabled", on);
        $("#ml-decay-settings").toggle(on);
    });

    // Decay sub-settings
    const $decay = $body.find("#ml-decay-settings");
    const decay = getSetting("decay", {});

    function addDecayRow(label, sub, control) {
        $decay.append(`<div class="ml-decay-row"><div><div class="ml-decay-label">${label}</div><div class="ml-decay-sub">${sub}</div></div>${control}</div>`);
    }

    const modes = ["linear", "exponential", "step"];
    const modeOpts = modes.map(m => `<option value="${m}" ${(decay.mode || "linear") === m ? "selected" : ""}>${m.charAt(0).toUpperCase() + m.slice(1)}</option>`).join("");
    addDecayRow("Decay mode", "How injection priority decreases over time",
        `<select class="ml-setting-select" id="ml-setting-decayMode">${modeOpts}</select>`
    );
    addDecayRow("Decay start", "Number of scenes before decay begins",
        `<input type="number" id="ml-setting-decayStart" value="${decay.decayStart || 5}" min="1" max="50">`
    );
    addDecayRow("Minimum priority", "Entries never drop below this floor (0.0–1.0)",
        `<input type="number" id="ml-setting-decayMinPriority" value="${decay.minimumPriority || 0.3}" min="0" max="1" step="0.1">`
    );
    addDecayRow("Exempt pinned entries", "Pinned memories always inject at full priority",
        `<label class="ml-toggle"><input type="checkbox" id="ml-setting-decayExemptPinned" ${decay.exemptPinned !== false ? "checked" : ""}><span class="ml-slider"></span></label>`
    );

    // Wire decay settings (delegated)
    $decay.find("#ml-setting-decayMode").on("change", function () { setSetting("decay.mode", $(this).val()); });
    $decay.find("#ml-setting-decayStart").on("change", function () { setSetting("decay.decayStart", parseInt($(this).val())); });
    $decay.find("#ml-setting-decayMinPriority").on("change", function () { setSetting("decay.minimumPriority", parseFloat($(this).val())); });
    $decay.find("#ml-setting-decayExemptPinned").on("change", function () { setSetting("decay.exemptPinned", $(this).prop("checked")); });

    // ── Batch scan ──────────────────────────────────────
    $body.append(settingRow("Batch scan", "Scan full chat history · scene-aware chunks · non-compounding",
        `<button class="ml-btn" id="ml-batch-scan-btn">Run batch scan</button>`
    ));
    $body.find("#ml-batch-scan-btn").on("click", () => runBatchScan($body.find("#ml-batch-scan-btn"), null, null, "Run batch scan"));

    // ── Selective batch scan ─────────────────────────────
    // Same machinery as the full scan, restricted to a user-chosen message
    // window. Exists because active roleplays have incomplete scenes at the
    // end of the chat — a full scan would mow through them, lock them as
    // "already scanned", and capture half a scene. Scan up to where the story
    // is settled and leave the live scene alone.
    $body.append(settingRow("Selective batch scan", "Scan only a message range · leaves the rest available for manual scenes",
        `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <input type="number" class="ml-setting-select" id="ml-sel-scan-from" placeholder="from" min="0" style="width:64px;text-align:center" title="First message # (matches ST's #, starts at 0)">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#666">–</span>
            <input type="number" class="ml-setting-select" id="ml-sel-scan-to" placeholder="to" min="0" style="width:64px;text-align:center" title="Last message # (matches ST's #)">
            <button class="ml-btn" id="ml-sel-scan-btn">Run selective scan</button>
        </div>`
    ));
    $body.find("#ml-sel-scan-btn").on("click", async () => {
        const { chat } = await import("../../../../../script.js");
        const total = chat?.length || 0;
        let from = parseInt($body.find("#ml-sel-scan-from").val(), 10);
        let to   = parseInt($body.find("#ml-sel-scan-to").val(), 10);
        if (isNaN(from) || isNaN(to)) { toastr?.warning?.("Enter both a start and end message number.", "Memory Loom"); return; }
        if (from < 0) from = 0;                  // ST's first message is #0
        if (to > total - 1) to = total - 1;      // last valid 0-based index
        if (from > to) { toastr?.warning?.("Start message must be before end message.", "Memory Loom"); return; }
        // Inputs are ST message numbers (ST labels the first message #0), used
        // DIRECTLY as 0-based indices — no offset, so what you type matches what
        // you see in ST exactly.
        runBatchScan($body.find("#ml-sel-scan-btn"), from, to, "Run selective scan");
    });

    // ── World memory generation toggle ───────────────────
    // Governs the AUTOMATIC world pass on scene close AND during batch/selective
    // scans. When off, those scans skip world entirely. The explicit "Scan world"
    // button in Debug always runs regardless of this toggle.
    const worldOn = getSetting("worldMemory.enabled", true);
    $body.append(settingRow("World memory generation", "Include the strict world-memory pass automatically on scene close and during batch/selective scans · the Debug 'Scan world' button always runs regardless",
        `<label class="ml-toggle"><input type="checkbox" id="ml-setting-worldEnabled" ${worldOn ? "checked" : ""}><span class="ml-slider"></span></label>`
    ));
    $body.find("#ml-setting-worldEnabled").on("change", function () {
        setSetting("worldMemory.enabled", this.checked);
    });

    // ── World scale (per-chat) ───────────────────────────
    // Anchors how the world writer judges what counts as a world EVENT. Stored
    // per-chat, like NWST's setting context, so each roleplay scales correctly —
    // a town-scale slice-of-life vs a multi-realm epic. Read by worldWriter.js.
    const $scaleWrap = $(`
        <div class="ml-setting-row" style="flex-direction:column;align-items:stretch;gap:6px">
            <div>
                <div class="ml-setting-label">World scale <span style="color:#888;font-weight:400">· per chat</span></div>
                <div class="ml-setting-sub">Describe how big this world is so world-EVENT detection scales correctly. A town/school setting lets town-level events count; a multi-realm epic restricts events to realm-level. Mention any latent genre shifts (e.g. dormant supernatural elements) so an activation is caught as a top-tier event.</div>
            </div>
            <textarea id="ml-setting-worldscale" rows="3" placeholder="e.g. Small-scale: a single town (Miyashita) and its high school, slice-of-life. A dormant cursed-energy contamination leaks in certain spots and could activate, flipping the genre to urban fantasy. OR: Large: multiple dimensions (Soul Society, Hueco Mundo, the living world) with great-power factions."></textarea>
            <div><button class="ml-btn" id="ml-setting-worldscale-save">Save world scale</button></div>
        </div>
    `);
    $body.append($scaleWrap);
    (async () => {
        try {
            const { getWorldScale } = await import("../data/storage.js");
            $scaleWrap.find("#ml-setting-worldscale").val(getWorldScale());
        } catch (e) { console.warn("[ML] load world scale failed:", e); }
    })();
    $scaleWrap.find("#ml-setting-worldscale-save").on("click", async function () {
        try {
            const { saveWorldScale } = await import("../data/storage.js");
            saveWorldScale($scaleWrap.find("#ml-setting-worldscale").val());
            toastr?.success?.("World scale saved for this chat.");
        } catch (e) { console.error("[ML] save world scale failed:", e); toastr?.error?.("Failed to save world scale."); }
    });

    // ── Lorebook memory import (EXPERIMENTAL) ───────────
    $body.append(settingRow("Lorebook import · <span style='color:#c9a227'>experimental</span>", "Parse Core Memories out of a curated lorebook JSON and import them as entries",
        `<button class="ml-btn" id="ml-lorebook-import-btn">Import from lorebook</button>
         <input type="file" id="ml-lorebook-file" accept=".json,application/json" style="display:none">`
    ));
    $body.find("#ml-lorebook-import-btn").on("click", () => $body.find("#ml-lorebook-file").trigger("click"));
    $body.find("#ml-lorebook-file").on("change", async function () {
        const file = this.files?.[0];
        this.value = ""; // allow re-selecting the same file later
        if (!file) return;
        const { showPanelLoading, hidePanelLoading, setProcessingStatus } = await import("./panel.js");
        try {
            const textRaw = await file.text();
            const json = JSON.parse(textRaw);
            const { parseLorebook } = await import("../lib/lorebookImport.js");
            const { parsed, skipped, total } = parseLorebook(json);
            if (!parsed.length) {
                toastr?.warning?.(`No importable memories found (${total} entries checked). This experimental importer expects **Title** / **Date** / **Primary Character** structured Core Memories.`, "Memory Loom");
                return;
            }
            const ok = await mlPopupConfirm(`Found <b>${parsed.length}</b> importable memories in "${escapeHtml(file.name)}"${skipped ? ` (${skipped} skipped — no parsable structure)` : ""}.<br><br>Import them now? Entries will be filed into character folders automatically and embedded.`);
            if (!ok) return;
            const { createEntry } = await import("../data/entries.js");
            const { embedEntry } = await import("../embed/embedder.js");
            let created = 0;
            for (const data of parsed) {
                const msg = `Importing memories… ${created + 1}/${parsed.length}`;
                showPanelLoading(msg); setProcessingStatus(msg);
                try {
                    const entry = createEntry(data);
                    created++;
                    await embedEntry(entry).catch(err => console.warn("[ML] Import embed failed:", err));
                } catch (err) {
                    console.error("[ML] Lorebook import: entry create failed:", err);
                }
            }
            toastr?.success?.(`Imported ${created}/${parsed.length} memories from lorebook.`, "Memory Loom", { timeOut: 6000 });
            const { renderLibraryTab } = await import("./library.js");
            const $lib = $("#ml-p-library"); if ($lib.length) renderLibraryTab($lib);
        } catch (err) {
            console.error("[ML] Lorebook import failed:", err);
            toastr?.error?.("Lorebook import failed — is the file valid lorebook JSON? Check console.", "Memory Loom");
        } finally {
            hidePanelLoading(); setProcessingStatus(null);
        }
    });

    // ── Import / Export / Clear ─────────────────────────
    $body.append('<hr class="ml-rule">');
    $body.append(`
        <div class="ml-btn-row">
            <button class="ml-btn" id="ml-import-btn">Import all</button>
            <button class="ml-btn" id="ml-export-btn">Export all</button>
            <button class="ml-btn-danger" id="ml-clear-all-btn">Clear all data</button>
        </div>
    `);
    $body.find("#ml-clear-all-btn").on("click", async () => {
        const ctx = getContext();
        const { callGenericPopup, POPUP_TYPE } = ctx;
        const confirmed = await callGenericPopup(
            "This will permanently delete ALL Memory Loom data for this chat (entries, folders, scenes, consolidations). Global settings will be preserved.",
            POPUP_TYPE.CONFIRM,
            ""
        );
        if (!confirmed) return;
        const { getChatData } = await import("../data/storage.js");
        const chatData = getChatData();
        chatData.entries = {};
        chatData.folders = [];
        chatData.scenes = [];
        chatData.consolidations = {};
        chatData.pendingEntries = null;
        chatData.openSceneId = null;
        chatData.messageCounter = 0;
        chatData.stickiness = {};
        chatData.cooldowns = {};
        const { saveEntries, saveFolders, saveScenes, saveConsolidations, savePendingEntries, saveOpenSceneId } = await import("../data/storage.js");
        saveEntries({});
        saveScenes([]);
        saveConsolidations({});
        savePendingEntries(null);
        saveOpenSceneId(null);
        // Re-init default folders
        const { initDefaultFolders } = await import("../data/folders.js");
        initDefaultFolders();
        // Reset in-memory scene state
        const { initSceneCounter } = await import("../data/scenes.js");
        initSceneCounter();
        toastr?.success?.("All Memory Loom data cleared for this chat.", "Memory Loom");
        $(document).trigger("ml:scene-state-changed");
        const { renderLibraryTab } = await import("./library.js");
        const { renderHomeTab } = await import("./home.js");
        renderHomeTab($("#ml-p-home"));
        renderLibraryTab($("#ml-p-library"));
    });
    $body.find("#ml-export-btn").on("click", async () => {
        const { exportAllData } = await import("../settings.js");
        const { getChatData } = await import("../data/storage.js");
        const json = await exportAllData(getChatData());
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const _charName = String(getContext()?.name2 || "chat").replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "_") || "chat";
        a.download = `memory-loom-export-${_charName}-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr?.success?.("Data exported.");
    });
    $body.find("#ml-import-btn").on("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const text = await file.text();

            // Peek at the file to tell the user what they're importing
            let counts = "";
            try {
                const peek = JSON.parse(text);
                const cd = peek.chatData || {};
                const nEntries = cd.entries ? (Array.isArray(cd.entries) ? cd.entries.length : Object.keys(cd.entries).length) : 0;
                const nScenes = Array.isArray(cd.scenes) ? cd.scenes.length : 0;
                const nPending = cd.pendingEntries ? (Array.isArray(cd.pendingEntries) ? cd.pendingEntries.length : Object.keys(cd.pendingEntries).length) : 0;
                const hasSettings = peek.settings ? "yes" : "no";
                counts = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#888;margin:8px 0;line-height:1.6">Found: ${nEntries} memories, ${nScenes} scenes, ${nPending} pending · settings: ${hasSettings}</div>`;
            } catch (err) {
                toastr?.error?.("That file isn't valid JSON.", "Memory Loom");
                return;
            }

            // Ask how to import — radios for settings + data, defaults are the SAFE
            // non-destructive options (keep settings, merge data)
            const html = `
                <div style="text-align:left">
                    <h3 style="margin-top:0">Import Memory Loom data</h3>
                    ${counts}
                    <div style="margin:10px 0"><b>Settings</b>
                        <label class="checkbox_label" style="display:flex;gap:8px;align-items:center;margin:6px 0">
                            <input type="radio" name="ml-imp-settings" value="keep" checked> Keep my current settings
                        </label>
                        <label class="checkbox_label" style="display:flex;gap:8px;align-items:center;margin:6px 0">
                            <input type="radio" name="ml-imp-settings" value="overwrite"> Overwrite with imported settings
                        </label>
                    </div>
                    <div style="margin:10px 0"><b>Memories, folders, scenes &amp; pending entries</b>
                        <label class="checkbox_label" style="display:flex;gap:8px;align-items:center;margin:6px 0">
                            <input type="radio" name="ml-imp-data" value="merge" checked> Merge (keep existing, add imported)
                        </label>
                        <label class="checkbox_label" style="display:flex;gap:8px;align-items:center;margin:6px 0">
                            <input type="radio" name="ml-imp-data" value="replace"> Replace (wipe existing first)
                        </label>
                    </div>
                </div>`;

            let settingsMode = "keep", dataMode = "merge";
            $(document).off("change.mlimp").on("change.mlimp", "input[name='ml-imp-settings']", function () { settingsMode = $(this).val(); })
                .on("change.mlimp", "input[name='ml-imp-data']", function () { dataMode = $(this).val(); });

            let proceed = false;
            try {
                const ctx = window.SillyTavern?.getContext();
                if (ctx?.callGenericPopup) {
                    const r = await ctx.callGenericPopup(html, ctx.POPUP_TYPE?.CONFIRM || "confirm", "");
                    proceed = r === true || r === 1;
                } else {
                    proceed = confirm("Import this file? (merge mode)");
                }
            } finally {
                $(document).off("change.mlimp");
            }
            if (!proceed) return;

            // Belt-and-suspenders for the destructive combo: extra confirm
            if (dataMode === "replace") {
                const sure = await mlPopupConfirm("<b>Replace</b> will permanently delete your existing memories, folders, scenes, and pending entries before importing. This cannot be undone. Continue?");
                if (!sure) return;
            }

            const { importAllData } = await import("../settings.js");
            const ok = await importAllData(text, { settingsMode, dataMode });
            if (ok) {
                toastr?.success?.("Data imported.", "Memory Loom");
                try {
                    const { renderLibraryTab } = await import("./library.js");
                    const { renderHomeTab } = await import("./home.js");
                    renderHomeTab($("#ml-p-home"));
                    renderLibraryTab($("#ml-p-library"));
                    $(document).trigger("ml:scene-state-changed");
                } catch (renderErr) {
                    console.warn("[ML] Import succeeded but UI refresh failed:", renderErr);
                    toastr?.info?.("Import succeeded. Reload if the Home tab does not refresh.", "Memory Loom");
                }
            } else {
                toastr?.error?.("Import failed. Check console.", "Memory Loom");
            }
        };
        input.click();
    });

    $pane.append($section);
}



// ST-native confirm popup with HTML content; falls back to window.confirm
async function mlPopupConfirm(html) {
    try {
        const ctx = window.SillyTavern?.getContext();
        if (ctx?.callGenericPopup) {
            const res = await ctx.callGenericPopup(html, ctx.POPUP_TYPE?.CONFIRM || "confirm", "");
            return res === true || res === 1;
        }
    } catch (e) {}
    return confirm(html.replace(/<[^>]+>/g, ""));
}

// ─── Shared Batch Scan Runner ─────────────────────────────

/**
 * Run a batch scan over the whole chat (rangeStart/rangeEnd null) or a
 * message window (selective scan). Identical behavior either way — chunking,
 * hidden-message handling, scene creation, summary + entry generation —
 * except for the window.
 *
 * Progress is shown three ways: toasts per chunk, the persistent panel
 * overlay, and the Home-tab processing banner. Home and Library (Scenes view)
 * re-render after every chunk so new material appears as it's created.
 */
async function runBatchScan($btn, rangeStart, rangeEnd, idleLabel, worldOnly = false) {
    $btn.prop("disabled", true).text("Scanning...");
    const { showPanelLoading, hidePanelLoading, setProcessingStatus } = await import("./panel.js");
    try {
        const { chat, name1 } = await import("../../../../../script.js");
        if (!chat || !chat.length) {
            toastr?.warning?.("No messages to scan.", "Memory Loom");
            return;
        }
        const profileKey = getSetting("connections.memoryWriterLLM", "");
        if (!profileKey) {
            toastr?.warning?.("No Memory Writer LLM configured. Set one in Settings > Connections.", "Memory Loom");
            return;
        }
        const { resolveProfile } = await import("../llm/connections.js");
        const profile = resolveProfile(profileKey);
        if (!profile) {
            toastr?.warning?.(`Profile "${profileKey}" not found. Check Settings > Connections.`, "Memory Loom");
            return;
        }

        const { createScene, closeScene, recordLastClosedScene, getAllScenes } = await import("../data/scenes.js");
        const { generateSceneSummary, generateMemoryEntries } = await import("../llm/writer.js");
        const { generateWorldMemories } = await import("../llm/worldWriter.js");
        const { renderHomeTab } = await import("./home.js");
        const { renderLibraryTab } = await import("./library.js");

        const isSelective = rangeStart !== null || rangeEnd !== null;
        const scanLabel = worldOnly ? "World scan" : (isSelective ? "Selective scan" : "Batch scan");
        toastr?.info?.(isSelective
            ? `${scanLabel} started — messages #${rangeStart}–#${rangeEnd}...`
            : `${scanLabel} started — analyzing chat history...`, "Memory Loom");

        // Capture the chat we're scanning. ST mutates `chat` and swaps chat_metadata
        // in place on chat switch — if the user changes chats mid-scan, we MUST abort
        // or we'd write scenes from this chat into the other chat's data.
        const scanChatId = getContext().chatId;

        const chunks = chunkMessagesForScan(chat, name1, rangeStart ?? 0, rangeEnd ?? null);
        if (!chunks.length) {
            toastr?.warning?.("Nothing to scan in that range.", "Memory Loom");
            return;
        }
        console.log(`[ML] ${isSelective ? "Selective" : "Batch"} scan: ${chunks.length} scene-aware chunks`);

        // refresh helper — re-renders Home and whichever Library view is open
        // (Scenes included) so new entries/scenes appear without tab-flipping
        const refreshPanes = () => {
            try {
                const $home = $("#ml-p-home"); if ($home.length) renderHomeTab($home);
                const $lib = $("#ml-p-library"); if ($lib.length) renderLibraryTab($lib);
            } catch (e) { console.warn("[ML] Pane refresh failed:", e); }
        };

        let processed = 0, totalEntries = 0;
        for (let i = 0; i < chunks.length; i++) {
            if (getContext().chatId !== scanChatId) {
                console.warn("[ML] Scan aborted — chat changed mid-scan.");
                toastr?.warning?.("Scan stopped: chat was switched.", "Memory Loom");
                break;
            }
            const chunk = chunks[i];
            const progressMsg = `Scanning messages #${chunk.start}–#${chunk.end} (${i + 1}/${chunks.length})...`;
            showPanelLoading(progressMsg);
            setProcessingStatus(progressMsg);
            toastr?.info?.(progressMsg, "Memory Loom", { timeOut: 3000 });
            try {
                let closed = null;
                if (worldOnly) {
                    // Reuse an existing CLOSED scene overlapping this chunk if one
                    // exists (e.g. a prior batch scan already created it) — creating
                    // a new scene over already-scanned messages returns null and
                    // would skip the chunk. Only create one where none exists.
                    const existing = getAllScenes().find(s =>
                        s.status === "closed" &&
                        chunk.start >= s.messageStart &&
                        (s.messageEnd === null || chunk.start <= s.messageEnd)
                    );
                    if (existing) {
                        closed = existing;
                        // ensure it has a summary for reconciliation
                        if (!existing.llmSummary) await generateSceneSummary(existing.id);
                    } else {
                        const scene = createScene(chunk.start);
                        if (!scene) continue;
                        closed = closeScene(scene.id, chunk.end);
                        if (!closed) continue;
                        recordLastClosedScene(closed.id);
                        await generateSceneSummary(closed.id);
                    }
                } else {
                    const scene = createScene(chunk.start);
                    if (!scene) continue;
                    closed = closeScene(scene.id, chunk.end);
                    if (!closed) continue;
                    recordLastClosedScene(closed.id);
                    // Always generate a scene summary — world reconciliation needs it,
                    // and it's cheap context for everything downstream.
                    await generateSceneSummary(closed.id);
                }

                let chunkCount = 0;
                if (!worldOnly) {
                    const entries = await generateMemoryEntries(closed.id);
                    if (entries?.length) chunkCount += entries.length;
                    // pause between the two LLM calls within a chunk
                    await new Promise(r => setTimeout(r, 2000));
                }
                // World pass:
                //   - world-only scan (explicit button): ALWAYS runs, force=true
                //   - full batch scan: runs ONLY if World Memory Generation is on
                // Reads raw chunk messages (via the scene) + reconciles against
                // prior scene summaries and known world facts.
                const doWorld = worldOnly || getSetting("worldMemory.enabled", true);
                if (doWorld) {
                    const world = await generateWorldMemories(closed.id, worldOnly /* force */);
                    if (world?.length) chunkCount += world.length;
                }

                processed++;
                totalEntries += chunkCount;
                if (chunkCount > 0) {
                    toastr?.success?.(
                        `Chunk ${i + 1}: ${chunkCount} ${chunkCount === 1 ? "entry" : "entries"} queued`,
                        "Memory Loom", { timeOut: 2500 }
                    );
                }
                // show new scene + pending entries immediately
                refreshPanes();
            } catch (chunkErr) {
                console.error(`[ML] Scan chunk ${chunk.start}–${chunk.end} failed:`, chunkErr);
            }
            // Pause between chunks — each chunk fires multiple LLM calls with large
            // payloads, and providers like GLM Cloud rate-limit aggressively on bursts.
            await new Promise(r => setTimeout(r, 3000));
        }

        toastr?.success?.(
            `${worldOnly ? "World scan" : "Scan"} complete — ${processed}/${chunks.length} chunks, ${totalEntries} ${worldOnly ? "world " : ""}${totalEntries === 1 ? "entry" : "entries"} pending review.`,
            "Memory Loom", { timeOut: 6000 }
        );
        setProcessingStatus(null);
        refreshPanes();
    } catch (err) {
        console.error("[ML] Batch scan failed:", err);
        toastr?.error?.("Scan failed. Check console for details.", "Memory Loom");
    } finally {
        const { hidePanelLoading: hide, setProcessingStatus: clear } = await import("./panel.js");
        hide(); clear(null);
        $btn.prop("disabled", false).text(idleLabel);
        try { const { renderHomeTab } = await import("./home.js"); const $h = $("#ml-p-home"); if ($h.length) renderHomeTab($h); } catch (e) {}
    }
}

// ─── Batch Scan Chunking ──────────────────────────────────

/**
 * Chunk chat messages for batch scanning.
 *
 * Roleplay chats alternate user/char on every message, so speaker changes
 * MUST NOT be treated as scene boundaries — they would split every 1-2 messages.
 *
 * Only explicit narrative break markers (---, ***, ===) and time-skip language
 * are used as preferred split points. Size is the hard fallback.
 */
function chunkMessagesForScan(chat, userName, rangeStart = 0, rangeEnd = null) {
    // Selective scan support: restrict chunking to a message window. Indices
    // produced are ABSOLUTE chat indices, so scenes/entries reference the real
    // message positions regardless of the window.
    const lo = Math.max(0, rangeStart || 0);
    const hi = (rangeEnd === null || rangeEnd === undefined) ? chat.length - 1 : Math.min(chat.length - 1, rangeEnd);
    if (lo > hi) return [];
    if (lo > 0 || hi < chat.length - 1) {
        const windowChunks = chunkMessagesForScan(chat.slice(lo, hi + 1), userName);
        return windowChunks.map(c => ({ start: c.start + lo, end: c.end + lo }));
    }
    // Raised from 16k: the writer now budget-packs its own requests, so chunks no
    // longer need to fit a request budget — splitting mid-scene hurts more than a
    // bigger chunk does. A typical long-prose 9-message scene stays whole.
    const MAX_CHUNK_CHARS = 36000;
    const MIN_CHUNK_CHARS = 4000;  // don't split a chunk smaller than this
    const BREAK_PATTERNS = [
        /^-{3,}$/m, /^\*{3,}$/m, /^={3,}$/m,
        /\b(the next day|meanwhile|later that|some time later|the following)\b/i,
        /\b(a few (hours|days|weeks) later)\b/i,
        /\b(elsewhere|simultaneously|back at)\b/i,
    ];

    function msgText(msg) {
        const name = msg.name || (msg.is_user ? (userName || "User") : "Character");
        return `[${name}]: ${msg.mes || ""}`;
    }

    // If the whole chat fits in one chunk, just return it as-is
    const totalChars = chat.reduce((s, m) => s + msgText(m).length, 0);
    if (totalChars <= MAX_CHUNK_CHARS) {
        return [{ start: 0, end: chat.length - 1 }];
    }

    const chunks = [];
    let chunkStart = 0;

    while (chunkStart < chat.length) {
        let runningChars = 0;
        let lastBreak = -1;
        let endIdx = chunkStart;

        for (let i = chunkStart; i < chat.length; i++) {
            const chars = msgText(chat[i]).length;
            if (runningChars + chars > MAX_CHUNK_CHARS && endIdx > chunkStart) {
                const splitAt = lastBreak > chunkStart ? lastBreak : i;
                chunks.push({ start: chunkStart, end: splitAt - 1 });
                chunkStart = splitAt;
                break;
            }
            runningChars += chars;
            endIdx = i + 1;
            // Only mark explicit narrative breaks as preferred split points
            if (runningChars >= MIN_CHUNK_CHARS && chat[i].mes && BREAK_PATTERNS.some(p => p.test(chat[i].mes))) {
                lastBreak = i + 1;
            }
        }
        if (endIdx > chunkStart) {
            chunks.push({ start: chunkStart, end: endIdx - 1 });
            chunkStart = endIdx;
        }
    }

    return chunks;
}

// ─── Connection Profile Helpers ───────────────────────────

/**
 * Get all available connection profiles from ST's connection manager.
 * @returns {Array<{name: string, id: string}>}
 */
function getConnectionProfiles() {
    try {
        const ctx = getContext();
        const cm = ctx.extensionSettings?.connectionManager;
        if (!cm?.profiles) return [];
        return cm.profiles.map(p => ({
            name: p.name || "Unnamed",
            id: p.id || p.name,
        }));
    } catch {
        return [];
    }
}

// ─── Helpers ──────────────────────────────────────────────

function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}
