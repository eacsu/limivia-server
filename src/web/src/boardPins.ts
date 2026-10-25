// 合宙 CORE ESP32-C3 简约版：元件面朝向观察者，天线上、USB 下。
// 来源与完整位置表见 .agents/skills/limivia-esp32c3/references/board-and-chip.md。
export type BoardFace = 'front' | 'back'
export type PinCategory = '5v' | 'ground' | '3v3' | 'analog' | 'digital' | 'special'
export interface BoardPin {
  id: string
  side: 'left' | 'right'
  row: number
  label: string
  gpio?: number
  category: PinCategory
  description: string
  protected: boolean
}
const left = [
  'GND',
  'IO00',
  'IO01',
  'IO12',
  'IO18',
  'IO19',
  'GND',
  'RX0',
  'TX0',
  'IO13',
  'NC',
  'EN',
  '3.3V',
  'GND',
  'PWB',
  '5V',
]
const right = [
  'GND',
  '3.3V',
  'IO02',
  'IO03',
  'IO10',
  'IO06',
  'IO07',
  'IO11',
  'GND',
  '3.3V',
  'IO05',
  'IO04',
  'IO08',
  'IO09',
  '5V',
  'GND',
]
const restrictions: Record<number, string> = {
  2: '启动配置／受保护',
  8: '启动配置／受保护',
  9: 'BOOT 启动配置／受保护',
  11: 'Flash 电压／受保护',
  12: 'D4 系统状态 LED／受保护',
  18: 'USB D−／受保护',
  19: 'USB D+／受保护',
}
const special: Record<string, string> = {
  GND: '地线，外设需共地',
  '5V': '5V 供电；GPIO 不耐受 5V',
  '3.3V': '3.3V 电源',
  NC: '未连接',
  EN: '复位使能，低电平复位',
  PWB: '电源控制脚，接线请核对原理图',
}
export const BOARD_PINS: BoardPin[] = [left, right].flatMap((labels, side) =>
  labels.map((label, row) => {
    const gpio =
      label === 'RX0'
        ? 20
        : label === 'TX0'
          ? 21
          : label.startsWith('IO')
            ? Number(label.slice(2))
            : undefined
    const category: PinCategory =
      label === '5V'
        ? '5v'
        : label === 'GND'
          ? 'ground'
          : label === '3.3V'
            ? '3v3'
            : gpio === undefined
              ? 'special'
              : gpio <= 5
                ? 'analog'
                : 'digital'
    const description =
      gpio === undefined
        ? special[label]
        : [
            gpio <= 4 ? 'ADC1 模拟输入' : gpio === 5 ? 'ADC2 当前未开放，数字功能可用' : '数字信号',
            restrictions[gpio] ?? '数字输入／输出、PWM',
            gpio === 13 ? 'D5 实验 LED' : '',
          ]
            .filter(Boolean)
            .join(' · ')
    return {
      id: `${side === 0 ? 'L' : 'R'}${row + 1}`,
      side: side === 0 ? 'left' : 'right',
      row,
      label,
      gpio,
      category,
      description,
      protected: gpio !== undefined && gpio in restrictions,
    }
  }),
)
export function displaySide(pin: BoardPin, face: BoardFace) {
  return face === 'front' ? pin.side : pin.side === 'left' ? 'right' : 'left'
}
