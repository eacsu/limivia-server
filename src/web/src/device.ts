export type LinkKind = 'usb' | 'ble' | 'ws' | 'mqtt'
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value }
export type Args = Record<string, Value>
export interface Parameter {
  name: string
  type: string
  required?: boolean
  min?: number | null
  max?: number | null
  values?: string
}
export interface Capability {
  kind: string
  available: boolean
  capacity: number
  pin_roles: string
  required_pins: string
  config: Parameter[]
  actions: { action: string; args: Parameter[]; payload?: boolean }[]
}
export interface Resource {
  id: number
  instance: number
  kind: string
  state: 'opening' | 'ready' | 'closing' | 'fault'
  parent: number
  pin_mask: number
  definition: Args
  driver_error: number
  cleanup_error: number
}
export interface Identity {
  board: string
  device_id: string
  boot_id: string
  build_id: string
  profile: string
  firmware: string
  protocol: number
  contract: string
  jsonrpc: string
  batch_max: number
}
export interface Operation {
  id: string
  op: string
  status: string
  request_id?: number
  job_id?: number
  boot_id: string
  device_id: string
  generation: number
  created: number
  updated: number
  result: Args | null
  error: Args | null
  job?: Args
  result_expired: boolean
  external_effect_possible: boolean
  parent: string | null
  progress?: { phase: string; bytes: number; total: number; sha256: string; upload_id?: number }
  cancel_requested?: boolean
}
export interface DeviceState {
  wiring_revision?: number
  wiring_bindings?: Record<string, import('./wiring').WiringBinding>
  status: string
  kind: LinkKind
  generation: number
  cursor: number
  identity: Identity | null
  discovery: {
    identity: Identity
    pins: { pin: number; digital: boolean; adc1: boolean; deep_sleep_wake: boolean }[]
    resources: Capability[]
    operations: { op: string; available: boolean; params: string }[]
    raw_pages: Value[]
  } | null
  snapshot: {
    revision: number
    epoch: number
    resources: Resource[]
    pages: { stopping: boolean; autostart_inhibited: boolean; owner_endpoint: number }[]
  } | null
  stale: boolean
  error: Value
  operation_epoch: number
  snapshot_sync: {
    state: 'current' | 'recovering' | 'unavailable'
    last_success_at: number | null
    error: Value
  }
  handles: Record<string, Record<string, Value>>
  resource_observations?: Record<
    string,
    {
      instance: number
      generation: number
      device_id: string
      boot_id: string
      observed_at: number
      quality: 'confirmed' | 'recovering' | 'unknown'
      level: 0 | 1 | null
    }
  >
  resource_values: Record<string, Args>
  samples: Record<string, Value[]>
  sampling: string[]
  resource_origin: Record<string, 'managed' | 'external'>
}
export interface CatalogItem {
  op: string
  group: string
  label: string
  fields: { name: string; required: boolean }[]
  observer: boolean
  internal: boolean
  confirmation: string | null
}
export interface Feed {
  type: string
  cursor: number
  data?: unknown
  operations?: Operation[]
}
export const initialState: DeviceState = {
  status: 'disconnected',
  kind: 'ble',
  generation: 0,
  cursor: 0,
  identity: null,
  discovery: null,
  snapshot: null,
  stale: true,
  error: null,
  operation_epoch: 0,
  snapshot_sync: { state: 'unavailable', last_success_at: null, error: null },
  handles: {},
  resource_origin: {},
  resource_values: {},
  samples: {},
  sampling: [],
}
// 实物接线图仅消费从资源快照派生的只读视图，不作为设备协议模型。
export type PinMode = string
export interface Snapshot {
  pins: { pin: number; mode: PinMode; level: number | null; quality?: string; role?: string }[]
  sessions: { active: boolean }[]
}
export interface Sample {
  instance: number
  sequence: number
  pin: number
  raw: number
  millivolts: number | null
  calibrated: boolean
  uptime_ms: number
}
export const PIN_NUMBERS = [0, 1, 3, 4, 5, 6, 7, 10, 13, 20, 21]
export const terminal = (t: Operation) =>
  ['completed', 'failed', 'cancelled', 'unknown'].includes(t.status)
