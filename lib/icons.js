/**
 * lib/icons.js — Inline SVG icon definitions for Memory Loom
 *
 * All icons are defined as inline SVG <symbol> elements and injected into the
 * document once on extension load. Individual icons are rendered using the
 * iconSvg() helper function which returns an <svg> element referencing a symbol.
 *
 * WHY INLINE SVG: Font Awesome CDN is unreliable in SillyTavern on both PC and
 * mobile. Inline SVGs render consistently and don't require external network
 * requests. The SVG definitions are copied exactly from memory-loom-mockup.html.
 */

// ─── SVG Symbol Definitions ───────────────────────────────

/**
 * Raw HTML string containing all SVG <symbol> definitions.
 * Injected once into the document body on extension load.
 * Each symbol has a unique ID that is referenced via <use href="#id"/>.
 */
export const SVG_DEFS = `
<svg style="display:none" xmlns="http://www.w3.org/2000/svg" id="ml-svg-defs">
  <!-- Book-open: used for the "unscanned" message action button state -->
  <symbol id="ico-book-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
  </symbol>
  <!-- Feather: used for the "scene open" message action button state -->
  <symbol id="ico-feather" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/>
  </symbol>
  <!-- Book (closed): used for the "scanned/locked" message action button state -->
  <symbol id="ico-book" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
  </symbol>
  <!-- Chevron-down: generic expand/collapse indicator -->
  <symbol id="ico-chevron-down" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="6 9 12 15 18 9"/>
  </symbol>
  <!-- Chevron-right: used for subfolder expand indicators -->
  <symbol id="ico-chevron-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </symbol>
  <!-- Reader: used as the Memory Loom wordmark icon in the header -->
  <symbol id="ico-reader" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
  </symbol>
  <!-- Plus: used on "New entry" and "Add" buttons -->
  <symbol id="ico-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </symbol>
  <!-- Folder-plus: used on "New folder" button -->
  <symbol id="ico-folder-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
  </symbol>
  <!-- Globe: icon for the World folder -->
  <symbol id="ico-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </symbol>
  <!-- Users: icon for the Characters folder -->
  <symbol id="ico-users" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </symbol>
  <!-- Scroll: icon for the Plot folder -->
  <symbol id="ico-scroll" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
  </symbol>
  <!-- Image: used on character image upload buttons -->
  <symbol id="ico-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
  </symbol>
  <!-- Trash: used on delete/discard buttons -->
  <symbol id="ico-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
  </symbol>
  <symbol id="ico-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
  </symbol>
  <!-- Sort: used on the library sort dropdown -->
  <symbol id="ico-sort" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
  </symbol>
</svg>`;

// ─── Icon Rendering Helper ─────────────────────────────────

/**
 * Generate an inline SVG element that references a symbol from the defs.
 *
 * Usage:
 *   iconSvg("ico-book-open", 18, 18, "#bbb")
 *   → '<svg class="ico" width="18" height="18" style="color:#bbb"><use href="#ico-book-open"/></svg>'
 *
 * @param {string} name - Icon symbol ID (without the # prefix), e.g. "ico-book-open"
 * @param {number} [width=16] - SVG width in pixels
 * @param {number} [height=16] - SVG height in pixels
 * @param {string} [color] - CSS color value for the icon (applied via style attribute)
 * @returns {string} HTML string for the SVG element
 */
export function iconSvg(name, width = 16, height = 16, color = null) {
    const colorAttr = color ? ` style="color:${color}"` : "";
    return `<svg class="ico" width="${width}" height="${height}"${colorAttr}><use href="#${name}"/></svg>`;
}

/**
 * Inject the SVG symbol definitions into the document body.
 * Called once during extension initialization.
 * Safe to call multiple times — checks if defs already exist before injecting.
 */
export function injectSvgDefs() {
    if (document.getElementById("ml-svg-defs")) {
        return; // Already injected
    }
    const temp = document.createElement("div");
    temp.innerHTML = SVG_DEFS;
    document.body.appendChild(temp.firstElementChild);
    console.log("[ML] SVG icon definitions injected");
}
