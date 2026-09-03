'use client'

/**
 * Voice console — the ops event stream, made audible (registry kind `voice-console`).
 *
 * This panel is where the Tier-1 audio design becomes inspectable. It shows the
 * live transition stream, the orb, the mode controls, the cue previews, and the
 * metered character count against its cap.
 *
 * The cue previews are not a toy. An audio design whose only manifestation is
 * whether it happens to fire correctly at 2am cannot be reviewed, and a cue that
 * turns out to be indistinguishable from another one is a bug you discover
 * during the incident it was meant to warn you about. Being able to press five
 * buttons and hear them side by side is the review.
 *
 * Read-only: nothing here changes ops state. It listens and it makes noise.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ZoneBadge } from '@/components/ops/zone-badge'
import { VoiceOrb, type OrbState } from '@/components/ops/voice-orb'
import { useOpsVoice } from '@/lib/use-ops-voice'
import { CUE_KINDS, type CueKind, type OpsEvent } from '@/lib/ops-events'
import { CUE_SPECS } from '@/lib/ops-cues'
import { DAILY_CHAR_CAP } from '@/lib/voice-providers'
import { composeDigest } from '@/lib/ops-digest'
import { apiFetch } from '@/lib/api-client'
import { cn } from '@/lib/utils'

/** Most recent transitions kept on screen. */
const FEED_LIMIT = 40

interface FeedItem extends OpsEvent {
  /** Replayed events happened before this session connected. */
  replayed: boolean
}

