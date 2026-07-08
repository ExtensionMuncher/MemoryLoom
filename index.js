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
import { getFolders, saveFolders, getEntries, getScenes, getPendingEntries, savePendingEntries, getOpenSceneId, saveOpenSceneId, setMessageCounter, syncMessageCounterToLiveCount, getStickinessMap, saveStickinessMap, getCooldownsMap, saveCooldownsMap } from "./data/storage.js";
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
import { getAllEntries, resetEntryMigrationGuards } from "./data/entries.js";

let _sidecarRunning = false;

// ST may reuse/renumber mesIds after message deletion. This Set is only a
// session-level de-dupe guard, so it must be cleared whenever the live chat
// shrinks or changes shape. Otherwise newly-renumbered messages can be mistaken
// for old deleted ones.
const _processedMesIds = new Set();

// Tracks the live chat size so deleted OOC/test messages cannot strand the
// sidecar counter ahead of the real chat.
let _lastObservedChatLength = Array.isArray(chat) ? chat.length : 0;

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
    const liveCount = syncRuntimeMessageState(`sidecar ${trigger}`);
    const rawFreq = Number(getSetting("scanFrequency", 1));
    const freq = Number.isFinite(rawFreq) && rawFreq > 0 ? Math.floor(rawFreq) : 1;
    const sync = syncMessageCounterToLiveCount(liveCount);
    const lastScanCount = sync.counter;
    const messagesSinceScan = Math.max(0, liveCount - lastScanCount);
    const shouldFire = messagesSinceScan >= freq;

    dlog(`Sidecar trigger: ${trigger} (liveCount=${liveCount}, lastSidecarCount=${lastScanCount}, sinceLastScan=${messagesSinceScan}, runs every ${freq})`);
    if (!shouldFire) { dlog(`Sidecar skipped — ${messagesSinceScan}/${freq} message(s) since last scan (next run in ${freq - messagesSinceScan} message(s))`); return; }
    if (isSidecarPaused()) { dlog("Sidecar skipped — paused from Home tab"); return; }
    // Empty-library guard: the sidecar exists to find stored memories that match
    // the current conversation. With zero entries in the library there is nothing
    // to match against, so every LLM call would be wasted. Skip until the library
    // actually has content (e.g. after the first scene is closed and entries are
    // committed). This is the common "fresh chat, nothing saved yet" case.
    if (getAllEntries().length === 0) { dlog("Sidecar skipped — library is empty (no entries to match)"); return; }
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
    // Advance the baseline as soon as a run begins. This preserves the old
    // behavior where a failed sidecar call does not retry on every generation,
    // while still anchoring the scheduler to the current live chat length.
    setMessageCounter(liveCount);

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

// ── Runtime Message State ─────────────────────────────────

/**
 * Return the current live chat message count, preferring the event mesId when it
 * is available because ST passes freshly-rendered message indexes directly.
 * ST mesIds are zero-based, so mesId 143 means 144 live message slots.
 * @param {number|string|null} [mesId]
 * @returns {number}
 */
function getLiveMessageCount(mesId = null) {
    const chatLength = Array.isArray(chat) ? chat.length : 0;
    const parsed = mesId !== null && mesId !== undefined ? parseInt(mesId, 10) : NaN;
    const fromMesId = Number.isFinite(parsed) && parsed >= 0 ? parsed + 1 : 0;
    return Math.max(chatLength, fromMesId);
}

/**
 * Keep ML's session-only message bookkeeping aligned with the visible chat.
 * This fixes the deleted-OOC case where the saved sidecar counter points past
 * the live chat and the processed mesId cache still contains deleted indexes.
 * @param {string} reason
 * @param {number|string|null} [mesId]
 * @returns {number} current live message count
 */
function syncRuntimeMessageState(reason = "unknown", mesId = null) {
    const liveCount = getLiveMessageCount(mesId);

    if (liveCount < _lastObservedChatLength) {
        const previousLength = _lastObservedChatLength;
        _processedMesIds.clear();
        const sync = syncMessageCounterToLiveCount(liveCount);
        dlog(`[ML] Live chat shrank (${previousLength} → ${liveCount}) during ${reason}; cleared processed message IDs.` +
            (sync.changed ? ` Sidecar counter clamped ${sync.previous} → ${sync.counter}.` : ""));
    } else {
        const sync = syncMessageCounterToLiveCount(liveCount);
        if (sync.changed) {
            dlog(`[ML] Sidecar counter clamped ${sync.previous} → ${sync.counter} during ${reason}.`);
        }
    }

    _lastObservedChatLength = liveCount;
    return liveCount;
}

/**
 * Chat switches, deletes, edits, and swipes can invalidate mesId caches. Per-chat
 * ML data lives in chat_metadata, but _processedMesIds is memory-only and must
 * be reset when the visible chat changes shape.
 * @param {string} reason
 */
function resetRuntimeMessageState(reason = "chat changed") {
    _processedMesIds.clear();
    _lastObservedChatLength = getLiveMessageCount();
    const sync = syncMessageCounterToLiveCount(_lastObservedChatLength);
    dlog(`[ML] Runtime message state reset (${reason}); liveCount=${_lastObservedChatLength}` +
        (sync.changed ? `, sidecar counter clamped ${sync.previous} → ${sync.counter}` : ""));
}

