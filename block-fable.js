#!/usr/bin/env node
// PreToolUse hook (matcher "Workflow") — harness-layer backstop for the in-script fable
// guards in the verify-* engines. DENIES a Workflow call whose ARGS request the 'fable'
// model without the DOUBLE-UNLOCK (args.ceiling:'fable' AND args.fableApproved:true).
//
// Scans tool_input.args ONLY — never the script body: the verify engines legitimately
// mention 'fable' in comments, so scanning the script would deny every run. The realistic
// accident this catches is a caller passing model:'fable' via args to a saved/named
// workflow, in a workflow that forgot the in-script spawn() guard. Accident-guard, not
// adversarial — string-building like 'fa'+'ble' evades it (not the threat model).
// 2026-07-03, Max. Rationale: the MODEL/EFFORT GOVERNANCE block in verify-code.js.
let s = ''
process.stdin.on('data', (d) => (s += d))
process.stdin.on('end', () => {
  try {
    const ti = (JSON.parse(s || '{}').tool_input) || {}
    // args may arrive as an object OR as a JSON string (a known caller mistake).
    const argStr = typeof ti.args === 'string' ? ti.args : JSON.stringify(ti.args || {})
    const unlocked =
      /"ceiling"\s*:\s*"fable"/i.test(argStr) && /"fableApproved"\s*:\s*true/i.test(argStr)
    const deny = (reason) =>
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }),
      )
    if (/fable/i.test(argStr) && !unlocked) {
      deny(
        "Blocked: this workflow's args request the 'fable' model without the double-unlock. Fable is the token-blowup model and needs Max's approval AT THE TIME. To proceed, set BOTH args.ceiling:'fable' AND args.fableApproved:true.",
      )
    } else {
      // 2026-07-05 extension (third burn incident): INLINE scripts (tool_input.script) are
      // authored fresh per call — unlike the saved engines they carry no legitimate
      // 'fable' comment baggage — so scan the inline body too:
      //   (a) an explicit fable pin in agent() opts is denied without the args double-unlock;
      //   (b) a script that calls agent( but never writes 'model:' anywhere would INHERIT
      //       the session model (Fable) — denied with instructions to pin.
      // scriptPath-based runs (the saved engines) are exempt: their in-script spawn()
      // guards + this hook's args scan already govern them.
      const script = typeof ti.script === 'string' ? ti.script : ''
      if (script) {
        if (/model\s*[:=]\s*['"`]fable/i.test(script) && !unlocked) {
          deny(
            "Blocked: this inline workflow script pins model:'fable' without the double-unlock (args.ceiling:'fable' AND args.fableApproved:true). Fable subagents need Max's per-instance OK.",
          )
        } else if (/\bagent\s*\(/.test(script) && !/model\s*:/.test(script)) {
          deny(
            'Blocked: this inline workflow script calls agent() with NO model pin anywhere — unpinned workflow agents INHERIT the session model (Fable; incident 2026-07-05). Pin model:"opus"|"sonnet" on every agent() call (or in a shared opts object).',
          )
        }
      }
    }
  } catch (_e) {
    // Fail OPEN on a malformed/absent payload — a hook that crash-blocks every Workflow is
    // worse than missing one edge; the in-script engine guards still enforce.
  }
  process.exit(0)
})
