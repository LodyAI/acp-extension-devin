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

## MCP

Devin `>=3000.11.1` natively supports `mcpServers` supplied in `session/new`
and `session/load`, including HTTP and SSE transports. The adapter forwards
them verbatim and never writes an MCP configuration file.
