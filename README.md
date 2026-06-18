# Memory Loom

A per-chat narrative memory manager for [SillyTavern](https://github.com/SillyTavern/SillyTavern). Memory Loom watches your roleplay, writes vivid memories of what mattered, and feeds the most relevant ones back into context — so long-running stories stay coherent without you hand-maintaining a lorebook.

It is built for long-form collaborative roleplay where continuity is the whole point: who remembers what, how relationships and the world evolve, and which past moments should resurface when they become relevant again.

---

## What it does

- **Writes memories from your scenes.** Mark a scene's start and end (or run a batch scan over existing chat), and a writer LLM distills it into concise third-person memory entries — one per pivotal moment, with concrete sensory detail rather than dry summary.
- **Retrieves the right memories at the right time.** Before each reply, a lightweight *sidecar* LLM reads the recent messages and figures out what's being discussed; an embedding model then surfaces the stored memories most relevant to that moment and injects them into context.
- **Tracks the world, not just the cast.** A separate, stricter pass records *world memories* — the durable lore of your setting (factions, locations, rules, world-altering events) — kept apart from character memories and able to update itself as the world changes.
- **Consolidates over time.** As memories pile up, you can fold groups of them into higher-level summaries, keeping the working set lean while preserving meaning.
- **Keeps you in control.** Nothing is committed silently. Generated memories land in a *pending* review area where you approve, edit, regenerate, or discard them.

Everything is stored **per chat**, inside that chat's metadata — memories from one chat never leak into another.

---

## Requirements

- A recent SillyTavern install (server-side extensions enabled).
- **An embedding backend.** Memory Loom has its own embedding configuration (in the Vectorization settings) and supports Local/Transformers, Ollama, vLLM, OpenAI, Cohere, Google AI Studio, OpenRouter, and MistralAI. It uses ST's vector API endpoints under the hood but with its own settings — you do not configure this through ST's Vector Storage. Ollama with an embedding model (e.g. `qwen3-embedding`) works well.
- **Connection profiles** for the LLM roles below. These can all be the same profile, or different ones tuned for cost/speed.

---

## Installation

1. Place the `MemoryLoom` folder in your ST extensions directory:
   `SillyTavern/public/scripts/extensions/third-party/MemoryLoom`
2. Reload SillyTavern (a hard refresh, so the browser picks up the files).
3. Open the Memory Loom panel from the extensions menu.

To update, replace the whole folder and hard-refresh.

---

## First-time setup

1. **Connections** (Settings tab) — pick a profile for each of the four roles. See **Choosing models** below for what each one needs; they can all be the same profile or different ones tuned for cost and speed.
2. **Embedding** (Vectorization settings) — choose your embedding source and model directly in Memory Loom. Pick the provider, fill in the model field, and make sure that backend is reachable.
3. **Similarity threshold** (Injection settings) — the default is conservative. If relevant memories aren't surfacing, lower it; if irrelevant ones are, raise it. Turn on Debug logging to watch the actual match scores and tune from real numbers.

---

## Choosing models

Memory Loom uses four LLM roles, and they have very different demands. Matching model strength to the job keeps quality high without melting your machine or your API budget.

### Memory Writer LLM — *your strongest model*
This is where memory quality comes from. It reads a whole scene and distills it into vivid, accurate entries, and it also drives the world-memory pass and its update logic. Give it the best model you have access to — ideally a strong cloud API, or a local model with genuinely good reasoning, summarization, and a large context window. If you only upgrade one role, upgrade this one.

### Consolidation LLM — *also your strongest model*
Consolidation folds many memories and scene summaries into coherent higher-level arcs. That demands the same strengths as the writer — strong reasoning, summarization, and a large context limit, since it ingests a lot at once. Treat it the same as the Memory Writer: best model available, cloud API or a strong large local model.

### Scene Summary LLM — *a decent mid-size model*
This writes the internal scene reference notes that maintain continuity between sessions. It's a lighter job than full memory writing, so a competent mid-size model is plenty. A model in the ~12B range works well here. *(If you leave it unset, it falls back to the Memory Writer.)*

### Keyword Sidecar LLM — *a small, fast, lightweight model*
The sidecar's only job is to read the current context and output good keywords for the embedding model. It does not need to be smart or large — it needs to understand what's happening in the messages and produce clean, relevant keywords quickly. A small fast model in the ~9B range is ideal.

> **This connection runs on every message (or every N messages, per your Scan frequency setting).** Because it fires so often, its speed directly adds to your reply latency, and a heavy model here will make every turn sluggish (and, if local, work your hardware constantly). Pick something light. A small local model is perfect — it keeps the cost at zero and the latency low.

### Embedding model — *whatever you like*
The embedding model is configured in Memory Loom's own Vectorization settings — source plus model — use whatever you prefer. Remember to tune the similarity threshold to match it (the built-in default leans strict for some embedding models).

---

## How to use it

### Capturing memories

- **Manual scenes:** use the Scene Start / Scene End controls to mark a stretch of roleplay. On close, the writer generates memory entries (and, if enabled, a world pass).
- **Batch scan** (Scanning settings): process an existing or long chat in scene-sized chunks. Good for retrofitting Memory Loom onto a story already in progress.
- **Selective scan:** scan only a message range. Message numbers match ST's own numbering (the first message is `#0`).

All generated entries appear as **pending** on the Home tab — grouped by character, with world memories in their own clearly-divided section. Review them there.

### The library

The Library tab is your memory store, organized into folders:

- **Characters** — per-character subfolders, each with its own memories, optional banner image, and update history.
- **World** — setting lore (see below).
- **Plot** — arc-level summaries, including the products of consolidation.
- **Custom folders** — make your own top-level folders and subfolders, with images and their own menu bars.

Each memory card shows an estimated token cost and when its folder was last updated. You can search, sort, bulk-select, move, edit, star (mark as core/important), or exclude entries from consolidation.

### World memories

World memories are deliberately **stricter** than character memories. They capture facts about the *setting itself* — what an organization is, how the world's rules work, a significant location, or a world-altering event — and explicitly reject character-level detail, plot beats, and passing scene texture. Most scenes produce none, and that's expected; a lore-dense world yields more than a grounded one.

When a later scene changes something already recorded, the world pass can issue an **update** to the existing entry instead of duplicating it — these show up as pending entries marked "updates existing," and on approval the revised version replaces the old one.

You can also run a dedicated **world scan** from the Debug settings, and add or edit world entries by hand via the World folder's menu bar.

### Consolidation

When memories accumulate, open the Consolidate popout, select the memories and/or scenes to fold together, and confirm. Memory Loom writes one consolidated memory per character over the selection plus a single arc summary in the Plot folder, then demotes the source memories (non-destructively — they stay retrievable at lower priority). World memories can be included in consolidation too.

### Recall tool

If your chat backend supports tool calling, Memory Loom registers a `search_core_memories` function the model can call mid-reply to pull specific memories on demand, beyond what's auto-injected.

---

## How retrieval works (the short version)

1. You send a message.
2. The **sidecar** LLM reads recent context and extracts the characters, themes, and events in play.
3. Those become a query against this chat's **vector collection**; the embedding model returns the closest-matching stored memories.
4. Scoring applies your settings — similarity threshold, stickiness (a memory stays active for a few messages after firing), cooldown (a memory won't re-fire immediately), and optional decay (older memories gradually lose priority). Starred/important memories bypass decay and suppression.
5. The surviving memories are injected into the prompt, in the format and placement you chose.

A 45-second watchdog guards the whole pass, so a hung LLM call can never freeze your chat.

---

## Settings reference

- **Connections** — Memory Writer, Scene Summary, Consolidation, and Keyword Sidecar profiles (see *Choosing models*).
- **Scanning** — batch scan, selective scan, world-memory generation toggle.
- **Injection** — what gets injected and where; max entries per message; stickiness; cooldown; max recall-tool memories.
- **Vectorization** — embedding source mirror, similarity threshold, top-K, consolidated-priority multiplier, distance metric.
- **Consolidation** — token cap, auto-consolidation threshold, important-priority multiplier.
- **Debug** — verbose console logging (highly recommended while tuning), world scan, delta backfill, re-embed, undo last scan, memory decay, reset to defaults.
- **Data** — import / export everything.

---

## Back up your memories

Memories live in the chat's metadata. **Export regularly** — there's an Export All in the Data settings. A quick export after a good session is the difference between a non-event and a bad day if a chat gets wiped or corrupted. Imports support merge or replace, so you can recover or combine snapshots.

---

## Troubleshooting

- **No memories retrieved / nothing injects:** check that your embedding backend is reachable and the similarity threshold isn't too high. Turn on Debug logging and watch the retriever's score lines.
- **World scan returns "[NO WORLD MEMORY]" everywhere:** this is often correct — either the scenes contain no new setting lore, or the facts are already on record (re-scanning the same scenes dedupes). Confirm with Debug logging, which prints the raw model response for each scene.
- **A feature button seems to do nothing:** open the browser console (F12). Memory Loom logs its actions; errors there point to the cause (often an embedding backend not configured).
- **Memories from another chat showing up:** they shouldn't — storage is per-chat. If something looks crossed, check that you didn't import another chat's export into this one.

---

## Notes

- Storage is per-chat and lives in chat metadata; deleting a chat removes its memories.
- The sidecar runs before every reply — if latency matters, use a small fast model for that role.
- Stricter is safer for world memories: a missed fact can be added later, but a flood of trivial ones is just noise.
