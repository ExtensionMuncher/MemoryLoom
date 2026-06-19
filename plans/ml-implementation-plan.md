# Memory Loom — Implementation Plan

## Architecture Overview

Memory Loom is a SillyTavern extension providing curated memory archival for long-running roleplay. It operates on three layers: **Write** (LLM generates memory entries on scene close), **Retrieve** (keyword sidecar → embedding → system prompt injection), and **Consolidate** (merge memories into higher-level summaries).

All data is **per-chat** (stored in `chat_metadata.ml`). Settings are global (`extension_settings.ml`). The UI uses ST's `extension_container` + `inline-drawer` pattern with three tabs: Home, Library, Settings.

---

## File Structure

```
MemoryLoom/
├── index.js                    — Entry point, event registration, message buttons
├── manifest.json               — ST extension manifest
├── style.css                   — Full UI styles (replicated from mockup)
├── settings.js                 — Settings get/set, defaults, init
├── data/
│   ├── storage.js              — Wrapper for ST's extension_settings + chat_metadata API
│   ├── entries.js              — Memory entry CRUD, status/delta/tag management
│   ├── folders.js              — Folder + subfolder CRUD, routing logic
│   ├── scenes.js               — Scene open/close, summary storage
│   └── consolidations.js       — Consolidation entry CRUD, scope tracking
├── llm/
│   ├── connections.js          — Connection profile lookup + makeRequest() wrapper
│   ├── sidecar.js              — Keyword extraction LLM (runs every N messages)
│   ├── writer.js               — Memory Writer: scene summary → entry generation
│   ├── consolidator.js         — Consolidation LLM: arc/sub-arc merging
│   └── autoTag.js              — Tag suggestion for manual entries
├── embed/
│   ├── embedder.js             — Embedding model calls, vector storage per entry
│   └── retriever.js            — Query pipeline: sidecar keywords → embed → filter → inject
├── ui/
│   ├── panel.js                — Builds extension panel shell + 3 tabs + drawer toggle
│   ├── home.js                 — Home tab: toggle, sidecar control, writer status, pending cards
│   ├── library.js              — Library tab: folder tree, memory entries, scenes, modals
│   └── settings.js             — Settings tab: accordion sections with all config
├── inject/
│   └── promptInjector.js       — System prompt injection/removal with stickiness + cooldown
└── lib/
    └── icons.js                — Inline SVG icon definitions (copied from mockup)
```

### Key Dependencies (ST imports)

```js
// From ../../../../script.js
import { chat, chat_metadata, name1, saveSettingsDebounced, saveChatDebounced, setExtensionPrompt } from "../../../../script.js";

// From ../../../../scripts/events.js
import { eventSource, event_types } from "../../../../scripts/events.js";

// From ../../../../scripts/extensions.js
import { extension_settings, getContext } from "../../../../scripts/extensions.js";

// From ../../../../extensions/shared.js
import { ConnectionManagerRequestService } from "../../../../extensions/shared.js";
```

---

## Slice-by-Slice Breakdown

### Slice 1: Project Scaffold

**Files:** `manifest.json`, `index.js` (skeleton), `settings.js`, `data/storage.js`

#### manifest.json
```json
{
    "display_name": "Memory Loom",
    "loading_order": 3,
    "default_state": "enabled",
    "requires": [],
    "optional": [],
    "js": "index.js",
    "css": "style.css",
    "author": "ExtensionMuncher",
    "version": "0.1.0"
}
```

#### index.js (skeleton)
- Extension name constant: `"ml"` (used as namespace in storage)
- jQuery init wrapper
- Calls `initSettings()` to merge defaults
- Creates panel via `createPanel()`
- Renders all three tabs
- Registers event handlers: `MESSAGE_RECEIVED`, `MESSAGE_SENT`, `CHAT_CHANGED`, `APP_READY`
- Registers magic wand menu entry
- Registers slash commands (placeholder)
- Listens for `ml:tab-switched` to refresh tab content
- Listens for `ml:toggle` to enable/disable injection and buttons
- Re-entrancy guard for sidecar (`_sidecarRunning`)
- Message deduplication guard (`_processedMesIds` Set)
- Exports: `addMessageButtons(mesId)`, `onMessageReceived(mesId, isAiMessage)`, `onChatChanged()`

