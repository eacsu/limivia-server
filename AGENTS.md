# LIMIVIA 工程约定

- 使用中文沟通和维护 README。Python 3.12 用 Poetry 和项目内 .venv，前端用 pnpm。
- 发布包和 CLI 为 limivia-server，Python 包为 limivia_server；按用户要求 limivia SDK 暂不写入 TOML，由项目 .venv 的 pip 手动安装核验过的 0.3.0a3 JSON-RPC v3 wheel。其余依赖由 Poetry 使用清华源管理，不在 server 复制硬件传输或事件模型。
- Python 后端位于 `src/limivia_server`；React 前端位于 `src/web`。ESP-IDF 固件及构建、烧录、实机验证工具独立于 `limivia-esp32` 仓库（本机位于 `../limivia-esp32`）。本仓库运行不依赖它的检出位置。
- 控制链路为浏览器通过同源 HTTP/WebSocket 访问 Python 后端，后端生命周期持有单设备 AsyncLimivia 连接，支持 BLE / USB / WS / MQTT，默认蓝牙。多个页面共享观察与操作，连接后即可使用；SDK 自动管理协议控制令牌，不设置页面控制归属。后端统一托管前端，CLI 负责启动工作台和检查环境。
- 涉及板卡连接、引脚、电气边界或 USB/BLE 适配时，读取本仓库专用技能 [limivia-esp32c3](.agents/skills/limivia-esp32c3/SKILL.md)。固件开发读取固件仓库的 AGENTS.md 与专用 skill；各自资料不安装至全局技能目录。
- 界面采用 MANAS 工作台关系与苍渊·白垣锁定 Token；首版默认白垣。组件不得散写品牌 HEX。
- 默认验证：`poetry run pytest`、`poetry run ruff check src/limivia_server tests`、`pnpm --dir src/web run lint`、`pnpm --dir src/web test`、`pnpm --dir src/web run build`、`pnpm --dir src/web run test:e2e`。
- `docs/protocol.md` 是跨仓库协议真源；变更需协同更新固件仓库的协议快照、实现与测试。主仓库不重新引入 ESP-IDF 源码或固件构建工具；Python 串口与蓝牙依赖用于后端设备控制。

- 每项新工作先新建分支；按功能与改动目的分批提交，每批完成相应验证后提交；不自动推送。
