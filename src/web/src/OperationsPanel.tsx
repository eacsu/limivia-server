import { useState } from 'react'
import { api, type Args, type CatalogItem, type DeviceState, type Parameter } from './device'
import { Action, Fields, Result } from './Forms'
const numeric = new Set([
  'resource',
  'job_id',
  'buffer_id',
  'flow_id',
  'upload_id',
  'offset',
  'length',
  'size',
  'page',
  'revision',
  'limit_bytes',
  'duration_ms',
  'timeout_ms',
  'wake_pin',
  'wake_level',
  'qos',
  'will_qos',
  'protocol',
])
const boolean = new Set([
  'persist',
  'enable',
  'retain',
  'will_retain',
  'encrypt',
  'auto_light_sleep',
  'secret',
  'reboot',
  'cascade',
])
const object = new Set(['args', 'pins', 'config', 'json', 'value'])
function operationFields(item: CatalogItem): Parameter[] {
  return item.fields.map((field) => ({
    ...field,
    type: numeric.has(field.name)
      ? 'integer'
      : boolean.has(field.name)
        ? 'bool'
        : object.has(field.name)
          ? 'object'
          : ['resources', 'topics'].includes(field.name)
            ? 'array'
            : 'string',
    ...(['offset', 'page'].includes(field.name) ? { min: 0 } : {}),
    ...(field.name === 'mode' ? { values: 'light,deep' } : {}),
    ...(field.name === 'modem_sleep' ? { values: 'none,min,max' } : {}),
    ...(field.name === 'protocol' && item.op === 'mqtt.configure'
      ? { type: 'string', values: '3.1.1,5.0' }
      : {}),
  }))
}
export function OperationsPanel({
  state,
  enabled,
  catalog,
  groups,
  title,
}: {
  state: DeviceState
  enabled: boolean
  catalog: CatalogItem[]
  groups: string[]
  title: string
}) {
  const choices = catalog.filter((item) => !item.internal && groups.includes(item.op.split('.')[0]))
  const [selected, setSelected] = useState('')
  const item = choices.find((x) => x.op === selected) ?? choices[0]
  return (
    <>
      <div className="page-heading">
        <h1>{title}</h1>
        <span>按本次能力发现展示</span>
      </div>
      <div className="notice">
        {title === '联网通信'
          ? '这里配置板上 Wi-Fi、MQTT 和 ESP-NOW，与服务主机连接参数相互独立。密码与密钥仅写入，不回显。'
          : '设备状态、低功耗与清理错误由设备报告；没有仪器数据时不显示功耗测量值。'}
      </div>
      <div className="split">
        <section>
          <h2>业务操作</h2>
          <label className="field">
            选择功能
            <select value={item?.op ?? ''} onChange={(e) => setSelected(e.target.value)}>
              {choices.map((c) => (
                <option key={c.op} value={c.op}>
                  {c.group} · {c.label}
                </option>
              ))}
            </select>
          </label>
          {item ? (
            <OperationForm key={item.op} item={item} state={state} enabled={enabled} />
          ) : (
            <p>连接设备并读取能力后显示操作。</p>
          )}
        </section>
        <aside>
          <h2>操作含义</h2>
          <p>MQTT 的 queued 是本地入队；ESP-NOW 的 MAC ACK 不是远端应用确认。</p>
          <p>
            维护 AP 可能暂停
            MQTT/ESP-NOW；网络重配置、重启和睡眠可能中断当前连接。恢复后需要重新选择目标。
          </p>
          <p>自动浅睡眠默认关闭。OTA 提交默认不重启；上传完成不代表新固件运行成功。</p>
          <details>
            <summary>缓存句柄（仅当前 boot）</summary>
            <Result value={state.handles} />
          </details>
        </aside>
      </div>
    </>
  )
}
export function OperationForm({
  item,
  state,
  enabled,
}: {
  item: CatalogItem
  state: DeviceState
  enabled: boolean
}) {
  const [args, setArgs] = useState<Args>(() =>
    Object.fromEntries(
      operationFields(item)
        .filter((field) => field.required && ['object', 'array', 'json'].includes(field.type))
        .map((field) => [field.name, field.type === 'array' ? [] : {}]),
    ),
  )
  const [result, setResult] = useState<unknown>(null)
  const cap = state.discovery?.operations.find((x) => x.op === item.op)
  const available = cap?.available === true
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <p className="muted">
        {item.group} · {item.op}
      </p>
      {!available && <p>当前发现结果未确认此功能可用，请重新读取能力或切换支持的镜像。</p>}
      <Fields
        fields={operationFields(item).filter((field) => !item.confirmation || field.name !== 'confirm')}
        value={args}
        onChange={setArgs}
      />
      <Action
        primary
        disabled={!available || (!item.observer && !enabled)}
        run={async () => {
          const task = await api.run(
            item.op,
            item.confirmation ? { ...args, confirm: item.confirmation } : args,
          )
          setResult(task.result ?? task.job)
        }}
      >
        {item.label}
      </Action>
      <Result value={result} />
      {cap && <small>设备描述：{cap.params}</small>}
    </form>
  )
}
export function FilesPanel({
  state,
  enabled,
  catalog,
}: {
  state: DeviceState
  enabled: boolean
  catalog: CatalogItem[]
}) {
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [secret, setSecret] = useState(false)
  const [result, setResult] = useState<unknown>(null)
  const [advanced, setAdvanced] = useState(false)
  return (
    <>
      <div className="page-heading">
        <h1>板上文件</h1>
        <span>原子上传 · SHA256 校验</span>
      </div>
      <div className="split">
        <section>
          <h2>上传文件</h2>
          <div className="fields">
            <label className="field">
              选择文件
              <input
                type="file"
                onChange={(e) => {
                  const selected = e.target.files?.[0] ?? null
                  setFile(selected)
                  setName(selected?.name ?? '')
                }}
              />
            </label>
            <label className="field">
              板端文件名
              <input
                maxLength={48}
                pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={secret}
                onChange={(e) => setSecret(e.target.checked)}
              />
              秘密文件（不可列出或读回）
            </label>
          </div>
          <Action
            primary
            disabled={!enabled || !file || !name}
            run={async () => {
              const task = await api.upload(file!, name, secret)
              setResult(task)
            }}
          >
            开始上传
          </Action>
          <p>
            字节上传完成后仍需等待校验与提交；进度在操作记录中持续显示。初始化异常不会自动格式化。
          </p>
          <hr />
          <h2>文件列表与下载</h2>
          <div className="row">
            <Action
              disabled={!enabled}
              run={async () => setResult((await api.run('storage.list', { page: 0 })).result)}
            >
              读取文件列表
            </Action>
            <Action disabled={!enabled || !name || secret} run={() => api.download(name)}>
              下载指定文件
            </Action>
          </div>
          <Result value={result} />
          <button className="text-button" onClick={() => setAdvanced(!advanced)}>
            {advanced ? '收起' : '打开'}文件操作
          </button>
          {advanced && (
            <OperationsPanel
              title="文件操作"
              state={state}
              enabled={enabled}
              catalog={catalog}
              groups={['storage']}
            />
          )}
        </section>
        <aside>
          <h2>文件边界</h2>
          <p>文件名最多 48 个 ASCII 字符，不含目录或前导点。</p>
          <p>JSON record 原子替换，JSONL append 达到上限时明确失败，不自动丢弃旧记录。</p>
          <p>上传失败仅尝试中止本任务自己的上传；结果未知时先核对，不重发原写入。</p>
        </aside>
      </div>
    </>
  )
}

