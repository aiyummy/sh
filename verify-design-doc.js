export const meta = {
  name: 'verify-design-doc',
  description:
    'Adversarially gap-hunt a design doc (ADR/spec): find what it omits, hand-waves, or cannot represent — not just whether its stated claims are true. Includes the counter-lanes gap-hunting structurally lacks: simplicity (argues for LESS design), brownfield rollout (how it lands on the existing system), verifiability (mechanical enforcement vs rule-by-comment), ALTITUDE (fog/tunnel — is each section at the right specificity), and CURRENCY (web research against the post-cutoff state of the art, dated sources required). Role failures surface as role_failures — never silently dropped. The run ends with a pointer to the solo PROMOTION PROTOCOL (junior-to-senior rewrite by the orchestrator; in-file comment block).',
  whenToUse:
    'After drafting or substantially editing a design doc (ADR/spec). Confirmatory claim-checking inherits the author blind spots; this hunts the gaps. Pass args.docs (paths), optional args.repoRoot, optional args.context. LAUNCH PROTOCOL (2026-07-01): set args.model — for an ADR-grade run use model:{gap:\'opus\', currency:\'sonnet\'}: BOTH a bare string \'opus\' AND the bare map {gap:\'opus\'} cascade to the CURRENCY lane too (the gap key applies to every gap-stage role unless an explicit role key overrides), silently upgrading web-search breadth work off its deliberate cheap sonnet default (observed 2026-07-19 — both runs paid opus for query execution; the explicit currency key is the only form that preserves it). Roles are PINNED by default (gap+critic=opus, cluster+currency=sonnet; the engine never inherits the session model); double-unlock args.ceiling:\'fable\' + args.fableApproved:true for a fable pass. Per-stage map { gap, cluster, critic } and per-ROLE keys (e.g. { currency: \'opus\' }) supported — role key wins. AFTER the run: read the output-file .result in full (summary + findings_by_severity lead it), then promote SOLO per the in-file PROMOTION PROTOCOL (senior review -> promoted v2 -> delta -> open questions for Max).',
  phases: [
    { title: 'Gap hunt', detail: 'parallel adversarial roles: structure, premises, worst-case, schema, lifecycle, absences, simplicity, rollout, verifiability, altitude, currency (web SOTA), claim-grounding' },
    { title: 'Merge', detail: 'cluster duplicate findings across lanes; tag corroboration' },
    { title: 'Completeness critic', detail: 'what dimension did the roles themselves miss' },
  ],
}

// ---------------------------------------------------------------------------
// args contract:
//   args.docs:     string | string[]  absolute path(s) to the design doc(s)   [required]
//   args.repoRoot: string             absolute path to the codebase (grounds the one
//                                      confirmatory lane); omit for a doc-only review
//   args.context:  string             one-paragraph statement of the PROBLEM the design
//                                      solves (primes the worst-case tracer); optional
// Returns: { completenessCritic: {...}, role_failures: [...], gapHunt: [...role results],
//            promotion: <string — post-run pointer to the solo PROMOTION PROTOCOL below> }
//
// WHY this shape: a verifier handed the author's checklist only finds checklist items.
// These roles reason from the PROBLEM, not the doc's own framing, and hunt absences /
// unsound premises / unrepresentable cases — the gaps claim-checking structurally misses.
// See memory feedback_adversarial_verify_construction.
//
// SCOPE: this is for DESIGN DOCS (ADRs/specs) only. Verifying CODE/diffs is a different
// shape — find candidate issues, then adversarially verify each finding is real (fix-
// correctness / regression / multi-caller / test-adequacy). Don't point this at code;
// see memory feedback_adversarial_verify_cadence.
// ---------------------------------------------------------------------------

function asList(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return [v]
  return []
}
// Tolerate args passed as a JSON-OBJECT string (a common caller mistake), while
// preserving the deliberate bare-string affordance (args = one doc path): only
// strings that look like a JSON object are parsed.
// A '{'-prefixed string is definitionally a botched JSON object, never a real doc
// path — throw at the guard instead of letting the blob flow through the bare-string
// affordance and burn the whole ~20-agent gap hunt on garbage (2026-07-01 port review).
const A = (typeof args === 'string' && args.trim().startsWith('{'))
  ? (() => { try { return JSON.parse(args) } catch (e) { throw new Error('verify-design-doc: args looked like a JSON-object string but failed to parse (' + e.message + ') — fix the JSON; a bare string is only treated as a doc path when it does not start with "{"') } })()
  : args
const docs = asList(A && A.docs).length ? asList(A.docs) : asList(A)
if (!docs.length) {
  throw new Error('verify-design-doc: pass args.docs = absolute path(s) to the design doc(s) to verify')
}
const repoRoot = (A && A.repoRoot) || ''
const problem = (A && A.context) || '(no problem statement provided; infer it from the document itself)'
// args.compact (2026-07-01, Max): telegraphic inter-agent prose — mirrored from the
// code engines (see verify-code.js). Default OFF — the 2026-07-01 A/B showed ~0%
// token savings (verify cost is input/tool-read-dominated, not output prose).
const compact = (A && A.compact === true)

