import { useEffect, useRef, useState } from 'react'
import { Board } from './Board'
import { PinFunctions } from './PinFunctions'
import { SimpleConfig } from './SimpleConfig'
import { GpioStatus } from './GpioStatus'
import { useGpioStatus } from './useGpioStatus'
import { DirectGpio } from './DirectGpio'
import { BOARD_PINS, type BoardPin } from './boardPins'
import { api, boardState, kindNames, type DeviceState, type Capability } from './device'
import { Fields, Action, Result } from './Forms'
import { LedPanel } from './LedPanel'
import { ResourceActions } from './ResourceActions'
import {
  groupPins,
  newGroup,
  pinFunctions,
  pinRoles,
  type BoardSelection,
  type WiringGroup,
} from './wiring'
import type { WiringWorkspace } from './useWiring'
import { label } from './fieldLabels'
export function BoardWorkspace({
  state,
  enabled,
  online,
  wiring,
  selection,
  onSelect,
  onConnect,
}: {
  state: DeviceState
  enabled: boolean
  online: boolean
  wiring: WiringWorkspace
  selection: BoardSelection
  onSelect: (value: BoardSelection) => void
  onConnect: () => void
}) {
  const { plan, setPlan } = wiring
  const [pending, setPending] = useState<{ cap: Capability; gpio: number } | null>(null)
  const [gpioDrafts, setGpioDrafts] = useState<Record<string, WiringGroup>>({})
  const [gpioActionHost, setGpioActionHost] = useState<HTMLDivElement | null>(null)
  const [gpioPicking, setGpioPicking] = useState<{
    draft: WiringGroup
    selection: BoardSelection
  } | null>(null)
  const [assignError, setAssignError] = useState('')
  const [assign, setAssign] = useState<string | null>(null)
  const [checked, setChecked] = useState('')
  const inspector = useRef<HTMLElement>(null)
  const diagnostics = useRef<HTMLDialogElement>(null)
  const [ledFunctions, setLedFunctions] = useState(false)
  const lastPhysical = useRef<string | null>(null)
  const group =
    selection?.type === 'group' ? plan?.groups.find((g) => g.id === selection.id) : undefined
  const pin = selection?.type === 'pin' ? BOARD_PINS.find((p) => p.id === selection.id) : undefined
  const resource =
    selection?.type === 'resource'
      ? state.snapshot?.resources.find(
          (r) => r.id === selection.id && r.instance === selection.instance,
        )
      : undefined
  const cap = state.discovery?.resources.find((c) => c.kind === group?.kind)
  const simpleGroup = group?.kind === 'gpio' || group?.kind === 'pwm'
  const binding = group ? state.wiring_bindings?.[group.id] : undefined
  const bound = binding
    ? state.snapshot?.resources.find(
        (r) => r.id === binding.resource && r.instance === binding.instance,
      )
    : undefined
  const selectedPins =
    group && plan
      ? groupPins(group, plan.groups)
      : selection?.type === 'experiment'
        ? [selection.gpio]
        : pin?.gpio !== undefined
          ? [pin.gpio]
          : resource
            ? Object.values((resource.definition.pins ?? {}) as Record<string, number>)
            : []
  const selectedGpioResource = [
    bound,
    resource,
    state.snapshot?.resources.find(
      (r) =>
        r.kind === 'gpio' && selectedPins.length === 1 && !!(r.pin_mask & (2 ** selectedPins[0])),
    ),
  ].find((r) => r?.kind === 'gpio')
  const directGpio =
    selection?.type === 'experiment' || group?.kind === 'gpio' || resource?.kind === 'gpio'
  const showGpio =
    directGpio ||
    group?.kind === 'gpio' ||
    (!!selectedGpioResource &&
      !(pin?.gpio === 13 && state.identity?.board === 'luatos-esp32c3-usb'))
  const gpioModel = useGpioStatus(state, showGpio ? selectedGpioResource : undefined, online)
  const gpioSelectionKey =
    showGpio && selectedGpioResource
      ? `${state.generation}:${selectedGpioResource.id}:${selectedGpioResource.instance}`
      : ''
  useEffect(() => {
    if (gpioSelectionKey)
      inspector.current?.querySelector('.inspector-content')?.scrollTo({ top: 0 })
  }, [gpioSelectionKey])
  const selectPin = (value: BoardPin) => {
    lastPhysical.current = value.id
    if (gpioPicking) {
      const gpioCap = state.discovery?.resources.find((c) => c.kind === 'gpio')
      if (
        value.gpio === undefined ||
        !gpioCap ||
        !pinFunctions(state, value.gpio).some((c) => c.kind === 'gpio')
      ) {
        setAssignError('此位置不能承担当前信号角色，请重新选择。')
        return
      }
      const next = {
        ...gpioPicking.draft,
        id: newGroup(gpioCap).id,
        pins: { pin: value.gpio },
        name: `GPIO${value.gpio}`,
      }
      setGpioDrafts((current) => ({ ...current, [`gpio-${value.gpio}`]: next }))
      setGpioPicking(null)
      setAssignError('')
      onSelect({ type: 'experiment', gpio: value.gpio })
      requestAnimationFrame(() => inspector.current?.focus({ preventScroll: true }))
      return
    }
    if (assign && group) {
      if (
        value.gpio === undefined ||
        !pinFunctions(state, value.gpio).some((c) => c.kind === group.kind) ||
        (assign.startsWith('ch') && Number(assign.slice(2)) !== value.gpio)
      ) {
        setAssignError('此位置不能承担当前信号角色，请重新选择。')
        return
      }
      updateGroup({ pins: { ...group.pins, [assign]: value.gpio } })
      setAssignError('')
      setAssign(null)
      requestAnimationFrame(() => {
        if (
          inspector.current?.parentElement?.querySelector('.board-stage')?.getBoundingClientRect()
            .height === 0
        )
          inspector.current?.focus({ preventScroll: true })
      })
      return
    }
    setPending(null)
    const belonging =
      value.gpio === undefined
        ? []
        : (plan?.groups.filter((g) => groupPins(g, plan.groups).includes(value.gpio!)) ?? [])
    onSelect(
      belonging[0] && !(belonging.length > 1 && belonging.every((g) => g.kind === 'gpio'))
        ? { type: 'group', id: belonging[0].id }
        : value.gpio !== 13 && state.snapshot?.resources.some(
              (r) => r.kind === 'gpio' && value.gpio !== undefined && !!(r.pin_mask & (2 ** value.gpio)),
            )
          ? { type: 'experiment', gpio: value.gpio! }
          : { type: 'pin', id: value.id },
    )
  }
  const updateGroup = (patch: Partial<WiringGroup>) => {
    if (plan && group)
      setPlan({
        ...plan,
        groups: plan.groups.map((g) => (g.id === group.id ? { ...g, ...patch } : g)),
      })
    setChecked('')
  }
  const create = (capability: Capability, gpio?: number, role?: string, parent?: string) => {
    if (!plan) return
    const next = {
      ...newGroup(capability, gpio, role),
      name: kindNames[capability.kind] ?? capability.kind,
      parent_group: parent ?? null,
    }
    setPlan({ ...plan, groups: [...plan.groups, next] })
    onSelect({ type: 'group', id: next.id })
    setPending(null)
    setChecked('')
  }
  const chooseFunction = (capability: Capability) => {
    if (capability.kind === 'gpio' && pin?.gpio !== undefined) {
      onSelect({ type: 'experiment', gpio: pin.gpio })
      return
    }
    if (pin?.gpio === undefined) {
      create(capability)
      return
    }
    const roles = pinRoles(capability)
    if (roles.length === 1) create(capability, pin.gpio, roles[0])
    else setPending({ cap: capability, gpio: pin.gpio })
  }
  const scope = () => ({
    device_id: state.identity!.device_id,
    boot_id: state.identity!.boot_id,
    generation: state.generation,
    revision: plan!.revision,
  })
  const groupCommand = async (action: 'check' | 'apply') => {
    if (!group || !plan) return
    setChecked('')
    const operation = await api.request<import('./device').Operation>(
      `/api/device/wiring-groups/${group.id}/${action}`,
      'POST',
      scope(),
    )
    await api.wait(operation)
    setChecked(action === 'check' ? `${group.id}:${plan.revision}:${state.generation}` : '')
  }
  const selectionKey = JSON.stringify(selection)
  const [previousSelection, setPreviousSelection] = useState(selectionKey)
  if (selectionKey !== previousSelection) {
    setPreviousSelection(selectionKey)
    setPending(null)
    setAssign(null)
    setLedFunctions(false)
  }
  useEffect(() => {
    inspector.current?.querySelector('.inspector-content')?.scrollTo({ top: 0 })
    const stage = inspector.current?.parentElement?.querySelector('.board-stage')
    if (selectionKey !== 'null' && stage?.getBoundingClientRect().height === 0)
      inspector.current?.focus({ preventScroll: true })
  }, [selectionKey])
  const returnToBoard = () => {
    const id =
      lastPhysical.current ?? BOARD_PINS.find((p) => p.gpio === selectedPins[0])?.id ?? 'L1'
    onSelect(null)
    requestAnimationFrame(() => {
      const target = inspector.current?.parentElement?.querySelector<SVGGElement>(
        `.board-stage [data-pin-id="${id}"]`,
      )
      target?.focus({ preventScroll: true })
      target?.scrollIntoView({ block: 'nearest' })
    })
  }
  const knownBoard = state.identity?.board === 'luatos-esp32c3-usb'
  const functions = pin?.gpio === undefined ? [] : pinFunctions(state, pin.gpio)
  const internal =
    state.discovery?.resources.filter(
      (c) => c.available && !pinRoles(c).length && !c.kind.endsWith('.device'),
    ) ?? []
  const pinLabels: Record<number, string> = {}
  for (const g of plan?.groups ?? [])
    for (const p of groupPins(g, plan!.groups))
      pinLabels[p] = [pinLabels[p], g.name].filter(Boolean).join('、')
  return (
    <>
      <div className="board-workbench-heading">
        <div className="page-heading"><h1>设备工作台</h1></div>
        {state.identity && (
          <div className="wiring-toolbar">
            <label>
              接线方案
              <input
                aria-label="接线方案名称"
                value={plan?.title ?? ''}
                disabled={!plan || wiring.saving}
                onChange={(e) => plan && setPlan({ ...plan, title: e.target.value })}
              />
            </label>
            <Action run={wiring.save} disabled={!wiring.dirty || wiring.saving || !online}>
              保存方案
            </Action>
            <span role="status">
              {wiring.saving
                ? '正在保存'
                : wiring.remote
                  ? '服务器方案有更新'
                  : wiring.dirty
                    ? '未保存修改 · 不影响板上输出'
                    : plan
                      ? plan.revision
                        ? `方案已保存 · 版本 ${plan.revision}`
                        : '尚未保存接线方案'
                      : '读取接线方案'}
            </span>
            <div className="flex-space" />
          </div>
        )}
      </div>
      {!state.identity ? (
        <div className="empty-state">
          <h2>连接服务主机可访问的设备</h2>
          <p>从 USB / BLE 选择设备，或填写 WS / MQTT 目标。连接后即可开始实验。</p>
          <button className="primary" onClick={onConnect}>
            连接设备
          </button>
        </div>
      ) : (
        <>
          {wiring.error && <p role="alert">{wiring.error}</p>}
          {wiring.remote && (
            <div className="notice" role="alert">
              另一页面已修改方案。本地修改已保留，尚未覆盖服务器。
              <button onClick={wiring.acceptRemote}>放弃本地修改并载入服务器版本</button>
              <button
                onClick={() => {
                  if (plan) {
                    const a = document.createElement('a')
                    a.href = URL.createObjectURL(
                      new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }),
                    )
                    a.download = 'wiring-conflict.json'
                    a.click()
                    URL.revokeObjectURL(a.href)
                  }
                }}
              >
                导出本地副本
              </button>
            </div>
          )}
          <div
            className={`board-workspace ${assign || gpioPicking ? 'picking-pin' : ''} ${selection ? 'has-selection' : ''}`}
          >
            <section className="board-stage" aria-label="实物板卡与接线" tabIndex={0}>
              {(assign || gpioPicking) && (
                <div className="pin-picking-status">
                  <span role={assignError ? 'alert' : 'status'}>
                    {assignError ||
                      (gpioPicking ? '在板图选择新引脚' : `选择${label(assign!)}的新位置`)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setAssign(null)
                      if (gpioPicking) {
                        onSelect(gpioPicking.selection)
                        setGpioPicking(null)
                      }
                      setAssignError('')
                      requestAnimationFrame(() => inspector.current?.focus({ preventScroll: true }))
                    }}
                  >
                    取消更换
                  </button>
                </div>
              )}
              {knownBoard ? (
                <Board
                  state={boardState(state)}
                  selectedStatus={
                    showGpio
                      ? `GPIO${selectedPins[0]} · ${selectedGpioResource ? `${gpioModel.modeText} · ${['状态待核实', '结果待核实', '读取中'].includes(gpioModel.qualifier) ? gpioModel.qualifier : gpioModel.levelText}` : directGpio ? '未启用' : '未应用'}`
                      : undefined
                  }
                  selected={selectedPins[0] ?? -1}
                  ready={online && state.status === 'ready'}
                  highlighted={selectedPins}
                  pinLabels={pinLabels}
                  physicalHighlights={group?.support_pins ?? []}
                  physicalLabels={Object.fromEntries(
                    (plan?.groups ?? []).flatMap((g) => g.support_pins.map((id) => [id, g.name])),
                  )}
                  onSelectPin={selectPin}
                  onCloseDiagram={() => {
                    const stage = inspector.current?.parentElement?.querySelector('.board-stage')
                    if (stage?.getBoundingClientRect().height === 0)
                      inspector.current?.focus({ preventScroll: true })
                  }}
                  embedded
                  onInternal={() => onSelect({ type: 'internal' })}
                />
              ) : (
                <>
                  <div className="board-toolbar">
                    <h2>当前设备</h2>
                    <div className="board-toolbar-space" />
                    <button className="text-button" onClick={() => onSelect({ type: 'internal' })}>
                      片内功能
                    </button>
                  </div>
                  <p>当前板型没有已确认的物理位置映射。不会套用其他开发板的引脚图。</p>
                </>
              )}
            </section>
            <section
              className="board-inspector"
              ref={inspector}
              aria-label="接线与调试详情"
              tabIndex={0}
            >
              <header className="inspector-identity">
                <button className="text-button inspector-back" onClick={returnToBoard}>
                  ← 返回板卡
                </button>
                <h2>
                  {group
                    ? group.name
                    : selection?.type === 'experiment'
                      ? `GPIO${selection.gpio} · 引脚实验`
                      : resource
                        ? `设备上的 ${kindNames[resource.kind]}`
                        : pin
                          ? pin.gpio === 13 && knownBoard
                            ? '板载 LED · D5'
                            : `${pin.label}${pin.gpio === undefined ? '' : ` / GPIO ${pin.gpio}`}`
                          : selection?.type === 'internal'
                            ? '片内功能'
                            : '从已接线的位置开始'}
                </h2>
                <p>
                  {group
                    ? kindNames[group.kind]
                    : selection?.type === 'experiment'
                      ? selectedGpioResource
                        ? '临时实验 · 设备已启用'
                        : '临时配置 · 未执行'
                      : resource
                        ? '未归组配置 · 以设备读回为准'
                        : pin
                          ? pin.gpio === 13 && knownBoard
                            ? 'GPIO13 · 板载实验灯'
                            : `${pin.id} · ${pin.description}`
                          : selection?.type === 'internal'
                            ? '这些功能没有独立 GPIO。'
                            : '选择引脚或已有接线组'}
                </p>
                {directGpio && (
                  <button
                    className="text-button inspector-function-back"
                    onClick={() => {
                      const physical = BOARD_PINS.find((p) => p.gpio === selectedPins[0])
                      if (physical) onSelect({ type: 'pin', id: physical.id })
                    }}
                  >
                    选择其他功能
                  </button>
                )}
              </header>
              {showGpio && selectedPins[0] !== undefined && (
                <GpioStatus
                  model={gpioModel}
                  resource={selectedGpioResource}
                  gpio={selectedPins[0]}
                  showOutputControl={!directGpio}
                />
              )}
              <div className="inspector-content">
                {directGpio && state.discovery?.resources.find((c) => c.kind === 'gpio') ? (
                  <DirectGpio
                    key={group?.id ?? `gpio-${selectedPins[0]}`}
                    gpio={selectedPins[0]}
                    capability={state.discovery.resources.find((c) => c.kind === 'gpio')!}
                    state={state}
                    online={online}
                    resource={state.snapshot?.resources.find(
                      (r) => !!(r.pin_mask & (2 ** selectedPins[0])),
                    )}
                    model={gpioModel}
                    actionHost={gpioActionHost}
                    wiring={wiring}
                    initial={gpioDrafts[group?.id ?? `gpio-${selectedPins[0]}`] ?? group}
                    onDraft={(draft) =>
                      setGpioDrafts((current) => ({
                        ...current,
                        [group?.id ?? `gpio-${selectedPins[0]}`]: draft,
                      }))
                    }
                    onSaved={(id) => onSelect({ type: 'group', id })}
                    onStopped={() =>
                      onSelect(
                        group
                          ? { type: 'group', id: group.id }
                          : { type: 'experiment', gpio: selectedPins[0] },
                      )
                    }
                    onChangePin={(draft) => {
                      setGpioPicking({ draft, selection })
                      setAssignError('')
                      onSelect(null)
                      setAssign(null)
                    }}
                  />
                ) : group ? (
                  <>
                    <form onSubmit={(e) => e.preventDefault()}>
                      {simpleGroup && <h3 className="plan-config-title">方案配置</h3>}
                      {!simpleGroup && (
                        <>
                          <label className="field">
                            接线组名称
                            <input
                              value={group.name}
                              onChange={(e) => updateGroup({ name: e.target.value })}
                            />
                          </label>
                          <p className="muted">
                            接线由你记录；实际连接未自动检测。保存方案不会改变设备输出。
                          </p>
                        </>
                      )}
                      {simpleGroup && (
                        <div className="pin-summary">
                          <span>引脚</span>
                          <output aria-label="当前引脚">
                            {group.pins.pin === undefined ? '未分配' : `GPIO${group.pins.pin}`}
                          </output>
                          <button
                            type="button"
                            className="text-button"
                            aria-pressed={assign === 'pin'}
                            onClick={() => {
                              setAssign(assign === 'pin' ? null : 'pin')
                              setAssignError('')
                            }}
                          >
                            更换引脚
                          </button>
                        </div>
                      )}
                      {!simpleGroup &&
                        cap &&
                        pinRoles(cap).map((role) => (
                          <div className="role-row" key={role}>
                            <label className="field">
                              {label(role)}
                              <select
                                aria-label={
                                  label(role) + (cap.required_pins.includes(role) ? ' *' : '')
                                }
                                value={group.pins[role] ?? ''}
                                onChange={(e) => {
                                  const pins = { ...group.pins }
                                  if (e.target.value === '') delete pins[role]
                                  else pins[role] = Number(e.target.value)
                                  updateGroup({ pins })
                                }}
                              >
                                <option value="">未分配</option>
                                {state.discovery?.pins
                                  .filter(
                                    (p) =>
                                      pinFunctions(state, p.pin).some(
                                        (c) => c.kind === group.kind,
                                      ) &&
                                      (!role.startsWith('ch') || p.pin === Number(role.slice(2))),
                                  )
                                  .map((p) => (
                                    <option key={p.pin} value={p.pin}>
                                      GPIO {p.pin}
                                      {p.pin === 13 ? ' · D5 LED' : ''}
                                    </option>
                                  ))}
                              </select>
                            </label>
                            <button
                              type="button"
                              aria-pressed={assign === role}
                              onClick={() => setAssign(assign === role ? null : role)}
                            >
                              在板图选择{label(role)}
                            </button>
                          </div>
                        ))}
                      {assign && !simpleGroup && (
                        <p role="status">
                          请在左侧板图选择 {label(assign)}，电源和保护脚不能分配为信号。
                          {assignError}
                        </p>
                      )}
                      {group.kind.endsWith('.device') && (
                        <label className="field">
                          所属总线
                          <select
                            value={group.parent_group ?? ''}
                            onChange={(e) => updateGroup({ parent_group: e.target.value || null })}
                          >
                            <option value="">请选择</option>
                            {plan?.groups
                              .filter((g) => g.kind === group.kind.replace('device', 'master'))
                              .map((g) => (
                                <option key={g.id} value={g.id}>
                                  {g.name}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                      {cap ? (
                        simpleGroup ? (
                          <SimpleConfig
                            kind={group.kind as 'gpio' | 'pwm'}
                            fields={cap.config}
                            value={group.config}
                            onChange={(config) => updateGroup({ config })}
                          />
                        ) : (
                          <Fields
                            fields={cap.config}
                            value={group.config}
                            onChange={(config) => updateGroup({ config })}
                          />
                        )
                      ) : (
                        <p>当前固件未提供本组功能，方案仍被保留。</p>
                      )}
                      <details className="wiring-notes">
                        <summary>{simpleGroup ? '名称与接线备注' : '接线备注与供电位置'}</summary>
                        {simpleGroup && (
                          <label className="field">
                            接线组名称
                            <input
                              value={group.name}
                              onChange={(e) => updateGroup({ name: e.target.value })}
                            />
                          </label>
                        )}
                        <label className="field">
                          备注
                          <textarea
                            value={group.notes}
                            onChange={(e) => updateGroup({ notes: e.target.value })}
                          />
                        </label>
                        <fieldset>
                          <legend>已接供电 / 地线（人工记录）</legend>
                          {BOARD_PINS.filter((p) =>
                            ['5v', '3v3', 'ground'].includes(p.category),
                          ).map((p) => (
                            <label key={p.id}>
                              <input
                                type="checkbox"
                                checked={group.support_pins.includes(p.id)}
                                onChange={(e) =>
                                  updateGroup({
                                    support_pins: e.target.checked
                                      ? [...group.support_pins, p.id]
                                      : group.support_pins.filter((id) => id !== p.id),
                                  })
                                }
                              />
                              {p.id} · {p.label}
                            </label>
                          ))}
                        </fieldset>
                      </details>
                      <div className="row">
                        <Action
                          run={() => groupCommand('check')}
                          disabled={wiring.dirty || !online || !cap?.available || !!bound}
                        >
                          检查本组
                        </Action>
                        <Action
                          primary
                          run={() => groupCommand('apply')}
                          disabled={
                            !enabled ||
                            state.stale ||
                            wiring.dirty ||
                            !!bound ||
                            checked !== `${group.id}:${plan?.revision}:${state.generation}`
                          }
                        >
                          应用本组
                        </Action>
                      </div>
                      <p className="muted">
                        {wiring.dirty
                          ? '先保存方案，再检查并应用本组。'
                          : bound
                            ? '设备已有本组配置；修改方案不会自动替换它。'
                            : checked
                              ? !enabled
                                ? '预检通过；请先取得本页控制权，才能应用。'
                                : state.stale
                                  ? '预检通过；正在同步设备状态，完成后才能应用。'
                                  : '预检通过，未预留资源；应用时设备仍会检查。'
                              : '尚未应用 · 检查通过后才能配置设备。'}
                      </p>
                    </form>
                    {bound && (
                      <ResourceActions
                        key={`${state.generation}:${bound.id}:${bound.instance}`}
                        resource={bound}
                        capability={state.discovery?.resources.find((c) => c.kind === bound.kind)}
                        state={state}
                        enabled={enabled}
                      />
                    )}
                    {cap?.kind.endsWith('.master') && (
                      <div className="row">
                        {state.discovery?.resources
                          .filter(
                            (c) => c.available && c.kind === cap.kind.replace('master', 'device'),
                          )
                          .map((c) => (
                            <button
                              key={c.kind}
                              onClick={() => create(c, undefined, undefined, group.id)}
                            >
                              添加{kindNames[c.kind]}
                            </button>
                          ))}
                      </div>
                    )}
                    <details>
                      <summary>组管理</summary>
                      <button
                        disabled={!!bound || plan?.groups.some((g) => g.parent_group === group.id)}
                        onClick={() => {
                          if (plan) {
                            setPlan({
                              ...plan,
                              groups: plan.groups.filter((g) => g.id !== group.id),
                            })
                            onSelect(null)
                          }
                        }}
                      >
                        从方案移除
                      </button>
                    </details>
                  </>
                ) : resource ? (
                  <>
                    <ResourceActions
                      key={`${state.generation}:${resource.id}:${resource.instance}`}
                      resource={resource}
                      capability={state.discovery?.resources.find((c) => c.kind === resource.kind)}
                      state={state}
                      enabled={enabled}
                    />
                  </>
                ) : pin ? (
                  <>
                    {pin.gpio === 13 && knownBoard && (
                      <>
                        <LedPanel state={state} online={online} enabled={enabled} embedded />
                        <button
                          className="text-button led-other-functions"
                          aria-expanded={ledFunctions}
                          onClick={() => setLedFunctions(!ledFunctions)}
                        >
                          GPIO13 其他功能
                        </button>
                      </>
                    )}
                    {pending ? (
                      <div>
                        <h3>此引脚在 {kindNames[pending.cap.kind]} 中的角色</h3>
                        {pinRoles(pending.cap)
                          .filter(
                            (role) =>
                              !role.startsWith('ch') || Number(role.slice(2)) === pending.gpio,
                          )
                          .map((role) => (
                            <button
                              key={role}
                              onClick={() => create(pending.cap, pending.gpio, role)}
                            >
                              {label(role)}
                            </button>
                          ))}
                      </div>
                    ) : (
                      (pin.gpio !== 13 || !knownBoard || ledFunctions) &&
                      (functions.length ? (
                        <PinFunctions
                          key={pin.id}
                          functions={functions}
                          onChoose={chooseFunction}
                        />
                      ) : (
                        <div className="pin-functions">
                          <h3>{pin.protected ? '受保护 · 不可配置' : '此位置仅查看信息'}</h3>
                        </div>
                      ))
                    )}
                  </>
                ) : selection?.type === 'internal' ? (
                  <>
                    {internal.map((c) => (
                      <button key={c.kind} onClick={() => create(c)}>
                        {kindNames[c.kind]}
                      </button>
                    ))}
                  </>
                ) : (
                  <div className="board-selection-help">
                    <p>选中板上引脚，分配功能并记录接线；也可从左侧选择已有接线组。</p>
                    <p>多引脚功能整体配置，方案和设备实际状态分别显示。</p>
                  </div>
                )}
              </div>
              {directGpio && <div className="direct-gpio-action-host" ref={setGpioActionHost} />}
              <button
                className="inspector-diagnostics function-row"
                onClick={() => diagnostics.current?.showModal()}
              >
                <strong>诊断信息</strong>
                <small>能力与快照</small>
                <i className="family-chevron" aria-hidden="true" />
              </button>
              <dialog
                ref={diagnostics}
                className="board-dialog inspector-diagnostic-dialog"
                aria-labelledby="board-diagnostics-title"
              >
                <div className="board-dialog-heading">
                  <h2 id="board-diagnostics-title">诊断信息</h2>
                  <button onClick={() => diagnostics.current?.close()}>关闭诊断</button>
                </div>
                <details className="unavailable-functions">
                  <summary>当前固件不可用功能</summary>
                  {state.discovery?.resources
                    .filter((c) => !c.available)
                    .map((c) => (
                      <p key={c.kind}>{kindNames[c.kind] ?? c.kind} · 当前固件未提供</p>
                    ))}
                </details>
                <details>
                  <summary>当前一致快照</summary>
                  <Result value={state.snapshot} />
                </details>
              </dialog>
            </section>
          </div>
        </>
      )}
    </>
  )
}
