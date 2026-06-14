/**
 * index.js — Memory Loom
 */
import { chat, chat_metadata, name1, saveSettingsDebounced, saveChatDebounced } from "../../../../script.js";
import { eventSource, event_types } from "../../../../scripts/events.js";
import { extension_settings } from "../../../../scripts/extensions.js";
import { initSettings, isEnabled, getSetting, isSidecarPaused } from "./settings.js";

// ── Debug log gate ────────────────────────────────────────
// Quiet by default: [ML]-prefixed console.log lines only show when the Debug
// toggle (Settings → Debug) is on. Warnings and errors ALWAYS show.
const __mlOrigLog = console.log.bind(console);
console.log = function (...args) {
    if (typeof args[0] === "string" && args[0].startsWith("[ML]")) {
        const on = (typeof window !== "undefined" && window.__ML_DEBUG !== undefined)
            ? window.__ML_DEBUG
            : (() => { try { return getSetting("debug.enabled", false); } catch (e) { return true; } })();
        if (!on) return;
    }
    __mlOrigLog(...args);
};
import { getFolders, saveFolders, getEntries, getScenes, getPendingEntries, savePendingEntries, getOpenSceneId, saveOpenSceneId, getMessageCounter, incrementMessageCounter, getStickinessMap, saveStickinessMap, getCooldownsMap, saveCooldownsMap } from "./data/storage.js";
import { createPanel, showPanelLoading, hidePanelLoading, setProcessingStatus } from "./ui/panel.js";
import { injectSvgDefs } from "./lib/icons.js";
import { renderHomeTab } from "./ui/home.js";
import { renderLibraryTab } from "./ui/library.js";
import { renderSettingsTab } from "./ui/settings.js";
import { extractKeywords } from "./llm/sidecar.js";
import { dlog } from "./lib/debug.js";
import { isMLInternalGen } from "./llm/connections.js";
import { registerMemoryRecallTool } from "./llm/recallTool.js";
import { runWriterFlow } from "./llm/writer.js";
import { maybeAutoConsolidate } from "./llm/consolidationOrchestrator.js";
import { runRetrievalPipeline, tickCounters } from "./embed/retriever.js";
import { updateInjection, removeInjection } from "./inject/promptInjector.js";
import { createScene, closeScene, getOpenScene, isMessageInClosedScene, initSceneCounter, recordLastClosedScene } from "./data/scenes.js";

let _sidecarRunning = false;
const _processedMesIds = new Set();
let mlPopoutVisible = false, $mlPopout = null;

jQuery(async () => {
    try {
        await initSettings(); window.__ML_DEBUG = getSetting("debug.enabled", false);
        injectSvgDefs();
        createPanel();
        renderHomeTab($("#ml-p-home"));
        renderLibraryTab($("#ml-p-library"));
        renderSettingsTab($("#ml-p-settings"));
        initSceneCounter();
        registerEventHandlers();
        registerMagicWandMenuEntry();
        eventSource.once(event_types.APP_READY, () => {
            if (!isEnabled()) return;
            $(".mes").each(function () {
                const mesId = $(this).attr("mesid");
                if (mesId !== undefined) addMessageButtons(parseInt(mesId, 10));
            });
        });
        $(document).on("ml:tab-switched", (_e, tabId) => {
            const $pane = $(`#ml-p-${tabId}`);
            if (tabId === "home") renderHomeTab($pane);
            else if (tabId === "library") renderLibraryTab($pane);
            else if (tabId === "settings") renderSettingsTab($pane);
        });
        $(document).on("ml:toggle", (_e, enabled) => {
            if (enabled) { $(".ml-scene-btn").show(); $("#ml_container").css({ opacity: "", pointerEvents: "" }); }
            else { removeInjection(); $(".ml-scene-btn").hide(); $("#ml_container").css({ opacity: "0.45", pointerEvents: "none" }); }
        });
        if (!isEnabled()) removeInjection(); // clear stale injection if extension is disabled
        registerMemoryRecallTool();
    } catch (err) { console.error("[ML] Init failed:", err.message, err.stack); }
});


/**
 * The sidecar → retriever → injector pipeline.
 * Every skip reason that used to be a silent early return now logs in debug
 * mode, so "why didn't the sidecar run" is answerable from the F12 console.
 */
let _sidecarStartedAt = 0;
const SIDECAR_TIMEOUT_MS = 45000; // hard cap per run — a hung LLM call must never wedge the pipeline

