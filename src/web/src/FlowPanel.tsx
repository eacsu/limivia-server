import { useState } from 'react'
import {
  api,
  kindNames,
  actionNames,
  saveBlob,
  type Args,
  type DeviceState,
  type Parameter,
} from './device'
import { Action, Fields, ObjectEditor, Result } from './Forms'
const ops: Record<string, string> = {
  call: '资源操作',
  service: '系统服务',
  await: '等待条件',
  delay: '等待时间',
  set: '设置变量',
  add: '变量累加',
  if: '条件分支',
  loop: '有限循环',
  sleep: '计划深睡眠',
  end: '结束',
}
const services = [
  'storage.record',
  'storage.append',
  'mqtt.publish',
  'espnow.send',
  'system.time',
  'wifi.status',
  'mqtt.status',
]
interface Definition {
  version: number
  profile: string
  autostart: boolean
  resources: Args[]
  variables: Args
  steps: Args[]
  repeat_ms?: number
}
const newStep = (op: string): Args =>
  op === 'delay'
    ? { op, ms: 500 }
    : op === 'end'
      ? { op }
      : op === 'loop'
        ? { op, count: 10, target: 0 }
        : op === 'sleep'
          ? { op, duration_ms: 1000 }
          : ['call', 'await', 'service'].includes(op)
            ? {
                op,
                ...(op === 'service'
                  ? { action: 'system.time' }
                  : { resource: '', action: 'status' }),
                args: {},
                timeout_ms: 6000,
                ...(op === 'await' ? { field: '', poll_ms: 100 } : {}),
              }
            : {
                op,
                variable: '',
                value: 0,
                ...(op === 'if' ? { compare: 'eq', then: 0, else: 0 } : {}),
              }
