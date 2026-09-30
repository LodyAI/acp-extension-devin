# Devin ACP adapter guidelines

`CLAUDE.md` is a symlink to this file. The public Lody repository guidelines also apply.

## Scope

- Standalone public adapter. Lody consumes its executable; never import Lody
  workspace packages.
- Launch only the official `devin acp` from an explicit `DEVIN_PATH`. Do not
  patch or bundle Devin. Do not search `PATH`: the managed binary may
  already be a user wrapper.
- Private `cognition.ai/*` methods and `_meta` fields are translated inside the
  adapter only. Every relied-on field is pinned in `runtime-manifest.json` and
  asserted by tests against a fixed official runtime version.
- Advertise only implemented Core capabilities; never declare a `_meta.lody`
  capability before its translation exists.
- stdout carries protocol only; diagnostics go to stderr. On connection close,
  end the child's stdin; propagate child error/exit codes and signals.

## Subagent events

- Translate the private subagent stream only after bilateral negotiation:
  client `_meta.lody.subagentEvents` in, `cognition.ai/subagentSupport` out.
- Once negotiated, native child output and lifecycle rows never reach the root
  stream; unattributed events must not become root output.
- A snapshot precedes all content of its run; late content after termination is
  dropped. Run IDs are adapter-owned and distinct from Devin agentIds — a reused
  agentId after termination is a new run.
- Sidekick runs are inferred (no wire lifecycle); never invent descriptions or
  summaries for them. `session/load` replay creates no runs.

## MCP

- Forward `session/new` / `session/load` `mcpServers` verbatim. Devin
  `>=3000.11.1` accepts stdio, HTTP and SSE there; the adapter never writes an
  MCP configuration file.

## Local working records

- Optional `local-work/` holds checkout-local working records and evidence.
  Exclude it through this checkout's Git `info/exclude`; never stage or publish
  its contents. `CLAUDE.md` remains a symlink to this file.
- When that directory exists, read `local-work/AGENTS.md` and
  `local-work/STATUS.md` before resuming work, then follow their decision and
  evidence links. Local notes supplement these public rules.
- Public behavior and contributor-wide rules belong in tracked documentation;
  local notes do not replace public contracts or approval.

## Tests

- Synthetic inputs and explicit signals only: no sleeps, no real Devin process,
  no commercial providers. Inject `spawnImpl` for process assertions. Never
  commit captured transcripts; fixtures must be synthetic.

## Checks

- Before committing run `pnpm check` and `pnpm build`.
- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`. AI commits
  end with `Model: <runtime-model-id>`.