async function runSidecarPipeline(trigger) {
    const counter = incrementMessageCounter();
    const freq = getSetting("scanFrequency", 1);
    dlog(`Sidecar trigger: ${trigger} (turn ${counter}, runs every ${freq})`);
    if (counter % freq !== 0) { dlog(`Sidecar skipped — counter ${counter % freq}/${freq} (next run in ${freq - (counter % freq)} turn(s))`); return; }
    if (isSidecarPaused()) { dlog("Sidecar skipped — paused from Home tab"); return; }
    if (_sidecarRunning) {
        // Watchdog: a hung LLM call (cloud rate limit, dead connection) used to
        // leave this flag stuck TRUE forever, silently vetoing every future run
        // — "the sidecar ran once and never again". Stale runs now get evicted.
        if (Date.now() - _sidecarStartedAt > SIDECAR_TIMEOUT_MS) {
            console.warn("[ML] Sidecar: previous run exceeded timeout — force-resetting stuck flag");
            _sidecarRunning = false;
        } else {
            dlog("Sidecar skipped — previous run still in progress");
            return;
        }
    }
    _sidecarRunning = true;
    _sidecarStartedAt = Date.now();
    try {
        dlog("Sidecar: calling keyword LLM…");
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("sidecar timed out")), SIDECAR_TIMEOUT_MS));
        const keywords = await Promise.race([extractKeywords(), timeout]);
        dlog("Sidecar keywords:", JSON.stringify(keywords));
        const candidates = await Promise.race([runRetrievalPipeline(keywords), timeout]);
        dlog(`Retriever returned ${candidates.length} candidate(s):`, candidates.map(c => `"${c.entry.title}" (${(c.score ?? 0).toFixed(3)})`).join(", ") || "(none)");
        updateInjection(candidates);
        tickCounters();
    } catch (err) { console.error("[ML] Sidecar error:", err); }
    finally { _sidecarRunning = false; }
}

/**
 * Generate interceptor — ST AWAITS this before assembling the prompt for
 * every generation (same mechanism the built-in Vector Storage uses). This
 * is what makes per-turn injection actually work: the sidecar runs and the
 * refreshed injection is in place BEFORE the prompt is built, with the
 * user's newest message included in what the keyword LLM sees. The old
 * event-based triggers either landed one turn late (MESSAGE_SENT — prompt
 * already building) or lagged one message behind (MESSAGE_RECEIVED).
 */
globalThis.memoryLoomGenerateInterceptor = async function (chat, contextSize, abort, type) {
    try {
        if (!isEnabled()) return;
        if (isMLInternalGen()) { dlog("Interceptor: skipped (Memory Loom internal generation)"); return; }
        if (type === "quiet") { dlog("Interceptor: skipped (quiet generation)"); return; }
        dlog(`Interceptor: generation starting (type: ${type || "normal"})`);
        await runSidecarPipeline(`generation (${type || "normal"})`);
    } catch (err) {
        console.error("[ML] Generate interceptor error:", err);
    }
};

function registerEventHandlers() {
    eventSource.on(event_types.MESSAGE_RECEIVED, async (mesId) => {
        if (!isEnabled()) return;
        if (mesId !== undefined && _processedMesIds.has(mesId)) return;
        if (mesId !== undefined) _processedMesIds.add(mesId);
        addMessageButtons(mesId);
    });
    $(document).on("ml:scene-state-changed", () => { refreshSceneButtons(); });

    eventSource.on(event_types.MESSAGE_SENT, (mesId) => {
        if (!isEnabled()) return;
        if (mesId !== undefined && _processedMesIds.has(mesId)) return;
        if (mesId !== undefined) _processedMesIds.add(mesId);
        addMessageButtons(mesId);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        _processedMesIds.clear();
        initDefaultFolders();
        initSceneCounter();
        renderHomeTab($("#ml-p-home"));
        renderLibraryTab($("#ml-p-library"));
        renderSettingsTab($("#ml-p-settings"));
        if (!isEnabled()) removeInjection(); // clear stale injection on chat change if disabled
        $(".mes").each(function () {
            const mesId = $(this).attr("mesid");
            if (mesId !== undefined) addMessageButtons(parseInt(mesId, 10));
        });
    });
}

