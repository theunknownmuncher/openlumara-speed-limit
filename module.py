# speed-limit module for OpenLumara — a visual speed limit for webui text streaming
# Copyright (C) 2026 theunknownmuncher <theunknownmuncher@protonmail.com>
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

# -- AI GENERATED CODE (Qwen3.8 Flash Next) :: (2026-10-25) harness:openlumara
import core
import channels.webui.api as webui

# short stream-type names (used by the webui panel + broadcasts) ->
# (rate config key, limit toggle config key)
RATE_KEYS = {
    "content": ("content_chars_per_minute", "content_limit_enabled"),
    "reasoning": ("reasoning_chars_per_minute", "reasoning_limit_enabled"),
    "tool": ("tool_calls_chars_per_minute", "tool_limit_enabled"),
}

DEFAULT_RATE = 9000

# the module was called 'slow-stream' before the rename; its persisted
# settings are picked up and migrated automatically
LEGACY_MODULE_NAME = "slow-stream"


class SpeedLimit(core.module.Module):
    """Paces the visual text streaming in the webui: the model still generates and delivers text at full speed, but the chat reveals it at a configurable speed limit. Each streamed text type — message output, thinking/reasoning and tool calls — has its own on/off toggle and characters-per-minute rate, plus optional per-tool overrides (with their own toggles) so individual tools can use a different rate or skip the limit entirely. Only the webui rendering is paced — inference, the websocket feed, chat storage and every other channel are untouched. Configure everything live in the Speed Limit sidebar panel or in this module's settings; changes apply to all open webui pages immediately."""

    category = "system"

    settings = {
        "enabled": {
            "type": "boolean",
            "default": True,
            "description": "Master switch for the visual speed limit. With it off, the webui streams text as fast as it arrives (stock behavior).",
        },
        "content_limit_enabled": {
            "type": "boolean",
            "default": True,
            "description": "Apply the speed limit to message output (the assistant's answer text). Turn off to stream answers at full speed while other stream types stay limited.",
        },
        "content_chars_per_minute": {
            "type": "number",
            "default": DEFAULT_RATE,
            "description": "Maximum characters per minute the webui reveals for message output (about 4 characters per token). Set to 0 for no limit. Never affects actual token generation speed.",
        },
        "reasoning_limit_enabled": {
            "type": "boolean",
            "default": True,
            "description": "Apply the speed limit to reasoning ('thinking') text.",
        },
        "reasoning_chars_per_minute": {
            "type": "number",
            "default": DEFAULT_RATE,
            "description": "Maximum characters per minute the webui reveals for reasoning ('thinking') text. Set to 0 for no limit.",
        },
        "tool_limit_enabled": {
            "type": "boolean",
            "default": True,
            "description": "Apply the speed limit to tool call text (streaming arguments + tool responses) by default. Tools listed in the per-tool overrides use their own settings instead.",
        },
        "tool_calls_chars_per_minute": {
            "type": "number",
            "default": DEFAULT_RATE,
            "description": "Global tool-call rate in characters per minute, used for every tool without a per-tool override. Set to 0 for no limit.",
        },
        "tool_rate_overrides": {
            "type": "object",
            "default": {},
            "description": "Per-tool speed limits as `tool_name -> {enabled, rate}`, e.g. `host_shell_exec: {enabled: true, rate: 600}` (rate = characters per minute, 0 = no limit; enabled = false removes the limit for that tool). Easiest to edit in the **Speed Limit** sidebar panel, which offers a dropdown of all available tools.",
        },
        "enable_webui_extension": {
            "type": "boolean",
            "default": True,
            "description": "Loads the webui scripts that pace the reveal and add the Speed Limit sidebar panel. Turning this off disables the module in the webui entirely (the panel disappears after the next page load).",
        },
    }

    async def on_ready(self):
        cfg = self._effective_config()
        if not cfg["enabled"] or not self.config.get("enable_webui_extension", True):
            self.log(self.name, "visual speed limit is off")
        else:
            parts = []
            for short in ("content", "reasoning", "tool"):
                if cfg["limits"][short]:
                    parts.append(f"{short}: {cfg['rates'][short]:g}/min")
                else:
                    parts.append(f"{short}: unlimited")
            overrides = ", ".join(
                f"{name} {'unlimited' if not o['enabled'] else str(o['rate']) + '/min'}"
                for name, o in cfg["toolOverrides"].items()
            )
            self.log(self.name, f"webui reveal speed limit active ({', '.join(parts)}{'; tools: ' + overrides if overrides else ''})")

        # push the effective config to every connected webui client: settings
        # saves reload this module, and this is how the change lands live
        await self._broadcast_config()

    # -------------------------
    #   EFFECTIVE CONFIG
    # -------------------------

    def _raw_settings(self, name=None):
        """the persisted (raw) settings dict for this module (or a legacy name)"""
        try:
            raw = core.config.get("user_modules", "settings", name or self.name)
        except Exception:
            raw = None
        return raw if isinstance(raw, dict) else {}

    @staticmethod
    def _to_rate(value, fallback):
        try:
            return max(0.0, float(value))
        except (TypeError, ValueError):
            return float(fallback)

    def _effective_config(self):
        """current settings as a compact JSON payload for the webui.

        Migrates older settings on the fly:
        - settings persisted under the module's old name ('slow-stream') are
          used when nothing was saved under the new one yet
        - v1's single `chars_per_minute` rate seeds any type rate the user
          never set, and `throttle_reasoning: false` disables the reasoning
          limit
        - per-tool overrides saved as plain numbers (v2) become
          {enabled: true, rate: <number>}
        """
        raw = self._raw_settings()
        if not raw:
            raw = self._raw_settings(LEGACY_MODULE_NAME)

        legacy = raw.get("chars_per_minute")  # v1: one rate for everything

        def rate(short):
            rate_key, _ = RATE_KEYS[short]
            value = self.config.get(rate_key)
            if rate_key not in raw and legacy is not None:
                value = legacy
            return self._to_rate(value, DEFAULT_RATE)

        def limit_on(short):
            _, toggle_key = RATE_KEYS[short]
            if toggle_key in raw:
                return bool(raw.get(toggle_key))
            # v1 had no per-type toggles; throttle_reasoning: false meant
            # "reasoning streams at full speed"
            if short == "reasoning" and toggle_key not in raw and raw.get("throttle_reasoning") is False:
                return False
            return True

        overrides = {}
        raw_overrides = self.config.get("tool_rate_overrides")
        if isinstance(raw_overrides, dict):
            for name, value in raw_overrides.items():
                name = str(name).strip()
                if not name:
                    continue
                if isinstance(value, dict):
                    overrides[name] = {
                        "rate": self._to_rate(value.get("rate"), 0.0),
                        "enabled": bool(value.get("enabled", True)),
                    }
                else:
                    # v2 shape: a bare number meant "limited at this rate"
                    overrides[name] = {"rate": self._to_rate(value, 0.0), "enabled": True}

        return {
            "enabled": bool(self.config.get("enabled")),
            "limits": {short: limit_on(short) for short in RATE_KEYS},
            "rates": {short: rate(short) for short in RATE_KEYS},
            "toolOverrides": overrides,
            "enableWebuiExtension": bool(self.config.get("enable_webui_extension", True)),
        }

    async def _broadcast_config(self):
        """push {type: speed_limit_config} to all connected webui clients so
        rate changes apply immediately, without a page reload"""
        websocket_manager = getattr(getattr(self.manager, "channel", None), "websocket_manager", None)
        if websocket_manager is None:
            return  # active channel is not the webui (or not up yet)
        try:
            await websocket_manager.broadcast({"type": "speed_limit_config", "config": self._effective_config()})
        except Exception as e:
            self.log(self.name, f"could not broadcast settings update: {core.detail_error(e)}")

    # -------------------------
    #   WEBUI EXTENSION ROUTES
    # -------------------------

    @webui.route("config")
    async def _route_config(self, body=None, query=None):
        """the effective speed limit settings"""
        return self._effective_config()

    @webui.route("tools")
    async def _route_tools(self, body=None, query=None):
        """every tool name in the active tool catalog (for the panel dropdown)"""
        channel = getattr(self.manager, "channel", None)
        catalog = getattr(getattr(channel, "tool_loader", None), "catalog", None) or {}
        return {"tools": sorted(str(name) for name in catalog)}

    @webui.route("save", method="POST", admin_only=True)
    async def _route_save(self, body=None, query=None):
        """persist speed limit settings and push them live to all webui clients"""
        body = body or {}
        updates = {}

        if "enabled" in body:
            updates["enabled"] = bool(body["enabled"])
        if "enable_webui_extension" in body:
            updates["enable_webui_extension"] = bool(body["enable_webui_extension"])

        limits = body.get("limits")
        if isinstance(limits, dict):
            for short, (_, toggle_key) in RATE_KEYS.items():
                if short in limits:
                    updates[toggle_key] = bool(limits[short])

        rates = body.get("rates")
        if isinstance(rates, dict):
            for short, (rate_key, _) in RATE_KEYS.items():
                if short in rates:
                    try:
                        updates[rate_key] = max(0.0, float(rates[short]))
                    except (TypeError, ValueError):
                        return self.result(f"invalid rate for '{short}' (expected a number of characters per minute)", success=False)

        if "toolOverrides" in body:
            raw = body.get("toolOverrides")
            if not isinstance(raw, dict):
                return self.result("toolOverrides must be an object of tool_name -> {enabled, rate}", success=False)
            clean = {}
            for name, value in raw.items():
                name = str(name).strip()
                if not name:
                    continue
                if isinstance(value, dict):
                    # an override may omit the rate entirely (e.g. a
                    # disabled toggle in the panel or a hand-written
                    # { enabled: false } in config.yml): 0 keeps it valid
                    rate = value.get("rate")
                    if rate is None:
                        rate = 0.0
                    enabled = value.get("enabled", True)
                else:  # tolerate the bare-number shape from older clients
                    rate, enabled = value, True
                try:
                    clean[name] = {"rate": max(0.0, float(rate)), "enabled": bool(enabled)}
                except (TypeError, ValueError):
                    return self.result(f"invalid rate for tool '{name}' (expected a number)", success=False)
            updates["tool_rate_overrides"] = clean

        if not updates:
            return self.result("nothing to save was found in the request", success=False)

        # ConfigManager.set persists to config.yml on every call
        for key, value in updates.items():
            self.config.config.set(key, value)

        await self._broadcast_config()
        return self.result(self._effective_config())
