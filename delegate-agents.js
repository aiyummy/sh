export const meta = {
  name: 'delegate-agents',
  description: 'Pinned-model delegation: run 1..N subagent tasks on opus/sonnet (fable double-locked)',
  whenToUse: 'ALL ad-hoc subagent delegation. The plain Agent tool model pin SILENTLY FAILS (agents inherit the session model = Fable; incident 2026-07-05) and a PreToolUse hook now denies it. args: { tasks: [{prompt, label?, effort?, schema?}], model?: "opus"(default)|"sonnet", effort?: default "high" }. Fable requires BOTH args.ceiling:"fable" AND args.fableApproved:true (Max per-instance OK). After launch, verify the effective model in the run transcript dir (grep "model":"claude- in agent-*.jsonl).',
  phases: [{ title: 'Delegate' }],
}

// args may arrive as a JSON string (known caller mistake) - parse defensively.
const a = typeof args === 'string' ? JSON.parse(args) : (args || {})

// MODEL GOVERNANCE (the whole point of this wrapper): explicit pin on EVERY agent()
// call - never inherit the session model. opus|sonnet only; fable double-locked.
const ALLOWED = ['opus', 'sonnet']
const model = a.model || 'opus'
const fableUnlocked = a.ceiling === 'fable' && a.fableApproved === true
if (!ALLOWED.includes(model) && !(model === 'fable' && fableUnlocked)) {
  throw new Error(
    "delegate-agents: model '" + model + "' refused. Allowed: opus|sonnet. Fable requires BOTH args.ceiling:'fable' AND args.fableApproved:true (Max's per-instance OK)."
  )
}

const tasks = a.tasks
if (!Array.isArray(tasks) || tasks.length === 0) {
  throw new Error('delegate-agents: args.tasks must be a non-empty array of {prompt, label?, effort?, schema?}')
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const effortDefault = EFFORTS.includes(a.effort) ? a.effort : 'high'

phase('Delegate')
const results = await parallel(
  tasks.map((t, i) => () =>
    agent(t.prompt, {
      label: t.label || 'task-' + (i + 1),
      phase: 'Delegate',
      model: model, // explicit, every call
      effort: EFFORTS.includes(t.effort) ? t.effort : effortDefault,
      ...(t.schema ? { schema: t.schema } : {}),
    })
  )
)

const ok = results.filter((r) => r !== null && r !== undefined).length
log('delegate-agents: ' + ok + '/' + tasks.length + ' tasks returned (model=' + model + ')')
return { model: model, effort: effortDefault, results: results }