export const phaseNames: Record<string, string> = {
  created: '准备提交',
  running: '执行中',
  submitted: '已提交',
  accepted: '设备已受理',
  completed: '操作完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '结果待核实',
}
export const kindNames: Record<string, string> = {
  gpio: 'GPIO',
  pwm: 'PWM',
  adc: 'ADC',
  timer: '板载定时',
  uart: 'UART 串口',
  temperature: '片内温度',
  'adc.continuous': '连续 ADC',
  'i2c.master': 'I²C 主总线',
  'i2c.device': 'I²C 子设备',
  'i2c.slave': 'I²C 从机',
  'spi.master': 'SPI 主总线',
  'spi.device': 'SPI 子设备',
  'spi.slave': 'SPI 从机',
  twai: 'TWAI / 经典 CAN',
  'rmt.tx': 'RMT 发射',
  'rmt.rx': 'RMT 接收',
  i2s: 'I²S',
  sigma_delta: 'Sigma-Delta',
}
export const friendlyError = (e: unknown) => (e instanceof Error ? e.message : String(e))
export function gpioObservation(state: DeviceState, resource?: Resource) {
  if (!resource || state.status !== 'ready' || state.stale || resource.state !== 'ready') return
  const value = state.resource_observations?.[resource.id]
  if (
    (value?.quality === 'confirmed' || value?.quality === 'recovering') &&
    value.instance === resource.instance &&
    value.generation === state.generation &&
    value.device_id === state.identity?.device_id &&
    value.boot_id === state.identity?.boot_id &&
    (value.level === 0 || value.level === 1)
  )
    return value
}
export function boardState(state: DeviceState): Snapshot {
  return {
    pins: PIN_NUMBERS.map((pin) => {
      const r = state.snapshot?.resources.find((r) => r.pin_mask & (2 ** pin))
      const role = Object.entries((r?.definition.pins as Args) ?? {}).find(
        ([, p]) => p === pin,
      )?.[0]
      const mode =
        r?.state === 'fault'
          ? 'fault'
          : r?.kind === 'gpio'
            ? String((r.definition.config as Args)?.mode ?? 'input')
            : (r?.kind ?? 'idle')
      return {
        pin,
        mode,
        role,
        quality: state.status !== 'ready' || state.stale ? 'unknown' : (r?.state ?? 'idle'),
        level: r?.kind === 'gpio' ? (gpioObservation(state, r)?.level ?? null) : null,
      }
    }),
    sessions: [{ active: state.status === 'ready' }],
  }
}
export function pinStateLabel(pin: Snapshot['pins'][number] | undefined, compact = false) {
  if (!pin || pin.mode === 'idle')
    return {
      short: pin?.quality === 'idle' ? (compact ? '闲' : '空闲') : '?',
      full: pin?.quality === 'idle' ? '空闲' : '状态待核实',
    }
  const gpio = ['input', 'output', 'open_drain'].includes(pin.mode)
  const names: Record<string, string> = {
    input: '数字输入',
    output: '数字输出',
    open_drain: '开漏输出',
    fault: '故障',
  }
  const shortNames: Record<string, string> = {
    input: compact ? '入' : '输入',
    output: compact ? '出' : '输出',
    open_drain: compact ? '漏' : '开漏',
    fault: '故障',
    uart: compact ? '串口' : 'UART',
    'adc.continuous': 'ADC',
    'i2c.master': 'I²C',
    'i2c.slave': 'I²C',
    'i2c.device': 'I²C',
    'spi.master': 'SPI',
    'spi.slave': 'SPI',
    'spi.device': 'SPI',
    'rmt.tx': 'RMT',
    'rmt.rx': 'RMT',
    sigma_delta: 'ΣΔ',
  }
  const unknown =
    pin.quality === 'unknown' || (pin.quality && !['ready', 'idle'].includes(pin.quality))
  const level = unknown ? null : pin.level
  return {
    short:
      (shortNames[pin.mode] ?? pin.mode.toUpperCase()) +
      (gpio ? (level ?? '?') : unknown ? '?' : ''),
    full: `${names[pin.mode] ?? kindNames[pin.mode] ?? pin.mode}${pin.role ? ` · ${pin.role}` : ''} · ${gpio ? (level === null ? '电平待核实' : `${level ? '高' : '低'}电平 ${level}`) : unknown ? '状态待核实' : '已配置'}`,
  }
}
export function decodeBinary(result: Args): Uint8Array {
  const text = String(result.data ?? '')
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  if (bytes.length !== result.length || btoa(String.fromCharCode(...bytes)) !== text)
    throw new Error('二进制结果长度或 Base64 不符合契约。')
  return bytes
}
export function adcSamples(result: Args, pin: number, instance: number): Sample[] {
  const events = Array.isArray(result.events) ? result.events : []
  return events.map((item) => {
    const e = item as Args
    const typed = typeof e.raw === 'number'
    const view = typed ? null : new DataView(decodeBinary({ length: 8, data: e.data }).buffer)
    const mv = typed ? e.millivolts : view!.getInt32(4, true)
    return {
      pin,
      instance,
      sequence: Number(e.sequence),
      raw: typed ? Number(e.raw) : view!.getInt32(0, true),
      millivolts: typeof mv === 'number' && mv >= 0 ? mv : null,
      calibrated: typeof mv === 'number' && mv >= 0,
      uptime_ms: Number(e.uptime_ms ?? Number(e.time_us ?? 0) / 1000),
    }
  })
}
export interface DeviceScope {
  generation?: number
  boot_id?: string
  operation_epoch?: number
}
class WorkbenchAPI {
  private scope: DeviceScope = {}
  deviceScope() {
    return { ...this.scope }
  }
  private token = ''
  private initializing: Promise<string> | null = null
  async session(): Promise<string> {
    if (this.initializing) return this.initializing
    this.initializing = (async () => {
      this.token = sessionStorage.getItem('limivia-page') ?? ''
      if (this.token) {
        const response = await fetch('/api/device', { headers: { 'x-page-session': this.token } })
        if (response.ok) return this.token
      }
      const r = await fetch('/api/pages', { method: 'POST' })
      if (!r.ok) throw new Error('无法建立工作台页面会话。')
      this.token = (await r.json()).page_session
      sessionStorage.setItem('limivia-page', this.token)
      return this.token
    })()
    try {
      return await this.initializing
    } finally {
      this.initializing = null
    }
  }
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!this.token) await this.session()
    const headers: Record<string, string> = { 'x-page-session': this.token }
    if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json'
    let r: Response
    try {
      r = await fetch(path, {
        method,
        headers,
        body:
          body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      })
    } catch {
      throw new Error(
        method === 'GET'
          ? '后端读取失败，请检查服务连接。'
          : '本次提交结果待核实，请恢复连接后查看操作记录，勿直接重发写操作。',
      )
    }
    if (!r.ok) {
      if (r.status === 401) {
        this.token = ''
        sessionStorage.removeItem('limivia-page')
      }
      let reason
      try {
        reason = (await r.json()).detail
      } catch {
        reason = r.statusText
      }
      throw new Error(
        reason?.reason === 'wiring_conflict'
          ? '方案版本冲突，另一页面已保存更新；本地修改已保留。'
          : typeof reason === 'string'
            ? reason
            : JSON.stringify(reason),
      )
    }
    return r.json()
  }
  submit(op: string, args: Args = {}, scope: DeviceScope = this.scope) {
    return this.request<Operation>('/api/device/operations', 'POST', {
      op,
      args,
      ...scope,
    })
  }
  async wait(task: Operation): Promise<Operation> {
    let current = task
    while (!terminal(current)) {
      await new Promise((r) => setTimeout(r, 150))
      current = await this.request<Operation>('/api/operations/' + task.id)
    }
    if (current.status !== 'completed' || current.result_expired)
      throw new Error(
        [current.error?.reason, current.error?.message ?? '执行结果未确认或已过期，请先查询状态。']
          .filter(Boolean)
          .join(' · '),
      )
    return current
  }
  async run(op: string, args: Args = {}, scope: DeviceScope = this.scope) {
    return this.wait(await this.submit(op, args, scope))
  }
  async upload(file: File, name: string, secret = false, profile?: string) {
    const data = new FormData()
    data.append('file', file)
    const url =
      profile === undefined
        ? `/api/device/files/upload?name=${encodeURIComponent(name)}&secret=${secret}`
        : `/api/device/ota/upload?profile=${encodeURIComponent(profile)}`
    const scope = this.deviceScope()
    const scoped =
      scope.generation === undefined
        ? url
        : `${url}&generation=${scope.generation}&boot_id=${encodeURIComponent(scope.boot_id ?? '')}&operation_epoch=${scope.operation_epoch}`
    return this.request<Operation>(scoped, 'POST', data)
  }
  async download(name: string) {
    if (!this.token) await this.session()
    const r = await fetch(`/api/device/files/${encodeURIComponent(name)}/download`, {
      headers: { 'x-page-session': this.token },
    })
    if (!r.ok) throw new Error('下载失败，请核对文件是否存在或属于秘密文件。')
    saveBlob(await r.blob(), name)
  }
  subscribe(onFeed: (feed: Feed) => void, onConnection: (online: boolean) => void) {
    let disposed = false
    let socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let ping: ReturnType<typeof setInterval> | undefined
    const open = async () => {
      try {
        const page = await this.session()
        if (disposed) return
        socket = new WebSocket(
          `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/device/events`,
        )
        socket.onopen = () => {
          socket!.send(JSON.stringify({ page_session: page }))
          socket!.send(
            JSON.stringify({ type: 'observe', visible: document.visibilityState === 'visible' }),
          )
          onConnection(true)
          ping = setInterval(() => {
            if (socket?.readyState === 1) socket.send('ping')
          }, 20000)
        }
        socket.onmessage = (e) => {
          const feed = JSON.parse(e.data)
          if (feed.type === 'snapshot' && feed.data.identity)
            this.scope = {
              generation: feed.data.generation,
              boot_id: feed.data.identity.boot_id,
              operation_epoch: feed.data.operation_epoch,
            }
          onFeed(feed)
          if (feed.type === 'wiring.changed')
            window.dispatchEvent(new CustomEvent('wiring-changed', { detail: feed.data }))
          if (feed.type === 'snapshot')
            window.dispatchEvent(
              new CustomEvent('wiring-changed', {
                detail: { ...feed.data.identity, revision: feed.data.wiring_revision },
              }),
            )
        }
        socket.onclose = () => {
          clearInterval(ping)
          onConnection(false)
          if (!disposed) timer = setTimeout(open, 1500)
        }
      } catch {
        onConnection(false)
        if (!disposed) timer = setTimeout(open, 3000)
      }
    }
    const visibility = () => {
      if (socket?.readyState === 1)
        socket.send(
          JSON.stringify({ type: 'observe', visible: document.visibilityState === 'visible' }),
        )
    }
    document.addEventListener('visibilitychange', visibility)
    void open()
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', visibility)
      clearTimeout(timer)
      clearInterval(ping)
      socket?.close()
    }
  }
}
export const api = new WorkbenchAPI()
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const kindDescriptions: Record<string, string> = {
  gpio: '方向、电平、上下拉与事件',
  pwm: '占空比、渐变与周期呼吸',
  adc: '单次与周期采样',
  'adc.continuous': '带通道标签的连续采样',
  uart: '文本与二进制收发',
  'i2c.master': '总线配置、探测与扫描',
  'i2c.device': '子设备地址与读写事务',
  'i2c.slave': '从机预载、队列与事件',
  'spi.master': '共享总线配置',
  'spi.device': '片选、传输与结果',
  'spi.slave': '从机事务队列',
  twai: '经典 CAN 帧与错误',
  'rmt.tx': '符号发射与同步',
  'rmt.rx': '捕获与原始符号',
  i2s: '音频/PDM 原始数据',
  sigma_delta: '密度调制',
  timer: '电平时序与有限/无限循环',
  temperature: '片内温度采集',
}
export const actionNames: Record<string, string> = {
  status: '读取状态',
  read: '读取',
  write: '写入',
  events: '读取事件队列',
  duty: '更新占空比',
  fade: '渐变',
  probe: '探测地址',
  scan: '扫描总线',
  recover: '恢复总线',
  write_read: '写后读',
  preload: '预载',
  clear_tx: '清空发送',
  transfer: '传输',
  queue: '排入事务',
  fetch: '取回结果',
  send: '发送',
  receive: '接收',
  clear: '清空',
  errors: '读取错误',
  transmit: '发射',
  capture: '捕获',
  result: '取回捕获',
  play: '播放',
  record: '采集',
  stop: '停止',
  start: '启动',
  drain: '排空',
  abort: '中止',
  density: '更新密度',
  break: '发送 Break',
}
