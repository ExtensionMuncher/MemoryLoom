import { getChatData } from "../data/storage.js";
import { chat_metadata } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";

/** Capture before async work; call immediately before resuming chat-specific work. */
export function captureChatGuard() {
    const metadata = chat_metadata;
    const id = getContext()?.chatId;
    const data = getChatData();
    return () => {
        if (id == null || id === "" || getContext()?.chatId !== id || chat_metadata !== metadata || chat_metadata?.ml !== data) {
            const error = new Error("Memory Loom operation cancelled: active chat or data changed.");
            error.name = "MLStaleChatError";
            throw error;
        }
    };
}
