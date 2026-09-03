'use client'

/**
 * The orb — push-to-talk, and the cockpit's one piece of ambient state.
 *
 * ## Why push-to-talk and not a wake word
 *
 * "Wake up, Jarvis" was the ask, and every route to it was blocked for a
 * different reason. Picovoice Porcupine ships a built-in "Jarvis" keyword and
 * runs fully on-device, but its free plan is non-commercial and commercial use
 * is the $6,000/year Foundation plan. openWakeWord's code is Apache 2.0 while
 * its pre-trained models — including "hey jarvis" — are CC BY-NC-SA, and it
 * cannot run in a browser at all. The browser's own `SpeechRecognition` streams
 * microphone audio to Google's servers, so an always-on listener would mean
 * continuously shipping office audio, including client calls, to a third party:
 * a direct breach of rules 4 and 9.
 *
 * So: hold a key, or click the orb. Same interaction, no always-on microphone,
 * no licence problem, no cost. A custom openWakeWord model sidesteps the licence
 * and is genuinely doable — roughly a couple of hours plus a 4 GB negative
 * dataset and a new service on the box — and that is parked in 2.3 with the rest
 * of voice input rather than wedged in here.
 *
 * ## What it does now
 *
 * Holding the hotkey arms audio and speaks the digest. Speech *input* is 2.3, so
 * the orb does not pretend to listen — it shows that it is armed and speaks back.
 * The affordance is built now so 2.3 is a capability change, not a UI change.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { CueKind } from '@/lib/ops-events'

export type OrbState = 'muted' | 'idle' | 'speaking' | 'listening' | 'alert'

export interface VoiceOrbProps {
  state: OrbState
  /** The most recent cue class, used to tint the orb. */
  lastCue?: CueKind | null
  /** Fired on click or on the hotkey. */
  onActivate: () => void
  /** Held-key release, for when 2.3 wires up capture. */
  onRelease?: () => void
  /** Hotkey display label, e.g. "⌥ Space". */
  hotkeyLabel?: string
  className?: string
}

const STATE_COLOR: Record<OrbState, string> = {
  muted: 'bg-muted-foreground/30',
  idle: 'bg-sky-500/70',
  speaking: 'bg-emerald-500/80',
  listening: 'bg-amber-500/80',
  alert: 'bg-rose-500/85',
}

const STATE_LABEL: Record<OrbState, string> = {
  muted: 'Voice off — click to enable audio',
  idle: 'Voice armed — hold to speak the digest',
  speaking: 'Speaking',
  listening: 'Listening',
  alert: 'Something needs attention',
}

export function VoiceOrb({
  state,
  lastCue,
  onActivate,
  onRelease,
  hotkeyLabel = '⌥ Space',
  className,
}: VoiceOrbProps) {
  const [held, setHeld] = useState(false)
  const heldRef = useRef(false)

  /**
   * Hotkey: Alt/Option + Space, held.
   *
   * `repeat` is checked because holding a key fires keydown continuously, and
   * without it a held hotkey would re-trigger on every repeat — dozens of
   * activations per second. It also stays out of text fields: a global hotkey
   * that fires while you are typing a note is a bug that eats your input.
   */
  useEffect(() => {
    const isTextTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable
      )
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !event.altKey) return
      if (event.repeat || heldRef.current) return
      if (isTextTarget(event.target)) return
      event.preventDefault()
      heldRef.current = true
      setHeld(true)
      onActivate()
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.key !== 'Alt') return
      if (!heldRef.current) return
      heldRef.current = false
      setHeld(false)
      onRelease?.()
    }

    // A window that loses focus mid-hold never sees the keyup, which would
    // leave the orb stuck "held" forever.
    const onBlur = () => {
      if (!heldRef.current) return
      heldRef.current = false
      setHeld(false)
      onRelease?.()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [onActivate, onRelease])

  const handleClick = useCallback(() => onActivate(), [onActivate])

  const active = held || state === 'speaking' || state === 'listening'

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <button
        type="button"
        onClick={handleClick}
        aria-label={STATE_LABEL[state]}
        title={`${STATE_LABEL[state]} · ${hotkeyLabel}`}
        className={cn(
          'relative grid h-11 w-11 place-items-center rounded-full transition',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          state === 'muted' ? 'opacity-70 hover:opacity-100' : 'hover:scale-105',
        )}
      >
        {/* Halo. Only animates when something is happening, because a
            permanently pulsing element in peripheral vision is an irritant. */}
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 rounded-full transition-opacity',
            STATE_COLOR[state],
            active ? 'animate-ping opacity-40' : state === 'alert' ? 'opacity-25' : 'opacity-0',
          )}
        />
        <span
          aria-hidden
          className={cn(
            'relative h-6 w-6 rounded-full shadow-inner transition-transform',
            STATE_COLOR[state],
            active && 'scale-110',
          )}
        />
      </button>

      <div className="min-w-0 text-xs leading-tight">
        <div className="truncate font-medium">{STATE_LABEL[state]}</div>
        <div className="truncate text-muted-foreground">
          {state === 'muted' ? 'Browsers block audio until you click' : `Hold ${hotkeyLabel}`}
          {lastCue ? ` · last: ${lastCue}` : ''}
        </div>
      </div>
    </div>
  )
}
