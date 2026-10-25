import logoLight from './assets/figma/logo-vallum.svg'
import logoDark from './assets/figma/logo-abyssus.svg'
import { kindNames, type DeviceState } from './device'
import { navigationReason, type Section } from './navigation'
import type { BoardSelection } from './wiring'
import type { WiringWorkspace } from './useWiring'

const icons = import.meta.glob<string>('./assets/figma/v4/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
})
function Icon({ name }: { name: string }) {
  return (
    <span className="nav-icon" aria-hidden="true">
      <img className="theme-light" src={icons[`./assets/figma/v4/${name}-vallum.svg`]} alt="" />
      <img className="theme-dark" src={icons[`./assets/figma/v4/${name}-abyssus.svg`]} alt="" />
    </span>
  )
}
const navigation = [
  ['home', '设备工作台', 'workspace'],
  ['flow', '离线流程', 'flow'],
  ['network', '联网通信', 'network'],
  ['files', '板上文件', 'files'],
  ['maintenance', '设备维护', 'maintenance'],
] as const
export function Sidebar({
  state,
  section,
  selection,
  wiring,
  theme,
  onNavigate,
  onSelect,
  onFirmware,
  onBoard,
  onTheme,
  onConnect,
}: {
  state: DeviceState
  section: Section
  selection: BoardSelection
  wiring: WiringWorkspace
  theme: string
  onNavigate: (section: Section) => void
  onSelect: (view: BoardSelection) => void
  onFirmware: () => void
  onBoard: () => void
  onTheme: () => void
  onConnect: () => void
}) {
  const showResources = section === 'home'
  const pinsAvailable =
    state.identity?.board === 'luatos-esp32c3-usb' &&
    state.status === 'ready' &&
    !!state.discovery?.pins.length
  const resources = state.snapshot?.resources ?? []
  return (
    <nav className="sidebar" aria-label="工作台导航">
      <div className="brand">
        <img className="brand-mark theme-light" src={logoLight} width="32" height="32" alt="" />
        <img className="brand-mark theme-dark" src={logoDark} width="32" height="32" alt="" />
        <strong>LIMIVIA</strong>
      </div>
      <button
        className="device-context"
        onClick={onConnect}
        aria-label={state.identity ? '连接详情' : '连接设备'}
      >
        <span className="device-name">
          {state.identity?.board === 'luatos-esp32c3-usb'
            ? '合宙 ESP32-C3'
            : (state.identity?.board ?? '尚未连接设备')}
        </span>
        <span className="identity-tag">
          {state.identity ? `${state.identity.profile} · ${state.identity.firmware}` : '固件待识别'}
        </span>
        <span className="link-tag">{state.kind.toUpperCase()} · 服务主机</span>
      </button>
      <div className="sidebar-viewport" tabIndex={0} aria-label="功能与当前资源">
        <div className="sidebar-navigation">
          {navigation.map(([key, title, icon], index) => {
            const reason = navigationReason(key, state)
            return (
              <div className="nav-entry" key={key}>
                {index === 2 && <div className="nav-group-label">设备</div>}
                <button
                  className={`nav-item ${section === key ? 'selected' : ''}`}
                  aria-current={section === key ? 'page' : undefined}
                  disabled={!!reason}
                  title={reason ? `${title} · ${reason}` : undefined}
                  aria-label={title}
                  onClick={() => onNavigate(key)}
                >
                  <Icon name={icon} />
                  <span className="nav-label">{title}</span>
                  {reason && <small>{reason}</small>}
                </button>
                {key === 'home' && showResources && (
                  <div className="context-resources" role="group" aria-label="接线组与设备配置">
                    {!!wiring.plan?.groups.length && <div className="nav-group-label">接线组</div>}
                    {wiring.plan?.groups.map((group) => (
                      <button
                        key={group.id}
                        className={`context-resource ${selection?.type === 'group' && selection.id === group.id ? 'selected' : ''}`}
                        aria-current={
                          selection?.type === 'group' && selection.id === group.id
                            ? 'location'
                            : undefined
                        }
                        onClick={() => onSelect({ type: 'group', id: group.id })}
                      >
                        <span>{group.name}</span>
                        <small>
                          {kindNames[group.kind] ?? group.kind} ·{' '}
                          {state.wiring_bindings?.[group.id] ? '设备已有配置' : '方案待应用'}
                        </small>
                      </button>
                    ))}
                    {resources
                      .filter(
                        (r) =>
                          !Object.values(state.wiring_bindings ?? {}).some(
                            (b) => b.resource === r.id && b.instance === r.instance,
                          ),
                      )
                      .map((resource) => (
                        <button
                          key={`${resource.id}:${resource.instance}`}
                          className={`context-resource ${(selection?.type === 'resource' && selection.id === resource.id && selection.instance === resource.instance) || (selection?.type === 'experiment' && !!(resource.pin_mask & (2 ** selection.gpio))) ? 'selected' : ''}`}
                          onClick={() =>
                            onSelect({
                              type: 'resource',
                              id: resource.id,
                              instance: resource.instance,
                            })
                          }
                        >
                          <span>
                            {kindNames[resource.kind]} ·{' '}
                            {resource.pin_mask
                              ? 'GPIO ' +
                                Array.from({ length: 22 }, (_, pin) => pin)
                                  .filter((pin) => resource.pin_mask & (2 ** pin))
                                  .join('/')
                              : '#' + resource.id}
                          </span>
                          <small>
                            未归组 ·{' '}
                            {resource.state !== 'ready'
                              ? resource.state
                              : state.resource_origin[resource.id] === 'managed'
                                ? '本连接创建'
                                : '其他来源'}
                          </small>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="sidebar-footer">
        {section !== 'home' && section !== 'flow' && (
          <button
            className="nav-item"
            aria-label="引脚与占用"
            disabled={!pinsAvailable}
            onClick={onBoard}
          >
            <Icon name="pins" />
            <span className="nav-label">引脚与占用</span>
            {!pinsAvailable && <small>不可用</small>}
          </button>
        )}
        <button className="nav-item" onClick={onFirmware}>
          <Icon name="firmware" />
          固件与能力
        </button>
        <div className="sidebar-version">
          <small>LIMIVIA</small>
          <button className="text-button" onClick={onTheme}>
            {theme === 'vallum' ? '切换苍渊' : '切换白垣'}
          </button>
        </div>
      </div>
    </nav>
  )
}