// ===========================================================================
// MODEL / EFFORT GOVERNANCE (2026-07-03, Max) — belt + suspenders + double-unlock.
// Mirrors the code engines; roleModelFor is design-doc-ONLY (roles, not stages).
//   BELT: gap roles + critic -> opus; the currency web-search role -> sonnet (breadth).
//     NEVER inherits the session model. NOTE (2026-07-03): design-doc gap-hunt no longer
//     auto-rides a max session to max effort — it pins opus/high; an ADR-grade run is an
//     explicit args.model/args.effort choice (see whenToUse).
//   SUSPENDERS: args.model (string=all, or map { gap, critic } and/or per-ROLE keys —
//     role key wins) + args.effort (string, or map { gap, critic }) override.
//   CEILING (default opus): no role may resolve above opus unless BOTH args.ceiling==='fable'
//     AND args.fableApproved===true (double-unlock). Enforced by an args scan, a preflight,
//     and spawn() per call. See verify-code.js for the full rationale.
// ===========================================================================
const MODEL_TIER = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }
const FABLE_UNLOCKED = !!(A && typeof A === 'object' && A.ceiling === 'fable' && A.fableApproved === true)
const CEILING_TIER = FABLE_UNLOCKED
  ? MODEL_TIER.fable
  : Math.min((A && typeof A === 'object' && MODEL_TIER[A.ceiling] != null ? MODEL_TIER[A.ceiling] : MODEL_TIER.opus), MODEL_TIER.opus)
const ceilName = Object.keys(MODEL_TIER).find((k) => MODEL_TIER[k] === CEILING_TIER) || 'opus'
if (A && typeof A === 'object' && /fable/i.test(JSON.stringify(A)) && !FABLE_UNLOCKED)
  throw new Error("verify-design-doc: 'fable' requested in args without the double-unlock (set args.ceiling:'fable' AND args.fableApproved:true, only after Max approves at the time).")

const MODEL_DEFAULTS = { gap: 'opus', critic: 'opus', cluster: 'sonnet' }
// Clamp a resolved model DOWN to the ceiling — hard cheap cap when args.ceiling<opus.
// 'fable'/unknown are NEVER silently clamped (guards make a fable request fail loudly).
function capModel(m) {
  const tier = MODEL_TIER[m]
  if (tier == null || m === 'fable') return m
  return tier > CEILING_TIER ? ceilName : m
}
// Stage-level model (gap|critic). Override: args.model string > args.model[stage] > default.
function modelForRaw(stage) {
  let m = MODEL_DEFAULTS[stage] || 'opus'
  if (A && typeof A.model === 'string' && A.model) m = A.model
  else if (A && A.model && typeof A.model === 'object' && typeof A.model[stage] === 'string' && A.model[stage]) m = A.model[stage]
  return m
}
function modelFor(stage) { return capModel(modelForRaw(stage)) }
function modelOptFor(stage) { return { model: modelFor(stage) } }
// Per-ROLE model (design-doc-only). Precedence: args.model[role] > run-wide args.model
// (string or map 'gap') > the role's own default `model` (currency ships 'sonnet') > opus.
// Never inherits — was the deliberate fable-review inherit, now an explicit double-unlock.
function roleModelForRaw(r) {
  if (A && A.model && typeof A.model === 'object' && typeof A.model[r.key] === 'string' && A.model[r.key]) return A.model[r.key]
  if (A && typeof A.model === 'string' && A.model) return A.model
  if (A && A.model && typeof A.model === 'object' && typeof A.model.gap === 'string' && A.model.gap) return A.model.gap
  return r.model || 'opus'
}
function roleModelFor(r) { return capModel(roleModelForRaw(r)) }
function roleModelOpt(r) { return { model: roleModelFor(r) } }

// Effort — pinned belt (gap/critic 'high'); args.effort overrides (string or map
// { gap, critic }); thinking:false -> 'low', true FLOORS at 'high' (harmonized with the
// code engines, 2026-07-03 — was a bare SET that could lower a max session). Never inherits.
const EFFORT_TIERS = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_DEFAULTS = { gap: 'high', critic: 'high', cluster: 'medium' }
function effortOptFor(stage) {
  let e = EFFORT_DEFAULTS[stage] || 'high'
  if (A && typeof A.effort === 'string' && EFFORT_TIERS.includes(A.effort)) e = A.effort
  else if (A && A.effort && typeof A.effort === 'object' && EFFORT_TIERS.includes(A.effort[stage])) e = A.effort[stage]
  else if (A && A.thinking === false) e = 'low'
  else if (A && A.thinking === true && EFFORT_TIERS.indexOf(e) < EFFORT_TIERS.indexOf('high')) e = 'high'
  return { effort: e }
}

// SECONDARY guard — every subagent spawns through spawn(). Bans inherit + locks fable
// (independent string-match mechanism). GREP RULE: no bare `agent(` in this file.
function spawn(prompt, opts = {}) {
  const label = (opts && opts.label) || '?'
  const m = String((opts && opts.model) || '')
  if (!m) throw new Error(`verify-design-doc spawn [${label}]: no explicit model — inherit is banned (could ride a premium/fable session).`)
  if (/fable/i.test(m) && !FABLE_UNLOCKED) throw new Error(`verify-design-doc spawn [${label}]: model 'fable' without the double-unlock (args.ceiling:'fable' AND args.fableApproved:true). Ask Max first.`)
  return agent(prompt, opts)
}
const docList = docs.map((d, i) => `  ${i + 1}. ${d}`).join('\n')

