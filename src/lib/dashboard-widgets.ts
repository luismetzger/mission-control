export interface DashboardWidget {
  id: string
  label: string
  description: string
  category: 'health' | 'sessions' | 'tasks' | 'metrics' | 'integrations' | 'events'
  modes: ('local' | 'full')[]
  defaultSize: 'sm' | 'md' | 'lg' | 'full'
  component: string
}

export const WIDGET_CATALOG: DashboardWidget[] = [
  {
    // The reusable table panel, first table being AR aging (build-plan
    // 2.2h). Medium-width so it sits alongside the burn chart in the
    // grid — they are the two "expansion" panels beneath the telemetry
    // strip: chart for spend trajectory, table for AR bucket detail.
    id: 'ar-aging-table',
    label: 'AR Aging Table',
    description: 'Accounts receivable by aging bucket — latest weekly snapshot from the Bookkeeper brief',
    category: 'metrics',
    modes: ['local', 'full'],
    defaultSize: 'md',
    component: 'ArAgingTableWidget',
  },
  {
    // The reusable time-series chart, first series being AI burn vs the
    // monthly envelope (build-plan 2.2e). Registered as a medium-width
    // widget so it can sit next to a companion in the grid; `md` is 4 of
    // 12 columns on xl viewports.
    id: 'ai-burn-chart',
    label: 'AI Burn Chart',
    description: 'Cumulative AI spend against the monthly envelope, with a 7d / 30d / MTD window toggle',
    category: 'metrics',
    modes: ['local', 'full'],
    defaultSize: 'md',
    component: 'AiBurnChartWidget',
  },
  {
    // The three KPI cards (spend, AR, T3 queue) rendered as one row. Owns
    // its own data (each card fetches from /api/ops/kpi/:kind), so it is
    // registered `full`-width and available in both dashboard modes.
    id: 'cockpit-telemetry-strip',
    label: 'Cockpit Telemetry',
    description: 'AI spend MTD, AR outstanding, and T3 queue depth — each with a 30-day trend',
    category: 'metrics',
    modes: ['local', 'full'],
    defaultSize: 'full',
    component: 'CockpitTelemetryStripWidget',
  },
  {
    id: 'briefing-bar',
    label: 'Briefing Bar',
    description: 'At-a-glance operational summary — what needs attention now',
    category: 'metrics',
    modes: ['local', 'full'],
    defaultSize: 'full',
    component: 'BriefingBarWidget',
  },
  {
    id: 'activity-timeline',
    label: 'Activity Timeline',
    description: 'Real-time mission log — agent events, task updates, errors',
    category: 'events',
    modes: ['local', 'full'],
    defaultSize: 'md',
    component: 'ActivityTimelineWidget',
  },
  {
    id: 'fleet-status',
    label: 'Fleet Status',
    description: 'Per-runtime activity sparklines, session counts, and cost',
    category: 'sessions',
    modes: ['local', 'full'],
    defaultSize: 'md',
    component: 'FleetStatusWidget',
  },
  {
    id: 'task-pipeline',
    label: 'Task Pipeline',
    description: 'Visual task flow — inbox to done with bottleneck highlighting',
    category: 'tasks',
    modes: ['local', 'full'],
    defaultSize: 'full',
    component: 'TaskPipelineWidget',
  },
  {
    id: 'system-health',
    label: 'System Health',
    description: 'Compact health bar — CPU, memory, disk, uptime (expandable)',
    category: 'health',
    modes: ['local', 'full'],
    defaultSize: 'full',
    component: 'SystemHealthWidget',
  },
  {
    id: 'metric-cards',
    label: 'Key Metrics (Classic)',
    description: 'Top-line stats — sessions, load, tokens, cost',
    category: 'metrics',
    modes: ['local', 'full'],
    defaultSize: 'full',
    component: 'MetricCardsWidget',
  },
  {
    id: 'runtime-health',
    label: 'Runtime Health',
    description: 'Local OS, Claude, Codex, and MC core health',
    category: 'health',
    modes: ['local'],
    defaultSize: 'md',
    component: 'RuntimeHealthWidget',
  },
  {
    id: 'gateway-health',
    label: 'Gateway Health',
    description: 'Gateway golden signals — traffic, errors, saturation',
    category: 'health',
    modes: ['full'],
    defaultSize: 'md',
    component: 'GatewayHealthWidget',
  },
  {
    id: 'session-workbench',
    label: 'Session Workbench',
    description: 'Live session list with activity indicators',
    category: 'sessions',
    modes: ['local', 'full'],
    defaultSize: 'md',
    component: 'SessionWorkbenchWidget',
  },
  {
    id: 'event-stream',
    label: 'Event Stream',
    description: 'Merged log stream from all sources',
    category: 'events',
    modes: ['local', 'full'],
    defaultSize: 'md',
    component: 'EventStreamWidget',
  },
  {
    id: 'task-flow',
    label: 'Task Flow',
    description: 'Task status counts — inbox, assigned, in progress, review, done',
    category: 'tasks',
    modes: ['local', 'full'],
    defaultSize: 'sm',
    component: 'TaskFlowWidget',
  },
  {
    id: 'github-signal',
    label: 'GitHub Signal',
    description: 'GitHub repo stats — issues, stars, repos',
    category: 'integrations',
    modes: ['local'],
    defaultSize: 'sm',
    component: 'GithubSignalWidget',
  },
  {
    id: 'security-audit',
    label: 'Security & Audit',
    description: 'Audit events, login failures, notifications',
    category: 'events',
    modes: ['full'],
    defaultSize: 'sm',
    component: 'SecurityAuditWidget',
  },
  {
    id: 'maintenance',
    label: 'Maintenance & Backup',
    description: 'Backup status, pipeline health',
    category: 'health',
    modes: ['full'],
    defaultSize: 'sm',
    component: 'MaintenanceWidget',
  },
  {
    id: 'quick-actions',
    label: 'Quick Actions',
    description: 'Navigation shortcuts to key panels',
    category: 'sessions',
    modes: ['local', 'full'],
    defaultSize: 'full',
    component: 'QuickActionsWidget',
  },
]

