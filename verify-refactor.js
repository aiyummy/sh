export const meta = {
  name: 'verify-refactor',
  description:
    'REFACTOR-review fork of verify-code (forked per its own contract: engine intact, config swapped). Hunts refactoring opportunities in WORKING code — duplication, complexity, dead code, inconsistent patterns, naming, error handling, performance, security, data-layer hygiene, frontend state architecture, test design, ops conventions — then skeptics judge each finding on COST/BENEFIT (worth it? riskier than the smell? deliberate?) instead of defect reality. Behavior-preserving by definition: findings improve HOW the code works, never WHAT it does.',
  whenToUse:
    'A refactoring / code-quality review of working code (a whole tree, a subsystem, or specific files) where the question is "what is worth cleaning up", not "what is broken". Pass args.repoRoot + args.scope + args.context; override args.lenses / args.skeptics per run. args.currency: true adds the opt-in WEB-RESEARCH lens (checks pinned deps / patterns / SDK usage against current advisories + supersessions, dated sources required) — SET IT when the tree leans on external services, SDKs, or pinned dependencies; leave off for routine internal reviews. For defect hunts on new work use verify-code; for a whole-branch defect verify use verify-branch; for design docs use verify-design-doc. LAUNCH PROTOCOL (2026-07-01): also set args.model — recommended \'opus\'; stages are PINNED by default (engine never inherits the session model), so this is optional; the DOUBLE-UNLOCK args.ceiling:\'fable\' AND args.fableApproved:true is required for fable (ask Max at the time), and args.ceiling:\'sonnet\' is a hard cheap cap. Per-stage map supported ({review, verify, adjudicate, synthesis}); the skeptic \'verify\' stage is the highest-volume — downgrade it first (e.g. {verify: "sonnet"}). Effort defaults are pre-tuned; override only with a reason. args.compact: true = telegraphic inter-agent findings prose (experimental; default off pending A/B).',
  phases: [
    { title: 'Review', detail: 'parallel refactor lenses over the scope -> candidate findings' },
    { title: 'Verify', detail: 'cost/benefit skeptics try to REFUTE each finding (churn / risk / intent)' },
    { title: 'Adjudicate', detail: 'per-finding map-reduce verdict + completeness critic + graceful return' },
  ],
}

// ===========================================================================
// THE CONTRACT (why this scaffold exists — read once)
// ===========================================================================
// This file is the REFACTOR fork of verify-code.js, created per that file's
// own contract ("if a run needs a bespoke shape, COPY this file — do not
// weaken the engine"). The ENGINE below matches verify-code's (including the
// 2026-07-01 lens-failure-visibility hardening, applied to BOTH files) except:
// the two skeptic/verdict schema DESCRIPTION strings and the must_fix
// description speak cost/benefit instead of defect-reality (prompt text the
// skeptics read — the old wording would contradict the refactor skeptic
// lenses), and the startup log says verify-refactor. Structure, enums,
// control flow, and degradation behavior are identical — if you harden one
// engine, mirror it to the other in the same commit.
//
// A code adversarial-verify reliably fails in two ways unless the ENGINE is
// standardized: (1) a single late-stage adjudicator over many rich findings
// blows the StructuredOutput retry cap and the whole run returns NOTHING; (2)
// confirmatory lenses inherit the author's blind spots and pass plausible-but-
// wrong findings. This scaffold fixes both, the same way every time:
//   * REFUTE each finding with diverse skeptics (kills false positives).
//   * Adjudicate PER FINDING (map), then a tiny synthesis (reduce) over compact
//     objects — never one mega-call emitting a verdict array for all findings.
//   * GRACEFUL DEGRADATION: every reduce/agent is wrapped; the run ALWAYS
//     returns its findings, so a late failure degrades output, never discards
//     the expensive review+verify work.
//   * BOUNDED inputs (slice long text) + DEDUP before the expensive verify.
//   * Resume-friendly: expensive work is in agent() calls (journaled/cached on
//     resume); the fragile synthesis is last + cheapest to edit-and-resume.
// Per-run flexibility is the CONFIG block; the engine is invariant. If a run
// needs a bespoke phase, COPY this file and insert it BEFORE adjudication —
// do not weaken the engine.
//
// CONSUMING THE RESULT (read this, it is load-bearing): the object this script
// returns is persisted IN FULL at the run's output-file under the `.result` key
// (the output-file is one whole-file JSON object: { summary, logs, result, ... }).
// The task-notification's inline <result> preview is CAPPED (~9KB) and silently
// truncates a large result. ALWAYS read the output-file and parse `.result`
// before acting on findings — do NOT treat the truncated inline preview as the
// complete result. If a parse throws, debug it (whole-file JSON, then `.result`);
// never conclude the file is an unreadable transcript and bail (that lost the
// synthesis + nits on the job-77073 verify until the user caught it).
// See memory feedback_adversarial_verify_workflow_design + feedback_workflow_scaffold_crlf.
// ===========================================================================

// --- args / config -----------------------------------------------------------
// Tolerate args passed as a JSON string (a common caller mistake; the tool wants
// a real JSON object). Parse if string so the run doesn't die at the arg guard.
const A = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return {} } })()
  : (args || {})

const repoRoot = A.repoRoot || ''
if (!repoRoot) throw new Error('verify-refactor: pass args.repoRoot = absolute path to the repo (as a JSON object, not a string)')

