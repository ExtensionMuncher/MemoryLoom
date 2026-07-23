/**
 * llm/worldWriter.js — World memory generation
 *
 * World memories capture facts about the SETTING — organizations, locations,
 * power structures, world-state shifts, significant events as they affect the
 * world — NOT a character's personal experience. They are generated from a
 * closed scene, but under DELIBERATELY STRICTER criteria than character
 * memories: most scenes should produce ZERO world memories. The model is told
 * to reconcile against prior world entries and scene summaries so it only
 * records genuinely NEW or CHANGED world facts, never restating known lore.
 *
 * Kept entirely separate from the character writer so the two never tangle:
 * world pending entries carry category "world" and are reviewed in their own
 * section of the Home tab.
 */

import { makeRequest } from "./connections.js";
import { getScene, getPreviousSceneSummaries } from "../data/scenes.js";
import { getAllEntries } from "../data/entries.js";
import { getPendingEntries, savePendingEntries, getWorldScale } from "../data/storage.js";
import { getSetting } from "../settings.js";
import { getSceneMessages } from "./writer.js";
import { dlog } from "../lib/debug.js";

function getMaxResponseTokens() {
    const v = Number(getSetting("connections.maxResponseTokens", 8000));
    return (Number.isFinite(v) && v >= 500) ? v : 8000;
}

/** Pull existing world memories so the model can reconcile against known lore. */
function getKnownWorldFacts() {
    const all = getAllEntries()
        .filter(e => e.category === "world")
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    // Cap the list so a long backlog of known facts doesn't dominate the prompt
    // and push the model toward "everything's already known → nothing new".
    return all.slice(0, 12).map(e => `[id:${e.id}] ${e.title}: ${(e.content || "").slice(0, 180)}`);
}

