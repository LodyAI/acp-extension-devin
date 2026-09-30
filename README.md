# acp-extension-devin

An ACP-to-ACP adapter between Lody and the official Devin CLI: Devin already
speaks ACP natively (`devin acp`), so this package proxies the connection and
translates the Devin-specific pieces of the wire.

## Run

```sh
DEVIN_PATH=/path/to/devin node dist/index.js
```

`DEVIN_PATH` must be an explicit path to a Devin binary. The adapter never
searches `PATH`: the managed `bin/devin` may be a user wrapper, so any path is
accepted as given.

## Status

The adapter is currently a transparent proxy: every client message reaches the
runtime and every runtime message reaches the client unchanged. Translations
for the private `cognition.ai/*` surface are added per Core contract, pinned by
`runtime-manifest.json`.

## Subagent events

When the client advertises `clientCapabilities._meta.lody.subagentEvents`
(`{version: 1}`), the adapter asks Devin for its private subagent stream
(`clientCapabilities._meta["cognition.ai/subagentSupport"]`) and translates it
to Core `_lody/subagents/event` notifications:

- `run_subagent` children publish explicit `cognition.ai/subagent_started` /
  `cognition.ai/subagent_completed` rows on `tool_call_update`; these become run
  snapshots, and all updates tagged `cognition.ai/subagent_context` route to the
  matching run. Child usage becomes `progress` (context tokens only — context
  windows are not billing).
- **Sidekick** (Fusion model pairs) has no lifecycle or text stream on the
  wire — only `sk::`-prefixed tool calls and usage tagged `sidekick`. The
  adapter infers each lead→sidekick→lead handoff segment as one run named
  `Sidekick` (`stream: ["tool"]`); run start and end are inferred, never
  reported by Devin.
- Permission requests for run-owned tool calls are mirrored to the root
  session with a namespaced `subagent:<runId>:<id>` toolCallId and
  `_meta.lody.{subagentRunId, subagentToolCallId}`.
- Runs do not support cancel or output read (`outputRead: "none"`,
  `cancel: false`). A live sidekick run closes when root activity resumes or
  the prompt turn ends.
- `session/load` replay traffic is forwarded verbatim (known limitation: runs
  are not reconstructed from replay).

## MCP

Devin `>=3000.11.1` natively supports `mcpServers` supplied in `session/new`
and `session/load`, including HTTP and SSE transports. The adapter forwards
them verbatim and never writes an MCP configuration file.