// The telemetry strip sits directly under the briefing bar in both modes:
// the briefing tells you what needs attention right now, and the strip tells
// you which of the three slow-moving business KPIs is drifting. Same position
// on both layouts on purpose — there is no reason spend/AR/queue should live
// somewhere different on a gateway vs a local install.
export const LOCAL_DEFAULT_LAYOUT = [
  'briefing-bar',
  'cockpit-telemetry-strip',
  // AI burn chart sits directly under the strip: the strip's spend card is
  // a single-number MTD reading, and the chart is where you look when that
  // number is climbing and you want to know whether the shape is a spike
  // or a slope. Read together they answer both "where am I now" and
  // "where am I headed."
  'ai-burn-chart',
  // AR aging table sits next to the burn chart — both are the "expansion"
  // panels for the telemetry strip's single-number cards. Chart expands
  // spend into a trajectory; table expands AR into bucket detail (how much
  // is current, how much is overdue by how much). The strip answers "how
  // bad"; these two answer "how, and where."
  'ar-aging-table',
  'activity-timeline',
  'fleet-status',
  'task-pipeline',
  'system-health',
  'quick-actions',
]

export const GATEWAY_DEFAULT_LAYOUT = [
  'briefing-bar',
  'cockpit-telemetry-strip',
  'ai-burn-chart',
  'ar-aging-table',
  'activity-timeline',
  'fleet-status',
  'task-pipeline',
  'system-health',
  'quick-actions',
]

export function getDefaultLayout(mode: 'local' | 'full'): string[] {
  return mode === 'local' ? LOCAL_DEFAULT_LAYOUT : GATEWAY_DEFAULT_LAYOUT
}

export function getWidgetById(id: string): DashboardWidget | undefined {
  return WIDGET_CATALOG.find((w) => w.id === id)
}

export function getAvailableWidgets(mode: 'local' | 'full'): DashboardWidget[] {
  return WIDGET_CATALOG.filter((w) => w.modes.includes(mode))
}
