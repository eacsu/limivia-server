"""仅供 Playwright：真实 server/SDK 配合模拟设备；不进入应用包，不访问硬件。"""

import tempfile
from pathlib import Path

import uvicorn
from fastapi import Request

from limivia_server.web.app import create_app

from .fakes import FakeBackend, FakeTransport


def main():
    with tempfile.TemporaryDirectory(prefix="limivia-e2e-") as directory:
        backend = FakeBackend()
        app = create_app(backend=backend, data_dir=Path(directory))

        @app.post("/api/testing/reset")
        async def reset():
            service = app.state.devices
            await service.disconnect()
            backend.connection = FakeTransport()
            service.tasks.clear()
            service.store.db.execute("DELETE FROM operations")
            service.store.db.commit()
            service.wiring.db.execute("DELETE FROM plans")
            service.wiring.db.execute("DELETE FROM bindings")
            service.wiring.db.commit()
            service.wiring_checked = None
            service.state.update(identity=None, discovery=None, snapshot=None, error=None)
            service.changed()
            return {"reset": True}

        @app.post("/api/testing/configure")
        async def configure(request: Request):
            options = await request.json()
            for key in (
                "hold_jobs",
                "notification_gaps",
                "cleanup_fault",
                "fail_chunk",
                "result_expired",
                "disconnect_op",
                "silent_op",
            ):
                if key in options:
                    setattr(backend.connection, key, options[key])
            return {"configured": True}

        @app.get("/api/testing/commands")
        async def commands():
            return {"commands": backend.connection.commands}

        routes = app.router.routes
        testing = [
            route for route in routes if getattr(route, "path", "").startswith("/api/testing/")
        ]
        app.router.routes[:] = testing + [route for route in routes if route not in testing]
        uvicorn.run(app, host="127.0.0.1", port=18000)


if __name__ == "__main__":
    main()
