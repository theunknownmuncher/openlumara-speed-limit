# speed-limit

A **visual speed limit** for live text streaming in the OpenLumara webui.

The model generates text as fast as it can and the backend still broadcasts
every token immediately — this module only paces how fast the chat **reveals**
that text on screen. Inference speed, the websocket feed, chat storage and all
other channels are completely unaffected; when the stream finishes, the
finalized message is identical to what the model produced.

## Why?

Fast local models can outrun reading speed by a wide margin. Pacing the reveal
to a comfortable reading pace makes long answers easier to follow, without
touching generation performance at all.

## What gets paced

Each streamed text type has its **own limit toggle** and its own rate
(characters/minute, `0` = no limit):

| Stream type | Toggle | What it covers |
| --- | --- | --- |
| Message output | on/off | the assistant's answer text |
| Thinking | on/off | reasoning / thinking blocks |
| Tool calls | on/off | streaming tool arguments and tool response text |

Tool calls use a **global tool limit**, and you can register **per-tool
overrides** — each with its own toggle and rate (e.g. give `host_shell_exec` a
slower reveal, keep `file_manager_read` at another pace, or take
`web_search` off the speed limit entirely). Tools without an override follow
the global tool limit. Tools are picked from a dropdown of every tool in the
live tool catalog.

A limit that is switched off (or a rate of `0`) simply streams at full speed —
everything still appears in the correct order.

## Configuring it

Everything is configured in the **Speed Limit** tab in the chat sidebar:
master switch, a toggle + rate per stream type, the per-tool override editor,
and the webui extension switch. **Save & apply** persists to `config.yml` and
pushes the new settings to every connected webui page **immediately — no
reload needed**.

The same settings exist under *Settings → User Modules → speed-limit*
(`enabled`, `content_limit_enabled`, `content_chars_per_minute`,
`reasoning_limit_enabled`, `reasoning_chars_per_minute`, `tool_limit_enabled`,
`tool_calls_chars_per_minute`, `tool_rate_overrides`,
`enable_webui_extension`); saves there also apply live (the module reload
broadcasts the new settings, and the pacer re-checks the config at the start of
every stream).

`tool_rate_overrides` maps a tool name to `{enabled, rate}`, e.g.

```yaml
tool_rate_overrides:
  host_shell_exec: { enabled: true, rate: 600 }
  web_search: { enabled: false }   # no speed limit for this tool
```

## How it works

The module is purely a webui extension — no core files are modified:

- `webui/assets/js/speed_limit.js` wraps the core websocket message handler
  (`handleWebSocketMessage` from `js/services/websockets.js`). Incoming
  `turn_stream` messages already carry the *full accumulated* content of the
  current segment, so the wrapper forwards **every message to the store the
  moment it arrives** — only the paced text fields inside the forwarded copy
  are truncated to the revealed length, then grow on the reveal timer. That
  truncated prefix is exactly the shape the store sees during normal
  streaming. Tool argument rows render from the backend's leniently parsed
  `_metadata.args_parsed`; the wrapper reveals that object key-by-key (string
  values slice mid-key), which is indistinguishable from native partial
  parsing.
- Every stream type (and every tool with an override) has its own character
  budget pool, so thinking, answers and each tool reveal independently at
  their configured rates. Unlimited types are revealed at once, in order.
- **Process steps are never affected.** Because every `turn_stream` message
  reaches the store on the backend's timing, the agent chain's structure —
  step numbers, `step_status` transitions, tool cards, the final-content
  split and the expand/collapse choreography that reads all of it — behaves
  exactly like stock. Only the text inside the steps reveals slower. When the
  stream moves on to a new segment, the previous segment's reveal snaps to
  its full text, so a finalized step never sits half-typed.
- The only messages ever held back are `stream_state: idle` and
  `stream_complete`, and only until the last reveal has caught up, so the
  history handoff always runs on fully revealed text and the "AI is typing"
  indicator stays honest. Everything else (progress indicators, logs, token
  bookkeeping) passes through instantly.
- Settings changes are broadcast over the websocket (`speed_limit_config`) by
  the module and applied live; `webui/templates/index.html` (head slot) seeds
  the initial settings at page load.
- `webui/assets/js/speed_limit_panel.js` + `webui/templates/sidebars/`
  implement the sidebar panel; it talks to `/api/ext/speed-limit/`
  (`config`, `tools`, `save`).

## Notes

- If generation outruns the reveal, the final answer's remaining text keeps
  appearing at the limited speed after generation ends (the handoff to the
  finalized message waits for it). Raise the rate, or switch that limit off,
  if you don't want that. Text inside process steps instead snaps to complete
  when the stream moves on to the next step.
- Sending a new message while an old reveal is still draining flushes the
  remainder immediately, so nothing is ever lost or duplicated.
- Saving from the panel requires `enable_admin_settings` (it writes config).
- Verify the effective settings with `GET /api/ext/speed-limit/config` and the
  tool list with `GET /api/ext/speed-limit/tools`.
- This module used to be called **slow-stream**; settings persisted under the
  old name (including the old single `chars_per_minute` rate) are picked up and
  migrated automatically on the first save.

## Enabling

Add `speed-limit` to `user_modules.enabled` in `config.yml` (or enable it in
the module settings), then restart OpenLumara and reload the webui page.
Later changes do **not** need a restart or reload.

## License

GPL-3.0-or-later

Copyright (C) 2026 theunknownmuncher <theunknownmuncher@protonmail.com>

See [LICENSE](LICENSE).
