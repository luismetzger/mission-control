'use client'

/**
 * Client-side audio: plays cues, speaks lines, tracks metered characters.
 *
 * Three constraints shaped this, all of them browser facts rather than
 * preferences:
 *
 * 1. **Audio cannot start without a gesture.** Every current browser blocks
 *    `AudioContext` and `speechSynthesis` until the user has interacted with
 *    the page. So there is an explicit enable step, and until it happens the
 *    cockpit is honest about being muted rather than silently swallowing cues.
 *    An alerter you believe is armed and is not is worse than one you know is
 *    off.
 *
 * 2. **Speech is a queue, not a call.** Fire four utterances at
 *    `speechSynthesis` and you get four overlapping voices. Everything is
 *    serialised through one queue with a burst budget.
 *
 * 3. **The metered counter must be durable.** It is the mechanism keeping
 *    approved spend inside its cap, and a counter that resets on every page
 *    load is not a cap. It lives in `localStorage`, keyed by UTC date.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CUE_SPECS, CUE_SPACING_MS, CUE_BURST_BUDGET_MS, cueDurationMs } from '@/lib/ops-cues'
import type { CueKind, OpsEvent } from '@/lib/ops-events'
import { DAILY_CHAR_CAP, type VoiceProviderId } from '@/lib/voice-providers'

const STORAGE_KEY = 'ops-voice-prefs-v1'
const USAGE_KEY = 'ops-voice-usage-v1'

export type VoiceMode = 'off' | 'cues' | 'full'

export interface VoicePrefs {
  /** off: nothing. cues: tones only. full: tones plus spoken lines. */
  mode: VoiceMode
  /** Only play alert-severity events, per the presence modes in architecture/04. */
  alertsOnly: boolean
  volume: number
}

export const DEFAULT_PREFS: VoicePrefs = { mode: 'off', alertsOnly: false, volume: 0.6 }

interface DailyUsage {
  /** UTC date, YYYY-MM-DD. */
  date: string
  chars: number
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function readUsage(): DailyUsage {
  if (typeof window === 'undefined') return { date: todayUtc(), chars: 0 }
  try {
    const raw = window.localStorage.getItem(USAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as DailyUsage
      // A stale date means a new day, so the counter resets — but only forward.
      if (parsed.date === todayUtc()) return parsed
    }
  } catch {
    // Corrupt or unavailable storage. Fail toward the cap rather than past it:
    // an unreadable counter is treated as a fresh day, and the cap still binds
    // within that day.
  }
  return { date: todayUtc(), chars: 0 }
}

function writeUsage(usage: DailyUsage): void {
  try {
    window.localStorage.setItem(USAGE_KEY, JSON.stringify(usage))
  } catch {
    // Nothing useful to do; the in-memory counter still binds this session.
  }
}

function readPrefs(): VoicePrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<VoicePrefs>) }
  } catch {
    // fall through
  }
  return DEFAULT_PREFS
}

export interface OpsVoice {
  prefs: VoicePrefs
  setPrefs: (next: Partial<VoicePrefs>) => void
  /** True once a user gesture has unlocked audio. */
  armed: boolean
  /** Call from a click handler. Browsers require the gesture. */
  arm: () => Promise<boolean>
  /** Play the cue and, in `full` mode, speak the line. */
  announce: (event: OpsEvent) => void
  /** Speak arbitrary text — used by the digest and the orb. */
  speak: (text: string) => void
  /** Play one cue without speech. Used to preview cues in settings. */
  playCue: (kind: CueKind) => void
  stop: () => void
  charsUsedToday: number
  capped: boolean
  /** Which provider would speak right now, and why. */
  provider: { id: VoiceProviderId; reason: string }
}

