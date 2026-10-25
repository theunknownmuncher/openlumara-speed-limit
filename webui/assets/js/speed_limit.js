/* speed-limit -- Copyright (C) 2026 theunknownmuncher <theunknownmuncher@protonmail.com>
 * SPDX-License-Identifier: GPL-3.0-or-later
 * See the LICENSE file for the full GPL-3.0 text.
 */
/* -- AI GENERATED CODE (Qwen3.8 Flash Next) :: (2026-10-25) harness:openlumara
 * speed-limit: a visual speed limit for live text streaming in the webui.
 *
 * The model still generates at full speed and the backend still broadcasts
 * every token immediately — this script only paces how fast the chat REVEALS
 * the text. It wraps the core websocket message handler (handleWebSocketMessage
 * from js/services/websockets.js, a global function in a classic script) and
 * buffers streamed text, dripping it into the Alpine store at the configured
 * characters/minute. Every paced stream type has its own on/off limit toggle
 * and its own rate:
 *
 *   content    message output          (segment.content)
 *   reasoning  thinking text           (segment.reasoning_content)
 *   tool:<name> tool call text         (_metadata.args_parsed values and
 *                                      _metadata.response, per tool, with an
 *                                      optional per-tool override that can use
 *                                      another rate or drop the limit itself;
 *                                      tools without one use the global tool
 *                                      rate/toggle)
 *
 * A limit toggle that is off, or a rate of 0, means "no limit" for that stream
 * type: its text is revealed as soon as it arrives.
 *
 * Process steps are never affected: EVERY turn_stream message is forwarded to
 * the store the moment it arrives, so the agent chain's structure — step
 * numbers, step_status transitions, tool cards, the final-content split and
 * the expand/collapse choreography that reads all of it — stays exactly on
 * the backend's timing. Only the paced TEXT FIELDS inside the forwarded copy
 * are truncated to the revealed length and then grow on the reveal timer.
 * When the stream moves on to a new segment, the previous segment's reveal
 * snaps to its full text (a finalized step never keeps half-typed content,
 * mirroring what the store would hold without this module). The only
 * messages ever held back are stream_state idle and stream_complete, and
 * only until the last reveal has caught up, so the typing indicator stays
 * honest and the history handoff runs on fully revealed text.
 *
 * Why truncation is safe: every turn_stream message carries the FULL
 * accumulated content of the current segment, so a growing prefix is exactly
 * what the store already sees mid-generation. Tool argument rows render from
 * the backend's leniently parsed _metadata.args_parsed object; a partially
 * revealed copy is the same shape the backend itself stamps while arguments
 * are still streaming (complete keys, the boundary key sliced).
 *
 * Settings: initial values arrive as window.SPEED_LIMIT_CONFIG (head-slot
 * template), then update live — the module broadcasts {type:
 * "speed_limit_config"} whenever its settings are saved, and the pacer also
 * refreshes from /api/ext/speed-limit/config at the start of every stream as
 * a safety net. No page reload needed.
 */