// scope: HOW reviewers are pointed at the code. One of:
//   { diff: "main...HEAD" }            a git diff range (or { base, head })
//   { diffPath: "C:/.../diff.txt" }    a pre-captured diff file
//   { paths: ["src/x", "src/y"] }      files/dirs in the CURRENT tree (no diff)
//   { audit: "every DB write path" }   a free-form audit; reviewers find the code
// A provided-but-malformed scope must fail LOUDLY before any agent spend: the old
// silent {} fallback degraded a mistyped scope (e.g. scope: "main...HEAD") into an
// unscoped whole-repo free-roam with no trace in the result (2026-07-01 port review).
const SCOPE_KEYS = ['diffPath', 'diff', 'base', 'paths', 'audit']
if (A.scope !== undefined && (typeof A.scope !== 'object' || A.scope === null || Array.isArray(A.scope) || !SCOPE_KEYS.some((k) => k in A.scope)))
  throw new Error('verify-refactor: args.scope must be an object with one of diffPath|diff|base/head|paths|audit (got ' + JSON.stringify(A.scope).slice(0, 120) + ')')
const scope = A.scope || {}
const context = A.context || '(no context provided; infer the codebase purpose from the scope)'
const skeptics = Number.isInteger(A.skeptics) ? A.skeptics : 3
// args.compact (2026-07-01, Max — adapted from the caveman skill's protect-list):
// telegraphic inter-agent prose. Findings prose is read ONLY by other agents and
// the orchestrator, never raw by a human, so style tokens are pure waste there.
// A/B RESULT (2026-07-01, astra-api auth/cache audit, compact on vs off): ~0% token
// delta (1.909M vs 1.908M) — verify cost is INPUT/tool-read-dominated (400+ file
// reads), not output prose, so trimming prose saves nothing here; survivors were
// identical, no quality loss. Kept default OFF: no cost win on read-heavy audits.
// May still help OUTPUT-heavy runs (many long-evidence findings) — unmeasured.
const compact = A.compact === true

// ===========================================================================
// MODEL / EFFORT GOVERNANCE (2026-07-03, Max) — belt + suspenders + double-unlock.
// Mirrored from verify-code.js (lockstep rule) — harden both in the same commit.
//   BELT: every stage resolves to a CONCRETE pinned model (MODEL_DEFAULTS) — the engine
//     NEVER inherits the session model. Inheriting silently ran a 52-agent fleet at
//     premium cost under a Fable session (2026-07-01); pinning makes cost deterministic.
//   SUSPENDERS: args.model / args.effort still override per stage (a string = all stages,
//     or a per-stage map { review, verify, cluster, adjudicate, synthesis }).
//   CEILING (default opus): no stage may resolve ABOVE opus unless BOTH
//     args.ceiling==='fable' AND args.fableApproved===true (the DOUBLE-UNLOCK). 'fable'
//     is the token-blowup model; fable@max is the exact pain this guards.
//     args.ceiling:'sonnet' is a hard CHEAP cap. Enforced three ways: args scan below,
//     a preflight before the first spawn, and spawn() per call (see verify-code.js).
// ===========================================================================
const MODEL_TIER = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }
const FABLE_UNLOCKED = A.ceiling === 'fable' && A.fableApproved === true
// Effective ceiling: default opus; only the double-unlock raises it to fable. A bare
// ceiling:'fable' without fableApproved clamps to opus (so a fable request still throws).
const CEILING_TIER = FABLE_UNLOCKED ? MODEL_TIER.fable : Math.min(MODEL_TIER[A.ceiling] ?? MODEL_TIER.opus, MODEL_TIER.opus)
const ceilName = Object.keys(MODEL_TIER).find((k) => MODEL_TIER[k] === CEILING_TIER) || 'opus'
if (typeof A === 'object' && A && /fable/i.test(JSON.stringify(A)) && !FABLE_UNLOCKED)
  throw new Error("verify-refactor: 'fable' requested in args without the double-unlock (set args.ceiling:'fable' AND args.fableApproved:true, only after Max approves at the time).")

// MODEL_DEFAULTS — the belt. Judgment stages -> opus; high-volume breadth -> sonnet.
const MODEL_DEFAULTS = { review: 'opus', verify: 'sonnet', cluster: 'sonnet', adjudicate: 'opus', synthesis: 'opus' }
function modelForRaw(stage) {
  let m = MODEL_DEFAULTS[stage] || 'opus'
  if (typeof A.model === 'string' && A.model) m = A.model
  else if (A.model && typeof A.model === 'object' && typeof A.model[stage] === 'string' && A.model[stage]) m = A.model[stage]
  return m
}
// Clamp a resolved model DOWN to the ceiling — hard cheap cap when args.ceiling<opus.
// 'fable'/unknown are NEVER silently clamped (guards make a fable request fail loudly).
function capModel(m) {
  const tier = MODEL_TIER[m]
  if (tier == null || m === 'fable') return m
  return tier > CEILING_TIER ? ceilName : m
}
function modelFor(stage) { return capModel(modelForRaw(stage)) }
function modelOptFor(stage) { return { model: modelFor(stage) } } // always concrete — never inherit

