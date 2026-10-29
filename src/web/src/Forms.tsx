import { useState, type ReactNode } from 'react'
import {
  friendlyError,
  type Args,
  type Value,
  type Parameter,
  decodeBinary,
  saveBlob,
} from './device'
import { label, enumLabels } from './fieldLabels'
import { numericBound, parameterOptions, parameterRange } from './parameters'
export function Action({
  children,
  run,
  disabled = false,
  primary = false,
  onError,
  keepLabelWhileBusy = false,
}: {
  children: ReactNode
  run: () => Promise<unknown>
  disabled?: boolean
  primary?: boolean
  onError?: (message: string) => void
  keepLabelWhileBusy?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <span className="action-wrap">
      <button
        type="button"
        className={`${primary ? 'primary' : ''}${busy && keepLabelWhileBusy ? ' busy-stable' : ''}`}
        aria-busy={busy}
        disabled={disabled || busy}
        onClick={async (event) => {
          const form = event.currentTarget.closest('form')
          if (form && !form.reportValidity()) return
          setBusy(true)
          setError('')
          try {
            await run()
          } catch (e) {
            const message = friendlyError(e)
            if (onError) onError(message)
            else setError(message)
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy && !keepLabelWhileBusy ? '提交中…' : children}
      </button>
      {error && (
        <span className="inline-error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}
export function ObjectEditor({
  value,
  onChange,
  depth = 0,
}: {
  value: Value
  onChange: (v: Value) => void
  depth?: number
}) {
  const [newKey, setNewKey] = useState('')
  if (depth > 8) return <p>对象嵌套超过编辑深度，请通过文件导入。</p>
  if (value !== null && typeof value === 'object') {
    const array = Array.isArray(value)
    const entries = Object.entries(value)
    return (
      <div className="object-editor">
        {entries.map(([key, item]) => (
          <div className="object-row" key={key}>
            <span>{array ? Number(key) + 1 : key}</span>
            <ObjectEditor
              value={item}
              depth={depth + 1}
              onChange={(v) => {
                const next = array ? [...value] : { ...value }
                ;(next as Record<string, Value>)[key] = v
                onChange(next)
              }}
            />
            <button
              type="button"
              aria-label={'移除 ' + key}
              onClick={() => {
                if (array) onChange(value.filter((_, i) => i !== Number(key)))
                else {
                  const next = { ...value }
                  delete next[key]
                  onChange(next)
                }
              }}
            >
              −
            </button>
          </div>
        ))}
        <div className="row">
          {!array && (
            <input
              aria-label="新增字段名称"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="字段名"
            />
          )}
          <select
            aria-label="新增值类型"
            onChange={(e) => {
              const v: Value =
                e.target.value === 'object'
                  ? {}
                  : e.target.value === 'array'
                    ? []
                    : e.target.value === 'number'
                      ? 0
                      : e.target.value === 'bool'
                        ? false
                        : ''
              if (array) onChange([...value, v])
              else if (newKey && !(newKey in value)) {
                onChange({ ...value, [newKey]: v })
                setNewKey('')
              }
              e.target.value = ''
            }}
            defaultValue=""
          >
            <option value="" disabled>
              添加{array ? '一项' : '字段'}…
            </option>
            <option value="string">文本</option>
            <option value="number">数值</option>
            <option value="bool">布尔</option>
            <option value="object">对象 / 引用</option>
            <option value="array">列表</option>
          </select>
        </div>
      </div>
    )
  }
  if (typeof value === 'boolean')
    return (
      <select
        aria-label="布尔值"
        value={String(value)}
        onChange={(e) => onChange(e.target.value === 'true')}
      >
        <option value="false">关闭</option>
        <option value="true">开启</option>
      </select>
    )
  return (
    <input
      aria-label="字段值"
      type={typeof value === 'number' ? 'number' : 'text'}
      step="any"
      value={value ?? ''}
      onChange={(e) =>
        onChange(typeof value === 'number' ? Number(e.target.value) : e.target.value)
      }
    />
  )
}
export function BinaryField({
  value,
  onChange,
}: {
  value: Value | undefined
  onChange: (v: Value) => void
}) {
  const data = (
    typeof value === 'object' && value && !Array.isArray(value)
      ? value
      : { encoding: 'text', value: typeof value === 'string' ? value : '' }
  ) as Args
  return (
    <div className="binary-editor">
      <select
        aria-label="输入编码"
        value={String(data.encoding)}
        onChange={(e) => onChange({ ...data, encoding: e.target.value })}
      >
        <option value="text">UTF-8 文本</option>
        <option value="hex">HEX</option>
        <option value="base64">Base64</option>
      </select>
      <textarea
        aria-label="数据内容"
        value={String(data.value ?? '')}
        onChange={(e) => onChange({ ...data, value: e.target.value })}
      />
      <small>不自动拆分单次外部事务；较大载荷请显式使用缓存。</small>
    </div>
  )
}
export function Fields({
  fields,
  value,
  onChange,
}: {
  fields: Parameter[]
  value: Args
  onChange: (v: Args) => void
}) {
  return (
    <div className="fields">
      {fields.map((field) => {
        const name = field.name
        const v = value[name]
        const update = (item: Value) => onChange({ ...value, [name]: item })
        const options = parameterOptions(field)
        const range = parameterRange(field)
        const numeric = /int|float|number|u\d|i\d/.test(field.type)
        const bool = /bool/.test(field.type)
        return (
          <div
            className={'field ' + (/data|value|args|json|resources|will/.test(name) ? 'wide' : '')}
            key={name}
          >
            <span>
              {label(name)}
              {field.required ? ' *' : ''}
            </span>
            {['data', 'will'].includes(name) ? (
              <BinaryField value={v} onChange={update} />
            ) : ['object', 'array', 'json'].includes(field.type) ||
              ['args', 'json', 'value', 'resources'].includes(name) ? (
              <ObjectEditor value={v ?? (name === 'resources' ? [] : {})} onChange={update} />
            ) : bool ? (
              <select
                aria-label={label(name) + (field.required ? ' *' : '')}
                value={v === undefined ? '' : String(v)}
                onChange={(e) => {
                  if (e.target.value === '') {
                    const next = { ...value }
                    delete next[name]
                    onChange(next)
                  } else update(e.target.value === 'true')
                }}
                required={field.required}
              >
                <option value="">使用设备默认值</option>
                <option value="false">关闭</option>
                <option value="true">开启</option>
              </select>
            ) : options.length ? (
              <select
                aria-label={label(name) + (field.required ? ' *' : '')}
                value={String(v ?? '')}
                required={field.required}
                onChange={(e) => update(numeric ? Number(e.target.value) : e.target.value)}
              >
                <option value="">请选择</option>
                {options.map((item) => (
                  <option key={item} value={item}>
                    {enumLabels[item] ?? item}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label={label(name) + (field.required ? ' *' : '')}
                type={/password|key|pmk/.test(name) ? 'password' : numeric ? 'number' : 'text'}
                step={/float|number/.test(field.type) ? 'any' : 1}
                min={numericBound(field.min)}
                max={numericBound(field.max)}
                required={field.required}
                autoComplete={/password|key/.test(name) ? 'new-password' : 'off'}
                value={String(v ?? '')}
                onChange={(e) => {
                  if (!e.target.value && !field.required) {
                    const next = { ...value }
                    delete next[name]
                    onChange(next)
                  } else update(numeric ? Number(e.target.value) : e.target.value)
                }}
              />
            )}
            {range && <small>{range}</small>}
          </div>
        )
      })}
    </div>
  )
}
const stateLabels: Record<string, string> = {
  loaded: '已加载',
  running: '运行中',
  paused: '已暂停',
  stopping: '正在清理',
  stopped: '已停止',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  accepted: '已受理',
  ready: '就绪',
  opening: '正在创建',
  closing: '正在关闭',
  fault: '故障 · 仍占用资源',
  queued: '本地已入队（非应用确认）',
  light: '浅睡眠',
  deep: '深睡眠',
}
function ReadValue({
  value,
  depth = 0,
  name = '',
}: {
  value: Value
  depth?: number
  name?: string
}) {
  if (value === null) return <span>{name === 'millivolts' ? '未校准' : '未提供'}</span>
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>
  if (typeof value === 'string' || typeof value === 'number')
    return (
      <span>
        {typeof value === 'string' && ['state', 'delivery', 'mode'].includes(name)
          ? (stateLabels[value] ?? value)
          : value}
      </span>
    )
  if (depth > 3) return <span>请查看结构化详情</span>
  if (Array.isArray(value))
    return (
      <div className="read-array">
        {value.length === 0 ? (
          <span>暂无记录</span>
        ) : (
          value.slice(0, 24).map((item, i) => (
            <div key={i}>
              <small>#{i + 1}</small>
              <ReadValue value={item} depth={depth + 1} />
            </div>
          ))
        )}
        {value.length > 24 && (
          <small>显示前 24 条，共 {value.length} 条；完整结果见详情或下载。</small>
        )}
      </div>
    )
  return (
    <dl className="result-fields">
      {Object.entries(value)
        .filter(([key]) => key !== 'data')
        .map(([key, item]) => (
          <div key={key}>
            <dt>{label(key)}</dt>
            <dd>
              <ReadValue value={item} name={key} depth={depth + 1} />
            </dd>
          </div>
        ))}
    </dl>
  )
}
export function Result({ value, format }: { value: unknown; format?: string }) {
  if (value === null || value === undefined) return <p className="muted">暂无确认结果。</p>
  const object = value as Args
  let binary: Uint8Array | undefined
  let error = ''
  let text = ''
  let records: Args[] = []
  if (
    typeof object === 'object' &&
    typeof object.data === 'string' &&
    typeof object.length === 'number'
  ) {
    try {
      binary = decodeBinary(object)
      if (!format || ['uart', 'gpio'].includes(format)) {
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(binary)
        } catch {
          text = '不可解码为 UTF-8，保留 HEX 和原始字节。'
        }
      }
      if (['adc.continuous', 'rmt.tx', 'rmt.rx'].includes(format ?? '')) {
        if (binary.length % 4) throw new Error('数据长度不是完整 32 位记录，请以原始 HEX 核对。')
        const view = new DataView(binary.buffer)
        records = Array.from({ length: Math.min(binary.length / 4, 64) }, (_, i): Args => {
          const word = view.getUint32(i * 4, true)
          return format === 'adc.continuous'
            ? { channel: (word >>> 13) & 7, unit: (word >>> 16) & 1, raw: word & 4095 }
            : {
                duration0: word & 32767,
                level0: (word >>> 15) & 1,
                duration1: (word >>> 16) & 32767,
                level1: word >>> 31,
              }
        })
      }
    } catch (e) {
      error = friendlyError(e)
    }
  }
  return (
    <div className="result">
      {typeof object === 'object' && Object.keys(object).length === 0 ? (
        <p>设备已确认此操作，无附加结果。</p>
      ) : (
        <ReadValue value={value as Value} />
      )}
      {binary && (
        <>
          <p>
            {binary.length} 字节{text ? ' · ' + text : ''}
            {format === 'i2s' ? ' · 原始 I²S / PDM 字节，按资源位宽、通道与采样率解释' : ''}
          </p>
          {records.length > 0 && (
            <>
              <p>
                {format === 'adc.continuous'
                  ? 'ADC type2 · 小端 32 位通道/单元标签，raw 无校准电压单位'
                  : 'RMT 符号 · duration 为配置时钟计数（ticks）'}
              </p>
              <ReadValue value={records} />
            </>
          )}
          <details>
            <summary>HEX 数据</summary>
            <pre>{Array.from(binary, (x) => x.toString(16).padStart(2, '0')).join(' ')}</pre>
          </details>
          <button onClick={() => saveBlob(new Blob([binary!.slice().buffer]), 'result.bin')}>
            下载原始数据
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>结构化详情</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
        <button
          onClick={() =>
            saveBlob(
              new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
              'result.json',
            )
          }
        >
          导出完整结果
        </button>
      </details>
    </div>
  )
}
