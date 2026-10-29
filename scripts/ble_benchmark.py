"""Linux 单板 BLE 基准；每次运行独立 JSONL，不重试写操作。"""

import argparse
import asyncio
import importlib.metadata
import json
import time
from contextlib import AsyncExitStack, asynccontextmanager
from functools import partial
from pathlib import Path

from bleak import BleakClient, BleakScanner
from limivia import AsyncLimivia, __version__, transports

ADDRESS = "E4:B0:63:CA:B4:7A"
DEVICE = "e4:b0:63:ca:b4:78"
RUN_EMIT = None


class TimedBus:
    """代理可具有只读方法的 C 扩展总线对象，不修改第三方对象。"""

    def __init__(self, bus, emit):
        self.bus, self.emit = bus, emit

    def __getattr__(self, name):
        return getattr(self.bus, name)

    async def call(self, message):
        if message.member != "WriteValue":
            return await self.bus.call(message)
        started = time.perf_counter()
        error, completed = None, False
        try:
            reply = await self.bus.call(message)
            error, completed = reply.error_name, True
            return reply
        finally:
            self.emit(
                {
                    "op": "bluez_write_call",
                    "ok": completed and error is None,
                    "bluez_error": error,
                    "completed": completed,
                    "ms": (time.perf_counter() - started) * 1000,
                }
            )


def trace_queue(core, emit, now=time.perf_counter):
    """只记录操作名、局部请求 ID 与时间；不记录包内容、参数或凭据。"""
    queued = {}
    dispatched = {}
    enqueue, next_frame, complete = core._enqueue, core._next_frame, core._complete

    def measured_enqueue(*args, **kwargs):
        started = now()
        request = enqueue(*args, **kwargs)
        queued[request.id] = started
        return request

    def measured_next():
        frame = next_frame()
        if frame is not None:
            _, _, item = frame
            for request in item if isinstance(item, list) else [item]:
                started = now()
                dispatched[request.id] = started
                if request.id in queued:
                    emit(
                        {
                            "op": "sdk_queue",
                            "request": request.id,
                            "method": str(request.command.type),
                            "ok": True,
                            "ms": (started - queued[request.id]) * 1000,
                        }
                    )
        return frame

    def measured_complete(request, event):
        result = complete(request, event)
        started = queued.pop(request.id, None)
        sent = dispatched.pop(request.id, None)
        if started is not None:
            finished = now()
            emit(
                {
                    "op": "sdk_request",
                    "request": request.id,
                    "method": str(request.command.type),
                    "completion_type": event.type,
                    "internal": request.internal,
                    "ok": event.type != "command.failed",
                    "ms": (finished - started) * 1000,
                    "dispatch_to_complete_ms": (finished - sent) * 1000
                    if sent is not None
                    else None,
                }
            )
        return result

    core._enqueue, core._next_frame, core._complete = (
        measured_enqueue,
        measured_next,
        measured_complete,
    )


