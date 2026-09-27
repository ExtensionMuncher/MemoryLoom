import { captureChatGuard } from "./lib/chatGuard.js";
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
import { getFolders, saveFolders, getEntries, getScenes, getPendingEntries, savePendingEntries, getOpenSceneId, saveOpenSceneId, getMessageCounter, setMessageCounter, syncMessageCounterToLiveCount, getSidecarPauseCadence, saveSidecarPauseCadence, clearSidecarPauseCadence, getStickinessMap, saveStickinessMap, getCooldownsMap, saveCooldownsMap } from "./data/storage.js";
import { createPanel, showPanelLoading, hidePanelLoading, setProcessingStatus } from "./ui/panel.js";
import { injectSvgDefs } from "./lib/icons.js";
import { renderHomeTab, refreshSidecarCadenceDisplay, setSidecarCadenceRunning } from "./ui/home.js";
import { renderLibraryTab } from "./ui/library.js";
import { renderSettingsTab } from "./ui/settings.js";
import { extractKeywords } from "./llm/sidecar.js";
import { dlog, clearLastRetrievalTrace } from "./lib/debug.js";
import { isMLInternalGen } from "./llm/connections.js";
import { registerMemoryRecallTool } from "./llm/recallTool.js";
import { runWriterFlow } from "./llm/writer.js";
import { maybeAutoConsolidate } from "./llm/consolidationOrchestrator.js";
import { runRetrievalPipeline, tickCounters } from "./embed/retriever.js";
import { updateInjection, removeInjection, refreshCurrentInjectionEligibility } from "./inject/promptInjector.js";
import { MEMORY_ELIGIBILITY_EVENT } from "./lib/eligibilityEvents.js";
import { isNarrativeMessage, narrativeMessages } from "./lib/chatMessages.js";
import { createScene, closeScene, getOpenScene, isMessageInClosedScene, initSceneCounter, recordLastClosedScene } from "./data/scenes.js";
import { getAllEntries, resetEntryMigrationGuards } from "./data/entries.js";
import { reconcileFolderEntryCounts } from "./data/folders.js";

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

// Scene controls are a core chat affordance, so bootstrap them independently
// of the heavier async Memory Loom panel/settings initialization below. This
// prevents an unrelated init delay/error or another extension's late message-row
// rewrite from leaving the entire chat without Open/Close Scene controls.
jQuery(() => {
    try {
        registerSceneButtonDelegate();
        installSceneButtonObserver();
        scheduleSceneButtonRefresh();
    } catch (err) {
        console.error("[ML] Early scene-control bootstrap failed:", err);
    }
});

