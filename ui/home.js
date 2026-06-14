/** ui/home.js — Home tab */
import { isEnabled, isSidecarPaused, setSidecarPaused, getSetting } from "../settings.js";
import { renderHomeHeader, getProcessingStatus } from "./panel.js";
import { getPendingEntries, savePendingEntries, getOpenSceneId, getScenes } from "../data/storage.js";
import { getEntry, createEntry, deleteEntry, updateEntry } from "../data/entries.js";

/**
 * Commit one pending entry to the library. If it's a world UPDATE (carries
 * updateTargetId), the existing target entry is deleted first so the revision
 * replaces it cleanly. Returns the created entry.
 */
function commitPendingEntry(e) {
    if (e && e.updateTargetId) {
        try {
            const target = getEntry(e.updateTargetId);
            if (target) deleteEntry(e.updateTargetId);
        } catch (err) { console.error("[ML] World update: target removal failed:", err); }
        // strip the marker so it commits as a normal world entry
        const clean = Object.assign({}, e);
        delete clean.updateTargetId;
        return createEntry(clean);
    }
    return createEntry(e);
}
import { embedEntry } from "../embed/embedder.js";
import { regenerateEntry, generateMemoryEntries } from "../llm/writer.js";
import { iconSvg } from "../lib/icons.js";
const NS = ".ml-home";

function getSceneDisplayNum(sceneId) {
    const scenes = getScenes() || [];
    const idx = scenes.findIndex(function(s) { return s.id === sceneId; });
    return idx !== -1 ? String(idx + 1) : sceneId.replace("ml_scene_", "");
}

