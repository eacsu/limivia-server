import type { Snapshot } from './device'

export type PinGlyph = 'input-high' | 'high' | 'low' | 'pwm' | 'adc' | 'lock' | 'unknown'

export function pinStateGlyph(pin: Snapshot['pins'][number] | undefined): PinGlyph | null {
  if (!pin || pin.quality === 'unknown') return 'unknown'
  if (pin.mode === 'idle' && pin.quality === 'idle') return null
  if ((pin.quality && pin.quality !== 'ready') || pin.mode === 'fault' || pin.mode === 'idle') return 'unknown'
  if (['input', 'output', 'open_drain'].includes(pin.mode)) {
    if (pin.level !== 0 && pin.level !== 1) return 'unknown'
    return pin.level === 0 ? 'low' : pin.mode === 'input' ? 'input-high' : 'high'
  }
  if (pin.mode === 'pwm') return 'pwm'
  if (['adc', 'adc.continuous'].includes(pin.mode)) return 'adc'
  // A configured bus does not establish a confirmed physical level or waveform.
  return 'unknown'
}