// BOUNDED OUTPUT (2026-07-19, wf_97a44827 incident): two lanes produced structured
// outputs so large the tool input was TRUNCATED in transit — the findings array was
// dropped, the schema validator rejected with "must have required property 'findings'",
// and after several oversized retries the agents submitted a tiny placeholder stub
// that VALIDATED — a silent coverage hole disguised as a clean lane. Hard per-field
// maxLength + maxItems keep the payload under the transit limit, and the PREAMBLE now
// tells agents a schema rejection means truncation -> resubmit SHORTER, never stub.
const GAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'coverage_note', 'findings'],
  properties: {
    role: { type: 'string', maxLength: 120 },
    coverage_note: {
      type: 'string',
      maxLength: 1500,
      description:
        'What you actually checked. If you found little/nothing in your lane, JUSTIFY that confidence here (what you ruled out and why) rather than padding findings. An all-clean result must earn it.',
    },
    findings: {
      type: 'array',
      maxItems: 12,
      description:
        'Gaps in YOUR lane, ranked most-severe first (at most 12 — merge or drop minors past that). A gap is an absence, a hand-wave, a circular/unsound premise, an unrepresentable case, or an unspecified lifecycle/decision — NOT a false factual claim (that is the claim-grounding lane only; the currency lane\'s gaps are post-cutoff deltas — deprecations/supersessions/lessons — with dated sources).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['gap', 'location', 'severity', 'why_it_matters', 'suggested_fix'],
        properties: {
          gap: { type: 'string', maxLength: 800 },
          location: { type: 'string', maxLength: 300, description: 'Section/quote in the doc, or "(absent)" for a missing thing.' },
          severity: { type: 'string', enum: ['blocking', 'significant', 'minor'] },
          why_it_matters: { type: 'string', maxLength: 800 },
          suggested_fix: { type: 'string', maxLength: 800 },
        },
      },
    },
  },
}

const PREAMBLE = `You are adversarially reviewing a DESIGN document (an ADR / spec), NOT code. Your job is to find what the document does NOT address: gaps, hand-waves, circular or unsound reasoning, cases its schema cannot represent, unspecified lifecycle/operations. You are NOT confirming the claims it makes — a claim being true does not make the design complete.

Hard rules:
- IGNORE the document's own framing of what matters. Reason from the underlying PROBLEM, not the doc's table of contents. The author wrote both the doc and (often) the review checklist, so their blind spots are baked in; your value is seeing past them.
- A design doc with zero gaps is rare. If you genuinely find nothing in your lane, do NOT pad — say so in coverage_note and justify the confidence.
- If the document is marked planned / proposed / not-yet-shipped, then "the code doesn't exist yet" is NOT a gap — a design record describes intent, not build status. Flag missing DESIGN (an undecided question, an unrepresentable case, an unsound premise), never missing IMPLEMENTATION.
- Stay in YOUR lane (below); other roles cover the others.
- OUTPUT FRAMING: write every gap as a design-improvement note for the author — what the design should specify and why. When a gap touches security, state it as the missing control the design should add ("the doc never says who validates untrusted field X; specify it"), in neutral engineering language. Keep facts exact; focus on what to specify, not on misuse scenarios.
- OUTPUT BOUNDS (hard): at most 12 findings, ranked most-severe first; each text field caps at 800 characters (coverage_note 1500). An oversized structured output gets TRUNCATED in transit — the submission arrives without its findings array and is rejected as a schema mismatch. If your submission is rejected that way, your findings were LOST to truncation: resubmit the SAME substance SHORTER. NEVER submit placeholder/stub/test text to satisfy the schema — a fabricated success is worse than a reported failure.

The problem this design addresses:
${problem}

Document(s) to review (read them fully):
${docList}${repoRoot ? `\n\nCodebase root for grounding any code-dependent reasoning: ${repoRoot}` : ''}${compact ? `\n\nPROSE ECONOMY (compact mode): your output is read ONLY by other agents and an orchestrator — never directly by a human. Write every free-text field (gap, why_it_matters, suggested_fix, coverage_note) telegraphically: drop articles, hedging, pleasantries; fragments fine. Keep VERBATIM: identifiers, file paths, quoted doc text, section names, URLs, dates, numbers. Compression drops STYLE only — never a fact or a caveat; if brevity would lose evidence, keep the evidence.` : ''}`

