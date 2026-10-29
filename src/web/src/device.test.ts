import { describe, it, expect } from 'vitest'
import {
  decodeBinary,
  adcSamples,
  boardState,
  initialState,
  terminal,
  type Operation,
} from './device'
describe('v3 business projections', () => {
  it('validates canonical binary and length', () => {
    expect([...decodeBinary({ data: 'AQI=', length: 2 })]).toEqual([1, 2])
    expect(() => decodeBinary({ data: 'AQI=', length: 1 })).toThrow()
    expect(() => decodeBinary({ data: 'AR==', length: 1 })).toThrow()
  })
  it('decodes periodic ADC as little endian records and preserves uncalibrated mV', () => {
    const bytes = new Uint8Array(8)
    const view = new DataView(bytes.buffer)
    view.setInt32(0, 2048, true)
    view.setInt32(4, -1, true)
    const value = adcSamples(
      { events: [{ data: btoa(String.fromCharCode(...bytes)), sequence: 3 }] },
      4,
      9,
    )[0]
    expect(value.raw).toBe(2048)
    expect(value.millivolts).toBeNull()
    expect(value.calibrated).toBe(false)
    expect(value.pin).toBe(4)
  })
  it('does not infer completion from accepted or notifications', () => {
    expect(terminal({ status: 'accepted' } as Operation)).toBe(false)
    expect(terminal({ status: 'unknown' } as Operation)).toBe(true)
  })
  it('board is an empty read-only projection before discovery', () => {
    expect(boardState(initialState).pins.every((p) => p.mode === 'idle')).toBe(true)
    expect(boardState(initialState).sessions[0].active).toBe(false)
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Result } from './Forms'
describe('readable typed results', () => {
  it('shows uncalibrated ADC without inventing zero mV', () => {
    const html = renderToStaticMarkup(
      createElement(Result, { value: { raw: 2048, millivolts: null } }),
    )
    expect(html).toContain('未校准')
    expect(html).toContain('2048')
  })
  it('preserves continuous ADC tags and raw units', () => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, (3 << 13) | (1 << 16) | 2000, true)
    const html = renderToStaticMarkup(
      createElement(Result, {
        format: 'adc.continuous',
        value: { length: 4, data: btoa(String.fromCharCode(...bytes)) },
      }),
    )
    expect(html).toContain('ADC type2')
    expect(html).toContain('2000')
    expect(html).toContain('无校准电压单位')
  })
  it('explains queued delivery without claiming remote success', () => {
    const html = renderToStaticMarkup(
      createElement(Result, { value: { delivery: 'queued', message_id: 7 } }),
    )
    expect(html).toContain('本地已入队（非应用确认）')
  })
})

describe('shared pin observations', () => {
  it('decodes SDK a2 typed samples, preserving null calibration and timestamps', () => {
    const [sample] = adcSamples(
      { events: [{ raw: 1200, millivolts: null, sequence: 8, time_us: 42000 }] },
      1,
      2,
    )
    expect(sample).toMatchObject({
      raw: 1200,
      millivolts: null,
      calibrated: false,
      sequence: 8,
      uptime_ms: 42,
    })
  })
})

import { pinStateLabel, type DeviceState, type Resource } from './device'
describe('board state identity and mode semantics', () => {
  const resources: Resource[] = [
    {
      id: 1,
      instance: 7,
      kind: 'gpio',
      state: 'ready',
      parent: 0,
      pin_mask: 2 ** 10,
      definition: { pins: { pin: 10 }, config: { mode: 'output', level: 1 } },
      driver_error: 0,
      cleanup_error: 0,
    },
    {
      id: 2,
      instance: 8,
      kind: 'pwm',
      state: 'ready',
      parent: 0,
      pin_mask: 2 ** 3,
      definition: { pins: { pin: 3 }, config: { duty: 50 } },
      driver_error: 0,
      cleanup_error: 0,
    },
    {
      id: 3,
      instance: 9,
      kind: 'uart',
      state: 'ready',
      parent: 0,
      pin_mask: 2 ** 20 + 2 ** 21,
      definition: { pins: { rx: 20, tx: 21 }, config: {} },
      driver_error: 0,
      cleanup_error: 0,
    },
  ]
  const state: DeviceState = {
    ...initialState,
    status: 'ready',
    stale: false,
    generation: 4,
    identity: {
      board: 'luatos-esp32c3-usb',
      device_id: 'device',
      boot_id: 'boot',
      build_id: 'build',
      profile: 'bus',
      firmware: 'test',
      protocol: 3,
      contract: 'limivia-v3-jsonrpc2',
      jsonrpc: '2.0',
      batch_max: 8,
    },
    snapshot: { revision: 1, epoch: 1, resources, pages: [] },
    resource_values: { '1': { level: 1 } },
  }
  it('never derives a level from initial config or an unscoped cached result', () => {
    expect(boardState(state).pins.find((p) => p.pin === 10)?.level).toBeNull()
  })
  it('projects all configured pins and UART roles, while PWM has no digital level', () => {
    const pins = boardState(state).pins
    expect(pins.find((p) => p.pin === 3)).toMatchObject({ mode: 'pwm', level: null })
    expect(pins.find((p) => p.pin === 20)).toMatchObject({ mode: 'uart', role: 'rx' })
    expect(pins.find((p) => p.pin === 21)).toMatchObject({ mode: 'uart', role: 'tx' })
    expect(pinStateLabel(pins.find((p) => p.pin === 3)).short).toBe('PWM')
    expect(pinStateLabel(pins.find((p) => p.pin === 10)).short).toBe('输出?')
  })
  it('accepts only current generation, boot and resource instance observations', () => {
    const reading = {
      instance: 7,
      generation: 4,
      device_id: 'device',
      boot_id: 'boot',
      observed_at: 1,
      quality: 'confirmed' as const,
      level: 0 as const,
    }
    const current = { ...state, resource_observations: { '1': reading } }
    expect(boardState(current).pins.find((p) => p.pin === 10)?.level).toBe(0)
    for (const patch of [
      { instance: 8 },
      { generation: 3 },
      { boot_id: 'old' },
      { quality: 'unknown' as const },
    ])
      expect(
        boardState({
          ...current,
          resource_observations: { '1': { ...reading, ...patch } },
        }).pins.find((p) => p.pin === 10)?.level,
      ).toBeNull()
    expect(
      boardState({ ...current, status: 'disconnected' }).pins.find((p) => p.pin === 10)?.level,
    ).toBeNull()
  })
})
