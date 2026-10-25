import type { Parameter } from './device'

export const parameterOptions = (field: Parameter): string[] =>
  field.values
    ?.split(/[|,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean) ?? []

export const numericBound = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export function parameterRange(field: Parameter): string | undefined {
  if (!/int|float|number|u\d|i\d/.test(field.type) || parameterOptions(field).length) return
  const min = numericBound(field.min)
  const max = numericBound(field.max)
  if (min !== undefined && max !== undefined) return `${min}–${max}`
  if (min !== undefined) return `≥ ${min}`
  if (max !== undefined) return `≤ ${max}`
}
