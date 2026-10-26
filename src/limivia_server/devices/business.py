"""SDK a2 业务对象到工作台 HTTP 结果的适配；不复制传输、作业轮询或释放逻辑。"""

from __future__ import annotations

import asyncio
import base64
from typing import Any

from limivia import (
    AsyncADCInput,
    AsyncConnection,
    AsyncGPIOPin,
    AsyncPWMOutput,
    AsyncUARTPort,
    OperationError,
    ResultUnknownError,
)


def result_data(value: Any) -> dict:
    if value is None:
        return {}
    if isinstance(value, bytes):
        return {"data": base64.b64encode(value).decode(), "length": len(value)}
    if hasattr(value, "data"):
        return value.data
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return value


class BusinessConnection:
    def __init__(self, board: AsyncConnection):
        self.board = board
        self.resources = {}
        self.jobs = {}
        self.snapshot_reader = None
        self.resource_lookup = None

    def wire_args(self, op, args):
        """高级入口从现有资源身份补齐 r2 实例，页面无需管理 SDK 实例号。"""
        args = dict(args)

        def instance(resource_id):
            owned = self.resources.get(resource_id)
            info = (
                owned.info.model_dump(mode="json")
                if owned and owned.info
                else (self.resource_lookup(resource_id) if self.resource_lookup else None)
            )
            if not info:
                raise ValueError("资源不在当前快照中，请先刷新状态。")
            return info["instance"]

        if op in {"resource.call", "resource.close", "resource.recover"}:
            args.setdefault("instance", instance(args["resource"]))
        if op in {"resource.open", "resource.preflight", "mux.preflight"} and args.get("parent"):
            args.setdefault("parent_instance", instance(args["parent"]))
        if op in {"gpio.group.read", "gpio.group.write", "rmt.sync"}:
            items = [
                {"resource": item} if isinstance(item, int) else dict(item)
                for item in args["resources"]
            ]
            for item in items:
                item.setdefault("instance", instance(item["resource"]))
            args["resources"] = items
        return args

    async def open(self, args):
        kind, pins, config = args["kind"], args["pins"], dict(args["config"])
        if set(args) - {"kind", "pins", "config", "parent", "controller"}:
            raise ValueError("资源定义包含未知字段。")
        parent_id = args.get("parent")
        parent = self.resources.get(parent_id)
        if parent_id and not parent:
            raise ValueError("父资源不属于当前业务连接，不能重新创建或认领。")
        if parent_id or "controller" in args:
            resource = self.board.resources.open(
                kind,
                pins=pins,
                config=config,
                parent=parent,
                **({"controller": args["controller"]} if "controller" in args else {}),
            )
        elif kind == "gpio":
            if set(pins) != {"pin"}:
                raise ValueError("GPIO 需要唯一的 pin 角色。")
            mode = config.pop("mode", "input")
            if mode not in {"input", "output", "open_drain"}:
                raise ValueError("GPIO 模式无效。")
            level = config.pop("level", 0)
            resource = (
                self.board.gpio.input(pins["pin"], **config)
                if mode == "input"
                else self.board.gpio.output(
                    pins["pin"], value=level, open_drain=mode == "open_drain", **config
                )
            )
        elif kind == "pwm":
            resource = self.board.pwm.open(pins["pin"], **config)
        elif kind == "adc":
            resource = self.board.adc.open(pins["pin"], **config)
        elif kind == "uart":
            resource = self.board.uart.open(**pins, **config)
        else:
            resource = self.board.resources.open(
                kind,
                pins=pins,
                config=config,
                parent=parent,
                **({"controller": args["controller"]} if "controller" in args else {}),
            )
        await resource.open()
        info = resource.info
        if info is None:
            raise RuntimeError("SDK 未提供已确认的资源身份。")
        self.resources[info.id] = resource
        initial = resource.initial_state
        return {
            "resource": info.id,
            "instance": info.instance,
            "info": info.model_dump(mode="json"),
            **(initial.data if initial else {}),
        }

    async def info(self, resource_id):
        snapshot = await self.snapshot_reader()
        info = next((r for r in snapshot["resources"] if r["id"] == resource_id), None)
        if info is None:
            raise ValueError("资源不存在或已释放。")
        return info

    async def call(self, resource_id, action, args):
        resource = self.resources.get(resource_id)
        if resource is None:
            # SDK a3 没有认领已有资源的高层工厂；外部资源只允许公开 raw 只读诊断。
            if action != "status" or args:
                raise ValueError("不能操作不属于当前业务连接的资源。")
            return await self.raw_result(
                "resource.call",
                resource=resource_id,
                action="status",
                args={},
            )
        if action == "status":
            return result_data(await resource.status())
        if isinstance(resource, AsyncGPIOPin):
            if action == "write":
                return result_data(await resource.write(args["level"]))
            if action == "read":
                return {"level": await resource.read()}
        if isinstance(resource, AsyncPWMOutput):
            if action == "duty":
                return result_data(await resource.set_duty(args["duty"]))
            if action == "fade":
                return result_data(await resource.fade(**args))
        if isinstance(resource, AsyncADCInput):
            if action == "read":
                return result_data(await resource.read())
            if action == "events":
                return {
                    "events": [sample.model_dump(mode="json") for sample in await resource.events()]
                }
        if isinstance(resource, AsyncUARTPort):
            if action == "write":
                return {"written": await resource.write(**args)}
            if action == "read":
                return result_data(await resource.read(**args))
        return result_data(await resource.call(action, **args))

    async def raw_result(self, op, **args):
        """仅用于没有高层门面的协议诊断和高级 GPIO 组操作。"""
        args = self.wire_args(op, args)
        prefix, _, method = op.partition(".")
        async with self.board.raw.subscribe() as events:
            request_id = await getattr(getattr(self.board.raw, prefix), method.replace(".", "_"))(
                **args
            )
            try:
                async with asyncio.timeout(30):
                    async for event in events:
                        if getattr(event, "request_id", None) != request_id:
                            continue
                        if event.type == "job.completed":
                            return result_data(event.job.result)
                        if event.type.endswith(".completed"):
                            return result_data(event.result)
                        if event.type in {"command.failed", "job.failed", "job.cancelled"}:
                            raise OperationError(
                                "设备诊断操作失败。",
                                op=op,
                                request_id=request_id,
                                error=getattr(event, "error", None),
                                job=getattr(event, "job", None),
                                event=event,
                            )
            except TimeoutError as exc:
                raise ResultUnknownError(
                    "诊断结果待核实。", op=op, request_id=request_id, may_have_executed=True
                ) from exc
        raise ResultUnknownError(
            "诊断订阅已结束。", op=op, request_id=request_id, may_have_executed=True
        )

    async def execute(self, op, args):
        if op == "discover":
            return result_data(await self.board.discover(**args))
        if op == "state.snapshot":
            return result_data(await self.board.state.snapshot())
        if op == "resource.preflight":
            if args.get("parent"):
                args = {**args, "parent_instance": (await self.info(args["parent"]))["instance"]}
            return result_data(await self.board.mux.preflight(**args))
        if op == "resource.open":
            return await self.open(args)
        if op == "resource.get":
            return await self.info(args["resource"])
        if op == "resource.call":
            return await self.call(args["resource"], args["action"], args.get("args", {}))
        if op in {"resource.close", "resource.recover"}:
            resource = self.resources.get(args["resource"])
            if resource is None:
                raise ValueError("只能释放本业务连接创建的资源。")
            await (
                resource.recover(cascade=args.get("cascade", False))
                if op.endswith("recover")
                else resource.close(cascade=args.get("cascade", False))
            )
            self.resources.pop(args["resource"], None)
            return {}
        if op == "job.submit":
            job = await self.board.jobs.submit(args["command"])
            self.jobs[job.id] = job
            status = await job.status()
            return status.model_dump(mode="json")
        if op.startswith("job."):
            job_id = args["job_id"]
            job = self.jobs.get(job_id) or await self.board.jobs.get(job_id)
            self.jobs[job_id] = job
            method = {"job.get": job.status, "job.cancel": job.cancel, "job.wait": job.wait}[op]
            return result_data(await method())
        prefix, _, method = op.partition(".")
        if (prefix == "gpio" and method.startswith("group.")) or op == "rmt.sync":
            if op != "gpio.group.read":
                await self.board.control.acquire()
            return await self.raw_result(op, **args)
        facade = getattr(self.board, prefix, None)
        name = {"state": "retrieve", "capabilities": "retrieve", "diagnostics": "retrieve"}.get(
            op, method.replace(".", "_")
        )
        function = getattr(facade, name, None)
        if not function:
            raise ValueError("此操作没有 SDK a2 高层接口。")
        return result_data(await function(**args))
