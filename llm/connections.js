/**
 * llm/connections.js — ST connection profile integration for Memory Loom
 *
 * THE CORE BUG THIS FILE FIXES:
 * ConnectionManagerRequestService.sendRequest() expects the profile's internal
 * UUID, NOT its display name. We must resolve the profile object first, then
 * pass profile.id. Passing the display name causes "Profile not found (ID: X)".
 */

import { getContext } from "../../../../extensions.js";
import { ConnectionManagerRequestService } from "../../../../extensions/shared.js";
import { getSetting } from "../settings.js";

// ─── Rate Limiter ─────────────────────────────────────────

export class RateLimiter {
    constructor(options = {}) {
        this.requestsPerMinute = options.requestsPerMinute || 10;
        this.maxRetries = options.maxRetries ?? 3;
        this.baseDelayMs = options.baseDelayMs || 1000;
        this.maxDelayMs = 60000;
        this.windows = new Map();
    }

    async acquire(profileId) {
        const now = Date.now();
        if (!this.windows.has(profileId)) this.windows.set(profileId, []);
        const timestamps = this.windows.get(profileId);
        const cutoff = now - 60000;
        while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift();
        if (timestamps.length >= this.requestsPerMinute) {
            const waitMs = timestamps[0] + 60000 - now + 100;
            if (waitMs > 0) {
                console.log(`[ML] Rate limit for "${profileId}". Waiting ${Math.ceil(waitMs)}ms...`);
                await new Promise(r => setTimeout(r, waitMs));
                return this.acquire(profileId);
            }
        }
        this.windows.get(profileId).push(Date.now());
    }