export function renderHomeTab($pane) {
    $(document).off(NS); $pane.empty(); renderHomeHeader($pane);
    $pane.append('<hr class="ml-rule">'); renderSidecarRow($pane);
    $pane.append('<hr class="ml-rule">'); renderWriterStatus($pane); renderPendingSection($pane);
}
function renderSidecarRow($pane) {
    const paused = isSidecarPaused();
    const $row = $(`<div class="ml-control-row" style="border-bottom:none"><div><div class="ml-control-label">Keyword sidecar</div><div id="ml-sidecar-status" class="ml-control-sub">${paused?"Paused · injections suspended":"Running · every message"}</div></div><button id="ml-sidecar-btn" class="ml-btn">${paused?"Resume":"Pause"}</button></div>`);
    $(document).on("click"+NS, "#ml-sidecar-btn", () => { setSidecarPaused(!isSidecarPaused()); renderHomeTab($pane.closest(".ml-pane")); });
    $pane.append($row);
}
function renderWriterStatus($pane) {
    // Persistent processing banner — mirrors the pending-entries banner so
    // long operations (scene close, batch scan) are visible on Home itself
    const proc = getProcessingStatus();
    if (proc) $pane.append(`<div class="ml-writer-active" id="ml-processing-banner"><div class="ml-pulse"></div><span class="ml-proc-text">${h(proc)}</span></div>`);
    const oid = getOpenSceneId(), p = getPendingEntries(), hp = p && (Array.isArray(p)?p.length>0:Object.keys(p).length>0);
    if (oid && !hp) $pane.append('<div class="ml-writer-active"><div class="ml-pulse"></div>Memory writer active · Scene open</div>');
    else if (hp) $pane.append('<div class="ml-writer-active"><div class="ml-pulse"></div>Memory writer complete · pending entries ready</div>');
}
function renderPendingSection($pane) {
    const p = getPendingEntries(), pl = p ? (Array.isArray(p)?p:Object.values(p)) : [];
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
    const $ga = $('<div class="ml-btn-row" style="margin-top:11px"><button class="ml-btn-confirm" id="ml-commit-all" style="font-size:12px;padding:7px 18px">Commit all</button><button class="ml-btn-danger" id="ml-discard-all">Discard all</button></div>');
    $(document).on("click"+NS, "#ml-commit-all", async () => { const ok = await popup(`Commit all ${pl.length} entries?`); if(ok) { pl.forEach(e => { try{ const created = commitPendingEntry(e); embedEntry(created).catch(err => console.warn("[ML] Embed failed:", err)); }catch(err){console.error(err)} }); savePendingEntries(null); renderHomeTab($pane); }});
    $(document).on("click"+NS, "#ml-discard-all", async () => { const ok = await popup("Discard all pending entries?"); if(ok) { savePendingEntries(null); renderHomeTab($pane); }});
    $pane.append($ga);
}
function renderCard(entry,i,$pane) {
    const lo = entry.delta?.low_delta_flag;
    const $c = $(`<div class="ml-entry-card" id="ml-pc-${i}"><div class="ml-entry-card-hdr"><div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;flex-wrap:wrap"><div class="ml-entry-title" style="margin-bottom:0">${h(entry.title||"Untitled")}</div>${entry.updateTargetId?'<span class="ml-update-badge">✎ updates existing</span>':''}${lo?'<span class="ml-delta-flag">low delta</span>':''}</div><div class="ml-entry-meta">${entry.category==="world" ? (entry.updateTargetId ? "\ud83c\udf10 World update" : "\ud83c\udf10 World fact") : (h(entry.primaryCharacter||(entry.primaryCharacters||[]).join(", ")||"Unknown")+" · "+h(entry.category||"character"))}${entry.sceneId?' · Scene '+getSceneDisplayNum(entry.sceneId):''}</div></div>${iconSvg("ico-chevron-down",16,16,"#666")}</div><div class="ml-entry-card-body">${entry.updateTargetId?`<div class="ml-update-note">Replaces existing entry: ${h((getEntry(entry.updateTargetId)||{}).title||entry.updateTargetId)}</div>`:''}<div class="ml-entry-prose">${h(entry.content||"")}</div><div class="ml-entry-chars">${entry.category!=="world" && entry.primaryCharacter?`<span>Primary</span> · ${h(entry.primaryCharacter)}<br>`:''}${entry.keyCharacters?.length?`<span>Key</span> · ${h(entry.keyCharacters.join(", "))}`:''}</div>${db(entry)}<div class="ml-btn-row"><button class="ml-btn-confirm ml-co" data-idx="${i}">Commit</button><button class="ml-btn ml-rt" data-idx="${i}">Regen</button><button class="ml-btn ml-ee" data-idx="${i}">Edit</button><button class="ml-btn-danger ml-do" data-idx="${i}">Discard</button></div><div class="ml-regen-box" id="ml-rg-${i}"><div class="ml-field-hdr"><div class="ml-regen-hint" style="margin-bottom:0">Optional guidance</div><i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="ml-ri-${i}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i></div><textarea id="ml-ri-${i}" rows="2" style="margin-bottom:8px" placeholder="Guidance…"></textarea><div class="ml-btn-row"><button class="ml-btn ml-rg" data-idx="${i}">Regen with prompt</button><button class="ml-btn ml-rs" data-idx="${i}">Regen from scene</button></div></div></div></div>`);
    $c.find(".ml-entry-card-hdr").on("click",function(){$c.toggleClass("open")});
    $(document).on("click"+NS,`#ml-pc-${i} .ml-co`,()=>{const pl=getPendingEntries();const plist=pl?(Array.isArray(pl)?pl:Object.values(pl)):[];if(i<0||i>=plist.length)return;const created=commitPendingEntry(plist[i]);embedEntry(created).catch(err=>console.warn("[ML] Embed failed:",err));plist.splice(i,1);savePendingEntries(plist.length?plist:null);renderHomeTab($pane)});
    $(document).on("click"+NS,`#ml-pc-${i} .ml-do`,async()=>{const ok=await popup("Discard this entry?");if(!ok)return;const pl=getPendingEntries();const plist=pl?(Array.isArray(pl)?pl:Object.values(pl)):[];if(i<0||i>=plist.length)return;plist.splice(i,1);savePendingEntries(plist.length?plist:null);renderHomeTab($pane)});
    $(document).on("click"+NS,`#ml-pc-${i} .ml-rt`,()=>{$(`#ml-rg-${i}`).toggleClass("open")});
    // Edit entry — replace static prose with editable fields inline
    $(document).on("click"+NS,`#ml-pc-${i} .ml-ee`,()=>{
        const $card = $(`#ml-pc-${i}`);
        $card.addClass("open");
        if ($card.find(".ml-edit-form").length) return; // already open
        const pl=getPendingEntries(); const plist=pl?(Array.isArray(pl)?pl:Object.values(pl)):[];
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
        const pl=getPendingEntries(); const plist=pl?(Array.isArray(pl)?pl:Object.values(pl)):[];
        if(i<0||i>=plist.length)return;
        toastr?.info?.("Regenerating entry...");
        const newEntry = await regenerateEntry(plist[i], guidance);
        if (newEntry) { if (plist[i].updateTargetId) newEntry.updateTargetId = plist[i].updateTargetId; plist[i] = newEntry; savePendingEntries(plist); renderHomeTab($pane); toastr?.success?.("Entry regenerated."); }
        else { toastr?.error?.("Regeneration failed. Check LLM connection."); }
    });
    $(document).on("click"+NS,`#ml-pc-${i} .ml-rs`,async ()=>{
        const pl=getPendingEntries(); const plist=pl?(Array.isArray(pl)?pl:Object.values(pl)):[];
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
async function popup(msg){try{const ctx=window.SillyTavern?.getContext();if(ctx?.callGenericPopup){return await ctx.callGenericPopup(msg,ctx.POPUP_TYPE?.CONFIRM||"confirm","")}}catch(e){}return confirm(msg)}
