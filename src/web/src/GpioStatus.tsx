import type { Resource } from './device'
import type { useGpioStatus } from './useGpioStatus'

export function GpioStatus({
  model,
  resource,
  gpio,
  showOutputControl = true,
}: {
  model: ReturnType<typeof useGpioStatus>
  resource?: Resource
  gpio: number
  showOutputControl?: boolean
}) {
  return (
    <section className="gpio-current" aria-label="设备当前状态">
      <h3>设备当前状态</h3>
      <p className="gpio-current-value">
        GPIO{gpio} · {resource ? model.modeText : showOutputControl ? '未应用' : '未启用'}
      </p>
      <p className="gpio-current-reading" aria-live="polite">
        {resource
          ? `${model.mode === 'input' ? '输入电平' : '引脚电平'}：${model.levelText}${model.qualifier ? ` · ${model.qualifier}` : ''}`
          : showOutputControl
            ? '尚无已应用的 GPIO 资源'
            : '尚未启用 GPIO'}
      </p>
      {resource && (
        <div className="gpio-current-controls">
          {showOutputControl && model.mode !== 'input' && (
            <button
              type="button"
              className="gpio-output-button"
              disabled={!model.canWrite}
              onClick={() => void model.toggle()}
              aria-label={`切换实际输出，${model.levelText}`}
            >
              {model.levelText}
            </button>
          )}
          <button
            type="button"
            className="text-button"
            disabled={!model.canRead}
            aria-busy={model.busy}
            onClick={() => void model.read()}
          >
            读取状态
          </button>
        </div>
      )}
      {showOutputControl && model.error && (
        <p className="gpio-current-feedback" role="alert">
          {model.error}
        </p>
      )}
      {resource && model.mode === 'open_drain' && (
        <p className="gpio-current-feedback">开漏输出需要外部上拉；1 表示释放，0 表示拉低。</p>
      )}
      {model.busy && (
        <span className="sr-only" role="status">
          正在读取设备确认结果
        </span>
      )}
    </section>
  )
}