// Reasoning knobs (2026-07-01, Max; belt-ified 2026-07-03). effort IS the thinking dial.
// EFFORT_DEFAULTS is the belt; args.effort overrides (string or per-stage map);
// thinking:false clamps to 'low', true FLOORS at 'high'. Pinned — never inherits.
const EFFORT_TIERS = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_DEFAULTS = { review: 'high', verify: 'medium', cluster: 'medium', adjudicate: 'high', synthesis: 'high' }
function effortFor(stage, dflt) {
  let e = dflt !== undefined ? dflt : (EFFORT_DEFAULTS[stage] || 'high')
  if (typeof A.effort === 'string' && EFFORT_TIERS.includes(A.effort)) e = A.effort
  else if (A.effort && typeof A.effort === 'object' && EFFORT_TIERS.includes(A.effort[stage])) e = A.effort[stage]
  else if (A.thinking === false) e = 'low'
  else if (A.thinking === true && EFFORT_TIERS.indexOf(e) < EFFORT_TIERS.indexOf('high')) e = 'high'
  return e
}

// SECONDARY guard — EVERY subagent spawns through spawn(), not agent(). Bans inherit and
// locks 'fable' unless double-unlocked (independent string-match). GREP RULE: this file
// must contain NO bare `agent(` — spawn( only.
function spawn(prompt, opts = {}) {
  const label = (opts && opts.label) || '?'
  const m = String((opts && opts.model) || '')
  if (!m) throw new Error(`verify-refactor spawn [${label}]: no explicit model — inherit is banned (could ride a premium/fable session).`)
  if (/fable/i.test(m) && !FABLE_UNLOCKED) throw new Error(`verify-refactor spawn [${label}]: model 'fable' without the double-unlock (args.ceiling:'fable' AND args.fableApproved:true). Ask Max first.`)
  return agent(prompt, opts)
}

function buildScopeBrief() {
  if (scope.diffPath) {
    return `A code DIFF is under review; the full diff is saved at: ${scope.diffPath} — Read it first, then read the current files for context.`
  }
  if (scope.diff || scope.base) {
    const range = scope.diff || `${scope.base || 'main'}...${scope.head || 'HEAD'}`
    return `A code DIFF is under review: ${range}. Capture it via Bash: git -C "${repoRoot}" --no-pager diff ${range}  (and per-file with -- <path>). Read the current files for full context.`
  }
  if (Array.isArray(scope.paths) && scope.paths.length) {
    return `Review these paths in the CURRENT tree (no diff — read + grep them, and their callers): ${scope.paths.join(', ')}.`
  }
  if (scope.audit) {
    return `AUDIT TASK — find the relevant code yourself (grep/read under ${repoRoot}): ${scope.audit}`
  }
  return `Review the code under ${repoRoot} for the focus below; locate the relevant files yourself.`
}

