/**
 * Tier-1 audio cue design, as data.
 *
 * The cues are **synthesised in the browser from these specs**, not shipped as
 * audio files. Three reasons, in order of how much they matter:
 *
 * 1. A cue must never be late. An mp3 is a network fetch that can fail or
 *    stall, and a blocker alarm that arrives after you have already noticed the
 *    problem is not an alarm. Oscillators start in microseconds and cannot 404.
 * 2. Binary assets in a git repo whose entire premise is reviewable plain
 *    markdown are a wart. You cannot read a diff of a wav file.
 * 3. The design is then *legible*: the reason `blocker` is unsettling and
 *    `complete` is resolved is visible here as intervals, and arguable in a
 *    pull request, instead of being a matter of whose sample library got used.
 *
 * The intervals are chosen so the five cues are distinguishable without
 * looking — which is the whole point of an audio cue — and so the two that
 * mean "something is wrong" are the two that sound unresolved.
 */

import type { CueKind } from '@/lib/ops-events'

export interface CueTone {
  /** Hz. */
  freq: number
  /** Seconds from the start of the cue. */
  at: number
  /** Seconds. */
  duration: number
  /** 0-1, before the master gain. */
  gain: number
}

export interface CueSpec {
  kind: CueKind
  /** Oscillator shape. `sine` reads as soft, `triangle` as more insistent. */
  wave: OscillatorType
  tones: CueTone[]
  /** Shown next to the cue in the panel so the design is auditable by ear. */
  description: string
}

/**
 * A4 = 440. Everything below is a just-ish interval from a root, which is why
 * the cues sit together rather than sounding like five unrelated beeps.
 */
const A4 = 440
const C5 = 523.25
const E5 = 659.25
const G5 = 783.99
const A5 = 880
const F4 = 349.23
const B4 = 493.88

export const CUE_SPECS: Record<CueKind, CueSpec> = {
  /**
   * Rising major third, unresolved. Asks a question — something wants you.
   */
  approval: {
    kind: 'approval',
    wave: 'sine',
    tones: [
      { freq: C5, at: 0, duration: 0.11, gain: 0.5 },
      { freq: E5, at: 0.1, duration: 0.16, gain: 0.5 },
    ],
    description: 'Two rising notes, unresolved — something is waiting on you.',
  },

  /**
   * Falling minor second, twice. Deliberately uncomfortable and the only cue
   * that repeats, because a blocker you sleep through is the expensive one.
   */
  blocker: {
    kind: 'blocker',
    wave: 'triangle',
    tones: [
      { freq: B4, at: 0, duration: 0.1, gain: 0.55 },
      { freq: F4, at: 0.09, duration: 0.15, gain: 0.55 },
      { freq: B4, at: 0.28, duration: 0.1, gain: 0.5 },
      { freq: F4, at: 0.37, duration: 0.2, gain: 0.5 },
    ],
    description: 'A falling pair, repeated — something is broken.',
  },

  /**
   * Rising fifth to the octave. Resolved, brief, easy to ignore, which is
   * correct: good news should not demand attention.
   */
  complete: {
    kind: 'complete',
    wave: 'sine',
    tones: [
      { freq: C5, at: 0, duration: 0.09, gain: 0.4 },
      { freq: G5, at: 0.08, duration: 0.09, gain: 0.4 },
      { freq: A5, at: 0.16, duration: 0.18, gain: 0.34 },
    ],
    description: 'Three rising notes, resolved — something finished cleanly.',
  },

  /**
   * A low held tone under a higher one — a sound with weight to it. Money is
   * the one cue that should feel heavier than the others.
   */
  budget: {
    kind: 'budget',
    wave: 'triangle',
    tones: [
      { freq: A4 / 2, at: 0, duration: 0.42, gain: 0.42 },
      { freq: A4, at: 0.06, duration: 0.3, gain: 0.3 },
      { freq: C5, at: 0.22, duration: 0.22, gain: 0.26 },
    ],
    description: 'A low tone with weight under it — spend crossed a threshold.',
  },

  /**
   * One short soft note. The cue for things that are worth a line but should
   * never pull your eyes off what you were doing.
   */
  info: {
    kind: 'info',
    wave: 'sine',
    tones: [{ freq: A4, at: 0, duration: 0.08, gain: 0.28 }],
    description: 'A single soft note — noted, not urgent.',
  },
}

/** Total wall-clock length of a cue, for scheduling and for tests. */
export function cueDurationMs(spec: CueSpec): number {
  return Math.round(
    Math.max(...spec.tones.map((t) => t.at + t.duration)) * 1000,
  )
}

/**
 * Minimum gap between two audible cues.
 *
 * Without this, a poll that yields eight transitions plays eight overlapping
 * chords and you learn nothing except that something happened. The client
 * queues cues at this spacing and collapses repeats — see `voice-provider`.
 */
export const CUE_SPACING_MS = 520

/**
 * The longest a burst of cues may run before the client stops playing them and
 * plays a single `info` instead.
 *
 * A stream that has gone wrong should sound like a stream that has gone wrong
 * for a moment, not for four minutes.
 */
export const CUE_BURST_BUDGET_MS = 6_000