function buildWorldSystemPrompt() {
    return `[MLWORLDv3] You write WORLDBUILDING LORE for a roleplay setting — the kind of entry that would appear in a setting bible or a wiki's "World" section, describing the fictional universe itself. You are NOT logging what happened in the story. You are NOT cataloguing characters. You are NOT recording who is doing what to whom this week.

THE SINGLE MOST IMPORTANT RULE:
A world memory must be a fact about the SETTING that would still be worth knowing even if you never read this particular story. If it only makes sense as "something that is happening in the plot right now" or "a detail about a specific person," it is NOT a world memory.

POV: third-person omniscient. Refer to everyone, including the player character, by name and he/she/they. Never "I/me/my/we/us". The player character MAY appear if a genuine world fact centers on them, but their personal situation is almost never world lore (see rejections below).

WHAT ACTUALLY QUALIFIES (be selective, but DO record these when present):
- The nature of a major faction/organization AS AN INSTITUTION: what the Ravenshade Syndicate IS, its place in the city's power structure, how the criminal underworld operates. NOT its current operations or roster.
- How the world's systems work: its rules, its supernatural/technological laws, its social order.
- The character of a significant, enduring LOCATION as a place in the world. NOT what happened there in a scene.

WORLD EVENTS — A SEPARATE, DISTINCT KIND OF ENTRY (read carefully):
Apart from static facts above, you must also watch for a WORLD EVENT: something that HAPPENS and changes the state of the SETTING for many people, not just the characters in the room. A world event has structural consequences that outlive the scene — the kind of thing that would get a dated entry in a setting's timeline or a history book.

CRUCIAL — JUDGE EVENTS RELATIVE TO THIS WORLD'S OWN SCALE:
Worlds differ enormously in size. Some span multiple dimensions and civilizations; some are a single prefecture with rival factions; some are as small as one town or one school. The user has described THIS world's scale in the context provided below (look for "WORLD SCALE"). You MUST judge events against that scale, not an absolute one:
- In a LARGE world (multiple realms, nations, great powers): only realm/nation/great-power-level events qualify. A single town's fire does not.
- In a MEDIUM world (a region, a city, competing factions): faction-level and city-level events qualify.
- In a SMALL world (a town, a school, a community): town-level and community-level events DO qualify — the school board dissolves, a fire guts the shopping district, the town floods, an institution that anchors the community collapses. Do NOT reject these for "not being faction-level" — in a town-scale world, the town IS the world.
What stays rejected AT EVERY SCALE is the INTERPERSONAL floor: two people falling out, a single person's fate, a private deal. Lowering the ceiling to meet a small world never lowers this floor.
If no WORLD SCALE is provided, infer it conservatively from the story, and lean toward treating community/town-level structural events as qualifying in an evidently small-scale setting.

A world event qualifies ONLY if it clears this bar (relative to the world's scale):
- It changes something at the structural level for that world — a faction, institution, community, region, population, or the world's rules — not a single relationship or a single person's circumstances.
- Its consequences persist and affect people beyond those present in the scene.
- A chronicler of THIS world would record it.

A SPECIAL TOP-TIER CASE — A CHANGE TO THE WORLD'S RULES OR GENRE:
If the fundamental nature of the setting changes — its genre shifts, its physical/supernatural laws change, something latent becomes active and alters what is possible in this world — that is ALWAYS a world event of the highest order, at ANY scale. Example: a town that was ordinary slice-of-life has a dormant supernatural contamination ACTIVATE, flipping the setting into urban fantasy. That changes the rules for everyone and qualifies absolutely.
BUT distinguish LATENT from ACTIVATED: a threat that is merely sensed, foreshadowed, leaking faintly, or known-but-dormant is NOT yet an event — it is standing tension. The event is the moment it actually breaks containment and the setting's nature genuinely changes. "A character feels something wrong in the air" or "one location is known to be tainted" = not an event. "The taint erupts and the town's reality visibly shifts" = a top-tier world event.

Examples that QUALIFY as world events (scaled appropriately): a war or open conflict breaks out between factions/groups; a faction or institution falls, is destroyed, or seizes power; a treaty/alliance/truce is formed or broken; a barrier/seal protecting a place is breached; a public revelation changes how a population understands their world; a leader of an institution is overthrown or installed; a catastrophe reshapes a location for everyone who lives there; the world's rules or genre change.

Examples that DO NOT qualify (interpersonal or plot-local, NOT world events — REJECT at every scale):
✗ Two characters meet, fight, reconcile, kiss, or make a personal deal.
✗ One character is injured, captured, healed, or discharged from somewhere.
✗ Someone is tracked, followed, or has orders issued about them personally.
✗ A character joins/leaves/visits a place, has a realization, or changes how they feel.
✗ A small group's plan, errand, or outing — even if it feels momentous to them.
✗ A latent/dormant/sensed threat that has not actually activated.
The test for a world event: "Would this be recorded in THIS world's history, affecting people who weren't even in this scene, at this world's scale?" If it's really about what happened between specific people, it is NOT a world event. Most scenes contain NO world event. That is expected and correct.

REJECT THESE — they are NOT world memories (these are your most common mistakes):
✗ A specific named underling and their role. "Takeshi is a lieutenant with a scar who works from a garage in Nakano" → CHARACTER DATA. A roster of who's in an organization is not worldbuilding. REJECT.
✗ Anything about surveillance/tracking/orders concerning a specific person (especially the player character). "A network is tracking Mira," "the clan issued orders about Mira," "her conversations are being logged" → these are PLOT EVENTS about a character, not world structure. REJECT, no matter how many vehicles are described.
✗ A specific person's reputation, presence, abilities, habits, or psychology. "Kellan commands territorial presence," "Kellan is triggered by vanilla," "Kellan's courtship style" → CHARACTER MEMORIES wearing a costume. REJECT.
✗ A personal arrangement, deal, or relationship between specific characters. "Kellan has a pact with Mira for sketches" → a plot/relationship beat. REJECT.
✗ Weather, the atmosphere of a street on one day, the season. "Autumn in Tokyo, 14°C," "Shinjuku smells of chestnuts" → transient scene texture. REJECT.
✗ The internal operations, software version, or service protocols of one mundane business. "Kinokuniya's inventory system v4.2.17," "Kinokuniya's tiered customer service" → REJECT.
✗ A specific friend group, their chat name, their members. "The Disaster Committee group chat" → CHARACTER ROSTER. REJECT.

THE TEST, applied honestly: "Is this a fact about the fictional WORLD that belongs in a setting encyclopedia — or is it (a) about a specific person, (b) something happening in the plot, or (c) a passing scene detail?" Only the encyclopedia case qualifies. When unsure, REJECT — a missed fact costs nothing; this list of garbage is what we are eliminating.

If nothing in the scene is genuine world lore, output exactly: [NO WORLD MEMORY]. But when real world lore IS present, record it.

UPDATING EXISTING LORE (this is how world CHANGES and SHIFTS are captured):
You will be shown the world lore already on record, each tagged with [id:...]. If this scene REVISES, EXPANDS, or CHANGES one of those existing facts — a faction's situation shifted, a new detail belongs with an existing entry, a previously-true fact is now altered — do NOT write a brand-new entry that duplicates it. Instead, output an UPDATE block that references the existing entry's id and provides the full revised content (the old content plus the change, or a rewrite reflecting current knowledge). This is the primary way world EVENTS and SHIFTS should be recorded when they affect something already known.

Otherwise, for EACH genuine NEW world-lore fact, output a block in this exact format:

---

# WORLD MEMORY

**Title**: (3-6 word evocative title for the fact)
**Date/Time**: (when this became true/known, if applicable)

**Content**: (The world fact, stated neutrally and concretely.)

**Type**: (one of: organization, location, structure, rule)

---

And for EACH genuine WORLD EVENT (something that happened with setting-wide consequences — usually NONE per scene), output a block in this exact format:

---

# WORLD EVENT

**Title**: (3-6 word evocative title for the event)
**Date/Time**: (when it happened, if known)

**Content**: (What happened and its consequences for the setting, stated concretely in third person. Make clear WHY it matters beyond the people present.)

**Type**: event

---

And for EACH revision to an existing fact, output an UPDATE block in this exact format:

---

# WORLD UPDATE

**Target**: (the [id:...] value of the existing entry being revised — just the id, e.g. ml_entry_123_abc)
**Title**: (updated title — keep or refine the original)

**Content**: (the FULL revised content, incorporating the change — this will replace the old content entirely)

**Type**: (one of: organization, location, structure, rule, event, shift)

---

Output nothing else — no preamble, no commentary.`;
}

