import { describe, expect, it } from 'vitest'
import { pinStateGlyph } from './pinState'
import type { Snapshot } from './device'
const pin = (mode: string, level: number | null, quality = 'ready'): Snapshot['pins'][number] => ({ pin: 10, mode, level, quality })
describe('设备确认值到板图符号', () => {
  it('空闲留白，未知及故障不能冒充低电平', () => {
    expect(pinStateGlyph(pin('idle', null, 'idle'))).toBeNull()
    expect(pinStateGlyph(undefined)).toBe('unknown')
    expect(pinStateGlyph(pin('output', 1, 'unknown'))).toBe('unknown')
    expect(pinStateGlyph(pin('output', null))).toBe('unknown')
    expect(pinStateGlyph(pin('fault', 0, 'fault'))).toBe('unknown')
  })
  it('输入、输出与开漏只按读回值区分实心和空心', () => {
    expect(pinStateGlyph(pin('input', 1))).toBe('input-high')
    expect(pinStateGlyph(pin('input', 0))).toBe('low')
    expect(pinStateGlyph(pin('output', 1))).toBe('high')
    expect(pinStateGlyph(pin('output', 0))).toBe('low')
    expect(pinStateGlyph(pin('open_drain', 1))).toBe('high')
    expect(pinStateGlyph(pin('open_drain', 0))).toBe('low')
  })
  it('波形仅说明 PWM/采集模式，不推断高低电平', () => {
    expect(pinStateGlyph(pin('pwm', null))).toBe('pwm')
    expect(pinStateGlyph(pin('adc', null))).toBe('adc')
    expect(pinStateGlyph(pin('adc.continuous', null))).toBe('adc')
    expect(pinStateGlyph(pin('uart', null))).toBe('unknown')
  })
})
