"""工作台业务目录；命令类型真源是 SDK 公开 Operation，能力与范围由设备发现提供。"""

from __future__ import annotations

import inspect
from typing import get_args

from limivia.types import Operation, ResourceKind

OPERATIONS = get_args(Operation.__value__)
KINDS = get_args(ResourceKind.__value__)
INTERNAL = {
    "hello",
    "control.acquire",
    "control.release",
    "session.ping",
    "event.subscribe",
    "event.unsubscribe",
    "capabilities",
    "state",
}
OBSERVE = {
    "capabilities",
    "state",
    "diagnostics",
    "mux.query",
    "mux.preflight",
    "resource.preflight",
    "resource.get",
    "job.get",
    "flow.list",
    "flow.get",
    "gpio.group.read",
}
DESTRUCTIVE = {"storage.format": "erase_littlefs", "system.nvs_format": "erase_nvs"}
GROUPS = {
    "storage": "板上文件",
    "ota": "固件更新",
    "wifi": "板上 Wi-Fi",
    "mqtt": "板上 MQTT",
    "espnow": "ESP-NOW",
    "power": "低功耗",
    "system": "系统维护",
    "flow": "离线流程",
    "buffer": "二进制缓存",
    "gpio": "GPIO 组操作",
    "rmt": "RMT 同步",
    "resource": "资源",
    "mux": "引脚与占用",
    "job": "设备作业",
    "control": "控制权",
}
LABELS = {
    "status": "读取状态",
    "list": "读取列表",
    "configure": "应用配置",
    "get": "查询详情",
    "read": "读取",
    "write": "写入",
    "create": "创建",
    "delete": "删除",
    "format": "格式化",
    "begin": "开始上传",
    "chunk": "上传分块",
    "commit": "校验并提交",
    "abort": "中止",
    "scan": "扫描",
    "maintenance": "维护 AP",
    "disconnect": "断开",
    "publish": "发布消息",
    "subscribe": "订阅主题",
    "unsubscribe": "取消订阅",
    "receive": "读取接收队列",
    "start": "启动",
    "stop": "停止",
    "peer": "配置对端",
    "remove": "移除",
    "send": "发送",
    "sleep": "进入睡眠",
    "info": "系统信息",
    "time": "设备时间",
    "restart": "重启设备",
    "nvs_format": "清空 NVS",
    "record": "写入 JSON",
    "append": "追加 JSONL",
    "load": "加载",
    "pause": "暂停",
    "resume": "继续",
    "cancel": "请求取消",
    "acquire": "取得控制",
    "release": "释放控制",
    "sync": "同步发射",
    "group.read": "组读取",
    "group.write": "组写入",
}


def catalog(connection) -> list[dict]:
    """从公开门面的签名取得字段名，补充中文业务语义；不导入 SDK 私有 schema。"""
    result = []
    for op in OPERATIONS:
        prefix, _, action = op.partition(".")
        method_name = {
            "capabilities": "retrieve",
            "state": "retrieve",
            "diagnostics": "retrieve",
        }.get(op, action.replace(".", "_"))
        facade = getattr(connection, prefix, None)
        method = getattr(facade, method_name, None)
        fields = []
        if method:
            for name, parameter in inspect.signature(method).parameters.items():
                if name in {"self", "kwargs"}:
                    continue
                fields.append(
                    {"name": name, "required": parameter.default is inspect.Parameter.empty}
                )
        result.append(
            {
                "op": op,
                "group": GROUPS.get(prefix, "连接与发现"),
                "label": LABELS.get(action, op),
                "fields": fields,
                "observer": op in OBSERVE,
                "internal": op in INTERNAL,
                "confirmation": DESTRUCTIVE.get(op),
            }
        )
    return result
