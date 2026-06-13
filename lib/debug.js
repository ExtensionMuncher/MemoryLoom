/**
 * lib/debug.js — Debug-mode console logging
 *
 * dlog() writes to the F12 console ONLY when Settings > Debug > logging is
 * turned on. Used to make the sidecar → retriever → injector pipeline fully
 * observable without digging through the ST server's command prompt window.
 */

import { getSetting } from "../settings.js";

export function dlog(...args) {
    if (getSetting("debug.enabled", false)) {
        console.log("%c[ML debug]", "color:#c9a227;font-weight:bold", ...args);
    }
}
