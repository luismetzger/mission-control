import { describe, it, expect } from 'vitest'
import {
  diffSnapshots,
  budgetEvents,
  redactLine,
  filterBySeverity,
  MAX_LINE_CHARS,
  BUDGET_THRESHOLDS,
  CUE_KINDS,
  type OpsSnapshot,
  type SnapshotApproval,
  type SnapshotRun,
} from '@/lib/ops-events'
import { CUE_SPECS, cueDurationMs } from '@/lib/ops-cues'
import {
  selectProvider,
  availableMetered,
  estimateCost,
  monthToDateEstimate,
  DAILY_CHAR_CAP,
  PROVIDER_INFO,
} from '@/lib/voice-providers'
import { composeDigest, MAX_DIGEST_CHARS, MAX_DIGEST_ITEMS } from '@/lib/ops-digest'

const T = 1_756_800_000_000 // fixed clock

function approval(over: Partial<SnapshotApproval> = {}): SnapshotApproval {
  return {
    path: 'queue/2026-09-02-a.md',
    title: 'A thing',
    expiryState: 'ok',
    daysLeft: 14,
    ...over,
  }
}

function run(over: Partial<SnapshotRun> = {}): SnapshotRun {
  return {
    key: 'owner/repo#Wiki gates#main',
    repo: 'owner/repo',
    workflow: 'Wiki gates',
    conclusion: 'success',
    htmlUrl: 'https://github.com/owner/repo/actions/runs/1',
    zone: 'z0',
    ...over,
  }
}

function snapshot(over: Partial<OpsSnapshot> = {}): OpsSnapshot {
  return { approvals: [], runs: [], budgetFraction: null, takenAt: T, ...over }
}

// ---------------------------------------------------------------------------
// The cold-start rule. This is the single most important behaviour here: without
// it, every deploy announces the entire standing backlog as though it had just
// happened, which trains the operator to mute the alerter.
// ---------------------------------------------------------------------------

