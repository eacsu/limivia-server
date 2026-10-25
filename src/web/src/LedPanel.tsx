import { useRef, useState } from 'react'
import { api, type Args, type DeviceState } from './device'
import { confirmedLedOutput, ledOutputKey, type ConfirmedLedOutput } from './ledOutput'
import { useDelayedFlag } from './useDelayedFlag'
import { Action } from './Forms'
import { LedIndicator, NumberField } from './WorkbenchUI'
import boardLight from './assets/figma/led-board-vallum.svg'
import boardDark from './assets/figma/led-board-abyssus.svg'
import targetLight from './assets/figma/led-target-vallum.svg'
import targetDark from './assets/figma/led-target-abyssus.svg'

export function LedPanel({
  state,
  enabled,
  online,
  onDetails,
  embedded = false,
}: {
  state: DeviceState
  enabled: boolean
  online: boolean
  onDetails?: () => void
  embedded?: boolean
}) {
  const r = state.snapshot?.resources.find((resource) => resource.pin_mask & (2 ** 13))
  const config = r?.definition.config as Args | undefined
  const [mode, setMode] = useState(r?.kind === 'pwm' ? 'breath' : 'switch')
  const [duty, setDuty] = useState(typeof config?.duty === 'number' ? config.duty : 50)
  const [feedback, setFeedback] = useState('')
  const [feedbackError, setFeedbackError] = useState(false)
  const showError = (message: string) => {
    setFeedbackError(true)
    setFeedback(message)
  }
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const pending = useRef(false)
  const boardSupported = state.identity?.board === 'luatos-esp32c3-usb'
  const fresh = online && state.status === 'ready' && !state.stale
  const occupied =
    !!r && (state.resource_origin[r.id] !== 'managed' || !['gpio', 'pwm'].includes(r.kind))
  const resourceKey = ledOutputKey(state, r)
  const [invalidatedKey, setInvalidatedKey] = useState<string | null>(null)
  const released = !!r && invalidatedKey === resourceKey
  const [confirmed, setConfirmed] = useState<ConfirmedLedOutput | null>(null)
  const output = confirmedLedOutput(confirmed, state, r, online, busy, uncertain || released)
  if (output !== confirmed) setConfirmed(output)
  const known = !!output
  const on = output?.output === 'on'
  const breathing = output?.output === 'breath'
  const syncing = useDelayedFlag(online && state.status === 'ready' && state.stale, resourceKey)
  const supports = (kind: string) =>
    state.discovery?.resources.some(
      (c) =>
        c.kind === kind &&
        c.available &&
        c.actions.some((a) => a.action === (kind === 'gpio' ? 'write' : 'duty')) &&
        (kind !== 'pwm' || c.config.some((field) => field.name === 'breath_ms')),
    )
  const digital = state.discovery?.pins.some((pin) => pin.pin === 13 && pin.digital)
  const writable =
    enabled &&
    fresh &&
    boardSupported &&
    digital &&
    !occupied &&
    !busy &&
    !uncertain &&
    !released &&
    (!r || r.state === 'ready')
  const transact = async (work: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setFeedbackError(false)
    try {
      await work()
    } catch (error) {
      setUncertain(true)
      setFeedback('操作结果待核实，请重新读取状态。')
      throw error
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const apply = async () => {
    if (!writable) return
    if (mode === 'breath' && (!Number.isFinite(duty) || duty < 0 || duty > 100))
      throw new Error('峰值占空比须在 0–100% 之间。')
    const scope = api.deviceScope()
    const run = (op: string, args: Args = {}) => api.run(op, args, scope)
    const kind = mode === 'switch' ? 'gpio' : 'pwm'
    await transact(async () => {
      let id = r?.id
      if (r && r.kind !== kind) {
        await run('resource.close', { resource: r.id })
        setInvalidatedKey(resourceKey)
      }
      if (!r || r.kind !== kind) {
        const draft: Args = {
          kind,
          pins: { pin: 13 },
          config:
            kind === 'gpio'
              ? { mode: 'output', level: 1 }
              : { frequency: 1000, resolution: 10, duty, breath_ms: 2000 },
        }
        await run('resource.preflight', draft)
        const result = await run('resource.open', draft)
        id = Number(result.job?.resource ?? result.result?.resource)
        if (!id) throw new Error('未收到 LED 资源句柄。')
      } else {
        await run('resource.call', {
          resource: r.id,
          action: kind === 'gpio' ? 'write' : 'duty',
          args: kind === 'gpio' ? { level: on ? 0 : 1 } : { duty },
        })
      }
      await run('resource.call', { resource: id!, action: 'status', args: {} })
      setFeedback('操作已确认，已读取设备输出状态。')
    })
  }
  const status = !boardSupported
    ? '板型待确认'
    : !online || state.status !== 'ready'
      ? '状态待核实'
      : occupied
        ? '其他来源占用'
        : uncertain
          ? '结果待核实'
          : released || (!r && !busy)
            ? '未创建 LED 资源'
            : !known
              ? '尚未确认输出'
              : breathing
                ? '呼吸运行中'
                : output.output === 'pwm'
                  ? 'PWM 输出中'
                  : on
                    ? '已点亮'
                    : '已熄灭'
  if (state.identity && !boardSupported)
    return (
      <section className="home-led" aria-label="板载 LED 快捷控制">
        <h2>板载 LED</h2>
        <p>当前板型尚未配置板载 LED 映射，请在外设调试中按设备能力选择引脚。</p>
      </section>
    )
  return (
    <section
      className={`home-led ${mode === 'breath' ? 'breath-mode' : ''} ${embedded ? 'embedded-led' : ''}`}
      aria-label="板载 LED 快捷控制"
    >
      {!embedded && (
        <div className="home-led-heading">
          <div>
            <h2>板载 LED</h2>
            <span>D5 · GPIO13 · 无需外部接线</span>
          </div>
          <small>输出示意 · 非物理测量</small>
        </div>
      )}
      <div className="home-led-body">
        {!embedded && (
          <div className="led-board-location">
            <div
              className="led-board-crop"
              role="img"
              aria-label="开发板正面 USB 左侧为 D5 实验灯，右侧 D4 为系统状态灯"
            >
              <img className="led-board-image theme-light" src={boardLight} alt="" />
              <img className="led-board-image theme-dark" src={boardDark} alt="" />
              <img className="led-board-target theme-light" src={targetLight} alt="" />
              <img className="led-board-target theme-dark" src={targetDark} alt="" />
              <span className="board-label-d5">D5</span>
              <span className="board-label-d4">D4</span>
              <span className="board-label-usb">USB</span>
            </div>
            <small>
              正面 USB 左侧为 D5 实验灯
              <br />
              D4 · GPIO12 为系统状态灯（只读）
            </small>
          </div>
        )}
        <div className="led-output-state">
          <LedIndicator
            state={
              !known || occupied
                ? 'unknown'
                : breathing
                  ? 'breath'
                  : on
                    ? 'on'
                    : r?.kind === 'gpio'
                      ? 'off'
                      : 'unknown'
            }
          />
          <div>
            <small>设备最近确认输出</small>
            <h3>{status}</h3>
            <small>
              {known && !occupied
                ? breathing
                  ? '周期 2000 ms · 设备已确认'
                  : r?.kind === 'gpio'
                    ? `设备已确认输出为${on ? '高' : '低'}电平`
                    : '以设备返回状态为准'
                : !r
                  ? '等待创建 LED 资源'
                  : '以设备返回状态为准'}
            </small>
          </div>
        </div>
        <div className="led-controls">
          <div className="led-mode-row">
            <div className="mode-switch" role="group" aria-label="LED 控制模式">
              <button
                disabled={busy}
                aria-pressed={mode === 'switch'}
                onClick={() => setMode('switch')}
              >
                开关控制
              </button>
              <button
                disabled={busy || !supports('pwm')}
                aria-pressed={mode === 'breath'}
                onClick={() => setMode('breath')}
              >
                呼吸演示
              </button>
            </div>
            {mode === 'breath' && (
              <NumberField
                label="峰值占空比"
                value={duty}
                onChange={setDuty}
                min={0}
                max={100}
                unit="%"
              />
            )}
          </div>
          <div className="led-actions">
            <Action
              onError={showError}
              keepLabelWhileBusy
              primary
              disabled={
                !writable ||
                !supports(mode === 'switch' ? 'gpio' : 'pwm') ||
                (!!r && r.kind === 'gpio' && mode === 'switch' && !known)
              }
              run={apply}
            >
              {mode === 'switch'
                ? on
                  ? '熄灭 LED'
                  : '点亮 LED'
                : r?.kind === 'pwm'
                  ? '应用占空比'
                  : '开始呼吸'}
            </Action>
            <Action
              onError={showError}
              keepLabelWhileBusy
              disabled={
                !fresh ||
                !boardSupported ||
                busy ||
                (!!r && (r.state !== 'ready' || !['gpio', 'pwm'].includes(r.kind)))
              }
              run={() =>
                transact(async () => {
                  if (r)
                    await api.run('resource.call', { resource: r.id, action: 'status', args: {} })
                  else await api.request('/api/device/refresh', 'POST')
                  setInvalidatedKey(null)
                  setUncertain(false)
                  setFeedback('状态已读取，输出保持不变。')
                })
              }
            >
              读取状态
            </Action>
            <Action
              onError={showError}
              keepLabelWhileBusy
              disabled={!online || state.status !== 'ready' || busy || !r || occupied || released}
              run={() =>
                transact(async () => {
                  await api.run('resource.close', { resource: r!.id })
                  setInvalidatedKey(resourceKey)
                  setFeedback('LED 资源已释放。')
                })
              }
            >
              关闭 LED 资源
            </Action>
          </div>
          <div
            className="led-feedback"
            role={feedbackError ? 'alert' : 'status'}
            aria-atomic="true"
            tabIndex={0}
            aria-label="LED 操作反馈"
          >
            {busy
              ? '已提交，等待设备确认。'
              : feedbackError
                ? feedback
                : syncing
                  ? '正在同步设备状态，旧信息仅供参考。'
                  : occupied
                    ? 'GPIO13 已被占用，请从左侧配置核对来源。'
                    : feedback ||
                      (!enabled
                        ? '连接设备后即可操作 LED。'
                        : '输出以设备确认结果为准；断开页面不会停止输出。')}
          </div>
          <div className="led-links">
            {onDetails && (
              <button className="text-button" aria-label="打开 LED 详情" onClick={onDetails}>
                详细调试 →
              </button>
            )}
          </div>
        </div>
      </div>
      {embedded && <small className="led-output-note">输出示意 · 非物理测量</small>}
    </section>
  )
}
