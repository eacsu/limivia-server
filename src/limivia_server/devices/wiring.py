"""共享接线意图；硬件能力、校验和执行继续由 SDK / 固件负责。"""

from __future__ import annotations

import copy
import json
import sqlite3
from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from .catalog import KINDS
from .store import TERMINAL


class WiringGroup(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    name: str = Field(min_length=1, max_length=80)
    kind: str = ""
    pins: dict[str, int] = Field(default_factory=dict)
    config: dict[str, JsonValue] = Field(default_factory=dict)
    parent_group: str | None = None
    controller: int | None = Field(default=None, ge=0)
    support_pins: list[str] = Field(default_factory=list, max_length=32)
    notes: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def known_kind(self):
        if self.kind and self.kind not in KINDS:
            raise ValueError("未知的资源功能。")
        if any(type(pin) is not int or not 0 <= pin <= 63 for pin in self.pins.values()):
            raise ValueError("引脚映射必须为 GPIO 编号。")
        if any(p not in {f"{s}{i}" for s in "LR" for i in range(1, 17)} for p in self.support_pins):
            raise ValueError("供电接线必须使用物理位置 ID。")
        return self


class WiringPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    board: str = Field(min_length=1, max_length=100)
    revision: int = Field(ge=0)
    title: str = Field(default="我的接线实验", min_length=1, max_length=100)
    groups: list[WiringGroup] = Field(default_factory=list, max_length=64)

    @model_validator(mode="after")
    def relationships(self):
        groups = {g.id: g for g in self.groups}
        if len(groups) != len(self.groups):
            raise ValueError("接线组 ID 不能重复。")
        for group in self.groups:
            seen = {group.id}
            parent = group.parent_group
            while parent:
                if parent not in groups or parent in seen:
                    raise ValueError("父总线不存在或形成循环。")
                seen.add(parent)
                parent = groups[parent].parent_group
        if (
            len(json.dumps(self.model_dump(), ensure_ascii=False, allow_nan=False).encode())
            > 131072
        ):
            raise ValueError("接线方案不能超过 128 KiB。")
        return self


class GroupOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: str
    operation_epoch: int | None = None
    revision: int = Field(ge=0)
    generation: int
    boot_id: str


class SaveResourceInput(GroupOperation):
    resource: int = Field(gt=0)
    instance: int = Field(gt=0)
    group_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    name: str = Field(min_length=1, max_length=80)
    notes: str = Field(default="", max_length=2000)
    plan: WiringPlan


class WiringStore:
    def __init__(self, path: Path):
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS plans (device TEXT PRIMARY KEY, data TEXT)")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS bindings (device TEXT, group_id TEXT, data TEXT, PRIMARY KEY(device,group_id))"
        )
        self.db.commit()

    def get(self, device: str, board: str | None = None):
        row = self.db.execute("SELECT data FROM plans WHERE device=?", (device,)).fetchone()
        return (
            json.loads(row[0])
            if row
            else WiringPlan(board=board or "unknown", revision=0).model_dump()
        )

    def save(self, device: str, plan: WiringPlan, association=None):
        # 同一数据库事务内比较并更新；跨进程亦不会覆盖旧版本。
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            old = self.get(device, plan.board)
            if association and old["revision"] == plan.revision + 1:
                group_id, binding = association
                existing = self.bindings(device).get(group_id)
                if existing == {**binding, "plan_revision": old["revision"]} and old == {
                    **plan.model_dump(),
                    "revision": old["revision"],
                }:
                    return old
            if old["revision"] != plan.revision:
                raise HTTPException(409, {"reason": "wiring_conflict", "current": old})
            if old["revision"] and old["board"] != plan.board:
                raise HTTPException(409, "方案板型不能改变。")
            value = plan.model_dump()
            value["revision"] += 1
            self.db.execute(
                "INSERT OR REPLACE INTO plans VALUES (?,?)",
                (device, json.dumps(value, ensure_ascii=False)),
            )
            if association:
                group_id, binding = association
                self.db.execute(
                    "INSERT OR REPLACE INTO bindings VALUES (?,?,?)",
                    (device, group_id, json.dumps({**binding, "plan_revision": value["revision"]})),
                )
        return value

    def bind(self, device, group_id, value):
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO bindings VALUES (?,?,?)",
                (device, group_id, json.dumps(value)),
            )

    def bindings(self, device):
        return {
            row[0]: json.loads(row[1])
            for row in self.db.execute(
                "SELECT group_id,data FROM bindings WHERE device=?", (device,)
            )
        }

    def close(self):
        self.db.close()