const roles = [
  {
    key: 'structural-integrity',
    prompt: `${PREAMBLE}

YOUR LANE — structural / reference integrity (mechanical, be exhaustive):
- Every internal reference ("see § X", "(below)", "(above)", "per § Y") must resolve to a real section or item. List each that dangles.
- Every schema field or named term DEFINED must be USED somewhere; every field/term USED must be DEFINED. List undefined-but-used and defined-but-unused.
- Every section the doc promises (e.g. it points at "§ Freshness") must actually exist. List promised-but-missing sections.
- Across multiple docs: do they agree where they reference each other?`,
  },
  {
    key: 'premise-auditor',
    prompt: `${PREAMBLE}

YOUR LANE — premises and soundness:
- For each load-bearing claim, name the hidden premise it rests on and scrutinize it: is that premise established, or merely assumed?
- HUNT every claim of the form "X is cheap / easy / automatic / free / deterministic / trivial / reachable / guaranteed / safe / negligible" and demand the concrete mechanism. Gaps hide behind comforting adjectives.
- Flag CIRCULAR reasoning: a claim that depends on the very thing it is meant to produce (e.g. "we cheaply detect X" when detecting X requires the expensive step X was supposed to gate).`,
  },
  {
    key: 'worst-case-tracer',
    prompt: `${PREAMBLE}

YOUR LANE — trace the worst case end to end:
- Identify the hardest scenario the document itself names (or a harder one it implies).
- Walk it STEP BY STEP through the proposed design / schema / flow.
- At each step ask: does this step have a home in the design? Report every point where the scenario breaks, is unrepresentable, falls between defined buckets/states, or hits an unstated boundary (size caps, limits, thresholds, edge transitions).`,
  },
  {
    key: 'schema-adversary',
    prompt: `${PREAMBLE}

YOUR LANE — instantiate the schema against reality:
- For every data schema / structured output the doc defines, construct 2-3 CONCRETE record instances with realistic domain values, deliberately including edge cases: one-to-many, zero, duplicate, boundary, null.
- For each instance, check every field can actually hold the value. Report any field that is singular where the real case is plural (array needed), missing for a real case, wrong-typed, or ambiguous in shape.`,
  },
  {
    key: 'lifecycle-tracer',
    prompt: `${PREAMBLE}

YOUR LANE — lifecycle of every artifact:
- For each artifact / record / cached value / piece of derived state the design produces, trace its full lifecycle: created WHEN and by what; consumed by WHOM; mutated HOW; becomes STALE when; re-run / invalidated HOW; behavior under partial, concurrent, repeated, or out-of-order operations.
- Report any lifecycle stage left unspecified or mishandled (a snapshot that silently re-computes mid-edit, a cache with no stated invalidation, an artifact nobody consumes).`,
  },
  {
    key: 'absence-enumerator',
    prompt: `${PREAMBLE}

YOUR LANE — enumerate absences (do NOT check any claim):
- Imagine a skeptical engineer assigned to IMPLEMENT this tomorrow. List every question they would be forced to ask that the document does not answer.
- Include: decisions deferred without admitting it, "TBD" hiding inside confident prose, and unaddressed operational / failure / cost / calibration / security concerns.
- DEFERRALS (house rule): any "later / v2 / out of scope for now" item parked WITHOUT a concrete re-entry trigger and a named tracking home (e.g. a roadmap entry) is a gap — untracked deferrals get forgotten. The doc must either cut the item or track it; parking it as prose is the failure mode.
- TRUST BOUNDARIES: for every data flow the design sends into a prompt / SQL / shell / HTML surface, the doc must state WHO controls that text and whether/where it is neutralized. Second-order flows count: LLM output derived from untrusted input is still untrusted.
- Each unanswered question is a finding (gap = the question; suggested_fix = what the doc should decide or state).`,
  },
  // The three lanes below were added 2026-07-01: gap-hunting lanes structurally push
  // toward MORE spec and toward greenfield thinking, so a role set without them has
  // baked-in blind spots — nothing argues for deletion, nothing traces how the design
  // LANDS on the running system, and nothing asks how a stated guarantee is ENFORCED
  // (the 2026-07-01 refactor review caught two shipped rule-by-comment failures:
  // a comment-only prod guard and a guard test certifying a stale premise).
  {
    key: 'simplicity-auditor',
    prompt: `${PREAMBLE}

YOUR LANE — over-engineering / simplicity (the ONE lane arguing for LESS design, not more):
- For each mechanism / table / state / knob / phase the design introduces, ask: what actually breaks if it is deleted? Name every piece whose removal costs little — that is complexity someone must build, test, document, and maintain without it pulling its weight.
- Does an EXISTING mechanism (in the doc or the codebase) already cover the need, making the new piece a second source of truth or a parallel pipeline?
- Is any flexibility speculative ("configurable", "pluggable", "future-proof", an enum with one real value) with no named consumer? Speculative generality is a gap.
- Severity in this lane = the carrying cost of the unneeded complexity, not the risk of a missing piece.`,
  },
  {
    key: 'brownfield-rollout',
    prompt: `${PREAMBLE}

YOUR LANE — landing the design on the EXISTING system (designs are rarely greenfield):
- Trace current-state -> target-state: what exists today (data rows, caches, queues, in-flight artifacts, old prompt/cache versions, running crons) and what happens to each when this ships — backfilled, coexisting, invalidated, or stranded?
- Deploy/migration ordering: is there a window where old code runs against new schema/state (or vice versa)? What breaks inside that window?
- Rollback: if this is reverted after N days of production writes, what state is stranded, and does the doc say so?
- Which EXISTING documented invariants/conventions/guards does the design touch, and does the doc state how each is preserved (or explicitly amended)?`,
  },
  {
    key: 'verifiability-auditor',
    prompt: `${PREAMBLE}

YOUR LANE — how would we KNOW each guarantee holds (enforcement, not implementation):
- For each rule / invariant / guarantee the design states ("X must never...", "Y is always...", "Z is invalidated when..."), ask what MECHANICALLY enforces it — a schema constraint, a guard test, a boot assertion, a build-failing drift check — versus a comment or a convention someone must remember. Rule-by-comment on a load-bearing invariant is a gap.
- For each enforcement the doc DOES name, scrutinize its premise: can it actually fail when the rule is violated, and does its premise stay true as the system evolves? A guard with a stale premise certifies the opposite of what it claims.
- What observable signal exists in production when a guarantee is violated (alarm, attention item, red chip, log someone reads), and who sees it? A guarantee whose violation is silent is unverified by construction.`,
  },
  // The two lanes below were added 2026-07-01 (Max), adapted from the junior-to-senior
  // skill (github.com/JuliusBrussee/skills): the gap-hunt reasons from the PROBLEM but
  // not from the PRESENT — no lane checked the doc against the post-cutoff world — and
  // no lane asked whether each section sits at the right LEVEL of specificity.
  {
    key: 'altitude',
    prompt: `${PREAMBLE}

YOUR LANE — altitude (fog/tunnel): is each section at the RIGHT level of specificity? Classify each major section fog | tunnel | ok. Most real docs fog the hard parts and tunnel on the easy ones — detail where the author was comfortable, abstraction where they were not; that inversion is itself a finding. Lane boundary: premise-auditor owns UNSOUND CLAIMS ("X is cheap"); you own MISSING SPECIFICITY and MISSING VISION. Judge against the doc's own declared scope: a decision the doc EXPLICITLY defers with a tracking home is absence-enumerator's turf; a load-bearing choice hiding behind vague words is yours.
- FOG tests (each "no" on a load-bearing part is a gap): START-TOMORROW — could a competent engineer begin this item without making an architecture or product decision themselves? INTERFACE — does everything that crosses a boundary have its shape written down (field names, not "the relevant data")? FAILURE — for each external interaction, what happens when it fails ("handle errors" is not an answer)? QUANTITY — are load-bearing quantities stated (volumes, rates, sizes, latency budgets)? NAMED-TECHNOLOGY — every "a cache / a queue / some auth layer" is either NAMED with version + rationale, or listed as an explicitly-open decision with candidates and a decision trigger.
- TUNNEL tests (against the doc as a whole): AUDIENCE — who is this for, and what can they do afterward that they couldn't before? SUCCESS — is there an OBSERVABLE definition of success (metric, demo, passing suite)? NON-GOALS — anything explicitly out of scope (no non-goals = described, not scoped)? ALTERNATIVE — why did this approach beat the obvious boring alternative? SEQUENCING — smallest useful version first, or a flat list of equally-weighted tasks? PROPORTIONALITY — does detail land where the RISK is (twenty lines on a helper and one on the data migration is upside down)?
- VAGUE-WORD BLACKLIST — challenge each occurrence with the question it hides from: simple/straightforward (compared to what?); scalable (to what number, on which axis?); robust/resilient (against which failures, with what recovery path?); handle gracefully (retry, drop, queue, or surface to user?); performant/fast (what budget, at which percentile?); secure (against which threat model?); flexible/extensible (for which anticipated change, and who pays the carrying cost?); later/eventually/for now (sequencing decision or unowned risk — who reopens it, on what trigger?); etc./and so on (the list was the work — finish it); appropriate/as needed (by whose judgment, applied when?); leverage/utilize (usually decorating an undecided choice — name the thing).`,
  },
  {
    key: 'currency',
    // Web search/triage is recipe'd BREADTH work — a premium model adds little to
    // query execution, and the judgment happens later at promotion (Max, 2026-07-01).
    // Overridable: args.model map key 'currency' > run-wide args.model > this default.
    model: 'sonnet',
    prompt: `${PREAMBLE}

YOUR LANE — currency / state of the art (the one WEB-RESEARCH lane; critical — do not skip, do not fake):
The document's knowledge — like yours — has a training cutoff; your job is to find where the world moved since. If WebSearch/WebFetch are not already available, load them via ToolSearch first. If web access is GENUINELY unavailable, say so in coverage_note, proceed from local evidence only, and tag every best-practice judgment [training-data, unverified] — never launder stale knowledge as current truth.
- Extract the 2-5 LOAD-BEARING technical decisions/assumptions the doc makes (named technologies, patterns, protocols, external-service capabilities/limits/pricing). Research THOSE — typically 3-7 targeted searches total, not 30.
- Query patterns: "<thing> changelog" / "<thing> release notes <current year>"; "<approach> vs <alternative> <current year>"; "<pattern> deprecated" / "considered harmful"; "<tech> security advisory". ALWAYS pin the current year or "latest" into queries — undated queries return the training era, which defeats the point.
- Hunt three deltas: DEPRECATIONS (the doc's approach is now discouraged/removed), SUPERSESSIONS (a newer pattern clearly won — the old way's own docs pointing at the new way is the strongest signal), HARD-WON LESSONS (advisories, postmortems, benchmarks that flip a tradeoff the doc made on priors). Record CONFIRMATIONS too, in coverage_note as "confirmed current: <thing> (<source>, <date>)" — they feed the promotion step's "what the doc got right".
- Source quality: official docs/changelogs/RFCs > maintainer posts and issue threads > dated production postmortems/benchmarks > talks and practitioner blogs (corroborate before citing for a blocking gap) > SEO listicles and undated content (never evidence, at most pointers). Date-check every source — a "best practices" page predating the relevant major version is training-era knowledge wearing a URL.
- EVERY finding's evidence cites source + date inline, e.g. "(prisma.io/docs/releases, 2026-05)". A claim you cannot source gets tagged [training-data, unverified] in the finding text.
- Stopping rules: each load-bearing decision gets one primary source (or two agreeing secondaries), OR two consecutive dry searches (mark it confirmed-by-absence in coverage_note and move on). Spend the budget on would-be blocking/significant gaps, not minors.`,
  },
]