// Default REFACTOR lenses. Override/extend via args.lenses = [{key, focus}, ...].
const DEFAULT_LENSES = [
  { key: 'duplication', focus: 'Duplicated code that should be consolidated: the same logic/query/JSX/validation copy-pasted across files or repeated within one, near-duplicates that have drifted apart, parallel helpers doing the same job. Flag only where consolidation genuinely reduces maintenance risk (a future fix would have to land in N places and someone will miss one); cite EVERY copy.' },
  { key: 'complexity', focus: 'Overly complex logic that can be simplified WITHOUT changing behavior: god functions doing many unrelated jobs, deep nesting, tangled state (flags mutated across scopes), convoluted conditionals, long parameter lists, logic a simpler structure would express more clearly. Sketch the simpler shape in the suggested fix.' },
  { key: 'dead-code', focus: 'Dead code: functions/exports nothing calls, unreachable branches, unused variables/imports/params, routes or components nothing mounts, feature remnants, one-off scripts that no longer have a caller or a purpose, commented-out blocks kept "just in case". Grep the WHOLE repo (backend, frontend, scripts, AND tests) for references before claiming anything is dead — a false "dead" claim is the most expensive mistake this lens can make.' },
  { key: 'consistency', focus: 'Inconsistent patterns: the same problem solved different ways across files — error responses shaped differently per route, mixed data-fetch idioms, two different date/ID-coercion approaches, ad-hoc reimplementations of an existing shared util. Name the dominant (or better) pattern and list where the deviants are.' },
  { key: 'naming', focus: 'Poor naming: names that lie about what the code now does, vague names (data, handle, tmp, doStuff) on load-bearing symbols, inconsistent vocabulary for one concept across files, names that drifted after behavior changed. Only flag where a rename genuinely aids comprehension of important code — not every imperfect local variable.' },
  { key: 'error-handling', focus: 'Missing or inconsistent error handling: awaited promises with no failure path, catch blocks that swallow errors silently, user-facing surfaces that hang or blank on failure, missing validation at trust boundaries, inconsistent error-response shapes. Distinguish DELIBERATE best-effort catches (often commented) from genuine gaps.' },
  { key: 'performance', focus: 'Performance issues: N+1 queries, work redone per request/render that could be cached or hoisted, sequential awaits that could run in parallel, unbounded queries/loops over growing data, unnecessary re-renders, oversized payloads. Only flag paths that are plausibly hot with realistic data volumes — a one-user internal dashboard has different hot paths than a public site.' },
  { key: 'security', focus: 'Injection (untrusted input reaching a prompt/SQL/shell/HTML without neutralization), broken authz, a read-only/no-write invariant violated, secrets in code/logs. Consider the realistic threat actor and whether the path is reachable.' },
  { key: 'test-coverage', focus: 'What is claimed working but untested or weakly tested? Map each behavior to the test that exercises its INVARIANT (not just its shape). Name the highest-value missing test. Do not pad with low-value suggestions.' },
  // The four lenses below were added 2026-07-01 after the first whole-tree run: its
  // completeness critic flagged these dimensions as STRUCTURAL blind spots (zero
  // findings because no lens looked, not because the areas were clean). Keep them for
  // any whole-tree run; they are cheap relative to the coverage they buy. (Prompt
  // wording generalized from the origin project's conventions when ported into
  // nova-blueprint, 2026-07-01 — these strings must stay codebase-agnostic.)
  { key: 'data-layer', focus: 'SQL and data-layer hygiene: near-duplicate queries that should share a query module, multi-write flows missing a transaction wrapper the codebase otherwise uses, migration remnants (columns/tables/indexes no code reads anymore), query modules drifting from whatever query-organization convention the codebase establishes (or the absence of one where clearly needed), and DB test discipline (what the DB-facing tests actually pin). Read the data-access layer AND every route/service that embeds queries — this layer gets skipped because each query looks fine in isolation.' },
  { key: 'state-architecture', focus: 'Frontend state architecture (cross-file, not per-file): the same server state fetched or duplicated by sibling pages instead of shared, prop drilling a context/hook would simplify, copy-pasted effect patterns an existing shared hook already implements, memoization gaps causing obvious re-render waste, and component-local state silently duplicating a canonical source. Read across the frontend\'s page/route layer and its shared hook/store layer (pages/ and hooks/, routes/ and stores/, or this codebase\'s equivalent) — per-file review structurally misses cross-page state shape.' },
  { key: 'test-design', focus: 'Test DESIGN quality (distinct from coverage): tests that mock the very seam they claim to exercise (the assertion cannot fail for the real path), guard/enforcement tests whose stated premise has gone stale, tautological or shape-only assertions, fixtures drifted from real payload shapes, and over-broad module mocks hiding integration behavior. Name the specific test file and what it fails to protect.' },
  { key: 'ops-conventions', focus: 'Cross-cutting operational conventions: env-var/config flags read ad hoc instead of centrally (and dangerous flags lacking a mechanical guard), logging too inconsistent or context-poor to diagnose from, startup/shutdown lifecycle gaps, and dependency hygiene (unused or duplicated packages, version skew between package manifests if the repo has more than one). Sweep systematically — grep the env-var reads, the logger calls, and every package manifest.' },
]
// CURRENCY LENS (2026-07-19, Max) — OPT-IN web-research lens, activated by
// args.currency: true. OFF by default: routine reviews don't pay web-research cost
// (two-tier research doctrine, memory feedback_verify_current_docs); flip it on
// when the tree leans on external services, provider APIs/SDKs, or pinned
// dependencies. Findings flow through the normal skeptic/adjudication pipeline.
const CURRENCY_LENS = {
  key: 'currency',
  focus: 'CURRENCY / state of the art (the WEB-RESEARCH lens — active because args.currency was set). The code\'s dependencies and patterns — like your training data — have a cutoff; find where the world moved. If WebSearch/WebFetch are not already available, load them via ToolSearch first; if web access is GENUINELY unavailable, return ONE finding saying so (severity nit, title "[web-unavailable]") rather than faking coverage. Extract the 2-5 external-facing load-bearing facts from the scope: pinned dependency versions (read the lockfile/manifest — not the import), provider/SDK usage patterns, libraries whose idioms the code follows. Research those — typically 3-6 targeted searches: "<dep> security advisory <current year>", "<dep> <pinned major> deprecated/superseded", "<pattern> considered harmful <current year>", "<lib> migration guide latest". ALWAYS pin the current year into queries — undated queries return the training era. Report ONLY deltas that make the code WORTH UPDATING (a superseded pattern with a stated successor, a deprecated dep with a maintained replacement, an advisory in the pinned range) — severity = the refactor value, per this engine\'s bar; cite source + date inline in evidence; anything you cannot source gets tagged [training-data, unverified]. An empty findings array is the expected result when deps and patterns are current.',
}
const baseLenses = Array.isArray(A.lenses) && A.lenses.length ? A.lenses : DEFAULT_LENSES
const lenses = A.currency === true ? [...baseLenses, CURRENCY_LENS] : baseLenses

const SHARED = [
  'You are reviewing WORKING code for REFACTORING opportunities. This is NOT a defect hunt: assume the code functions and its test suite is green. The goal is to improve HOW the code does what it does — never WHAT it does. Every suggested refactor must keep behavior identical: same inputs -> same outputs, same side effects, same data written. If a change would alter observable behavior, it is out of scope for this review.',
  `Repo root: ${repoRoot}.`,
  buildScopeBrief(),
  'Read the CURRENT files for full context. Reason from the code; do not run builds/tests.',
  'Spread attention across the ENTIRE scope, including small and peripheral paths (scripts, tests, config, db) — a lens that reads only the biggest central files leaves the rest UNEXAMINED, not verified clean. An empty area must be a deliberate conclusion from having looked, never an artifact of not looking.',
  '',
  'SEVERITY here means REFACTOR VALUE, not defect badness:',
  '  blocker = the current shape is actively causing bugs or actively blocking future changes.',
  '  major   = a high-value refactor (clear payoff in maintenance safety or comprehension).',
  '  minor   = nice to have.',
  '  nit     = cosmetic.',
  'Do not inflate severity. RECOMMENDATION vocabulary (the enum is shared with the defect-verify engine): ship-as-is = codebase healthy, no refactor pass needed; ship-after-fixes = a refactor pass is worth doing; do-not-ship = something is actively causing bugs and needs prompt attention.',
  '',
  'WHAT THIS CODEBASE IS + WHO IS READING YOUR FINDINGS:',
  context,
  '',
  'Return ONLY concrete, defensible findings with a real code location. An empty findings array is valid and expected for a clean target — do NOT invent issues; cosmetic churn wastes a verification slot.',
  '',
  'OUTPUT BOUNDS (hard): at most 12 findings, ranked most-severe first; each text field caps at 800 characters. An oversized structured output gets TRUNCATED in transit — the submission arrives without its findings array and is rejected as a schema mismatch. If your submission is rejected that way, your findings were LOST to truncation: resubmit the SAME substance SHORTER. NEVER submit placeholder/stub/test text to satisfy the schema — a fabricated success is worse than a reported failure.',
  '',
  'OUTPUT FRAMING (all free-text fields): write findings as CODE-IMPROVEMENT notes for the maintainer — describe what the code currently does, why it is incorrect or unsafe, and the fix. Frame every finding as the missing or incorrect logic and its remedy (e.g. "this route omits the authorization check its siblings apply; add it"). State reachability as a plain code-path fact ("this branch runs when the session is absent"), not as instructions for misuse. Keep every technical fact exact — file, line, value, call flow. Neutral, remediation-focused engineering language throughout.',
  ...(compact ? [
    '',
    'PROSE ECONOMY (compact mode): your output is read ONLY by other agents and an orchestrator — never directly by a human. Write every free-text field (claim, evidence, reason, rationale, suggested_fix, summary) telegraphically: drop articles, hedging, pleasantries; fragments fine. Keep VERBATIM: identifiers, file paths + line refs, quoted code, commands, error strings, URLs, dates, numbers. Compression drops STYLE only — never a fact, a caller, or a caveat; if brevity would lose evidence, keep the evidence.',
  ] : []),
].join('\n')