function buildWorldUserPrompt(sceneSummary, messages, previousSummaries, knownFacts, worldScale) {
    let p = "";
    if (worldScale && String(worldScale).trim()) {
        p += "WORLD SCALE (the user's description of this world's size/scope — judge what counts as a world EVENT relative to THIS scale):\n";
        p += String(worldScale).trim() + "\n\n";
    }
    if (knownFacts.length > 0) {
        p += "WORLD LORE ALREADY ON RECORD (do not restate or rephrase any of these — only a genuine CHANGE to one, or something at this same altitude that is brand new, qualifies):\n";
        p += knownFacts.join("\n") + "\n\n";
    }
    if (previousSummaries.length > 0) {
        p += "Story so far (context only — do NOT mine this for facts):\n";
        previousSummaries.forEach((s, i) => { p += `- ${String(s).substring(0, 160)}...\n`; });
        p += "\n";
    }
    p += "THE SCENE TO EVALUATE:\n";
    if (sceneSummary) p += "Summary: " + sceneSummary + "\n";
    p += messages + "\n\n";

    // The framing is deliberately NOT "extract facts from this scene" — that
    // task structure makes the model surface every incidental detail (a minor
    // character's scar, a shop's software version, the weather). Instead it is
    // a gated judgment: default to nothing, and only clear the bar for true
    // setting-bible lore.
    p += `TASK:

Identify anything in the scene that is true at the level of the WORLD ITSELF — the nature of a major faction or organization, how the setting's power structure or systems work, a significant enduring location's role, or an event whose consequences reshape the setting. Record each as a setting-bible fact ("a fact about this fictional world"), following the qualification and rejection rules you were given.

If something already on record was genuinely changed or expanded by this scene, output a WORLD UPDATE for it rather than a duplicate.

Record what genuinely qualifies. Only if the scene establishes nothing new at the world level, output exactly: [NO WORLD MEMORY].`;
    return p;
}