export function FlowPanel({ state, enabled }: { state: DeviceState; enabled: boolean }) {
  const [definition, setDefinition] = useState<Definition>({
    version: 1,
    profile: state.identity?.profile ?? 'signal',
    autostart: false,
    resources: [],
    variables: {},
    steps: [newStep('delay'), newStep('end')],
  })
  const [name, setName] = useState('experiment.flow.json')
  const [selected, setSelected] = useState(0)
  const [selectedResource, setSelectedResource] = useState(-1)
  const [flowId, setFlowId] = useState('')
  const [result, setResult] = useState<unknown>(null)
  const [checks, setChecks] = useState<string[]>([])
  const [newOp, setNewOp] = useState('call')
  const update = (patch: Partial<Definition>) => {
    setDefinition({ ...definition, ...patch })
    setChecks([])
  }
  const step = definition.steps[selected]
  const stepResource = definition.resources.find((r) => r.name === step?.resource)
  const stepCapability = state.discovery?.resources.find((c) => c.kind === stepResource?.kind)
  const stepArgs = stepCapability?.actions.find((a) => a.action === step?.action)?.args ?? []
  const declaration = definition.resources[selectedResource]
  const cap = state.discovery?.resources.find((c) => c.kind === declaration?.kind)
  const updateStep = (next: Args) =>
    update({ steps: definition.steps.map((s, i) => (i === selected ? next : s)) })
  const validate = async () => {
    const check = await api.request<{ valid: boolean; errors: string[]; bytes: number }>(
      '/api/device/flows/validate',
      'POST',
      definition,
    )
    setChecks(
      check.valid
        ? [`本地校验通过 · ${check.bytes} 字节；设备仍会在加载和运行时检查。`]
        : check.errors,
    )
    if (!check.valid) throw new Error(check.errors.join(' '))
    return check
  }
  const move = (offset: number) => {
    const target = selected + offset
    if (target < 0 || target >= definition.steps.length) return
    const order = definition.steps.map((_, i) => i)
    ;[order[selected], order[target]] = [order[target], order[selected]]
    const mapping = new Map(order.map((old, i) => [old, i]))
    update({
      steps: order.map((old) =>
        Object.fromEntries(
          Object.entries(definition.steps[old]).map(([key, v]) => [
            ['then', 'else', 'target', 'on_error'].includes(key) ? key : key,
            ['then', 'else', 'target', 'on_error'].includes(key) && typeof v === 'number'
              ? mapping.get(v)!
              : v,
          ]),
        ),
      ),
    })
    setSelected(target)
  }
  const fields: Parameter[] = step
    ? Object.keys(step)
        .filter((k) => !['op', 'args', 'resource', 'action'].includes(k))
        .map((k) => ({
          name: k,
          type: ['field', 'variable', 'store', 'compare'].includes(k) ? 'string' : 'integer',
          required: true,
          ...(k === 'compare' ? { values: 'eq,ne,lt,le,gt,ge' } : {}),
        }))
    : []
  const positions = definition.steps.map((_, i) => ({
    x: 28 + (Math.floor(i / 4) % 2 ? 3 - (i % 4) : i % 4) * 200,
    y: 28 + Math.floor(i / 4) * 120,
  }))
  const height = Math.max(280, Math.ceil(definition.steps.length / 4) * 120 + 40)
  return (
    <>
      <div className="page-heading">
        <h1>离线流程</h1>
        <span>设备端执行 · 上传、加载与运行分别确认</span>
      </div>
      <div className="row">
        <Action
          primary
          disabled={!enabled}
          run={async () => {
            const scope = api.deviceScope()
            await validate()
            const file = new File([JSON.stringify(definition)], name, { type: 'application/json' })
            await api.wait(await api.upload(file, name))
            const task = await api.run('flow.load', { name }, scope)
            setFlowId(String(task.result?.flow_id ?? ''))
            setResult(task.result)
          }}
        >
          上传并加载
        </Action>
        <Action run={validate}>校验流程</Action>
        <label className="file-label">
          导入流程
          <input
            type="file"
            accept=".json"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              try {
                const value = JSON.parse(await file.text())
                const check = await api.request<{ valid: boolean; errors: string[] }>(
                  '/api/device/flows/validate',
                  'POST',
                  value,
                )
                if (check.valid) {
                  setDefinition(value)
                  setName(file.name)
                  setSelected(0)
                  setChecks([])
                } else setChecks(check.errors)
              } catch {
                setChecks(['文件不是有效流程 JSON。'])
              }
            }}
          />
        </label>
        <button
          onClick={() =>
            saveBlob(
              new Blob([JSON.stringify(definition, null, 2)], { type: 'application/json' }),
              name,
            )
          }
        >
          导出流程文件
        </button>
      </div>
      <div className="notice">
        <strong>结构化流程</strong>
        <p>用动作、等待与循环组织执行顺序。资源与变量在侧边配置，运行前整体检查占用。</p>
      </div>
      <div className="flow-workspace">
        <section>
          <h2>执行顺序</h2>
          <div className="flow-scroll">
            <div className="flow-canvas" style={{ height, width: 850 }}>
              <svg width="850" height={height} aria-hidden="true">
                <defs>
                  <marker
                    id="flow-arrow"
                    markerWidth="7"
                    markerHeight="7"
                    refX="6"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L6,3 L0,6" />
                  </marker>
                </defs>
                {positions.slice(1).map((point, i) => {
                  const previous = positions[i]
                  return (
                    <path
                      key={i}
                      markerEnd="url(#flow-arrow)"
                      d={
                        previous.y === point.y
                          ? previous.x < point.x
                            ? `M${previous.x + 160} ${previous.y + 35} L${point.x} ${point.y + 35}`
                            : `M${previous.x} ${previous.y + 35} L${point.x + 160} ${point.y + 35}`
                          : `M${previous.x + 80} ${previous.y + 70} V${point.y + 15} H${point.x + 80}`
                      }
                    />
                  )
                })}
              </svg>
              {definition.steps.map((s, i) => (
                <button
                  className={'flow-node ' + (selected === i ? 'selected' : '')}
                  key={i}
                  style={{ left: positions[i].x, top: positions[i].y }}
                  onClick={() => {
                    setSelected(i)
                    setSelectedResource(-1)
                  }}
                >
                  <small>
                    步骤 {i} · {String(s.op)}
                  </small>
                  <strong>{ops[String(s.op)]}</strong>
                  <span>
                    {s.action
                      ? String(s.action)
                      : s.ms
                        ? String(s.ms) + ' ms'
                        : s.variable
                          ? String(s.variable)
                          : s.target !== undefined
                            ? '返回步骤 ' + s.target
                            : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <select
              aria-label="添加步骤类型"
              value={newOp}
              onChange={(e) => setNewOp(e.target.value)}
            >
              {Object.entries(ops).map(([key, text]) => (
                <option key={key} value={key}>
                  {text}
                </option>
              ))}
            </select>
            <button
              disabled={definition.steps.length >= 64}
              onClick={() => {
                update({ steps: [...definition.steps, newStep(newOp)] })
                setSelected(definition.steps.length)
              }}
            >
              添加步骤
            </button>
            <button onClick={() => move(-1)} disabled={selected === 0}>
              前移
            </button>
            <button onClick={() => move(1)} disabled={selected >= definition.steps.length - 1}>
              后移
            </button>
            <button
              disabled={definition.steps.length <= 1}
              onClick={() => {
                if (
                  definition.steps.some((s) =>
                    ['then', 'else', 'target', 'on_error'].some((k) => s[k] === selected),
                  )
                ) {
                  setChecks(['该步骤是跳转目标，请先修改引用它的分支。'])
                  return
                }
                update({
                  steps: definition.steps
                    .filter((_, i) => i !== selected)
                    .map((s) =>
                      Object.fromEntries(
                        Object.entries(s).map(([k, v]) => [
                          k,
                          ['then', 'else', 'target', 'on_error'].includes(k) &&
                          typeof v === 'number' &&
                          v > selected
                            ? v - 1
                            : v,
                        ]),
                      ),
                    ),
                })
                setSelected(Math.max(0, selected - 1))
              }}
            >
              移除步骤
            </button>
          </div>
          <h2>流程资源与变量</h2>
          {definition.resources.map((r, i) => (
            <div className="list-row" key={i}>
              <button onClick={() => setSelectedResource(i)}>
                {String(r.name)} · {kindNames[String(r.kind)] ?? String(r.kind)}
              </button>
              <button
                onClick={() =>
                  update({ resources: definition.resources.filter((_, index) => index !== i) })
                }
              >
                移除资源声明
              </button>
            </div>
          ))}
          <button
            disabled={definition.resources.length >= 12}
            onClick={() => {
              const kind = state.discovery?.resources.find((c) => c.available)?.kind ?? 'gpio'
              update({
                resources: [
                  ...definition.resources,
                  {
                    name: 'resource' + (definition.resources.length + 1),
                    kind,
                    pins: {},
                    config: {},
                  },
                ],
              })
              setSelectedResource(definition.resources.length)
            }}
          >
            添加资源声明
          </button>
          <h3>数值变量（最多 8 个）</h3>
          <ObjectEditor
            value={definition.variables}
            onChange={(v) => update({ variables: v as Args })}
          />
        </section>
        <aside>
          <h2>{declaration ? '资源声明' : '节点属性'}</h2>
          {declaration ? (
            <>
              <label className="field">
                符号名
                <input
                  value={String(declaration.name)}
                  onChange={(e) =>
                    update({
                      resources: definition.resources.map((r, i) =>
                        i === selectedResource ? { ...r, name: e.target.value } : r,
                      ),
                    })
                  }
                />
              </label>
              <label className="field">
                资源类型
                <select
                  value={String(declaration.kind)}
                  onChange={(e) =>
                    update({
                      resources: definition.resources.map((r, i) =>
                        i === selectedResource
                          ? { ...r, kind: e.target.value, pins: {}, config: {} }
                          : r,
                      ),
                    })
                  }
                >
                  {state.discovery?.resources
                    .filter((c) => c.available)
                    .map((c) => (
                      <option key={c.kind} value={c.kind}>
                        {kindNames[c.kind] ?? c.kind}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                父资源符号名（可选）
                <input
                  value={String(declaration.parent ?? '')}
                  onChange={(e) => {
                    const copy = { ...declaration }
                    if (e.target.value) copy.parent = e.target.value
                    else delete copy.parent
                    update({
                      resources: definition.resources.map((r, i) =>
                        i === selectedResource ? copy : r,
                      ),
                    })
                  }}
                />
              </label>
              <label className="field">
                控制器（可选）
                <input
                  type="number"
                  min="0"
                  value={String(declaration.controller ?? '')}
                  onChange={(e) => {
                    const next = { ...declaration }
                    if (e.target.value === '') delete next.controller
                    else next.controller = Number(e.target.value)
                    update({
                      resources: definition.resources.map((r, i) =>
                        i === selectedResource ? next : r,
                      ),
                    })
                  }}
                />
              </label>
              <h3>引脚角色</h3>
              {(cap?.pin_roles.match(/[a-zA-Z_][\w.]*/g) ?? []).map((role) => (
                <label className="field" key={role}>
                  {role}
                  <select
                    aria-label={'流程引脚 ' + role}
                    value={String((declaration.pins as Args)?.[role] ?? '')}
                    onChange={(e) => {
                      const pins = { ...(declaration.pins as Args) }
                      if (e.target.value === '') delete pins[role]
                      else pins[role] = Number(e.target.value)
                      update({
                        resources: definition.resources.map((r, i) =>
                          i === selectedResource ? { ...r, pins } : r,
                        ),
                      })
                    }}
                  >
                    <option value="">未分配</option>
                    {state.discovery?.pins
                      .filter((p) =>
                        String(declaration.kind).startsWith('adc') ? p.adc1 : p.digital,
                      )
                      .map((p) => (
                        <option key={p.pin} value={p.pin}>
                          GPIO {p.pin}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              <Fields
                fields={cap?.config ?? []}
                value={(declaration.config ?? {}) as Args}
                onChange={(v) =>
                  update({
                    resources: definition.resources.map((r, i) =>
                      i === selectedResource ? { ...r, config: v } : r,
                    ),
                  })
                }
              />
            </>
          ) : step ? (
            <>
              <label className="field">
                步骤类型
                <select
                  value={String(step.op)}
                  onChange={(e) => updateStep(newStep(e.target.value))}
                >
                  {Object.entries(ops).map(([op, text]) => (
                    <option value={op} key={op}>
                      {text}
                    </option>
                  ))}
                </select>
              </label>
              {['call', 'await'].includes(String(step.op)) && (
                <label className="field">
                  流程资源
                  <select
                    value={String(step.resource)}
                    onChange={(e) => updateStep({ ...step, resource: e.target.value })}
                  >
                    <option value="">请选择</option>
                    {definition.resources.map((r) => (
                      <option key={String(r.name)}>{String(r.name)}</option>
                    ))}
                  </select>
                </label>
              )}
              {['call', 'await', 'service'].includes(String(step.op)) && (
                <>
                  <label className="field">
                    操作
                    {step.op === 'service' ? (
                      <select
                        value={String(step.action)}
                        onChange={(e) => updateStep({ ...step, action: e.target.value })}
                      >
                        {services.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    ) : (
                      <select
                        value={String(step.action)}
                        onChange={(e) => updateStep({ ...step, action: e.target.value, args: {} })}
                      >
                        <option value="status">读取状态 · status</option>
                        {stepCapability?.actions
                          .filter((a) => a.action !== 'status')
                          .map((a) => (
                            <option key={a.action} value={a.action}>
                              {actionNames[a.action] ?? a.action} · {a.action}
                            </option>
                          ))}
                      </select>
                    )}
                  </label>
                  <h3>参数与引用</h3>
                  {step.op !== 'service' && (
                    <Fields
                      fields={stepArgs}
                      value={(step.args as Args) ?? {}}
                      onChange={(v) => updateStep({ ...step, args: v })}
                    />
                  )}
                  <details open={step.op === 'service'}>
                    <summary>变量、结果引用与高级参数</summary>
                    <ObjectEditor
                      value={step.args ?? {}}
                      onChange={(v) => updateStep({ ...step, args: v })}
                    />
                  </details>
                  <small>变量引用使用对象字段 $var；上次结果字段使用 $result。</small>
                </>
              )}
              <Fields fields={fields} value={step} onChange={updateStep} />
              {['call', 'await', 'service'].includes(String(step.op)) && (
                <div className="row">
                  <button onClick={() => updateStep({ ...step, on_error: 0 })}>添加失败分支</button>
                  <button onClick={() => updateStep({ ...step, store: '' })}>保存结果至变量</button>
                </div>
              )}
            </>
          ) : null}
          <hr />
          <h2>流程设置</h2>
          <label className="field">
            流程文件
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            profile
            <input
              value={definition.profile}
              onChange={(e) => update({ profile: e.target.value })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={definition.autostart}
              onChange={(e) => {
                update({ autostart: e.target.checked })
              }}
            />
            自动启动（默认关闭）
          </label>
          <label className="field">
            重复间隔 ms（可选）
            <input
              type="number"
              min="1"
              value={definition.repeat_ms ?? ''}
              onChange={(e) => {
                const copy = { ...definition }
                if (e.target.value) copy.repeat_ms = Number(e.target.value)
                else delete copy.repeat_ms
                setDefinition(copy)
              }}
            />
          </label>
          <p>流程结束仍可能持有资源；停止并清理确认后才释放。</p>
        </aside>
      </div>
      {checks.length > 0 && (
        <div role="status">
          {checks.map((text, i) => (
            <p key={i}>{text}</p>
          ))}
        </div>
      )}
      <h2>已加载流程</h2>
      <div className="row">
        <label>
          流程 ID
          <input type="number" min="1" value={flowId} onChange={(e) => setFlowId(e.target.value)} />
        </label>
        <Action run={async () => setResult((await api.run('flow.list')).result)}>
          读取流程列表
        </Action>
        {['get', 'start', 'pause', 'resume', 'stop', 'remove'].map((action) => (
          <Action
            key={action}
            disabled={!flowId || (!enabled && action !== 'get')}
            run={async () => {
              const task = await api.run('flow.' + action, { flow_id: Number(flowId) })
              setResult(task.result)
            }}
          >
            {
              {
                get: '查询状态',
                start: '启动流程',
                pause: '暂停',
                resume: '继续',
                stop: '停止并清理',
                remove: '移除加载项',
              }[action]
            }
          </Action>
        ))}
      </div>
      <h3>本次操作结果</h3>
      <p className="muted">
        操作完成不代表流程运行或清理结束。运行中的步骤与变量请通过“查询状态”读取设备最新值。
      </p>
      <Result value={result} />
      <details>
        <summary>流程定义（只读预览）</summary>
        <pre>{JSON.stringify(definition, null, 2)}</pre>
      </details>
    </>
  )
}
