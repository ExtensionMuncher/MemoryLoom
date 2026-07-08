/**
 * lib/lorebookImport.js — EXPERIMENTAL lorebook memory importer
 *
 * Parses memories out of a SillyTavern lorebook (world info) JSON and turns
 * them into Memory Loom entries. Built against a curated "memory book"
 * structure where each lorebook entry's content holds one memory:
 *
 *   # CORE MEMORY
 *   **Title**: The First Cage
 *   **Date**: An afternoon in early spring, age 7.
 *   <narrative body>
 *   **Primary Character**: Jane Doe
 *   **Key Character(s)**: John Smith
 *   ---
 *
 * Parsing is deliberately tolerant: label spacing variants ("**Date **:"),
 * label aliases (Date/Time, Key Characters, Context/Memory bodies), and a
 * comment-line fallback ("Name | Type | Title") for entries that are missing
 * explicit Title/Primary labels. Joint memories ("A & B") become
 * multi-primary entries, which Memory Loom routes to the Group folder.
 *
 * EXPERIMENTAL: there are a million ways to structure a memory book — this
 * targets one meticulous format and degrades gracefully on everything else
 * (unparseable entries are skipped and reported, never half-imported).
 */

import { resolveCanonicalCharacter } from "../data/folders.js";

/**
 * Field-label aliases → canonical field. Matched case-insensitively against
 * whatever sits between ** ** before a colon.
 */
const LABEL_MAP = [
    [/^title$/i, "title"],
    [/^date(\s*\/\s*time)?$/i, "datetime"],
    [/^(date\s*&\s*time|datetime|time)$/i, "datetime"],
    [/^primary\s+character(\(s\)|s)?$/i, "primary"],
    [/^key\s+character(\(s\)|s)?$/i, "key"],
    [/^context$/i, "context"],
    [/^memory$/i, "memory"],
];

function canonLabel(raw) {
    const t = String(raw || "").trim();
    for (const [re, name] of LABEL_MAP) {
        if (re.test(t)) return name;
    }
    return null;
}

/**
 * Parse a single lorebook entry's content + comment into entry data.
 * Returns null if no memory structure could be found.
 */
function parseLorebookEntry(content, comment) {
    const text = String(content || "");
    if (!text.trim()) return null;

    // Find every "**Label**:" occurrence with its position. Tolerates spaces
    // inside the bold markers ("**Date **:").
    const labelRe = /\*\*\s*([^*\n]+?)\s*\*\*\s*:/g;
    const found = [];
    let m;
    while ((m = labelRe.exec(text)) !== null) {
        const name = canonLabel(m[1]);
        found.push({ name, raw: m[1], start: m.index, valueStart: m.index + m[0].length });
    }

    // Field value spans:
    //   - context/memory hold the narrative BODY → value runs to the next
    //     label or EOF (multi-line)
    //   - everything else (title, date, primary, key) is single-line metadata
    //     → value stops at end of line. Critical: in the standard layout the
    //     narrative sits between the Date line and the Primary line — letting
    //     Date run to the next label would swallow the whole narrative.
    const MULTILINE = new Set(["context", "memory"]);
    function fieldEnd(i) {
        const nextLabel = i + 1 < found.length ? found[i + 1].start : text.length;
        if (MULTILINE.has(found[i].name)) return nextLabel;
        const nl = text.indexOf("\n", found[i].valueStart);
        return nl === -1 ? nextLabel : Math.min(nl, nextLabel);
    }
    const fields = {};
    for (let i = 0; i < found.length; i++) {
        if (!found[i].name) continue;
        const val = text.slice(found[i].valueStart, fieldEnd(i)).trim();
        // first label wins if duplicated
        if (!(found[i].name in fields)) fields[found[i].name] = val;
    }

    // ── Comment fallback: "Primary Name | Type | Title" ──
    const commentParts = String(comment || "").split("|").map(s => s.trim()).filter(Boolean);
    const commentPrimary = commentParts.length >= 1 ? commentParts[0] : "";
    const commentTitle = commentParts.length >= 3 ? commentParts[commentParts.length - 1] : "";

    const title = (fields.title || commentTitle || "").replace(/\*+/g, "").trim();
    const datetime = (fields.datetime || "").replace(/\*+/g, "").trim();
    const primaryRaw = (fields.primary || commentPrimary || "").replace(/\*+/g, "").trim();
    const keyRaw = (fields.key || "").replace(/\*+/g, "").trim();

    if (!primaryRaw) return null; // a memory with no owner isn't importable

    // ── Narrative body ──
    let narrative = "";
    if (fields.memory) {
        // Context/Memory structured variant — keep context as a lead-in
        narrative = fields.context ? `${fields.context}\n\n${fields.memory}` : fields.memory;
    } else {
        // Standard variant: everything that isn't a labeled metadata line.
        // Cut the known single-line metadata spans out of the text, then strip
        // the "# CORE MEMORY" header and trailing rules.
        const cutRanges = [];
        for (let i = 0; i < found.length; i++) {
            if (!found[i].name || MULTILINE.has(found[i].name)) continue;
            // cut only the label's own line — the narrative between labels stays
            cutRanges.push([found[i].start, fieldEnd(i)]);
        }
        cutRanges.sort((a, b) => a[0] - b[0]);
        let body = "", cursor = 0;
        for (const [s, e] of cutRanges) {
            body += text.slice(cursor, s);
            cursor = e;
        }
        body += text.slice(cursor);
        narrative = body
            .replace(/^#+\s*CORE\s+MEMOR(Y|IES)\s*$/gim, "")
            .replace(/^\s*-{3,}\s*$/gm, "")
            .trim();
    }
    if (!narrative) return null;

    // ── Names: joint primaries on "&"/" and ", keys on commas/"&" ──
    const primaries = primaryRaw
        .split(/\s*&\s*|\s+and\s+/i)
        .map(s => resolveCanonicalCharacter(s.trim()))
        .filter(Boolean);
    const keyCharacters = keyRaw
        ? keyRaw.split(/\s*[,&]\s*/).map(s => resolveCanonicalCharacter(s.trim())).filter(Boolean)
        : [];

    return {
        title: title || "Imported memory",
        datetime,
        content: narrative,
        primaryCharacter: primaries.length === 1 ? primaries[0] : primaries,
        keyCharacters,
        category: "character",
        tags: ["lorebook-import"],
        source: "lorebook_import",
    };
}

/**
 * Parse a whole lorebook JSON object.
 * @param {object} json - parsed lorebook file
 * @returns {{ parsed: Array, skipped: number, total: number }}
 */
export function parseLorebook(json) {
    const entries = json?.entries;
    if (!entries || typeof entries !== "object") {
        return { parsed: [], skipped: 0, total: 0 };
    }
    const list = Array.isArray(entries) ? entries : Object.values(entries);
    const parsed = [];
    let skipped = 0;
    for (const e of list) {
        try {
            const data = parseLorebookEntry(e?.content, e?.comment);
            if (data) parsed.push(data);
            else skipped++;
        } catch (err) {
            console.warn("[ML] Lorebook import: entry failed to parse:", err);
            skipped++;
        }
    }
    return { parsed, skipped, total: list.length };
}
