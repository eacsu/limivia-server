# v3 能力覆盖清单

SDK 公开 Operation 共 76 项、ResourceKind 共 18 项。业务类型来自 SDK，具体配置、动作、范围和 available 来自运行时 discovery。下表的测试证据是软件网关/模拟设备，不等于全部外设的硬件验证。

后端对应 [test_devices.py](../tests/test_devices.py) 的分派、生命周期及边界集成；界面闭环见 [v3.spec.ts](../src/web/tests/v3.spec.ts)，18 类表单与布局见 [visual.spec.ts](../src/web/tests/visual.spec.ts)，结果解释见 [device.test.ts](../src/web/src/device.test.ts)。实际命令和数量见 [验证记录](verification.md)。

## 76 个操作

|序号|操作|后端入口|界面或内部用途|验证|
|---|---|---|---|---|
|1|`hello`|SDK 连接管理器|连接握手，SDK 自动执行|连接/发现/快照集成；unsubscribe 由 SDK 门面提供，页面不单独撤销共享订阅|
|2|`session.ping`|SDK 连接管理器|SDK 后台心跳|连接/发现/快照集成；unsubscribe 由 SDK 门面提供，页面不单独撤销共享订阅|
|3|`event.subscribe`|SDK 连接管理器|管理器统一订阅|连接/发现/快照集成；unsubscribe 由 SDK 门面提供，页面不单独撤销共享订阅|
|4|`event.unsubscribe`|SDK 连接管理器|管理器生命周期内部基础能力|连接/发现/快照集成；unsubscribe 由 SDK 门面提供，页面不单独撤销共享订阅|
|5|`control.acquire`|SDK 连接管理器|写操作自动协调；页面不暴露|自动获取及跨页面共享资源集成|
|6|`control.release`|SDK 连接生命周期|页面不暴露|结束连接清理本连接资源|
|7|`outputs.stop`|`POST /api/device/stop`|顶栏停止所有实验|全局停止与新操作代次集成及浏览器闭环|
|8|`capabilities`|SDK 连接管理器|SDK discover 聚合|连接/发现/快照集成；unsubscribe 由 SDK 门面提供，页面不单独撤销共享订阅|
|9|`state`|SDK 连接管理器|SDK state.snapshot 聚合|连接/发现/快照集成；unsubscribe 由 SDK 门面提供，页面不单独撤销共享订阅|
|10|`diagnostics`|`POST /api/device/operations`|设备维护诊断|通用分派契约|
|11|`mux.query`|`POST /api/device/operations`|资源预检 / 维护占用查询|通用分派契约|
|12|`mux.preflight`|`POST /api/device/operations`|资源预检 / 维护占用查询|通用分派契约|
|13|`resource.preflight`|`POST /api/device/operations`|外设调试资源树、配置与动作面板|通用分派契约；资源生命周期/故障/编码/采样集成|
|14|`resource.open`|`POST /api/device/operations`|外设调试资源树、配置与动作面板|通用分派契约；资源生命周期/故障/编码/采样集成|
|15|`resource.get`|`POST /api/device/operations`|外设调试资源树、配置与动作面板|通用分派契约；资源生命周期/故障/编码/采样集成|
|16|`resource.close`|`POST /api/device/operations`|外设调试资源树、配置与动作面板|通用分派契约；资源生命周期/故障/编码/采样集成|
|17|`resource.recover`|`POST /api/device/operations`|外设调试资源树、配置与动作面板|通用分派契约；资源生命周期/故障/编码/采样集成|
|18|`resource.call`|`POST /api/device/operations`|外设调试资源树、配置与动作面板|通用分派契约；资源生命周期/故障/编码/采样集成|
|19|`job.get`|`POST /api/device/operations`|操作详情查询/取消、设备维护|通用分派契约；取消请求与原作业分离|
|20|`job.cancel`|`POST /api/device/operations`|操作详情查询/取消、设备维护|通用分派契约；取消请求与原作业分离|
|21|`gpio.group.read`|`POST /api/device/operations`|设备维护组操作|通用分派契约|
|22|`gpio.group.write`|`POST /api/device/operations`|设备维护组操作|通用分派契约|
|23|`rmt.sync`|`POST /api/device/operations`|设备维护同步发射|通用分派契约|
|24|`buffer.create`|`POST /api/device/operations`|设备维护二进制缓存|通用分派契约|
|25|`buffer.write`|`POST /api/device/operations`|设备维护二进制缓存|通用分派契约|
|26|`buffer.read`|`POST /api/device/operations`|设备维护二进制缓存|通用分派契约|
|27|`buffer.delete`|`POST /api/device/operations`|设备维护二进制缓存|通用分派契约|
|28|`storage.status`|`POST /api/device/operations`|板上文件 / 流程上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|29|`storage.list`|`POST /api/device/operations`|板上文件 / 流程上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|30|`storage.format`|`POST /api/device/operations`|板上文件 / 流程上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|31|`storage.begin`|`POST /api/device/operations`|板上文件 / 流程上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|32|`storage.chunk`|`POST /api/device/operations`|板上文件 / 流程上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|33|`storage.commit`|`POST /api/device/operations`|板上文件 / 流程上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|34|`storage.abort`|`POST /api/device/operations`|板上文件 / 流程上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|35|`storage.read`|`POST /api/device/operations`|板上文件 / 流程上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|36|`storage.delete`|`POST /api/device/operations`|板上文件 / 流程上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|37|`storage.record`|`POST /api/device/operations`|板上文件 / 流程上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|38|`storage.append`|`POST /api/device/operations`|板上文件 / 流程上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|39|`ota.status`|`POST /api/device/operations`|设备维护 OTA 阶段与上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|40|`ota.begin`|`POST /api/device/operations`|设备维护 OTA 阶段与上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|41|`ota.chunk`|`POST /api/device/operations`|设备维护 OTA 阶段与上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|42|`ota.commit`|`POST /api/device/operations`|设备维护 OTA 阶段与上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|43|`ota.abort`|`POST /api/device/operations`|设备维护 OTA 阶段与上传|通用分派契约；上传/校验/中止/下载/秘密文件集成（OTA 不重启）|
|44|`wifi.status`|`POST /api/device/operations`|联网通信 Wi-Fi|通用分派契约|
|45|`wifi.configure`|`POST /api/device/operations`|联网通信 Wi-Fi|通用分派契约|
|46|`wifi.scan`|`POST /api/device/operations`|联网通信 Wi-Fi|通用分派契约|
|47|`wifi.maintenance`|`POST /api/device/operations`|联网通信 Wi-Fi|通用分派契约|
|48|`wifi.disconnect`|`POST /api/device/operations`|联网通信 Wi-Fi|通用分派契约|
|49|`mqtt.status`|`POST /api/device/operations`|联网通信高级 MQTT|通用分派契约|
|50|`mqtt.configure`|`POST /api/device/operations`|联网通信高级 MQTT|通用分派契约|
|51|`mqtt.publish`|`POST /api/device/operations`|联网通信高级 MQTT|通用分派契约|
|52|`mqtt.subscribe`|`POST /api/device/operations`|联网通信高级 MQTT|通用分派契约|
|53|`mqtt.unsubscribe`|`POST /api/device/operations`|联网通信高级 MQTT|通用分派契约|
|54|`mqtt.receive`|`POST /api/device/operations`|联网通信高级 MQTT|通用分派契约|
|55|`mqtt.stop`|`POST /api/device/operations`|联网通信高级 MQTT|通用分派契约|
|56|`espnow.status`|`POST /api/device/operations`|联网通信 ESP-NOW / 高级对端收发|通用分派契约|
|57|`espnow.start`|`POST /api/device/operations`|联网通信 ESP-NOW / 高级对端收发|通用分派契约|
|58|`espnow.stop`|`POST /api/device/operations`|联网通信 ESP-NOW / 高级对端收发|通用分派契约|
|59|`espnow.peer`|`POST /api/device/operations`|联网通信 ESP-NOW / 高级对端收发|通用分派契约|
|60|`espnow.remove`|`POST /api/device/operations`|联网通信 ESP-NOW / 高级对端收发|通用分派契约|
|61|`espnow.send`|`POST /api/device/operations`|联网通信 ESP-NOW / 高级对端收发|通用分派契约|
|62|`espnow.receive`|`POST /api/device/operations`|联网通信 ESP-NOW / 高级对端收发|通用分派契约|
|63|`power.configure`|`POST /api/device/operations`|设备维护低功耗|通用分派契约|
|64|`power.sleep`|`POST /api/device/operations`|设备维护低功耗|通用分派契约|
|65|`system.info`|`POST /api/device/operations`|设备维护系统服务|通用分派契约|
|66|`system.time`|`POST /api/device/operations`|设备维护系统服务|通用分派契约|
|67|`system.restart`|`POST /api/device/operations`|设备维护系统服务|通用分派契约|
|68|`system.nvs_format`|`POST /api/device/operations`|设备维护系统服务|通用分派契约|
|69|`flow.load`|`POST /api/device/operations`|离线流程执行图与运行控制|通用分派契约；流程加载/运行/暂停/清理/移除集成|
|70|`flow.list`|`POST /api/device/operations`|离线流程执行图与运行控制|通用分派契约；流程加载/运行/暂停/清理/移除集成|
|71|`flow.get`|`POST /api/device/operations`|离线流程执行图与运行控制|通用分派契约；流程加载/运行/暂停/清理/移除集成|
|72|`flow.start`|`POST /api/device/operations`|离线流程执行图与运行控制|通用分派契约；流程加载/运行/暂停/清理/移除集成|
|73|`flow.pause`|`POST /api/device/operations`|离线流程执行图与运行控制|通用分派契约；流程加载/运行/暂停/清理/移除集成|
|74|`flow.resume`|`POST /api/device/operations`|离线流程执行图与运行控制|通用分派契约；流程加载/运行/暂停/清理/移除集成|
|75|`flow.stop`|`POST /api/device/operations`|离线流程执行图与运行控制|通用分派契约；流程加载/运行/暂停/清理/移除集成|
|76|`flow.remove`|`POST /api/device/operations`|离线流程执行图与运行控制|通用分派契约；流程加载/运行/暂停/清理/移除集成|

