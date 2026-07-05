export const meta = {
  name: 'verify-branch',
  description:
    'Whole-branch adversarial-verify: a PRESET of verify-code tuned for reviewing an ENTIRE branch vs its base (pre-merge). It supplies a branch-diff scope + breadth lenses (cross-phase integration, consumer-audit of shifted invariants, regression, security, coverage) and delegates to verify-code so the hardened engine (refute -> map-reduce adjudicate -> graceful return) is shared, not duplicated.',
  whenToUse:
    'Before merging a branch that accumulated several phases of work — when per-chunk verifies can\'t see cross-phase integration. Pass args.repoRoot, args.base (default "main"), args.context (what the branch did + invariants that must hold END-TO-END). For a single diff/file-set/subsystem use verify-code directly; for design docs use verify-design-doc. LAUNCH PROTOCOL (2026-07-01): by-NAME delegation to verify-code only resolves when the session is rooted INSIDE this repo — from any other session root (e.g. the GitHub parent dir) pass args.enginePath = absolute path to the sibling verify-code.js. Also set args.model (\'opus\' recommended; verify-code PINS models by default now, so this is optional; forward args.ceiling:\'fable\' + args.fableApproved:true to double-unlock a fable pass).',
  // No phases here: the work + phases belong to verify-code, which this delegates to.
}

// ---------------------------------------------------------------------------
// This is a thin PRESET. The engine lives in verify-code.js (single source of
// truth for the refute -> per-finding map-reduce adjudicate -> graceful-return
// machinery). We only assemble the whole-branch CONFIG and hand it off.
//
// args: repoRoot [required], base (default "main"), head (default "HEAD"),
//       context (branch summary + END-TO-END invariants), diffPath (optional
//       pre-captured diff), skeptics (default 3), lenses (override the breadth set),
//       enginePath (absolute path to verify-code.js — REQUIRED from sessions not
//       rooted in this repo, see below).
//
// NOTE on nesting: workflow() is one level deep — run this template TOP-LEVEL
// (which is the normal case). It cannot itself be called from inside another
// workflow. See the Workflow tool's nesting rule.
// NOTE on name resolution (2026-07-01, empirically confirmed): workflow('verify-code')
// searches only the SESSION ROOT's .claude/workflows registry. A session rooted
// elsewhere (e.g. the GitHub parent dir) launches THIS file fine via scriptPath but
// cannot resolve the engine by name — pass args.enginePath and we delegate by
// { scriptPath } instead.
// See memory feedback_adversarial_verify_workflow_design.
// ---------------------------------------------------------------------------

const A = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return {} } })()
  : (args || {})

const repoRoot = A.repoRoot || ''
if (!repoRoot) throw new Error('verify-branch: pass args.repoRoot = absolute path to the repo (as a JSON object, not a string)')
// Fable double-unlock guard (mirrors the engines) — fail before delegating if 'fable' is
// requested in args without BOTH args.ceiling:'fable' AND args.fableApproved:true. The
// delegated verify-code re-checks, but catching it here avoids even launching the run.
if (typeof A === 'object' && A && /fable/i.test(JSON.stringify(A)) && !(A.ceiling === 'fable' && A.fableApproved === true))
  throw new Error("verify-branch: 'fable' requested in args without the double-unlock (set args.ceiling:'fable' AND args.fableApproved:true, only after Max approves at the time).")
const base = A.base || 'main'
const head = A.head || 'HEAD'

// Breadth lenses tuned for a WHOLE BRANCH — the dimensions per-chunk verifies
// structurally miss. Override via args.lenses (e.g. add per-subsystem reviewers).
const BRANCH_LENSES = Array.isArray(A.lenses) && A.lenses.length ? A.lenses : [
  { key: 'cross-phase-integration', focus: 'Interactions BETWEEN the branch\'s phases that no single per-chunk review could see: a later phase that changed the meaning/shape an earlier phase relied on, an invariant that holds in each phase alone but breaks when they compose, ordering/coupling across the phases.' },
  { key: 'consumer-audit', focus: 'For every shape/field/invariant the branch CHANGED, grep the ENTIRE repo (src + frontend + tests) for EVERY consumer and confirm each still holds. Silent-semantic-drift (a value that still type-checks but now means something different) is the highest-yield class here.' },
  { key: 'correctness', focus: 'Logic bugs introduced anywhere on the branch: null/undefined, wrong conditionals, type coercion (DB Date/string surprises), NaN/empty-set math, async/ordering. Trace real values.' },
  { key: 'regression', focus: 'What did the branch break in code it did not directly edit but depends on? Removed/renamed symbols still referenced, a response/query field other callers still read, a behavior other surfaces relied on.' },
  { key: 'security', focus: 'Injection (untrusted input reaching a prompt/SQL/shell/HTML un-neutralized), broken authz, a read-only/no-write invariant violated, secrets. Weigh the realistic threat actor + reachability.' },
  { key: 'intent-fidelity', focus: 'Does the branch match its driving ADR/spec end-to-end? Over-reach (broke a kept consumer), under-reach (left an old path as a second source of truth), and stale/contradictory docs introduced along the way.' },
  { key: 'data-and-migrations', focus: 'Schema/migrations: apply-in-order on a fresh DB, idempotent, backfills correct + safe to re-run; parity between any generated/dynamic queries and the schema they assume; DATE/BIGSERIAL serialization gotchas; no schema-vs-SQL drift.' },
  { key: 'test-coverage', focus: 'What is claimed working but untested across the branch? Map new behaviors to the tests that exercise their INVARIANT, not just shape. Name the highest-value missing tests.' },
]

const branchContext = [
  'WHOLE-BRANCH PRE-MERGE REVIEW. The branch accumulated multiple phases of work; the test suite is presumed green and per-chunk verifies already ran. Your edge is CROSS-PHASE + whole-repo reach: find what those per-chunk passes could not see, and production-merge risks (data corruption, read-only violations, silent semantic drift, security).',
  '',
  A.context || '(no branch summary provided; infer it from the diff + the driving ADR/spec)',
].join('\n')

// The scope: a pre-captured diff if given, else the base...head range for the
// reviewers to capture themselves.
const scope = A.diffPath ? { diffPath: A.diffPath } : { diff: `${base}...${head}` }

// Delegate by { scriptPath } when the caller supplies enginePath (sessions whose
// root can't resolve 'verify-code' by name — see the name-resolution NOTE above).
const engineRef = A.enginePath ? { scriptPath: A.enginePath } : 'verify-code'
return await workflow(engineRef, {
  repoRoot,
  scope,
  context: branchContext,
  lenses: BRANCH_LENSES,
  skeptics: Number.isInteger(A.skeptics) ? A.skeptics : 3,
  // Forward the per-run reasoning overrides (verify-code's args.model — a string
  // or a per-stage map — / args.effort / args.thinking knobs, 2026-07-01) —
  // without these lines a preset run could never use them.
  ...(A.model && (typeof A.model === 'string' || typeof A.model === 'object') ? { model: A.model } : {}),
  ...(A.effort !== undefined ? { effort: A.effort } : {}),
  ...(typeof A.thinking === 'boolean' ? { thinking: A.thinking } : {}),
  // Forward the model-governance knobs so a whole-branch run can set the cost ceiling /
  // double-unlock fable exactly as a direct verify-code run would (2026-07-03).
  ...(A.ceiling !== undefined ? { ceiling: A.ceiling } : {}),
  ...(A.fableApproved !== undefined ? { fableApproved: A.fableApproved } : {}),
})