export function VoiceConsolePanel() {
  const voice = useOpsVoice()
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [connection, setConnection] = useState<'connecting' | 'live' | 'error' | 'unconfigured'>(
    'connecting',
  )
  const [seeded, setSeeded] = useState<boolean | null>(null)
  const [lastCue, setLastCue] = useState<CueKind | null>(null)
  const [speaking, setSpeaking] = useState(false)

  // The stream effect must not re-run when the announce callback changes
  // identity, or every preference change would tear down and rebuild the
  // EventSource — losing the replay buffer and reconnecting for no reason. The
  // ref is the standard escape hatch; it is written in an effect rather than
  // during render.
  const announceRef = useRef(voice.announce)
  useEffect(() => {
    announceRef.current = voice.announce
  }, [voice.announce])

  useEffect(() => {
    // Probe first. An EventSource against a 503 retries forever and silently,
    // so the "not configured" case has to be detected with a normal fetch or the
    // panel sits on "connecting" while the browser hammers the endpoint.
    let source: EventSource | null = null
    let cancelled = false

    const connect = async () => {
      try {
        const status = await apiFetch<{ configured: boolean; seeded: boolean }>(
          '/api/ops/events/status',
        )
        if (!status.configured) {
          setConnection('unconfigured')
          return
        }
        setSeeded(status.seeded)
      } catch {
        if (!cancelled) setConnection('error')
        return
      }
      if (cancelled) return

      source = new EventSource('/api/ops/events')

      source.addEventListener('ops.hello', (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { seeded: boolean }
          setSeeded(payload.seeded)
        } catch {
          setSeeded(null)
        }
        setConnection('live')
      })

      source.addEventListener('ops.replay', (event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as OpsEvent
          // Replayed events are shown but never sounded. A cue is a
          // notification of a change; playing one for something that happened
          // before you opened the page is a false alarm.
          setFeed((current) => [{ ...parsed, replayed: true }, ...current].slice(0, FEED_LIMIT))
        } catch {
          // Ignore a malformed frame rather than tearing down the stream.
        }
      })

      source.addEventListener('ops.event', (event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as OpsEvent
          setFeed((current) => [{ ...parsed, replayed: false }, ...current].slice(0, FEED_LIMIT))
          setLastCue(parsed.cue)
          announceRef.current(parsed)
        } catch {
          // As above.
        }
      })

      source.onerror = () => {
        // EventSource reconnects on its own; say so rather than implying loss.
        setConnection((current) => (current === 'live' ? 'connecting' : current))
      }
    }

    void connect()
    return () => {
      cancelled = true
      source?.close()
    }
  }, [])

  const orbState: OrbState = useMemo(() => {
    if (voice.prefs.mode === 'off' || !voice.armed) return 'muted'
    if (speaking) return 'speaking'
    if (feed.some((f) => !f.replayed && f.severity === 'alert')) return 'alert'
    return 'idle'
  }, [voice.prefs.mode, voice.armed, speaking, feed])

  /**
   * Orb activation: arm audio if needed, then speak the digest.
   *
   * Speech input is 2.3, so this speaks rather than listens. The digest is built
   * from what the panel already has — the point is the interaction and the
   * plumbing, and the composer is fully tested against richer input.
   */
  const handleActivate = useCallback(async () => {
    if (!voice.armed) {
      const ok = await voice.arm()
      if (!ok) return
      if (voice.prefs.mode === 'off') voice.setPrefs({ mode: 'full' })
      voice.playCue('info')
      return
    }

    const approvals = feed
      .filter((f) => f.type.startsWith('ops.approval.') && f.type !== 'ops.approval.decided')
      .map((f) => ({ title: f.line, daysLeft: f.type === 'ops.approval.expired' ? -1 : 7 }))
    const failingRuns = feed
      .filter((f) => f.type === 'ops.ci.failed')
      .map((f) => ({ repo: 'ops', workflow: f.line }))

    const digest = composeDigest({
      failingRuns,
      approvals,
      meetings: [],
      clientDeltas: [],
      budgetFraction: null,
    })

    setSpeaking(true)
    voice.speak(digest.text)
    window.setTimeout(() => setSpeaking(false), Math.min(30_000, digest.chars * 60))
  }, [voice, feed])

  const capPct = Math.min(100, Math.round((voice.charsUsedToday / DAILY_CHAR_CAP) * 100))

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Voice console</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Ops state transitions, as sound. Cues fire on the four transitions that matter —
            approval requested, blocker, task complete, budget threshold — and nothing else, so
            silence means nothing changed.
          </p>
        </div>
        <VoiceOrb state={orbState} lastCue={lastCue} onActivate={handleActivate} />
      </header>

      {/* Stream status. "Live but not seeded" is a real state and is stated
          plainly: before the watcher has a baseline, an empty feed means "not
          watching yet", not "all quiet". */}
      <div className="rounded-md border p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-block h-2 w-2 rounded-full',
              connection === 'live'
                ? 'bg-emerald-500'
                : connection === 'connecting'
                  ? 'bg-amber-500'
                  : 'bg-rose-500',
            )}
          />
          <span className="font-medium">
            {connection === 'live'
              ? 'Watching'
              : connection === 'connecting'
                ? 'Connecting'
                : connection === 'unconfigured'
                  ? 'Ops sources not configured'
                  : 'Stream unavailable'}
          </span>
          {connection === 'live' && seeded === false && (
            <span className="text-muted-foreground">
              — baseline not taken yet, so nothing can be reported as changed
            </span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="text-sm font-medium">Mode</div>
          <div className="flex gap-2">
            {(['off', 'cues', 'full'] as const).map((mode) => (
              <Button
                key={mode}
                size="sm"
                variant={voice.prefs.mode === mode ? 'default' : 'outline'}
                onClick={async () => {
                  if (mode !== 'off' && !voice.armed) await voice.arm()
                  voice.setPrefs({ mode })
                }}
              >
                {mode === 'off' ? 'Silent' : mode === 'cues' ? 'Cues only' : 'Cues + speech'}
              </Button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={voice.prefs.alertsOnly}
              onChange={(e) => voice.setPrefs({ alertsOnly: e.target.checked })}
            />
            Important only — blockers, new approvals, 80%+ spend
          </label>
          {!voice.armed && (
            <p className="text-xs text-muted-foreground">
              Browsers block audio until you interact with the page, so nothing plays until you
              click the orb. Until then the cockpit is muted, and it says so rather than
              pretending to be armed.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Voice</div>
          <p className="text-sm">{voice.provider.reason}</p>
          <div className="text-xs text-muted-foreground">
            {voice.charsUsedToday.toLocaleString()} / {DAILY_CHAR_CAP.toLocaleString()} characters
            today ({capPct}%). The cap exists because the approved ~$13/month rests on an estimated
            volume, not a measured one — past it, speech falls back to the free browser voice and
            cues keep playing.
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full', capPct >= 100 ? 'bg-rose-500' : 'bg-sky-500')}
              style={{ width: `${capPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Cue previews */}
      <div className="rounded-md border p-3">
        <div className="mb-2 text-sm font-medium">Cues</div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {CUE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={async () => {
                if (!voice.armed) await voice.arm()
                voice.playCue(kind)
                setLastCue(kind)
              }}
              className="rounded border p-2 text-left text-xs hover:bg-accent"
            >
              <div className="font-medium capitalize">{kind}</div>
              <div className="text-muted-foreground">{CUE_SPECS[kind].description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Feed */}
      <div className="rounded-md border">
        <div className="border-b p-3 text-sm font-medium">Transitions</div>
        {feed.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            {connection === 'live' && seeded
              ? 'Nothing has changed since the baseline. This is the expected state.'
              : 'No transitions yet.'}
          </p>
        ) : (
          <ul className="divide-y">
            {feed.map((item) => (
              <li key={`${item.id}-${item.timestamp}`} className="flex items-start gap-3 p-3">
                <span className="mt-0.5 shrink-0 text-xs font-medium capitalize text-muted-foreground">
                  {item.cue}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{item.line}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <ZoneBadge zone={item.zone} />
                    <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                    {item.replayed && <span>· before you connected, not sounded</span>}
                    {item.href && (
                      <a className="underline" href={item.href}>
                        open
                      </a>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