另有 discover、state.snapshot 两个 SDK 聚合入口，不计入 76 项；统一通过刷新接口使用。批量接口走 SDK batch，每项保留独立 operation ID。基础操作不会变成可破坏共享会话的普通页面按钮。

## 18 类资源

|kind|界面|字段与结果|验证|
|---|---|---|---|
|`gpio`|外设调试 → gpio|方向、电平、上下拉、事件；读回值与定义分开；其余字段按能力生成|浏览器表单、LED 读写、资源创建/关闭/fault/recover 集成|
|`pwm`|外设调试 → pwm|频率、分辨率、占空比、周期呼吸、duty/fade；其余字段按能力生成|浏览器表单及预检→创建→占空比→关闭闭环|
|`adc`|外设调试 → adc|单次/周期、raw/mV、未校准与 CSV；其余字段按能力生成|浏览器表单；后端共享采样/有界缓存；raw/未校准 mV 单元测试|
|`adc.continuous`|外设调试 → adc.continuous|带通道/单元的 type2 小端 32 位数据；其余字段按能力生成|浏览器表单；type2 通道/单元/raw 解码单元测试|
|`uart`|外设调试 → uart|文本/HEX/Base64、收发、错误、内部回环说明；其余字段按能力生成|浏览器表单；资源调用的文本/HEX/Base64 软件编码集成|
|`i2c.master`|外设调试 → i2c.master|总线配置、probe/scan/recover；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`i2c.device`|外设调试 → i2c.device|父总线、地址与事务；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`i2c.slave`|外设调试 → i2c.slave|从机预载、队列与事件；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`spi.master`|外设调试 → spi.master|总线与共享配置；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`spi.device`|外设调试 → spi.device|父总线、CS、读写/传输；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`spi.slave`|外设调试 → spi.slave|从机事务队列与结果；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`twai`|外设调试 → twai|经典 CAN、ID、帧与错误；不提供 CAN FD；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`rmt.tx`|外设调试 → rmt.tx|发射/同步与显式 abort/close；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`rmt.rx`|外设调试 → rmt.rx|捕获与 32 位符号（时钟计数/电平）；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`i2s`|外设调试 → i2s|位宽、采样率、通道与原始 PCM/PDM 字节；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`sigma_delta`|外设调试 → sigma_delta|密度配置与操作；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`timer`|外设调试 → timer|高低时长、有限/无限次数与结束电平；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|
|`temperature`|外设调试 → temperature|片内温度，不声明环境温度；其余字段按能力生成|浏览器能力表单覆盖；通用资源桥接（驱动结果为模拟）|

## 证据边界

- 2026-10-24 补充无头 Chromium 经正式后端/SDK 连接 USB bus 实机：LED/PWM、文件上传/列表/下载/删除、无引脚短流程加载/运行/停止/移除及全局停止通过。仅这些闭环具有本轮 USB 实机证据，不扩大为所有操作或外设驱动的实机验收。
- 参数与驱动范围由 SDK 和设备最终校验；通用分派测试证明所有公开操作能被网关关联和交付，不冒充逐个硬件驱动成功。
- 测试夹具的引脚、资源配置和部分动作页来自 SDK 冻结捕获；缺失的测试能力页及系统操作列表由模拟设备补齐，明确仅用于软件验证。
- bus/signal/iot 的 available、未知 profile 字符串、跨 boot 句柄与凭据脱敏分别验证；实际 BLE、板上 WS/MQTT/TLS、第二无线节点、外接器件、音频/RMT 输入、物理时序/功耗和 OTA 激活未在本轮验收。
- 旧 SDK/协议、任意代码执行、自动重放、自动重连抢控制、自动格式化、固件烧录与发布均不作为支持能力。
