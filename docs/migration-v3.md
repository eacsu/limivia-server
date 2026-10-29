# v2 工作台迁移至 JSON-RPC v3

这是前后端与 SDK 契约的同步升级，不保留旧网页包络、旧 SDK 或按引脚命令的兼容层。

## 安装与客户端

按 README 先安装服务依赖，再通过项目 `.venv` 的 pip 安装已核验的 SDK 0.3.0a3 wheel。本轮按用户要求从 TOML/Poetry 锁中移除 limivia。相同版本的历史自定义 v3 wheel 不兼容，核对 `doctor` 的导入位置、来源 SHA256 和 `limivia-v3-jsonrpc2`。

重新构建前端并整页刷新浏览器。旧 `/api/device/connect` WebSocket、`v/id/op/params` 帧、session/control 字段和按字符串 error.code 分支均失效；新客户端使用 HTTP 业务任务和 `/api/device/events` 类型化消息。

## 接口与行为

|旧行为|新行为|
|---|---|
|每页面占有 SDK 会话，页面退出关闭链路|服务生命周期持有单设备连接，多页面观察|
|连接时申请控制|连接后即可使用，SDK 在写入前自动协调协议令牌|
|浏览器等待单条 RPC 完成|202 operation ID；普通业务 running→高层接口确认终态，显式 Job/高级批量保留真实作业语义|
|gpio.set/pwm.set/adc.start 等按引脚命令|resource.preflight/open→call→close/recover，句柄来自设备结果|
|单页 state 当完整状态|SDK state.snapshot 一致分页；revision=0 也检查|
|采样通知即样本|data.available 仅提示，显式协调队列读取|
|error.code 字符串|code 为整数或 null，业务分支读取 reason|
|取消请求成功即取消实验|继续等待原 job 终态|
|从创建配置推断当前电平|独立保存设备 read/status 结果|
|断线重发或恢复输出|只读同步；写操作未知时显式查询，绝不自动重放|

事件首帧为完整快照与近期任务，后续带服务 cursor。通知缺口通过只读刷新恢复；慢页面接收重同步快照。SDK session、control、wire ID 和 seq 不进入浏览器业务接口。

## 历史与句柄

旧仓库没有数据库或持久化的引脚任务，无数据库迁移需要。新版创建 schema v1 的本地 SQLite；服务重启将未结束任务标记为未知，旧设备/boot 记录仍可阅读，但不在新 boot 复用资源、buffer、upload、flow 或 job ID。

旧临时表单中的引脚参数不自动变成新资源，不执行旧动作。流程文件使用 schema version:1，这与被拒绝的线协议 v1 无关；默认 autostart=false。

仅同步已存在的冻结 v3 契约，没有改变固件 wire 语义。固件仓库已拥有相同协议来源，本轮不修改其实现或执行硬件操作。