if (repoRoot) {
  roles.push({
    key: 'claim-grounding',
    prompt: `${PREAMBLE}

YOUR LANE — the ONE confirmatory lane: ground the doc's concrete factual claims about the codebase against the actual code at ${repoRoot}. For each load-bearing claim that names a file, function, table, column, route, env var, or behavior, verify it. Report any claim the code contradicts (gap = "wrong: <claim>") or that is imprecise/too-strong (gap = "overstated: <claim>"). Ground the harder facts too: pinned dependency VERSIONS from lockfiles/manifests (a doc assuming an API the pinned version lacks is a blocking gap), PRIOR ART (similar features, ADRs, migrations the doc should cite or consciously break), and BLAST RADIUS (what actually imports/depends on the things the doc changes — the doc's scope estimate is a guess; the dependency graph is a fact). This lane alone may legitimately come back mostly-confirmed; the gap-hunting lanes should not.`,
  })
}

phase('Gap hunt')
// PREFLIGHT — resolve every role's + the critic's model and FAIL CLOSED + LOUD before
// any tokens spend if one exceeds the ceiling. Replaces the old inherit-session log; the
// resolved plan is now VISIBLE up front (a silent inherit was the 2026-07-01 footgun).
const plan = [
  ...roles.map((r) => ({ stage: `gap:${r.key}`, raw: roleModelForRaw(r), model: roleModelFor(r) })),
  { stage: 'cluster', raw: modelForRaw('cluster'), model: modelFor('cluster') },
  { stage: 'critic', raw: modelForRaw('critic'), model: modelFor('critic') },
]
const KNOWN_MODELS = new Set(Object.keys(MODEL_TIER))
const bad = plan.filter((p) => !KNOWN_MODELS.has(p.model) || (p.model === 'fable' && !FABLE_UNLOCKED))
if (bad.length) throw new Error(
  `verify-design-doc preflight: ${bad.map((p) => `${p.stage}->${p.model}`).join(', ')} — model must be haiku|sonnet|opus, or 'fable' WITH the double-unlock (args.ceiling:'fable' AND args.fableApproved:true). No tokens spent.`)
