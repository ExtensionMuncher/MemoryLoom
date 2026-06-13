/**
 * ui/settings.js — Settings tab renderer
 *
 * Renders the complete Settings tab with six accordion sections:
 *   1. Connections — LLM profile dropdowns (from ST's connection manager)
 *   2. Scanning — Sidecar scan frequency
 *   3. Memory Writing — Prompts + folder suggestions toggle
 *   4. Injection — Inject toggle, placement, max entries per message
 *   5. Vectorization — Similarity threshold, query source, advanced raw settings,
 *      embedding source/model, stickiness, cooldown
 *   6. Data — Undo last scan, memory decay, batch scan, import/export
 *
 * All textareas get expand popout buttons. Accordion sections are collapsible.
 * Connection profile dropdowns are populated from ST's connection manager.
 */

import { getSetting, setSetting } from "../settings.js";
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

    // Set current values and wire change handlers.
    // Use $body.find() — $section is not in the document yet so document-level
    // selectors ($(...)) would find nothing. $body.find() works on detached elements.
    ["memoryWriterLLM", "sceneSummaryLLM", "consolidationLLM", "sidecarLLM"].forEach(key => {
        const current = getSetting(`connections.${key}`, "");
        const $select = $body.find(`#ml-setting-${key}`);
        $select.val(current);
        $select.on("change", function () {
            setSetting(`connections.${key}`, $(this).val());
        });
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
    const placement = getSetting("injection.placement", "below_card");
    const placements = ["above_card", "below_card", "top", "bottom"];
    const placementLabels = ["Above character card", "Below character card", "Top of system prompt", "Bottom of system prompt"];
    const placementOpts = placements.map((p, i) =>
        `<option value="${p}" ${placement === p ? "selected" : ""}>${placementLabels[i]}</option>`
    ).join("");
    $body.append(settingRow("Injection placement", "Where in the system prompt entries are inserted",
        `<select class="ml-setting-select" id="ml-setting-placement">${placementOpts}</select>`
    ));
    $body.find("#ml-setting-placement").on("change", function () {
        setSetting("injection.placement", $(this).val());
    });

    // Max entries
    const maxEntries = getSetting("injection.maxEntriesPerMessage", 3);
    $body.append(settingRow("Max entries per message", "Cap on simultaneous injections",
        `<input type="number" id="ml-setting-maxEntries" value="${maxEntries}" min="1" max="10">`
    ));
    $body.find("#ml-setting-maxEntries").on("change", function () {
        setSetting("injection.maxEntriesPerMessage", parseInt($(this).val()) || 3);
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
    addRawRow('Top-k results',  'Max candidates before threshold',  'ml-setting-topK',          rawSettings.topK          || 10);

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

    // Re-rank
    const rerank = rawSettings.rerank || false;
    $rawAdvanced.append(`
        <div class="ml-decay-row">
            <div><div class="ml-decay-label">Re-rank results</div><div class="ml-decay-sub">Second-pass sort before injecting</div></div>
            <label class="ml-toggle"><input type="checkbox" id="ml-setting-rerank" ${rerank ? "checked" : ""}><span class="ml-slider"></span></label>
        </div>
    `);

    // Wire raw settings
    $rawAdvanced.find("#ml-setting-scanDepth").on("change", function () { saveRaw("scanDepth", parseInt($(this).val())); });
    $rawAdvanced.find("#ml-setting-chunkSize").on("change", function () { saveRaw("chunkSize", parseInt($(this).val())); });
    $rawAdvanced.find("#ml-setting-overlapTokens").on("change", function () { saveRaw("overlapTokens", parseInt($(this).val())); });
    $rawAdvanced.find("#ml-setting-topK").on("change", function () { saveRaw("topK", parseInt($(this).val())); });
    $rawAdvanced.find("#ml-setting-distanceMetric").on("change", function () { saveRaw("distanceMetric", $(this).val()); });
    $rawAdvanced.find("#ml-setting-rerank").on("change", function () { saveRaw("rerank", $(this).prop("checked")); });

    function saveRaw(key, value) {
        const raw = getSetting("vectorization.raw", {});
        raw[key] = value;
        setSetting("vectorization.raw", raw);
    }

    $body.append($rawAdvanced);

    // ── Stickiness ──────────────────────────────────────
    const stickiness = getSetting("vectorization.defaultStickiness", 0);
    $body.append(settingRow("Default stickiness", "Messages to stay after firing (0 = off)",
        `<input type="number" id="ml-setting-stickiness" value="${stickiness}" min="0" max="50">`
    ));
    $body.find("#ml-setting-stickiness").on("change", function () {
        setSetting("vectorization.defaultStickiness", parseInt($(this).val()) || 0);
    });

    // ── Cooldown ────────────────────────────────────────
    const cooldown = getSetting("vectorization.defaultCooldown", 0);
    $body.append(settingRow("Default cooldown", "Messages before re-fire (0 = off)",
        `<input type="number" id="ml-setting-cooldown" value="${cooldown}" min="0" max="50">`
    ));
    $body.find("#ml-setting-cooldown").on("change", function () {
        setSetting("vectorization.defaultCooldown", parseInt($(this).val()) || 0);
    });

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
            <input type="number" class="ml-setting-select" id="ml-sel-scan-from" placeholder="from" min="1" style="width:64px;text-align:center" title="First message # (1-based)">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#666">–</span>
            <input type="number" class="ml-setting-select" id="ml-sel-scan-to" placeholder="to" min="1" style="width:64px;text-align:center" title="Last message # (1-based)">
            <button class="ml-btn" id="ml-sel-scan-btn">Run selective scan</button>
        </div>`
    ));
    $body.find("#ml-sel-scan-btn").on("click", async () => {
        const { chat } = await import("../../../../../script.js");
        const total = chat?.length || 0;
        let from = parseInt($body.find("#ml-sel-scan-from").val(), 10);
        let to   = parseInt($body.find("#ml-sel-scan-to").val(), 10);
        if (isNaN(from) || isNaN(to)) { toastr?.warning?.("Enter both a start and end message number.", "Memory Loom"); return; }
        if (from < 1) from = 1;
        if (to > total) to = total;
        if (from > to) { toastr?.warning?.("Start message must be before end message.", "Memory Loom"); return; }
        // user types 1-based message numbers; chat indices are 0-based
        runBatchScan($body.find("#ml-sel-scan-btn"), from - 1, to - 1, "Run selective scan");
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
                const hasSettings = peek.settings ? "yes" : "no";
                counts = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#888;margin:8px 0;line-height:1.6">Found: ${nEntries} memories, ${nScenes} scenes · settings: ${hasSettings}</div>`;
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
                    <div style="margin:10px 0"><b>Memories, folders &amp; scenes</b>
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
                const sure = await mlPopupConfirm("<b>Replace</b> will permanently delete your existing memories, folders, and scenes before importing. This cannot be undone. Continue?");
                if (!sure) return;
            }

            const { importAllData } = await import("../settings.js");
            const ok = await importAllData(text, { settingsMode, dataMode });
            if (ok) {
                toastr?.success?.("Data imported. Reload to see changes.", "Memory Loom");
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
async function runBatchScan($btn, rangeStart, rangeEnd, idleLabel) {
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

        const { createScene, closeScene, recordLastClosedScene } = await import("../data/scenes.js");
        const { generateSceneSummary, generateMemoryEntries } = await import("../llm/writer.js");
        const { renderHomeTab } = await import("./home.js");
        const { renderLibraryTab } = await import("./library.js");

        const isSelective = rangeStart !== null || rangeEnd !== null;
        toastr?.info?.(isSelective
            ? `Selective scan started — messages ${rangeStart + 1}–${rangeEnd + 1}...`
            : "Batch scan started — analyzing chat history...", "Memory Loom");

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
            const progressMsg = `Scanning messages ${chunk.start + 1}–${chunk.end + 1} (${i + 1}/${chunks.length})...`;
            showPanelLoading(progressMsg);
            setProcessingStatus(progressMsg);
            toastr?.info?.(progressMsg, "Memory Loom", { timeOut: 3000 });
            try {
                const scene = createScene(chunk.start);
                if (!scene) continue;
                const closed = closeScene(scene.id, chunk.end);
                if (!closed) continue;
                recordLastClosedScene(closed.id);
                await generateSceneSummary(closed.id);
                const entries = await generateMemoryEntries(closed.id);
                processed++;
                if (entries?.length) {
                    totalEntries += entries.length;
                    toastr?.success?.(
                        `Chunk ${i + 1}: ${entries.length} ${entries.length === 1 ? "entry" : "entries"} queued`,
                        "Memory Loom", { timeOut: 2500 }
                    );
                }
                // show new scene + pending entries immediately
                refreshPanes();
            } catch (chunkErr) {
                console.error(`[ML] Scan chunk ${chunk.start}–${chunk.end} failed:`, chunkErr);
            }
            // Pause between chunks — each chunk fires 2 LLM calls with large payloads,
            // and providers like GLM Cloud rate-limit aggressively on burst traffic.
            await new Promise(r => setTimeout(r, 3000));
        }

        toastr?.success?.(
            `Scan complete — ${processed}/${chunks.length} chunks, ${totalEntries} entries pending review.`,
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