#### settings.js
- `initSettings()` — deep merge defaults into `extension_settings.ml.settings`
- `isEnabled()` → boolean
- `getSetting(key, defaultValue)` — dot-notation path lookup
- `setSetting(key, value)` — saves to `extension_settings.ml.settings`
- `getDefaultSettings()` — returns the full default settings object from the kickoff prompt (Settings data structure)
- `toggleEnabled(enabled?)` → new state

#### data/storage.js
- Namespace: `"ml"`
- `ensureSettingsNamespace()` — initializes `extension_settings.ml` if missing
- `ensureChatNamespace()` — initializes `chat_metadata.ml` with `{ entries: {}, folders: {}, scenes: [], consolidations: {}, pendingEntries: null, messageCounter: 0, openSceneId: null, stickiness: {}, cooldowns: {} }` if missing
- `getSettings()` / `saveAllSettings(obj)` / `saveSetting(key, value)` / `persistSettings()` — global settings
- `getChatData()` / `persistChatData()` — per-chat
- `getEntries()` / `saveEntries(obj)` — entries map keyed by ID
- `getFolders()` / `saveFolders(arr)` — folders array
- `getScenes()` / `saveScenes(arr)` — scenes array
- `getConsolidations()` / `saveConsolidations(obj)` — consolidations map
- `getChatData()` — returns full `chat_metadata.ml` object
- `persistChatData()` — calls `saveChatDebounced()`
- `getPendingEntries()` / `savePendingEntries(obj)` — pending review entries
- `getOpenSceneId()` / `saveOpenSceneId(id)` — currently open scene
- `getMessageCounter()` / `incrementMessageCounter()` / `resetMessageCounter()` — for scan frequency
- `getDefaultSettings()` — returns the full defaults object (used by settings.js)

---

### Slice 2: UI Shell

**Files:** `style.css`, `ui/panel.js`, `lib/icons.js`

#### style.css
- Replicate ALL styles from `memory-loom-mockup.html` `<style>` block
- Replace hardcoded colors with ST CSS variables where possible:
  - `var(--grey-700)` etc. for backgrounds
  - `var(--neutral-200)` for borders
  - `var(--text-900)` for text
  - Keep functional colors: pinned gold `#cdb97a`, consolidation green `#4a5a50`, low-delta amber `#c8884a`
- Add `.rst-scene-btn` equivalents as `.ml-scene-btn` for message action buttons
- Typography: Lora (prose), IBM Plex Mono (UI), Inter (fallback)
- All the mockup classes: `.shell`, `.shell-header`, `.tabs`, `.tab`, `.pane`, `.entry-card`, `.entry-card-hdr`, `.entry-card-body`, `.entry-prose`, `.entry-chars`, `.regen-box`, `.folder`, `.folder-hdr`, `.folder-body`, `.char-subfolder`, `.char-banner`, `.mem-entry`, `.mem-full`, `.status-badge`, `.delta-flag`, `.scene-entry`, `.accordion`, `.acc-hdr`, `.acc-body`, `.setting-row`, `.decay-settings`, `.crop-overlay`, `.crop-modal`, `.ml-modal-overlay`, `.ml-modal`, `.form-*`, `.char-tag-input`, `.pill-row`, `.pill`, `.route-preview`, `.ml-expand-btn`, `.field-hdr`, `.ml-popout-overlay`, `.msg-btn-demo`, `.control-row`, `.writer-active`, `.pending-badge`, `.seg-control`, `.filter-bar`, `.btn`, `.btn-confirm`, `.btn-danger`, `.icon-btn`, `.toggle`, `.tag`, `.lbl`, `.rule`