const clamps = plan.filter((p) => p.raw !== p.model)
if (clamps.length) log(`verify-design-doc: ceiling '${ceilName}' clamped ${clamps.map((p) => `${p.stage.replace('gap:', '')} ${p.raw}->${p.model}`).join(', ')}.`)
log(`verify-design-doc: ${roles.length} roles over ${docs.length} doc(s); ceiling=${ceilName}${FABLE_UNLOCKED ? ' [FABLE UNLOCKED]' : ''}; models ${plan.map((p) => `${p.stage.replace('gap:', '')}=${p.model}`).join(' ')}${compact ? '; compact prose' : ''}.`)
// ROLE-FAILURE VISIBILITY (2026-07-01, mirrors the verify-code/verify-refactor
// hardening): agent() resolves to NULL — it does not throw — on terminal API errors
// or skips, and the old bare `.filter(Boolean)` silently DROPPED the whole role from
// the result with no retry and no trace (the same bug class that invisibly lost
// verify-refactor's duplication lens). Null/malformed is treated as failure, each
// failed role retries once, and what still fails is surfaced in `role_failures` AND
// shown to the completeness critic as an unexamined lane.
// STUB DETECTOR (2026-07-19, wf_97a44827 incident): schema bounds stop transit
// truncation, but an agent can still SATISFY the schema with placeholder text
// (observed: gap "test", why "because", fix "fix it" — a validated fabrication).
// An exact placeholder word in any field, OR a finding whose substantive fields
// are ALL tiny, routes through the same retry->role_failures path as null
// output — fabricated success is structurally impossible, not vigilance-dependent.
const STUB_RX = /^(?:test(?:\s?gap)?|probe|stub|placeholder|todo|tbd|n\/a|na|none|nil|x+|-+|\.+|because|fix(?:\s?it)?|why|gap|loc(?:ation)?|file line \d+)$/i
const isStubField = (s) => STUB_RX.test(String(s || '').trim())
const isTiny = (s) => String(s || '').trim().length < 12
const stubbed = (res) =>
  isStubField(res.coverage_note) ||
  (res.findings || []).some(
    (f) =>
      [f.gap, f.location, f.why_it_matters, f.suggested_fix].some(isStubField) ||
      [f.gap, f.why_it_matters, f.suggested_fix].every(isTiny),
  )
