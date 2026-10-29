import { useMemo, useState } from 'react'
import {
  api,
  kindNames,
  actionNames,
  adcSamples,
  saveBlob,
  type Args,
  type Capability,
  type DeviceState,
  type Resource,
} from './device'
import { Action, Fields, Result } from './Forms'
import { Chart } from './WorkbenchUI'
export function ResourceActions({
  resource,
  capability,
  enabled,
  state,
}: {
  resource: Resource
  capability?: Capability
  enabled: boolean
  state: DeviceState
}) {
  const [action, setAction] = useState('status')
  const [args, setArgs] = useState<Args>({})
  const [result, setResult] = useState<unknown>(null)
  const fields = capability?.actions.find((a) => a.action === action)?.args ?? []
  const actions = capability?.actions ?? []
  const pin = Number((resource.definition.pins as Args)?.pin ?? 0)
  const samples = useMemo(() => {
    if (resource.kind !== 'adc') return []
    try {
      return adcSamples({ events: state.samples?.[resource.id] ?? [] }, pin, resource.instance)
    } catch {
      return []
    }
  }, [state.samples, resource.id, resource.instance, resource.kind, pin])
  const collect = state.sampling?.includes(String(resource.id))
  const content = (
    <>
      <div className="toolbar">
        <h2>
          #{resource.id} · {kindNames[resource.kind] ?? resource.kind}
        </h2>
        <span>{resource.state}</span>
      </div>
      <p>
        {resource.state === 'fault'
          ? '故障资源仍占用引脚；恢复动作会重试关闭。'
          : '配置是设备已确认的定义。'}
      </p>
      <Result value={resource.definition} />
      <div className="fields">
        <label className="field">
          资源操作
          <select
            value={action}
            onChange={(e) => {
              setAction(e.target.value)
              setArgs({})
            }}
          >
            <option value="status">status · 读取状态</option>
            {actions
              .filter(
                (a) => a.action !== 'status' && !(resource.kind === 'gpio' && a.action === 'write'),
              )
              .map((a) => (
                <option key={a.action} value={a.action}>
                  {actionNames[a.action] ?? a.action} · {a.action}
                </option>
              ))}
          </select>
        </label>
      </div>
      <Fields fields={fields} value={args} onChange={setArgs} />
      <div className="row">
        <Action
          disabled={!enabled}
          primary
          run={async () => {
            const task = await api.run('resource.call', { resource: resource.id, action, args })
            setResult(task.result)
          }}
        >
          执行操作
        </Action>
        <Action
          run={async () =>
            setResult((await api.run('resource.get', { resource: resource.id })).result)
          }
        >
          查询资源
        </Action>
        {resource.kind === 'adc' && (
          <button
            disabled={!enabled}
            onClick={() => {
              void api.request(
                `/api/device/resources/${resource.id}/sampling?enabled=${!collect}`,
                'POST',
              )
            }}
          >
            {collect ? '停止读取队列' : '连续读取采样'}
          </button>
        )}
        <Action
          disabled={!enabled}
          run={async () => {
            setResult(
              (
                await api.run(resource.state === 'fault' ? 'resource.recover' : 'resource.close', {
                  resource: resource.id,
                })
              ).result,
            )
          }}
        >
          {resource.state === 'fault' ? '重试关闭' : '关闭资源'}
        </Action>
        <Action
          disabled={!enabled}
          run={async () => {
            setResult(
                (await api.run('resource.close', { resource: resource.id, cascade: true })).result,
              )
          }}
        >
          级联关闭…
        </Action>
      </div>
      {resource.kind === 'adc' && (
        <>
          <Chart samples={samples} stale={state.stale || state.status !== 'ready'} />
          <button
            disabled={!samples.length}
            onClick={() =>
              saveBlob(
                new Blob([
                  'sequence,raw,millivolts\n' +
                    samples.map((s) => `${s.sequence},${s.raw},${s.millivolts ?? ''}`).join('\n'),
                ]),
                'adc.csv',
              )
            }
          >
            导出采样 CSV
          </button>
        </>
      )}
      <Result value={result} format={resource.kind} />
      <p className="muted">
        周期 ADC 的 raw/mV 与连续 ADC type2 格式不同；I²S PDM 不自动解释为 PCM，TWAI 为经典 CAN。
      </p>
    </>
  )
  return resource.kind === 'gpio' ? (
    <details className="resource-advanced">
      <summary>资源详情与高级操作</summary>
      {content}
    </details>
  ) : (
    content
  )
}