export function useOpsVoice(): OpsVoice {
  const [prefs, setPrefsState] = useState<VoicePrefs>(DEFAULT_PREFS)
  const [armed, setArmed] = useState(false)
  const [charsUsedToday, setCharsUsedToday] = useState(0)

  const ctxRef = useRef<AudioContext | null>(null)
  const queueRef = useRef<Array<{ event?: OpsEvent; text?: string; cue?: CueKind }>>([])
  const drainingRef = useRef(false)
  const burstStartRef = useRef(0)

  // localStorage is not available during SSR, so hydration happens in an effect.
  useEffect(() => {
    setPrefsState(readPrefs())
    setCharsUsedToday(readUsage().chars)
  }, [])

  const setPrefs = useCallback((next: Partial<VoicePrefs>) => {
    setPrefsState((current) => {
      const merged = { ...current, ...next }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
      } catch {
        // Preference is still applied for this session.
      }
      return merged
    })
  }, [])

  const arm = useCallback(async (): Promise<boolean> => {
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return false
      const ctx = ctxRef.current ?? new Ctor()
      ctxRef.current = ctx
      if (ctx.state === 'suspended') await ctx.resume()
      setArmed(ctx.state === 'running')
      return ctx.state === 'running'
    } catch {
      return false
    }
  }, [])

  const playCue = useCallback(
    (kind: CueKind) => {
      const ctx = ctxRef.current
      if (!ctx || ctx.state !== 'running') return
      const spec = CUE_SPECS[kind]
      const master = ctx.createGain()
      master.gain.value = Math.max(0, Math.min(1, prefs.volume))
      master.connect(ctx.destination)

      const start = ctx.currentTime
      for (const tone of spec.tones) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = spec.wave
        osc.frequency.value = tone.freq
        // A ramped envelope rather than a hard gate — an abrupt oscillator start
        // produces an audible click that reads as a glitch, not a cue.
        const t0 = start + tone.at
        gain.gain.setValueAtTime(0, t0)
        gain.gain.linearRampToValueAtTime(tone.gain, t0 + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.duration)
        osc.connect(gain)
        gain.connect(master)
        osc.start(t0)
        osc.stop(t0 + tone.duration + 0.02)
      }
    },
    [prefs.volume],
  )

  /**
   * Speak one line through the browser synthesiser.
   *
   * The cloud providers are *not* called from here even when a key exists — a
   * browser cannot hold the key, so cloud synthesis has to be a server route
   * that the client fetches audio from. Until that route exists this returns
   * the browser voice, and `provider` below says so rather than implying a
   * cloud voice is in use. Claiming a capability the code does not have is how
   * a spend gate ends up bypassed on paper.
   */
  const speakBrowser = useCallback(
    (text: string) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.volume = Math.max(0, Math.min(1, prefs.volume))
      utterance.rate = 1.05
      window.speechSynthesis.speak(utterance)
    },
    [prefs.volume],
  )

  const noteChars = useCallback((chars: number) => {
    const usage = readUsage()
    const next = { date: usage.date, chars: usage.chars + chars }
    writeUsage(next)
    setCharsUsedToday(next.chars)
  }, [])

  const speak = useCallback(
    (text: string) => {
      if (prefs.mode !== 'full' || !text) return
      speakBrowser(text)
      // Counted even for the free provider, so the character volume behind the
      // approved ~$13/month estimate becomes a measurement before the money is
      // actually switched on.
      noteChars(text.length)
    },
    [prefs.mode, speakBrowser, noteChars],
  )

  const drain = useCallback(() => {
    if (drainingRef.current) return
    drainingRef.current = true
    burstStartRef.current = Date.now()

    const step = () => {
      const item = queueRef.current.shift()
      if (!item) {
        drainingRef.current = false
        return
      }

      // A burst that has run past its budget is a stream misbehaving, not news.
      // Collapse the remainder into one soft note and stop.
      if (Date.now() - burstStartRef.current > CUE_BURST_BUDGET_MS) {
        queueRef.current = []
        playCue('info')
        drainingRef.current = false
        return
      }

      const kind = item.cue ?? item.event?.cue ?? 'info'
      playCue(kind)
      if (item.event) speak(item.event.line)
      else if (item.text) speak(item.text)

      const gap = Math.max(CUE_SPACING_MS, cueDurationMs(CUE_SPECS[kind]) + 120)
      window.setTimeout(step, gap)
    }
    step()
  }, [playCue, speak])

  const announce = useCallback(
    (event: OpsEvent) => {
      if (prefs.mode === 'off' || !armed) return
      if (prefs.alertsOnly && event.severity !== 'alert') return
      // Same transition twice in one burst is one cue.
      if (queueRef.current.some((q) => q.event?.id === event.id)) return
      queueRef.current.push({ event })
      drain()
    },
    [prefs.mode, prefs.alertsOnly, armed, drain],
  )

  const stop = useCallback(() => {
    queueRef.current = []
    drainingRef.current = false
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
  }, [])

  const capped = charsUsedToday >= DAILY_CHAR_CAP

  const provider = useMemo(
    () => ({
      id: 'browser' as VoiceProviderId,
      reason: capped
        ? `Daily character cap reached (${DAILY_CHAR_CAP.toLocaleString()}); cues still play.`
        : 'Browser voice — cloud TTS is approved but not switched on, so this costs nothing.',
    }),
    [capped],
  )

  return {
    prefs,
    setPrefs,
    armed,
    arm,
    announce,
    speak,
    playCue,
    stop,
    charsUsedToday,
    capped,
    provider,
  }
}