def active_bindings(service):
    identity = service.state.get("identity") or {}
    if not identity or not service.wiring:
        return {}
    resources = (service.state.get("snapshot") or {}).get("resources", [])
    groups = {g["id"] for g in service.wiring.get(identity["device_id"])["groups"]}
    return {
        key: value
        for key, value in service.wiring.bindings(identity["device_id"]).items()
        if key in groups
        and value["boot_id"] == identity["boot_id"]
        and any(
            r["id"] == value["resource"] and r["instance"] == value["instance"] for r in resources
        )
    }


async def save_resource_group(service, body: SaveResourceInput, page):
    def target():
        identity = service.state.get("identity") or {}
        if (identity.get("device_id"), identity.get("boot_id"), service.generation) != (
            body.device_id,
            body.boot_id,
            body.generation,
        ) or body.plan.board != identity.get("board"):
            raise HTTPException(409, "目标设备、启动、板型或连接代次已改变。")
        resource = next(
            (
                r
                for r in (service.state.get("snapshot") or {}).get("resources", [])
                if r["id"] == body.resource and r["instance"] == body.instance
            ),
            None,
        )
        if not resource or resource["kind"] != "gpio" or resource["state"] != "ready":
            raise HTTPException(409, "GPIO 资源已改变或尚未就绪，请重新读取。")
        for group_id, binding in active_bindings(service).items():
            same = binding["resource"] == body.resource and binding["instance"] == body.instance
            if (same and group_id != body.group_id) or (group_id == body.group_id and not same):
                raise HTTPException(409, "资源或接线组已有其他关联，请核对方案。")
        return resource

    if body.revision != body.plan.revision:
        raise HTTPException(409, "方案版本不一致。")
    target()
    reading = await service.execute(
        "resource.call", {"resource": body.resource, "action": "status", "args": {}}, page
    )
    resource = target()
    level = (reading.get("result") or {}).get("level")
    if type(level) is not int or level not in (0, 1):
        raise HTTPException(409, "尚未取得有效电平，未保存方案。")
    definition = copy.deepcopy(resource["definition"])
    definition["config"] = {**definition.get("config", {}), "level": level}
    groups = [g.model_dump() for g in body.plan.groups]
    old = next((g for g in groups if g["id"] == body.group_id), {})
    group = WiringGroup.model_validate(
        {
            **old,
            "id": body.group_id,
            "name": body.name,
            "notes": body.notes,
            "kind": "gpio",
            "pins": definition["pins"],
            "config": definition["config"],
            "parent_group": None,
            "controller": None,
        }
    ).model_dump()
    groups = [group if g["id"] == body.group_id else g for g in groups]
    if not old:
        groups.append(group)
    plan = WiringPlan.model_validate({**body.plan.model_dump(), "groups": groups})
    value = service.wiring.save(
        body.device_id,
        plan,
        (
            body.group_id,
            {
                "boot_id": body.boot_id,
                "resource": body.resource,
                "instance": body.instance,
                "definition": definition,
            },
        ),
    )
    service.wiring_checked = None
    service.emit("wiring.changed", {"device_id": body.device_id, "revision": value["revision"]})
    service.changed()
    return value