const roleFailures = []
const runRole = (r, tag) =>
  spawn(r.prompt, { label: `gap:${r.key}${tag}`, phase: 'Gap hunt', schema: GAP_SCHEMA, agentType: 'Explore', ...roleModelOpt(r), ...effortOptFor('gap') })
    .then((res) => {
      if (!res || !Array.isArray(res.findings)) throw new Error('role agent returned null/malformed')
      if (stubbed(res)) throw new Error('role agent returned placeholder/stub output')
      return res
    })
const gapResults = (
  await parallel(
    roles.map((r) => () =>
      runRole(r, '').catch(() =>
        runRole(r, ':retry').catch(() => {
          roleFailures.push(r.key)
          log(`role ${r.key} failed twice — its lane is UNEXAMINED this run`)
          return null
        }),
      ),
    ),
  )
).filter(Boolean)

// MERGE (2026-07-19, Max): cluster duplicate findings ACROSS lanes and tag
// corroboration instead of dropping — cross-lane agreement is confidence signal
// (5 lanes independently flagging one gap = the strongest finding in the run),
// and unmerged duplication doubles the solo promotion reading (observed: ~80
// raw -> ~50 unique on the ADR-set run). Graceful: a cluster failure degrades
// to unmerged findings with a log line, never throws away the gap hunt.
phase('Merge')
const flat = gapResults.flatMap((r) => r.findings.map((f) => ({ ...f, role: r.role })))
const SEV_RANK = { blocking: 0, significant: 1, minor: 2 }
let merged = flat.map((f) => ({ ...f, corroborating_roles: [f.role] }))
if (flat.length > 1) {
  const CLUSTER_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['clusters'],
    properties: {
      clusters: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['member_indices'],
          properties: {
            member_indices: { type: 'array', maxItems: 20, items: { type: 'integer' }, description: 'indices (from the numbered list) of findings describing the SAME underlying design gap' },
          },
        },
      },
    },
  }
  const numbered = flat.map((f, i) => `${i}. [${f.severity}] (${String(f.role).slice(0, 60)}) ${String(f.gap).slice(0, 200)}`).join('\n')
  const clusters = await spawn(
    `You are deduplicating adversarial design-review findings from parallel review lanes. Below is a numbered list (index, severity, lane, summary). Group findings that describe the SAME underlying design gap (same missing decision/control/lifecycle, even if worded differently or anchored to different sections). Return clusters of member_indices — ONLY clusters with 2+ members (singletons are implied). Do not force-merge: distinct gaps in the same area stay separate.\n\n${numbered}`,
    { label: 'cluster-merge', phase: 'Merge', schema: CLUSTER_SCHEMA, ...modelOptFor('cluster'), ...effortOptFor('cluster') },
  )
    .then((c) => (c && Array.isArray(c.clusters) ? c.clusters : null))
    .catch(() => null)
  if (clusters) {
    const used = new Set()
    const out = []
    for (const cl of clusters) {
      const idxs = (cl.member_indices || []).filter((i) => Number.isInteger(i) && i >= 0 && i < flat.length && !used.has(i))
      if (idxs.length < 2) continue
      idxs.forEach((i) => used.add(i))
      const members = idxs.map((i) => flat[i])
      const canon = members.reduce((a, b) => ((SEV_RANK[a.severity] ?? 3) <= (SEV_RANK[b.severity] ?? 3) ? a : b))
      out.push({ ...canon, corroborating_roles: [...new Set(members.map((m) => m.role))] })
    }
    flat.forEach((f, i) => {
      if (!used.has(i)) out.push({ ...f, corroborating_roles: [f.role] })
    })
    merged = out
    log(`merge: ${flat.length} raw findings -> ${merged.length} unique (${merged.filter((m) => m.corroborating_roles.length > 1).length} corroborated by 2+ lanes)`)
  } else {
    log('cluster-merge failed — returning unmerged findings (corroboration tags absent)')
  }
}

// Compact digest so the completeness critic can react to what already ran —
// including which lanes FAILED (an unexamined lane is a coverage hole, not clean).
const digest = [
  ...gapResults.map((r) => {
    // BOUNDED inputs (lockstep with the code engines' pre-synthesis compaction):
    // unbounded gap text at this single reduce stage was the family's one violation
    // of its own slice-long-fields hardening rule (2026-07-01 port review).
    const items = r.findings.slice(0, 12).map((f) => `${f.severity}:${String(f.gap).slice(0, 180)}`).join(' | ')
      + (r.findings.length > 12 ? ` (+${r.findings.length - 12} more)` : '')
    return `[${r.role}] ${r.findings.length} finding(s): ${items || '(none — ' + (r.coverage_note || '').slice(0, 140) + ')'}`
  }),
  ...roleFailures.map((k) => `[${k}] ROLE FAILED — this lane went UNEXAMINED; treat it as a coverage hole, not as clean`),
].join('\n')