/** Parse world-memory and world-update blocks out of the LLM response. */
function parseWorldResponse(response, sceneId) {
    if (!response) return [];
    const hasBlocks = /#\s*WORLD\s+(MEMORY|UPDATE|EVENT)/i.test(response);
    if (!hasBlocks && /\[NO WORLD MEMORY\]/i.test(response)) return [];
    const out = [];

    // Tolerant field matcher: accepts **Label**:, **Label:**, *Label:*, "Label:"
    const fieldFrom = (block, label) => {
        const re = new RegExp(`[*_]{0,2}\\s*(?:${label})\\s*[*_]{0,2}\\s*:\\s*[*_]{0,2}\\s*([^\\n]*)`, "i");
        const m = block.match(re);
        return (m && m[1] != null) ? m[1].replace(/[*_]+/g, "").trim() : "";
    };
    const contentFrom = (block) => {
        const cm = block.match(/[*_]{0,2}\s*Content\s*[*_]{0,2}\s*:\s*[*_]{0,2}\s*([\s\S]*?)(?:\n[*_]{1,2}\s*\w|\n-{3,}|\s*$)/i);
        return cm ? cm[1].replace(/[*_]+/g, "").trim() : "";
    };

    // Split into typed blocks, keeping the header capture so we know MEMORY vs UPDATE.
    const parts = response.split(/#\s*WORLD\s+(MEMORY|UPDATE|EVENT)/i);
    for (let i = 1; i < parts.length; i += 2) {
        const kind = (parts[i] || "").toUpperCase();
        const block = parts[i + 1] || "";
        const title = fieldFrom(block, "Title");
        const datetime = fieldFrom(block, "Date/?Time|Date|Time");
        const type = fieldFrom(block, "Type");
        const content = contentFrom(block);
        if (!content && !title) continue;

        const isEvent = (kind === "EVENT") || (type && type.toLowerCase() === "event");

        const base = {
            id: `mlpend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            title: title || (isEvent ? "World event" : "World fact"),
            datetime,
            content,
            category: "world",
            // worldEvent distinguishes setting-altering events (which flow into
            // consolidation) from static world facts (which do not).
            worldEvent: isEvent,
            primaryCharacter: "",
            primaryCharacters: [],
            keyCharacters: [],
            tags: isEvent ? ["world", "event"] : (type ? ["world", type.toLowerCase()] : ["world"]),
            sceneId: sceneId || null,
            source: isEvent ? "scene_world_event" : "scene_world",
            status: "pending",
        };

        if (kind === "UPDATE") {
            // Extract the target id from the RAW line — the normal field cleanup
            // strips underscores, which would corrupt an "ml_entry_..." id.
            const rawLine = (block.match(/Target[*_:\s]*([^\n]*)/i) || [])[1] || "";
            const idMatch = rawLine.match(/ml_entry_[A-Za-z0-9_]+/);
            const targetId = idMatch ? idMatch[0] : "";
            if (targetId) {
                base.updateTargetId = targetId;   // marks this as a revision
                base.source = "scene_world_update";
            }
        }
        out.push(base);
    }
    return out;
}

/**
 * Generate world memories for a closed scene. Strict — usually returns [].
 * @param {string} sceneId
 * @returns {Promise<object[]|null>}
 */
export async function generateWorldMemories(sceneId, force = false) {
    // `force` is set by the explicit "Scan world" button so it runs regardless
    // of the auto-generation toggle. The toggle only governs AUTOMATIC passes
    // (scene close, batch scans).
    if (!force && !getSetting("worldMemory.enabled", true)) {
        dlog("World memory: auto-generation disabled in settings — skipping");
        return [];
    }
    const profileName = getSetting("connections.memoryWriterLLM", "");
    if (!profileName) return null;

    const scene = getScene(sceneId);
    if (!scene) return null;

    const sceneMessages = getSceneMessages(scene, true); // world scan reads hidden messages too
    const previousSummaries = getPreviousSceneSummaries(sceneId);
    const knownFacts = getKnownWorldFacts();

    const sys = buildWorldSystemPrompt();
    const user = buildWorldUserPrompt(scene.llmSummary, sceneMessages, previousSummaries, knownFacts, getWorldScale());

    dlog(`World memory: scanning scene ${sceneId} against ${knownFacts.length} known world facts…`);
    const response = await makeRequest(profileName, sys, user, getMaxResponseTokens(), 0.4);
    if (!response) { dlog("World memory: empty response from LLM"); return null; }

    dlog(`World memory: raw response (${response.length} chars):`, response.slice(0, 600));
    const entries = parseWorldResponse(response, sceneId);
    dlog(`World memory: ${entries.length} world fact(s) parsed from response`);
    if (entries.length > 0) {
        const existing = getPendingEntries() || [];
        savePendingEntries([...existing, ...entries]);
    }
    return entries;
}
