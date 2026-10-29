"""诊断采样不能改变 SDK 返回值、重复记账或记录协议凭据。"""

import asyncio
import importlib.util
import json
from collections import deque
from pathlib import Path
from types import SimpleNamespace

import pytest


def benchmark_module():
    path = Path(__file__).parents[1] / "scripts" / "ble_benchmark.py"
    spec = importlib.util.spec_from_file_location("ble_benchmark", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_queue_trace_preserves_batch_completion_and_omits_credentials():
    module = benchmark_module()
    secret = object()
    pending, frames, rows = {}, deque(), []
    instant = [1.0]

    def enqueue(command, *, internal=False):
        request = SimpleNamespace(
            id=len(pending) + 1,
            command=SimpleNamespace(type=command["type"], params=secret),
            internal=internal,
            session=secret,
        )
        pending[request.id] = request
        return request

    def complete(request, event):
        pending.pop(request.id, None)
        return event

    core = SimpleNamespace(_enqueue=enqueue, _next_frame=frames.popleft, _complete=complete)
    module.trace_queue(core, rows.append, now=lambda: instant[0])
    first = core._enqueue({"type": "state.get", "params": secret})
    second = core._enqueue({"type": "session.ping", "params": secret}, internal=True)
    frame = (1, True, [first, second])
    frames.append(frame)
    instant[0] = 1.25
    assert core._next_frame() is frame
    instant[0] = 1.5
    success = SimpleNamespace(type="command.completed", result=secret)
    failure = SimpleNamespace(type="command.failed", error=secret)
    assert core._complete(first, success) is success
    assert core._complete(second, failure) is failure
    core._complete(first, success)
    assert not pending
    assert [r["op"] for r in rows] == ["sdk_queue", "sdk_queue", "sdk_request", "sdk_request"]
    assert rows[0]["ms"] == 250
    assert rows[2]["ms"] == 500
    assert rows[2]["dispatch_to_complete_ms"] == 250
    assert rows[2]["ok"] is True
    assert rows[3]["ok"] is False
    assert rows[3]["internal"] is True
    # Serialization must succeed despite non-serializable credentials in every input.
    assert "params" not in json.dumps(rows)
    assert all("session" not in r for r in rows)


def test_bus_proxy_supports_readonly_methods_and_preserves_replies():
    module, rows = benchmark_module(), []
    reply = SimpleNamespace(error_name=None, body=object())

    class ReadonlyBus:
        __slots__ = ()

        async def call(self, message):
            return reply

        def disconnect(self):
            return reply

    proxy = module.TimedBus(ReadonlyBus(), rows.append)

    async def run():
        assert await proxy.call(SimpleNamespace(member="ReadValue")) is reply
        assert rows == []
        assert await proxy.call(SimpleNamespace(member="WriteValue", body=object())) is reply

    asyncio.run(run())
    assert proxy.disconnect() is reply
    assert len(rows) == 1 and rows[0]["ok"] is True
    json.dumps(rows)  # Neither the input body nor reply body may be serialized.


def test_bus_proxy_propagates_cancellation_and_records_unfinished_call():
    module, rows = benchmark_module(), []

    class WaitingBus:
        async def call(self, message):
            await asyncio.Future()

    async def run():
        proxy = module.TimedBus(WaitingBus(), rows.append)
        task = asyncio.create_task(proxy.call(SimpleNamespace(member="WriteValue")))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert len(rows) == 1
    assert rows[0]["completed"] is False and rows[0]["ok"] is False
