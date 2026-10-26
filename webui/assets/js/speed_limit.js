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
 *   content    message output          (step.content and the final answer
 *                                      bubble's content, turn_final)
 *   reasoning  thinking text           (step.reasoning_content)
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
 * Protocol note: since the step-grouping move to core (upstream commit
 * c47b8d4), the backend no longer broadcasts turn_stream segments. It ships
 * cumulative snapshots instead:
 *
 *   {type: "turn_step",  step: {...}}      one step, keyed by step.step,
 *                                          carrying reasoning_content,
 *                                          content and tool_calls
 *   {type: "turn_final", messages: [...]}  the provisional final answer
 *                                          bubble; [] retracts it back into
 *                                          the chain
 *
 * Process steps are never affected: EVERY turn_step / turn_final message is
 * forwarded to the store the moment it arrives, so the agent chain's structure
 * — step numbers, status transitions, tool cards, the final-content split and
 * the expand/collapse choreography that reads all of it — stays exactly on
 * the backend's timing. Only the paced TEXT FIELDS inside the forwarded copy
 * are truncated to the revealed length and then grow on the reveal timer.
 * When the stream moves on (a new step number, or the final bubble taking
 * over), the previous segment's reveal snaps to its full text (a finalized
 * step never keeps half-typed content, mirroring what the store would hold
 * without this module). Text that slides back from the final bubble into a
 * step (a retraction) continues revealing where it left off instead of
 * retyping from zero. The only messages ever held back are stream_state idle
 * and stream_complete, and only until the last reveal has caught up, so the
 * typing indicator stays honest and the stream_complete history handoff runs
 * on fully revealed text.
 *
 * Why truncation is safe: every snapshot carries the FULL accumulated text of
 * the object it updates (render-by-full-replacement), so a growing prefix is
 * exactly what the store already sees mid-generation. Tool argument rows
 * render from the backend's leniently parsed _metadata.args_parsed object; a
 * partially revealed copy is the same shape the backend itself stamps while
 * arguments are still streaming (complete keys, the boundary key sliced).
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
    const FINAL_IDENT = 'final';

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
    // {ident, kind ('step'|'final'), seg (latest cumulative snapshot), units, done}
    let active = null;
    // end-of-stream messages (stream_state idle, stream_complete) waiting on
    // the active reveal; released in arrival order once it finishes
    let held = [];
    // last delivered revealed-lengths per segment identity, so a segment that
    // resumes after finishing (or gets re-emitted with late tool responses)
    // continues where the store already is instead of retyping from zero.
    // Step numbers restart with every stream, so this cache is cleared at the
    // start of each one (stream_state message_sending) and on sync/flush/drop.
    let lensCache = new Map();

    function str(v) { return typeof v === 'string' ? v : ''; }

    function identOfStep(step) { return 'step:' + step.step; }

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

    // the paced text units of a snapshot. Each unit: {key, poolKey, fullLen, revealed}
    // plus, for plain text fields, the field to truncate.
    // kind 'step':  seg is the step object; kind 'final': seg is the messages array.
    function buildUnits(kind, seg, seedLens) {
        const units = [];

        if (kind === 'final') {
            const msg = Array.isArray(seg) ? seg[0] : null;
            units.push({ key: 'final', poolKey: 'content', field: 'content', fullLen: str(msg && msg.content).length });
        } else {
            units.push({ key: 'reasoning', poolKey: 'reasoning', field: 'reasoning_content', fullLen: str(seg.reasoning_content).length });
            units.push({ key: 'content', poolKey: 'content', field: 'content', fullLen: str(seg.content).length });

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
        const fresh = buildUnits(item.kind, item.seg);
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

    function wrapMsg(item, seg) {
        return item.kind === 'final'
            ? { type: 'turn_final', messages: seg }
            : { type: 'turn_step', step: seg };
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

        if (item.kind === 'final') {
            const unit = item.units.find(function (u) { return u.key === 'final'; });
            const msg = Array.isArray(seg) ? seg[0] : null;
            if (!msg || !unit || unit.revealed >= unit.fullLen) return seg;
            const copy = Object.assign({}, msg);
            copy.content = str(msg.content).slice(0, unit.revealed);
            return [copy].concat(seg.slice(1));
        }

        const out = Object.assign({}, seg);

        // step text fields: truncate whatever is still mid-reveal
        for (const unit of item.units) {
            if (unit.field && unit.revealed < unit.fullLen) {
                out[unit.field] = str(seg[unit.field]).slice(0, unit.revealed);
            }
        }

        const calls = Array.isArray(seg.tool_calls) ? seg.tool_calls : [];
        if (calls.length) {
            const units = {};
            for (const unit of item.units) units[unit.key] = unit;

            out.tool_calls = calls.map(function (call, i) {
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
        }

        return out;
    }

    function deliverCopy(item) {
        trackCopy(item);
        deliver(wrapMsg(item, buildCopy(item)));
    }

    function deliverFinal(item) {
        // the latest authoritative snapshot: full text and every final field
        // (label, status, is_cmd, ...) land on the store exactly as they
        // would without us — remember it as fully revealed
        const lens = {};
        for (const unit of item.units) lens[unit.key] = unit.fullLen;
        cacheSet(item.ident, lens);
        deliver(wrapMsg(item, item.seg));
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
        lensCache.clear(); // step numbers restart with the new stream
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
    function startReveal(ident, kind, seg, units) {
        active = { ident: ident, kind: kind, seg: seg, units: units, done: false };
        deliverCopy(active);
        start();
    }

    function fullLens(units) {
        const lens = {};
        for (const unit of units) lens[unit.key] = unit.fullLen;
        return lens;
    }

    function onTurnStep(data) {
        const step = data.step;
        if (!step || typeof step !== 'object' || step.step === undefined) {
            snapActive();
            return passthrough(data);
        }

        const ident = identOfStep(step);

        if (active && active.ident === ident && !active.done) {
            // update of the step being revealed: forward the fresh structure
            // right away (text stays truncated at the revealed lengths), so
            // nothing built on the chain waits on the reveal
            active.seg = step;
            refreshUnits(active);
            if (allRevealed(active)) finishActive();
            else { deliverCopy(active); start(); }
            return;
        }

        if (active && active.kind === 'step' && +step.step < +active.seg.step) {
            // an older step caught up with us (a late tool response re-emits
            // its owning step): its text was handed over in full already,
            // keep it that way and let the snapshot through untouched
            cacheSet(ident, fullLens(buildUnits('step', step)));
            return passthrough(data);
        }

        // text sliding back from the final bubble into this step (a
        // retraction) continues revealing where the bubble left off instead
        // of retyping from zero: the folded content ends with the bubble's
        // full text, so the carry-over offset is exact
        let carry = null;
        if (active && active.kind === 'final') {
            const u = active.units.find(function (x) { return x.key === 'final'; });
            const finalText = str(Array.isArray(active.seg) && active.seg[0] && active.seg[0].content);
            if (u && finalText && str(step.content).endsWith(finalText)) {
                carry = { revealed: u.revealed, full: finalText.length };
            }
        }

        // a different segment (or the previous reveal already finished):
        // the old segment is final from here on
        snapActive();

        const seed = lensCache.get(ident) || null;
        const units = buildUnits('step', step, seed);

        if (carry) {
            for (const unit of units) {
                if (unit.key === 'content' && !(seed && Number.isFinite(seed[unit.key])) && unit.fullLen > 0) {
                    const prefix = Math.max(unit.fullLen - carry.full, 0);
                    unit.revealed = Math.min(prefix + carry.revealed, unit.fullLen);
                }
            }
        }

        const unlimited = !units.length || units.every(function (u) { return rateFor(u.poolKey) <= 0; });

        if (unlimited || units.every(function (u) { return u.revealed >= u.fullLen; })) {
            // nothing to reveal (unlimited rate, or already fully revealed
            // from a previous delivery): stock delivery. remember the full
            // lengths so a later limited update can't truncate below them
            if (units.length) cacheSet(ident, fullLens(units));
            return passthrough(data);
        }

        startReveal(ident, 'step', step, units);
    }

    function onTurnFinal(data) {
        const msgs = data.messages;

        if (!(Array.isArray(msgs) && msgs.length === 1 && msgs[0] && typeof msgs[0] === 'object')) {
            // an empty list is a retract (the answer slid back into the
            // chain); multi-message snapshots are never paced. both belong
            // on the live store as-is, after finalizing any reveal in flight
            snapActive();
            return passthrough(data);
        }

        if (active && active.ident === FINAL_IDENT && !active.done) {
            // the answer bubble is growing: forward the structure right away,
            // its text keeps revealing on the timer
            active.seg = msgs;
            refreshUnits(active);
            if (allRevealed(active)) finishActive();
            else { deliverCopy(active); start(); }
            return;
        }

        // the final bubble takes over: the step being revealed is final now
        snapActive();

        const seed = lensCache.get(FINAL_IDENT) || null;
        const units = buildUnits('final', msgs, seed);

        const unlimited = !units.length || units.every(function (u) { return rateFor(u.poolKey) <= 0; });

        if (unlimited || units.every(function (u) { return u.revealed >= u.fullLen; })) {
            if (units.length) cacheSet(FINAL_IDENT, fullLens(units));
            return passthrough(data);
        }

        startReveal(FINAL_IDENT, 'final', msgs, units);
    }

    window.handleWebSocketMessage = function (data) {
        const type = data && data.type;

        try {
            // live settings push from the module (settings were saved)
            if (type === 'speed_limit_config') { applyConfig(data.config); return Promise.resolve(); }

            if (!settings.enabled) return original(data);

            if (type === 'turn_step') return onTurnStep(data);
            if (type === 'turn_final') return onTurnFinal(data);

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

            if (type === 'stream_state') {
                // a new stream is starting: step numbers restart, so the
                // revealed-length bookkeeping of the old one is stale
                if (data.state === 'message_sending') lensCache.clear();
                return passthrough(data);
            }
            if (type === 'stream_complete') return passthrough(data);
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