// ===========================================================================
// THE ENGINE — standardized + hardened. DO NOT EDIT per-run; change the config
// above (or args) instead. Edits here change reliability for every consumer.
// ===========================================================================

// BOUNDED OUTPUT (2026-07-19, design-doc wf_97a44827 incident, lockstep-applied here):
// an oversized structured output is TRUNCATED in transit, arrives without `findings`,
// fails schema validation, and after repeated oversized retries the agent may submit
// a tiny placeholder stub that VALIDATES — a silent coverage hole disguised as a clean
// lens. Hard maxItems/maxLength keep payloads under the transit limit; SHARED carries
// the matching resubmit-shorter/never-stub instruction.
const FINDING_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'severity', 'file', 'location', 'claim', 'evidence', 'suggested_fix'],
        properties: {
          title: { type: 'string', maxLength: 200 },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          file: { type: 'string', maxLength: 300 },
          location: { type: 'string', maxLength: 300 },
          claim: { type: 'string', maxLength: 800 },
          evidence: { type: 'string', maxLength: 800, description: 'concrete cross-file code reasoning, not speculation' },
          suggested_fix: { type: 'string', maxLength: 800 },
        },
      },
    },
  },
}

phase('Review')
// PREFLIGHT — resolve every stage's model/effort and FAIL CLOSED + LOUD before any
// tokens spend if a stage exceeds the ceiling. The resolved plan is VISIBLE up front.
const STAGES = ['review', 'cluster', 'verify', 'adjudicate', 'synthesis']
const plan = STAGES.map((s) => ({ stage: s, raw: modelForRaw(s), model: modelFor(s), effort: effortFor(s) }))
const KNOWN_MODELS = new Set(Object.keys(MODEL_TIER))
const bad = plan.filter((p) => !KNOWN_MODELS.has(p.model) || (p.model === 'fable' && !FABLE_UNLOCKED))
if (bad.length) throw new Error(
  `verify-refactor preflight: ${bad.map((p) => `${p.stage}->${p.model}`).join(', ')} — model must be haiku|sonnet|opus, or 'fable' WITH the double-unlock (args.ceiling:'fable' AND args.fableApproved:true). No tokens spent.`)
const clamps = plan.filter((p) => p.raw !== p.model)
if (clamps.length) log(`verify-refactor: ceiling '${ceilName}' clamped ${clamps.map((p) => `${p.stage} ${p.raw}->${p.model}`).join(', ')}.`)
log(`verify-refactor: ${lenses.length} lenses, ${skeptics} skeptics/finding; ceiling=${ceilName}${FABLE_UNLOCKED ? ' [FABLE UNLOCKED]' : ''}; plan ${plan.map((p) => `${p.stage}=${p.model}/${p.effort}`).join(' ')}${compact ? '; compact prose' : ''}.`)
// LENS-FAILURE VISIBILITY (2026-07-01): agent() resolves to NULL — it does not throw —
// when a subagent dies on a terminal API error or is skipped, so the old
// `(r && r.findings) || []` mapping silently converted a dead lens into "zero
// findings" (the first whole-tree run lost its entire duplication lens to a
// mid-response connection error with no trace in the result). A coverage hole must be
// VISIBLE in the result, never inferred: null/malformed is treated as failure, each
// failed lens retries once, and what still fails is surfaced in `lens_failures`.
const lensFailures = []
// STUB DETECTOR (2026-07-19, wf_97a44827 incident, lockstep with verify-design-doc):
// schema bounds stop transit truncation, but an agent can still SATISFY the schema
// with placeholder text (observed there: claim "test", fix "fix it" — a validated
// fabrication). An exact placeholder word in any field, OR a finding whose
// substantive fields are ALL tiny, routes through the same retry->lens_failures
// path as null output — fabricated success is structurally impossible.
const STUB_RX = /^(?:test(?:\s?gap)?|probe|stub|placeholder|todo|tbd|n\/a|na|none|nil|x+|-+|\.+|because|fix(?:\s?it)?|why|claim|title|file line \d+)$/i
const isStubField = (s) => STUB_RX.test(String(s || '').trim())
const isTiny = (s) => String(s || '').trim().length < 12
const stubbedLens = (r) =>
  (r.findings || []).some(
    (f) =>
      [f.title, f.file, f.location, f.claim, f.evidence, f.suggested_fix].some(isStubField) ||
      [f.claim, f.evidence, f.suggested_fix].every(isTiny),
  )
