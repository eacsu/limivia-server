# 共享接线方案 HTTP 接口

此节描述 server 的界面业务接口，不增加 SDK / 固件 JSON-RPC 方法，也不更改跨仓库 v3 线协议。

## GPIO 直接实验与按需保存

普通 GPIO 使用既有操作接口顺序执行控制权获取、`resource.preflight`、`resource.open` 与 `resource.call/status`，无需先写方案。电平切换为 `write` 后 `status`；控制权、设备/boot/代次、资源来源和未知结果仍按原有边界处理。离开或刷新不自动重放、关闭实验。

`POST /api/device/wiring-groups/from-resource` 接收：

```json
{
  "device_id": "目标设备", "boot_id": "当前启动", "generation": 1,
  "revision": 0, "resource": 1, "instance": 1,
  "group_id": "external-led", "name": "外置 LED", "notes": "人工接线记录",
  "plan": {"schema_version": 1, "board": "luatos-esp32c3-usb", "revision": 0, "groups": []}
}
```

接口验证身份、板型、代次及就绪 GPIO 的 ID/instance，再只读 `status`。从设备定义和读回电平生成接线组，在同一事务内比较方案版本、保存完整方案及关联，返回递增版本的 `WiringPlan`。已有组保留供电备注等元数据，运行配置和当前电平以设备为准。当前资源已关联其他组、组已关联其他活动资源、版本或身份不符、资源关闭/故障或无有效读数时拒绝保存。

完全相同的重复请求在其结果版本仍为当前版本时返回相同方案，不新增组或递增版本；后续修改或读回状态变化不能被旧请求覆盖。只读保存不要求取得控制、不转移资源所有权，不发送创建、关闭或电平写入。观察页可记录已有 GPIO，不能因此控制它。未启用的配置继续使用原有 `PUT` 保存；前端明确处理其他未保存修改及服务器版本变化。

## 原有方案接口

- `GET /api/wiring-plans/{device_id}` 读取该设备的共享方案；未保存时 revision 为 0。`PUT` 提交完整方案及读取时的 revision，事务内比较后递增版本；并发旧版本返回 409 / `wiring_conflict`，包含服务器当前方案。接口使用既有页面会话与同源限制，保存时核对当前设备和板型；不需要设备写控制权，也不会提交硬件命令。
- schema_version=1；方案保存 board、title、revision、groups。接线组保存稳定 id、name、kind、pins、config、parent_group、controller、support_pins（物理位置 ID）、notes；接线和供电位置均为人工记录。方案最多 64 组 / 128 KiB，父关系不能缺失或成环。具体能力与电气可用性继续由 SDK / 固件预检决定。
- `POST /api/device/wiring-groups/{group_id}/check` 与 `/apply` 接收 device_id、revision、generation、boot_id，返回既有操作记录。检查不预留；应用需要当前版本已检查、当前页控制权和就绪父总线，内部再次预检后才创建单组资源。编排记录为 `wiring.check` / `wiring.apply`，SDK 步骤作为子记录保留；版本、控制 epoch 或连接改变会停止后续步骤，不自动替换已有资源、回滚输出或重试未知写入。
- `/api/device` 的 `wiring_bindings` 仅发布当前 boot、资源 ID 与 instance 均能由设备快照确认的关联；`wiring_revision` 帮助断线重同步。服务器保存的关联提示不赋予控制权，也不跨启动复用句柄。
- 方案持久化于工作台数据目录的 `wiring.sqlite3`，不写入开发板。WebSocket 的 `wiring.changed` 只通知设备 ID 与新版本，客户端重新读取方案。正在编辑的页面保留本地草稿，显式处理冲突；保存方案不等于设备已应用。
