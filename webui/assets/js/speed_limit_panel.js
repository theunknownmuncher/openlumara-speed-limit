/* speed-limit -- Copyright (C) 2026 theunknownmuncher <theunknownmuncher@protonmail.com>
 * SPDX-License-Identifier: GPL-3.0-or-later
 * See the LICENSE file for the full GPL-3.0 text.
 */
/* -- AI GENERATED CODE (Qwen3.8 Flash Next) :: (2026-10-25) harness:openlumara
   speed-limit sidebar panel: configure every part of the visual speed limit —
   master switch, a limit toggle + rate per streamed text type, per-tool
   overrides (toggle + rate, tools picked from a dropdown of the live tool
   catalog) and the webui extension switch. Saves go through
   /api/ext/speed-limit/save, which persists to config.yml and broadcasts the
   new settings to every connected webui — applied immediately, no reload.
   The plain global object is registered as the Alpine store speedLimit,
   used by the sidebar tab through speedLimitComponent(). */
const SPEED_LIMIT_PANEL = {
    loaded: false,
    loading: false,
    saving: false,
    error: "",
    notice: "",

    enabled: true,
    limits: { content: true, reasoning: true, tool: true },
    rates: { content: 9000, reasoning: 9000, tool: 9000 },
    enableWebuiExtension: true,
    rows: [],           // [{ tool, rate, enabled }] — editable view of toolOverrides
    toolNames: [],      // dropdown options from the live tool catalog
    newRow: { tool: "", rate: 9000, enabled: true },

    streamTypes: [
        { key: "content", label: "Message output", hint: "The assistant's answer text" },
        { key: "reasoning", label: "Thinking", hint: "Reasoning / thinking text" },
        { key: "tool", label: "Tool calls (global)", hint: "Streaming tool arguments + tool responses for every tool without an override below" },
    ],

    adminDisabled: function () {
        return window.ADMIN_SETTINGS_DISABLED === true;
    },

    async refresh() {
        this.loading = true;
        this.error = "";

        try {
            const cfg = await simpleApiFetch("/api/ext/speed-limit/config") || {};
            this.applyCfg(cfg);

            try {
                const tools = await simpleApiFetch("/api/ext/speed-limit/tools");
                this.toolNames = (tools && tools.tools) || [];
            } catch (e) {
                this.toolNames = [];
            }

            this.loaded = true;
        } catch (e) {
            this.error = this.errorText(e);
        } finally {
            this.loading = false;
        }
    },

    applyCfg(cfg) {
        if (!cfg || typeof cfg !== "object") return;
        if (typeof cfg.enabled === "boolean") this.enabled = cfg.enabled;
        if (typeof cfg.enableWebuiExtension === "boolean") this.enableWebuiExtension = cfg.enableWebuiExtension;

        const limits = cfg.limits && typeof cfg.limits === "object" ? cfg.limits : null;
        const rates = cfg.rates && typeof cfg.rates === "object" ? cfg.rates : {};
        for (const key of ["content", "reasoning", "tool"]) {
            if (limits && key in limits) this.limits[key] = !!limits[key];
            const value = +rates[key];
            if (Number.isFinite(value)) this.rates[key] = Math.max(0, value);
        }

        const overrides = cfg.toolOverrides && typeof cfg.toolOverrides === "object" ? cfg.toolOverrides : {};
        this.rows = Object.entries(overrides).map(([tool, value]) => {
            // older settings stored an override as a bare rate
            if (value && typeof value === "object") {
                return { tool, rate: Math.max(0, +value.rate || 0), enabled: value.enabled !== false };
            }
            return { tool, rate: Math.max(0, +value || 0), enabled: true };
        });
    },

    optionsFor(row) {
        // every tool not already claimed by another override row, plus the
        // row's current value (kept even if it vanished from the catalog)
        return this.toolNames.filter(name =>
            name === row.tool || !this.rows.some(other => other !== row && other.tool === name));
    },

    availableNewTools() {
        return this.toolNames.filter(name => !this.rows.some(row => row.tool === name));
    },

    addRow() {
        const tool = String(this.newRow.tool || "").trim();
        if (!tool) {
            this.error = "pick a tool to override first";
            return;
        }
        if (this.rows.some(row => row.tool === tool)) return;

        this.error = "";
        this.rows.push({
            tool,
            rate: Math.max(0, +this.newRow.rate || 0),
            enabled: this.newRow.enabled !== false,
        });
        this.newRow = { tool: "", rate: 9000, enabled: true };
    },

    removeRow(row) {
        this.rows = this.rows.filter(other => other !== row);
    },

    async save() {
        this.saving = true;
        this.error = "";
        this.notice = "";

        try {
            const toolOverrides = {};
            for (const row of this.rows) {
                if (!row.tool) continue;
                toolOverrides[row.tool] = {
                    rate: Math.max(0, +row.rate || 0),
                    enabled: row.enabled !== false,
                };
            }

            const cfg = await simpleApiPost("/api/ext/speed-limit/save", {
                enabled: this.enabled,
                enable_webui_extension: this.enableWebuiExtension,
                limits: {
                    content: !!this.limits.content,
                    reasoning: !!this.limits.reasoning,
                    tool: !!this.limits.tool,
                },
                rates: {
                    content: Math.max(0, +this.rates.content || 0),
                    reasoning: Math.max(0, +this.rates.reasoning || 0),
                    tool: Math.max(0, +this.rates.tool || 0),
                },
                toolOverrides,
            });
            if (cfg && typeof cfg === "object") this.applyCfg(cfg);
            this.notice = "saved — applied live to every open webui";
        } catch (e) {
            this.error = this.errorText(e);
        } finally {
            this.saving = false;
        }
    },

    errorText(e) {
        if (e && typeof e === "object") return e.message || JSON.stringify(e);
        return String(e);
    }
};

document.addEventListener("alpine:init", () => {
    Alpine.store("speedLimit", SPEED_LIMIT_PANEL);
});

function speedLimitComponent() {
    return Alpine.store("speedLimit") || SPEED_LIMIT_PANEL;
}

// the pacer re-dispatches every live settings push (saved from any page or
// the module settings) so an open panel mirrors the new values
window.addEventListener("speed-limit-config", (event) => {
    const store = (window.Alpine && Alpine.store("speedLimit")) || SPEED_LIMIT_PANEL;
    try { store.applyCfg((event && event.detail) || {}); } catch (e) {}
});
