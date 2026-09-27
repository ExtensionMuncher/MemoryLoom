/**
 * Return true only for ordinary user/assistant narrative messages.
 *
 * IMPORTANT: SillyTavern overloads `is_system: true` for *hidden chat
 * messages* (see hideChatMessageRange in ST 1.18), so that flag by itself is
 * NOT evidence that a message is a real system/tool record. Historical RP that
 * has been hidden for context management must remain available to Memory Loom
 * scans. We therefore identify actual utility/system records from their
 * stronger markers instead.
 */
export function isNarrativeMessage(message) {
    if (!message || typeof message !== "object") return false;
    if (typeof message.mes !== "string" || !message.mes.trim()) return false;
    if (message.owner_extension || message.extension_id || message.from_extension) return false;
    if (message.tool_calls || message.tool_call_id || message.tool_invocations || message.function_call) return false;

    const extra = message.extra && typeof message.extra === "object" ? message.extra : {};
    if (extra.hidden || extra.is_tool || extra.tool_call || extra.tool_calls || extra.tool_result || extra.tool_invocations) return false;
    if (extra.summary || extra.is_summary || extra.summarized || extra.memory_summary) return false;
    if (extra.isSmallSys === true && !message.is_user) return false;

    const kind = String(message.role || message.type || extra.type || extra.message_type || extra.source || extra.role || "").toLowerCase();
    if (/(tool|function|tracker|summary|summarized|utility|extension|injection|prompt|context)/.test(kind)) return false;

    const name = String(message.name || "").trim().toLowerCase();
    if (/\b(tool|system|summary|summarizer|tracker)\b/.test(name) && !message.is_user) return false;

    // A nameless, non-user `is_system` record has no character identity to
    // anchor it as hidden narrative, so keep treating that legacy shape as a
    // utility/system record. Hidden ordinary assistant messages retain the
    // character name and pass above.
    if (message.is_system === true && !message.is_user && !name) return false;

    return true;
}

export function narrativeMessages(messages) {
    return Array.isArray(messages) ? messages.filter(isNarrativeMessage) : [];
}
