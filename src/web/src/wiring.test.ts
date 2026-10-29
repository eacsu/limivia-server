import { describe, it, expect, vi } from 'vitest'
import { initialState, type Capability } from './device'
import { groupPins, newGroup, pinFunctions, mergeSavedPlan, type WiringPlan } from './wiring'
const gpio: Capability = {
  kind: 'gpio',
  available: true,
  capacity: 10,
  pin_roles: 'pin',
  required_pins: 'pin',
  config: [],
  actions: [],
}
describe('板卡与接线投影', () => {
  it('实验记录保存期间的其他编辑保留，服务器新增关联组不会丢失或重复', () => {
    const group = { ...newGroup(gpio, 4, 'pin'), name: '原有记录' }
    const added = { ...newGroup(gpio, 10, 'pin'), name: '外置 LED' }
    const baseline: WiringPlan = {
      schema_version: 1,
      board: 'test',
      revision: 1,
      title: '原方案',
      groups: [group],
    }
    const local = {
      ...baseline,
      title: '继续编辑的标题',
      groups: [{ ...group, notes: '保存期间补充' }],
    }
    const saved = { ...baseline, revision: 2, groups: [group, added] }
    const merged = mergeSavedPlan(local, baseline, saved)
    expect(merged.title).toBe('继续编辑的标题')
    expect(merged.groups.map((g) => g.id)).toEqual([group.id, added.id])
    expect(merged.groups[0].notes).toBe('保存期间补充')
    expect(mergeSavedPlan(merged, baseline, saved).groups).toHaveLength(2)
    expect(mergeSavedPlan({ ...local, groups: [] }, baseline, saved).groups).toEqual([added])
  })
  it('GPIO 新草稿使用输入、无上下拉和低电平预设，不显式覆盖驱动与反相', () => {
    const fields = [
      { name: 'mode', type: 'enum', values: 'input output open_drain' },
      { name: 'pull', type: 'enum', values: 'none up down' },
      { name: 'level', type: 'integer', min: 0, max: 1 },
      { name: 'drive', type: 'integer', min: 0, max: 3 },
      { name: 'invert', type: 'boolean' },
    ]
    expect(newGroup({ ...gpio, config: fields }, 10, 'pin').config).toEqual({
      mode: 'input',
      pull: 'none',
      level: 0,
    })
  })
  it('PWM 推荐值按能力范围限制，空边界不会变成零', () => {
    const group = newGroup({
      ...gpio,
      kind: 'pwm',
      config: [
        { name: 'frequency', type: 'integer', min: 10, max: 500 },
        { name: 'duty', type: 'number', min: 0, max: 100 },
        { name: 'resolution', type: 'integer', min: null, max: 14 },
      ],
    })
    expect(group.config).toEqual({ frequency: 500, duty: 50, resolution: 10 })
  })
  it('局域网 HTTP 缺少 randomUUID 时仍生成有效且不同的 UUID v4', () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto)
    vi.stubGlobal('crypto', { getRandomValues })
    try {
      const first = newGroup(gpio, 10, 'pin')
      const second = newGroup(gpio, 10, 'pin')
      expect(first.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      expect(second.id).not.toBe(first.id)
      expect(first.pins).toEqual({ pin: 10 })
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('从实际引脚与固件能力筛选功能，保护脚不提供配置', () => {
    const state = {
      ...initialState,
      discovery: {
        identity: null!,
        pins: [
          { pin: 4, digital: true, adc1: true, deep_sleep_wake: false },
          { pin: 12, digital: true, adc1: false, deep_sleep_wake: false },
        ],
        resources: [gpio, { ...gpio, kind: 'pwm', available: false }, { ...gpio, kind: 'adc' }],
        operations: [],
        raw_pages: [],
      },
    }
    expect(pinFunctions(state, 4).map((c) => c.kind)).toEqual(['gpio', 'adc'])
    expect(pinFunctions(state, 12)).toEqual([])
    expect(pinFunctions(initialState, 4)).toEqual([])
  })
  it('子设备继承总线引脚，但不会重复创建父总线', () => {
    const parent = { ...newGroup(gpio, 4, 'sda'), id: 'bus', pins: { sda: 4, scl: 5 } }
    const child = { ...newGroup(gpio), id: 'sensor', parent_group: 'bus' }
    expect(groupPins(child, [parent, child])).toEqual([4, 5])
    expect(child.pins).toEqual({})
    expect(
      groupPins({ ...parent, parent_group: 'sensor' }, [
        { ...parent, parent_group: 'sensor' },
        child,
      ]),
    ).toEqual([4, 5])
  })
  it('选中的起始引脚仅绑定所选角色，草稿没有运行句柄', () => {
    const group = newGroup({ ...gpio, kind: 'uart', pin_roles: 'tx rx' }, 4, 'rx')
    expect(group.pins).toEqual({ rx: 4 })
    expect(group).not.toHaveProperty('resource')
  })
})
