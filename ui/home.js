import { captureChatGuard } from "../lib/chatGuard.js";
/** ui/home.js — Home tab */
import { isEnabled, isSidecarPaused, setSidecarPaused, getSetting } from "../settings.js";
import { renderHomeHeader, getProcessingStatus, showPanelLoading, hidePanelLoading, setProcessingStatus } from "./panel.js";
import { getPendingEntries, savePendingEntries, getOpenSceneId, getScenes, runChatTransaction, getMessageCounter, getSidecarPauseCadence } from "../data/storage.js";
import { getEntry, createEntry, deleteEntry, updateEntry } from "../data/entries.js";
import { chat } from "../../../../../script.js";
import { narrativeMessages } from "../lib/chatMessages.js";

/** Create one committed record inside an already-open chat transaction. */
function createCommittedRecord(e, oldWorldTargets) {
    // Committing means the entry becomes live, so force status to "active".
    // World pending entries carry status:"pending" from the writer.
    const clean = Object.assign({}, e, { status: "active" });
    if (clean.updateTargetId) {
        const target = getEntry(clean.updateTargetId);
        if (target) {
            oldWorldTargets.push(target);
            deleteEntry(clean.updateTargetId);
        }
        delete clean.updateTargetId;
    }
    const next = createEntry(clean);
    if (!next) throw new Error(`Memory entry creation returned no result for "${e?.title || "Untitled"}".`);
    return next;
}

/** Atomically commit one pending entry and remove its review card. */
function commitPendingEntry(e) {
    const oldWorldTargets = [];
    const created = runChatTransaction(() => {
        if (findPendingIndex(e) < 0) throw new Error("Pending memory changed before it could be committed.");
        const next = createCommittedRecord(e, oldWorldTargets);
        if (!removePending(e)) throw new Error("Committed memory could not be removed from the pending queue.");
        return next;
    });
    cleanupSupersededWorldVectors(oldWorldTargets);
    return created;
}

function cleanupSupersededWorldVectors(entries) {
    for (const entry of entries) {
        deleteEntryVector(entry).catch(err => console.warn("[ML] World update: old vector delete failed:", err));
    }
}
import { embedEntry, deleteEntryVector } from "../embed/embedder.js";
import { autoTagEntry, entryNeedsAutoTags } from "../llm/autoTag.js";
import { regenerateEntry, generateMemoryEntries, runWriterFlow } from "../llm/writer.js";
import { iconSvg } from "../lib/icons.js";
const NS = ".ml-home";

// ─── Sidecar Cadence Display ─────────────────────────────

let _sidecarScanRunning = false;

/**
 * Refresh the quiet Home-tab cadence indicator. This intentionally mirrors the
 * NWST/RST status language and layout so all three extensions expose the same
 * "next scan in N messages" contract.
 */
export function refreshSidecarCadenceDisplay(liveCountOverride = null) {
    const $row = $("#ml-sidecar-cadence");
    const $text = $("#ml-sidecar-cadence-text");
    if (!$row.length || !$text.length) return;

    const enabled = isEnabled();
    const paused = isSidecarPaused();
    const frequency = Math.max(1, Number(getSetting("scanFrequency", 1)) || 1);
    const parsedLiveCount = Number(liveCountOverride);
    const liveCount = liveCountOverride !== null && liveCountOverride !== undefined && Number.isFinite(parsedLiveCount) && parsedLiveCount >= 0
        ? Math.floor(parsedLiveCount)
        : (Array.isArray(chat) ? narrativeMessages(chat).length : 0);
    const lastBaseline = Math.max(0, Number(getMessageCounter()) || 0);
    const pauseSnapshot = paused ? getSidecarPauseCadence() : null;
    const cadenceLiveCount = pauseSnapshot ? pauseSnapshot.liveCount : liveCount;
    const cadenceBaseline = pauseSnapshot ? pauseSnapshot.baseline : lastBaseline;
    const sinceBaseline = Math.max(0, cadenceLiveCount - Math.min(cadenceBaseline, cadenceLiveCount));
    const nextIn = Math.max(0, frequency - sinceBaseline);

    let status = "ready";
    let label = "";
    if (!enabled) {
        status = "disabled";
        label = "Sidecar disabled.";
    } else if (paused) {
        status = "paused";
        label = "Sidecar paused.";
    } else if (_sidecarScanRunning) {
        status = "scanning";
        label = "Sidecar scan running…";
    } else if (nextIn === 0) {
        status = "due";
        label = "Sidecar ready · scan due";
    } else {
        label = `Sidecar ready · next scan in ${nextIn} message${nextIn === 1 ? "" : "s"}`;
    }

    $row.attr("data-status", status);
    $text.text(label);
    $row.attr("title", `Cadence counts narrative chat messages. ${sinceBaseline}/${frequency} messages since the current baseline.`);
}

