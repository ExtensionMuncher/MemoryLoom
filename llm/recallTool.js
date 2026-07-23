/**
 * llm/recallTool.js — Memory Recall function tool
 *
 * Registers a `search_core_memories` tool with ST's ToolManager, following
 * timeline-memory's query_timeline_chapter pattern. The MAIN chat LLM calls
 * this mid-generation when a character is trying to remember something, or
 * when current events might connect to a past memory it can't see.
 *
 * Differences from passive (sidecar) injection:
 *   - Deliberate: the model asks, with its own search query
 *   - Bypasses Max Entries per Message — has its own limit
 *     (Settings > Injection > Max tool-call memories)
 *   - Bypasses stickiness/cooldown — a deliberate recall should never be
 *     suppressed by passive-injection pacing rules
 *   - Uses a more lenient similarity threshold (a directed search should
 *     surface near-misses the passive pipeline would skip)
 *
 * No extra connection profile is involved: unlike timeline-memory, which
 * must compress whole chapters through an LLM to answer questions, Memory
 * Loom's entries are already compact — they're returned verbatim as
 * CORE MEMORY blocks. The "LLM doing the recalling" is the main chat model
 * itself. Requires a Chat Completion backend with function calling support
 * and ST's tool calling enabled.
 */

import { isEnabled, getSetting } from "../settings.js";
import { getCollectionId } from "../embed/embedder.js";
import { queryCollection, buildVectorSettings } from "../embed/retriever.js";
import { getEntries } from "../data/storage.js";
import { formatMemoriesAsBlocks } from "../inject/promptInjector.js";
import { resolveCanonicalCharacter } from "../data/folders.js";
import { dlog } from "../lib/debug.js";

const TOOL_NAME = "search_core_memories";

export function registerMemoryRecallTool() {
    let ToolManager;
    try {
        ToolManager = window.SillyTavern?.getContext()?.ToolManager;
    } catch (e) { /* fall through */ }
    if (!ToolManager?.registerFunctionTool) {
        console.warn("[ML] Recall tool: ToolManager unavailable — ST version may not support function tools");
        return;
    }

    // Clear a stale definition before re-registering (timeline-memory pattern)
    try { ToolManager.unregisterFunctionTool(TOOL_NAME); } catch (e) {}

    ToolManager.registerFunctionTool({
        name: TOOL_NAME,
        displayName: "Search Core Memories",
        description: "Use when a character references, encounters, or reacts to a past event, person, promise, secret, or unresolved thread logged in Core Memories.",
        stealth: false,
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "What to search for — an event, feeling, person, object, or moment. Phrase it like the memory might be written, e.g. 'the near-kiss in the library stairwell' or 'first day at the new job'.",
                },
                character: {
                    type: "string",
                    description: "Optional: restrict results to memories belonging to this character (their full name).",
                },
            },
            required: ["query"],
        },
        action: async (args) => {
            try {
                return await searchCoreMemories(args?.query || "", args?.character || "");
            } catch (err) {
                console.error("[ML] Recall tool error:", err);
                return "Memory search failed — the archive could not be reached.";
            }
        },
        shouldRegister: () => isEnabled() && getSetting("injection.recallToolEnabled", true),
        formatMessage: (args) => `Searching core memories for: "${args?.query || ""}"${args?.character ? ` (${args.character})` : ""}`,
    });

    console.log("[ML] Recall tool registered: search_core_memories");
}

/**
 * The actual search: vector similarity + title/content keyword fallback,
 * optional character filter, own result limit.
 */
async function searchCoreMemories(query, characterFilter) {
    const q = String(query || "").trim();
    if (!q) return "No search query was provided.";

    const limit = Math.max(1, Number(getSetting("injection.maxToolCallMemories", 5)) || 5);
    const collectionId = getCollectionId();
    const allEntries = Object.values(getEntries() || {});
    if (allEntries.length === 0) return "The memory archive is empty — no Core Memories exist yet.";

    dlog(`Recall tool: query "${q}"${characterFilter ? `, character "${characterFilter}"` : ""}, limit ${limit}`);

    // ── 1. Vector search (lenient threshold — deliberate recall) ──
    const passiveThreshold = Number(getSetting("vectorization.similarityThreshold", 0.75));
    const threshold = Math.min(passiveThreshold, 0.5);
    let hits = [];
    if (collectionId) {
        const raw = await queryCollection(collectionId, q, Math.max(limit * 3, 10), threshold, buildVectorSettings());
        if (raw?.hashes?.length) {
            for (let i = 0; i < raw.hashes.length; i++) {
                const entry = allEntries.find(e => e.vectorHash === raw.hashes[i]);
                if (entry) hits.push({ entry, score: raw.metadata?.[i]?.score || 0 });
            }
        }
        dlog(`Recall tool: ${hits.length} vector hit(s) at threshold ${threshold}`);
    }

    // ── 2. Keyword fallback/boost: title or content contains the query ──
    // Catches "find THE specific memory" lookups by title that vector
    // similarity can miss, and works even if embeddings are unavailable.
    const ql = q.toLowerCase();
    for (const entry of allEntries) {
        const inTitle = (entry.title || "").toLowerCase().includes(ql);
        const inContent = (entry.content || "").toLowerCase().includes(ql);
        if (inTitle || inContent) {
            const existing = hits.find(h => h.entry.id === entry.id);
            if (existing) existing.score += inTitle ? 1 : 0.25; // boost to front
            else hits.push({ entry, score: inTitle ? 1 : 0.25 });
        }
    }

    // ── 3. Optional character filter (alias-aware) ──
    if (characterFilter) {
        const canon = resolveCanonicalCharacter(characterFilter).toLowerCase();
        hits = hits.filter(({ entry }) => {
            const prims = (entry.primaryCharacters?.length ? entry.primaryCharacters : [entry.primaryCharacter]).filter(Boolean);
            const keys = entry.keyCharacters || [];
            return [...prims, ...keys].some(n => String(n).toLowerCase() === canon);
        });
        dlog(`Recall tool: ${hits.length} hit(s) after character filter "${canon}"`);
    }

    if (hits.length === 0) {
        return `No Core Memories found matching "${q}"${characterFilter ? ` for ${characterFilter}` : ""}. The memory may not exist in the archive.`;
    }

    hits.sort((a, b) => (b.score || 0) - (a.score || 0));
    const final = hits.slice(0, limit).map(h => h.entry);
    dlog(`Recall tool: returning ${final.length} memorie(s):`, final.map(e => `"${e.title}"`).join(", "));
    return formatMemoriesAsBlocks(final);
}