(function () {
    'use strict';

    const original = window.handleWebSocketMessage;
    if (typeof original !== 'function') return; // core ws layer not loaded (login page): stay out of the way

    const STREAM_TYPES = ['content', 'reasoning', 'tool'];
    const PACED_TYPES = { content: 1, reasoning: 1, tool_calls: 1 };

    // ---- live settings ---------------------------------------------------
    const settings = {
        enabled: false,
        limits: { content: true, reasoning: true, tool: true }, // false = stream at full speed
        rates: { content: 9000, reasoning: 9000, tool: 9000 },     // characters/minute, 0 = no limit
        toolOverrides: {},                                      // tool -> {rate, enabled}
    };

    function toRate(value, fallback) {
        const n = +value;
        return Number.isFinite(n) ? Math.max(0, n) : fallback;
    }

    // per-tool override as {rate, enabled}; tolerates the older shape where
    // an override was just a number (meaning "limited at this rate")
    function normalizeOverride(value) {
        if (value && typeof value === 'object') {
            return { rate: toRate(value.rate, 0), enabled: value.enabled !== false };
        }
        return { rate: toRate(value, 0), enabled: true };
    }

    function applyConfig(cfg) {
        if (!cfg || typeof cfg !== 'object') return;
        if ('enabled' in cfg) settings.enabled = !!cfg.enabled;

        // older payloads had no per-type toggles: keep the "limited" default
        const limits = cfg.limits;
        if (limits && typeof limits === 'object') {
            for (const key of STREAM_TYPES) {
                if (key in limits) settings.limits[key] = !!limits[key];
            }
        }

        const rates = cfg.rates;
        if (rates && typeof rates === 'object') {
            for (const key of STREAM_TYPES) {
                if (key in rates) settings.rates[key] = toRate(rates[key], settings.rates[key]);
            }
        }

        if (cfg.toolOverrides && typeof cfg.toolOverrides === 'object') {
            const overrides = {};
            for (const [name, value] of Object.entries(cfg.toolOverrides)) {
                if (!name) continue;
                overrides[String(name)] = normalizeOverride(value);
            }
            settings.toolOverrides = overrides;
        }

        // let the sidebar panel (and anything else) mirror the new settings
        try { window.dispatchEvent(new CustomEvent('speed-limit-config', { detail: cfg })); } catch (e) {}
    }

    function refreshConfig() {
        if (typeof simpleApiFetch !== 'function') return;
        try {
            Promise.resolve(simpleApiFetch('/api/ext/speed-limit/config')).then(applyConfig).catch(function () {});
        } catch (e) {}
    }

    applyConfig(window.SPEED_LIMIT_CONFIG || {});
    refreshConfig();

    // effective characters/minute for a pool key; 0 = unlimited
    function rateFor(poolKey) {
        if (poolKey === 'content') return settings.limits.content ? settings.rates.content : 0;
        if (poolKey === 'reasoning') return settings.limits.reasoning ? settings.rates.reasoning : 0;
        if (poolKey.indexOf('tool:') === 0) {
            const override = settings.toolOverrides[poolKey.slice(5)];
            if (override) return override.enabled ? override.rate : 0;
            return settings.limits.tool ? settings.rates.tool : 0;
        }
        return 0;
    }

    // ---- reveal bookkeeping ------------------------------------------------
    const TICK_MS = 50;

    let chain = Promise.resolve(); // serialized deliveries (see header comment)
    let timer = null;
    let lastTick = 0;
    let pools = new Map();         // poolKey -> {budget} — fractional character allowance

    // the one segment whose text is still being revealed:
    // {ident, seg (latest cumulative snapshot), units, done}
    let active = null;
    // end-of-stream messages (stream_state idle, stream_complete) waiting on
    // the active reveal; released in arrival order once it finishes
    let held = [];
    // last delivered revealed-lengths per segment identity, so a segment that
    // resumes after finishing (or gets re-yielded with merged tool responses)
    // continues where the store already is instead of retyping from zero
    let lensCache = new Map();

    function str(v) { return typeof v === 'string' ? v : ''; }

    function identOf(seg) { return seg.type + '|' + (seg.tool_call_id === undefined ? '' : seg.tool_call_id); }

    // the text the tool call arg rows render for a parsed arg value
    function displayText(value) {
        if (value !== null && typeof value === 'object') {
            try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
        }
        if (typeof value === 'string') return value;
        if (value === null || value === undefined) return '';
        return String(value);
    }

    // args_parsed copy as it looks after `revealed` display characters:
    // whole keys up to the budget, the boundary key sliced when it is a
    // string (non-string values only appear once fully affordable)
    function truncatedArgs(parsed, revealed) {
        const out = {};
        let budget = revealed;
        for (const key in parsed) {
            if (budget <= 0) break;
            const value = parsed[key];
            const text = displayText(value);
            if (text.length <= budget) {
                out[key] = value;
                budget -= text.length;
            } else {
                if (typeof value === 'string') out[key] = value.slice(0, budget);
                break;
            }
        }
        return out;
    }

    function toolCallId(call, index) { return call.id || ('#' + index); }

    // the paced text units of a segment. Each unit: {key, poolKey, fullLen, revealed}
    // plus, for plain text segments, the segment field to truncate.
    function buildUnits(seg, seedLens) {
        const units = [];

        if (seg.type === 'content' || seg.type === 'reasoning') {
            const field = seg.type === 'content' ? 'content' : 'reasoning_content';
            units.push({ key: seg.type, poolKey: seg.type, field: field, fullLen: str(seg[field]).length });
        } else if (seg.type === 'tool_calls') {
            const calls = Array.isArray(seg.tool_calls) ? seg.tool_calls : [];
            calls.forEach(function (call, i) {
                const id = toolCallId(call, i);
                const meta = (call && call._metadata) || null;
                const name = (meta && meta.display_name) || (call && call.function && call.function.name) || '';
                const poolKey = 'tool:' + name;

                let argsLen = 0;
                const parsed = meta && meta.args_parsed;
                if (parsed && typeof parsed === 'object') {
                    for (const key in parsed) argsLen += displayText(parsed[key]).length;
                }
                units.push({ key: 'args:' + id, poolKey: poolKey, args: true, fullLen: argsLen });

                const response = meta && str(meta.response);
                if (response) units.push({ key: 'resp:' + id, poolKey: poolKey, resp: true, callIndex: i, fullLen: response.length });
            });
        }

        if (seedLens) {
            for (const unit of units) {
                if (Number.isFinite(seedLens[unit.key])) unit.revealed = Math.min(seedLens[unit.key], unit.fullLen);
            }
        }
        for (const unit of units) if (!Number.isFinite(unit.revealed)) unit.revealed = 0;
        return units;
    }

    // refresh the active segment against the latest cumulative snapshot,
    // keeping the revealed progress of every unit (clamped to the new text)
    function refreshUnits(item) {
        const previous = {};
        for (const unit of item.units) previous[unit.key] = unit.revealed;
        const fresh = buildUnits(item.seg);
        for (const unit of fresh) {
            if (Number.isFinite(previous[unit.key])) unit.revealed = Math.min(previous[unit.key], unit.fullLen);
        }
        item.units = fresh;
    }

    // ---- delivery ----------------------------------------------------------
    function deliver(msg) {
        chain = chain.then(function () { return original(msg); })
                     .catch(function (e) { console.error('speed-limit: handler failed:', e); });
    }

    async function passthrough(data) {
        // reload-capable messages must not overtake deliveries already queued
        await chain;
        return original(data);
    }

    function cacheSet(ident, lens) {
        if (lensCache.size > 128) {
            const oldest = lensCache.keys().next().value;
            lensCache.delete(oldest);
        }
        lensCache.set(ident, lens);
    }

    function trackCopy(item) {
        const lens = {};
        for (const unit of item.units) lens[unit.key] = unit.revealed;
        cacheSet(item.ident, lens);
    }

    function allRevealed(item) {
        return item.units.every(function (u) { return u.revealed >= u.fullLen; });
    }

    function buildCopy(item) {
        const seg = item.seg;

        if (seg.type === 'tool_calls') {
            const units = {};
            for (const unit of item.units) units[unit.key] = unit;

            const calls = Array.isArray(seg.tool_calls) ? seg.tool_calls : [];
            const outCalls = calls.map(function (call, i) {
                const id = toolCallId(call, i);
                const argsUnit = units['args:' + id];
                const respUnit = units['resp:' + id];
                const meta = (call && call._metadata) || null;
                const parsed = meta && meta.args_parsed;
                const response = meta ? str(meta.response) : '';

                const argsCut = argsUnit && parsed && typeof parsed === 'object' && argsUnit.revealed < argsUnit.fullLen;
                const respCut = respUnit && response && respUnit.revealed < respUnit.fullLen;
                if (!argsCut && !respCut) return call;

                const copy = Object.assign({}, call);
                const copyMeta = Object.assign({}, meta);
                if (argsCut) copyMeta.args_parsed = truncatedArgs(parsed, argsUnit.revealed);
                if (respCut) copyMeta.response = response.slice(0, respUnit.revealed);
                copy._metadata = copyMeta;
                return copy;
            });

            const out = Object.assign({}, seg);
            out.tool_calls = outCalls;
            return out;
        }

        // plain text segment: truncate the growing field
        const unit = item.units[0];
        const out = Object.assign({}, seg);
        out[unit.field] = str(seg[unit.field]).slice(0, unit.revealed);
        return out;
    }

    function deliverCopy(item) {
        trackCopy(item);
        deliver({ type: 'turn_stream', turn: buildCopy(item) });
    }

    function deliverFinal(item) {
        // the latest authoritative snapshot: full text and every final field
        // (label, step_status, is_cmd, ...) land on the store exactly as they
        // would without us — remember it as fully revealed
        const lens = {};
        for (const unit of item.units) lens[unit.key] = unit.fullLen;
        cacheSet(item.ident, lens);
        deliver({ type: 'turn_stream', turn: item.seg });
    }

    // ---- reveal lifecycle ----------------------------------------------------
    function releaseHeld() {
        if (!held.length) return;
        const msgs = held;
        held = [];
        for (const msg of msgs) deliver(msg);
    }

    function finishActive() {
        // the reveal caught up: hand over the authoritative snapshot and let
        // the end-of-stream messages waiting on it through
        if (active && !active.done) {
            active.done = true;
            deliverFinal(active);
        }
        releaseHeld();
    }

    function snapActive() {
        // the stream moved on to a new segment: the previous one is final,
        // hand over its full text immediately (no more pacing for it)
        if (active && !active.done) {
            active.done = true;
            deliverFinal(active);
        }
        active = null;
        // held messages only arrive after the last segment; never let one sit
        // across a segment boundary if the backend reopens after completing
        releaseHeld();
    }

    // ---- reveal timer ------------------------------------------------------
    function start() {
        if (timer === null) {
            lastTick = performance.now();
            timer = setInterval(tick, TICK_MS);
        }
    }

    function stop() {
        if (timer !== null) { clearInterval(timer); timer = null; }
    }

    function tick() {
        const now = performance.now();
        const dtMinutes = (now - lastTick) / 60000;
        lastTick = now;

        if (!active || active.done) {
            releaseHeld();
            stop();
            pools.clear();
            return;
        }

        refreshUnits(active);
        const pending = active.units.filter(function (u) { return u.revealed < u.fullLen; });
        if (!pending.length) {
            finishActive();
            return;
        }

        // refill every pool feeding the active segment once (~3s worth cap:
        // a backgrounded tab must not dump a burst catch-up when resumed)
        let progressed = false;
        const refilled = new Set();
        for (const unit of pending) {
            const rate = rateFor(unit.poolKey);
            unit.rate = rate;
            if (rate <= 0) {
                unit.revealed = unit.fullLen; // unlimited: reveal at once
                progressed = true;
                continue;
            }
            let pool = pools.get(unit.poolKey);
            if (!pool) { pool = { budget: 0 }; pools.set(unit.poolKey, pool); }
            if (!refilled.has(unit.poolKey)) {
                pool.budget = Math.min(pool.budget + dtMinutes * rate, rate * 0.05 + 1);
                refilled.add(unit.poolKey);
            }
        }

        for (const unit of pending) {
            if (unit.revealed >= unit.fullLen || unit.rate <= 0) continue;
            const pool = pools.get(unit.poolKey);
            let chars = Math.floor(pool.budget);
            if (chars < 1) continue;
            chars = Math.min(chars, unit.fullLen - unit.revealed);
            unit.revealed += chars;
            pool.budget -= chars;
            progressed = true;
        }

        if (progressed) {
            if (allRevealed(active)) finishActive();
            else deliverCopy(active);
        }
    }

    function flush() {
        // deliver everything pending, in order (a new turn is starting: the
        // previous stream's handoff must still run cleanly)
        if (active && !active.done) {
            active.done = true;
            deliverFinal(active);
        }
        active = null;
        releaseHeld();
        stop();
        pools.clear();
    }

    function drop() {
        // pending reveals are stale: the store is about to be wiped/rebuilt
        active = null;
        held = [];
        lensCache.clear();
        stop();
        pools.clear();
    }

    // ---- message routing ---------------------------------------------------
    function onTurnStream(data) {
        const seg = data.turn;
        const pacedType = seg && PACED_TYPES[seg.type];

        if (!pacedType) {
            // not a revealable segment, but it still belongs on the live
            // store: finalize any reveal in flight before letting it through
            snapActive();
            return passthrough(data);
        }

        const ident = identOf(seg);

        if (active && active.ident === ident && !active.done) {
            // update of the segment being revealed: forward the fresh
            // structure right away (text stays truncated at the revealed
            // lengths), so nothing built on the chain waits on the reveal
            active.seg = seg;
            refreshUnits(active);
            if (allRevealed(active)) finishActive();
            else { deliverCopy(active); start(); }
            return;
        }

        // a different segment (or the previous reveal already finished):
        // the old segment is final from here on
        snapActive();

        const seed = lensCache.get(ident) || null;
        const units = buildUnits(seg, seed);
        const unlimited = !units.length || units.every(function (u) { return rateFor(u.poolKey) <= 0; });

        if (unlimited || units.every(function (u) { return u.revealed >= u.fullLen; })) {
            // nothing to reveal (unlimited rate, or already fully revealed
            // from a previous delivery): stock delivery. remember the full
            // lengths so a later limited update can't truncate below them
            const lens = {};
            for (const unit of units) lens[unit.key] = unit.fullLen;
            if (units.length) cacheSet(ident, lens);
            return passthrough(data);
        }

        // new segment: forward its structure immediately with the text at
        // the revealed lengths, then drip the rest on the reveal timer
        active = { ident: ident, seg: seg, units: units, done: false };
        deliverCopy(active);
        start();
    }

    window.handleWebSocketMessage = function (data) {
        const type = data && data.type;

        try {
            // live settings push from the module (settings were saved)
            if (type === 'speed_limit_config') { applyConfig(data.config); return Promise.resolve(); }

            if (!settings.enabled) return original(data);

            if (type === 'turn_stream') return onTurnStream(data);

            // hold the end-of-stream signals until the reveal has caught up:
            // keeps the typing indicator honest, keeps the native push guard
            // (stream.state !== idle) effective during the tail, and runs the
            // stream_complete history handoff on fully revealed text
            if (((type === 'stream_state' && data.state === 'idle') || type === 'stream_complete') &&
                active && !active.done) {
                held.push(data);
                return Promise.resolve();
            }

            if (type === 'user_message_added') { refreshConfig(); flush(); return passthrough(data); }
            if (type === 'sync' || type === 'chat_switched' || type === 'shutdown') { drop(); return passthrough(data); }
            if (type === 'token' && data.content && data.content.type === 'error') { drop(); return passthrough(data); }

            // stream_state (non-idle) and an unheld stream_complete still
            // must not overtake in-flight deliveries
            if (type === 'stream_state' || type === 'stream_complete') return passthrough(data);
        } catch (e) {
            console.error('speed-limit: wrapper error, reverting to stock streaming:', e);
            drop();
        }

        // transient bookkeeping (token, log, push, ready, ...): pass straight
        // through so processing indicators and audio stay snappy
        return original(data);
    };

    // a (re)connecting websocket invalidates anything still queued from the
    // old connection: the backend replays whatever is still live
    const originalConnect = window.connectWebSocket;
    if (typeof originalConnect === 'function') {
        window.connectWebSocket = function () {
            drop();
            return originalConnect.apply(this, arguments);
        };
    }

    function describe(short) {
        return settings.limits[short] ? settings.rates[short] + '/min' : 'unlimited';
    }

    console.log('speed-limit: webui reveal speed limit installed (content ' + describe('content') +
                ', reasoning ' + describe('reasoning') + ', tools ' + describe('tool') + ')');
})();