export function setSidecarCadenceRunning(running) {
    _sidecarScanRunning = Boolean(running);
    refreshSidecarCadenceDisplay();
}

if (typeof document !== "undefined" && typeof globalThis.$ === "function") {
    globalThis.$(document).on("ml:refresh-sidecar-cadence", () => refreshSidecarCadenceDisplay());
}

/** Normalize legacy/imported object maps and current arrays at the UI boundary. */
function pendingList(value = getPendingEntries()) {
    if (!value) return [];
    return Array.isArray(value) ? value : Object.values(value);
}

function savePendingList(value) {
    const list = pendingList(value).filter(Boolean);
    savePendingEntries(list.length ? list : null);
}

function pendingFingerprint(entry) {
    if (!entry || typeof entry !== "object") return String(entry);
    return JSON.stringify([
        entry.sceneId || "",
        entry.category || "character",
        entry.updateTargetId || "",
        entry.title || "",
        entry.datetime || "",
        entry.content || "",
        entry.primaryCharacter || "",
        entry.primaryCharacters || [],
        entry.keyCharacters || [],
    ]);
}

function findPendingIndex(entry, value = getPendingEntries()) {
    const list = pendingList(value);
    const direct = list.indexOf(entry);
    if (direct >= 0) return direct;
    const fingerprint = pendingFingerprint(entry);
    return list.findIndex(candidate => pendingFingerprint(candidate) === fingerprint);
}

function discardPendingSnapshot(snapshot) {
    const remaining = [...pendingList()];
    let removed = 0;
    for (const entry of pendingList(snapshot)) {
        const index = findPendingIndex(entry, remaining);
        if (index < 0) continue;
        remaining.splice(index, 1);
        removed++;
    }
    savePendingList(remaining);
    return removed;
}

function commitPendingSnapshot(snapshot, options = {}) {
    const candidates = pendingList(snapshot);
    const assertCurrent = options.assertCurrent || (() => {});
    const onProgress = options.onProgress || (() => {});
    if (!candidates.length) return { committed: 0, failed: 0, skipped: 0, total: 0, created: [] };

    // Resolve every snapshot record against the current queue before writing
    // anything. The JavaScript thread cannot interleave another card action
    // during the synchronous transaction below.
    const remaining = [...pendingList()];
    const resolved = [];
    for (const candidate of candidates) {
        const matchIndex = findPendingIndex(candidate, remaining);
        if (matchIndex < 0) {
            throw new Error(`Pending memory changed before Commit All: "${candidate?.title || "Untitled"}".`);
        }
        resolved.push(remaining[matchIndex]);
        remaining.splice(matchIndex, 1);
    }

    const oldWorldTargets = [];
    const created = runChatTransaction(() => {
        assertCurrent();
        const committedEntries = [];
        for (let index = 0; index < resolved.length; index++) {
            onProgress(index, resolved.length, resolved[index]);
            committedEntries.push(createCommittedRecord(resolved[index], oldWorldTargets));
        }
        const removed = discardPendingSnapshot(resolved);
        if (removed !== resolved.length) {
            throw new Error(`Commit All removed ${removed}/${resolved.length} pending cards; transaction rolled back.`);
        }
        return committedEntries;
    });

    cleanupSupersededWorldVectors(oldWorldTargets);
    return { committed: created.length, failed: 0, skipped: 0, total: candidates.length, created };
}

async function finalizeCommittedEntry(entry) {
    const assertChat = captureChatGuard();
    const result = {
        entryId: entry?.id || null,
        title: entry?.title || "Untitled",
        tagAttempted: false,
        tagFailed: false,
        embedFailed: false,
    };
    if (!entry) {
        result.embedFailed = true;
        return result;
    }

    result.tagAttempted = getSetting("memoryWriting.autoTagOnCommit", false) && entryNeedsAutoTags(entry);
    if (result.tagAttempted) {
        try {
            const tagged = await autoTagEntry(entry) || entry;
            result.tagFailed = entryNeedsAutoTags(tagged);
        } catch (err) {
            if (err?.name === "MLStaleChatError") throw err;
            console.warn("[ML] Auto-tag on commit failed:", err);
            result.tagFailed = true;
        }
    }

    assertChat();
    const current = getEntry(entry.id);
    if (!current) {
        result.embedFailed = true;
        return result;
    }
    try { result.embedFailed = !(await embedEntry(current)); }
    catch (err) {
        if (err?.name === "MLStaleChatError") throw err;
        console.warn("[ML] Embed failed:", err);
        result.embedFailed = true;
    }
    assertChat();

    return result;
}

