# LED 单次点击链路拆解（Linux BLE 实机）

日期：2026-10-25。同一B47A板、hci1、SDK/固件0.3.0a4；JSON-RPC v3，正常页面后台观察开启。本轮只点亮、熄灭各一次，没有长测，没有修改产品实现。

## 计时口径

前面的约0.9秒来自100次SDK“write + read”的平均值，不是完整页面点击。此次测量真实Chromium页面，从DOM点击到页面确认输出且操作按钮重新可用；同时关联HTTP平台任务与SDK请求。

临时在127.0.0.1:8001运行相同后端和前端构建，以透明包装记录原函数时间，测完撤下；不记录RPC参数、GATT载荷或会话凭据。首次点亮包含创建资源，随后熄灭使用已有资源。页面确认输出分别为1和0，资源关闭成功，刷新后仍ready。下面是各一次样本，不是均值、P95或光学测量。

## 已有资源：单次熄灭1731ms

|阶段|耗时|实际行为|
|---|---:|---|
|等待在途快照及进入SDK前调度|547ms|点击时后台完整快照尚未结束；前台先等待它完成|
|SDK写操作|299ms|resource.get校验约117ms → resource.call(write)受理约120ms → job.get确认约60ms|
|后端自动回读|300ms|再次resource.get约120ms → resource.call(status)受理约120ms → job.get约60ms|
|前端追加状态读取|330ms|再一次resource.get约150ms → resource.call(status)受理约120ms → job.get约60ms|
|HTTP、轮询、服务端收尾和页面调度余量|255ms|包含前端150ms任务轮询，以及服务端与界面调度；未进一步归因|
|合计|1731ms|从点击到确认状态且按钮恢复|

写入加两次状态读取，共9条设备RPC，其中3次resource.get、3次resource.call、3次job.get。状态读取也是作业式调用：先accepted，再通过job.get取得最终结果，并非单条同步查询。

快照在点击前已启动约92ms，整次快照638ms；只计点击之后剩余的等待，没有把整段快照重复相加。后端回读结束到写任务结束还观察到约106ms间隔，归入最后一行；未单独测到磁盘、推送或事件循环各自占比，不能据此断言SQLite占了106ms。

## 首次点亮：2161ms

首次点亮涉及3个依次完成的HTTP任务：

|平台任务|服务端耗时|内容|
|---|---:|---|
|预检|428ms|mux.preflight，包含与在途观察请求的排队|
|创建资源|1071ms|控制令牌申请、创建作业确认、resource.get，再刷新6页完整快照（快照691ms）|
|读取输出状态|322ms|resource.get → resource.call(status) → job.get|

三个任务服务端耗时合计约1821ms，其余约340ms为HTTP、前端轮询及调度间隔，页面总计2161ms。不能把首次创建时间当作每次已有资源切换时间。

## 已确认的问题

- LedPanel.apply在写入后固定发一次status；后端写操作本身已经通过StateSync.read回读。
- StateSync.read只合并尚未完成的同一次读取；上一读取完成后再调用，会创建新的读取，不复用已确认结果。因此前端追加status确实产生第二次回读。
- SDK AsyncResource.call每次调用前都resource.get校验；本次写入及两次状态读取合计重复校验3次。
- resource.call(status)也经过作业受理和轮询，使两次回读各用3条RPC。
- WorkbenchAPI.wait固定每150ms查平台任务，任务完成不会直接唤醒等待的api.run。

主要优化边界应是复用已确认结果、减少重复往返，并让前台轻量写入避免被完整观察快照长时间阻塞。校验与确认可以在设备端同一次操作内完成；不应仅通过删除回读、缩短轮询间隔或显示目标值来伪装执行成功。本轮只诊断，尚未实施这些优化。

## 证据与代码

原始证据在Git忽略目录artifacts/led-single-action：browser-result.json（点击、HTTP轮询、DOM时间）、server-trace.jsonl（服务端、SDK、作业阶段）、profile_server.py、browser-profile.cjs及截图。SDK后台job.get按唯一在途前台作业的时间窗口关联；会话心跳和后台快照另记，没有算成9条前台RPC。

关键代码：src/web/src/LedPanel.tsx的apply；src/web/src/device.ts的WorkbenchAPI.wait；src/limivia_server/devices/service.py的_run_business；src/limivia_server/devices/sync.py的read/_read。SDK对应limivia/_peripherals.py中的AsyncResource._validate和call。

计时结束后，临时8001实例已停止，正常0.0.0.0:8000实例及测试前LED高电平已恢复。恢复时再次遇到既有BLE重连故障，经重启正常实例、仅重置UGREEN适配器后恢复BLE；这些连接恢复时间不计入点击耗时。
