export const meta = {
  name: 'verify-code',
  description:
    'Canonical adversarial-verify scaffold for CODE review. Config-over-engine: the per-run specifics (scope, lenses, skeptics) are a small config you set via args; the hardened ENGINE below (refute-each -> per-finding map-reduce adjudicate -> graceful-degradation return, with bounded inputs + dedup + lens-failure visibility + a completeness critic) is fixed and do-not-edit. Start HERE for any code verify; verify-branch is a whole-branch preset of this.',
  whenToUse:
    'Any post-implementation code adversarial-verify (a diff, a set of files/dirs on main, or a free-form subsystem audit). Pass args.repoRoot + args.scope + args.context; override args.lenses / args.skeptics for the run. For a whole branch, run verify-branch (it presets this). For DESIGN DOCS pre-implementation, use verify-design-doc instead (gap-hunt, different shape). LAUNCH PROTOCOL (2026-07-01): also set args.model — recommended \'opus\'; stages are PINNED by default (engine never inherits the session model), so this is optional; the DOUBLE-UNLOCK args.ceiling:\'fable\' AND args.fableApproved:true is required for fable (ask Max at the time), and args.ceiling:\'sonnet\' is a hard cheap cap. Per-stage map supported ({review, verify, adjudicate, synthesis}); the skeptic \'verify\' stage is the highest-volume — downgrade it first (e.g. {verify: "sonnet"}). Effort defaults are pre-tuned; override only with a reason. args.compact: true = telegraphic inter-agent findings prose (experimental; default off pending A/B).',
  phases: [
    { title: 'Review', detail: 'parallel lenses over the scope -> candidate findings' },
    { title: 'Verify', detail: 'diverse skeptics try to REFUTE each finding' },
    { title: 'Adjudicate', detail: 'per-finding map-reduce verdict + completeness critic + graceful return' },
  ],
}

// ===========================================================================
// THE CONTRACT (why this scaffold exists — read once)
// ===========================================================================
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
//   * LENS-FAILURE VISIBILITY (added 2026-07-01): agent() resolves to NULL — it does
//     NOT throw — on terminal API errors/skips, so the old `(r && r.findings) || []`
//     mapping silently turned a dead lens into "zero findings" (the first
//     verify-refactor whole-tree run lost its entire duplication lens to a
//     mid-response connection error, invisibly). Lenses now null-check + retry once;
//     what still fails surfaces as `lens_failures` in the result AND feeds the
//     completeness critic. Same null-guards on skeptic/adjudicate/synthesis returns,
//     and zero surviving skeptic votes (all-skeptics-failed) passes the finding to
//     adjudication instead of dropping it as refuted. Mirrored in verify-refactor.js
//     — the engines must stay in lockstep; harden both in the same commit.
// Per-run flexibility is the CONFIG block; the engine is invariant. If a run
// needs a bespoke phase (e.g. a security repro/PoC step), COPY this file and
// insert it BEFORE adjudication — do not weaken the engine.
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
if (!repoRoot) throw new Error('verify-code: pass args.repoRoot = absolute path to the repo (as a JSON object, not a string)')

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
  throw new Error('verify-code: args.scope must be an object with one of diffPath|diff|base/head|paths|audit (got ' + JSON.stringify(A.scope).slice(0, 120) + ')')
const scope = A.scope || {}
const context = A.context || '(no change summary provided; infer it from the scope)'
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
//   BELT: every stage resolves to a CONCRETE pinned model (MODEL_DEFAULTS) — the engine
//     NEVER inherits the session model. Inheriting silently ran a 52-agent fleet at
//     premium cost under a Fable session (2026-07-01); pinning makes cost deterministic
//     regardless of the orchestrator's model.
//   SUSPENDERS: args.model / args.effort still override per stage (a string = all stages,
//     or a per-stage map { review, verify, cluster, adjudicate, synthesis }).
//   CEILING (default opus): no stage may resolve ABOVE opus unless BOTH
//     args.ceiling==='fable' AND args.fableApproved===true (the DOUBLE-UNLOCK — a single
//     fat-fingered arg must not open the premium gate). 'fable' is the token-blowup
//     model; fable@max is the exact pain this guards. args.ceiling:'sonnet' is a hard
//     CHEAP cap. Enforced THREE ways: (1) the args scan just below, (2) a preflight
//     before the first spawn (fail closed + loud, no tokens spent), (3) spawn() per call
//     (bans inherit + locks fable via an independent string-match). A PreToolUse hook on
//     the Workflow tool is the out-of-script backstop (scans caller args for fable).
// ===========================================================================
const MODEL_TIER = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }
const FABLE_UNLOCKED = A.ceiling === 'fable' && A.fableApproved === true
// Effective ceiling: default opus; only the double-unlock raises it to fable. A bare
// ceiling:'fable' without fableApproved clamps to opus (so a fable request still throws).
const CEILING_TIER = FABLE_UNLOCKED ? MODEL_TIER.fable : Math.min(MODEL_TIER[A.ceiling] ?? MODEL_TIER.opus, MODEL_TIER.opus)
const ceilName = Object.keys(MODEL_TIER).find((k) => MODEL_TIER[k] === CEILING_TIER) || 'opus'
// TERTIARY guard: 'fable' hiding anywhere in args (string, per-stage map, typo'd field)
// without the double-unlock — fail before any resolution/spend.
if (typeof A === 'object' && A && /fable/i.test(JSON.stringify(A)) && !FABLE_UNLOCKED)
  throw new Error("verify-code: 'fable' requested in args without the double-unlock (set args.ceiling:'fable' AND args.fableApproved:true, only after Max approves at the time).")