def group_definition(service, body, group_id):
    identity = service.state.get("identity") or {}
    if (identity.get("device_id"), identity.get("boot_id"), service.generation) != (
        body.device_id,
        body.boot_id,
        body.generation,
    ):
        raise HTTPException(409, "目标设备、启动或连接代次已改变。")
    plan = service.wiring.get(body.device_id)
    if plan["revision"] != body.revision or plan["board"] != identity.get("board"):
        raise HTTPException(409, "方案已改变，请先保存并重新检查本组。")
    group = next((g for g in plan["groups"] if g["id"] == group_id), None)
    if not group or not group["kind"]:
        raise HTTPException(422, "请先选择功能并保存接线组。")
    if group_id in active_bindings(service):
        raise HTTPException(409, "本组已有运行配置；请先核对并显式关闭原资源，不能自动替换。")
    definition = {k: copy.deepcopy(group[k]) for k in ("kind", "pins", "config")}
    if group["controller"] is not None:
        definition["controller"] = group["controller"]
    if group["parent_group"]:
        parent = active_bindings(service).get(group["parent_group"])
        if not parent:
            raise HTTPException(409, "请先应用所属总线。")
        resource = next(
            r for r in service.state["snapshot"]["resources"] if r["id"] == parent["resource"]
        )
        if resource["state"] != "ready":
            raise HTTPException(409, "所属总线尚未就绪。")
        definition["parent"] = parent["resource"]
    return definition


async def start_group_operation(service, body, group_id, page, apply=False):
    service.authorize("resource.open" if apply else "resource.preflight", page)
    definition = group_definition(service, body, group_id)
    if any(
        t["op"].startswith("wiring.") and t["status"] not in TERMINAL
        for t in service.tasks.values()
    ):
        raise HTTPException(409, "请等待当前接线组操作确认。")
    checked = (
        body.device_id,
        body.generation,
        body.boot_id,
        body.revision,
        group_id,
        service.operation_epoch,
    )
    if apply and service.wiring_checked != checked:
        raise HTTPException(409, "请先检查当前版本的本组接线。")
    task = service.new_task("wiring.apply" if apply else "wiring.check", page)
    task.update(status="submitted", result={"group_id": group_id, "plan_revision": body.revision})
    service.save(task)
    service.spawn(
        run_group_operation(service, body, group_id, definition, checked, task, page, apply)
    )
    return task


async def run_group_operation(service, body, group_id, definition, checked, task, page, apply):
    async def run(op, args):
        if service.generation != body.generation or service.operation_epoch != checked[-1]:
            raise HTTPException(409, "连接已改变或设备已停止，停止后续步骤。")
        return await service.execute(op, args, page, parent=task["id"])

    try:
        await run("resource.preflight", definition)
        if apply:
            # 在预检等待期间方案可能被其他页面编辑，写入前再次比较版本。
            group_definition(service, body, group_id)
            opened = await run("resource.open", definition)
            resource = (opened.get("job") or {}).get("resource") or (
                opened.get("result") or {}
            ).get("resource")
            if not resource:
                raise HTTPException(409, "资源可能已创建，尚未取得句柄，请查询设备状态。")
            current = await run("resource.get", {"resource": resource})
            instance = (current.get("result") or {}).get("instance")
            if not isinstance(instance, int) or instance < 1:
                raise HTTPException(409, "资源已创建但实例尚未确认，请查询设备状态。")
            binding = {
                "boot_id": body.boot_id,
                "resource": resource,
                "instance": instance,
                "definition": definition,
                "plan_revision": body.revision,
            }
            service.wiring.bind(body.device_id, group_id, binding)
            task["result"].update(binding)
            service.wiring_checked = None
            service.changed()
        else:
            service.wiring_checked = checked
        task["status"] = "completed"
    except Exception as exc:  # noqa: BLE001 — 编排边界统一记录，绝不自动回滚或重试写入。
        children = [t for t in service.tasks.values() if t["parent"] == task["id"]]
        possible = any(
            t["op"] == "resource.open"
            and (t["status"] in {"completed", "unknown"} or t["external_effect_possible"])
            for t in children
        )
        task.update(
            status="unknown" if possible else "failed",
            external_effect_possible=possible,
            error={
                "reason": "wiring_unconfirmed",
                "message": str(exc.detail)
                if isinstance(exc, HTTPException)
                else "本组操作未确认，请核对设备状态。",
                "may_have_executed": possible,
            },
        )
        service.wiring_checked = None
    finally:
        service.save(task)
        service._wake(task)