// One delegated listener handles every scene button, no matter how many times
// the buttons are rebuilt. Bound to document so it survives ST's frequent
// message-row re-renders (the reason direct handlers failed on mobile). We guard
// against the double-fire that touch devices produce (touchend THEN click) with
// a short timestamp lock.
let _lastSceneTap = 0;
function registerSceneButtonDelegate() {
    const run = (e) => {
        const el = e.target && e.target.closest ? e.target.closest(".ml-scene-btn") : null;
        if (!el) return;
        const action = el.getAttribute("data-ml-action");
        if (!action) return;  // "Already scanned" state — no action
        const now = Date.now();
        if (now - _lastSceneTap < 400) return;  // de-dupe rapid double events
        _lastSceneTap = now;
        const mesId = parseInt(el.getAttribute("data-ml-mesid"), 10);
        if (isNaN(mesId)) return;
        console.log("[ML] scene button tapped:", action, "mesId:", mesId);
        handleSceneButtonAction(action, mesId).catch((err) => {
            console.error("[ML] Scene button action failed:", err);
            toastr?.error?.("Memory Loom scene action failed. Check the console for details.");
            try {
                hidePanelLoading();
                setProcessingStatus(null);
                refreshSceneButtons();
            } catch (cleanupErr) {
                console.error("[ML] Scene button cleanup failed:", cleanupErr);
            }
        });
    };
    // Namespaced so re-init doesn't stack duplicates. 'click' covers desktop and
    // mobile taps on modern browsers; we intentionally do NOT preventDefault or
    // stopPropagation so we never interfere with SillyTavern's own handling.
    $(document).off("click.mlscene");
    $(document).on("click.mlscene", ".ml-scene-btn", run);
}

