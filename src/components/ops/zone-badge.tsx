'use client'

/**
 * ZoneBadge — the one way a cockpit component says which zone it is showing.
 *
 * Every registered component renders this on every instance/row. The zone is
 * always derived from the data source (which repo the row came from) on the
 * server; this component only renders what it is given, and renders `unknown`
 * loudly rather than guessing.
 */

import { zoneClientSlug, zoneLabel, type Zone } from '@/lib/ops-registry'

const styles: Record<'z0' | 'z1' | 'p' | 'unknown', string> = {
  z0: 'bg-primary/10 text-primary border-primary/30',
  z1: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  p: 'bg-green-500/10 text-green-400 border-green-500/30',
  unknown: 'bg-red-500/10 text-red-400 border-red-500/40',
}

function styleKey(zone: Zone): keyof typeof styles {
  if (zone === 'z0') return 'z0'
  if (zone === 'p') return 'p'
  if (zoneClientSlug(zone)) return 'z1'
  return 'unknown'
}

export function ZoneBadge({ zone, className = '' }: { zone: Zone; className?: string }) {
  const key = styleKey(zone)
  return (
    <span
      title={key === 'unknown' ? 'This row came from a repo that is not in the configured ops repo set' : zoneLabel(zone)}
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${styles[key]} ${className}`}
    >
      {zone === 'unknown' ? 'zone?' : zone}
    </span>
  )
}
