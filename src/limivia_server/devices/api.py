from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Header, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .service import DeviceService
from .transfers import download_file, start_upload, validate_flow
from .wiring import (
    GroupOperation,
    SaveResourceInput,
    WiringPlan,
    save_resource_group,
    start_group_operation,
)


class ConnectInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["usb", "ble", "ws", "mqtt"] = "ble"
    target: str = Field(min_length=1, max_length=2048)
    expected_device_id: str | None = None
    options: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def target_url(self):
        if self.kind in {"ws", "mqtt"}:
            url = urlsplit(self.target)
            schemes = {"ws", "wss"} if self.kind == "ws" else {"mqtt", "mqtts"}
            if url.scheme not in schemes or not url.hostname or url.username or url.password:
                raise ValueError("需要不含账号密码的有效传输 URL。")
            if self.kind == "mqtt" and not self.options.get("device_id"):
                raise ValueError("MQTT 必须填写目标设备 MAC。")
        return self


class OperationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: str
    args: dict[str, Any] = Field(default_factory=dict)
    operation_epoch: int | None = None
    generation: int | None = None
    boot_id: str | None = None


def same_origin(origin, host, scheme):
    parsed = urlsplit(origin)
    return parsed.netloc == host and parsed.scheme == scheme


def device_router(service: DeviceService) -> APIRouter:
    router = APIRouter()

    def page(token):
        return service.page(token or "")

    def check_scope(body):
        identity = service.state.get("identity") or {}
        if body.operation_epoch is not None and body.operation_epoch != service.operation_epoch:
            raise HTTPException(409, "设备已停止或连接已改变，请重新执行新动作。")
        if (body.generation is not None and body.generation != service.generation) or (
            body.boot_id is not None and body.boot_id != identity.get("boot_id")
        ):
            raise HTTPException(409, "连接代次或设备 boot 已改变，请重新核对句柄与配置。")

    @router.post("/api/pages")
    async def new_page():
        return service.new_page()

    @router.get("/api/wiring-plans/{device_id}")
    async def wiring_get(device_id: str, x_page_session: str = Header(default="")):
        page(x_page_session)
        identity = service.state.get("identity") or {}
        board = identity.get("board") if identity.get("device_id") == device_id else None
        return service.wiring.get(device_id, board)

    @router.put("/api/wiring-plans/{device_id}")
    async def wiring_save(
        device_id: str, body: WiringPlan, x_page_session: str = Header(default="")
    ):
        page(x_page_session)
        identity = service.state.get("identity") or {}
        if identity.get("device_id") != device_id or identity.get("board") != body.board:
            raise HTTPException(409, "请连接并核对方案对应设备与板型。")
        value = service.wiring.save(device_id, body)
        service.wiring_checked = None
        service.emit("wiring.changed", {"device_id": device_id, "revision": value["revision"]})
        return value

    @router.post("/api/device/wiring-groups/from-resource")
    async def wiring_from_resource(
        body: SaveResourceInput, x_page_session: str = Header(default="")
    ):
        check_scope(body)
        return await save_resource_group(service, body, page(x_page_session))

    @router.post("/api/device/wiring-groups/{group_id}/{action}", status_code=202)
    async def wiring_action(
        group_id: str,
        action: Literal["check", "apply"],
        body: GroupOperation,
        x_page_session: str = Header(default=""),
    ):
        check_scope(body)
        return await start_group_operation(
            service, body, group_id, page(x_page_session), action == "apply"
        )

    @router.get("/api/device/discover")
    async def discover(kind: Literal["ble", "usb"] = "ble"):
        return await service.scan(kind)

    @router.post("/api/device/connect", status_code=202)
    async def connect(config: ConnectInput, x_page_session: str = Header(default="")):
        token = page(x_page_session)
        await service.connect(config)
        return service.view(token)

    @router.post("/api/device/disconnect")
    async def disconnect(x_page_session: str = Header(default="")):
        token = page(x_page_session)
        await service.disconnect()
        return service.view(token)

    @router.get("/api/device")
    async def state(x_page_session: str = Header(default="")):
        return service.view(page(x_page_session))

    @router.get("/api/device/catalog")
    async def catalog():
        return service.operation_catalog()

    @router.post("/api/device/resources/{resource}/sampling")
    async def sampling(resource: int, enabled: bool, x_page_session: str = Header(default="")):
        await service.sampling(resource, enabled, page(x_page_session))
        return {"enabled": enabled}

    @router.post("/api/device/refresh", status_code=202)
    async def refresh(x_page_session: str = Header(default="")):
        page(x_page_session)
        if not service.connection:
            raise HTTPException(409, "请先连接设备。")
        service.refresh_capabilities(refresh=True)
        return {"status": "refreshing"}

    @router.post("/api/device/operations", status_code=202)
    async def submit(body: OperationInput, x_page_session: str = Header(default="")):
        check_scope(body)
        return await service.submit(body.op, body.args, page(x_page_session))

    @router.post("/api/device/batches", status_code=202)
    async def batch(body: list[OperationInput], x_page_session: str = Header(default="")):
        for item in body:
            check_scope(item)
        return await service.batch(body, page(x_page_session))

    @router.post("/api/device/stop", status_code=202)
    async def stop(x_page_session: str = Header(default="")):
        return await service.submit("outputs.stop", {}, page(x_page_session))

    @router.get("/api/operations")
    async def operations(limit: int = 100, offset: int = 0):
        if not 1 <= limit <= 1000 or offset < 0:
            raise HTTPException(422, "分页参数超出范围。")
        return service.store.recent(limit, offset)

    @router.get("/api/operations/{operation_id}")
    async def operation(operation_id: str):
        task = service.tasks.get(operation_id) or service.store.get(operation_id)
        if not task:
            raise HTTPException(404, "操作不存在。")
        return task

    @router.post("/api/operations/{operation_id}/abort", status_code=202)
    async def abort(operation_id: str, x_page_session: str = Header(default="")):
        page(x_page_session)
        task = service.tasks.get(operation_id)
        if (
            not task
            or not task["op"].endswith(".upload")
            or task["generation"] != service.generation
        ):
            raise HTTPException(409, "没有可中止的本代上传任务。")
        if task["status"] not in {"created", "running", "submitted", "accepted"} or task[
            "progress"
        ]["phase"] in {"verifying", "committed"}:
            raise HTTPException(409, "上传已进入提交校验或已结束，请查询最终结果。")
        task["cancel_requested"] = True
        service.save(task)
        return task

    @router.post("/api/device/files/upload", status_code=202)
    async def upload(
        file: UploadFile,
        name: str,
        secret: bool = False,
        x_page_session: str = Header(default=""),
        generation: int | None = None,
        boot_id: str | None = None,
        operation_epoch: int | None = None,
    ):
        check_scope(
            OperationInput(
                op="storage.begin",
                generation=generation,
                boot_id=boot_id,
                operation_epoch=operation_epoch,
            )
        )
        return await start_upload(service, file, name, page(x_page_session), secret=secret)

    @router.post("/api/device/ota/upload", status_code=202)
    async def ota(
        file: UploadFile,
        profile: str,
        x_page_session: str = Header(default=""),
        generation: int | None = None,
        boot_id: str | None = None,
        operation_epoch: int | None = None,
    ):
        check_scope(
            OperationInput(
                op="ota.begin",
                generation=generation,
                boot_id=boot_id,
                operation_epoch=operation_epoch,
            )
        )
        return await start_upload(
            service, file, "firmware.bin", page(x_page_session), profile=profile
        )

    @router.get("/api/device/files/{name}/download")
    async def download(name: str, x_page_session: str = Header(default="")):
        data = await download_file(service, name, page(x_page_session))
        return Response(
            data,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )

    @router.post("/api/device/flows/validate")
    async def flow_validate(definition: dict):
        return validate_flow(definition, (service.state["identity"] or {}).get("profile"))

    @router.websocket("/api/device/events")
    async def events(socket: WebSocket):
        scheme = "https" if socket.url.scheme == "wss" else "http"
        if not same_origin(
            socket.headers.get("origin", ""), socket.headers.get("host", ""), scheme
        ):
            await socket.close(code=1008)
            return
        await socket.accept()
        subscription = token = None
        try:
            async with asyncio.timeout(5):
                hello = await socket.receive_json()
            token = page(hello.get("page_session", ""))
            subscription = object()
            queue = asyncio.Queue(maxsize=128)
            service.subscribers[subscription] = queue
            service.pages[token] += 1
            service.changed()
            await socket.send_json(
                {
                    "type": "snapshot",
                    "cursor": service.cursor,
                    "data": service.view(token),
                    "operations": service.store.recent(),
                }
            )

            async def send():
                while True:
                    item = await queue.get()
                    if item["type"] in {"device", "resync"}:
                        item = {
                            "type": "snapshot",
                            "cursor": service.cursor,
                            "data": service.view(token),
                            "operations": service.store.recent(),
                        }
                    await socket.send_json(item)

            sender = asyncio.create_task(send())
            try:
                while True:
                    message = await socket.receive_text()
                    if message != "ping":
                        value = json.loads(message)
                        if value.get("type") == "observe":
                            service.monitor(subscription, value.get("visible") is True)
            finally:
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)
        except Exception:  # noqa: BLE001 — 记录任务/连接失败，不向外输出敏感异常。
            with suppress(Exception):
                await socket.close(code=1008)
        finally:
            if subscription:
                service.monitor(subscription, False)
                service.subscribers.pop(subscription, None)
                service.pages[token] -= 1
                service.changed()

    return router


async def enforce_origin(request: Request, call_next):
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        origin = request.headers.get("origin")
        if origin and not same_origin(origin, request.headers.get("host", ""), request.url.scheme):
            return Response("跨源操作被拒绝。", status_code=403)
        if request.headers.get("sec-fetch-site") == "cross-site":
            return Response("跨源操作被拒绝。", status_code=403)
    return await call_next(request)