async def main():
    # Both scan and connect must use the specified fixture, never hci0 fallback.
    discover = transports.BleakScanner.discover
    transports.BleakScanner.discover = partial(discover, bluez={"adapter": "hci1"})
    transports.BleakClient = partial(BleakClient, bluez={"adapter": "hci1"})
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--phase",
        choices=[
            "queries",
            "connections",
            "gatt",
            "usb",
            "discovery",
            "exercise",
            "soak",
            "acceptance",
        ],
        default="queries",
    )
    parser.add_argument("--observe", action="store_true")
    parser.add_argument("--n", type=int, default=100)
    parser.add_argument("--job-timeout", type=float, default=300)
    parser.add_argument("--seconds", type=float, default=3600)
    parser.add_argument("--binary", action="store_true")
    parser.add_argument("--trace-queue", action="store_true")
    parser.add_argument(
        "--acquire-address",
        action="store_true",
        help="仅用于暖连接测量：以 12 秒地址扫描获得测试夹具；不计入 SDK 扫描成功率",
    )
    parser.add_argument(
        "--fixture-attempts",
        type=int,
        default=1,
        help="暖连接夹具获取次数；逐次记录，独立于冷连接成功率",
    )
    parser.add_argument("--transport", choices=["ble", "usb"], default="ble")
    parser.add_argument(
        "--connect-budget",
        type=float,
        default=15,
        help="独立诊断预算；延长时不与默认连接成功率混算",
    )
    args = parser.parse_args()
    if args.phase == "acceptance":
        args.observe = True
    if args.binary:
        transports.BluetoothTransport = partial(transports.BluetoothTransport, binary=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    output = args.output.open("x")

    def emit(row):
        output.write(json.dumps({"at": time.time(), **row}, ensure_ascii=False) + "\n")
        output.flush()

    global RUN_EMIT
    RUN_EMIT = emit

    def client_factory(*positional, **keywords):
        keywords.pop("bluez", None)
        keywords["timeout"] = args.connect_budget
        client = BleakClient(*positional, bluez={"adapter": "hci1"}, **keywords)
        connect = client.connect

        async def measured_connect():
            started = time.perf_counter()
            ok = False
            try:
                result = await connect()
                ok = True
                return result
            finally:
                emit({"op": "gatt_connect", "ok": ok, "ms": (time.perf_counter() - started) * 1000})

        client.connect = measured_connect
        return client

    transports.BleakClient = client_factory

    emit(
        {
            "meta": {
                "sdk": __version__,
                "installed_distribution": importlib.metadata.version("limivia"),
                "phase": args.phase,
                "job_timeout": args.job_timeout,
                "connect_budget": args.connect_budget,
                "binary": args.binary,
                "acquire_address": args.acquire_address,
                "observe": args.observe,
                "trace_queue": args.trace_queue,
                "transport": "usb" if args.phase == "usb" else args.transport,
                "address": ADDRESS,
                "adapter": "hci1",
            }
        }
    )

    async def sample(name, fn, n):
        for index in range(n):
            started = time.perf_counter()
            try:
                result = await fn()
                row = {"op": name, "i": index, "ok": True}
                if name == "identity":
                    row["identity"] = result.model_dump(mode="json")
                if name == "diagnostics":
                    row["diagnostics"] = result.model_dump(mode="json")
            except Exception as exc:  # noqa: BLE001 -- every measurement failure is recorded
                row = {
                    "op": name,
                    "i": index,
                    "ok": False,
                    "error": str(exc),
                    "type": type(exc).__name__,
                }
            emit({**row, "ms": (time.perf_counter() - started) * 1000})
            if index % 10 == 0:
                print(name, index, row["ok"], flush=True)

    @asynccontextmanager
    async def acquire(sdk, kind):
        async with AsyncExitStack() as stack:
            for attempt in range(args.fixture_attempts):
                started = time.perf_counter()
                try:
                    if args.acquire_address and kind == "ble":
                        device = await BleakScanner.find_device_by_address(
                            ADDRESS, timeout=12, bluez={"adapter": "hci1"}
                        )
                        if device is None:
                            raise RuntimeError("12 秒地址扫描未发现目标测试夹具")
                        sdk._backend.targets[("ble", ADDRESS)] = device
                        target = ADDRESS
                    else:
                        devices = await sdk.devices.list(kind=kind)
                        target = next(
                            (
                                d.id
                                for d in devices
                                if (kind == "usb" and "ACM" in d.id) or d.id == ADDRESS
                            ),
                            None,
                        )
                        if target is None:
                            raise RuntimeError("SDK 5 秒扫描未发现目标测试夹具")
                    board = await stack.enter_async_context(
                        sdk.devices.connect(kind=kind, target=target, expected_device_id=DEVICE)
                    )
                    emit(
                        {
                            "op": "fixture_acquire",
                            "i": attempt,
                            "ok": True,
                            "ms": (time.perf_counter() - started) * 1000,
                        }
                    )
                    break
                except Exception as exc:  # noqa: BLE001 -- record each fixture acquisition failure
                    emit(
                        {
                            "op": "fixture_acquire",
                            "i": attempt,
                            "ok": False,
                            "error_type": type(exc).__name__,
                            "error": str(exc),
                            "ms": (time.perf_counter() - started) * 1000,
                        }
                    )
                    await asyncio.sleep(1)
            else:
                raise RuntimeError("暖连接夹具获取失败；未进行任何业务样本采集")
            yield board

    if args.phase == "gatt":
        device = await BleakScanner.find_device_by_address(ADDRESS, timeout=12, adapter="hci1")
        if device is None:
            raise RuntimeError("未发现目标")
        async with BleakClient(
            device, bluez={"adapter": "hci1"}, timeout=args.connect_budget
        ) as client:
            await sample(
                "gatt_read",
                lambda: client.read_gatt_char("00002b3a-0000-1000-8000-00805f9b34fb"),
                args.n,
            )
        return

    if args.phase == "connections":
        for index in range(args.n):
            started = time.perf_counter()
            try:
                async with AsyncLimivia() as sdk:
                    devices = await sdk.devices.list(kind="ble")
                    found = any(d.id == ADDRESS for d in devices)
                    emit(
                        {
                            "op": "scan",
                            "i": index,
                            "ok": found,
                            "ms": (time.perf_counter() - started) * 1000,
                        }
                    )
                    if not found:
                        continue
                    started = time.perf_counter()
                    async with sdk.devices.connect(kind="ble", target=ADDRESS) as board:
                        assert board.identity.device_id == DEVICE
                        emit(
                            {
                                "op": "connection_handshake",
                                "i": index,
                                "ok": True,
                                "ms": (time.perf_counter() - started) * 1000,
                            }
                        )
            except Exception as exc:  # noqa: BLE001 -- connection-rate denominator includes all failures
                emit(
                    {
                        "op": "connection_handshake",
                        "i": index,
                        "ok": False,
                        "ms": (time.perf_counter() - started) * 1000,
                        "error": str(exc),
                    }
                )
            await asyncio.sleep(1)
        return

    async with AsyncLimivia(
        job_timeout=args.job_timeout, connect_timeout=max(20, args.connect_budget + 5)
    ) as sdk:
        kind = "usb" if args.phase == "usb" else args.transport
        async with acquire(sdk, kind) as board:
            assert board.identity.device_id == DEVICE
            emit({"identity": board.identity.model_dump(mode="json")})
            if args.trace_queue:
                trace_queue(board._core, emit)

            async def events():
                async with board.raw.subscribe() as stream:
                    async for event in stream:
                        if event.type in {
                            "connection.closed",
                            "notifications.gap",
                            "protocol.error",
                            "command.failed",
                        }:
                            error = getattr(event, "error", None)
                            emit({"event": event.type, "reason": getattr(error, "reason", None)})

            event_task = asyncio.create_task(events())
            # Record per-frame ATT writes without logging sessions/control credentials.
            transport = board._core._transport
            if kind == "ble":
                original = transport.client.write_gatt_char
                original_push = transport._push

                def measured_push(data):
                    if isinstance(data, bytes):
                        emit({"op": "notification", "bytes": len(data)})
                    original_push(data)

                transport._push = measured_push
                characteristic = transport.client.services.get_characteristic(
                    "7b9d0002-7a21-4c9b-8b30-69e5ce1d0001"
                )
                emit({"link": {"rx_payload": characteristic.max_write_without_response_size}})
                if args.trace_queue:
                    # Linux diagnostic only: measure D-Bus without logging message bodies.
                    bus = getattr(transport.client._backend, "_bus", None)
                    if bus is not None:
                        transport.client._backend._bus = TimedBus(bus, emit)

                async def measured_write(characteristic, data, **kwargs):
                    started = time.perf_counter()
                    ok = False
                    try:
                        result = await original(characteristic, data, **kwargs)
                        ok = True
                        return result
                    finally:
                        emit(
                            {
                                "op": "att_write",
                                "ok": ok,
                                "bytes": len(data),
                                "ms": (time.perf_counter() - started) * 1000,
                            }
                        )

                transport.client.write_gatt_char = measured_write

            async def ping():
                return await board._request("session.ping", {}, control=False)

            async def observer():
                while True:
                    await sample("background_snapshot", board.state.snapshot, 1)
                    await asyncio.sleep(2)

            background = asyncio.create_task(observer()) if args.observe else None
            try:
                if args.phase == "discovery":
                    await sample("discovery_uncached", lambda: board.discover(refresh=True), args.n)
                    return

                async def exercise():
                    async with board.gpio.output(13, value=0) as led:
                        for index in range(args.n):
                            started = time.perf_counter()
                            try:
                                await led.write(index % 2)
                                assert await led.read() == index % 2
                                emit(
                                    {
                                        "op": "led_write_readback",
                                        "i": index,
                                        "ok": True,
                                        "ms": (time.perf_counter() - started) * 1000,
                                    }
                                )
                            except Exception as exc:
                                emit(
                                    {
                                        "op": "led_write_readback",
                                        "i": index,
                                        "ok": False,
                                        "error": str(exc),
                                        "ms": (time.perf_counter() - started) * 1000,
                                    }
                                )
                                # Query actual state before cleanup; do not repeat an unknown write.
                                await sample("unknown_recovery_snapshot", board.state.snapshot, 1)
                                raise

                async def soak():
                    deadline = time.monotonic() + args.seconds
                    index = 0
                    while time.monotonic() < deadline:
                        await sample("soak_ping", ping, 1)
                        await sample("soak_snapshot", board.state.snapshot, 1)
                        if board._core._closed:
                            emit(
                                {
                                    "progress": "soak_aborted",
                                    "remaining_s": deadline - time.monotonic(),
                                }
                            )
                            break
                        await asyncio.sleep(2)
                        index += 1
                        if index % 10 == 0:
                            emit(
                                {
                                    "progress": "soak",
                                    "remaining_s": max(0, deadline - time.monotonic()),
                                }
                            )
                    await sample("diagnostics", board.diagnostics.retrieve, 2)

                if args.phase == "exercise":
                    await exercise()
                    return
                if args.phase == "soak":
                    await soak()
                    return
                await sample("ping", ping, args.n)
                await sample("state_page", lambda: board.state.retrieve(page=0), args.n)
                await sample("snapshot", board.state.snapshot, 30)
                await sample("discovery_uncached", lambda: board.discover(refresh=True), 10)
                await sample("diagnostics", board.diagnostics.retrieve, 2)
                if args.phase == "acceptance":
                    emit({"progress": "exercise_started"})
                    await exercise()
                    emit({"progress": "soak_started", "seconds": args.seconds})
                    await soak()
            finally:
                if background:
                    background.cancel()
                    await asyncio.gather(background, return_exceptions=True)
                event_task.cancel()
                await asyncio.gather(event_task, return_exceptions=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        if RUN_EMIT:
            RUN_EMIT({"event": "run.failed", "error_type": type(exc).__name__, "error": str(exc)})
        raise
