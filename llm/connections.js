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

    async executeWithRetry(profileId, fn) {
        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            await this.acquire(profileId);
            try {
                return await fn();
            } catch (err) {
                lastError = err;
                if (attempt >= this.maxRetries) break;
                if (!isRetryable(err)) throw err;
                const delay = Math.min(this.baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000, this.maxDelayMs);
                console.log(`[ML] Retry ${attempt + 1}/${this.maxRetries} for "${profileId}" in ${Math.ceil(delay)}ms`);
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

let _mlInternalGen = false;
export function setMLInternalGen(val) { _mlInternalGen = val; }
export function isMLInternalGen() { return _mlInternalGen; }

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
export async function makeRequest(profileKey, systemPrompt, userPrompt, maxTokens = 500, temperature = null) {
    if (!profileKey) {
        toastr?.warning?.('No connection profile selected. Check Settings > Connections.');
        return null;
    }

    // Resolve profile name → full profile object → extract UUID
    // This is the critical step: sendRequest needs profile.id (UUID), not the display name
    const profile = resolveProfile(profileKey);
    if (!profile) {
        console.warn(`[ML] makeRequest — profile not found: "${profileKey}". Check Settings > Connections.`);
        toastr?.warning?.(`Connection profile "${profileKey}" not found. Check Settings > Connections.`);
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
        const softOn = (noThinkMap && typeof noThinkMap === "object")
            ? !!noThinkMap[profile.id]
            : legacySoft;
        const hardOn = (noThinkHardMap && typeof noThinkHardMap === "object")
            ? !!noThinkHardMap[profile.id]
            : legacyHard;

        const response = await rateLimiter.executeWithRetry(profile.id, async () => {
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

            // Pass profile.id (UUID) — this is what ST's sendRequest requires
            return await ConnectionManagerRequestService.sendRequest(
                profile.id,
                messages,
                maxTokens,
                // includePreset pulled in the connection profile's full prompt list — which
                // includes the character card — bloating every request and leaking context
                // we explicitly removed. Send only our own messages.
                { includePreset: false, includeInstruct: false, stream: false },
                overridePayload,
            );
        });

        if (typeof response === 'string') return response;
        if (response && typeof response === 'object') {
            if (response.choices?.[0]?.message?.content !== undefined) {
                const choice    = response.choices[0];
                const content   = choice.message.content;
                const reasoning = choice.message.reasoning;
                // NEVER fall back to reasoning as if it were the answer. Thinking
                // models (e.g. Gemma via Ollama) put their scratchpad in `reasoning`
                // and the real answer in `content`. If content is empty, the model
                // spent its entire token budget thinking and got cut off — returning
                // the reasoning here is what produced "summaries" full of
                // "Wait, let me check the prompt again".
                if (!content && reasoning) {
                    const cutOff = choice.finish_reason === 'length';
                    const why = cutOff
                        ? 'it spent the entire token budget on reasoning and was cut off before answering'
                        : 'it returned only reasoning with an empty answer';
                    console.error(`[ML] "${profile.name}" is a thinking model and ${why}. ` +
                        'Use a non-thinking model for this role, or raise the token limit.');
                    toastr?.error?.(`"${profile.name}" returned only reasoning, no answer — likely a thinking model. Try a non-thinking model for this role.`);
                    return null;
                }
                return content || '';
            }
            if (response.content !== undefined) {
                if (!response.content && response.reasoning) {
                    console.error(`[ML] "${profile.name}" returned only reasoning with an empty answer. Use a non-thinking model or raise the token limit.`);
                    toastr?.error?.(`"${profile.name}" returned only reasoning, no answer.`);
                    return null;
                }
                return response.content || '';
            }
            if (response.response) return response.response;
        }
        console.warn('[ML] Unexpected response format:', response);
        return null;

    } catch (err) {
        console.error(`[ML] LLM request failed for "${profile.name}":`, err);
        toastr?.error?.(`LLM request failed for "${profile.name}". Check console for details.`);
        return null;
    } finally {
        setMLInternalGen(false);
    }
}
