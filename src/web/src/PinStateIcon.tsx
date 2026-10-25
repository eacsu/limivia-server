import type { PinGlyph } from './pinState'
import inputHighLight from './assets/figma/pin-state/input-high-vallum.svg'
import inputHighDark from './assets/figma/pin-state/input-high-abyssus.svg'
import highLight from './assets/figma/pin-state/high-vallum.svg'
import highDark from './assets/figma/pin-state/high-abyssus.svg'
import lowLight from './assets/figma/pin-state/low-vallum.svg'
import lowDark from './assets/figma/pin-state/low-abyssus.svg'
import pwmLight from './assets/figma/pin-state/pwm-vallum.svg'
import pwmDark from './assets/figma/pin-state/pwm-abyssus.svg'
import adcLight from './assets/figma/pin-state/adc-vallum.svg'
import adcDark from './assets/figma/pin-state/adc-abyssus.svg'
import lockLight from './assets/figma/pin-state/lock-vallum.svg'
import lockDark from './assets/figma/pin-state/lock-abyssus.svg'
import unknownLight from './assets/figma/pin-state/unknown-vallum.svg'
import unknownDark from './assets/figma/pin-state/unknown-abyssus.svg'

const assets = {
  'input-high': [inputHighLight, inputHighDark],
  high: [highLight, highDark],
  low: [lowLight, lowDark],
  pwm: [pwmLight, pwmDark],
  adc: [adcLight, adcDark],
  lock: [lockLight, lockDark],
  unknown: [unknownLight, unknownDark],
} as const

export function PinStateIcon({
  kind, flipped = false, x, y,
}: { kind: PinGlyph; flipped?: boolean; x?: number; y?: number }) {
  const arrow = ['input-high', 'high', 'low'].includes(kind)
  const [light, dark] = assets[kind]
  return (
    <svg
      className="pin-state-icon"
      x={x} y={y} width="18" height="18" viewBox="0 0 18 18"
      aria-hidden="true" data-state-icon={kind} data-flipped={flipped}
    >
      <g transform={flipped ? 'translate(18 0) scale(-1 1)' : undefined}>
        <image className="pin-icon-light" href={light} x={arrow ? 0.25 : 0} y={arrow ? 2.25 : 0} width={arrow ? 17.5 : 18} height={arrow ? 13.5 : 18} />
        <image className="pin-icon-dark" href={dark} x={arrow ? 0.25 : 0} y={arrow ? 2.25 : 0} width={arrow ? 17.5 : 18} height={arrow ? 13.5 : 18} />
      </g>
    </svg>
  )
}