const runLens = (l, tag) =>
  spawn(`${SHARED}\n\nLENS [${l.key}]: ${l.focus}`, { label: `review:${l.key}${tag}`, phase: 'Review', schema: FINDING_SCHEMA, effort: effortFor('review', 'high'), ...modelOptFor('review') })
    .then((r) => {
      if (!r || !Array.isArray(r.findings)) throw new Error('lens agent returned null/malformed')
      if (stubbedLens(r)) throw new Error('lens agent returned placeholder/stub output')
      return r.findings.map((f) => ({ ...f, lens: l.key }))
    })
const reviews = await parallel(
  lenses.map((l) => () =>
    runLens(l, '').catch(() =>
      runLens(l, ':retry').catch(() => {
        lensFailures.push(l.key)
        log(`lens ${l.key} failed twice — its findings are MISSING from this run`)
        return []
      }),
    ),
  ),
)
const raw = reviews.filter(Boolean).flat()
log(`${raw.length} raw findings${lensFailures.length ? `; FAILED lenses: ${lensFailures.join(', ')}` : ''}.`)

// Dedup by file + title-slug so near-duplicates aren't refuted N times each.
// Keep the HIGHEST-severity copy on collision: first-wins let an early nit shadow a
// later blocker out of the skeptic/adjudication pipeline entirely (2026-07-01 port
// review) — nits skip verification, so the shadowed defect could never reach `real`.
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 8).join(' ')
const SEV_RANK = { blocker: 3, major: 2, minor: 1, nit: 0 }
const seenKeys = new Map()
for (const f of raw) {
  const k = `${f.file || ''}::${slug(f.title)}`
  const prev = seenKeys.get(k)
  if (!prev || (SEV_RANK[f.severity] ?? 0) > (SEV_RANK[prev.severity] ?? 0)) seenKeys.set(k, f)
}
const deduped = [...seenKeys.values()]

// SEMANTIC CLUSTER-DEDUP (2026-07-01, Max): the string-slug dedup above only merges
// near-identical TITLES; cross-lens findings describing the SAME issue in different
// words survive separately and EACH pays the full skeptic + adjudicate re-read cost
// (a 2026-07-01 astra audit yielded 12 findings that were really ~3 defects -> 36
// skeptics where ~9 would do). One cheap agent clusters by underlying issue; we keep
// the highest-severity representative and RECORD the corroborating lens set — N
// independent lenses agreeing is evidence the skeptic/adjudicator should see, which
// the old first-wins dedup discarded. QUALITY GUARANTEE: clustering NEVER drops a
// finding — any index the agent omits becomes its own singleton cluster, and on agent
// failure we fall back to the unclustered set. So worst case = today's behavior.
// Mirrored from verify-code.js (lockstep rule).
let clustered = deduped
if (deduped.length > 1) {
  const CLUSTER_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['clusters'],
    properties: {
      clusters: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['member_indices'],
          properties: {
            member_indices: { type: 'array', items: { type: 'integer' }, description: 'indices (from the numbered list) of findings describing the SAME underlying issue' },
          },
        },
      },
    },
  }
  const listing = deduped.map((f, i) => `${i}. [${f.severity}] ${f.file} @ ${f.location} — ${f.title}: ${(f.claim || '').slice(0, 200)}`).join('\n')
  const clusterResult = await spawn(
    `${SHARED}\n\nCLUSTER these candidate findings by UNDERLYING ISSUE — group ONLY those that describe the SAME root issue (same bug/opportunity, same code, even if worded differently or at slightly different lines). Two findings at nearby locations that are GENUINELY DIFFERENT must NOT be merged. Every index appears in exactly ONE cluster; a finding with no duplicate is its own single-member cluster. Findings:\n${listing}`,
    { label: 'cluster-dedup', phase: 'Review', schema: CLUSTER_SCHEMA, effort: effortFor('cluster'), ...modelOptFor('cluster') },
  ).catch(() => null)
  if (clusterResult && Array.isArray(clusterResult.clusters)) {
    const assigned = new Set()
    const groups = []
    for (const c of clusterResult.clusters) {
      const idxs = (c.member_indices || []).filter((i) => Number.isInteger(i) && i >= 0 && i < deduped.length && !assigned.has(i))
      if (!idxs.length) continue
      idxs.forEach((i) => assigned.add(i))
      groups.push(idxs)
    }
    // QUALITY GUARANTEE: any finding the agent dropped becomes its own cluster.
    for (let i = 0; i < deduped.length; i++) if (!assigned.has(i)) groups.push([i])
    clustered = groups.map((idxs) => {
      const members = idxs.map((i) => deduped[i])
      const rep = members.reduce((a, b) => ((SEV_RANK[b.severity] ?? 0) > (SEV_RANK[a.severity] ?? 0) ? b : a))
      const lensSet = [...new Set(members.map((m) => m.lens).filter(Boolean))]
      return { ...rep, corroboration: { count: members.length, lenses: lensSet } }
    })
    log(`clustered ${deduped.length} findings -> ${clustered.length} distinct issue(s).`)
  } else {
    log(`cluster-dedup agent failed; proceeding with ${deduped.length} unclustered findings.`)
  }
}

