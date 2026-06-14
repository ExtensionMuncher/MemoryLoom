/**
 * ui/panel.js — Builds and manages the Memory Loom extension panel
 *
 * Creates the main UI shell using ST's extension_container + inline-drawer pattern.
 * The panel has three tabs: Home, Library, Settings. Each tab has its own pane
 * that is shown/hidden when the user switches tabs.
 *
 * Pattern: follows relationship-stat-tracker's ui/panel.js structure exactly.
 */

import { isEnabled, toggleEnabled, isSidecarPaused, setSidecarPaused } from "../settings.js";

// ─── Tab Definitions ──────────────────────────────────────

/**
 * Tab configuration.
 * Each tab has an id (used for CSS classes and DOM IDs) and a display label.
 * The order here determines the tab order in the UI.
 */
const TABS = [
    { id: "home", label: "Home" },
    { id: "library", label: "Library" },
    { id: "settings", label: "Settings" },
];

// ─── Panel Creation ───────────────────────────────────────

/**
 * Create the main Memory Loom panel.
 *
 * Uses ST's standard extension panel pattern:
 *   extension_container > inline-drawer > inline-drawer-toggle + inline-drawer-content
 *
 * The panel is appended to #extensions_settings, which is ST's built-in
 * container for extension panels in the extensions drawer.
 *
 * @returns {jQuery} The panel's shell element (for appending tab content)
 */
export function createPanel() {
    // Build the full panel structure using ST's extension_container pattern
    const $container = $(`
        <div id="ml_container" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Memory Loom</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="ml-shell"></div>
                </div>
            </div>
            <!-- Persistent loading overlay — shown during long operations (scene summary, batch scan) -->
            <div id="ml-loading-overlay" class="ml-loading-overlay" style="display:none">
                <div class="ml-loading-content">
                    <div class="ml-loading-spinner"></div>
                    <div id="ml-loading-text">Processing...</div>
                </div>
            </div>
        </div>
    `);

    const $shell = $container.find(".ml-shell");

    // ── Build tab bar ────────────────────────────────────
    const $tabs = $('<div class="ml-tabs"></div>');
    TABS.forEach((tab, i) => {
        const $tab = $(`<div class="ml-tab${i === 0 ? " on" : ""}">${tab.label}</div>`);
        $tab.on("click", () => switchTab(tab.id));
        $tabs.append($tab);
    });
    $shell.append($tabs);

    // ── Build tab panes ──────────────────────────────────
    TABS.forEach((tab, i) => {
        const $pane = $(`<div id="ml-p-${tab.id}" class="ml-pane${i === 0 ? " on" : ""}"></div>`);
        $shell.append($pane);
    });

    // ── Append to ST's extensions settings area ──────────
    $("#extensions_settings").append($container);

    console.log("[ML] Panel created");
    return $shell;
}

// ─── Tab Switching ─────────────────────────────────────────

/**
 * Switch to a specific tab.
 * Updates the tab button active state, shows the corresponding pane,
 * and triggers a custom event so tab-specific code can refresh its content.
 *
 * @param {string} tabId - Tab identifier: "home", "library", or "settings"
 */
export function switchTab(tabId) {
    // Update tab button active states
    $(".ml-tab").removeClass("on");
    const tabIndex = TABS.findIndex((t) => t.id === tabId);
    if (tabIndex >= 0) {
        $(".ml-tab").eq(tabIndex).addClass("on");
    }

    // Show the correct pane, hide all others
    $(".ml-pane").removeClass("on");
    $(`#ml-p-${tabId}`).addClass("on");

    // Trigger refresh event so tab content renderers can update
    $(document).trigger("ml:tab-switched", [tabId]);
}

/**
 * Get the jQuery element for a specific tab's content pane.
 * Used by tab renderers to target where they should render.
 *
 * @param {string} tabId
 * @returns {jQuery}
 */
export function getPane(tabId) {
    return $(`#ml-p-${tabId}`);
}

/**
 * Get the ID of the currently active tab.
 * @returns {string}
 */
export function getActiveTab() {
    const $activeTab = $(".ml-tab.on");
    const index = $(".ml-tab").index($activeTab);
    return TABS[index]?.id || "home";
}

// ─── Home Tab Header ──────────────────────────────────────

