import { useId } from 'react'
import type { Args, Parameter, Value } from './device'
import { Fields } from './Forms'
import { enumLabels, label } from './fieldLabels'
import { numericBound, parameterOptions } from './parameters'

type Choice = { value: Value | undefined; text: string }

export function CycleField({
  field,
  value,
  choices,
  onChange,
  inherited,
  title,
}: {
  field: Parameter
  value: Value | undefined
  choices: Choice[]
  onChange: (value: Value | undefined) => void
  inherited?: Value
  title?: string
}) {
  const id = useId()
  const effective = value === undefined && inherited !== undefined ? inherited : value
  const index = choices.findIndex((choice) => choice.value === effective)
  const current = index >= 0 ? choices[index].text : String(effective)
  const next = choices[(index + 1) % choices.length]
  const name = title ?? label(field.name)
  return (
    <div className="field cycle-field">
      <span id={id}>
        {name}
        {field.required ? ' *' : ''}
      </span>
      <button
        type="button"
        className="cycle-control"
        aria-label={`${name}：${current}，点击切换`}
        aria-describedby={id}
        title={`下一项：${next.text}`}
        onClick={() => onChange(next.value)}
      >
        <span>
          {current}
          {value === undefined && inherited !== undefined ? '（设备默认）' : ''}
        </span>
      </button>
    </div>
  )
}

export function DutyField({
  field,
  value,
  onChange,
}: {
  field: Parameter
  value: Value | undefined
  onChange: (value: Value | undefined) => void
}) {
  const id = useId()
  const min = numericBound(field.min) ?? 0
  const max = numericBound(field.max) ?? 100
  const number = typeof value === 'number' && Number.isFinite(value) ? value : undefined
  return (
    <div className="field duty-field">
      <span id={id}>占空比（%）{field.required ? ' *' : ''}</span>
      <div className="range-value-row">
        <input
          className="duty-slider"
          type="range"
          aria-label="占空比滑杆"
          aria-describedby={id}
          aria-valuetext={number === undefined ? '设备默认' : `${number}%`}
          min={min}
          max={max}
          step="any"
          value={number ?? min}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <input
          type="number"
          aria-label={`占空比（%）${field.required ? ' *' : ''}`}
          min={min}
          max={max}
          step="any"
          required={field.required}
          placeholder="设备默认"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </div>
      <div className="range-endpoints" aria-hidden="true">
        <span>{min}%</span>
        <span>{max}%</span>
      </div>
    </div>
  )
}

export function SimpleConfig({
  kind,
  fields,
  value,
  onChange,
  initialLevelInAdvanced = false,
}: {
  kind: 'gpio' | 'pwm'
  fields: Parameter[]
  value: Args
  onChange: (value: Args) => void
  initialLevelInAdvanced?: boolean
}) {
  const mode = typeof value.mode === 'string' ? value.mode : 'input'
  const basics = (
    kind === 'pwm'
      ? ['duty', 'frequency']
      : [
          'mode',
          ...(mode === 'input' ? ['pull'] : mode === 'open_drain' ? ['level', 'pull'] : ['level']),
        ]
  ).filter((name) => !(initialLevelInAdvanced && name === 'level'))
  const hidden = kind === 'gpio' && mode === 'input' ? ['level', 'drive'] : []
  const advanced = fields.filter(
    (field) => !basics.includes(field.name) && !hidden.includes(field.name),
  )
  const set = (name: string, item: Value | undefined) => {
    const next = { ...value }
    if (item === undefined) delete next[name]
    else next[name] = item
    onChange(next)
  }
  const render = (field: Parameter, basic = false) => {
    const options = parameterOptions(field)
    const bool = /bool/.test(field.type)
    const bit = ['level', 'end_level'].includes(field.name)
    const drive = field.name === 'drive' && field.min === 0 && field.max === 3
    let choices: Choice[] = []
    if (bool)
      choices = [
        { value: false, text: '关闭' },
        { value: true, text: '开启' },
      ]
    else if (bit)
      choices = [
        { value: 0, text: '低电平 0' },
        { value: 1, text: '高电平 1' },
      ]
    else if (drive) choices = [0, 1, 2, 3].map((value) => ({ value, text: `档位 ${value}` }))
    else if (options.length && options.length <= 4)
      choices = options.map((option) => ({
        value: /int|float|number/.test(field.type) ? Number(option) : option,
        text:
          ({ rising: '上升沿', falling: '下降沿', any: '任意边沿' } as Record<string, string>)[
            option
          ] ??
          enumLabels[option] ??
          option,
      }))
    if (kind === 'pwm' && field.name === 'duty')
      return (
        <DutyField
          key={field.name}
          field={field}
          value={value[field.name]}
          onChange={(item) => set(field.name, item)}
        />
      )
    if (choices.length) {
      if (!basic && !field.required && !(initialLevelInAdvanced && field.name === 'level'))
        choices = [{ value: undefined, text: '设备默认' }, ...choices]
      return (
        <CycleField
          key={field.name}
          field={field}
          value={value[field.name]}
          choices={choices}
          inherited={
            basic || (initialLevelInAdvanced && field.name === 'level')
              ? ({ mode: 'input', pull: 'none', level: 0 } as Args)[field.name]
              : undefined
          }
          title={field.name === 'level' ? '初始电平' : undefined}
          onChange={(item) => set(field.name, item)}
        />
      )
    }
    return <Fields key={field.name} fields={[field]} value={value} onChange={onChange} />
  }
  const count = advanced.filter(
    (field) =>
      value[field.name] !== undefined &&
      !(initialLevelInAdvanced && field.name === 'level' && value.level === 1),
  ).length
  return (
    <div className="simple-config">
      <p className="config-button-hint">点击按钮切换</p>
      {basics.flatMap((name) => {
        const field = fields.find((f) => f.name === name)
        return field ? [render(field, true)] : []
      })}
      {advanced.length > 0 && (
        <details className="advanced-config">
          <summary>高级设置{count ? ` · ${count} 项已设置` : ''}</summary>
          <div className="advanced-config-body">
            {advanced
              .filter(
                (field) =>
                  field.name !== 'debounce_us' ||
                  (typeof value.edge === 'string' && value.edge !== 'none'),
              )
              .map((field) => render(field))}
          </div>
        </details>
      )}
    </div>
  )
}