export function NetworkPanel({
  state,
  enabled,
  catalog,
}: {
  state: DeviceState
  enabled: boolean
  catalog: CatalogItem[]
}) {
  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [persist, setPersist] = useState(false)
  const [wifi, setWifi] = useState<unknown>(null)
  const [esp, setEsp] = useState<unknown>(null)
  const [advanced, setAdvanced] = useState(false)
  const supports = (op: string) =>
    state.discovery?.operations.some((item) => item.op === op && item.available) ?? false
  return (
    <>
      <div className="page-heading">
        <h1>联网通信</h1>
        <span>当前固件 · {state.identity?.profile ?? '待识别'}</span>
      </div>
      <div className="toolbar">
        <span>按本次能力发现展示</span>
        <small>通信能力来自当前固件</small>
      </div>
      <div className="notice">
        <strong>板端网络与连接传输相互独立</strong>
        <p>
          当前平台通过 {state.kind.toUpperCase()} 连接板卡。这里配置板上 Wi-Fi 和
          ESP-NOW，不会更改服务主机的连接参数。
        </p>
      </div>
      <div className="network-columns">
        <section>
          <h2>板上 Wi-Fi</h2>
          <p className="muted">
            {supports('wifi.configure')
              ? '请查询设备确认当前网络状态。'
              : '当前发现结果未提供板上 Wi-Fi 配置。'}
          </p>
          <form onSubmit={(e) => e.preventDefault()}>
            <label className="field">
              网络名称
              <input
                autoComplete="off"
                value={ssid}
                placeholder="输入 SSID"
                onChange={(e) => setSsid(e.target.value)}
              />
            </label>
            <label className="field">
              新密码
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                placeholder="输入密码（仅写入）"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <small>密码不会读回或出现在操作记录中；空密码仅用于你确认的开放网络。</small>
            <label className="check">
              <input
                type="checkbox"
                checked={persist}
                onChange={(e) => setPersist(e.target.checked)}
              />
              保存到板端（默认仅当前启动有效）
            </label>
            <div className="row">
              <Action
                primary
                disabled={!enabled || !ssid || !supports('wifi.configure')}
                run={async () => {
                  const result = await api.run('wifi.configure', { ssid, password, persist })
                  setPassword('')
                  setWifi(result.result)
                }}
              >
                保存并连接
              </Action>
              <Action
                disabled={!enabled || !supports('wifi.status')}
                run={async () => setWifi((await api.run('wifi.status')).result)}
              >
                查询网络状态
              </Action>
              <Action
                disabled={!enabled || !supports('wifi.scan')}
                run={async () => setWifi((await api.run('wifi.scan')).result)}
              >
                扫描 Wi-Fi
              </Action>
            </div>
          </form>
          <Result value={wifi} />
        </section>
        <aside>
          <h2>ESP-NOW</h2>
          <p className="muted">
            {supports('espnow.start') ? '节点由你显式配置。' : '当前发现结果未提供 ESP-NOW。'}
          </p>
          <dl>
            <dt>节点</dt>
            <dd>请查询设备状态核实</dd>
            <dt>接收数据</dt>
            <dd>显式读取队列后显示</dd>
          </dl>
          <div className="row">
            <Action
              primary
              disabled={!enabled || !supports('espnow.start')}
              run={async () => setEsp((await api.run('espnow.start')).result)}
            >
              启动 ESP-NOW
            </Action>
            <Action
              disabled={!enabled || !supports('espnow.status')}
              run={async () => setEsp((await api.run('espnow.status')).result)}
            >
              读取状态
            </Action>
          </div>
          <p>MAC ACK 不等于应用确认；广播不能证明接收节点存在。</p>
          <Result value={esp} />
        </aside>
      </div>
      <button className="text-button" onClick={() => setAdvanced(!advanced)}>
        {advanced ? '收起' : '展开'} MQTT、对端、发送与接收配置
      </button>
      {advanced && (
        <OperationsPanel
          title="网络高级操作"
          state={state}
          enabled={enabled}
          catalog={catalog}
          groups={['wifi', 'mqtt', 'espnow']}
        />
      )}
    </>
  )
}
