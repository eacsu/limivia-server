import { type Args, type DeviceState, type Capability } from './device'
import { BOARD_PINS } from './boardPins'
import { numericBound, parameterOptions } from './parameters'
export interface WiringGroup {
  id: string
  name: string
  kind: string
  pins: Record<string, number>
  config: Args
  parent_group: string | null
  controller: number | null
  support_pins: string[]
  notes: string
}
export interface WiringPlan {
  schema_version: 1
  board: string
  revision: number
  title: string
  groups: WiringGroup[]
}
export interface WiringBinding {
  boot_id: string
  resource: number
  instance: number
  definition: Args
  plan_revision: number
}

export function mergeSavedPlan(
  local: WiringPlan,
  baseline: WiringPlan,
  saved: WiringPlan,
): WiringPlan {
  return {
    ...local,
    revision: saved.revision,
    groups: [
      ...saved.groups.flatMap((group) => {
        const previous = baseline.groups.find((g) => g.id === group.id)
        const current = local.groups.find((g) => g.id === group.id)
        if (previous && !current) return []
        return [current && JSON.stringify(current) !== JSON.stringify(previous) ? current : group]
      }),
      ...local.groups.filter((group) => !saved.groups.some((g) => g.id === group.id)),
    ],
  }
}
export type BoardSelection =
  | { type: 'experiment'; gpio: number }
  | { type: 'pin'; id: string }
  | { type: 'group'; id: string }
  | { type: 'resource'; id: number; instance: number }
  | { type: 'internal' }
  | null
export function initialBoardSelection(state: DeviceState): BoardSelection {
  if (
    state.status !== 'ready' ||
    state.identity?.board !== 'luatos-esp32c3-usb' ||
    !state.discovery?.pins.some((p) => p.pin === 13 && p.digital) ||
    !state.discovery.resources.some((c) => c.available && ['gpio', 'pwm'].includes(c.kind))
  )
    return null
  return { type: 'pin', id: BOARD_PINS.find((p) => p.gpio === 13)!.id }
}
export const pinRoles = (cap: Capability) => cap.pin_roles.match(/[a-zA-Z_][\w.]*/g) ?? []
export function groupPins(
  group: WiringGroup,
  groups: WiringGroup[],
  seen = new Set<string>(),
): number[] {
  if (seen.has(group.id)) return []
  seen.add(group.id)
  const parent = groups.find((g) => g.id === group.parent_group)
  return [
    ...new Set([...Object.values(group.pins), ...(parent ? groupPins(parent, groups, seen) : [])]),
  ]
}
export function pinFunctions(state: DeviceState, gpio: number) {
  const physical = BOARD_PINS.find((p) => p.gpio === gpio)
  const pin = state.discovery?.pins.find((p) => p.pin === gpio)
  if (!physical || physical.protected || !pin) return []
  return (
    state.discovery?.resources.filter(
      (c) =>
        c.available && pinRoles(c).length && (c.kind.startsWith('adc') ? pin.adc1 : pin.digital),
    ) ?? []
  )
}
export function newGroup(cap: Capability, gpio?: number, role?: string): WiringGroup {
  const defaults: Args = {
    mode: cap.kind === 'gpio' ? 'input' : 'uart',
    pull: 'none',
    ...(cap.kind === 'gpio' ? { level: 0 } : {}),
    frequency: 1000,
    resolution: 10,
    duty: 50,
    interval_ms: 500,
    high_ms: 500,
    low_ms: 500,
    count: 0,
    baud: 115200,
  }
  const config: Args = {}
  for (const field of cap.config) {
    const value = defaults[field.name]
    if (
      value !== undefined &&
      !(typeof value === 'string' && field.values && !parameterOptions(field).includes(value))
    )
      config[field.name] =
        typeof value === 'number'
          ? Math.min(
              numericBound(field.max) ?? Infinity,
              Math.max(numericBound(field.min) ?? -Infinity, value),
            )
          : value
  }
  return {
    id: newGroupId(),
    name: '',
    kind: cap.kind,
    pins: gpio === undefined || !role ? {} : { [role]: gpio },
    config,
    parent_group: null,
    controller: null,
    support_pins: [],
    notes: '',
  }
}

function newGroupId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // 局域网 HTTP 没有 randomUUID，但仍支持安全随机数；方案 ID 保持 UUID v4 格式。
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