#### lib/icons.js
- Export SVG symbol definitions as an HTML string (copied from mockup's `<svg style="display:none">` block)
- Include all icons: `ico-book-open`, `ico-feather`, `ico-book`, `ico-chevron-down`, `ico-chevron-right`, `ico-reader`, `ico-plus`, `ico-folder-plus`, `ico-globe`, `ico-users`, `ico-scroll`, `ico-image`, `ico-trash`, `ico-sort`
- Also export helper: `iconSvg(name, width, height, color)` → returns SVG HTML string using `<use href="#icon-name"/>`

#### ui/panel.js
- Export `createPanel()`:
  - Creates `#ml_container.extension_container` with `.inline-drawer` pattern (matches RST)
  - Builds tab bar with three tabs: Home, Library, Settings
  - Creates three panes: `#ml-p-home`, `#ml-p-library`, `#ml-p-settings`
  - Appends to `#extensions_settings`
  - Returns the shell jQuery element
- Export `switchTab(tabId)` — updates tab `.on` classes and pane visibility, triggers `ml:tab-switched`
- Export `getPane(tabId)` → jQuery element
- Export `showPanelLoading(msg)` / `hidePanelLoading()` — persistent overlay (matches RST pattern)
- Export `renderHomeHeader($pane)` — enable/disable toggle with status text

---

### Slice 3: Home Tab

**File:** `ui/home.js`

- Export `renderHomeTab($pane)`:
  - Renders enable/disable toggle row (calls `renderHomeHeader` from panel.js)
  - Renders keyword sidecar row: status text ("Running · every message") + Pause/Resume button
  - Renders writer active indicator with pulse animation (shown when a scene is open and writer is generating)
  - Renders pending entries section:
    - Iterates `getPendingEntries()` (an array of proposed entries from the writer)
    - Each entry renders as a collapsible `.entry-card` with:
      - Title, metadata line (primary character, category, scene, message range)
      - Chevron toggle for expand/collapse
      - Expanded body: prose content, primary/key characters, delta block (before/after/delta + delta_type tags), low_delta_flag badge
      - Per-entry action row: Commit, Regenerate (toggles regen guidance box), Edit, Discard
      - Regen guidance box: textarea + "Regenerate with prompt" / "Regenerate from scene" buttons
    - Global action row: Commit All, Discard All
- Export `toggleSidecar()` — pauses/resumes the keyword sidecar pipeline
- Export `commitEntry(entryId)` — moves entry from pending to committed storage, auto-routes, auto-embeds
- Export `discardEntry(entryId)` — removes from pending
- Export `commitAllPending()` / `discardAllPending()`
- Export `regenerateEntry(entryId, guidance?)` — re-runs writer for a single entry
- All textareas get `.ml-expand-btn` with `data-for` attribute

---

### Slice 4: Data Layer

**Files:** `data/entries.js`, `data/folders.js`, `data/scenes.js`

#### data/entries.js
- `createEntry(data)` → entry object with generated ID (`ml_entry_${timestamp}_${random}`)
- `getEntry(id)` → entry object or null
- `getAllEntries()` → array of all committed entries
- `getEntriesByFolder(folderId)` → filtered array
- `getEntriesByCharacter(charName)` → filtered array (searches primaryCharacter + primaryCharacters)
- `updateEntry(id, updates)` → merges updates, sets updatedAt
- `deleteEntry(id)` → removes from storage
- `setEntryStatus(id, status)` → updates status field
- `getEntriesByStatus(status)` → filtered array
- `getEntriesNeedingEmbedding()` → entries where vectorId is null and status is active/pinned
- `setEntryVector(id, vectorId)` → sets vectorId reference
- `generateId()` → `ml_entry_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
- `routeEntry(entry)` → determines destination folder based on category + primaryCharacters:
  - Single primary + character category → that character's subfolder (auto-create if needed)
  - 2+ primaries + character category → Group subfolder
  - World/Plot category → user-specified folder

#### data/folders.js
- `getDefaultFolders()` → returns the three mandatory top-level folders: World, Characters, Plot
- `initDefaultFolders()` → ensures the three default folders exist in storage
- `createFolder(data)` → folder object with generated ID
- `getFolder(id)` → folder object
- `getAllFolders()` → flat array
- `getTopLevelFolders()` → folders where parentId is null
- `getSubfolders(parentId)` → child folders
- `updateFolder(id, updates)`
- `deleteFolder(id)` → also deletes all entries in the folder
- `getOrCreateCharacterSubfolder(charName)` → finds or creates a character subfolder under Characters
- `incrementEntryCount(folderId)` / `decrementEntryCount(folderId)`
- `generateId()` → `ml_folder_${Date.now()}_${random}`

#### data/scenes.js
- `createScene(messageStart)` → scene object with id `ml_scene_${messageStart}`, status "open"
- `closeScene(sceneId, messageEnd)` → sets messageEnd, status "closed", returns scene
- `getOpenScene()` → scene with status "open" or null
- `getScene(id)` → scene object
- `getAllScenes()` → array
- `updateSceneSummary(id, summary)` → sets llmSummary
- `updateSceneTitle(id, title)` → sets title
- `deleteScene(id)`
- `isMessageInScene(scene, mesId)` → boolean (checks messageStart ≤ mesId ≤ messageEnd)
- `getScenesForConsolidation()` → returns scenes eligible for consolidation (closed, not already consolidated)
- `initSceneCounter()` → ensures scene counter is initialized in chat metadata

---

### Slice 5: Library Tab

**File:** `ui/library.js`

This is the largest UI file. It renders the folder tree, memory entries list, scene summaries, and all modals.

- Export `renderLibraryTab($pane)`:
  - Renders segmented control: Memories | Scenes
  - When Memories is selected:
    - Shows New Entry + New Folder buttons
    - Shows filter bar: search input, sort dropdown, folder filter dropdown
    - Renders folder tree:
      - Each top-level folder is a collapsible `.folder`
      - World folder: globe icon, shows memory entries directly
      - Characters folder: users icon, contains character subfolders
      - Plot folder: scroll icon, shows memory entries + consolidation entries
      - User-created primary folders: no special icon
      - Character subfolders (`.char-subfolder`):
        - If `hasImage`: renders banner image with gradient overlay
        - Renders character info row: name, stats line (N memories · last updated X)
        - Image upload button + New entry button
        - Memory entries listed below
      - Each memory entry is a collapsible row: title, date, preview (2-line clamp), tags
      - Expanded memory shows: full prose, character list, edit/delete buttons
      - Status badges shown on entry cards
      - Consolidation entries get distinct left border accent
  - When Scenes is selected:
    - Hides New Entry + New Folder buttons
    - Shows scene info notice
    - Renders scene entries: scene number, title, message range, collapsible body with editable summary textarea
- Export `toggleMem(id)` — expand/collapse memory entry
- Export `openNewEntryModal()` — shows the New Entry modal
- Export `openNewFolderModal()` — shows the New Folder modal
- Export `deleteEntry(id)` — confirmation + removal
- Export `editEntry(id)` — opens entry for editing
- Export `openCrop(folderId)` — opens crop dialog for character banner

**New Entry Modal** (inline in library.js or separate):
- Title field + expand button
- Date/Time field + expand button
- Content textarea + expand button
- Category dropdown (Character / World / Plot)
- Folder datalist input + expand button
- Primary character(s) tag input (comma-separated, converts to tags)
- Key characters tag input (Enter or comma to add)
- Routing preview (updates live as fields change)
- Auto-tag assist button (calls autoTag.js)
- Save / Cancel buttons
- On save: creates entry via `data/entries.js`, auto-embeds, auto-routes

**New Folder Modal:**
- Folder name input
- Level pill selector: Primary / Subfolder
- Subfolder parent picker (only shown for Subfolder)
- Type-specific preview text
- Create / Cancel buttons

---

### Slice 6: Settings Tab

**File:** `ui/settings.js`

- Export `renderSettingsTab($pane)`:
  - Renders accordion sections:
    1. **Connections** (open by default):
       - Memory writer LLM dropdown
       - Consolidation LLM dropdown
       - Keyword sidecar LLM dropdown
       - All populated from `getConnectionProfiles()` (ST's connection profile system)
    2. **Scanning**:
       - Scan frequency dropdown (Every message / Every 3 / Every 5)
    3. **Memory Writing**:
       - Folder suggestions toggle
       - Scene summary prompt textarea + expand button
       - Memory entry prompt textarea + expand button
    4. **Injection**:
       - Inject matched memories toggle
       - Injection placement dropdown (Above card / Below card / Top / Bottom)
       - Max entries per message number input
    5. **Vectorization**:
       - Embedding source dropdown (ST's vector sources: openai, ollama, vllm, transformers, etc.)
       - Embedding model text input (model name for the selected source)
       - Alt endpoint toggle + URL input (for local/custom embedding servers)
       - Similarity threshold number input (default: 0.75)
       - Query source dropdown (Sidecar keywords / Raw recent messages)
       - Raw advanced settings sub-panel (shown when Raw is selected):
         - Scan depth, Chunk size, Overlap tokens, Top-k results
         - Distance metric dropdown (Cosine / Dot product / Euclidean)
         - Re-rank results toggle
       - Default stickiness number input (0 = use global default)
       - Default cooldown number input (0 = use global default)
       - Embedding batch size number input (items per insert batch)
    6. **Data**:
       - Undo last scan button + last scan indicator
       - Memory decay toggle → expands sub-panel:
         - Decay mode dropdown (Linear / Exponential / Step)
         - Decay start number input
         - Minimum priority number input
         - Exempt pinned entries toggle
       - Batch scan button
       - Import all / Export all buttons

- All settings changes save via `setSetting()` which triggers `saveSettingsDebounced()`
- All textareas get expand buttons
- Accordion toggle: `this.parentElement.classList.toggle('open')`

---

### Slice 7: LLM Layer

**Files:** `llm/connections.js`, `llm/sidecar.js`, `llm/writer.js`, `llm/consolidator.js`, `llm/autoTag.js`

#### llm/connections.js
- `getConnectionProfiles()` → array of `{name, id}` from ST's connection manager
- `getConnectionProfile(name)` → single profile object
- `makeRequest(profileId, systemPrompt, userPrompt, maxTokens, temperature?)` → response string or null
  - Uses `ConnectionManagerRequestService.sendRequest()` (5-arg pattern from RST)
  - Handles reasoning model response formats (content vs reasoning field)
  - Rate limiter with exponential backoff retry
  - Sets `_mlInternalGen` flag during request to prevent self-injection
- `RateLimiter` class (copied from RST, adapted for ML)
- `updateRateLimiterSettings(batchSettings)`

#### llm/sidecar.js
- `extractKeywords()`:
  - Gets recent messages from chat (last N, configurable)
  - Calls sidecar LLM with a system prompt instructing it to extract:
    - Character names present or referenced
    - Key themes/topics
    - Recent events referenced
    - Emotional/relational dynamics at play
  - Returns a structured list of keywords/phrases
  - NEVER extracts keywords for {{user}}
- The sidecar prompt must be hardcoded and not user-configurable
- Returns: `{ keywords: string[], characters: string[], themes: string[] }`

#### llm/writer.js
- `generateSceneSummary(sceneId)`:
  - Gets all messages in the scene's message range
  - Gets all previous closed scene summaries as context
  - Calls Memory Writer LLM with scene summary prompt from settings
  - Returns summary string (INTERNAL ONLY — never injected)
  - Stores summary on the scene object
- `generateMemoryEntries(sceneId)`:
  - Uses scene summary + full scene messages as context
  - Calls Memory Writer LLM with memory entry prompt from settings
  - LLM returns structured JSON array of proposed entries
  - Each entry includes: title, datetime, content, primaryCharacter(s), keyCharacters, delta block, suggested tags, suggested folder
  - NEVER generates entries for {{user}}
  - Flags low-delta entries
  - Returns array of pending entry objects
  - Stores in `savePendingEntries()`
- `generateSingleEntry(entryData, guidance?)` — for regeneration
- `parseWriterResponse(responseText)` → array of entry objects (handles JSON extraction from LLM output)

#### llm/consolidator.js
- `generateConsolidation(sources, mode)`:
  - mode: "selected" | "folder" | "mixed"
  - Gathers source entries + scene summaries
  - Calls Consolidation LLM with consolidation prompt
  - Returns consolidation draft object matching Consolidation Entry data structure
  - Must NOT include open_threads, future_questions, or suggested_next_steps
  - Expresses unresolved context as present state
- `parseConsolidationResponse(responseText)` → consolidation object

#### llm/autoTag.js
- `suggestTags(content)`:
  - Calls Memory Writer LLM (or a smaller model) with the entry content
  - Returns array of suggested tag strings
  - User can accept or modify

---

### Slice 8: Embedding Layer

**Files:** `embed/embedder.js`, `embed/retriever.js`

**APPROACH:** Use ST's native vector API (`/api/vector/insert`, `/api/vector/query`, `/api/vector/delete`) —
the SAME pattern proven by VectFox. Embedding AND storage are handled server-side by ST's Vectra
database. Memory Loom manages its own collection and just sends text; the server handles
embedding model selection, vectorization, and similarity search.

This is cleaner than the lightweight fallback because:
- No need to store/load/manage Float32Arrays in chat_metadata
- Similarity search is done server-side (more efficient at scale)
- VectFox proves this API is stable and usable by third-party extensions
- The `utils/vector-distance.js` module from ST-Helpers (found in VectFox) provides pure-JS
  cosine similarity, dot product, and Euclidean distance for any client-side post-processing

**Collection ID:** `ml_memory_{chatUUID}` — one collection per chat, built from `chat_metadata.integrity`
(follows VectFox's pattern in `core/collection-ids.js`)

**Embedding settings** (separate from LLM connection profiles — embedding uses ST's vector source system):
```js
embedding: {
    source: 'openai',           // ST vector source (openai, ollama, vllm, transformers, etc.)
    model: '',                  // model name for the source (e.g. 'text-embedding-3-small')
    useAltEndpoint: false,      // use custom endpoint URL
    altEndpointUrl: '',         // custom endpoint URL
    insertBatchSize: 10,        // items per batch insert
    rateLimitCalls: 0,          // 0 = disabled
    rateLimitInterval: 60,      // seconds
}
```

#### embed/embedder.js

Uses ST's vector API pattern (proven by VectFox's `core-vector-api.js` and `backends/standard.js`):

- `embedEntry(entry)`:
  - Builds embedding text from: `[title]\n[datetime]\n[content]\nPrimary: [chars]\nKey: [chars]`
  - Hashes the text using `getStringHash()` (imported from `../../../../utils.js`)
  - Calls `insertVectorItems(collectionId, [{hash, text}], mlSettings)` which POSTs to `/api/vector/insert`
  - The server handles: embedding model selection → vectorization → Vectra storage
  - Updates entry's `vectorHash` field with the hash (for later deletion/re-embedding)
- `deleteEntryVector(entry)`:
  - Calls `deleteVectorItems(collectionId, [entry.vectorHash], mlSettings)` → POSTs to `/api/vector/delete`
- `reEmbedEntry(entry)`:
  - Deletes old vector hash, then re-embeds with new content hash (used after edits)
- `batchEmbedEntries(entries, onProgress)`:
  - Chunks entries into batches (configurable size from settings)
  - Inserts each batch via the vector API with rate limiting
  - Reports progress via callback
- `getEmbeddingText(entry)` → combined text string for embedding
- `buildVectorRequestBody(args, mlSettings)` → builds source/model/URL/provider params
  (mirrors VectFox's `getVectorsRequestBody()` pattern)
- `throwIfEmbeddingSourceInvalid(mlSettings)` → validates API key/URL/model before requests
- `getCollectionId()` → builds `ml_memory_{chatUUID}` from `chat_metadata.integrity`

#### embed/retriever.js

- `runRetrievalPipeline()` — called after each sidecar keyword extraction:
  1. Get sidecar keywords from `extractKeywords()` (in llm/sidecar.js)
  2. Join keywords into a query string
  3. POST to `/api/vector/query` with collection ID + query text + topK + threshold
  4. Server handles: embed query text → cosine similarity against all stored vectors → return ranked results
  5. Results come back as `{ hashes: number[], metadata: object[] }` where metadata includes similarity scores
  6. Map hashes back to entry IDs (lookup by vectorHash in storage)
  7. Apply stickiness: currently-sticky entries always pass regardless of score
  8. Apply cooldown: entries in cooldown period are skipped
  9. Apply decay multiplier to scores (if decay is enabled in settings)
  10. Sort by adjusted score descending
  11. Take top N (maxEntriesPerMessage from settings)
  12. Call `updateInjection(candidates)` in inject/promptInjector.js
- `queryCollection(collectionId, searchText, topK, threshold, mlSettings)`:
  - Builds request body with source/model params
  - POSTs to `/api/vector/query`
  - Returns `{ hashes, metadata }`
- `getStickyEntries()` → entry IDs currently within stickiness window
- `getCooldownEntries()` → entry IDs currently in cooldown
- `recordInjection(entryId)` — records that entry was injected now (for stickiness tracking)
- `startCooldown(entryId)` — begins cooldown timer for recently-injected entry
- `applyDecay(entry, baseScore)` → adjusted score after decay formula (linear/exponential/step, uses scene age)

---

### Slice 9: Injection

**File:** `inject/promptInjector.js`

- Uses `setExtensionPrompt()` from ST's script.js (same pattern as RST)
- `updateInjection(candidates)`:
  - Builds injection block from candidate entries
  - Format: markdown with entry title, date, prose content, delta
  - Uses configured placement (above_card / below_card / top / bottom)
  - Registers with `PROMPT_ID = "ml-memory-injection"`
  - Also registers preview key at IN_PROMPT for visibility in Prompt inspector
- `removeInjection()`:
  - Clears the prompt block
- `buildInjectionBlock(entries)` → string:
  - Groups entries by primary character
  - Formats as markdown with dividers
  - Includes entry title, date, prose body, delta summary
- `getInjectionPlacement()` → ST position constant (0/1/2)
- Internal generation guard (`_mlInternalGen`) to prevent self-injection during ML's own LLM calls (matches RST pattern)
- `setMLInternalGen(val)` — exported for connections.js to use

---

### Slice 10: Message Action Buttons

**Implemented in:** `index.js`

- `addMessageButtons(mesId)`:
  - Finds `.extraMesButtons` on the message with given mesId
  - Checks if button already exists (no duplicates)
  - Determines button state:
    - If message is in a closed scene → **fa-book** (locked, unscannable)
    - If message is in the currently open scene → **fa-feather** (scene open, click to close)
    - Otherwise → **fa-book-open** (unscanned, click to open scene)
  - Creates button element with inline SVG icon (NOT font-awesome)
  - Adds click handler:
    - fa-book-open: calls `createScene(mesId)`, updates button states
    - fa-feather: calls `closeScene(openScene.id, mesId)`, triggers writer flow
    - fa-book: no action (disabled)
  - Appends button to message bar
- Uses inline SVG icons from `lib/icons.js`
- Buttons re-added on `CHAT_CHANGED` and `APP_READY` events
- `refreshAllMessageButtons()` — iterates all `.mes` elements, adds buttons where missing

---

### Slice 11: Scene Management Workflow

**Implemented across:** `index.js`, `data/scenes.js`, `llm/writer.js`, `ui/home.js`

Flow:
1. User clicks **fa-book-open** on message N → `createScene(N)` → stores open scene
2. All messages from N to latest get **fa-feather** buttons
3. User clicks **fa-feather** on message M → `closeScene(openScene.id, M)`
4. Writer flow triggers:
   a. Show panel loading indicator ("Generating scene summary...")
   b. `generateSceneSummary(sceneId)` — calls Memory Writer LLM
   c. Show panel loading indicator ("Generating memory entries...")
   d. `generateMemoryEntries(sceneId)` — calls Memory Writer LLM
   e. Store pending entries via `savePendingEntries()`
   f. Hide loading indicator
   g. Show toast: "Memory entries ready for review"
   h. Refresh Home tab to show pending cards
5. User reviews on Home tab:
   - Expand/collapse entry cards
   - Commit individual entries (auto-embed + auto-route)
   - Regenerate with optional guidance
   - Edit before commit
   - Discard
   - Commit All / Discard All
6. On commit: entry moves from pending to committed storage, folder tree updates, embedding runs

---

### Slice 12: Modals

**Implemented in:** `ui/library.js`

**New Entry Modal** (`#ml-new-entry-modal`):
- Fields: Title, Date/Time, Content, Category, Folder, Primary character(s), Key characters
- Dynamic routing preview
- Auto-tag assist button
- All fields have expand popout buttons
- On save: create entry, auto-embed, auto-route, close modal

**New Folder Modal** (`#ml-new-folder-modal`):
- Fields: Folder name, Level (Primary/Subfolder pills), Parent (for subfolders)
- Dynamic preview of folder type and buttons
- On create: create folder, refresh library

**Crop Dialog** (`#ml-crop-modal`):
- Copied from RST's crop implementation
- Aspect ratio locked to banner (wide rectangle: 648×110 ratio)
- Drag to reposition, corner handles for aspect-locked resize
- Mouse + touch event support via `getXY()` helper
- Skip crop / Crop & save / Cancel buttons
- On apply: crops image to canvas, stores as data URL, updates character subfolder's banner

---

### Slice 13: Consolidation Workflow

**Implemented across:** `data/consolidations.js`, `llm/consolidator.js`, `ui/library.js`

- User enters consolidation mode from Library tab
- Three modes:
  1. **Consolidate Selected**: user checks entries + scenes
  2. **Consolidate Folder**: user picks a folder
  3. **Consolidate Mixed Scope**: user picks multiple folders + entry types
- Flow:
  1. User selects sources
  2. Call `generateConsolidation(sources, mode)` → consolidation draft
  3. Show draft for review with edit capability
  4. On commit:
     - Store in Plot folder
     - Apply `status_updates` to source entries (active → consolidated)
     - Auto-embed the consolidation entry
- Consolidation entries display with green left-border accent in Library
- `data/consolidations.js`:
  - `createConsolidation(data)` → consolidation object
  - `getConsolidation(id)` / `getAllConsolidations()`
  - `updateConsolidation(id, updates)`
  - `deleteConsolidation(id)`
  - `applyStatusUpdates(updates[])` → updates source entry statuses

---

### Slice 14: Batch Scan + Decay + Undo

**Batch Scan** (`llm/batchScan.js` or in `index.js`):
- Triggered from Settings → Data → "Run batch scan"
- Auto-detects scene boundaries by analyzing message gaps/topic shifts
- For each detected scene: creates scene record, generates summary, generates entries
- Creates character subfolders for any unrecognized names
- Non-compounding — checks for existing data, won't duplicate
- Shows progress indicator during scan
- After completion: "Undo Last Scan" subtext changes to "cannot undo a batch scan"

**Memory Decay** (in `embed/retriever.js`):
- Applied during retrieval pipeline
- For each candidate entry:
  - Calculate entry age (in scenes since creation)
  - If age < decayStart: no decay
  - If age ≥ decayStart: apply decay formula based on mode
    - Linear: `priority = 1.0 - (age - decayStart) * rate`
    - Exponential: `priority = e^(-rate * (age - decayStart))`
    - Step: `priority = stepFunction(age)`
  - Clamp to minimumPriority floor
  - Skip if entry is pinned and exemptPinned is true
  - Multiply similarity score by priority

**Undo Last Scan** (in `index.js` or `data/scenes.js`):
- Stores reference to most recent scene closure
- On undo: removes scene record, removes associated entries, restores message button states
- Disabled after batch scan (button remains visible but disabled)

---

### Slice 15: Import/Export + Slash Commands + Magic Wand

**Import/Export** (in `settings.js` or `data/storage.js`):
- `exportAllData()` → JSON blob with all entries, folders, scenes, consolidations, settings
- `importAllData(jsonString)` → parses and restores, overwrites existing
- Triggered from Settings → Data buttons

**Magic Wand Menu Entry** (in `index.js`):
- Registers entry in `#extensionsMenu` (same pattern as RST)
- Clicking toggles a standalone floating popup (TypefaceR pattern)
- Popup contains the full ML panel content
- Draggable via ST's `dragElement()`

**Slash Commands** (placeholder in `index.js`):
- `/ml-scan` — trigger a manual sidecar scan
- `/ml-close-scene` — close the current open scene
- `/ml-inject` — show currently injected memories
- (These can be expanded later)

---

### Slice 16: Integration Testing

- Verify all files load without errors
- Verify manifest.json is valid
- Verify panel appears in ST's extensions area
- Verify tab switching works
- Verify settings save/load correctly
- Verify message buttons appear and cycle states correctly
- Verify scene open/close flow
- Verify LLM calls succeed with real connection profiles
- Verify embedding and retrieval pipeline
- Verify injection appears in system prompt
- Verify consolidation workflow
- Verify all modals open/close correctly
- Verify crop dialog works with mouse and touch
- Cross-reference every UI element against mockup for visual fidelity
- Verify all expand buttons are present on textareas
- Verify inline SVG icons render correctly

---

## Key Design Decisions

1. **Namespace**: `"ml"` throughout (extension_settings.ml, chat_metadata.ml)
2. **Storage pattern**: Matches RST — global settings in `extension_settings`, per-chat data in `chat_metadata`
3. **LLM calls**: Via `ConnectionManagerRequestService.sendRequest()` (5-arg pattern)
4. **Injection**: Via `setExtensionPrompt()` with `PROMPT_ID` constant
5. **UI pattern**: ST's `extension_container` + `inline-drawer` (identical to RST)
6. **Message buttons**: Appended to `.extraMesButtons`, use inline SVG not FA
7. **Icons**: Inline SVG symbols defined once, referenced via `<use href="#icon-name"/>`
8. **Expand buttons**: `class="editor_maximize"` + `data-for="[id]"` — ST handles popout natively
9. **Typography**: Lora for prose, IBM Plex Mono for UI, never mix
10. **Colors**: Monochrome + functional color only, use ST CSS variables where possible

## Files NOT to modify

- Any files outside the `MemoryLoom/` directory
- ST core files (`script.js`, `extensions.js`, etc.)
- Other extensions' files