jQuery(async () => {
    try {
        await initSettings(); window.__ML_DEBUG = getSetting("debug.enabled", false);
        initDefaultFolders();
        getAllEntries(); // run per-chat safety migrations before any UI/retrieval work
        reconcileFolderEntryCounts();
        injectSvgDefs();
        createPanel();
        renderHomeTab($("#ml-p-home"));
        renderLibraryTab($("#ml-p-library"));
        renderSettingsTab($("#ml-p-settings"));
        initSceneCounter();
        registerEventHandlers();
        installSceneButtonObserver();
        registerMagicWandMenuEntry();

        // Do not rely on APP_READY for the first scene-button injection. ML does
        // asynchronous setup above, so SillyTavern can legitimately emit
        // APP_READY before this listener is registered. In that race the whole
        // existing chat used to remain without Open/Close Scene buttons until a
        // later chat switch. Populate the live DOM immediately, then keep the
        // APP_READY hook as an idempotent safety pass for slower host boots.
        refreshSceneButtons();
        eventSource.once(event_types.APP_READY, () => {
            if (!isEnabled()) return;
            refreshSceneButtons();
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
        // A persistent extension prompt must never retain a memory after it is
        // edited, archived, suppressed, deleted, replaced, or imported over.
        $(document).off(`${MEMORY_ELIGIBILITY_EVENT}.ml-eligibility`)
            .on(`${MEMORY_ELIGIBILITY_EVENT}.ml-eligibility`, refreshCurrentInjectionEligibility);
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
let _sidecarRunId = 0;
const SIDECAR_TIMEOUT_MS = 45000; // hard cap per run — a hung LLM call must never wedge the pipeline

async function runSidecarPipeline(trigger) {
    const assertChat = captureChatGuard();
    const liveCount = syncRuntimeMessageState(`sidecar ${trigger}`);
    const rawFreq = Number(getSetting("scanFrequency", 1));
    const freq = Number.isFinite(rawFreq) && rawFreq > 0 ? Math.floor(rawFreq) : 1;

    // Pause is a true cadence freeze. Keep the original snapshot intact no
    // matter how many narrative messages are added while paused.
    if (isSidecarPaused()) {
        captureSidecarPauseCadence(liveCount);
        refreshSidecarCadenceDisplay(liveCount);
        dlog("Sidecar skipped — paused; cadence progress frozen");
        return;
    }

    const sync = syncMessageCounterToLiveCount(liveCount);
    const lastScanCount = sync.counter;
    const messagesSinceScan = Math.max(0, liveCount - lastScanCount);
    const shouldFire = messagesSinceScan >= freq;

    dlog(`Sidecar trigger: ${trigger} (liveCount=${liveCount}, lastSidecarCount=${lastScanCount}, sinceLastScan=${messagesSinceScan}, runs every ${freq})`);
    refreshSidecarCadenceDisplay(liveCount);
    if (!shouldFire) { dlog(`Sidecar skipped — ${messagesSinceScan}/${freq} message(s) since last scan (next run in ${freq - messagesSinceScan} message(s))`); return; }
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
    setSidecarCadenceRunning(true);
    _sidecarStartedAt = Date.now();
    const runStamp = ++_sidecarRunId;
    let timer;
    const assertCurrent = () => {
        assertChat();
        if (!isEnabled() || isSidecarPaused() || _sidecarRunId !== runStamp) throw new Error("Sidecar cancelled or superseded");
    };
    try {
        dlog("Sidecar: calling keyword LLM…");
        const timeout = new Promise((_, rej) => timer = setTimeout(() => rej(new Error("sidecar timed out")), SIDECAR_TIMEOUT_MS));
        const keywords = await Promise.race([extractKeywords(), timeout]);
        assertCurrent();
        dlog("Sidecar keywords:", JSON.stringify(keywords));
        const candidates = await Promise.race([runRetrievalPipeline(keywords), timeout]);
        dlog(`Retriever returned ${candidates.length} candidate(s):`, candidates.map(c => `"${c.entry.title}" (${(c.score ?? 0).toFixed(3)})`).join(", ") || "(none)");
        assertCurrent();
        tickCounters();
        updateInjection(candidates);
    } catch (err) { console.error("[ML] Sidecar error:", err); }
    finally {
        clearTimeout(timer);
        if (_sidecarRunId === runStamp) _sidecarRunning = false;
        setSidecarCadenceRunning(false);
        refreshSidecarCadenceDisplay();
    }
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
    return narrativeMessages(chat).length;
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

/** Freeze cadence progress without consuming messages that arrive while paused. */
function captureSidecarPauseCadence(liveCount = getLiveMessageCount(), force = false) {
    const sync = syncMessageCounterToLiveCount(liveCount);
    const existing = getSidecarPauseCadence();
    if (!force && existing) return existing;
    return saveSidecarPauseCadence(liveCount, sync.counter);
}

/** Restore the exact pre-pause progress against the current live chat length. */
function restoreSidecarPauseCadence(liveCount = getLiveMessageCount()) {
    const snapshot = getSidecarPauseCadence();
    if (!snapshot) return syncMessageCounterToLiveCount(liveCount).counter;

    const progressAtPause = Math.max(0, snapshot.liveCount - snapshot.baseline);
    const preservedProgress = Math.min(progressAtPause, Math.max(0, liveCount));
    const restoredBaseline = Math.max(0, Math.floor(liveCount) - preservedProgress);
    setMessageCounter(restoredBaseline);
    clearSidecarPauseCadence();
    return restoredBaseline;
}

// One delegated listener handles every scene button, no matter how many times
// the buttons are rebuilt. Bound to document so it survives ST's frequent
// message-row re-renders (the reason direct handlers failed on mobile). We guard
// against the double-fire that touch devices produce (touchend THEN click) with
// a short timestamp lock.
let _lastSceneTap = 0;
let _sceneButtonObserver = null;
let _sceneRefreshTimer = null;

function scheduleSceneButtonRefresh(delay = 0) {
    if (_sceneRefreshTimer !== null) return;
    _sceneRefreshTimer = setTimeout(() => {
        _sceneRefreshTimer = null;
        try { refreshSceneButtons(); }
        catch (err) { console.error("[ML] Scene-button refresh failed:", err); }
    }, Math.max(0, Number(delay) || 0));
}

/**
 * Watch the live chat DOM itself instead of trusting a particular host/extension
 * event ordering. ST and other extensions are allowed to replace message rows or
 * their .extraMesButtons containers after MESSAGE_*_RENDERED has already fired.
 * When that happens, event-only injection silently disappears. The observer
 * notices added/replaced action bars (and removal of an ML control) and repairs
 * the affected rows on the next task.
 */
function installSceneButtonObserver() {
    if (_sceneButtonObserver || typeof MutationObserver !== "function") return;
    const root = document.getElementById("chat") || document.body;
    if (!root) return;

    _sceneButtonObserver = new MutationObserver((mutations) => {
        let shouldRefresh = false;
        for (const mutation of mutations) {
            if (mutation.type !== "childList") continue;
            const target = mutation.target?.nodeType === 1 ? mutation.target : null;

            // Any replacement inside a message action container can remove an
            // extension button without another ST render event being emitted.
            if (target?.matches?.(".extraMesButtons, .mes_buttons")) {
                const row = target.closest?.(".mes[mesid]");
                if (row && !row.querySelector(".ml-scene-btn")) {
                    shouldRefresh = true;
                    break;
                }
            }

            for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
                if (!node || node.nodeType !== 1) continue;
                if (node.matches?.(".mes[mesid], .extraMesButtons, .ml-scene-btn") ||
                    node.querySelector?.(".mes[mesid], .extraMesButtons, .ml-scene-btn")) {
                    shouldRefresh = true;
                    break;
                }
            }
            if (shouldRefresh) break;
        }
        if (shouldRefresh) scheduleSceneButtonRefresh();
    });

    _sceneButtonObserver.observe(root, { childList: true, subtree: true });
    console.log("[ML] Scene-button DOM observer attached");
    scheduleSceneButtonRefresh();
}

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

    // SillyTavern can rebuild a message row (swipe/edit/chat render) after ML has
    // already injected its action button. Re-attach on the host's actual render
    // events so scene controls survive DOM replacement instead of depending on
    // message-send/receive timing alone.
    ["USER_MESSAGE_RENDERED", "CHARACTER_MESSAGE_RENDERED", "MESSAGE_UPDATED"].forEach((eventName) => {
        const eventType = event_types[eventName];
        if (!eventType) return;
        eventSource.on(eventType, (mesId) => {
            if (!isEnabled()) return;
            const id = Number(mesId);
            if (!Number.isInteger(id)) return;
            // Rendering is complete when these events fire in ST 1.18, but defer
            // one task as a defensive measure for extensions that append/replace
            // message-action DOM in their own render listeners.
            setTimeout(() => addMessageButtons(id), 0);
        });
    });

    $(document).on("ml:sidecar-pause-changed", (_event, paused) => {
        // Invalidate any in-flight result so a request started before pause can
        // never inject after the user resumes quickly.
        _sidecarRunId++;
        _sidecarRunning = false;
        setSidecarCadenceRunning(false);
        const liveCount = getLiveMessageCount();
        if (paused) {
            const snapshot = captureSidecarPauseCadence(liveCount, true);
            const progress = Math.max(0, snapshot.liveCount - snapshot.baseline);
            dlog(`[ML] Sidecar paused; cadence frozen at ${progress} message(s) of progress.`);
        } else {
            const restoredBaseline = restoreSidecarPauseCadence(liveCount);
            dlog(`[ML] Sidecar resumed; cadence baseline restored to ${restoredBaseline} at liveCount=${liveCount}.`);
        }
        refreshSidecarCadenceDisplay(liveCount);
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, async (mesId) => {
        if (!isEnabled()) return;
        if (chat?.[Number(mesId)] && !isNarrativeMessage(chat[Number(mesId)])) return;
        const liveCount = syncRuntimeMessageState("MESSAGE_RECEIVED", mesId);
        refreshSidecarCadenceDisplay(liveCount);
        if (mesId !== undefined && _processedMesIds.has(mesId)) return;
        if (mesId !== undefined) _processedMesIds.add(mesId);
        addMessageButtons(mesId);
    });
    $(document).on("ml:scene-state-changed", () => { refreshSceneButtons(); });

    eventSource.on(event_types.MESSAGE_SENT, (mesId) => {
        if (!isEnabled()) return;
        if (chat?.[Number(mesId)] && !isNarrativeMessage(chat[Number(mesId)])) return;
        const liveCount = syncRuntimeMessageState("MESSAGE_SENT", mesId);
        refreshSidecarCadenceDisplay(liveCount);
        if (mesId !== undefined && _processedMesIds.has(mesId)) return;
        if (mesId !== undefined) _processedMesIds.add(mesId);
        addMessageButtons(mesId);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        _sidecarRunId++;
        _sidecarRunning = false;
        clearLastRetrievalTrace();
        resetRuntimeMessageState("CHAT_CHANGED");
        setSidecarCadenceRunning(false);
        const liveCount = getLiveMessageCount();
        if (isSidecarPaused()) captureSidecarPauseCadence(liveCount);
        else if (getSidecarPauseCadence()) restoreSidecarPauseCadence(liveCount);
        else clearSidecarPauseCadence();
        refreshSidecarCadenceDisplay(liveCount);
        resetEntryMigrationGuards();   // re-run per-chat migrations for the new chat
        initDefaultFolders();
        getAllEntries();
        reconcileFolderEntryCounts();
        initSceneCounter();
        renderHomeTab($("#ml-p-home"));
        renderLibraryTab($("#ml-p-library"));
        renderSettingsTab($("#ml-p-settings"));
        if (!isEnabled()) removeInjection(); // clear stale injection on chat change if disabled
        scheduleSceneButtonRefresh();
    });

    // Message deletion/edit/swipe can renumber mesIds without a full extension
    // reload. Register defensively for whichever event names exist in this ST build.
    ["MESSAGE_DELETED", "MESSAGE_EDITED", "MESSAGE_SWIPED", "CHAT_DELETED"].forEach((eventName) => {
        const eventType = event_types[eventName];
        if (!eventType) return;
        eventSource.on(eventType, () => {
            resetRuntimeMessageState(eventName);
            scheduleSceneButtonRefresh();
        });
    });
}

function sceneButtonState(mesId) {
    const openScene = getOpenScene();
    if (openScene && mesId >= openScene.messageStart && (openScene.messageEnd === null || mesId <= openScene.messageEnd)) {
        return { iconId: "ico-feather", title: "Close scene", active: true, action: "close" };
    }
    if (isMessageInClosedScene(mesId)) {
        return { iconId: "ico-book", title: "Already scanned", active: false, action: "" };
    }
    return { iconId: "ico-book-open", title: "Open scene", active: false, action: "open" };
}

function addMessageButtons(mesId) {
    if (!isEnabled()) return;
    const id = Number(mesId);
    if (!Number.isInteger(id)) return;

    const $row = $(`.mes[mesid="${id}"]`);
    if (!$row.length) return;

    // Hidden roleplay messages in ST 1.18 may carry is_system=true but are still
    // narrative; isNarrativeMessage handles that distinction. Actual tool/system
    // records should not expose scene controls.
    if (chat?.[id] && !isNarrativeMessage(chat[id])) {
        $row.find(".ml-scene-btn").remove();
        return;
    }

    // Prefer ST's normal extension-action container. If another extension/core
    // customization temporarily removes it, fall back to the main action bar so
    // Open/Close Scene remains available instead of disappearing entirely.
    let $bar = $row.find(".extraMesButtons").first();
    if (!$bar.length) $bar = $row.find(".mes_buttons").first();
    if (!$bar.length) return;

    const state = sceneButtonState(id);
    const desiredClass = `mes_button ml-scene-btn${state.active ? " ml-scene-active" : ""}`;
    const icon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#${state.iconId}"/></svg>`;

    let $btn = $row.find(".ml-scene-btn").first();
    $row.find(".ml-scene-btn").slice(1).remove();

    // Move a fallback button into .extraMesButtons once the canonical container
    // appears, without recreating it unnecessarily.
    if ($btn.length && $btn.parent()[0] !== $bar[0]) $bar.prepend($btn);

    if (!$btn.length) {
        $btn = $(`<div role="button" tabindex="0"></div>`);
        $bar.prepend($btn);
    }

    if ($btn.attr("class") !== desiredClass) $btn.attr("class", desiredClass);
    if ($btn.attr("title") !== state.title) $btn.attr("title", state.title);
    if ($btn.attr("data-ml-action") !== state.action) $btn.attr("data-ml-action", state.action);
    if ($btn.attr("data-ml-mesid") !== String(id)) $btn.attr("data-ml-mesid", String(id));
    if ($btn.attr("data-ml-icon") !== state.iconId) {
        $btn.attr("data-ml-icon", state.iconId).html(icon);
    }
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
            if (result?.ok) {
                const count = (result.entries?.length || 0) + (result.worldEntries?.length || 0);
                if (count > 0) {
                    toastr?.success?.(count + " entr" + (count === 1 ? "y" : "ies") + " ready for review.");
                } else {
                    toastr?.success?.("Scene scan complete — no new memories were needed.");
                }
            } else {
                toastr?.warning?.(`Scene closed, but ${result?.error || "memory generation failed"} You can retry it from Memory Loom Home.`);
            }
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
