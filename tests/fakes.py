"""测试侧v3设备：控制响应/断线/作业，不能作为真实硬件证据。"""

import asyncio
import base64
import copy
import hashlib
import json
import struct
from pathlib import Path
from typing import get_args

from limivia.types import Operation

HELLO = {
    "protocol": 3,
    "jsonrpc": "2.0",
    "contract": "limivia-v3-jsonrpc2-r2",
    "batch_max": 8,
    "sequence_window": 64,
    "sequence_high": 0,
    "board": "luatos-esp32c3-usb",
    "device_id": "02:00:00:00:00:01",
    "firmware": "0.3.0-dev",
    "boot_id": "0123456789abcdef",
    "build_id": "a" * 64,
    "session": "session-test",
    "profile": "bus",
    "request_max": 1024,
    "response_max": 8192,
    "session_timeout_ms": 5000,
    "capability_pages": 28,
    "auth_mode": "open",
    "resources_max": 24,
    "job_history": 16,
    "buffer_max": 4096,
}
STATE = {
    "revision": 1,
    "epoch": 1,
    "page": 0,
    "pages": 6,
    "uptime_ms": 10,
    "stopping": False,
    "autostart_inhibited": True,
    "owner_endpoint": -1,
    "resources": [],
}


class FakeTransport:
    def __init__(self):
        self.closed = False
        self.commands = []
        self.frames = []
        self.nonce = None
        self.capture = None
        self.hello = copy.deepcopy(HELLO)
        self.jobs = {}
        self.resources = {}
        self.next_id = 1
        self.control = None
        self.silent_op = None
        self.disconnect_op = None
        self.refuse = False
        self.hold_jobs = False
        self.job_state = "completed"
        self.result_expired = False
        self.close_delay = 0
        self.write_delay = 0
        self.partial = False
        self.loops = []
        self.respond = True
        self.bad_response = None
        self.files = {}
        self.uploads = {}
        self.flows = {}
        self.buffers = {}
        self.levels = {}
        self.sequence = 0
        self.notification_gaps = False
        self.notice_sequence = 0
        self.fail_chunk = False
        self.cleanup_fault = False
        self.capabilities = json.loads(
            (Path(__file__).with_name("capabilities-v3.json")).read_text()
        )["profiles"]

    async def open(self):
        self.loops.append(asyncio.get_running_loop())
        self.closed = False
        self.queue = asyncio.Queue()

    async def emit(self, value):
        """测试用业务结果构造器；实际链路始终传输JSON-RPC。"""
        value = dict(value)
        context = {
            "boot_id": value.pop("boot_id", self.hello["boot_id"]),
            "session": value.pop("session", self.hello["session"]),
        }
        if "jsonrpc" in value:
            wire = value
        elif "event" in value:
            wire = {
                "jsonrpc": "2.0",
                "method": value.pop("event"),
                "params": {"context": context, "args": value},
            }
        elif value.get("ok", True):
            wire = {
                "jsonrpc": "2.0",
                "id": value["id"],
                "result": {"context": context, "value": value.get("result", {})},
            }
        else:
            error = value["error"]
            reason = error.get("reason", error.get("code", "test_refusal"))
            code = error["code"] if type(error.get("code")) is int else 1000
            wire = {
                "jsonrpc": "2.0",
                "id": value["id"],
                "error": {
                    "code": code,
                    "message": "Operation rejected",
                    "data": {
                        "reason": reason,
                        "context": context,
                        **{
                            k: v for k, v in error.items() if k not in {"code", "reason", "message"}
                        },
                    },
                },
            }
        if self.capture is not None:
            self.capture.append(wire)
            return
        await self.emit_wire(wire)

    async def emit_wire(self, wire):
        data = (json.dumps(wire) + "\n").encode()
        for offset in range(0, len(data), 7):
            await self.queue.put(data[offset : offset + 7])

    async def read(self):
        item = await self.queue.get()
        if isinstance(item, Exception):
            raise item
        return item

    async def write(self, data):
        self.loops.append(asyncio.get_running_loop())
        if self.write_delay:
            await asyncio.sleep(self.write_delay)
        if self.partial:
            raise ConnectionError("partial write")
        frame = json.loads(data)
        self.frames.append(frame)
        if isinstance(frame, list):
            self.capture = []
            for command in sorted(frame, key=lambda c: c["method"] != "outputs.stop"):
                await self.handle(command)
            messages = list(reversed(self.capture))
            self.capture = None
            await self.emit_wire(messages)
        else:
            await self.handle(frame)

    async def handle(self, wire):
        assert wire["jsonrpc"] == "2.0" and "v" not in wire
        context, p = (
            wire["params"]
            if isinstance(wire["params"], list)
            else (wire["params"].get("context", {}), wire["params"].get("args", {}))
        )
        op = wire["method"]
        command = {"id": wire.get("id"), "op": op, "params": p, "context": context}
        self.commands.append(command)
        if self.notification_gaps and op == "resource.call" and p.get("action") == "status":
            self.notice_sequence += 3
            await self.emit(
                {
                    "event": "state.changed",
                    "event_sequence": self.notice_sequence,
                    "revision": 1,
                    "resource": p["resource"],
                    "instance": p["resource"],
                    "job_id": 0,
                    "sequence": 0,
                    "dropped": 0,
                }
            )
        if op != "hello":
            assert type(context["seq"]) is int
            self.hello["sequence_high"] = max(self.hello["sequence_high"], context["seq"])
        if self.disconnect_op == op:
            await self.queue.put(ConnectionError("test disconnect"))
            return
        if op == self.silent_op or not self.respond:
            return
        if self.refuse and op != "hello":
            await self.emit({"id": command["id"], "ok": False, "error": {"code": "test_refusal"}})
            return
        if self.fail_chunk and op == "storage.chunk":
            await self.emit(
                {"id": wire["id"], "ok": False, "error": {"code": "flash_write_failed"}}
            )
            return
        if op == "storage.read" and self.files.get(p["name"], {}).get("secret"):
            await self.emit({"id": wire["id"], "ok": False, "error": {"code": "secret_file"}})
            return
        if op == "hello":
            nonce = context["client_nonce"]
            if self.nonce is not None and nonce != self.nonce:
                self.hello["session"] += "-new"
                self.hello["sequence_high"] = 0
                self.control = None
            self.nonce = nonce
            result = self.hello
        elif op == "control.acquire":
            self.control = "control-test"
            result = {"control": self.control}
        elif op == "control.release":
            self.control = None
            result = {}
        elif op == "state":
            result = {
                **STATE,
                "page": p.get("page", 0),
                "resources": list(self.resources.values())[
                    p.get("page", 0) * 4 : p.get("page", 0) * 4 + 4
                ],
                "owner_endpoint": 0 if self.control else -1,
            }
        elif op == "capabilities":
            page = p.get("page", 0)
            profile = self.hello["profile"]
            result = copy.deepcopy(
                self.capabilities.get(profile, self.capabilities["signal"]).get(
                    str(page), {"page": page, "pages": 28, "items": []}
                )
            )
            if page >= 20:
                all_ops = list(get_args(Operation.__value__))
                result = {
                    "page": page,
                    "pages": 28,
                    "items": [],
                    "operations": [
                        {
                            "op": op,
                            "params": "test fixture",
                            "available": not (
                                op.split(".")[0] in {"wifi", "mqtt", "espnow", "power"}
                                and profile != "iot"
                            ),
                        }
                        for op in all_ops[(page - 20) * 10 : (page - 19) * 10]
                    ],
                }

        elif op == "diagnostics":
            result = {
                "rejected": 0,
                "stale_completions": 0,
                "lost_notifications": 0,
                "timing": "software_monotonic",
                "system": {},
            }
        elif op == "job.get":
            if p["job_id"] not in self.jobs:
                await self.emit({"id": wire["id"], "ok": False, "error": {"code": "job_expired"}})
                return
            result = copy.deepcopy(self.jobs[p["job_id"]])
            if not self.hold_jobs:
                result["state"] = "failed" if result.get("driver_error") else self.job_state
            result["result_expired"] = self.result_expired
        elif op == "job.cancel":
            self.job_state = "cancelled"
            result = copy.deepcopy(self.jobs[p["job_id"]])
            result["cancel_requested"] = True
        elif op == "resource.get":
            if p["resource"] not in self.resources:
                await self.emit(
                    {"id": wire["id"], "ok": False, "error": {"reason": "resource_not_found"}}
                )
                return
            result = self.resources[p["resource"]]
        elif op.startswith(("storage.", "ota.", "flow.", "buffer.")):
            try:
                result = self.business(op, p)
            except (KeyError, ValueError):
                await self.emit({"id": wire["id"], "ok": False, "error": {"code": "invalid_state"}})
                return
        elif op in {"mux.preflight", "resource.preflight"}:
            mask = sum(1 << pin for pin in p["pins"].values())
            if any(r["pin_mask"] & mask for r in self.resources.values()):
                await self.emit({"id": wire["id"], "ok": False, "error": {"code": "pin_conflict"}})
                return
            result = {"available": True, "pin_mask": mask}
        elif (
            op.startswith(
                (
                    "resource.open",
                    "resource.call",
                    "resource.close",
                    "resource.recover",
                    "storage.",
                    "ota.",
                    "wifi.",
                    "mqtt.",
                    "espnow.",
                    "power.",
                    "system.",
                )
            )
            or op == "outputs.stop"
        ):
            resource = 0
            action = op
            if op == "resource.open":
                resource = self.next_id
                self.next_id += 1
                action = "open"
                self.levels[resource] = p.get("config", {}).get("level", 0)
                self.resources[resource] = {
                    "id": resource,
                    "instance": resource,
                    "kind": p["kind"],
                    "state": "ready",
                    "pin_mask": sum(1 << v for v in p["pins"].values()),
                    "definition": p,
                    "parent": p.get("parent", 0),
                }
            elif op == "resource.call":
                resource = p["resource"]
                action = p["action"]
                if action == "write" and "level" in p["args"]:
                    self.levels[resource] = p["args"]["level"]
            elif op in {"resource.close", "resource.recover"}:
                resource = p["resource"]
                descendants = {resource}
                while children := {
                    key
                    for key, value in self.resources.items()
                    if value.get("parent") in descendants and key not in descendants
                }:
                    descendants.update(children)
                if len(descendants) > 1 and not p.get("cascade"):
                    await self.emit(
                        {"id": wire["id"], "ok": False, "error": {"code": "children_exist"}}
                    )
                    return
                if self.cleanup_fault:
                    self.resources[resource]["state"] = "fault"
                else:
                    for child in descendants:
                        self.resources.pop(child, None)
                action = "close"
            elif op == "outputs.stop":
                self.control = None
                self.resources.clear()
            result = {
                "job_id": self.next_id,
                "resource": resource,
                "state": "accepted",
                "action": action,
                "driver_error": 0,
                "external_effect_possible": False,
                "result_expired": False,
                "cancel_requested": False,
            }
            self.next_id += 1
            self.jobs[result["job_id"]] = copy.deepcopy(result)
            job = self.jobs[result["job_id"]]
            if op in {"resource.close", "resource.recover"} and self.cleanup_fault:
                job.update(driver_error=5, error_code="cleanup_failed")
            if op == "resource.call":
                if action in {"read", "status"}:
                    job["result"] = {"level": self.levels.get(resource, 0), "enabled": True}
                elif action == "events":
                    self.sequence += 1
                    job["result"] = {
                        "events": [
                            {
                                "sequence": self.sequence,
                                "data": base64.b64encode(struct.pack("<ii", 2048, -1)).decode(),
                            }
                        ],
                        "dropped": 0,
                    }
                else:
                    job["result"] = {"written": len(base64.b64decode(p["args"].get("data", "")))}
            if op == "mqtt.publish":
                job["result"] = {"delivery": "queued", "message_id": 1}

            if op == "outputs.stop":
                self.jobs[result["job_id"]]["result"] = {
                    "cleanup_faults": 0,
                    "persist_error": getattr(self, "stop_persist_error", 0),
                    "autostart_inhibited": True,
                }
        else:
            result = {}
        info = self.resources.get(result.get("resource"))
        if (
            op in {"resource.open", "resource.call"}
            and info
            and (
                info["kind"] == "gpio"
                and action in {"open", "read", "write", "status"}
                or info["kind"] == "pwm"
                and action in {"duty", "status"}
            )
        ):
            config = info["definition"]["config"]
            confirmed = {
                "resource": info["id"],
                "instance": info["instance"],
                "revision": 1,
                "observed_us": 1000,
                "enabled": True,
            }
            if info["kind"] == "gpio":
                confirmed.update(
                    mode=config.get("mode", "input"), level=self.levels.get(info["id"], 0)
                )
            else:
                confirmed["duty_percent"] = float(
                    p.get("args", {}).get("duty", config.get("duty", 0))
                )
            if action == "open":
                confirmed["info"] = copy.deepcopy(info)
            result = confirmed
        response = {"id": command["id"], "ok": True, "result": result}
        if self.bad_response:
            response = self.bad_response(response)
        await self.emit(response)

    def business(self, op, p):
        prefix, action = op.split(".")
        if prefix in {"storage", "ota"}:
            if action == "status":
                return {
                    "initialized": True,
                    "active_slot": "ota_0",
                    "uploading": bool(self.uploads),
                }
            if action == "list":
                return {
                    "files": [
                        {"name": name, "size": len(item["data"])}
                        for name, item in self.files.items()
                        if not item.get("secret")
                    ]
                }
            if action == "begin":
                self.next_id += 1
                self.uploads[self.next_id] = {
                    **p,
                    "data": bytearray(),
                    "name": p.get("name", "firmware.bin"),
                }
                return {"upload_id": self.next_id}
            if action == "chunk":
                item = self.uploads[p["upload_id"]]
                assert len(item["data"]) == p["offset"]
                item["data"].extend(base64.b64decode(p["data"]))
                return {"offset": len(item["data"])}
            if action == "commit":
                item = self.uploads.pop(p["upload_id"])
                assert len(item["data"]) == item["size"]
                assert hashlib.sha256(item["data"]).hexdigest() == item["sha256"]
                self.files[item["name"]] = item
                return {"committed": True, "reboot": p.get("reboot", False)}
            if action == "abort":
                self.uploads.pop(p["upload_id"], None)
                return {"aborted": True}
            if action == "read":
                item = self.files[p["name"]]
                chunk = item["data"][p["offset"] : p["offset"] + p["length"]]
                return {"data": base64.b64encode(chunk).decode(), "length": len(chunk)}
            if action == "delete":
                self.files.pop(p["name"], None)
                return {"deleted": True}
            if action in {"record", "append"}:
                data = json.dumps(p["value"]).encode() + (b"\n" if action == "append" else b"")
                old = self.files.get(p["name"], {}).get("data", b"") if action == "append" else b""
                if len(old) + len(data) > p.get("limit_bytes", 262144):
                    raise ValueError("full")
                self.files[p["name"]] = {"data": old + data}
                return {"written": len(data)}
            if action == "format":
                self.files.clear()
                return {"formatted": True}
        if prefix == "buffer":
            if action == "create":
                self.next_id += 1
                self.buffers[self.next_id] = bytearray()
                return {"buffer_id": self.next_id}
            if action == "write":
                self.buffers[p["buffer_id"]].extend(base64.b64decode(p["data"]))
                return {"written": True}
            if action == "read":
                data = self.buffers[p["buffer_id"]][p["offset"] : p["offset"] + p["length"]]
                return {"length": len(data), "data": base64.b64encode(data).decode()}
            if action == "delete":
                self.buffers.pop(p["buffer_id"])
                return {}
        if prefix == "flow":
            if action == "load":
                definition = json.loads(self.files[p["name"]]["data"])
                assert definition["profile"] == self.hello["profile"]
                self.next_id += 1
                self.flows[self.next_id] = {
                    "flow_id": self.next_id,
                    "name": p["name"],
                    "state": "loaded",
                    "step": 0,
                    "resources": [],
                    "variables": definition["variables"],
                }
                return {"flow_id": self.next_id}
            if action == "list":
                return {"flows": list(self.flows.values())}
            item = self.flows[p["flow_id"]]
            if action == "remove":
                self.flows.pop(p["flow_id"])
                return {"removed": True}
            item["state"] = {
                "start": "running",
                "pause": "paused",
                "resume": "running",
                "stop": "stopped",
            }.get(action, item["state"])
            return dict(item)
        return {}

    async def close(self):
        if self.close_delay:
            await asyncio.sleep(self.close_delay)
        self.closed = True


class FakeBackend:
    def __init__(self, transport=None):
        self.connection = transport or FakeTransport()
        self.discovered = False

    async def discover(self, kind):
        self.discovered = True
        return [
            {"id": "test", "name": "LIMIVIA-bus"},
            {"id": "signal", "name": "LIMIVIA-signal"},
            {"id": "iot", "name": "LIMIVIA-iot"},
        ]

    def transport(self, kind, target, options=None):
        if self.connection.closed:
            self.connection = FakeTransport()
        if target in {"bus", "signal", "iot"}:
            self.connection.hello["profile"] = target
        return self.connection


async def result(connection, request_id, *, accepted=False):
    async with asyncio.timeout(2):
        while True:
            event = await connection.recv()
            if getattr(event, "request_id", None) == request_id:
                if event.type == "command.accepted" and not accepted:
                    continue
                return event
