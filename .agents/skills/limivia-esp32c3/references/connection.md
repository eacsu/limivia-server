# 设备连接与恢复

本资料仅覆盖 LIMIVIA 工作台的设备接入。固件构建、烧录、驱动调试及实机验证工具由独立的 `limivia-esp32` 仓库维护，本仓库不依赖该目录存在。

## 后端设备连接

- 默认 BLE，后端经 AsyncLimivia SDK 用 Bleak 搜索服务 UUID 并订阅 GATT 通知；USB 用 pySerial 打开匹配 VID/PID 的原生串口，115200、DTR/RTS 保持 pySerial 默认值（本板显式拉低会复位）。SDK 建立连接时先自动 `hello` 检查板型和协议，不仅凭名称或 VID/PID 判断。
- 网页先“搜索设备”，再选择与连接。浏览器只需同源 HTTP/WebSocket，不依赖 Web Serial / Web Bluetooth，不需要浏览器实验特性。
- 所用串口和蓝牙适配器位于后端运行环境。WSL、容器与虚拟机需要自行提供设备或系统蓝牙服务，网页端口转发不转发硬件。
- Linux BLE 需要可用控制器、BlueZ 与系统 D-Bus 权限；USB 需要后端用户的串口权限。Windows/macOS 需允许运行后端的应用使用蓝牙。
- 后端生命周期持有一条设备连接，多个页面共享观察与操作；SDK 自动协调协议令牌，无需手动接管。关闭页面不关闭设备连接，也不停止输出。运行单进程、单 worker；切换通道先断开，超时的写操作不自动重试。
- `/api/device/discover?kind=ble|usb` 返回候选或可恢复错误，`POST /api/device/connect` 提交连接配置，`/api/device/events` 为同源 WebSocket 事件通道。USB/BLE 由 SDK 重新核对扫描候选与预期设备身份，不允许客户端直接指定任意串口路径。
- BLE 服务名 `LIMIVIA-xxxx`，具体服务与特征 UUID 以工程协议文档为准。缺少真实设备时明确记录实机未验证，不用模拟数据冒充连接成功。

## USB 排查

- 本板没有 USB-UART 桥，使用 ESP32-C3 原生 USB Serial/JTAG。先确认数据线、供电、后端串口权限；串口被监视器占用时先关闭监视器。
- Linux 常见端口为 `/dev/ttyACM*`，优先通过 `/dev/serial/by-id/` 识别；编号及 VID:PID 不能单独证明板型。
- 正常复位仍无法连接时，按住 BOOT，再按下并松开 RST，最后松开 BOOT，重新枚举端口。下载模式不提供工作台协议；烧录恢复须切换到固件仓库执行。
- GPIO18/19 必须保留给 USB，不建议用 eFuse 写入恢复连接。
- 连接成功后读取 `hello` 和 `state`；浏览器刷新或关闭不停止输出。SDK 0.3.0a7 的显式“结束实验并断开”会清理本连接创建的资源，其他来源的资源不认领、不释放；失败时提示结果待核实。意外传输断开后输出可能继续，恢复时不把页面旧值写回板卡。

连接模型更新：2026-10-26，SDK 0.3.0a7 / JSON-RPC v3；原硬件观察核验日期：2026-10-21。[Bleak](https://bleak.readthedocs.io/en/latest/)、[pySerial](https://pyserial.readthedocs.io/en/stable/pyserial_api.html)、[乐鑫串口连接](https://docs.espressif.com/projects/esp-idf/en/v6.0.2/esp32c3/get-started/establish-serial-connection.html)。