    async executeWithRetry(profileId, fn, options = {}) {
        const maxRetries = Number.isFinite(options.maxRetries) ? Math.max(0, options.maxRetries) : this.maxRetries;
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            await this.acquire(profileId);
            try {
                return await fn();
            } catch (err) {
                lastError = err;
                if (attempt >= maxRetries) break;
                if (!isRetryable(err)) throw err;
                const delay = Math.min(this.baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000, this.maxDelayMs);
                console.log(`[ML] Retry ${attempt + 1}/${maxRetries} for "${profileId}" in ${Math.ceil(delay)}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastError;
    }
}

function isRetryable(err) {
    if (err?.status === 429 || err?.status === 502 || err?.status === 503 || err?.status === 0) return true;
    const msg = (err?.message || '').toLowerCase();
    return msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429') ||
        msg.includes('timeout') || msg.includes('timed out') ||
        msg.includes('network') || msg.includes('econnrefused') || msg.includes('bad gateway') ||
        msg.includes('service unavailable');
}

const rateLimiter = new RateLimiter({ requestsPerMinute: 6, baseDelayMs: 5000, maxRetries: 4 });

// ─── Profile Resolution ───────────────────────────────────

/**
 * Get all available connection profiles from ST's connection manager.
 * Returns minimal {name, id} pairs for dropdown population.
 */
export function getConnectionProfiles() {
    try {
        const ctx = getContext();
        const profiles = ctx.extensionSettings?.connectionManager?.profiles;
        if (!profiles) return [];
        return profiles.map(p => ({ name: p.name || 'Unnamed', id: p.id || p.name }));
    } catch {
        return [];
    }
}

/**
 * Resolve a profile by ID or display name — searches both fields.
 *
 * Settings store the profile's display name. ConnectionManagerRequestService
 * requires the internal UUID. This function bridges the gap by accepting either
 * and always returning the full profile object so callers can pass profile.id.
 *
 * @param {string} profileKey - Profile ID or display name from settings
 * @returns {object|null} Full ST profile object, or null if not found
 */
export function resolveProfile(profileKey) {
    if (!profileKey) return null;
    try {
        const ctx = getContext();
        const profiles = ctx.extensionSettings?.connectionManager?.profiles;
        if (!profiles?.length) return null;
        // Accept both UUID and display name — settings may store either
        return profiles.find(p => p.id === profileKey || p.name === profileKey) || null;
    } catch {
        return null;
    }
}

// ─── Internal Generation Flag ─────────────────────────────

let _mlInternalGenCount = 0;
export function setMLInternalGen(val) {
    _mlInternalGenCount = val
        ? _mlInternalGenCount + 1
        : Math.max(0, _mlInternalGenCount - 1);
}
export function isMLInternalGen() { return _mlInternalGenCount > 0; }

function withTimeout(promise, timeoutMs, label = "LLM request") {
    const ms = Number(timeoutMs) || 0;
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function hasOwn(object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Resolve a per-profile boolean while remaining compatible with the broken
 * v0.1.7 settings UI, which stored map entries under the display name even
 * though the request path looked them up by UUID.
 */
function getProfileToggle(map, profile, legacyValue) {
    if (map && typeof map === "object") {
        if (hasOwn(map, profile.id)) return !!map[profile.id];
        if (hasOwn(map, profile.name)) return !!map[profile.name];
        if (Object.keys(map).length > 0) return false;
    }
    return !!legacyValue;
}

function flattenResponseText(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        return value.map(flattenResponseText).filter(Boolean).join("");
    }
    if (value && typeof value === "object") {
        if (typeof value.text === "string") return value.text;
        if (typeof value.content === "string" || Array.isArray(value.content)) {
            return flattenResponseText(value.content);
        }
    }
    return "";
}

function extractResponseParts(response) {
    if (typeof response === "string") return { content: response, reasoning: "" };
    if (!response || typeof response !== "object") return { content: "", reasoning: "" };

    // Current SillyTavern Connection Manager returns ExtractedData directly.
    // The remaining paths preserve compatibility with older/raw adapters.
    const contentCandidates = [
        response.content,
        response.text,
        response.response,
        response.generated_text,
        response.message?.content,
        response.data?.content,
        response.data?.text,
        response.data?.response,
        response.result?.content,
        response.result?.text,
        response.choices?.[0]?.message?.content,
        response.choices?.[0]?.text,
        response.data?.choices?.[0]?.message?.content,
        response.data?.choices?.[0]?.text,
    ];
    const reasoningCandidates = [
        response.reasoning,
        response.reasoning_content,
        response.message?.reasoning,
        response.message?.reasoning_content,
        response.data?.reasoning,
        response.data?.reasoning_content,
        response.result?.reasoning,
        response.result?.reasoning_content,
        response.choices?.[0]?.message?.reasoning,
        response.choices?.[0]?.message?.reasoning_content,
        response.data?.choices?.[0]?.message?.reasoning,
        response.data?.choices?.[0]?.message?.reasoning_content,
    ];
    const firstText = (values) => {
        for (const value of values) {
            const text = flattenResponseText(value);
            if (text.trim()) return text;
        }
        return "";
    };
    return { content: firstText(contentCandidates), reasoning: firstText(reasoningCandidates) };
}

// ─── Core Request ─────────────────────────────────────────

/**
 * Make an LLM request via a named connection profile.
 *
 * @param {string} profileKey - Profile display name or UUID from settings
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} [maxTokens=500]
 * @param {number|null} [temperature=null]
 * @returns {Promise<string|null>}
 */
export async function makeRequest(profileKey, systemPrompt, userPrompt, maxTokens = 500, temperature = null, options = {}) {
    if (!profileKey) {
        if (!options?.suppressToasts) toastr?.warning?.('No connection profile selected. Check Settings > Connections.');
        return null;
    }

    // Resolve profile name → full profile object → extract UUID
    // This is the critical step: sendRequest needs profile.id (UUID), not the display name
    const profile = resolveProfile(profileKey);
    if (!profile) {
        console.warn(`[ML] makeRequest — profile not found: "${profileKey}". Check Settings > Connections.`);
        if (!options?.suppressToasts) toastr?.warning?.(`Connection profile "${profileKey}" not found. Check Settings > Connections.`);
        return null;
    }

    console.log(`[ML] makeRequest — profile: "${profile.name}" (${profile.id}) maxTokens: ${maxTokens}`);

    if (!userPrompt && !systemPrompt) {
        console.warn('[ML] makeRequest — no prompt content provided');
        return null;
    }

    setMLInternalGen(true);
    try {
        // Per-profile no-think resolution. The setting is keyed by profile ID so
        // each connection profile can independently enable reasoning suppression
        // (e.g. local Qwen sidecar off-thinking while a cloud writer keeps it).
        // Backward-compat: the old blanket booleans (connections.noThink /
        // .noThinkHard), if still true, apply to ALL profiles until the user sets
        // any per-profile value — so existing setups keep working unchanged.
        const noThinkMap = getSetting("connections.noThinkProfiles", null);
        const noThinkHardMap = getSetting("connections.noThinkHardProfiles", null);
        const legacySoft = getSetting("connections.noThink", false);
        const legacyHard = getSetting("connections.noThinkHard", false);
        const softOn = getProfileToggle(noThinkMap, profile, legacySoft) || options.preferNoThink === true;
        const hardOn = getProfileToggle(noThinkHardMap, profile, legacyHard);

        const requestPromise = rateLimiter.executeWithRetry(profile.id, async () => {
            const messages = [];
            if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
            // No-think soft switch: append "/no_think" to the END of the USER
            // message (reliable in the user turn; latest instruction wins).
            // Harmless to models that don't recognize it.
            let finalUser = userPrompt || "";
            if (softOn) {
                finalUser = (finalUser ? finalUser + "\n\n" : "") + "/no_think";
            }
            if (finalUser) messages.push({ role: 'user', content: finalUser });

            const overridePayload = { max_tokens: maxTokens };
            if (temperature !== null) overridePayload.temperature = temperature;

            // No-think HARD switch (per-profile, opt-in). Some backends ERROR on
            // unknown body keys, so this is only sent when explicitly enabled for
            // this profile. Sends the common forms; tolerant backends ignore keys
            // they don't recognize (think=Ollama, chat_template_kwargs=vLLM, etc).
            if (hardOn) {
                overridePayload.think = false;
                overridePayload.enable_thinking = false;
                overridePayload.chat_template_kwargs = Object.assign(
                    {}, overridePayload.chat_template_kwargs, { enable_thinking: false }
                );
            }

            // Pass profile.id (UUID) — this is what ST's sendRequest requires.
            return await ConnectionManagerRequestService.sendRequest(
                profile.id,
                messages,
                maxTokens,
                // Keep the generation preset disabled: it can pull the profile's full
                // prompt list (including the character card) into this isolated helper
                // request. Keep instruct formatting ENABLED, however. On ST text-
                // completion profiles (Ollama, llama.cpp, etc.) Connection Manager uses
                // the profile's instruct template to turn our system/user messages into a
                // valid chat prompt with an assistant-generation prefix. Disabling it
                // reduced the request to raw concatenated prose and could yield empty or
                // reasoning-only answers from chat-tuned local models.
                { includePreset: false, includeInstruct: true, stream: false },
                overridePayload,
            );
        }, { maxRetries: options.maxRetries });

        const response = await withTimeout(requestPromise, options.timeoutMs, `ML request for "${profile.name}"`);

        const { content, reasoning } = extractResponseParts(response);
        if (content.trim()) return content;

        const task = options?.requestLabel ? ` for ${options.requestLabel}` : "";
        if (reasoning.trim()) {
            // Connection Manager's ExtractedData deliberately omits finish_reason,
            // so we cannot truthfully claim that the token limit was exhausted.
            // Keep private reasoning out of saved memories and report only what is
            // known: the provider supplied no visible answer.
            console.error(`[ML] "${profile.name}" returned reasoning but no visible answer${task}. ` +
                `Reasoning suppression: soft=${softOn}, hard=${hardOn}.`);
            if (!options?.suppressToasts) {
                toastr?.error?.(`"${profile.name}" returned reasoning but no final answer${task}. Memory Loom did not save the private reasoning.`);
            }
            return null;
        }

        console.warn(`[ML] Empty or unexpected response${task}:`, response);
        if (!options?.suppressToasts) toastr?.error?.(`"${profile.name}" returned no answer${task}.`);
        return null;

    } catch (err) {
        console.error(`[ML] LLM request failed for "${profile.name}":`, err);
        if (!options?.suppressToasts) toastr?.error?.(`LLM request failed for "${profile.name}". Check console for details.`);
        return null;
    } finally {
        setMLInternalGen(false);
    }
}
