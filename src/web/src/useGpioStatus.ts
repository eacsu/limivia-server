import { useEffect, useRef, useState } from 'react'
import { api, gpioObservation, type Args, type DeviceState, type Resource } from './device'

export const gpioModeName = (mode: unknown) =>
  ({ input: '数字输入', output: '数字输出', open_drain: '开漏输出' })[String(mode)] ?? '模式待核实'

export function gpioResourceKey(state: DeviceState, resource?: Resource) {
  return [
    state.generation,
    state.identity?.device_id,
    state.identity?.boot_id,
    state.identity?.build_id,
    resource?.id,
    resource?.instance,
  ].join(':')
}

type Reading = { key: string; level?: number; busy?: boolean; error?: string }

export function useGpioStatus(state: DeviceState, resource: Resource | undefined, online: boolean) {
  const key = gpioResourceKey(state, resource)
  const [reading, setReading] = useState<Reading>({ key: '' })
  const inFlight = useRef<string | null>(null)
  const activeKey = useRef(key)
  useEffect(() => {
    activeKey.current = key
  }, [key])
  const ready = online && state.status === 'ready' && resource?.state === 'ready'
  const current = reading.key === key ? reading : undefined
  const config = resource?.definition.config as Args | undefined
  const mode = config?.mode ?? 'input'
  const fresh = ready && !state.stale
  const level = online && !current?.error ? gpioObservation(state, resource)?.level : undefined
  const usable = fresh && !current?.error && level !== undefined
  const writable =
    usable &&
    !!resource &&
    state.resource_origin[resource.id] === 'managed' &&
    (mode === 'output' || mode === 'open_drain')
  const run = async (toggle: boolean) => {
    if (inFlight.current === key || !fresh || !resource || (toggle && !writable)) return
    inFlight.current = key
    setReading({ ...current, key, busy: true, error: undefined })
    const scope = api.deviceScope()
    try {
      if (toggle)
        await api.run(
          'resource.call',
          {
            resource: resource.id,
            action: 'write',
            args: { level: level === 1 ? 0 : 1 },
          },
          scope,
        )
      if (activeKey.current !== key) return
      const result = await api.run(
        'resource.call',
        {
          resource: resource.id,
          action: 'status',
          args: {},
        },
        scope,
      )
      const readLevel = result.result?.level
      if (readLevel !== 0 && readLevel !== 1) throw new Error('设备未返回有效电平。')
      if (activeKey.current === key) setReading({ key, level: readLevel })
    } catch (error) {
      if (activeKey.current === key)
        setReading({ ...current, key, error: `${String(error)}；结果待核实，请重新读取。` })
    } finally {
      if (inFlight.current === key) inFlight.current = null
    }
  }
  const levelText = level === undefined ? '电平待核实' : `${level === 1 ? '高' : '低'}电平 ${level}`
  const qualifier = !resource
    ? '未应用'
    : !ready || current?.error || level === undefined
      ? '状态待核实'
      : ''
  return {
    mode,
    modeText: gpioModeName(mode),
    levelText,
    qualifier,
    level,
    busy: !!current?.busy,
    error: current?.error,
    canRead: fresh && !current?.busy,
    canWrite: writable && !current?.busy,
    read: () => run(false),
    toggle: () => run(true),
    acceptLevel: (level: unknown) => {
      if ((level === 0 || level === 1) && activeKey.current === key) setReading({ key, level })
    },
    beginOperation: () => {
      if (activeKey.current === key) setReading({ ...current, key, busy: true, error: undefined })
    },
    invalidate: (error: string) => {
      if (activeKey.current === key) setReading({ ...current, key, error })
    },
  }
}
