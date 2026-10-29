import { describe, expect, it } from 'vitest'
import { BOARD_PINS, displaySide } from './boardPins'
describe('实物排针', () => {
  it('完整保留两侧各16个物理位置与重复电源脚', () => {
    expect(BOARD_PINS).toHaveLength(32)
    expect(new Set(BOARD_PINS.map((p) => p.id)).size).toBe(32)
    expect(BOARD_PINS.filter((p) => p.side === 'left').map((p) => p.label)).toEqual([
      'GND',
      'IO00',
      'IO01',
      'IO12',
      'IO18',
      'IO19',
      'GND',
      'RX0',
      'TX0',
      'IO13',
      'NC',
      'EN',
      '3.3V',
      'GND',
      'PWB',
      '5V',
    ])
    expect(BOARD_PINS.filter((p) => p.side === 'right').map((p) => p.label)).toEqual([
      'GND',
      '3.3V',
      'IO02',
      'IO03',
      'IO10',
      'IO06',
      'IO07',
      'IO11',
      'GND',
      '3.3V',
      'IO05',
      'IO04',
      'IO08',
      'IO09',
      '5V',
      'GND',
    ])
    expect(
      BOARD_PINS.filter((p) => p.category === 'analog')
        .map((p) => p.gpio)
        .sort(),
    ).toEqual([0, 1, 2, 3, 4, 5])
    expect(BOARD_PINS.find((p) => p.label === 'RX0')?.gpio).toBe(20)
    expect(BOARD_PINS.find((p) => p.label === 'TX0')?.gpio).toBe(21)
  })
  it('背面仅交换左右，不改变物理位置身份', () => {
    for (const pin of BOARD_PINS) {
      expect(displaySide(pin, 'front')).toBe(pin.side)
      expect(displaySide(pin, 'back')).not.toBe(pin.side)
    }
    expect(BOARD_PINS.find((p) => p.gpio === 2)?.protected).toBe(true)
    expect(BOARD_PINS.find((p) => p.gpio === 5)?.description).toContain('ADC2 当前未开放')
  })
})