// MODEL_DEFAULTS — the belt. Judgment stages -> opus; high-volume breadth -> sonnet.
// Override precedence: args.model string (all stages) > args.model[stage] > this default.
const MODEL_DEFAULTS = { review: 'opus', verify: 'sonnet', cluster: 'sonnet', adjudicate: 'opus', synthesis: 'opus' }
function modelForRaw(stage) {
  let m = MODEL_DEFAULTS[stage] || 'opus'
  if (typeof A.model === 'string' && A.model) m = A.model
  else if (A.model && typeof A.model === 'object' && typeof A.model[stage] === 'string' && A.model[stage]) m = A.model[stage]
  return m
}
// Clamp a resolved model DOWN to the ceiling — the hard cheap cap when args.ceiling<opus
// (ceiling:'sonnet' runs opus stages as sonnet, logged). 'fable' and unknown models are
// NEVER silently clamped: the args-scan / spawn / preflight guards make a fable request
// fail LOUDLY rather than quietly degrade to opus.
function capModel(m) {
  const tier = MODEL_TIER[m]
  if (tier == null || m === 'fable') return m
  return tier > CEILING_TIER ? ceilName : m
}
function modelFor(stage) { return capModel(modelForRaw(stage)) }
function modelOptFor(stage) { return { model: modelFor(stage) } } // always concrete — never inherit

// Reasoning knobs (2026-07-01, Max; belt-ified 2026-07-03). effort IS the thinking dial
// ('low'|'medium'|'high'|'xhigh'|'max'). EFFORT_DEFAULTS is the belt (per stage); args.effort
// overrides (string = all stages, or a per-stage map); args.thinking:false clamps to 'low',
// true FLOORS at 'high' (raises low, never lowers an xhigh/max). Pinned — never inherits.
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