phase('Verify')
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['real', 'reason'],
  properties: {
    real: { type: 'boolean', description: 'true ONLY if the finding is accurate as described AND the refactor is genuinely worth doing (value beats cost + risk)' },
    reason: { type: 'string', description: 'cite the actual code; if refuted, say why (cosmetic churn, riskier than the smell, deliberate pattern, misread)' },
  },
}
const SKEPTIC_LENSES = [
  'WORTH IT: is this refactor actually worth doing? The payoff (fewer future bugs, meaningfully easier changes, real comprehension gain) must beat the cost of making AND reviewing the change. real=false if it is cosmetic churn a competent dev would not bother fixing. Default real=false unless the value is concrete.',
  'RISK: is the refactor RISKIER than the smell? Trace what depends on the current shape — callers, tests, serialized/persisted data, cache or prompt-version keys, ordering and side effects. real=false if changing it could plausibly break behavior the current ugly-but-working code preserves, and the payoff does not clearly justify that risk.',
  'INTENT: is the pattern DELIBERATE? Read the comments/JSDoc/ADRs/docs around it — performance choices, framework or API constraints, generated code, documented decisions. real=false if the "smell" is an intentional, reasoned choice.',
]
const verifiable = clustered.filter((f) => f.severity !== 'nit')
const nits = clustered.filter((f) => f.severity === 'nit')
// Severity-scaled skeptics (2026-07-01, Max): blocker/major get the full panel; a
// minor gets ONE (rigor belongs where the payoff is — a minor refactor doesn't
// warrant triple cost/benefit debate; nits already skip verification). Never below 1.
const skepticsFor = (sev) => (sev === 'minor' ? 1 : skeptics)

const verified = await parallel(
  verifiable.map((f) => () =>
    parallel(
      Array.from({ length: skepticsFor(f.severity) }, (_unused, i) => () =>
        spawn(
          `${SHARED}\n\nYou are SKEPTIC #${i + 1} testing ONE finding — try to REFUTE it. ${SKEPTIC_LENSES[i % SKEPTIC_LENSES.length]}\n\nIf the finding's evidence cites a DATED EXTERNAL SOURCE (advisory/changelog/release notes), refute the CODE-side premise from the code (the pinned version, the call as written); to dispute the external claim itself, check it via web tools (ToolSearch: WebFetch/WebSearch) — never refute a sourced external fact from memory alone.\n\nFINDING:\n${JSON.stringify(
            { title: f.title, severity: f.severity, file: f.file, location: f.location, claim: f.claim, evidence: (f.evidence || '').slice(0, 700), ...(f.corroboration && f.corroboration.count > 1 ? { corroborating_lenses: f.corroboration.lenses } : {}) }, null, 2,
          )}`,
          { label: 'verify', phase: 'Verify', schema: VERIFY_SCHEMA, effort: effortFor('verify', 'medium'), ...modelOptFor('verify') },
        ).catch(() => null)
      ),
    ).then((votes) => {
      const v = votes.filter(Boolean)
      const realCount = v.filter((x) => x.real).length
      // Zero surviving votes means every skeptic call FAILED (infra), not that the
      // finding was refuted — pass it through to adjudication (whose own catch
      // degrades to a review-manually stub) instead of silently dropping it.
      if (v.length === 0) log(`all skeptics failed for "${String(f.title).slice(0, 60)}" — passing to adjudication unrefuted`)
      return { ...f, real_votes: realCount, total_votes: v.length, survives: realCount * 2 >= v.length }
    }),
  ),
)
const survived = verified.filter((f) => f.survives)
log(`${survived.length}/${verifiable.length} survived refutation; ${nits.length} nits.`)

phase('Adjudicate')
// MAP: adjudicate ONE finding per call (small in/out, fault-isolated). A failed
// call degrades to a stub instead of throwing away the batch.
const ONE_VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'severity', 'must_fix', 'rationale', 'fix'],
  properties: {
    verdict: { type: 'string', enum: ['real', 'false-positive', 'out-of-scope', 'duplicate'] },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
    must_fix: { type: 'boolean', description: 'true only if the current shape is actively causing bugs or data loss (or imminently will) — a merely valuable refactor is must_fix=false' },
    rationale: { type: 'string' },
    fix: { type: 'string' },
  },
}
const adjudicated = await parallel(
  survived.map((f) => () =>
    spawn(
      `${SHARED}\n\nADJUDICATE ONE finding (survived ${f.real_votes}/${f.total_votes} skeptics${f.corroboration && f.corroboration.count > 1 ? `; corroborated by ${f.corroboration.count} lenses: ${f.corroboration.lenses.join(', ')}` : ''}). Read the actual code, then verdict it. Input:\n${JSON.stringify(
        { title: f.title, lens: f.lens, severity: f.severity, file: f.file, location: f.location, claim: f.claim, evidence: (f.evidence || '').slice(0, 800), suggested_fix: (f.suggested_fix || '').slice(0, 400) }, null, 2,
      )}`,
      { label: 'adjudicate', phase: 'Adjudicate', schema: ONE_VERDICT_SCHEMA, effort: effortFor('adjudicate', 'high'), ...modelOptFor('adjudicate') },
    )
      .then((v) => {
        if (!v) throw new Error('adjudication agent returned null')
        return { title: f.title, lens: f.lens, file: f.file, location: f.location, claim: f.claim, real_votes: f.real_votes, corroboration: f.corroboration, ...v }
      })
      .catch(() => ({ title: f.title, lens: f.lens, file: f.file, location: f.location, claim: f.claim, real_votes: f.real_votes, corroboration: f.corroboration, verdict: 'real', severity: f.severity, must_fix: false, rationale: 'adjudication call failed; review manually', fix: f.suggested_fix || '' })),
  ),
)
const real = adjudicated.filter((a) => a.verdict === 'real')

