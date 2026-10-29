import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  api,
  type Args,
  type Capability,
  type DeviceState,
  type Operation,
  type Resource,
} from './device'
import { SimpleConfig } from './SimpleConfig'
import { Action } from './Forms'
import { ResourceActions } from './ResourceActions'
import { newGroup, type WiringGroup } from './wiring'
import type { WiringWorkspace } from './useWiring'
import type { useGpioStatus } from './useGpioStatus'

export function DirectGpio({
  gpio,
  capability,
  state,
  online,
  resource,
  model,
  wiring,
  initial,
  onDraft,
  onSaved,
  onChangePin,
  onStopped,
  actionHost,
}: {
  gpio: number
  capability: Capability
  state: DeviceState
  online: boolean
  resource?: Resource
  model: ReturnType<typeof useGpioStatus>
  wiring: WiringWorkspace
  initial?: WiringGroup
  onDraft: (draft: WiringGroup) => void
  onSaved: (id: string) => void
  onChangePin: (draft: WiringGroup) => void
  onStopped: () => void
  actionHost: HTMLElement | null
}) {
  const [draft, setDraft] = useState<WiringGroup>(
    () =>
      initial ?? {
        ...newGroup(capability, gpio, 'pin'),
        name: `GPIO${gpio}`,
        config: {
          ...newGroup(capability).config,
          ...(resource?.kind === 'gpio' ? (resource.definition.config as Args) : {}),
          ...(!resource ? { level: 1 } : {}),
        },
      },
  )
  const update = (patch: Partial<WiringGroup>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    onDraft(next)
  }
  const [phase, setPhase] = useState('')
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const pending = useRef(false)
  const form = useRef<HTMLFormElement>(null)
  const busy = !!phase
  const mode = String(draft.config.mode ?? 'input')
  const targetLevel = draft.config.level === 1 ? 1 : 0
  const sameConfig =
    !!resource &&
    resource.kind === 'gpio' &&
    JSON.stringify(
      Object.entries({
        mode: 'input',
        pull: 'none',
        ...((resource.definition.config as Args) ?? {}),
      })
        .filter(([k]) => k !== 'level')
        .sort(),
    ) ===
      JSON.stringify(
        Object.entries({ mode: 'input', pull: 'none', ...draft.config })
          .filter(([k]) => k !== 'level')
          .sort(),
      )
  const foreign =
    !!resource && (state.resource_origin[resource.id] !== 'managed' || resource.kind !== 'gpio')
  const blocked = !online
    ? '页面连接已断开，请恢复连接。'
    : state.status !== 'ready' || state.stale
      ? '正在同步设备状态，完成后可执行。'
      : !capability.available
        ? '固件未开放 GPIO。'
        : foreign && !(sameConfig && mode === 'input')
          ? '此引脚已有其他来源或其他功能的资源，请核对资源来源或先停止相关功能。'
          : resource && resource.state !== 'ready'
            ? '资源尚未就绪，请先核对或释放。'
            : uncertain
              ? '创建或替换结果待核实，请先核对当前资源。'
              : ''
  const desired =
    mode === 'input'
      ? '启用输入'
      : mode === 'open_drain'
        ? targetLevel
          ? '释放输出'
          : '拉低输出'
        : `输出${targetLevel ? '高' : '低'}电平`
  const actionLabel =
    resource && sameConfig
      ? mode === 'input'
        ? '读取输入电平'
        : model.levelText
      : desired
  const run = async () => {
    if (pending.current || blocked || !form.current?.reportValidity()) return
    if (resource && sameConfig && mode === 'input') {
      await model.read()
      return
    }
    pending.current = true
    setError(false)
    setFeedback('')
    const scope = api.deviceScope()
    const config = structuredClone(draft.config)
    const definition = { kind: 'gpio', pins: { pin: gpio }, config }
    let step = '预检'
    let opening: Operation | undefined
    try {
      setPhase(step)
      if (resource && sameConfig) {
        model.beginOperation()
        step = '切换电平'
        setPhase(step)
        await api.run(
          'resource.call',
          { resource: resource.id, action: 'write', args: { level: model.level === 1 ? 0 : 1 } },
          scope,
        )
        step = '读回确认'
        setPhase(step)
        const read = await api.run(
          'resource.call',
          { resource: resource.id, action: 'status', args: {} },
          scope,
        )
        if (read.result?.level !== 0 && read.result?.level !== 1)
          throw new Error('未取得有效电平。')
        model.acceptLevel(read.result.level)
        setFeedback('')
        return
      }
      if (resource) {
        step = '关闭原资源'
        setPhase(step)
        await api.run('resource.close', { resource: resource.id }, scope)
      }
      step = '预检'
      setPhase(step)
      await api.run('resource.preflight', definition, scope)
      step = '创建 GPIO'
      setPhase(step)
      opening = await api.submit('resource.open', definition, scope)
      const opened = await api.wait(opening)
      const id = Number(opened.job?.resource ?? opened.result?.resource)
      if (!id) throw new Error('未取得资源句柄。')
      step = '读回确认'
      setPhase(step)
      const read = await api.run(
        'resource.call',
        { resource: id, action: 'status', args: {} },
        scope,
      )
      if (read.result?.level !== 0 && read.result?.level !== 1) throw new Error('未取得有效电平。')
      setFeedback('')
    } catch (e) {
      let possible = ['创建 GPIO', '读回确认', '关闭原资源', '切换电平'].includes(step)
      if (opening) {
        try {
          const task = await api.request<Operation>('/api/operations/' + opening.id)
          if (['failed', 'cancelled'].includes(task.status) && !task.external_effect_possible)
            possible = false
        } catch {
          /* 未能核对时保持不确定，不自动重试写入。 */
        }
      }
      setUncertain(possible)
      if (resource && possible) model.invalidate('操作结果待核实，请重新读取。')
      setError(true)
      setFeedback(
        `${step}失败：${String(e)}${possible ? '；结果待核实，禁止自动重试。' : '；修正后可重新执行。'}`,
      )
    } finally {
      pending.current = false
      setPhase('')
    }
  }
  const save = async () => {
    if (!draft.name.trim()) throw new Error('请填写接线组名称。')
    const plan = wiring.plan
    if (!plan) throw new Error('方案尚未读取。')
    const savedGroup = { ...draft, pins: { pin: gpio } }
    const exists = plan.groups.some((g) => g.id === draft.id)
    const submitted = {
      ...plan,
      groups: exists
        ? plan.groups.map((g) => (g.id === draft.id ? savedGroup : g))
        : [...plan.groups, savedGroup],
    }
    const saved = await wiring.saveDraft(
      submitted,
      resource?.kind === 'gpio'
        ? {
            group_id: draft.id,
            name: draft.name,
            notes: draft.notes,
            resource: resource.id,
            instance: resource.instance,
          }
        : undefined,
    )
    if (saved) {
      onSaved(draft.id)
      setFeedback('已保存到接线方案，设备输出未改变。')
    }
  }
  return (
    <form ref={form} className="direct-gpio" onSubmit={(e) => e.preventDefault()}>
      <h3>引脚实验</h3>
      <div className="pin-summary">
        <span>引脚</span>
        <output aria-label="当前引脚">GPIO{gpio}</output>
        <button type="button" className="text-button" onClick={() => onChangePin(draft)}>
          更换引脚
        </button>
      </div>
      <SimpleConfig
        kind="gpio"
        initialLevelInAdvanced
        fields={capability.config}
        value={draft.config}
        onChange={(config) => update({ config })}
      />
      {mode !== 'input' && !resource && (
        <p className="muted">
          首次{mode === 'open_drain' ? '驱动' : '输出'}：{targetLevel ? '高电平 1' : '低电平 0'}；
          {mode === 'open_drain' && targetLevel ? '释放状态，需外部上拉。' : '执行前不会改变设备。'}
        </p>
      )}
      {actionHost &&
        createPortal(
          <div className="direct-gpio-actions">
            <Action
              primary
              keepLabelWhileBusy
              disabled={
                !!blocked ||
                busy ||
                model.busy ||
                (!!resource &&
                  sameConfig &&
                  mode !== 'input' &&
                  (model.level === undefined || !!model.error))
              }
              run={run}
            >
              {actionLabel}
            </Action>
            {resource && (
              <Action
                disabled={busy || !online || state.resource_origin[resource.id] !== 'managed'}
                run={async () => {
                  onDraft(draft)
                  await api.run(
                    resource.state === 'fault' ? 'resource.recover' : 'resource.close',
                    { resource: resource.id },
                  )
                  onStopped()
                }}
              >
                {resource.state === 'fault' ? '重试释放引脚' : '停止并释放引脚'}
              </Action>
            )}
            {(error || blocked || model.error) && (
              <p className="direct-gpio-feedback" role="alert">
                {error ? feedback : blocked || model.error}
              </p>
            )}
            {uncertain && (
              <Action
                disabled={busy || !resource || !online}
                run={async () => {
                  if (!resource) return
                  const read = await api.run('resource.call', {
                    resource: resource.id,
                    action: 'status',
                    args: {},
                  })
                  if (read.result?.level !== 0 && read.result?.level !== 1)
                    throw new Error('电平仍待核实。')
                  setUncertain(false)
                  setError(false)
                  setFeedback('已核对现有资源，不会重复创建。')
                  await model.read()
                }}
              >
                核对当前资源
              </Action>
            )}
          </div>,
          actionHost,
        )}
      <details className="wiring-notes">
        <summary>保存到接线方案</summary>
        <label className="field">
          接线组名称
          <input
            value={draft.name}
            maxLength={80}
            onChange={(e) => update({ name: e.target.value })}
          />
        </label>
        <label className="field">
          备注
          <textarea
            value={draft.notes}
            maxLength={2000}
            onChange={(e) => update({ notes: e.target.value })}
          />
        </label>
        <Action
          disabled={busy || wiring.saving || !wiring.plan || !online || !!wiring.remote}
          run={save}
        >
          保存到接线方案
        </Action>
        <p className="muted">
          {resource
            ? '保存设备当前配置和最近读回电平，不应用待执行修改。'
            : '保存待执行配置，不创建或应用设备资源。'}
        </p>
      </details>
      {resource?.kind === 'gpio' && (
        <ResourceActions
          resource={resource}
          capability={capability}
          state={state}
          enabled={online && state.resource_origin[resource.id] === 'managed'}
        />
      )}
    </form>
  )
}
