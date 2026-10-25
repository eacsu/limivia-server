# 后端设备与任务模型（JSON-RPC v3）

浏览器通过同源 HTTP 提交业务操作，通过 `/api/device/events` WebSocket 观察快照与增量。后端使用 limivia SDK 公开的 `AsyncLimivia`、`AsyncConnection` 和类型化事件，不转发设备线协议，不复制传输、seq、心跳或设备作业轮询。

## 连接与操作代次

服务生命周期管理一个设备连接，单进程、单 worker。Linux 对数据目录持有进程锁，避免同目录多个管理进程竞争。USB/BLE 扫描和连接互斥；WS/MQTT 显式提供 URL，MQTT 必填目标 MAC；证书路径属于服务主机。

同一个 AsyncLimivia 从服务启动持续到关闭。扫描和后续连接必须复用此实例，保留 SDK 默认 Backend 的最近扫描候选缓存；不能在扫描请求退出后销毁客户端，再用新的客户端连接刚选择的 USB/BLE 目标。每次连接仍建立新的连接上下文及代次，断开不销毁整个 SDK。

`POST /api/pages` 签发页面会话，前端保存在 sessionStorage；HTTP 使用 `X-Page-Session`，WebSocket 首条消息携带 `page_session`。连接管理器与页面生命周期分离，浏览器关闭、刷新和实时通道重连不会断开设备或重放动作。

连接就绪后，所有页面均可操作本连接创建的资源。页面会话仅用于关联请求及实时订阅，不授予独占写权限。SDK 高层接口及高级批量入口自动获取协议令牌，令牌不下发浏览器；手动 control.acquire/release 不作为页面操作。外部资源仍不自动认领，真实引脚冲突与驱动故障照常反馈。

操作代次 operation_epoch 隔离停止前的旧动作。`outputs.stop` 有独立入口，绕过普通任务队列满的限制；立即推进操作代次，只有 SDK 原始停止 job 的清理、持久化与自启抑制确认后才显示完成。

## 操作关联与事件消费

普通 GPIO/PWM/ADC/UART 使用 `board.gpio/pwm/adc/uart` 工厂，其他资源通过 `board.resources.open` 持有高层资源对象；结果通过公开模型及 `OperationResult.data` 归一化到 HTTP。资源对象由设备连接持有，不绑定单个请求或浏览器页面。普通成功结果没有 request/job 编号时字段保持空值，任务为 running→completed/failed/unknown。SDK 错误保留真实编号、驱动错误、过期标记及资源清理诊断。

显式 `job.submit/get/cancel/wait` 使用 `board.jobs` 和真实 `AsyncJob`。高级 batch、GPIO 组协议操作，以及 SDK 尚无认领接口的外部资源只读 status 诊断使用公开 `board.raw`，不重新创建、认领外部资源。只有这些入口保留原始提交/受理关联；单个订阅溢出后重建订阅并刷新快照，不关闭其他消费者或整个连接。

WebSocket 握手后可发送 `{type:"observe",visible:true/false}`。所有可见订阅共同驱动一个约 1 秒的只读循环；隐藏、卸载及 socket 关闭撤销需求，慢设备自然延长周期，不重叠读取。观察不申请控制、不消费事件队列、不写操作历史。`resource_observations` 包含 generation、device_id、boot_id、instance、observed_at、quality 与 level；未知、故障、断开或实例变化丢弃旧读数。普通 GPIO 写成功后立即读回；快照变化只刷新结构，不让导航反复进入“待识别”。

浏览器离开或刷新不清理资源。显式“结束实验并断开”及服务正常关闭调用 SDK 连接释放，清理本连接拥有的资源；其他来源不受影响。清理失败保留未知结果并提示重新连接核实，不宣称输出已经停止。

普通在途操作最多 64 个；每订阅者缓冲 128 条。慢订阅者溢出时改发完整重同步快照，不阻塞 SDK 消费者。SQLite 保存脱敏任务状态，默认保留 30 天、最多 10,000 条已结束任务，不淘汰未结束记录。进程重启将未确认任务标为 unknown，不自动重连。

## 状态、数据与恢复

