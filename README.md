# sh — Claude Code tooling transfer repo

Portable tooling for Max's Claude Code sessions: adversarial-verify workflow engines,
pinned-model delegation wrappers, and the subagent model-governance hooks. Each file's
header comment is its own authoritative doc; this README is the install/usage map.

## Why the governance package exists (incident 2026-07-05)

The plain Agent tool's `model` parameter **silently fails** — every spawned agent inherits
the session model. On a Fable session, an explicit `model: "opus"` pin on 9 agent spawns
was ignored and all 9 ran on `claude-fable-5` (verified in the sub-session transcripts).
Third incident of the class (2026-07-01 unpinned 52-agent verify run; 2026-07-02 Fable-inherited
Explore digest). Standing rule: **all subagents run pinned opus/sonnet; Fable requires Max's
explicit per-instance OK.** The package below makes that rule mechanical, not disciplinary.

## The three enforcement layers

| Layer | File | Install to | What it does |
|---|---|---|---|
| Hook (belt) | `block-plain-agent.js` | `~/.claude/hooks/` | PreToolUse on `Agent`: **denies ALL plain Agent-tool spawns**. Escape: Max's per-instance OK = literal `MAX-APPROVED-PLAIN-AGENT` token in the prompt (the spawn then knowingly runs the session model). |
| Hook (belt) | `block-fable.js` | `~/.claude/hooks/` | PreToolUse on `Workflow`: denies (a) args requesting `fable` without the double-unlock (`args.ceiling:'fable'` AND `args.fableApproved:true`); (b) **inline** scripts pinning `model:'fable'` un-unlocked; (c) **inline** scripts calling `agent()` with no `model:` anywhere (the inherit accident). Saved-engine `scriptPath` runs are exempt from the body scan — their in-script `spawn()` guards govern. |
| Workflow (suspenders) | `delegate-agents.js` | `<working-folder>/.claude/workflows/` | The sanctioned delegation path: 1..N tasks in parallel, **explicit model pin on every `agent()` call** (opus default / sonnet; fable double-locked), per-task effort + optional structured-output schema. |

**settings.json wiring** (`~/.claude/settings.json`):

```json
"hooks": {
  "PreToolUse": [
    { "matcher": "Workflow", "hooks": [{ "type": "command", "command": "node C:/Users/Max/.claude/hooks/block-fable.js" }] },
    { "matcher": "Agent",    "hooks": [{ "type": "command", "command": "node C:/Users/Max/.claude/hooks/block-plain-agent.js" }] }
  ]
}
```

**Fourth layer (context):** mirror the hard rule in the working folder's `CLAUDE.md` so it is
in-context every session:

> Subagent delegation: NEVER the plain Agent tool (model pin silently fails → session-model burn).
> Delegate via Workflow `delegate-agents` / verify engines; pins opus/sonnet only; Fable =
> double-unlock + Max's per-instance OK. After ANY spawn, verify the effective model in the run's
> `agent-*.jsonl` transcripts (`grep '"model":"claude-'`) before letting agents run long.

## Using delegate-agents

```
Workflow({ name: "delegate-agents", args: {
  model: "opus",            // default "opus"; or "sonnet"; fable needs ceiling+fableApproved
  effort: "high",           // default for all tasks; per-task override below
  tasks: [
    { prompt: "…", label: "check-1" },
    { prompt: "…", label: "cheap-sweep", effort: "low" },
    { prompt: "…", label: "typed", schema: { "type": "object", "required": ["x"], "properties": { "x": { "type": "string" } } } }
  ]
}})
```

- Name resolution is **session-root-only**: sessions rooted at the working folder call it by
  name; repo-rooted sessions pass `scriptPath` to the file instead.
- Args must be actual JSON (the script also tolerates a JSON string, a known caller mistake).
- Returns `{ model, effort, results: [...] }`; a null entry = that task's agent died/was skipped.
- **Always verify after launch:** the tool result names the run's transcript dir — grep
  `"model":"claude-` in its `agent-*.jsonl` files; kill + surface on any mismatch.

## The rest of the toolkit

- `verify-code.js` / `verify-branch.js` / `verify-refactor.js` / `verify-design-doc.js` —
  adversarial-verify engines (multi-lane gap/bug hunts). Repo-agnostic via `args.repoRoot`;
  model governance built in (pinned defaults, fable double-unlock, `spawn()` chokepoint).
  Consume results from the run's output-file `.result`, never the truncated inline preview.
  See each file's `whenToUse` + LAUNCH PROTOCOL header.
- `delegate-task.js` — the original 1-task downgrade wrapper (opus default | sonnet, pinned
  effort). Superseded for fan-outs by `delegate-agents.js`; still fine for single delegations.

## Install checklist (new machine / new working folder)

1. Copy the two hooks to `~/.claude/hooks/`; add both `PreToolUse` entries to
   `~/.claude/settings.json` (JSON above).
2. Pipe-test: `echo '{"tool_name":"Agent","tool_input":{"prompt":"x"}}' | node ~/.claude/hooks/block-plain-agent.js`
   → expect a deny JSON. Empty output on the marker/pinned variants.
3. Copy `delegate-agents.js` (and any engines you want name-resolvable) to
   `<working-folder>/.claude/workflows/`. Keep files **LF, control-char-free** — CRLF or C1
   chars in workflow files are rejected by the Workflow runtime.
4. Add the CLAUDE.md rule block to the working folder's `CLAUDE.md`.