/**
 * Render the Home tab's header row with the enable/disable toggle.
 *
 * This header shows:
 *   - "Memory Loom" title
 *   - Status text ("Extension enabled" or "Extension disabled")
 *   - Toggle switch to enable/disable the entire extension
 *
 * Replaces any existing header to avoid duplicates on re-render.
 *
 * @param {jQuery} $pane - The Home tab pane element
 */
export function renderHomeHeader($pane) {
    const enabled = isEnabled();
    const statusText = enabled ? "Extension enabled" : "Extension disabled";

    // Remove existing header to prevent duplicates
    $pane.find("#ml-header-wrap").remove();

    const $header = $(`
        <div id="ml-header-wrap" class="ml-control-row">
            <div>
                <div class="ml-control-label">Memory Loom</div>
                <div id="ml-ext-status" class="ml-control-sub">${statusText}</div>
            </div>
            <label class="ml-toggle">
                <input type="checkbox" ${enabled ? "checked" : ""}>
                <span class="ml-slider"></span>
            </label>
        </div>
    `);

    // Wire up the toggle switch
    $header.find("input").on("change", function () {
        const newState = $(this).prop("checked");
        toggleEnabled(newState);
        $("#ml-ext-status").text(newState ? "Extension enabled" : "Extension disabled");
        // Notify index.js to update injection and button visibility
        $(document).trigger("ml:toggle", [newState]);
    });

    $pane.prepend($header);
}

// ─── Keyword Sidecar Control Row ──────────────────────────

/**
 * Render the keyword sidecar pause/resume control row.
 * Shows current sidecar status and a button to pause or resume.
 *
 * @param {jQuery} $pane - The Home tab pane element
 */
export function renderSidecarControl($pane) {
    const paused = isSidecarPaused();
    const statusText = paused ? "Paused · injections suspended" : "Running · every message";
    const buttonText = paused ? "Resume" : "Pause";

    // Remove existing to prevent duplicates
    $pane.find("#ml-sidecar-wrap").remove();

    const $row = $(`
        <div id="ml-sidecar-wrap" class="ml-control-row" style="border-bottom:none">
            <div>
                <div class="ml-control-label">Keyword sidecar</div>
                <div id="ml-sidecar-status" class="ml-control-sub">${statusText}</div>
            </div>
            <button id="ml-sidecar-btn" class="ml-btn">${buttonText}</button>
        </div>
    `);

    // Wire up the pause/resume button
    $row.find("#ml-sidecar-btn").on("click", function () {
        const currentlyPaused = isSidecarPaused();
        setSidecarPaused(!currentlyPaused);
        // Re-render to update text
        renderSidecarControl($pane);
    });

    // Insert after the header wrap (or at top if no header)
    const $header = $pane.find("#ml-header-wrap");
    if ($header.length) {
        $header.after($row);
    } else {
        $pane.prepend($row);
    }
}


// ─── Processing Status Flag ───────────────────────────────
// Set while a long writer operation runs (scene close, batch scan). Home tab
// reads this to show a persistent "processing" banner — same visual weight as
// the pending-entries banner — so the user knows ML is still working even if
// toasts were missed.
let processingStatus = null;
export function setProcessingStatus(text) {
    processingStatus = text || null;
    // live-update the banner if Home is currently rendered
    const $b = $("#ml-processing-banner");
    if (processingStatus && $b.length) $b.find(".ml-proc-text").text(processingStatus);
}
export function getProcessingStatus() {
    return processingStatus;
}

// ─── Loading Indicator ────────────────────────────────────

let loadingTimeout = null;

/**
 * Show a persistent loading overlay on the ML panel.
 * Used during long operations like scene summary generation, memory entry
 * generation, and batch scanning. The overlay survives tab switches.
 *
 * @param {string} [message="Processing..."] - Status message to display
 */
export function showPanelLoading(message = "Processing...") {
    clearTimeout(loadingTimeout);
    const $overlay = $("#ml-loading-overlay");
    if ($overlay.length) {
        $("#ml-loading-text").text(message);
        $overlay.fadeIn(150);
    }
}

/**
 * Hide the persistent loading overlay.
 */
export function hidePanelLoading() {
    clearTimeout(loadingTimeout);
    const $overlay = $("#ml-loading-overlay");
    if ($overlay.length) {
        $overlay.fadeOut(150);
    }
}