使用 discover 聚合能力、state.snapshot 聚合一致分页；revision=0 参与一致性检查。身份、boot/build/profile/contract 变化后重新发现，旧任务仍作为历史展示，旧句柄不能跨 boot 使用。

资源 definition 是创建配置，不冒充实时状态。resource.call 的确认结果进入独立观测缓存。关闭失败后只读刷新快照，fault 保持占用；recover 重试关闭，不重新打开。

周期 ADC 由显式采样入口启动唯一的后端资源读取任务，每 500ms 最多一次；多个页面共享最多 120 条原始事件。连接结束或一次读取失败即停止消费；不会因通知自动启动读取。连续 ADC/RMT/I²S 保留各自二进制格式，不伪造单位或测量结论。

上传使用服务后台任务串行执行 begin→384 字节 chunk→commit。父任务单独显示字节与校验阶段，子操作保持完整关联；失败只清理本任务已知且仍有权限的上传。未知结果不重发。OTA commit 固定默认 reboot=false。下载分块读取，秘密文件由设备拒绝读回。

## 主要接口

|接口|行为|
|---|---|
|GET /api/device/discover?kind=ble或usb|扫描服务主机候选|
|POST /api/device/connect、/disconnect|显式连接或断开|
|GET /api/device|身份、发现、快照、观测值、采样、同步健康及资源来源|
|POST /api/device/refresh|刷新完整能力和一致状态，不申请控制|
|POST /api/device/operations|`{op,args,generation?,boot_id?,operation_epoch?}`；202 返回服务任务|
|POST /api/device/batches|操作数组；每项独立任务，不保证事务/顺序|
|POST /api/device/stop|独立全局停止|
|GET /api/operations、/{id}|任务分页与详情|
|POST /api/operations/{id}/abort|请求中止本代未进入 commit 的上传|
|WS /api/device/events|首帧完整快照，后续任务/通知/快照带服务 cursor|
|POST /api/device/resources/{id}/sampling?enabled=true或false|显式协调周期 ADC 队列消费|
|POST /api/device/files/upload、/ota/upload|multipart 文件；后端编排进度|
|GET /api/device/files/{name}/download|分块读取非秘密文件|
|POST /api/device/flows/validate|结构化流程本地校验；设备最终裁定|

前端提交携带当前 generation/boot_id/operation_epoch；服务拒绝连接切换后的旧草稿。多步动作冻结同一作用域，上传在读取主机文件后再次检查连接与操作代次。直接脚本省略作用域时表示明确针对当前服务连接。

单项和批量动作参数中的 `data`/`will` 可使用 `{encoding:"text"或"hex"或"base64",value:"..."}`；服务显式转换成 bytes 再交给 SDK。普通 JSON 对象不作为二进制解释。未知字段、长度、范围与完整请求大小最终由 SDK 和设备校验。

日志、实时消息和历史记录过滤 session/control、密码、密钥、证书私钥路径及已知凭据文本。任务不保存原始提交参数。全部模拟设备、测试控制接口和历史能力向量只存在 tests 目录，不进入应用包。

通知为最佳努力提示，state.changed/notifications.gap 只触发共享快照查询，不清空已确认状态。所有快照调用共享一个在途查询，GPIO 状态读取按资源实例合并；等待超时不启动第二个同类在途查询。快速失败进入 recovering 并保留上次确认值，连续失败超过 3 秒才标记不可用；资源读数失败只影响该资源。snapshot_sync 独立记录同步健康与最后成功时间。连接代次、boot 或资源实例变化立即失效旧读数，修改操作使旧读取版本失效，晚到读取不能覆盖新确认值。

浏览器界面由明确动作按钮直接提交，不使用二次确认弹窗。`storage.format` / `system.nvs_format` 的协议确认参数由操作入口按目录描述自动附加，不要求用户再输入文字；HTTP/设备契约及后端确认参数校验继续保留。网络重配置、停止、断开、级联关闭、自动启动和 OTA 上传同样由对应按钮直接执行，结果与错误仍按真实终态反馈。

创建、关闭及写入操作的服务任务完成状态在后续结构快照或 GPIO 读回发布后才写入，避免客户端已经收到完成结果却仍看不到对应资源/确认值。设备动作已确认、但后续查验失败时记录为结果待核实并保留可能已执行的标记，不自动重放写入。
