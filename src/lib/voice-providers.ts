/**
 * Voice output: three providers behind one interface.
 *
 * `architecture/03` §2 names the stack — the browser's built-in speech
 * synthesis, ElevenLabs Flash for interactive lines, OpenAI TTS for
 * notifications. This module is the selection logic and the spend gate; the
 * actual audio playback lives in the client hook.
 *
 * ## The gate
 *
 * Two of the three providers cost money on every sentence, and recurring
 * third-party spend is T3 under `policies/autonomy.md` — a human approves it,
 * in writing, before it starts. That approval is a queue entry
 * (`queue/2026-09-02-cloud-tts-for-jarvis-voice.md`), not a conversation.
 *
 * So the cloud providers **ship dark**. With no key in the environment,
 * `selectProvider` returns the browser voice, the cockpit still talks, and the
 * bill is zero. Setting `OPS_TTS_OPENAI_KEY` or `OPS_TTS_ELEVENLABS_KEY` is the
 * physical act that turns approved spend on — which means the approval and the
 * capability cannot drift apart, because the key *is* the switch.
 *
 * A gate you can walk around is decoration, so the check is here, in the only
 * place that decides which provider speaks, rather than in a UI toggle.
 *
 * ## The cap
 *
 * The queue entry's own recommendation was to cap daily characters in code, and
 * the reason is specific: the volume estimate behind the ~$13/month figure is a
 * guess (~30 events/day), and the one failure mode that turns a guess into a
 * surprise invoice is an event loop that starts emitting far more than
 * expected. `DAILY_CHAR_CAP` is the ceiling on that. Past it, voice degrades to
 * the free browser provider rather than going silent — losing the nice voice is
 * an acceptable failure, losing the alert is not.
 */

export const VOICE_PROVIDERS = ['browser', 'openai', 'elevenlabs'] as const
export type VoiceProviderId = (typeof VOICE_PROVIDERS)[number]

export interface VoiceProviderInfo {
  id: VoiceProviderId
  label: string
  /** True when this provider bills per character. */
  metered: boolean
  /** USD per 1M characters, from the provider's published pricing. */
  usdPerMillionChars: number
  /** Name of the env var that enables it. Null for the free provider. */
  envVar: string | null
  /** Where the number above came from, so it can be re-checked. */
  pricingSource: string | null
}

/**
 * Published rates. Not estimates — these are the vendors' list prices, and if
 * they change this table is wrong and should be corrected in a PR rather than
 * quietly drifting.
 */
export const PROVIDER_INFO: Record<VoiceProviderId, VoiceProviderInfo> = {
  browser: {
    id: 'browser',
    label: 'Browser voice',
    metered: false,
    usdPerMillionChars: 0,
    envVar: null,
    pricingSource: null,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI TTS',
    metered: true,
    usdPerMillionChars: 15,
    envVar: 'OPS_TTS_OPENAI_KEY',
    pricingSource: 'https://platform.openai.com/docs/pricing',
  },
  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs Flash',
    metered: true,
    // The Creator plan is $11 for 121k characters/month. Expressed per million
    // for comparability; the real billing is a subscription, not usage, so this
    // is the effective rate at plan capacity and understates it below capacity.
    usdPerMillionChars: 91,
    envVar: 'OPS_TTS_ELEVENLABS_KEY',
    pricingSource: 'https://elevenlabs.io/pricing',
  },
}

/**
 * Daily character ceiling across all metered providers.
 *
 * ~4,500/day was the estimate behind the approved figure. This is ~2.7x that —
 * loose enough that a busier-than-usual day does not degrade the voice, tight
 * enough that a runaway loop costs cents rather than the month's envelope.
 */
export const DAILY_CHAR_CAP = 12_000

export interface VoiceEnv {
  OPS_TTS_OPENAI_KEY?: string
  OPS_TTS_ELEVENLABS_KEY?: string
  /** Optional preference between the two cloud providers when both have keys. */
  OPS_TTS_PREFERRED?: string
}

export interface ProviderSelection {
  provider: VoiceProviderId
  /**
   * Why. Surfaced in the settings panel so "why is it using the robot voice"
   * has an answer that does not require reading the source.
   */
  reason: string
  /** True when the selection was forced down by the cap rather than chosen. */
  degraded: boolean
}

/** Which metered providers actually have a key present. */
export function availableMetered(env: VoiceEnv): VoiceProviderId[] {
  const out: VoiceProviderId[] = []
  if (isPresent(env.OPS_TTS_ELEVENLABS_KEY)) out.push('elevenlabs')
  if (isPresent(env.OPS_TTS_OPENAI_KEY)) out.push('openai')
  return out
}

function isPresent(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Pick a provider for one utterance.
 *
 * @param charsUsedToday characters already spoken through metered providers today
 * @param chars length of the line about to be spoken
 */
export function selectProvider(
  env: VoiceEnv,
  charsUsedToday: number,
  chars: number,
): ProviderSelection {
  const metered = availableMetered(env)

  if (metered.length === 0) {
    return {
      provider: 'browser',
      reason:
        'No cloud TTS key is set, so the free browser voice is used. Cloud voice is approved spend that has not been switched on.',
      degraded: false,
    }
  }

  // The cap is checked against the projected total, not the current one, so a
  // single long utterance cannot straddle the ceiling.
  if (charsUsedToday + chars > DAILY_CHAR_CAP) {
    return {
      provider: 'browser',
      reason: `Daily metered character cap (${DAILY_CHAR_CAP.toLocaleString()}) would be exceeded, so this line uses the free browser voice. Nothing is dropped.`,
      degraded: true,
    }
  }

  const preferred = String(env.OPS_TTS_PREFERRED ?? '').trim().toLowerCase()
  if (preferred && (metered as string[]).includes(preferred)) {
    return {
      provider: preferred as VoiceProviderId,
      reason: `OPS_TTS_PREFERRED selects ${PROVIDER_INFO[preferred as VoiceProviderId].label}.`,
      degraded: false,
    }
  }

  // Default order: ElevenLabs when present, since its subscription is paid
  // whether or not it is used, so falling back to metered OpenAI while an
  // ElevenLabs plan sits idle would pay twice for one sentence.
  const chosen = metered[0]
  return {
    provider: chosen,
    reason: `${PROVIDER_INFO[chosen].label} is configured.`,
    degraded: false,
  }
}

/** Cost of a line, in USD, at the provider's published rate. */
export function estimateCost(provider: VoiceProviderId, chars: number): number {
  return (chars / 1_000_000) * PROVIDER_INFO[provider].usdPerMillionChars
}

/**
 * Month-to-date spend from a character count, for the settings panel.
 *
 * The point of showing this is to replace the estimate with a measurement. The
 * approved figure rested on ~135k characters/month that nobody had observed;
 * once this number exists the guess can be corrected rather than repeated.
 */
export function monthToDateEstimate(
  charsByProvider: Partial<Record<VoiceProviderId, number>>,
): { totalChars: number; usd: number; lines: Array<{ provider: VoiceProviderId; chars: number; usd: number }> } {
  const lines = (Object.entries(charsByProvider) as Array<[VoiceProviderId, number]>)
    .filter(([, chars]) => chars > 0)
    .map(([provider, chars]) => ({ provider, chars, usd: estimateCost(provider, chars) }))
  return {
    totalChars: lines.reduce((sum, l) => sum + l.chars, 0),
    usd: lines.reduce((sum, l) => sum + l.usd, 0),
    lines,
  }
}
