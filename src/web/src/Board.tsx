import { useEffect, useId, useRef, useState } from 'react'
import { pinStateLabel, type Snapshot } from './device'
import { BOARD_PINS, displaySide, type BoardFace, type BoardPin } from './board'
import { PinStateIcon } from './PinStateIcon'
import { pinStateGlyph, type PinGlyph } from './pinState'
import ledMarkLight from './assets/figma/pin-state/led-mark-vallum.svg'
import ledMarkDark from './assets/figma/pin-state/led-mark-abyssus.svg'
import d5Light from './assets/figma/pin-state/board-d5-vallum.svg'
import d5Dark from './assets/figma/pin-state/board-d5-abyssus.svg'
import d4Light from './assets/figma/pin-state/board-d4-vallum.svg'
import d4Dark from './assets/figma/pin-state/board-d4-abyssus.svg'
import antenna from './assets/figma/compact-antenna.svg'
import antennaNarrow from './assets/figma/compact-antenna-narrow.svg'

export function Board({
  state,
  selected,
  ready,
  onSelectPin,
  highlighted = [],
  pinLabels = {},
  embedded = false,
  physicalHighlights = [],
  physicalLabels = {},
  onCloseDiagram,
  onInternal,
  selectedStatus,
}: {
  state: Snapshot | null
  selected: number
  ready: boolean
  onSelectPin?: (pin: BoardPin) => void
  highlighted?: number[]
  pinLabels?: Record<number, string>
  physicalHighlights?: string[]
  physicalLabels?: Record<string, string>
  embedded?: boolean
  onCloseDiagram?: () => void
  onInternal?: () => void
  selectedStatus?: string
}) {
  const [face, setFace] = useState<BoardFace>('front')
  const [inspected, setInspected] = useState<BoardPin | null>(null)
  const [previousSelected, setPreviousSelected] = useState(selected)
  if (selected !== previousSelected) {
    setPreviousSelected(selected)
    setInspected(null)
  }
  const [size, setSize] = useState({ short: false, narrow: false })
  const viewport = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const help = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLDialogElement>(null)
  const boardId = useId().replace(/:/g, '')
  const detail = inspected ?? BOARD_PINS.find((p) => p.gpio === selected) ?? BOARD_PINS[0]
  const front = face === 'front'
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0)
        setSize({ short: height < 480 || width < 360, narrow: width < 360 })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const choose = (pin: BoardPin) => {
    setInspected(pin)
    onSelectPin?.(pin)
  }
  const controls = () => (
    <div className="board-controls" role="group" aria-label="观察方向">
      <button type="button" aria-pressed={front} onClick={() => setFace('front')}>
        正面
      </button>
      <button type="button" aria-pressed={!front} onClick={() => setFace('back')}>
        背面
      </button>
    </div>
  )
  const diagram = (view: 'inline' | 'expanded') => {
    const narrow = view === 'inline' && size.narrow
    const short = view === 'inline' && size.short
    const width = narrow ? 288 : 360
    const height = short ? 388 : 480
    const center = width / 2
    const edge = narrow ? 80 : 100
    const pcbWidth = narrow ? 128 : 160
    const rowWidth = narrow ? 80 : 96
    const rowStart = short ? 12 : 40
    const rowStep = short ? 364 / 15 : 400 / 15
    const buttonY = short ? 256 : 348
    const ledY = short ? 316 : 408
    const chipY = short ? 124 : 154
    const leftComponent = center - 64
    return (
      <svg
        className="board"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        data-size={narrow ? 'narrow' : short ? 'short' : 'regular'}
        role="group"
        aria-label={`合宙 CORE ESP32-C3 ${front ? '正面' : '背面'}接线图，32 个引脚，USB 在下`}
      >
        <defs>
          <mask id={`${boardId}-${view}-antenna`} style={{ maskType: 'alpha' }}>
            <image
              href={narrow ? antennaNarrow : antenna}
              x={narrow ? 84 : 112}
              y="12"
              width={narrow ? 120 : 136}
              height="28"
            />
          </mask>
        </defs>
        <rect className="pcb" x={edge} y="0.5" width={pcbWidth} height={height - 8.5} rx="8" />
        {front ? (
          <>
            <rect
              className="antenna"
              x={narrow ? 84 : 112}
              y="12"
              width={narrow ? 120 : 136}
              height="28"
              mask={`url(#${boardId}-${view}-antenna)`}
            />
            <rect className="chip" x={center - 30} y={chipY} width="60" height="64" rx="3" />
            <text className="chip-label" x={center} y={chipY + 25} textAnchor="middle">
              ESP32
            </text>
            <text className="chip-label" x={center} y={chipY + 45} textAnchor="middle">
              C3
            </text>
            {['RST', 'BOOT'].map((label, i) => (
              <g key={label}>
                <rect
                  className="usb"
                  x={leftComponent + i * 88}
                  y={buttonY}
                  width="40"
                  height="18"
                  rx="3"
                />
                <text
                  className="board-small"
                  x={leftComponent + 20 + i * 88}
                  y={buttonY + 36}
                  textAnchor="middle"
                >
                  {label}
                </text>
              </g>
            ))}
            {['D5', 'D4'].map((label, i) => {
              const pin = BOARD_PINS.find((p) => p.gpio === (i === 0 ? 13 : 12))!
              const x = leftComponent + i * 88
              return (
                <g
                  key={label}
                  className={onSelectPin ? 'board-led-target' : undefined}
                  role={onSelectPin ? 'button' : undefined}
                  tabIndex={onSelectPin ? 0 : undefined}
                  aria-label={
                    onSelectPin
                      ? `板上 ${label}${i === 0 ? ' 实验灯 / GPIO13' : ' 系统灯 / GPIO12（只读）'}`
                      : undefined
                  }
                  onClick={() => onSelectPin && choose(pin)}
                  onKeyDown={(e) => {
                    if (onSelectPin && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault()
                      choose(pin)
                    }
                  }}
                >
                  {onSelectPin && (
                    <rect
                      className={selected === pin.gpio ? 'board-led-selected' : ''}
                      x={x}
                      y={ledY}
                      width="40"
                      height="40"
                      rx="3"
                      fill="transparent"
                    />
                  )}
                  <image className="pin-icon-light" href={i === 0 ? d5Light : d4Light} x={x + 15} y={ledY + 4} width="10" height="10" />
                  <image className="pin-icon-dark" href={i === 0 ? d5Dark : d4Dark} x={x + 15} y={ledY + 4} width="10" height="10" />
                  {ready && (i === 0 ? state?.pins.find((p) => p.pin === 13)?.level === 1 : state?.sessions.some((session) => session.active)) && (
                    <circle className="led active" cx={x + 20} cy={ledY + 9} r="5" />
                  )}
                  <text className="board-small" x={x + 20} y={ledY + 34} textAnchor="middle">
                    {label}
                  </text>
                </g>
              )
            })}
          </>
        ) : (
          <text className="board-small" x={center} y={height / 2} textAnchor="middle">
            背面 · 左右翻转
          </text>
        )}
        <rect className="usb" x={center - 17} y={height - 28} width="34" height="28" rx="4" />
        <text className="board-small" x={center} y={height - 9} textAnchor="middle">
          USB
        </text>
        {BOARD_PINS.map((pin) => {
          const right = displaySide(pin, face) === 'right'
          const y = rowStart + pin.row * rowStep
          const padX = right ? edge + pcbWidth : edge - 16
          const current = state?.pins.find((p) => p.pin === pin.gpio)
          const status = pinStateLabel(current, narrow)
          const glyph = pin.protected ? 'lock' : pin.gpio === undefined ? null : pinStateGlyph(current)
          const flipped = current?.mode === 'input' ? right : !right
          return (
            <g
              key={pin.id}
              role="button"
              tabIndex={0}
              aria-label={`${pin.id} ${pin.label}${pin.gpio === undefined ? '' : ` GPIO ${pin.gpio}`}，${pin.description}${pin.gpio !== undefined && !pin.protected ? `，${status.full}` : ''}${physicalLabels[pin.id] ? ` · ${physicalLabels[pin.id]}` : ''}`}
              aria-pressed={!!(detail.id === pin.id && (inspected || selected >= 0))}
              data-pin-id={pin.id}
              data-side={right ? 'right' : 'left'}
              data-category={pin.category}
              data-pin-mode={current?.mode ?? 'idle'}
              data-pin-level={current?.level ?? 'unknown'}
              data-pin-quality={current?.quality ?? 'unknown'}
              data-protected={pin.protected}
              data-pin-symbol={glyph ?? 'empty'}
              className={`pin pin-${pin.category}${pin.gpio === selected ? ' selected-pin' : ''}${detail.id === pin.id && (inspected || selected >= 0) ? ' inspected-pin' : ''}${(pin.gpio !== undefined && pinLabels[pin.gpio]) || physicalLabels[pin.id] ? ' assigned-pin' : ''}${physicalHighlights.includes(pin.id) || (pin.gpio !== undefined && highlighted.includes(pin.gpio)) ? ' grouped-pin' : ''}`}
              onClick={() => choose(pin)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  choose(pin)
                }
              }}
            >
              <title>{[
                pin.description,
                pin.gpio !== undefined && !pin.protected ? status.full : '',
                pin.gpio !== undefined ? pinLabels[pin.gpio] : '',
              ].filter(Boolean).join(' · ')}</title>
              <rect
                className="pin-hit"
                x={right ? padX : edge - rowWidth}
                y={y - 12}
                width={rowWidth}
                height="24"
                rx="4"
              />
              <rect
                className="pin-outline"
                x={right ? padX : edge - rowWidth + (narrow ? 0 : 10)}
                y={y - 12}
                width={narrow ? rowWidth : rowWidth - 10}
                height="24"
                rx="4"
                aria-hidden="true"
              />
              <rect className="pin-pad" x={padX} y={y - 7} width="16" height="14" rx="2" />
              {glyph && (
                <PinStateIcon kind={glyph} flipped={['high', 'low', 'input-high'].includes(glyph) && flipped} x={right ? padX + 22 : padX - 24} y={y - 9} />
              )}
              {pin.gpio === 13 && (
                <g
                  className="pin-led-mark"
                  transform={`translate(${padX}, ${y - 7})`}
                  aria-hidden="true"
                >
                  <image className="pin-icon-light" href={ledMarkLight} width="16" height="14" />
                  <image className="pin-icon-dark" href={ledMarkDark} width="16" height="14" />
                </g>
              )}
              <text
                x={right ? padX + 46 : padX - 30}
                y={y + 5}
                textAnchor={right ? 'start' : 'end'}
              >
                {pin.label}
              </text>
            </g>
          )
        })}
      </svg>
    )
  }
  const legend = () => (
    <div className="board-legend">
      {['5v:5V', 'ground:GND', '3v3:3.3V', 'analog:ADC 能力', 'digital:数字'].map((item) => {
        const [category, label] = item.split(':')
        return (
          <span key={category} className={`pin-${category}`}>
            <i aria-hidden="true" />
            {label}
          </span>
        )
      })}
      <span className="board-protection-legend">
        <PinStateIcon kind="lock" />
        受保护
      </span>
    </div>
  )
  const information = () => (
    <p className="board-detail" aria-live="polite">
      <strong>
        当前查看：{detail.label}
        {detail.gpio === undefined ? '' : ` / GPIO ${detail.gpio}`}
      </strong>
      <br />
      {detail.description}
    </p>
  )
  return (
    <div className={`board-wrap ${embedded ? 'board-embedded' : ''}`}>
      <div className="board-toolbar">
        <h2>
          {selectedStatus ? (
            <span role="status" aria-label="选中引脚当前状态">
              {selectedStatus}
            </span>
          ) : (
            'CORE ESP32-C3'
          )}
        </h2>
        {!selectedStatus && <span className="board-orientation">天线上 / USB 下</span>}
        <div className="board-toolbar-space" />
        <div className="board-controls-row">{controls()}</div>
        <button
          className="text-button board-expand"
          type="button"
          aria-label="放大接线图"
          onClick={() => dialog.current?.showModal()}
        >
          放大
        </button>
        <button
          className="text-button"
          type="button"
          aria-label="接线与引脚列表"
          onClick={() => list.current?.showModal()}
        >
          引脚
        </button>
        <button className="text-button" type="button" onClick={() => help.current?.showModal()}>
          图例
        </button>
        {onInternal && (
          <button className="text-button" type="button" onClick={onInternal}>
            片内功能
          </button>
        )}
      </div>
      <div className="board-viewport" ref={viewport}>
        {diagram('inline')}
      </div>
      {!embedded && legend()}
      {!embedded && information()}
      <dialog
        ref={dialog}
        className="board-dialog"
        aria-labelledby={`${boardId}-title`}
        onClose={onCloseDiagram}
      >
        <div className="board-dialog-heading">
          <h2 id={`${boardId}-title`}>实物接线图 · 32 引脚</h2>
          <button type="button" onClick={() => dialog.current?.close()}>
            关闭接线图
          </button>
        </div>
        {controls()}
        <div className="board-scroll">{diagram('expanded')}</div>
        {legend()}
        {information()}
      </dialog>
      <dialog ref={help} className="board-dialog pin-legend-dialog" aria-labelledby={`${boardId}-help`}>
        <h2 id={`${boardId}-help`}>图形含义 · 空闲时不显示图标</h2>
        <div className="pin-state-legend">
          {([
            ['input-high', '输入 · 高', true], ['low', '输出 · 低', false],
            ['high', '输出 · 高', false], ['pwm', 'PWM', false],
            ['adc', '采集', false], ['lock', '保护', false], ['unknown', '未知', false],
          ] as [PinGlyph, string, boolean][]).map(([kind, label, flip]) => (
            <span key={kind}><PinStateIcon kind={kind} flipped={flip} />{label}</span>
          ))}
        </div>
        <p>箭头相对板子指向表示输入／输出；实心与空心表示高／低。类别色块不随状态改变。</p>
        <button className="text-button" type="button" onClick={() => help.current?.close()}>关闭图例</button>
      </dialog>
      <dialog
        ref={list}
        className="board-dialog pin-table"
        aria-labelledby={`${boardId}-list`}
        onClose={onCloseDiagram}
      >
        <div className="board-dialog-heading">
          <h2 id={`${boardId}-list`}>接线与引脚列表</h2>
          <button type="button" onClick={() => list.current?.close()}>
            关闭引脚列表
          </button>
        </div>
        {BOARD_PINS.map((pin) => (
          <button
            key={pin.id}
            onClick={() => {
              choose(pin)
              list.current?.close()
            }}
          >
            {pin.id} · {pin.label} ·{' '}
            {pin.protected
              ? '受保护 · 不可配置'
              : pin.gpio === undefined
                ? pin.description
                : (pinLabels[pin.gpio] ?? '未分配')}
          </button>
        ))}
      </dialog>
    </div>
  )
}