async function finalizeCommittedEntries(entries, options = {}) {
    const assertCurrent = options.assertCurrent || (() => {});
    const onProgress = options.onProgress || (() => {});
    const results = [];
    const list = Array.isArray(entries) ? entries : [];
    for (let index = 0; index < list.length; index++) {
        assertCurrent();
        onProgress(index, list.length, list[index]);
        results.push(await finalizeCommittedEntry(list[index]));
    }
    assertCurrent();
    return results;
}

function getSceneDisplayNum(sceneId) {
    const scenes = getScenes() || [];
    const idx = scenes.findIndex(function(s) { return s.id === sceneId; });
    return idx !== -1 ? String(idx + 1) : sceneId.replace("ml_scene_", "");
}

export function renderHomeTab($pane) {
    const assertChat = captureChatGuard();
    $(document).off(NS); $pane.empty(); renderHomeHeader($pane);
    $pane.append('<hr class="ml-rule">'); renderSidecarRow($pane);
    $pane.append('<hr class="ml-rule">'); renderWriterStatus($pane); renderPendingSection($pane);
}
function renderSidecarRow($pane) {
    const paused = isSidecarPaused();
    const $row = $(`<div class="ml-control-row" style="border-bottom:none"><div><div class="ml-control-label">Keyword sidecar</div><div id="ml-sidecar-status" class="ml-control-sub">${paused?"Paused · retrieval suspended":"Automatic memory retrieval"}</div></div><button id="ml-sidecar-btn" class="ml-btn">${paused?"Resume":"Pause"}</button></div>`);
    $(document).on("click"+NS, "#ml-sidecar-btn", () => { setSidecarPaused(!isSidecarPaused()); renderHomeTab($pane.closest(".ml-pane")); });
    $pane.append($row);
    $pane.append(`<div class="ml-sidecar-cadence" id="ml-sidecar-cadence" data-status="ready" title="Sidecar cadence status"><span class="ml-sidecar-cadence-dot">●</span><span id="ml-sidecar-cadence-text">Sidecar cadence status unavailable.</span></div>`);
    refreshSidecarCadenceDisplay();
}
function renderWriterStatus($pane) {
    // Persistent processing banner — mirrors the pending-entries banner so
    // long operations (scene close, batch scan) are visible on Home itself
    const proc = getProcessingStatus();
    if (proc) $pane.append(`<div class="ml-writer-active" id="ml-processing-banner"><div class="ml-pulse"></div><span class="ml-proc-text">${h(proc)}</span></div>`);
    const failedScene = (getScenes() || [])
        .filter(scene => (scene?.generation && (["failed", "partial"].includes(scene.generation.status) ||
                (!proc && scene.generation.status === "running"))) ||
            (scene?.status === "closed" && !scene.llmSummary))
        .sort((a, b) => (b.generation?.updatedAt || b.createdAt || 0) - (a.generation?.updatedAt || a.createdAt || 0))[0];
    if (failedScene) {
        const error = failedScene.generation?.error || "This scene closed before its summary and memories were generated.";
        const $failure = $(`<div class="ml-writer-active ml-writer-failed" style="display:flex;align-items:center;gap:10px">
            <div style="flex:1;min-width:0"><div style="color:#d9a6a6">Scene ${h(getSceneDisplayNum(failedScene.id))} needs attention</div><div style="font-size:11px;color:#888;margin-top:2px">${h(error)} Successful stages will not be repeated.</div></div>
            <button class="ml-btn" id="ml-retry-scene-generation" data-scene-id="${h(failedScene.id)}">Retry</button>
        </div>`);
        $failure.find("#ml-retry-scene-generation").on("click", async function () {
            const sceneId = $(this).attr("data-scene-id");
            const $button = $(this).prop("disabled", true).text("Retrying…");
            const label = `Retrying memory generation for Scene ${getSceneDisplayNum(sceneId)}...`;
            showPanelLoading(label);
            setProcessingStatus(label);
            try {
                const result = await runWriterFlow(sceneId, { retry: true });
                if (result?.ok) {
                    const count = (result.entries?.length || 0) + (result.worldEntries?.length || 0);
                    toastr?.success?.(count > 0
                        ? `${count} ${count === 1 ? "entry" : "entries"} ready for review.`
                        : "Scene generation completed — no additional memories were needed.", "Memory Loom");
                } else {
                    toastr?.error?.(result?.error || "Scene generation retry failed.", "Memory Loom");
                }
            } catch (err) {
                console.error("[ML] Scene generation retry failed:", err);
                toastr?.error?.("Scene generation retry was cancelled or failed.", "Memory Loom");
            } finally {
                hidePanelLoading();
                setProcessingStatus(null);
                $button.prop("disabled", false).text("Retry");
                renderHomeTab($pane);
            }
        });
        $pane.append($failure);
    }
    const oid = getOpenSceneId(), p = getPendingEntries(), hp = p && (Array.isArray(p)?p.length>0:Object.keys(p).length>0);
    if (oid && !hp) $pane.append('<div class="ml-writer-active"><div class="ml-pulse"></div>Memory writer active · Scene open</div>');
    else if (hp) $pane.append('<div class="ml-writer-active"><div class="ml-pulse"></div>Memory writer complete · pending entries ready</div>');
}
function renderPendingSection($pane) {
    const pl = pendingList();
    if (!pl.length) { $pane.append('<div style="padding:20px 0;text-align:center;color:#666;font-family:\'IBM Plex Mono\',monospace;font-size:12px">No pending entries.<br><span style="font-size:11px;color:#555">Close a scene to generate memory entries.</span></div>'); return; }
    $pane.append(`<div style="display:flex;align-items:center;gap:9px;margin-bottom:12px"><span class="ml-lbl" style="margin-bottom:0">Pending entries</span><span class="ml-pending-badge">${pl.length} pending</span></div>`);
    // ── Split pending entries: World vs Character ────────
    // World memories are kept in their own clearly-divided section so they
    // never blend into the per-character groups. Every card keeps its ORIGINAL
    // index into the full pending list, so commit/discard/edit/regen are
    // untouched regardless of how we visually group.
    const charItems = [];   // [entry, originalIndex]
    const worldItems = [];
    pl.forEach((e, i) => {
        if ((e.category || "character") === "world") worldItems.push([e, i]);
        else charItems.push([e, i]);
    });

    // Character section — grouped by character
    if (charItems.length > 0) {
        const groups = new Map();
        charItems.forEach(([e, i]) => {
            const key = (e.primaryCharacter || (e.primaryCharacters || []).join(", ") || "Unassigned").trim() || "Unassigned";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push([e, i]);
        });
        $pane.append(`<div class="ml-pending-section-label">Character memories</div>`);
        if (groups.size <= 1) {
            charItems.forEach(([e, i]) => $pane.append(renderCard(e, i, $pane)));
        } else {
            const startOpen = charItems.length <= 8;
            for (const [charName, items] of groups) {
                const $grp = $(`
                    <div class="ml-pending-group${startOpen ? " open" : ""}">
                        <div class="ml-pending-group-hdr">
                            ${iconSvg("ico-chevron-down", 14, 14, "#666")}
                            <span class="ml-pending-group-name">${h(charName)}</span>
                            <span class="ml-pending-badge">${items.length}</span>
                        </div>
                        <div class="ml-pending-group-body"></div>
                    </div>
                `);
                const $gb = $grp.find(".ml-pending-group-body");
                items.forEach(([e, i]) => $gb.append(renderCard(e, i, $pane)));
                $grp.find(".ml-pending-group-hdr").on("click", function () { $grp.toggleClass("open"); });
                $pane.append($grp);
            }
        }
    }

    // Divider + World section
    if (worldItems.length > 0) {
        $pane.append(`<div class="ml-pending-divider"></div>`);
        $pane.append(`<div class="ml-pending-section-label ml-pending-world-label">${iconSvg("ico-globe", 13, 13, "#9fb0c4")} World memories <span class="ml-pending-badge">${worldItems.length}</span></div>`);
        worldItems.forEach(([e, i]) => $pane.append(renderCard(e, i, $pane)));
    }
    const $ga = $('<div class="ml-btn-row" style="margin-top:11px"><button type="button" class="ml-btn-confirm" id="ml-commit-all" style="font-size:12px;padding:7px 18px">Commit all</button><button type="button" class="ml-btn-danger" id="ml-discard-all">Discard all</button></div>');
    $ga.find("#ml-commit-all").on("click", async function (event) {
        event.preventDefault();
        event.stopPropagation();
        const assertCurrent = captureChatGuard();
        const $button = $(this).prop("disabled", true).text("Committing…");
        const initialCount = pendingList().length;
        let committedResult = null;
        try {
            if (!await popup(`Commit all ${initialCount} entries?`)) return;
            assertCurrent();
            // Capture after confirmation. Capturing before the asynchronous popup
            // created a stale window in which an edited/regenerated card could be
            // silently skipped by the bulk loop.
            const snapshot = [...pendingList()];
            if (!snapshot.length) {
                toastr?.info?.("No pending memories remain to commit.", "Memory Loom");
                renderHomeTab($pane);
                return;
            }
            // This is one synchronous transaction: either every reviewed card is
            // committed and removed, or the entire queue is restored.
            committedResult = commitPendingSnapshot(snapshot, {
                assertCurrent,
                onProgress(index, total) {
                    $button.text(`${index + 1}/${total}`);
                },
            });
            assertCurrent();
            const prepMessage = `Preparing committed memories… 0/${committedResult.committed}`;
            showPanelLoading(prepMessage);
            setProcessingStatus(prepMessage);
            // Remove the review cards immediately. Optional LLM/vector work is
            // post-processing and can no longer strand part of the queue.
            renderHomeTab($pane);
            toastr?.success?.(`Committed ${committedResult.committed} ${committedResult.committed === 1 ? "memory" : "memories"}.`, "Memory Loom");

            const prepared = await finalizeCommittedEntries(committedResult.created, {
                assertCurrent,
                onProgress(index, total) {
                    const msg = `Preparing committed memories… ${index + 1}/${total}`;
                    showPanelLoading(msg);
                    setProcessingStatus(msg);
                },
            });
            const tagFailures = prepared.filter(item => item.tagFailed);
            const embedFailures = prepared.filter(item => item.embedFailed);
            if (tagFailures.length || embedFailures.length) {
                const affected = [...new Set([...tagFailures, ...embedFailures].map(item => item.title))];
                const names = affected.slice(0, 4).join("; ") + (affected.length > 4 ? "; …" : "");
                toastr?.warning?.(`The memories were committed, but optional preparation failed for ${affected.length}: ${names}. You can Auto-Tag or Re-embed them later.`, "Memory Loom", { timeOut: 9000 });
            }
        } catch (error) {
            if (committedResult) {
                console.warn("[ML] Post-processing committed memories stopped:", error);
                toastr?.warning?.(error?.name === "MLStaleChatError"
                    ? "The memories were committed; optional preparation stopped because the active chat changed."
                    : "The memories were committed, but optional preparation did not finish. You can Auto-Tag or Re-embed them later.", "Memory Loom");
            } else {
                console.error("[ML] Commit all failed:", error);
                toastr?.error?.(error?.name === "MLStaleChatError"
                    ? "Commit all was cancelled because the active chat changed."
                    : "Could not commit pending memories. All reviewed cards remain pending.", "Memory Loom");
            }
        } finally {
            hidePanelLoading();
            setProcessingStatus(null);
            $button.prop("disabled", false).text("Commit all");
            if (committedResult) {
                try { assertCurrent(); renderHomeTab($pane); } catch { /* new chat owns its own UI */ }
            }
        }
    });
    $ga.find("#ml-discard-all").on("click", async function (event) {
        event.preventDefault();
        event.stopPropagation();
        const assertCurrent = captureChatGuard();
        const snapshot = pendingList();
        const $button = $(this).prop("disabled", true);
        try {
            if (!await popup("Discard all pending entries?")) return;
            assertCurrent();
            const removed = discardPendingSnapshot(snapshot);
            renderHomeTab($pane);
            toastr?.success?.(`Discarded ${removed} pending ${removed === 1 ? "entry" : "entries"}.`, "Memory Loom");
        } catch (error) {
            console.error("[ML] Discard all failed:", error);
            toastr?.error?.("Could not discard pending memories. Check the console.", "Memory Loom");
        } finally {
            $button.prop("disabled", false);
        }
    });
    $pane.append($ga);
}
function renderCard(entry,i,$pane) {
    const assertChat = captureChatGuard();
    const lo = entry.delta?.low_delta_flag;
    const $c = $(`<div class="ml-entry-card" id="ml-pc-${i}"><div class="ml-entry-card-hdr"><div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;flex-wrap:wrap"><div class="ml-entry-title" style="margin-bottom:0">${h(entry.title||"Untitled")}</div>${entry.updateTargetId?'<span class="ml-update-badge">✎ updates existing</span>':''}${lo?'<span class="ml-delta-flag">low delta</span>':''}</div><div class="ml-entry-meta">${entry.category==="world" ? (entry.updateTargetId ? "\ud83c\udf10 World update" : (entry.worldEvent ? "\ud83c\udf10 World event" : "\ud83c\udf10 World fact")) : (h(entry.primaryCharacter||(entry.primaryCharacters||[]).join(", ")||"Unknown")+" · "+h(entry.category||"character"))}${entry.sceneId?' · Scene '+getSceneDisplayNum(entry.sceneId):''}</div></div>${iconSvg("ico-chevron-down",16,16,"#666")}</div><div class="ml-entry-card-body">${entry.updateTargetId?`<div class="ml-update-note">Replaces existing entry: ${h((getEntry(entry.updateTargetId)||{}).title||entry.updateTargetId)}</div>`:''}<div class="ml-entry-prose">${h(entry.content||"")}</div><div class="ml-entry-chars">${entry.category!=="world" && entry.primaryCharacter?`<span>Primary</span> · ${h(entry.primaryCharacter)}<br>`:''}${entry.keyCharacters?.length?`<span>Key</span> · ${h(entry.keyCharacters.join(", "))}`:''}</div>${db(entry)}<div class="ml-btn-row"><button type="button" class="ml-btn-confirm ml-co" data-idx="${i}">Commit</button><button type="button" class="ml-btn ml-rt" data-idx="${i}">Regen</button><button type="button" class="ml-btn ml-ee" data-idx="${i}">Edit</button><button type="button" class="ml-btn-danger ml-do" data-idx="${i}">Discard</button></div><div class="ml-regen-box" id="ml-rg-${i}"><div class="ml-field-hdr"><div class="ml-regen-hint" style="margin-bottom:0">Optional guidance</div><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-ri-${i}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i></div><textarea id="ml-ri-${i}" rows="2" style="margin-bottom:8px" placeholder="Guidance…"></textarea><div class="ml-btn-row"><button type="button" class="ml-btn ml-rg" data-idx="${i}">Regen with prompt</button><button type="button" class="ml-btn ml-rs" data-idx="${i}">Regen from scene</button></div></div></div></div>`);
    $c.find(".ml-entry-card-hdr").on("click",function(){$c.toggleClass("open")});
    $(document).on("click"+NS,`#ml-pc-${i} .ml-co`,async()=>{
        const plist=pendingList();
        if(i<0||i>=plist.length)return;
        const $btn = $(`#ml-pc-${i} .ml-co`);
        $btn.prop("disabled", true).text("Committing…");
        let created = null;
        try {
            assertChat();
            if (plist[i] !== entry) return;
            created = commitPendingEntry(entry);
            const prepMessage = "Preparing committed memory…";
            showPanelLoading(prepMessage);
            setProcessingStatus(prepMessage);
            renderHomeTab($pane);
            toastr?.success?.("Memory committed.", "Memory Loom");

            const prepared = await finalizeCommittedEntry(created);
            assertChat();
            if (prepared.tagFailed || prepared.embedFailed) {
                toastr?.warning?.("The memory was committed, but optional preparation did not finish. You can Auto-Tag or Re-embed it later.", "Memory Loom");
            }
        } catch(err) {
            if (created) {
                console.warn("[ML] Post-processing committed memory stopped:", err);
                toastr?.warning?.(err?.name === "MLStaleChatError"
                    ? "The memory was committed; optional preparation stopped because the active chat changed."
                    : "The memory was committed, but optional preparation did not finish.", "Memory Loom");
            } else {
                console.error("[ML] Commit failed:", err);
                toastr?.error?.("Commit failed. The review card remains pending.", "Memory Loom");
                $btn.prop("disabled", false).text("Commit");
            }
        } finally {
            hidePanelLoading();
            setProcessingStatus(null);
            if (created) {
                try { assertChat(); renderHomeTab($pane); } catch { /* new chat owns its own UI */ }
            }
        }
    });
    $(document).on("click"+NS,`#ml-pc-${i} .ml-do`,async()=>{const ok=await popup("Discard this entry?");if(!ok)return;assertChat();const plist=pendingList();if(i<0||i>=plist.length)return;if(plist[i]!==entry)return;removePending(entry);renderHomeTab($pane)});
    $(document).on("click"+NS,`#ml-pc-${i} .ml-rt`,()=>{$(`#ml-rg-${i}`).toggleClass("open")});
    // Edit entry — replace static prose with editable fields inline
    $(document).on("click"+NS,`#ml-pc-${i} .ml-ee`,()=>{
        const $card = $(`#ml-pc-${i}`);
        $card.addClass("open");
        if ($card.find(".ml-edit-form").length) return; // already open
        const plist=pendingList();
        if(i<0||i>=plist.length)return;
        const e = plist[i];
        const $prose = $card.find(".ml-entry-prose");
        const $editForm = $(`
            <div class="ml-edit-form" style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
                <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.06em">Editing entry</div>
                ${e.category==="world" ? "" : `
                <div class="ml-field-row"><span class="ml-fh">Primary character</span><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-edit-primary-${i}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer"></i></div>
                <textarea class="ml-edit-primary ml-edit-mini" id="ml-edit-primary-${i}" rows="1" placeholder="Who this memory belongs to (comma-separate for a joint memory)">${h(e.primaryCharacter||(e.primaryCharacters||[]).join(', ')||'')}</textarea>`}
                <div class="ml-field-row"><span class="ml-fh">Title</span><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-edit-title-${i}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer"></i></div>
                <textarea class="ml-edit-title ml-edit-mini" id="ml-edit-title-${i}" rows="1">${h(e.title||'')}</textarea>
                <div class="ml-field-row"><span class="ml-fh">Date / Time</span><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-edit-datetime-${i}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer"></i></div>
                <textarea class="ml-edit-datetime ml-edit-mini" id="ml-edit-datetime-${i}" rows="1">${h(e.datetime||'')}</textarea>
                <div class="ml-field-row"><span class="ml-fh">Narrative</span><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-edit-narrative-${i}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer"></i></div>
                <textarea class="ml-edit-narrative" id="ml-edit-narrative-${i}" rows="6">${h(e.content||'')}</textarea>
                <div class="ml-field-row"><span class="ml-fh">Before</span><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-edit-before-${i}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer"></i></div>
                <textarea class="ml-edit-before ml-edit-mini" id="ml-edit-before-${i}" rows="2">${h(e.delta?.before_state||'')}</textarea>
                <div class="ml-field-row"><span class="ml-fh">After</span><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-edit-after-${i}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer"></i></div>
                <textarea class="ml-edit-after ml-edit-mini" id="ml-edit-after-${i}" rows="2">${h(e.delta?.after_state||'')}</textarea>
                <div class="ml-field-row"><span class="ml-fh">Delta</span><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-edit-delta-${i}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer"></i></div>
                <textarea class="ml-edit-delta ml-edit-mini" id="ml-edit-delta-${i}" rows="2">${h(e.delta?.delta||'')}</textarea>
                <button class="ml-btn ml-toggle-keychar" style="align-self:flex-start;font-size:11px">${(e.keyCharacters&&e.keyCharacters.length)?'Edit key characters':'+ Add key characters'}</button>
                <div class="ml-keychar-row" style="display:${(e.keyCharacters&&e.keyCharacters.length)?'flex':'none'};flex-direction:column;gap:4px">
                    <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#666">Key characters (comma-separated)</div>
                    <textarea class="ml-edit-keychar ml-edit-mini" rows="1" placeholder="Other participants">${h((e.keyCharacters||[]).join(', '))}</textarea>
                </div>
                <div class="ml-btn-row" style="margin-top:4px">
                    <button class="ml-btn-confirm ml-save-edit">Save edits</button>
                    <button class="ml-btn ml-cancel-edit">Cancel</button>
                </div>
            </div>
        `);
        $prose.after($editForm);
        $prose.hide();
        $editForm.find(".ml-toggle-keychar").on("click", function() {
            const $row = $editForm.find(".ml-keychar-row");
            $row.css("display", $row.css("display") === "none" ? "flex" : "none");
        });
        $editForm.find(".ml-save-edit").on("click", () => {
            const keyRaw = $editForm.find(".ml-edit-keychar").val() || "";
            const updated = Object.assign({}, plist[i], {
                title:          $editForm.find(".ml-edit-title").val().trim(),
                datetime:       $editForm.find(".ml-edit-datetime").val().trim(),
                content:        $editForm.find(".ml-edit-narrative").val().trim(),
                primaryCharacter: e.category==="world" ? "" : ($editForm.find(".ml-edit-primary").val()||"").trim(),
                keyCharacters:  keyRaw.split(",").map(s => s.trim()).filter(Boolean),
                delta: Object.assign({}, plist[i].delta || {}, {
                    before_state: $editForm.find(".ml-edit-before").val().trim(),
                    after_state:  $editForm.find(".ml-edit-after").val().trim(),
                    delta:        $editForm.find(".ml-edit-delta").val().trim(),
                }),
            });
            // comma-separated input = joint memory (multi-primary)
            const _prims = updated.primaryCharacter.split(",").map(s => s.trim()).filter(Boolean);
            updated.primaryCharacters = _prims;
            updated.primaryCharacter = _prims.length === 1 ? _prims[0] : "";
            plist[i] = updated;
            savePendingEntries(plist);
            toastr?.success?.("Entry updated.");
            renderHomeTab($pane);
        });
        $editForm.find(".ml-cancel-edit").on("click", () => {
            $editForm.remove(); $prose.show();
        });
    });
    $(document).on("click"+NS,`#ml-pc-${i} .ml-rg`,async ()=>{
        const guidance = $(`#ml-ri-${i}`).val()?.trim() || "";
        const plist=pendingList();
        if(i<0||i>=plist.length)return;
        toastr?.info?.("Regenerating entry...");
        const snapshot = JSON.stringify(plist[i]);
        const newEntry = await regenerateEntry(plist[i], guidance);
        assertChat();
        if (findPendingIndex(entry) < 0 || JSON.stringify(entry) !== snapshot) return;
        if (newEntry) { if (plist[i].updateTargetId) newEntry.updateTargetId = plist[i].updateTargetId; const current = pendingList(); const currentIndex = findPendingIndex(entry, current); if (currentIndex < 0) return; current[currentIndex] = newEntry; savePendingList(current); renderHomeTab($pane); toastr?.success?.("Entry regenerated."); }
        else { toastr?.error?.("Regeneration failed. Check LLM connection."); }
    });
    $(document).on("click"+NS,`#ml-pc-${i} .ml-rs`,async ()=>{
        const plist=pendingList();
        if(i<0||i>=plist.length)return;
        const sceneId = plist[i].sceneId;
        if (!sceneId) { toastr?.warning?.("No scene associated with this entry."); return; }
        toastr?.info?.("Regenerating from scene...");
        const entries = await generateMemoryEntries(sceneId);
        if (entries && entries.length > 0) { renderHomeTab($pane); toastr?.success?.(`${entries.length} entries regenerated.`); }
        else { toastr?.error?.("Regeneration failed. Check LLM connection."); }
    });
    return $c;
}
function db(entry){const d=entry.delta;if(!d||(!d.before_state&&!d.after_state&&!d.delta&&(!d.delta_type||!d.delta_type.length)))return"";let o=`<div style="background:#222;border:1px solid #3a3a3a;border-radius:4px;padding:10px 12px;margin-bottom:12px;font-size:12px;line-height:1.7"><div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#666;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:7px">Before / After delta</div>`;if(d.before_state)o+=`<div style="margin-bottom:5px"><span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#888">Before</span><br>${h(d.before_state)}</div>`;if(d.after_state)o+=`<div style="margin-bottom:5px"><span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#888">After</span><br>${h(d.after_state)}</div>`;if(d.delta)o+=`<div style="margin-bottom:7px"><span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#888">Delta</span><br>${h(d.delta)}</div>`;if(d.delta_type?.length){o+='<div style="display:flex;gap:5px;flex-wrap:wrap">';for(const t of d.delta_type)o+=`<span class="ml-tag">${h(t)}</span>`;o+='</div>'}return o+'</div>'}
function h(s){if(!s)return"";const d=document.createElement("div");d.textContent=s;return d.innerHTML}
async function popup(msg){
    try {
        const ctx=window.SillyTavern?.getContext();
        if(ctx?.callGenericPopup){
            const result = await ctx.callGenericPopup(msg,ctx.POPUP_TYPE?.CONFIRM||"confirm","");
            return result === true || result === 1 || result === ctx.POPUP_RESULT?.AFFIRMATIVE;
        }
    } catch(e) {
        console.warn("[ML] Confirmation popup failed; using browser confirmation:", e);
    }
    return confirm(msg) === true;
}

function removePending(entry) {
    const current = pendingList();
    const index = findPendingIndex(entry, current);
    if (index < 0) return false;
    current.splice(index, 1);
    savePendingList(current);
    return true;
}