phase('Completeness critic')
// Graceful degradation: the parallel gap hunt above is the expensive deliverable; a
// failure in this single tail critic must never throw it away. agent() can THROW or
// RESOLVE NULL (terminal API error) — retry once, then degrade to a stub that names
// the failure, never a bare null (a bare null silently hides both the missing
// dimension AND its cause). The return below always carries gapHunt regardless.
// (See feedback_adversarial_verify_workflow_design.)
const runCritic = () =>
  spawn(
    `${PREAMBLE}

YOUR LANE — completeness critic. The gap-hunt roles below have already run; here is the digest:

${digest}

Do NOT repeat them. Any line marked ROLE FAILED is an unexamined lane — call it out as a coverage hole. Ask: what CLASS of gap did this whole set of roles structurally fail to look for? What dimension of this design is still unexamined? Consider at least: abuse/incentive cases, interaction with adjacent systems the doc assumes but never names, what happens when the design's CORE assumption is violated, and whether any "out of scope" item is actually load-bearing and wrongly deferred. Report new gaps only. If coverage genuinely looks complete, say so and name what would change your mind.`,
    { label: 'gap:completeness-critic', phase: 'Completeness critic', schema: GAP_SCHEMA, agentType: 'Explore', ...modelOptFor('critic'), ...effortOptFor('critic') },
  ).then((c) => {
    if (!c || !Array.isArray(c.findings)) throw new Error('critic agent returned null/malformed')
    if (stubbed(c)) throw new Error('critic agent returned placeholder/stub output')
    return c
  })
const critic = await runCritic()
  .catch(() => runCritic())
  .catch((err) => {
    const msg = String(err?.message ?? err).slice(0, 300)
    log(`completeness critic failed twice; returning a stub. error: ${msg}`)
    return {
      role: 'completeness-critic',
      coverage_note: `CRITIC FAILED twice (${msg}) — the completeness dimension is UNEXAMINED this run; the gapHunt findings below stand, but re-run the critic or review coverage manually.`,
      findings: [],
      critic_error: msg,
    }
  })

// ===========================================================================
// PROMOTION PROTOCOL (the junior-to-senior step — runs AFTER this workflow)
// ===========================================================================
// This workflow CHECKS; it never rewrites. Promotion is SOLO main-loop work by
// the ORCHESTRATOR — never a subagent: the rewrite needs product intent and
// conversation context no agent has (memory feedback_solo_vs_agents). Adapted
// 2026-07-01 from the junior-to-senior skill. After reading the output-file
// `.result` IN FULL:
//   1. ALTITUDE VERDICT — fog | tunnel | mixed, one-sentence justification
//      (from the altitude lane's findings + your own read of the doc).
//   2. SENIOR REVIEW — findings grouped blocking / significant / minor, each
//      with its evidence (doc quote, file ref, or source+date from the
//      currency lane) and a concrete fix. Credit what the doc got RIGHT —
//      including the currency lane's "confirmed current" notes — with the same
//      care as the faults; the rewrite must preserve it.
//   3. PROMOTED DOC (v2) — goal + non-goals; each load-bearing DECISION with
//      the chosen option (named, with version where applicable), rationale,
//      strongest rejected alternative, and evidence; design at the right
//      altitude (interfaces, data shapes, failure handling on the hard parts;
//      deliberately coarse on the routine); sequencing with an OBSERVABLE
//      verification per milestone; risks + rollback; OPEN QUESTIONS for Max —
//      product direction is never invented by the promoter.
//   4. DELTA SUMMARY — 3-6 bullets: what changed junior->senior and why.
// Boundaries: never silently replace the doc — Max sees review, rewrite, and
// delta, and decides. If research contradicts Max's stated preference, present
// the evidence and defer. Zero blocking/significant findings is a legitimate
// outcome — say "this doc holds" and stop; do not manufacture findings.
// ===========================================================================
// SUMMARY-FIRST RETURN (2026-07-19, Max): the task-notification inline preview
// caps at ~9KB, so lead with the tally + severity-sorted merged findings — the
// preview becomes useful instead of truncating mid-critic-prose. The full
// object is persisted at the output-file under `.result`; read THAT before
// acting on the gaps (coverage notes live in gapHunt), never just the preview
// (see memory feedback_workflow_result_consumption).
const criticTagged = (critic.findings || []).map((f) => ({ ...f, role: 'completeness-critic', corroborating_roles: ['completeness-critic'] }))
const findingsBySeverity = [...merged, ...criticTagged].sort(
  (a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3) || b.corroborating_roles.length - a.corroborating_roles.length,
)
const counts = { blocking: 0, significant: 0, minor: 0 }
findingsBySeverity.forEach((f) => {
  if (counts[f.severity] != null) counts[f.severity]++
})
return {
  summary: {
    counts,
    total_unique: findingsBySeverity.length,
    raw_findings: flat.length + criticTagged.length,
    corroborated_2plus: merged.filter((m) => m.corroborating_roles.length > 1).length,
    roles_completed: gapResults.length,
    role_failures: roleFailures,
  },
  findings_by_severity: findingsBySeverity,
  completenessCritic: critic,
  role_failures: roleFailures,
  gapHunt: gapResults,
  promotion: 'CHECK done. Next: the ORCHESTRATOR promotes SOLO per the PROMOTION PROTOCOL comment block in verify-design-doc.js (altitude verdict -> senior review -> promoted v2 -> delta -> open questions for Max). Work from findings_by_severity (deduped, corroboration-tagged); coverage notes are in gapHunt. Do not delegate the rewrite to an agent.',
}
