export const meta = {
  name: 'delegate-task',
  description:
    'One supervised implementation agent on a DOWNGRADED model (opus default, sonnet allowed) at a pinned reasoning effort. Exists because (a) subagents inherit the session model by default — under a premium orchestrator that silently spends premium tokens/limits on mechanical work — and (b) the plain Agent tool exposes a model knob but NO effort/extended-thinking knob; Workflow agent() opts expose both. The caller MUST review the resulting diff line-by-line and run the suite; this wrapper provides no verification of its own.',
  whenToUse:
    'Delegating one simple, fully-specified implementation task (an explicit recipe + traps already written down) to a cheaper model at pinned effort. Pass args.prompt = the complete self-contained brief. Model tiers (2026-07-01): opus (default) = mechanical CODE edits with a recipe, anything touching logic; sonnet = well-bounded single-file edits, doc/config updates, boilerplate from an explicit template, structured extraction. args.effort defaults to high — effort IS the extended-thinking dial. NOT for judgment-heavy work (keep that in the main loop), and NOT a substitute for the verify-* scaffolds.',
  phases: [{ title: 'Implement', detail: 'single downgraded-model agent executes the brief' }],
}

// args: { prompt: string [required], model?: 'opus'|'sonnet' (default 'opus'),
//         label?: string, effort?: 'low'|'medium'|'high'|'xhigh'|'max' (default 'high') }
// Renamed from opus-task.js and generalized beyond Opus (2026-07-01, Max). haiku was
// considered and deliberately EXCLUDED (Max's call, 2026-07-01) — revisit only with
// evidence. The allowlist also excludes 'fable'/anything unknown by design: this
// wrapper exists to DOWNGRADE from the orchestrator model; premium-model work
// belongs in the main loop, and a typo should fail at the guard, not mid-run.
// Tolerate args passed as a JSON string (common caller mistake).
const A = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return { prompt: args } } })()
  : (args || {})
if (!A.prompt) throw new Error('delegate-task: pass args.prompt = the complete, self-contained task brief')
const MODELS = ['opus', 'sonnet']
const model = A.model === undefined ? 'opus' : A.model
if (!MODELS.includes(model)) throw new Error(`delegate-task: args.model must be ${MODELS.join('|')} (got ${JSON.stringify(A.model)}) — this wrapper downgrades; session-model work belongs in the main loop`)
const effort = A.effort || 'high'

phase('Implement')
log(`delegate-task: model=${model}, effort=${effort}`)
// Null-visibility per feedback_adversarial_verify_workflow_design: agent() resolves
// NULL (no throw) on terminal API errors — retry once, then FAIL LOUDLY (a silent
// null here would read as "task done" to a caller skimming the result).
const run = (tag) =>
  agent(A.prompt, { label: (A.label || 'delegate-task') + tag, phase: 'Implement', model, effort })
    .then((r) => {
      if (!r) throw new Error('implementation agent returned null')
      return r
    })
return await run('').catch(() => run(':retry'))