function addMessageButtons(mesId) {
    if (!isEnabled()) return;
    const $bar = $(`.mes[mesid="${mesId}"] .extraMesButtons`);
    if (!$bar.length) return;
    $bar.find(".ml-scene-btn").remove();
    const openScene = getOpenScene();
    let icon, title, css, handler;
    if (openScene && mesId >= openScene.messageStart && (openScene.messageEnd === null || mesId <= openScene.messageEnd)) {
        icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-feather"/></svg>';
        title = "Close scene"; css = "ml-scene-btn ml-scene-active";
        handler = async () => {
            const closed = closeScene(openScene.id, mesId);
            if (!closed) return;
            recordLastClosedScene(closed.id);
            refreshSceneButtons();
            toastr?.info?.("Scene closed — generating entries...");
            // Persistent indicators: panel overlay + Home-tab processing banner.
            // Toasts vanish; these stay up until the writer flow finishes.
            showPanelLoading("Scene closed — generating memory entries...");
            setProcessingStatus("Generating memory entries for closed scene...");
            renderHomeTab($("#ml-p-home"));
            try {
                const result = await runWriterFlow(closed.id);
                if (result && result.length > 0) toastr?.success?.(result.length + " entr" + (result.length === 1 ? "y" : "ies") + " ready for review.");
                else toastr?.warning?.("Scene closed. Check LLM connection.");
            } catch (e) { console.error(e); toastr?.error?.("Entry generation failed."); }
            hidePanelLoading();
            setProcessingStatus(null);
            // Refresh Home (pending entries) AND Library (Scenes view) so the new
            // material shows without flipping between tabs
            renderHomeTab($("#ml-p-home"));
            const $lib = $("#ml-p-library");
            if ($lib.length) renderLibraryTab($lib);
            // Automatic consolidation check — only fires if enabled and a folder
            // crossed its threshold. Runs after entries are committed, not pending.
            maybeAutoConsolidate().then(() => {
                const $l = $("#ml-p-library"); if ($l.length) renderLibraryTab($l);
            }).catch(err => console.error("[ML] Auto-consolidate error:", err));
        };
    } else if (isMessageInClosedScene(mesId)) {
        icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-book"/></svg>';
        title = "Already scanned"; css = "ml-scene-btn"; handler = null;
    } else {
        icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-book-open"/></svg>';
        title = "Open scene"; css = "ml-scene-btn";
        handler = () => {
            if (getOpenScene()) { toastr?.warning?.("Scene already open."); return; }
            createScene(mesId); refreshSceneButtons(); toastr?.success?.("Scene opened.");
        };
    }
    const $btn = $(`<div class="${css}" title="${title}">${icon}</div>`);
    if (handler) $btn.on("click", handler);
    $bar.prepend($btn);
}
function refreshSceneButtons() {
    $(".mes[mesid]").each(function() {
        const id = parseInt($(this).attr("mesid"), 10);
        if (!isNaN(id)) addMessageButtons(id);
    });
}


function initDefaultFolders() {
    const folders = getFolders();
    const defaults = [
        { id: "ml_folder_world", name: "World", type: "world", parentId: null },
        { id: "ml_folder_characters", name: "Characters", type: "characters", parentId: null },
        { id: "ml_folder_plot", name: "Plot", type: "plot", parentId: null },
    ];
    let changed = false;
    for (const df of defaults) {
        if (!folders.find(f => f.id === df.id)) {
            folders.push({ ...df, characterName: null, hasImage: false, imagePath: null, entryCount: 0, createdAt: Date.now() });
            changed = true;
        }
    }
    if (changed) saveFolders(folders);
}

function registerMagicWandMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('ml-wand-entry')) return;
    const entry = document.createElement('div');
    entry.id = 'ml-wand-entry';
    entry.className = 'list-group-item flex-container flexGap5 interactable';
    entry.title = 'Open Memory Loom'; entry.tabIndex = 0;
    entry.innerHTML = '<i class="fa-solid fa-book-open-reader"></i><span>Memory Loom</span>';
    entry.addEventListener('click', () => { mlPopoutVisible ? closeMlPopout() : openMlPopout(); });
    menu.appendChild(entry);
}
function openMlPopout() {
    if (mlPopoutVisible) return;
    const $c = $('#ml_container .inline-drawer-content'); if (!$c.length) return;
    $mlPopout = $(`<div id="ml-popout" class="draggable"><div id="ml-popout-header" class="ml-popout-header"><div class="ml-popout-title"><i class="fa-solid fa-book-open-reader"></i><span>Memory Loom</span></div><div class="ml-popout-close" title="Close"><i class="fa-solid fa-xmark"></i></div></div><div id="ml-popout-content"></div></div>`);
    $('body').append($mlPopout); $mlPopout.find('#ml-popout-content')[0].appendChild($c[0]);
    $mlPopout.find('.ml-popout-close').on('click', closeMlPopout);
    $(document).on('keydown.ml_popout', e => { if (e.key === 'Escape') closeMlPopout(); });
    if (typeof window.dragElement === 'function') window.dragElement($mlPopout);
    $mlPopout.fadeIn(200); mlPopoutVisible = true;
}
function closeMlPopout() {
    if (!mlPopoutVisible || !$mlPopout) return;
    const dc = document.getElementById('ml-popout-content')?.firstElementChild;
    $mlPopout.fadeOut(200, () => {
        if (dc) { const p = $('#ml_container .inline-drawer'); (p.length ? p : $('#ml_container')).append(dc); }
        $mlPopout.remove(); $mlPopout = null;
    });
    mlPopoutVisible = false; $(document).off('keydown.ml_popout');
}
