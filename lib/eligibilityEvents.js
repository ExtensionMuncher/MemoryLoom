export const MEMORY_ELIGIBILITY_EVENT = "ml:memory-eligibility-changed";
let notificationQueued = false;

/**
 * Tell the runtime that the currently registered prompt may contain stale
 * memory data. This is deliberately a browser event instead of an import of
 * the prompt injector so data modules remain independent of UI/runtime code.
 */
export function notifyMemoryEligibilityChanged() {
    if (typeof document === "undefined" || typeof document.dispatchEvent !== "function") return;
    if (notificationQueued) return;
    notificationQueued = true;
    const dispatch = () => {
        notificationQueued = false;
        const EventCtor = globalThis.CustomEvent || globalThis.Event;
        if (EventCtor) document.dispatchEvent(new EventCtor(MEMORY_ELIGIBILITY_EVENT));
    };
    if (typeof queueMicrotask === "function") queueMicrotask(dispatch);
    else Promise.resolve().then(dispatch);
}