function registerEventHandlers() {
    registerSceneButtonDelegate();
    eventSource.on(event_types.MESSAGE_RECEIVED, async (mesId) => {
        if (!isEnabled()) return;
        syncRuntimeMessageState("MESSAGE_RECEIVED", mesId);
        if (mesId !== undefined && _processedMesIds.has(mesId)) return;
        if (mesId !== undefined) _processedMesIds.add(mesId);
        addMessageButtons(mesId);
    });
    $(document).on("ml:scene-state-changed", () => { refreshSceneButtons(); });

    eventSource.on(event_types.MESSAGE_SENT, (mesId) => {
        if (!isEnabled()) return;
        syncRuntimeMessageState("MESSAGE_SENT", mesId);
        if (mesId !== undefined && _processedMesIds.has(mesId)) return;
        if (mesId !== undefined) _processedMesIds.add(mesId);
        addMessageButtons(mesId);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        resetRuntimeMessageState("CHAT_CHANGED");
        resetEntryMigrationGuards();   // re-run per-chat migrations for the new chat
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

    // Message deletion/edit/swipe can renumber mesIds without a full extension
    // reload. Register defensively for whichever event names exist in this ST build.
    ["MESSAGE_DELETED", "MESSAGE_EDITED", "MESSAGE_SWIPED", "CHAT_DELETED"].forEach((eventName) => {
        const eventType = event_types[eventName];
        if (!eventType) return;
        eventSource.on(eventType, () => resetRuntimeMessageState(eventName));
    });
}

function addMessageButtons(mesId) {
    if (!isEnabled()) return;
    const $bar = $(`.mes[mesid="${mesId}"] .extraMesButtons`);
    if (!$bar.length) return;
    $bar.find(".ml-scene-btn").remove();
    const openScene = getOpenScene();
    let icon, title, css, action;
    if (openScene && mesId >= openScene.messageStart && (openScene.messageEnd === null || mesId <= openScene.messageEnd)) {
        icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-feather"/></svg>';
        title = "Close scene"; css = "ml-scene-btn ml-scene-active"; action = "close";
    } else if (isMessageInClosedScene(mesId)) {
        icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-book"/></svg>';
        title = "Already scanned"; css = "ml-scene-btn"; action = "";
    } else {
        icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#ico-book-open"/></svg>';
        title = "Open scene"; css = "ml-scene-btn"; action = "open";
    }
    // Data-driven button: the click is handled by ONE delegated listener on
    // document (see registerSceneButtonDelegate). Direct per-button handlers were
    // unreliable on mobile — ST re-renders message rows frequently, swapping the
    // element out from under a tap before the click fired, so nothing happened.
    const $btn = $(`<div class="${css}" title="${title}" data-ml-action="${action}" data-ml-mesid="${mesId}" role="button" tabindex="0">${icon}</div>`);
    $bar.prepend($btn);
}

// Runs the scene action for a given message. Called by the delegated listener.
async function handleSceneButtonAction(action, mesId) {
    if (action === "open") {
        if (getOpenScene()) { toastr?.warning?.("Scene already open."); return; }
        createScene(mesId); refreshSceneButtons(); toastr?.success?.("Scene opened.");
        return;
    }
    if (action === "close") {
        const openScene = getOpenScene();
        console.log("[ML] handleSceneButtonAction close — openScene:", openScene);
        if (!openScene) { refreshSceneButtons(); return; }
        const closed = closeScene(openScene.id, mesId);
        console.log("[ML] closeScene returned:", closed);
        if (!closed) return;
        recordLastClosedScene(closed.id);
        refreshSceneButtons();
        toastr?.info?.("Scene closed — generating entries...");
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
        renderHomeTab($("#ml-p-home"));
        const $lib = $("#ml-p-library");
        if ($lib.length) renderLibraryTab($lib);
        maybeAutoConsolidate().then(() => {
            const $l = $("#ml-p-library"); if ($l.length) renderLibraryTab($l);
        }).catch(err => console.error("[ML] Auto-consolidate error:", err));
    }
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
    entry.addEventListener('click', () => {
        // Use real DOM presence, not just the flag, so a desynced flag can't
        // wedge the toggle (the "won't reopen" bug). open() self-heals stale state.
        const reallyOpen = mlPopoutVisible && $mlPopout && document.body.contains($mlPopout[0]);
        reallyOpen ? closeMlPopout() : openMlPopout();
    });
    menu.appendChild(entry);
}
function openMlPopout() {
    // Self-heal: if state says open but the popout DOM is gone (destroyed by an
    // outside event, interrupted fade, etc.), reset so we can reopen instead of
    // being permanently stuck. This was the "popup won't reopen until refresh" bug.
    if (mlPopoutVisible && (!$mlPopout || !document.body.contains($mlPopout[0]))) {
        recoverOrphanedPopoutContent();
        mlPopoutVisible = false;
        $mlPopout = null;
    }
    if (mlPopoutVisible) return;

    // The drawer content may be orphaned inside a removed popout from a prior
    // botched close — recover it back to #ml_container before we grab it.
    recoverOrphanedPopoutContent();

    let $c = $('#ml_container .inline-drawer-content');
    if (!$c.length) {
        // Last resort: the panel was never built or content is missing — rebuild.
        try { createPanel(); } catch (e) { console.error("[ML] popout: panel rebuild failed:", e); }
        $c = $('#ml_container .inline-drawer-content');
        if (!$c.length) { console.warn("[ML] popout: no panel content to show."); return; }
    }

    $mlPopout = $(`<div id="ml-popout" class="draggable"><div id="ml-popout-header" class="ml-popout-header"><div class="ml-popout-title"><i class="fa-solid fa-book-open-reader"></i><span>Memory Loom</span></div><div class="ml-popout-close" title="Close"><i class="fa-solid fa-xmark"></i></div></div><div id="ml-popout-content"></div></div>`);
    $('body').append($mlPopout);
    $mlPopout.find('#ml-popout-content')[0].appendChild($c[0]);
    $mlPopout.find('.ml-popout-close').on('click', closeMlPopout);
    $(document).on('keydown.ml_popout', e => { if (e.key === 'Escape') closeMlPopout(); });
    if (typeof window.dragElement === 'function') window.dragElement($mlPopout);
    $mlPopout.fadeIn(200); mlPopoutVisible = true;
}

/** Move the drawer content back into #ml_container if it's stranded in a
 *  (possibly detached) popout. Safe to call anytime; no-op if nothing stranded. */
function recoverOrphanedPopoutContent() {
    try {
        const content = document.getElementById('ml-popout-content')?.firstElementChild
            || (document.querySelector('#ml-popout .inline-drawer-content'));
        if (content && !$('#ml_container .inline-drawer-content').length) {
            const p = $('#ml_container .inline-drawer');
            (p.length ? p : $('#ml_container')).append(content);
        }
        // Remove any leftover popout shells
        $('#ml-popout').each(function () { if (this !== ($mlPopout && $mlPopout[0])) this.remove(); });
    } catch (e) { console.warn("[ML] popout recovery skipped:", e); }
}

function closeMlPopout() {
    if (!mlPopoutVisible || !$mlPopout) {
        // State already says closed — make sure nothing is stranded, then bail.
        recoverOrphanedPopoutContent();
        mlPopoutVisible = false; $mlPopout = null;
        $(document).off('keydown.ml_popout');
        return;
    }
    const popoutEl = $mlPopout;
    const dc = document.getElementById('ml-popout-content')?.firstElementChild;
    // Flip state FIRST so a mid-fade interruption can't leave us stuck "open".
    mlPopoutVisible = false; $mlPopout = null;
    $(document).off('keydown.ml_popout');
    const restore = () => {
        if (dc && !$('#ml_container .inline-drawer-content').length) {
            const p = $('#ml_container .inline-drawer');
            (p.length ? p : $('#ml_container')).append(dc);
        }
        popoutEl.remove();
    };
    popoutEl.fadeOut(200, restore);
    // Safety net: if fadeOut's callback never fires (tab backgrounded, etc.),
    // force the restore shortly after so content is never left orphaned.
    setTimeout(() => { if (document.body.contains(popoutEl[0])) restore(); }, 600);
}
