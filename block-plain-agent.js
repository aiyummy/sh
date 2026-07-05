#!/usr/bin/env node
// PreToolUse hook (matcher "Agent") — DENIES ALL plain Agent-tool spawns.
//
// Why: 2026-07-05 incident (third Fable burn) — the plain Agent tool's `model` parameter
// is SILENTLY IGNORED; every spawned agent inherits the session model (Fable) regardless
// of an explicit opus/sonnet pin. Verified in sub-session transcripts. Under Max's
// standing rule (all subagents pinned opus/sonnet; Fable needs per-instance OK), the
// plain Agent tool is therefore unsafe by construction.
//
// Sanctioned paths instead:
//   - Workflow agent() opts {model:'opus'|'sonnet'} (verified working; fable double-locked
//     by block-fable.js + the in-engine guards)
//   - delegate-agents.js (GitHub/.claude/workflows) / delegate-task.js (nova-blueprint)
//
// Escape hatch (deliberate, auditable): if Max explicitly approves a plain-Agent spawn
// (which WILL run on the session model), include the literal token
// MAX-APPROVED-PLAIN-AGENT in the Agent call's prompt.
let s = ''
process.stdin.on('data', (d) => (s += d))
process.stdin.on('end', () => {
  try {
    const ti = JSON.parse(s || '{}').tool_input || {}
    const prompt = typeof ti.prompt === 'string' ? ti.prompt : ''
    if (!prompt.includes('MAX-APPROVED-PLAIN-AGENT')) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'Blocked: the plain Agent tool is banned (its model param silently fails; spawns inherit the SESSION model = Fable — incident 2026-07-05). Delegate via a Workflow with agent({model:"opus"|"sonnet"}) or delegate-agents.js, then verify the effective model in the spawned transcript. If Max explicitly approved a plain-Agent spawn on the session model, include MAX-APPROVED-PLAIN-AGENT in the prompt.',
          },
        }),
      )
    }
  } catch (_e) {
    // Fail OPEN on malformed payload — same posture as block-fable.js.
  }
  process.exit(0)
})
