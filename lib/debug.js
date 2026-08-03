/**
 * lib/debug.js — Debug-mode console logging and session-only diagnostics
 *
 * dlog() writes to the F12 console ONLY when Settings > Debug > logging is
 * turned on. Retrieval traces keep only the most recent passive-recall run in
 * memory so the Debug panel can explain why candidates were selected, filtered,
 * or capped without adding any prompt tokens or extra LLM calls.
 */

import { getSetting } from "../settings.js";

let _lastRetrievalTrace = null;
const RETRIEVAL_TRACE_EVENT = "ml:retrieval-trace-updated";

export function dlog(...args) {
    if (getSetting("debug.enabled", false)) {
        console.log("%c[ML debug]", "color:#c9a227;font-weight:bold", ...args);
    }
}

/** Store the latest passive-retrieval explanation for this browser session. */
export function publishRetrievalTrace(trace) {
    _lastRetrievalTrace = trace || null;
    if (typeof document !== "undefined" && typeof CustomEvent !== "undefined") {
        document.dispatchEvent(new CustomEvent(RETRIEVAL_TRACE_EVENT, {
            detail: _lastRetrievalTrace,
        }));
    }
}

/** Return the most recently captured passive-retrieval explanation. */
export function getLastRetrievalTrace() {
    return _lastRetrievalTrace;
}

/** Clear stale diagnostics (used manually and when switching chats). */
export function clearLastRetrievalTrace() {
    publishRetrievalTrace(null);
}