// REDUCE: a small completeness-critic + synthesis over COMPACT objects.
// GRACEFUL DEGRADATION (do not weaken): the LLM synthesis is the LAST + least-
// critical step and is intermittently flaky (forced-StructuredOutput retries +
// transient API errors — observed ~1/3 of runs). It must NEVER cost the
// headline. The recommendation is DERIVABLE from the per-finding verdicts we
// already hold, so on failure we return a DETERMINISTIC recommendation + the
// captured error (synthesis_error) instead of null. Returning null silently
// dropped BOTH the recommendation AND the cause (the 2026-06-29 email-feature
// run); only the LLM-authored completeness_gaps is genuinely lost on failure.
const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'recommendation', 'completeness_gaps'],
  properties: {
    summary: { type: 'string', description: '3-5 sentence readiness read' },
    recommendation: { type: 'string', enum: ['ship-as-is', 'ship-after-fixes', 'do-not-ship'] },
    completeness_gaps: { type: 'array', items: { type: 'string' }, description: 'what CLASS of issue / which lens or claim was NOT adequately covered; worth a human second look' },
  },
}
// Deterministic recommendation from the verdicts — used for the no-findings
// shortcut AND as the synthesis-failure fallback. do-not-ship if any must_fix;
// ship-after-fixes if any real finding; else ship-as-is.
const derivedRecommendation = real.some((r) => r.must_fix)
  ? 'do-not-ship'
  : real.length > 0 ? 'ship-after-fixes' : 'ship-as-is'
let synthesis
if (real.length === 0 && nits.length === 0 && lensFailures.length === 0) {
  synthesis = { summary: 'No real findings survived adversarial verification.', recommendation: 'ship-as-is', completeness_gaps: [] }
} else {
  synthesis = await spawn(
    `${SHARED}\n\nCOMPLETENESS CRITIC + synthesizer. Below are the adjudicated REAL findings (compact) + nits, plus lens_failures: review lenses whose agents FAILED entirely — their whole dimension went UNEXAMINED this run, so treat each as a coverage hole, not as clean. Give a 3-5 sentence readiness summary, a recommendation, and — most important — name what CLASS of issue this lens set structurally failed to look for (the gap a human should re-check). Do NOT re-verdict findings.\n${JSON.stringify(
      { lens_failures: lensFailures, real: real.map((r) => ({ title: r.title, severity: r.severity, must_fix: r.must_fix, file: r.file })), nits: nits.map((n) => ({ title: n.title, file: n.file })) }, null, 2,
    )}`,
    { label: 'synthesis', phase: 'Adjudicate', schema: SYNTH_SCHEMA, effort: effortFor('synthesis', 'high'), ...modelOptFor('synthesis') },
  ).then((s) => {
    if (!s) throw new Error('synthesis agent returned null')
    return s
  }).catch((err) => {
    const msg = String(err?.message ?? err).slice(0, 300)
    log(`synthesis agent failed; using deterministic recommendation '${derivedRecommendation}'. error: ${msg}`)
    return {
      summary: `Synthesis agent failed; recommendation derived deterministically from ${real.length} real finding(s) + ${nits.length} nit(s). The per-finding verdicts above are authoritative; only the completeness-gap analysis was lost.`,
      recommendation: derivedRecommendation,
      completeness_gaps: [],
      synthesis_error: msg,
    }
  })
}

// Return contract — ordered + sized for the task-notification preview. Lead with
// the SMALL, most-important fields (synthesis + counts); keep `real` (the
// actionable findings) in FULL, since the .result persisted to the output-file
// IS this object and a consumer acts on it. Everything else is compacted. We
// DROP the old `survivors: adjudicated` field: in the common all-real case it
// duplicated `real` verbatim and — with synthesis emitted LAST — pushed synthesis
// past the ~9KB notification-preview cap, so it silently truncated and a consumer
// reading only the preview lost the synthesis + nits (job-77073 verify). The
// reorder+dedup keeps a typical result inside the preview; a large result still
// truncates in the preview but is read IN FULL from the output-file `.result`
// (see CONSUMING THE RESULT in the contract above). Non-real survived
// adjudications (false-positive/out-of-scope/duplicate) are compacted, not lost.
return {
  synthesis,              // small + most important -> FIRST (never null; on agent failure it is a deterministic stub carrying synthesis_error)
  lens_failures: lensFailures, // review lenses that died even after a retry — these dimensions are UNEXAMINED, not clean
  counts: { raw: raw.length, deduped: deduped.length, clustered: clustered.length, verified: verifiable.length, survived: survived.length, real: real.length, nits: nits.length },
  real,                   // findings verdicted 'real' — kept in FULL (the actionable deliverable)
  nits,
  refuted: verified.filter((f) => !f.survives).map((f) => ({ title: f.title, file: f.file, claim: f.claim, real_votes: f.real_votes, total_votes: f.total_votes })),
  survived_not_real: adjudicated.filter((a) => a.verdict !== 'real').map((a) => ({ title: a.title, file: a.file, verdict: a.verdict })),
}