// SECONDARY guard — EVERY subagent spawns through spawn(), not agent(). Independent of
// the preflight (per-call, not batch) and of MODEL_TIER (string-match): it bans inherit
// (a spawn with no model could ride a premium session) and locks 'fable' unless double-
// unlocked. Catches ad-hoc/future calls the preflight never enumerated. GREP RULE: this
// file must contain NO bare `agent(` — spawn( only.
function spawn(prompt, opts = {}) {
  const label = (opts && opts.label) || '?'
  const m = String((opts && opts.model) || '')
  if (!m) throw new Error(`verify-code spawn [${label}]: no explicit model — inherit is banned (could ride a premium/fable session).`)
  if (/fable/i.test(m) && !FABLE_UNLOCKED) throw new Error(`verify-code spawn [${label}]: model 'fable' without the double-unlock (args.ceiling:'fable' AND args.fableApproved:true). Ask Max first.`)
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

// Default review lenses. Override/extend via args.lenses = [{key, focus}, ...].
const DEFAULT_LENSES = [
  { key: 'correctness', focus: 'Logic bugs: null/undefined access, wrong conditionals, off-by-one, type coercion (e.g. a DB value arriving as Date/string the code did not expect), NaN/empty-set math, async/ordering. Trace the actual values.' },
  { key: 'regression', focus: 'What breaks in code NOT under direct review but interacting with it? Co-consumers of a changed function/shape, removed/renamed symbols still referenced, a field other callers still read, a behavior other surfaces relied on. Grep the whole repo for callers.' },
  { key: 'intent-fidelity', focus: 'Does the code match its stated intent + any cited spec/ADR? Flag over-reach (broke a kept consumer), under-reach (left an old path as a second source of truth), and stale/contradictory docs or comments.' },
  { key: 'security', focus: 'Injection (untrusted input reaching a prompt/SQL/shell/HTML without neutralization), broken authz, a read-only/no-write invariant violated, secrets in code/logs. Consider the realistic threat actor and whether the path is reachable.' },
  { key: 'test-coverage', focus: 'What is claimed working but untested or weakly tested? Map each behavior to the test that exercises its INVARIANT (not just its shape). Name the highest-value missing test. Do not pad with low-value suggestions.' },
]
const lenses = Array.isArray(A.lenses) && A.lenses.length ? A.lenses : DEFAULT_LENSES

const SHARED = [
  'You are adversarially verifying CODE before it is trusted/merged. The test suite is presumed GREEN — find what a green suite + the author missed: correctness bugs, regressions in interacting code, broken invariants, security holes, unverified claims.',
  `Repo root: ${repoRoot}.`,
  buildScopeBrief(),
  'Read the CURRENT files for full context. Reason from the code; do not run builds/tests.',
  '',
  'WHAT THIS IS + INVARIANTS THAT MUST HOLD:',
  context,
  '',
  'Return ONLY concrete, defensible findings with a real code location. An empty findings array is valid and expected for a clean target — do NOT invent issues; a false alarm wastes a verification slot.',
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
// tokens spend if a stage exceeds the ceiling. Replaces the old inherit-session log;
// the resolved plan is now VISIBLE up front (a silent inherit was the 2026-07-01 footgun).
const STAGES = ['review', 'cluster', 'verify', 'adjudicate', 'synthesis']
const plan = STAGES.map((s) => ({ stage: s, raw: modelForRaw(s), model: modelFor(s), effort: effortFor(s) }))
const KNOWN_MODELS = new Set(Object.keys(MODEL_TIER))
const bad = plan.filter((p) => !KNOWN_MODELS.has(p.model) || (p.model === 'fable' && !FABLE_UNLOCKED))
if (bad.length) throw new Error(
  `verify-code preflight: ${bad.map((p) => `${p.stage}->${p.model}`).join(', ')} — model must be haiku|sonnet|opus, or 'fable' WITH the double-unlock (args.ceiling:'fable' AND args.fableApproved:true). No tokens spent.`)
const clamps = plan.filter((p) => p.raw !== p.model)
if (clamps.length) log(`verify-code: ceiling '${ceilName}' clamped ${clamps.map((p) => `${p.stage} ${p.raw}->${p.model}`).join(', ')}.`)
log(`verify-code: ${lenses.length} lenses, ${skeptics} skeptics/finding; ceiling=${ceilName}${FABLE_UNLOCKED ? ' [FABLE UNLOCKED]' : ''}; plan ${plan.map((p) => `${p.stage}=${p.model}/${p.effort}`).join(' ')}${compact ? '; compact prose' : ''}.`)
// LENS-FAILURE VISIBILITY (2026-07-01): agent() resolves to NULL — it does not throw —
// when a subagent dies on a terminal API error or is skipped, so the old
// `(r && r.findings) || []` mapping silently converted a dead lens into "zero
// findings" (the first verify-refactor whole-tree run lost its entire duplication
// lens to a mid-response connection error with no trace in the result). A coverage
// hole must be VISIBLE in the result, never inferred: null/malformed is treated as
// failure, each failed lens retries once, and what still fails is surfaced in
// `lens_failures`.
const lensFailures = []
const runLens = (l, tag) =>
  spawn(`${SHARED}\n\nLENS [${l.key}]: ${l.focus}`, { label: `review:${l.key}${tag}`, phase: 'Review', schema: FINDING_SCHEMA, effort: effortFor('review', 'high'), ...modelOptFor('review') })
    .then((r) => {
      if (!r || !Array.isArray(r.findings)) throw new Error('lens agent returned null/malformed')
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
// near-identical TITLES; cross-lens findings describing the SAME defect in different
// words survive separately and EACH pays the full skeptic + adjudicate re-read cost
// (a 2026-07-01 astra audit yielded 12 findings that were really ~3 defects -> 36
// skeptics where ~9 would do). One cheap agent clusters by underlying defect; we keep
// the highest-severity representative and RECORD the corroborating lens set — N
// independent lenses agreeing is evidence the skeptic/adjudicator should see, which
// the old first-wins dedup discarded. QUALITY GUARANTEE: clustering NEVER drops a
// finding — any index the agent omits becomes its own singleton cluster, and on agent
// failure we fall back to the unclustered set. So worst case = today's behavior.
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
    real: { type: 'boolean', description: 'true ONLY if the defect is genuinely real in the code as written AND reachable' },
    reason: { type: 'string', description: 'cite the actual code; if refuted, say why (guard elsewhere, intended decision, unreachable, misread)' },
  },
}
const SKEPTIC_LENSES = [
  'CORRECTNESS: read the cited code. Is the defect real AS WRITTEN? Hunt for why it is NOT a bug (a guard upstream, a default, a caller contract). Default real=false unless you trace a concrete failing path.',
  'INTENT: genuine defect, or an INTENTIONAL/documented decision (read the spec/ADR/marker)? real=false if intended.',
  'REACHABILITY: does it actually MANIFEST with real data + the real call flow? real=false if unreachable/theoretical.',
]
const verifiable = clustered.filter((f) => f.severity !== 'nit')
const nits = clustered.filter((f) => f.severity === 'nit')
// Severity-scaled skeptics (2026-07-01, Max): blocker/major get the full panel; a
// minor gets ONE (rigor belongs where incidents live — a minor doesn't warrant triple
// refutation; nits already skip verification). Never below 1.
const skepticsFor = (sev) => (sev === 'minor' ? 1 : skeptics)

const verified = await parallel(
  verifiable.map((f) => () =>
    parallel(
      Array.from({ length: skepticsFor(f.severity) }, (_unused, i) => () =>
        spawn(
          `${SHARED}\n\nYou are SKEPTIC #${i + 1} testing ONE finding — try to REFUTE it. ${SKEPTIC_LENSES[i % SKEPTIC_LENSES.length]}\n\nFINDING:\n${JSON.stringify(
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
    must_fix: { type: 'boolean', description: 'true only for a correctness/security/data-loss defect that would cause an incident' },
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