describe('cold start', () => {
  it('emits nothing when there is no previous snapshot, however much is pending', () => {
    const next = snapshot({
      approvals: [
        approval({ path: 'queue/a.md' }),
        approval({ path: 'queue/b.md', expiryState: 'expired', daysLeft: -3 }),
      ],
      runs: [run({ conclusion: 'failure' })],
      budgetFraction: 0.95,
    })
    expect(diffSnapshots(null, next)).toEqual([])
  })

  it('emits nothing on a steady state — silence has to mean something', () => {
    const state = snapshot({ approvals: [approval()], runs: [run()] })
    expect(diffSnapshots(state, { ...state, takenAt: T + 60_000 })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

describe('approval transitions', () => {
  it('announces a newly appeared request as an alert', () => {
    const events = diffSnapshots(
      snapshot(),
      snapshot({ approvals: [approval({ title: 'Cloud TTS spend' })] }),
    )
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('ops.approval.requested')
    expect(events[0].cue).toBe('approval')
    expect(events[0].severity).toBe('alert')
    expect(events[0].line).toContain('Cloud TTS spend')
  })

  it('announces expiry only on the edge into expired, not every poll after', () => {
    const before = snapshot({ approvals: [approval({ expiryState: 'due-soon', daysLeft: 0 })] })
    const expired = snapshot({ approvals: [approval({ expiryState: 'expired', daysLeft: -1 })] })

    const crossing = diffSnapshots(before, expired)
    expect(crossing.map((e) => e.type)).toEqual(['ops.approval.expired'])
    expect(crossing[0].cue).toBe('blocker')

    // Already expired on both sides: nothing new to say.
    expect(diffSnapshots(expired, { ...expired, takenAt: T + 60_000 })).toEqual([])
  })

  it('warns on the edge into due-soon but not from expired backwards', () => {
    const ok = snapshot({ approvals: [approval({ expiryState: 'ok', daysLeft: 5 })] })
    const soon = snapshot({ approvals: [approval({ expiryState: 'due-soon', daysLeft: 2 })] })
    const events = diffSnapshots(ok, soon)
    expect(events.map((e) => e.type)).toEqual(['ops.approval.due_soon'])
    expect(events[0].severity).toBe('notice')
    expect(events[0].line).toContain('2 days')
  })

  it('treats a request leaving the pending queue as a decision', () => {
    const events = diffSnapshots(snapshot({ approvals: [approval({ title: 'Ops token' })] }), snapshot())
    expect(events.map((e) => e.type)).toEqual(['ops.approval.decided'])
    expect(events[0].cue).toBe('complete')
    expect(events[0].line).toContain('Ops token')
  })

  it('gives every approval event a somewhere to go', () => {
    const events = diffSnapshots(snapshot(), snapshot({ approvals: [approval()] }))
    expect(events[0].href).toBe('/ops-approvals')
  })

  it('keys events by path so the same transition dedupes across polls', () => {
    const a = diffSnapshots(snapshot(), snapshot({ approvals: [approval()] }))
    const b = diffSnapshots(snapshot(), snapshot({ approvals: [approval()], takenAt: T + 5_000 }))
    expect(a[0].id).toBe(b[0].id)
  })
})

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

describe('CI transitions', () => {
  it('announces green to red as a blocker', () => {
    const events = diffSnapshots(
      snapshot({ runs: [run()] }),
      snapshot({ runs: [run({ conclusion: 'failure' })] }),
    )
    expect(events.map((e) => e.type)).toEqual(['ops.ci.failed'])
    expect(events[0].cue).toBe('blocker')
    expect(events[0].severity).toBe('alert')
  })

  it('announces red to green as recovery, quietly', () => {
    const events = diffSnapshots(
      snapshot({ runs: [run({ conclusion: 'failure' })] }),
      snapshot({ runs: [run()] }),
    )
    expect(events.map((e) => e.type)).toEqual(['ops.ci.recovered'])
    expect(events[0].severity).toBe('notice')
  })

  it('says nothing about a workflow it is seeing for the first time', () => {
    // A newly added workflow that is already failing is not a transition — the
    // watcher has no idea when it broke, and guessing produces a false alarm.
    const events = diffSnapshots(
      snapshot({ runs: [run()] }),
      snapshot({ runs: [run(), run({ key: 'owner/other#Tests#main', conclusion: 'failure' })] }),
    )
    expect(events).toEqual([])
  })

  it('does not re-announce a failure that stays failing', () => {
    const red = snapshot({ runs: [run({ conclusion: 'failure' })] })
    expect(diffSnapshots(red, { ...red, takenAt: T + 60_000 })).toEqual([])
  })

  it('treats cancelled as not-green, so a cancel-then-pass reads as recovery', () => {
    const events = diffSnapshots(
      snapshot({ runs: [run({ conclusion: 'cancelled' })] }),
      snapshot({ runs: [run()] }),
    )
    expect(events.map((e) => e.type)).toEqual(['ops.ci.recovered'])
  })

  it('carries the run zone rather than assuming z0', () => {
    const events = diffSnapshots(
      snapshot({ runs: [run({ zone: 'z1-kevin-anan' })] }),
      snapshot({ runs: [run({ zone: 'z1-kevin-anan', conclusion: 'failure' })] }),
    )
    expect(events[0].zone).toBe('z1-kevin-anan')
  })
})

// ---------------------------------------------------------------------------
// Budget. The daily monitor has already been burned once by a threshold check
// that misread its input and then went permanently silent, so these are blunt.
// ---------------------------------------------------------------------------

describe('budget thresholds', () => {
  it('fires once on each upward crossing', () => {
    expect(budgetEvents(0.45, 0.52, T).map((e) => e.type)).toEqual(['ops.budget.threshold'])
    expect(budgetEvents(0.52, 0.55, T)).toEqual([])
  })

  it('fires for every threshold jumped in one step', () => {
    const events = budgetEvents(0.1, 1.05, T)
    expect(events).toHaveLength(BUDGET_THRESHOLDS.length)
  })

  it('never fires on a downward move — a new month starting at zero is not news', () => {
    expect(budgetEvents(0.95, 0.02, T)).toEqual([])
  })

  it('says nothing when spend is unknown rather than guessing zero', () => {
    expect(budgetEvents(null, 0.9, T)).toEqual([])
    expect(budgetEvents(0.1, null, T)).toEqual([])
  })

  it('escalates severity at 80% and recommends pausing at 100%', () => {
    expect(budgetEvents(0.7, 0.85, T)[0].severity).toBe('alert')
    expect(budgetEvents(0.4, 0.45, T)).toEqual([])
    expect(budgetEvents(0.99, 1.0, T)[0].line).toContain('pause')
  })

  it('scopes its id to the month, so next month can cross the same line again', () => {
    const sept = budgetEvents(0.4, 0.6, Date.parse('2026-09-15T00:00:00Z'))[0]
    const oct = budgetEvents(0.4, 0.6, Date.parse('2026-10-15T00:00:00Z'))[0]
    expect(sept.id).not.toBe(oct.id)
  })
})

// ---------------------------------------------------------------------------
// Redaction. Rule 9 forbids PII and secrets in the wikis; a spoken line is a
// worse place for them, because it leaves the machine as sound in a room.
// ---------------------------------------------------------------------------

describe('redaction', () => {
  it('strips email addresses', () => {
    expect(redactLine('ping kevin.anan@example.com about it')).not.toContain('@example.com')
  })

  it('strips long digit runs like a QuickBooks customer id', () => {
    expect(redactLine('customer 9130357978299526 is overdue')).not.toContain('9130357978299526')
  })

  it('strips AWS access key ids and token-shaped strings', () => {
    // Exactly the real shape (AKIA + 16)...
    expect(redactLine('key AKIAQQQQWWWWEEEERRRR')).not.toContain('AKIAQQQQ')
    // ...and a longer lookalike, because a redactor that only catches the exact
    // length has failed open on the one that got mangled in transit.
    expect(redactLine('key AKIAQQQQWWWWEEEERRRRTTTT')).not.toContain('AKIAQQQQ')
    expect(redactLine('token ghp_abcdefghijklmnopqrstuvwxyz0123')).not.toContain('ghp_abc')
  })

  it('leaves ordinary short numbers alone — a cue that says "[redacted] days" is useless', () => {
    expect(redactLine('expires in 3 days, 2026-09-02')).toBe('expires in 3 days, 2026-09-02')
  })

  it('applies to spoken lines produced by the differ, not just when called directly', () => {
    const events = diffSnapshots(
      snapshot(),
      snapshot({ approvals: [approval({ title: 'invoice for kevin@example.com' })] }),
    )
    expect(events[0].line).not.toContain('kevin@example.com')
  })

  it('caps a pathological title so one line cannot monopolise the voice', () => {
    const events = diffSnapshots(
      snapshot(),
      snapshot({ approvals: [approval({ title: 'x'.repeat(600) })] }),
    )
    expect(events[0].line.length).toBeLessThanOrEqual(MAX_LINE_CHARS)
  })
})

describe('severity filtering', () => {
  it('keeps only alerts in important-only mode', () => {
    const events = diffSnapshots(
      snapshot({ approvals: [approval({ expiryState: 'ok', daysLeft: 5 })] }),
      snapshot({
        approvals: [approval({ expiryState: 'due-soon', daysLeft: 2 })],
        runs: [],
      }),
    )
    expect(filterBySeverity(events, true)).toEqual([])
    expect(filterBySeverity(events, false)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------

describe('cue specs', () => {
  it('defines a spec for every cue kind', () => {
    for (const kind of CUE_KINDS) expect(CUE_SPECS[kind]).toBeDefined()
  })

  it('keeps every cue short enough to be a cue rather than a jingle', () => {
    for (const kind of CUE_KINDS) expect(cueDurationMs(CUE_SPECS[kind])).toBeLessThan(1000)
  })

  it('gives each kind a distinguishable tone signature', () => {
    // Identical cues for different meanings defeats the entire point of audio
    // feedback, so this asserts the designs actually differ.
    const signatures = CUE_KINDS.map((k) =>
      `${CUE_SPECS[k].wave}:${CUE_SPECS[k].tones.map((t) => Math.round(t.freq)).join(',')}`,
    )
    expect(new Set(signatures).size).toBe(CUE_KINDS.length)
  })

  it('keeps gains inside unity so a cue cannot clip', () => {
    for (const kind of CUE_KINDS) {
      for (const tone of CUE_SPECS[kind].tones) {
        expect(tone.gain).toBeGreaterThan(0)
        expect(tone.gain).toBeLessThanOrEqual(1)
      }
    }
  })

  it('makes the two bad-news cues the loudest and blocker the only repeating one', () => {
    const peak = (k: (typeof CUE_KINDS)[number]) =>
      Math.max(...CUE_SPECS[k].tones.map((t) => t.gain))
    expect(peak('blocker')).toBeGreaterThan(peak('info'))
    expect(peak('blocker')).toBeGreaterThan(peak('complete'))
    // Blocker repeats its falling pair; nothing else repeats a frequency.
    const freqs = CUE_SPECS.blocker.tones.map((t) => t.freq)
    expect(new Set(freqs).size).toBeLessThan(freqs.length)
  })
})

// ---------------------------------------------------------------------------
// The spend gate. This is the part that must not be able to fail open.
// ---------------------------------------------------------------------------

describe('voice provider selection', () => {
  it('uses the free browser voice when no cloud key is set', () => {
    const selection = selectProvider({}, 0, 100)
    expect(selection.provider).toBe('browser')
    expect(selection.degraded).toBe(false)
    expect(selection.reason).toMatch(/no cloud tts key/i)
  })

  it('treats a blank or whitespace key as absent', () => {
    expect(selectProvider({ OPS_TTS_OPENAI_KEY: '' }, 0, 10).provider).toBe('browser')
    expect(selectProvider({ OPS_TTS_OPENAI_KEY: '   ' }, 0, 10).provider).toBe('browser')
  })

  it('only reports a metered provider available once its key exists', () => {
    expect(availableMetered({})).toEqual([])
    expect(availableMetered({ OPS_TTS_OPENAI_KEY: 'sk-x' })).toEqual(['openai'])
    expect(availableMetered({ OPS_TTS_ELEVENLABS_KEY: 'el-x' })).toEqual(['elevenlabs'])
  })

  it('prefers the subscription over the metered one when both are present', () => {
    // ElevenLabs is paid whether used or not, so spending OpenAI cents while an
    // ElevenLabs plan sits idle would pay twice for one sentence.
    const selection = selectProvider(
      { OPS_TTS_OPENAI_KEY: 'sk-x', OPS_TTS_ELEVENLABS_KEY: 'el-x' },
      0,
      100,
    )
    expect(selection.provider).toBe('elevenlabs')
  })

  it('honours an explicit preference', () => {
    const selection = selectProvider(
      { OPS_TTS_OPENAI_KEY: 'sk-x', OPS_TTS_ELEVENLABS_KEY: 'el-x', OPS_TTS_PREFERRED: 'openai' },
      0,
      100,
    )
    expect(selection.provider).toBe('openai')
  })

  it('ignores a preference for a provider that has no key', () => {
    const selection = selectProvider(
      { OPS_TTS_OPENAI_KEY: 'sk-x', OPS_TTS_PREFERRED: 'elevenlabs' },
      0,
      100,
    )
    expect(selection.provider).toBe('openai')
  })

  it('falls back to the free voice at the daily cap rather than going silent', () => {
    const selection = selectProvider({ OPS_TTS_OPENAI_KEY: 'sk-x' }, DAILY_CHAR_CAP, 1)
    expect(selection.provider).toBe('browser')
    expect(selection.degraded).toBe(true)
  })

  it('checks the cap against the projected total, so one long line cannot straddle it', () => {
    const justUnder = DAILY_CHAR_CAP - 10
    expect(selectProvider({ OPS_TTS_OPENAI_KEY: 'sk-x' }, justUnder, 5).provider).toBe('openai')
    expect(selectProvider({ OPS_TTS_OPENAI_KEY: 'sk-x' }, justUnder, 50).provider).toBe('browser')
  })

  it('costs the browser voice at zero and the metered ones from published rates', () => {
    expect(estimateCost('browser', 1_000_000)).toBe(0)
    expect(estimateCost('openai', 1_000_000)).toBeCloseTo(15, 5)
    expect(PROVIDER_INFO.openai.pricingSource).toContain('openai.com')
    expect(PROVIDER_INFO.elevenlabs.pricingSource).toContain('elevenlabs.io')
  })

  it('reproduces the approved monthly estimate from the approved volume', () => {
    // The queue entry claimed 135k characters/month is $2.03 at OpenAI's rate.
    // If that arithmetic was wrong, the approval rested on a wrong number.
    const estimate = monthToDateEstimate({ openai: 135_000 })
    expect(estimate.usd).toBeCloseTo(2.03, 2)
    expect(estimate.totalChars).toBe(135_000)
  })

  it('omits providers with no usage from the breakdown', () => {
    expect(monthToDateEstimate({ openai: 100, elevenlabs: 0 }).lines).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The digest. Speech is linear and unskippable, so ordering is the design.
// ---------------------------------------------------------------------------

describe('spoken digest', () => {
  const empty = {
    failingRuns: [],
    approvals: [],
    meetings: [],
    clientDeltas: [],
    budgetFraction: null,
  }

  it('says so explicitly when nothing is wrong', () => {
    const digest = composeDigest(empty, T)
    expect(digest.text).toMatch(/nothing is broken and nothing is waiting/i)
  })

  it('puts an expired approval before broken CI and before the calendar', () => {
    const digest = composeDigest(
      {
        ...empty,
        approvals: [{ title: 'Ops token', daysLeft: -2 }],
        failingRuns: [{ repo: 'owner/brain', workflow: 'Wiki gates' }],
        meetings: [{ title: 'Kevin review', startsAt: '7:30 AM' }],
      },
      T,
    )
    const expiredAt = digest.text.indexOf('expired')
    const ciAt = digest.text.indexOf('Wiki gates')
    const meetingAt = digest.text.indexOf('Kevin review')
    expect(expiredAt).toBeGreaterThan(-1)
    expect(expiredAt).toBeLessThan(ciAt)
    expect(ciAt).toBeLessThan(meetingAt)
  })

  it('says an expired approval is already failing the build, not merely waiting', () => {
    const digest = composeDigest({ ...empty, approvals: [{ title: 'X', daysLeft: -1 }] }, T)
    expect(digest.text).toMatch(/failing the wiki gate/i)
  })

  it('mentions spend only once it is worth interrupting for', () => {
    expect(composeDigest({ ...empty, budgetFraction: 0.4 }, T).text).not.toMatch(/percent/)
    expect(composeDigest({ ...empty, budgetFraction: 0.85 }, T).text).toMatch(/85 percent/)
  })

  it('drops the least important items first when truncating', () => {
    const digest = composeDigest(
      {
        ...empty,
        approvals: [{ title: 'Urgent', daysLeft: -1 }],
        failingRuns: [{ repo: 'o/r', workflow: 'Gates' }],
        meetings: [{ title: 'Standup', startsAt: '9 AM' }],
        clientDeltas: Array.from({ length: 10 }, (_, i) => ({
          client: `Client ${i}`,
          summary: 'moved',
        })),
      },
      T,
    )
    expect(digest.truncated).toBe(true)
    expect(digest.sentences.length).toBeLessThanOrEqual(MAX_DIGEST_ITEMS)
    expect(digest.text).toMatch(/expired/) // the important thing survived
    expect(digest.text).not.toMatch(/Client 9/)
  })

  it('stays inside the spoken character budget even with pathological input', () => {
    const digest = composeDigest(
      {
        ...empty,
        clientDeltas: [{ client: 'C', summary: 'y'.repeat(5000) }],
      },
      T,
    )
    expect(digest.chars).toBeLessThanOrEqual(MAX_DIGEST_CHARS)
  })

  it('never drops the greeting, so a truncated digest still opens like one', () => {
    const digest = composeDigest(
      { ...empty, clientDeltas: Array.from({ length: 30 }, () => ({ client: 'C', summary: 'x' })) },
      T,
    )
    expect(digest.sentences[0]).toMatch(/^Good (morning|afternoon|evening)\./)
  })

  it('redacts the digest as well as individual cues', () => {
    const digest = composeDigest(
      { ...empty, clientDeltas: [{ client: 'Kevin', summary: 'emailed kevin@example.com' }] },
      T,
    )
    expect(digest.text).not.toContain('kevin@example.com')
  })

  it('says the calendar is empty rather than omitting it', () => {
    // A digest that silently skips the calendar is indistinguishable from one
    // whose calendar read failed.
    expect(composeDigest(empty, T).text).toMatch(/nothing on the calendar/i)
  })
})
