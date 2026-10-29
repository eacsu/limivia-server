from __future__ import annotations

import hashlib
import json
import math
import re

from fastapi import HTTPException
from limivia.types import BinaryResult

from .catalog import KINDS

FLOW_OPS = {"call", "service", "await", "delay", "set", "add", "if", "loop", "sleep", "end"}
SERVICES = {
    "storage.record",
    "storage.append",
    "mqtt.publish",
    "espnow.send",
    "system.time",
    "wifi.status",
    "mqtt.status",
}


def filename(name):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,47}", name):
        raise HTTPException(422, "文件名限 48 个 ASCII 字母数字、点、横线或下划线，不能以点开头。")
    return name


def validate_flow(definition, profile=None):
    errors = []
    if not isinstance(definition, dict):
        return {"valid": False, "errors": ["流程必须为 JSON 对象。"], "bytes": 0}
    if type(definition.get("version")) is not int or definition["version"] != 1:
        errors.append("流程 schema version 必须为 1。")
    if not isinstance(definition.get("profile"), str) or not definition["profile"]:
        errors.append("请选择流程 profile。")
    elif profile and definition["profile"] != profile:
        errors.append("流程 profile 与设备不匹配。")
    if type(definition.get("autostart", False)) is not bool:
        errors.append("autostart 必须为布尔值。")
    if set(definition) - {
        "version",
        "profile",
        "autostart",
        "resources",
        "variables",
        "steps",
        "repeat_ms",
    }:
        errors.append("流程包含未知顶层字段。")
    if "repeat_ms" in definition and (
        type(definition["repeat_ms"]) is not int or not 1 <= definition["repeat_ms"] <= 86400000
    ):
        errors.append("重复间隔需为 1..86400000 ms。")
    if "resources" not in definition or "steps" not in definition:
        errors.append("流程必须包含 resources 和 steps 数组。")
    resources, variables, steps = (
        definition.get(k, default)
        for k, default in [("resources", []), ("variables", {}), ("steps", [])]
    )
    if not isinstance(resources, list) or len(resources) > 12:
        errors.append("每流程最多 12 个资源。")
        resources = []
    if not isinstance(variables, dict) or len(variables) > 8:
        errors.append("每流程最多 8 个数值变量。")
        variables = {}
    if not isinstance(steps, list) or not 1 <= len(steps) <= 64:
        errors.append("流程需要 1–64 个步骤。")
        steps = []
    names = set()
    for item in resources:
        if not isinstance(item, dict):
            errors.append("资源声明必须为对象。")
            continue
        if not isinstance(item.get("kind"), str) or item["kind"] not in KINDS:
            errors.append("资源 kind 不在当前 v3 公开类型中。")
        if not isinstance(item.get("pins"), dict) or not isinstance(item.get("config"), dict):
            errors.append("资源 pins 和 config 必须为对象。")
        if set(item) - {"name", "kind", "parent", "controller", "pins", "config"}:
            errors.append("资源声明包含未知字段。")
        name = item.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,24}", name):
            errors.append("资源符号名需为 1–24 个字母数字或下划线。")
        elif name in names:
            errors.append("资源符号名不能重复。")
        if item.get("parent") and (
            not isinstance(item["parent"], str) or item["parent"] not in names
        ):
            errors.append("父资源必须先声明。")
        if isinstance(name, str):
            names.add(name)
    for name, value in variables.items():
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,24}", name):
            errors.append("变量名称限 1–24 个 ASCII 字母数字、点、横线或下划线。")
        if type(value) not in (int, float) or not math.isfinite(value):
            errors.append(f"变量 {name} 必须为有限数值。")

    def references(value, depth=0):
        if depth > 16:
            errors.append("流程参数嵌套超过 16 层。")
            return
        if isinstance(value, dict):
            if "$var" in value and (
                not isinstance(value["$var"], str)
                or value["$var"] not in variables
                or len(value) != 1
            ):
                errors.append("步骤引用了未声明变量。")
            if "$result" in value and (
                not isinstance(value["$result"], str)
                or len(value) != 1
                or not re.fullmatch(r"[A-Za-z0-9_.-]{1,32}", value["$result"])
            ):
                errors.append("结果字段引用必须为字符串。")
            for item in value.values():
                references(item, depth + 1)
        elif isinstance(value, list):
            for item in value:
                references(item, depth + 1)

    for i, step in enumerate(steps):
        prefix = f"步骤 {i + 1}："
        if (
            not isinstance(step, dict)
            or not isinstance(step.get("op"), str)
            or step["op"] not in FLOW_OPS
        ):
            errors.append(prefix + "未知步骤类型。")
            continue
        op = step["op"]
        if op in {"call", "await"}:
            if (
                not {"resource", "action", "args", "timeout_ms"}.issubset(step)
                or not isinstance(step.get("resource"), str)
                or step["resource"] not in names
            ):
                errors.append(prefix + "需要已声明资源、action、args 和 timeout_ms。")
            if op == "await" and not {"field", "poll_ms"}.issubset(step):
                errors.append(prefix + "await 需要 field 和 poll_ms。")
        if op == "service" and (
            not isinstance(step.get("action"), str) or step["action"] not in SERVICES
        ):
            errors.append(prefix + "service 不在设备白名单中。")
        if op in {"set", "add"} and (
            not isinstance(step.get("variable"), str) or step["variable"] not in variables
        ):
            errors.append(prefix + "变量未声明。")
        if op == "delay" and (type(step.get("ms")) is not int or step["ms"] <= 0):
            errors.append(prefix + "等待时间需为正整数。")
        allowed = {
            "op",
            "resource",
            "action",
            "args",
            "timeout_ms",
            "on_error",
            "store",
            "field",
            "poll_ms",
            "ms",
            "variable",
            "value",
            "compare",
            "then",
            "else",
            "count",
            "target",
            "duration_ms",
            "wake_pin",
            "wake_level",
        }
        if set(step) - allowed:
            errors.append(prefix + "含有未知字段。")
        if op in {"call", "await", "service"}:
            if not isinstance(step.get("args"), dict) or not isinstance(step.get("action"), str):
                errors.append(prefix + "action 必须为文本，args 必须为对象。")
            if type(step.get("timeout_ms")) is not int or not 1 <= step["timeout_ms"] <= 3600000:
                errors.append(prefix + "timeout_ms 需为 1..3600000。")
            if step.get("store") is not None and (
                not isinstance(step["store"], str) or step["store"] not in variables
            ):
                errors.append(prefix + "保存结果的变量未声明。")
        if op == "await" and (
            type(step.get("poll_ms")) is not int or not 1 <= step["poll_ms"] <= 60000
        ):
            errors.append(prefix + "poll_ms 需为 1..60000。")
        if op in {"set", "add", "if"}:
            if (
                not isinstance(step.get("variable"), str)
                or step["variable"] not in variables
                or type(step.get("value")) not in (int, float)
            ):
                errors.append(prefix + "需要已声明变量和数值。")
            if op == "if" and (
                not isinstance(step.get("compare"), str)
                or step["compare"] not in {"eq", "ne", "lt", "le", "gt", "ge"}
            ):
                errors.append(prefix + "比较符需为 eq/ne/lt/le/gt/ge。")
        if op == "loop" and (
            type(step.get("count")) is not int or not 1 <= step["count"] <= 100000
        ):
            errors.append(prefix + "有限循环次数需为 1..100000。")
        if op == "sleep" and (
            type(step.get("duration_ms")) is not int or not 1 <= step["duration_ms"] <= 86400000
        ):
            errors.append(prefix + "睡眠时长需为 1..86400000 ms。")
        for key in ("then", "else", "target", "on_error"):
            if key not in step:
                continue
            target = step[key]
            maximum = i - 1 if key == "target" and op == "loop" else len(steps)
            if type(target) is not int or not 0 <= target <= maximum:
                errors.append(prefix + f"{key} 跳转索引越界。")
        references(step)
    # 等待节点切断 CPU 环；有限 loop 的回边有界，不能一概拒绝。
    visiting, visited = set(), set()

    def visit(index):
        if index == len(steps) or index in visited:
            return True
        if index in visiting:
            return False
        if not 0 <= index < len(steps) or not isinstance(steps[index], dict):
            return True
        step = steps[index]
        if not isinstance(step.get("op"), str) or step["op"] in {"delay", "await", "sleep", "end"}:
            return True
        visiting.add(index)
        edges = (
            [step.get("then", index + 1), step.get("else", index + 1)]
            if step.get("op") == "if"
            else [index + 1]
        )
        if "on_error" in step:
            edges.append(step["on_error"])
        valid = all(visit(target) for target in edges if type(target) is int)
        visiting.remove(index)
        visited.add(index)
        return valid

    if any(not visit(index) for index in range(len(steps))):
        errors.append("条件或错误分支形成无等待 CPU 循环。")
    try:
        size = len(
            json.dumps(
                definition, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode()
        )
    except (TypeError, ValueError, RecursionError):
        errors.append("流程内容不能序列化为严格 JSON。")
        size = 0
    if size > 16384:
        errors.append("流程文件超过 16 KiB。")
    return {"valid": not errors, "errors": errors, "bytes": size}


async def start_upload(service, file, name, page, *, secret=False, profile=None):
    filename(name)
    prefix = "ota" if profile is not None else "storage"
    service.authorize(prefix + ".begin", page)
    generation, epoch = service.generation, service.operation_epoch
    data = await file.read(16 * 1024 * 1024 + 1)
    await file.close()
    if generation != service.generation or epoch != service.operation_epoch:
        raise HTTPException(409, "连接代次已改变，请重新核对上传目标。")
    service.authorize(prefix + ".begin", page)
    if not data or len(data) > 16 * 1024 * 1024:
        raise HTTPException(422, "上传文件需为 1 字节至 16 MiB。")
    if name.endswith(".flow.json") and not secret and prefix == "storage":
        try:
            checked = validate_flow(json.loads(data), service.state["identity"]["profile"])
        except (ValueError, RecursionError) as exc:
            raise HTTPException(422, "流程文件不是有效 JSON。") from exc
        if not checked["valid"]:
            raise HTTPException(422, checked)
    if any(
        t["op"] == prefix + ".upload"
        and t["status"] not in {"completed", "failed", "cancelled", "unknown"}
        for t in service.tasks.values()
    ):
        raise HTTPException(409, "当前已有本服务上传任务，请先等待或中止。")
    task = service.new_task(prefix + ".upload", page)
    task.update(
        status="submitted",
        progress={
            "phase": "begin",
            "bytes": 0,
            "total": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        },
    )
    service.save(task)
    service.spawn(upload_bytes(service, task, data, name, page, epoch, prefix, secret, profile))
    return task


async def upload_bytes(
    service, task, data, name, page, epoch, prefix="storage", secret=False, profile=None
):
    upload_id = None
    try:
        args = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        if prefix == "storage":
            args.update(name=name, secret=secret)
        else:
            args.update(board=service.state["identity"]["board"], protocol=3, profile=profile)

        async def run(op, params):
            if task["generation"] != service.generation or epoch != service.operation_epoch:
                raise HTTPException(409, "连接代次已改变，上传不能继续。")
            return await service.execute(op, params, page, parent=task["id"])

        begun = await run(prefix + ".begin", args)
        upload_id = begun["result"]["upload_id"]
        task["progress"].update(phase="uploading", upload_id=upload_id)
        for offset in range(0, len(data), 384):
            if task.get("cancel_requested"):
                await run(prefix + ".abort", {"upload_id": upload_id})
                task["status"] = "cancelled"
                return
            await run(
                prefix + ".chunk",
                {"upload_id": upload_id, "offset": offset, "data": data[offset : offset + 384]},
            )
            task["progress"]["bytes"] = min(offset + 384, len(data))
            service.save(task)
        if task.get("cancel_requested"):
            await run(prefix + ".abort", {"upload_id": upload_id})
            task["status"] = "cancelled"
            return
        task["progress"]["phase"] = "verifying"
        service.save(task)
        params = {"upload_id": upload_id}
        if prefix == "ota":
            params["reboot"] = False
        committed = await run(prefix + ".commit", params)
        task.update(status="completed", result=committed["result"])
        task["progress"]["phase"] = "committed"
    except Exception:  # noqa: BLE001 — 记录任务/连接失败，不向外输出敏感异常。
        unknown = any(
            t["parent"] == task["id"] and t["status"] == "unknown" for t in service.tasks.values()
        )
        task.update(
            error={
                "reason": "transfer_interrupted",
                "message": "传输未确认完成，请核对设备上传状态。",
                "may_have_executed": unknown,
            },
        )
        if upload_id and not unknown and task["generation"] == service.generation:
            try:
                await service.execute(
                    prefix + ".abort", {"upload_id": upload_id}, page, parent=task["id"]
                )
            except Exception:  # noqa: BLE001 — 记录任务/连接失败，不向外输出敏感异常。
                task["error"]["cleanup_pending"] = True
        elif upload_id:
            task["error"]["cleanup_pending"] = True
        task["status"] = "unknown" if unknown else "failed"
    finally:
        service.save(task)
        service._wake(task)


async def download_file(service, name, page):
    filename(name)
    generation = service.generation
    content = bytearray()
    while len(content) <= 16 * 1024 * 1024:
        if generation != service.generation:
            raise HTTPException(409, "连接已改变，请重新开始下载。")
        task = await service.execute(
            "storage.read", {"name": name, "offset": len(content), "length": 384}, page
        )
        chunk = BinaryResult.model_validate(task["result"]).to_bytes()
        content.extend(chunk)
        if len(chunk) < 384:
            return bytes(content)
    raise HTTPException(413, "文件超过工作台下载上限。")
