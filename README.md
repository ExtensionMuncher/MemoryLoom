# Memory Loom

A per-chat narrative memory manager for [SillyTavern](https://github.com/SillyTavern/SillyTavern). Memory Loom watches your roleplay, writes vivid memories of what mattered, links related developmental memories over time, and feeds the most relevant context back into the prompt — so long-running stories stay coherent without you hand-maintaining a lorebook.

It is built for long-form collaborative roleplay where continuity is the point: who remembers what, how relationships and the world evolve, which past moments should resurface, and how separate episodes connect into longer character-development threads.

---

## What it does

- **Writes memories from your scenes.** Mark a scene's start and end (or run a batch scan over an existing chat), and a writer LLM transforms pivotal moments into subjective third-person memories — preserving concrete evidence while prioritizing what the Primary Character retained, felt, inferred, misunderstood, and changed.
- **Uses the original scene as evidence.** Scene summaries, character memories, world memories, summary regeneration, and pending-memory regeneration receive the original narrative turns rather than a compacted/sampled substitute. If the selected model cannot fit the source, the request fails transparently instead of silently dropping evidence.
- **Retrieves the right memories at the right time.** Before each reply, a lightweight sidecar LLM reads recent narrative context and identifies what is in play; an embedding model then surfaces relevant memories for injection.
- **Tracks developmental memory chains.** Related memories for the same Primary Character can form narrow, chronological developmental threads. A memory may belong to multiple genuinely distinct chains, and retrieval can expand a strong semantic hit into a small number of adjacent chain stages.
- **Tracks the world, not just the cast.** A stricter world-memory pass records durable setting lore — factions, locations, rules, institutions, and world-scale events — while rejecting character dossiers, passing scene texture, and ordinary plot beats.
- **Consolidates over time.** Groups of episodic memories can be folded into higher-level character summaries and plot arcs while preserving the original sources and their provenance.
- **Keeps suppression explicit.** Manual suppression and approved supersession remove a memory from ordinary retrieval without deleting it. Writer-proposed supersession requires separate user approval; simply committing a new memory never silently retires an older one.
- **Keeps you in control.** Generated memories land in a Pending review area where you approve, edit, regenerate, or discard them before they become durable library entries.
- **Explains passive retrieval decisions.** The Debug panel keeps a session-only report of the latest retrieval pass: vector/lexical scores, threshold and priority changes, chain expansion, suppression/cooldown filtering, optional reranker results, caps, and final injected memories. This adds no prompt tokens or model calls.

Everything is stored **per chat**, inside that chat's metadata — memories from one chat do not leak into another.

---

## Requirements

- A recent SillyTavern install with server-side extensions enabled.
- **An embedding backend.** Memory Loom has its own embedding configuration and supports Local/Transformers, KoboldCpp, Ollama, vLLM, OpenAI, Cohere, Google AI Studio, OpenRouter, and MistralAI. It uses SillyTavern's vector endpoints under the hood while keeping its own source/model settings.
- **Connection profiles** for Memory Writer, Scene Summary, Consolidation, and Keyword Sidecar. These can all use the same profile or different profiles chosen for quality, context size, latency, and cost.

### KoboldCpp embeddings

KoboldCpp can be used directly as the embedding source. Memory Loom follows SillyTavern's native KoboldCpp vector flow and uses the KoboldCpp URL already configured in ST's Text Completion settings by default. You may optionally provide a Memory-Loom-only alternate endpoint.

KoboldCpp **1.87+** with an embedding model loaded is required for embedding requests.

---

## Installation

1. Place the `MemoryLoom` folder in your ST extensions directory:
   `SillyTavern/public/scripts/extensions/third-party/MemoryLoom`
2. Reload SillyTavern with a hard refresh so the browser picks up the new files.
3. Open Memory Loom from the extensions menu.

To update, replace the whole `MemoryLoom` folder and hard-refresh.

---

## First-time setup

1. **Connections** — select a profile for the Memory Writer, Scene Summary, Consolidation, and Keyword Sidecar roles.
2. **Embedding** — choose the embedding source and model in Vectorization. If using KoboldCpp, confirm ST's Text Completion KoboldCpp URL is correct or configure an alternate endpoint.
3. **Similarity threshold** — start with the default and tune from actual retrieval results. If relevant memories rarely surface, lower it; if unrelated memories appear, raise it.
4. **Scan frequency** — choose how often the Keyword Sidecar runs. A small fast sidecar profile keeps normal reply latency low.
5. Optional: enable the **LLM reranker** if you want a lightweight second pass over the strongest vector candidates.

---

## Choosing models

Memory Loom uses several distinct LLM jobs. Matching model strength to the job generally gives better results than using one expensive model everywhere.

### Memory Writer LLM — *your strongest model*

This is the main quality-critical role. It writes character memories and world memories, handles source-grounded regeneration, and can propose organic chain actions. Give it a strong model with good long-context comprehension, causal reasoning, and structured-output discipline.

Character and world memory generation share the **Memory writer max tokens** budget (25,000 tokens by default). Memory Loom can detect a reasoning-heavy response that consumes its visible-answer budget and performs one no-think recovery request when the observable output is clearly starved or malformed.

### Consolidation LLM — *also strong*

Consolidation reads many memories at once and synthesizes higher-level developmental state and plot arcs. It is also used by the historical Memory Chaining scan. A strong long-context model works best.

### Scene Summary LLM — *a competent mid-size model*

Scene summaries are internal continuity references. A good mid-size model is usually enough. If left unset, the role falls back to the Memory Writer.

### Keyword Sidecar LLM — *small and fast*

The Sidecar reads recent context and emits retrieval keywords. It runs frequently, so low latency matters more than deep reasoning. Use a small local model when possible.

### Embedding model — *whatever fits your retrieval stack*

Choose the embedding backend/model you prefer and tune Memory Loom's similarity threshold around its score distribution.

---

## How to use it

### Capturing memories

- **Manual scenes:** use the Open/Close Scene controls attached to SillyTavern messages. Scene controls are reattached after message renders, edits, swipes, and chat-DOM replacement so they do not silently disappear.
- **Batch scan:** process an existing chat in scene-sized chunks. Batch-generated memories still go through Pending review.
- **Selective scan:** process a chosen message range. Message numbers match SillyTavern's own zero-based numbering.
- **World scan:** run a world-only pass when you specifically want to reconstruct durable setting lore.

A closed scene tracks Scene Summary, Character Memories, and World Memories as separate generation stages. Failure in one stage does not force the other source-grounded stages to fail. Retry reruns only stages that are not already complete.

### Regeneration

- **Regenerate summary** reruns only the Scene Summary from the original scene evidence.
- **Regenerate** on a Pending Memory rereads the original source scene rather than merely rewriting the previous draft.
- Transport/provider errors are recorded per scene with a compact diagnostic so a failed generation remains inspectable later.

### Pending review

Generated character and world memories appear on Home for review. Commit, edit, regenerate, or discard them before they enter the library.

If the Memory Writer proposes that a new memory supersedes an older one, the Pending card displays a separate **Approve suppression** action. Committing the new memory — including Commit All — does **not** approve the suppression automatically.

---

## The library

The Library is organized into folders:

- **Characters** — per-character subfolders with memories, aliases, optional banner images, and character-specific developmental chains.
- **World** — durable setting lore.
- **Plot** — arc-level summaries, including consolidation products.
- **Custom folders** — user-created top-level folders and subfolders.

Memory cards support search, sorting, bulk selection, moving, editing, starring, archival, suppression visibility, consolidation exclusion, and tag correction. Saving edited recall tags triggers re-embedding so retrieval reflects the updated text.

A **suppressed** badge appears on memories currently excluded from ordinary retrieval. Suppressed entries remain browsable and retain their provenance.

---

## Memory Chaining

Memory Chains represent **narrow developmental threads**, not general character histories or relationship folders.

Examples of appropriate chains include a character gradually learning to trust someone, repeatedly failing and revising the same strategy, or moving through distinct stages of grief. Merely sharing the same character, event, or topic is not enough.

Important rules:

- Every chain belongs to exactly one **Primary Character**.
- Memories owned by different Primary Characters cannot be combined just because they react to the same person or event.
- A memory may belong to more than one chain when the episode genuinely advances multiple independent threads.
- Chain order is derived from memory chronology rather than arbitrary stored position.
- Historical scan proposals are intentionally sparse (normally 2–8 strong milestone memories). Organic chains can grow beyond that as later scenes genuinely continue the thread.
- Chain membership does not delete, merge, or rewrite the episodic memories themselves.

### Organic chaining

During normal scene-close writing, the Memory Writer can conservatively propose that a new memory:

- appends to one or more existing chains;
- creates a new chain with an existing memory; or
- leaves chaining alone.

When a new stage genuinely recontextualizes a thread, the writer may also propose a revised chain label or compact description. Ordinary reinforcement should leave the chain description unchanged.

### Manual chain manager

The Library includes **Create / Edit Chains** for manually creating, renaming, describing, editing, or deleting chains. The memory picker is restricted to memories owned by the selected Primary Character and shows chronology, content, Delta, and existing chain memberships.

Deleting a chain removes only the chain relationship. The memories remain intact.

### Historical chain scan

Debug includes a preview-first Memory Chaining workflow:

1. Scan existing memories for sparse developmental chains.
2. Review each proposal and the exact member memories.
3. Approve the proposals you want.
4. Apply approved chains.
5. Optionally undo the last applied scan batch.

The scan can also validate/rebuild membership metadata. Large/slow reasoning models receive a generous fixed ceiling rather than being prematurely killed by a short helper timeout.

After Batch Scan, historical chain reconciliation runs only after that batch's Pending character memories have all been committed or discarded, ensuring proposed chains reference durable memory IDs.

---

## Suppression and supersession

Suppression is an explicit retrieval exclusion, not deletion.

- **Manual suppression** can be applied/released by the user.
- **Approved writer supersession** records that a new memory has replaced an older representation after the user separately approves the proposal.
- Suppression records retain reason, source, timestamp, and optional successor provenance.
- Suppressed memories are excluded from passive retrieval, injection, World Writer reconciliation, and automatic consolidation candidates, while remaining visible in the library and in their chains.

The Memory Writer may only propose supersession against ordinary active same-character generated episodic memories. Imported/manual memories, starred memories, consolidation sources, consolidation-excluded entries, existing chain milestones, and already-suppressed memories are protected from automatic writer proposals.

Batch Scan never performs writer supersession. Historical reconstruction is additive.

Legacy writer suppressions that were created automatically without separate approval are restored during migration. Future writer suppression requires explicit approval.

---

## World memories

World memories are deliberately stricter than character memories. They capture facts about the **setting itself** — organizations, rules, institutions, significant locations, durable social structures, or world-scale events — and reject character dossiers, personal relationships, ordinary plot beats, surveillance of a particular individual, and passing scene texture.

Most scenes producing no World Memory is normal.

When later evidence changes an existing world fact, the World Writer can propose an **UPDATE** to a known world-memory ID. Suppressed world memories are excluded from reconciliation targets.

---

## Consolidation

Consolidation synthesizes selected episodic memories into higher-level character memories and a Plot arc summary.

Consolidated source memories are **not suppressed**. They retain their consolidation provenance and remain eligible for semantic retrieval after passing the normal similarity threshold; the configured **Consolidated memory priority** then reduces their ranking relative to ordinary memories. Important/starred sources keep their normal important-memory priority behavior.

Consolidated sources are excluded from future automatic consolidation so the same episodes are not repeatedly folded into new summaries. Manual consolidation can explicitly override appropriate chain-related eligibility when the user chooses.

**Undo Consolidation** removes the generated consolidation outputs and restores surviving sources/scenes to their recorded pre-consolidation state. It preserves unrelated later manual/suppression history and protects nested consolidations that still depend on an earlier output.

---

## How retrieval works

1. You send a message.
2. The **Keyword Sidecar** reads recent narrative context and produces a retrieval query (unless Raw recent messages is selected instead).
3. The configured embedding backend queries this chat's vector collection.
4. Candidates must pass semantic eligibility before status/priority adjustments are applied.
5. Suppressed/archived memories, cooldowns, decay, consolidated priority, important-memory priority, and other eligibility rules are applied.
6. **Chain expansion** may add a small number of adjacent memories from a chain containing a strong retrieved hit. Expansion is local and non-recursive; it does not flood the prompt with an entire chain.
7. If enabled, the LLM reranker sees the combined candidate pool.
8. Category/global injection limits select the final memories.
9. The resulting memory block is injected into the prompt.

The Debug → **Last passive retrieval** report shows how the most recent retrieval moved through these stages.

---

## Recall tool

If your chat backend supports tool calling, Memory Loom registers `search_core_memories`, allowing the model to deliberately search stored memories beyond the passive injection set. Recall operations retain the same per-chat ownership safeguards as passive retrieval.

---

## Settings reference

- **Connections** — Memory Writer, Scene Summary, Consolidation, and Keyword Sidecar profiles; per-profile soft/hard no-think controls.
- **Scanning** — Sidecar frequency, 25k default Memory Writer output budget, general helper/summary response budget, and optional LLM reranker.
- **Memory Writing** — world-memory generation and writer/summary prompt overrides.
- **Injection** — enable/placement/depth/role, per-category limits, stickiness, cooldown, and recall-tool limits.
- **Consolidation** — consolidation output budget, automatic consolidation threshold, consolidated-memory priority, important-memory priority.
- **Vectorization** — embedding source/model, similarity threshold, query source, top-K, raw-query options, decay, and chain-expansion behavior.
- **Debug** — retrieval diagnostics, world scan, delta backfill, re-embed, undo last scan, Memory Chaining scan/validation/rebuild, reset tools.
- **Data** — import/export and per-chat data maintenance.

---

## Back up your memories

Memories live in the chat's metadata. **Export regularly.** Export All includes library entries, scenes, folders, consolidations, chains, chain proposals/batches, suppression provenance, cadence state, and Memory Loom settings.

Imports support merge or replace and validate IDs, chain membership, suppression successors, and other structural relationships before mutating the current chat.

---

## Troubleshooting

- **No memories retrieved / nothing injects:** confirm the embedding backend is reachable and inspect **Debug → Last passive retrieval**. Check similarity score, suppression/status, cooldown, decay, chain expansion, reranker order, and injection caps.
- **KoboldCpp embeddings fail:** confirm KoboldCpp 1.87+ is running with an embedding-capable model and that ST's Text Completion KoboldCpp URL (or Memory Loom's alternate endpoint) is reachable.
- **Writer produced reasoning but no usable memory:** Memory Loom performs one no-think recovery when it detects reasoning-dominated malformed visible output. If that also fails, inspect the stored scene diagnostic and provider logs rather than assuming the scene succeeded.
- **A scene says Needs attention:** expand the status/retry controls. Generation stages are independent; retry should rerun only incomplete/failed stages.
- **World scan returns `[NO WORLD MEMORY]`:** often correct. The source may contain no durable setting lore or the fact may already exist.
- **A memory was unexpectedly retired:** open its suppression information. Writer supersession requires separate approval; legacy unapproved writer suppressions are automatically restored during migration.
- **A chain proposal looks too broad:** reject it. Chains are intentionally sparse developmental threads, not general character timelines.
- **Scene controls disappear after a swipe/edit:** Memory Loom should automatically restore them. If not, hard-refresh and check F12 for an initialization/DOM error.

---

## Notes

- Storage is per chat and lives in chat metadata; deleting a chat removes its Memory Loom data unless you exported it first.
- The Sidecar runs frequently. Use a small fast model if reply latency matters.
- Suppression is reversible and provenance-aware; deletion is not the same operation.
- Memory chains add developmental context without flattening episodic memories into one summary.
- Stricter is safer for World Memories: a missed setting fact can be added later, while noisy character/plot data permanently weakens retrieval quality.

---

*Memory Loom is a community SillyTavern extension. It orchestrates your configured models through SillyTavern's Connection Manager and vector APIs; it ships no models of its own.*
