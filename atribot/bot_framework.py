import asyncio
import datetime
import os
from logging import Logger
from pathlib import Path
from typing import Any, Awaitable

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from atribot.common_utils.http_client import HTTPClient
from atribot.core.atri_config import atriConfig
from atribot.core.cache.management_chat_example import ChatManager
from atribot.core.cache.message_store import store_message_to_db
from atribot.core.command.async_permissions_management import PermissionsManagement
from atribot.core.command.command_loader import CommandLoader
from atribot.core.command.command_parsing import CommandSystem
from atribot.core.db.async_postgresql import AsyncPostgreSQL
from atribot.core.event_bus.rule import AtCommandRule
from atribot.core.network_connections.qq_send_message import QQAPIClient
from atribot.core.pipeline.whitelist import WhitelistMiddleware
from atribot.core.platform.manager import PlatformManager
from atribot.core.service_container import container
from atribot.core.time_trigger import TimeTriggerSupervisor
from atribot.core.type.bot_types import MessageEventEnvelope, atriMessageEvent
from atribot.core.type.onebot_event_types import PrivateMessageEvent
from atribot.LLMchat.chat import GroupChat, PrivateChat
from atribot.LLMchat.emoji_system import EmojiCore
from atribot.LLMchat.initiative_chat import initiativeChat
from atribot.LLMchat.LLM_supervisor import LLMCoordinator
from atribot.LLMchat.MCP.mcp_tool_manager import ToolManager
from atribot.LLMchat.MCP.tool_calls import ToolCalls
from atribot.LLMchat.media_processor import MediaProcessor
from atribot.LLMchat.memory.memory_system import MemorySystem
from atribot.LLMchat.memory.user_info_system import UserSystem
from atribot.LLMchat.model_api.ai_connection_manager import LLMConnectionManager
from atribot.LLMchat.sandbox.docker_sandbox import DockerSandbox
from atribot.LLMchat.sandbox.sandbox_base import SandBoxBase
from atribot.LLMchat.skills.skills_manager import SkillsManager
from atribot.LLMchat.token_manage import TokenManager
from atribot.plugins.manager import PluginManager


class BotFramework:

    _SERVICE_CLASSES = (
        atriConfig,
        HTTPClient,
        TimeTriggerSupervisor,
        TokenManager,
        MemorySystem,
        UserSystem,
        MediaProcessor,
        LLMCoordinator,
        GroupChat,
        PrivateChat,
        SkillsManager,
        EmojiCore,
        ChatManager,
        PermissionsManagement,
        CommandSystem,
        CommandLoader,
        PluginManager,
    )

    _NAMED_SERVICE_CLASSES = (
        (AsyncPostgreSQL, "database"),
        (ToolManager, "MCP"),
        (LLMConnectionManager, "LLMSupplier"),
        (ToolCalls, "ToolCalls"),
    )

    _RESOLVE_TARGETS = (
        HTTPClient,
        TimeTriggerSupervisor,
        ToolManager,
        AsyncPostgreSQL,
        TokenManager,
        LLMConnectionManager,
        SkillsManager,
        MemorySystem,
        UserSystem,
        ChatManager,
        EmojiCore,
        PermissionsManagement,
        ToolCalls,
        MediaProcessor,
        CommandSystem,
        CommandLoader,
        LLMCoordinator,
        GroupChat,
        PrivateChat,
        PluginManager,
    )

    def __init__(self):
        self.log: Logger = container.get_by_type(Logger).getChild("Bot")
        self._background_tasks: set[asyncio.Task[Any]] = set()
        """退出时统一回收的后台任务"""
        self._shutdown_task: asyncio.Task[None] | None = None
        self._is_shutdown = False
        """标记是否已经完成关闭"""
        self._platform_manager: PlatformManager | None = None
        """平台管理器实例"""

    @classmethod
    async def create(cls):
        """工厂初始化方法"""
        self = cls()
        try:
            await self.initialize()
        except BaseException:
            await self.graceful_shutdown()
            raise
        return self

    async def initialize(self):
        """初始化"""
        self.config = atriConfig()
        container.register("config", self.config)

        self._register_services()

        self._platform_manager = PlatformManager(self.config)
        container.register("PlatformManager", self._platform_manager, cleanup=self._platform_manager.stop_all)
        container._type_map[PlatformManager] = "PlatformManager"

        if self._platform_manager.adapters:
            _first_adapter = next(iter(self._platform_manager.adapters.values()))
            _send_client = _first_adapter.get_client()
            container.register("SendMessage", _send_client)
            container._type_map[QQAPIClient] = "SendMessage"
            self.log.info(
                "SendMessage 已桥接到适配器 '%s' (%s)",
                next(iter(self._platform_manager.adapters.keys())),
                type(_send_client).__name__,
            )
        else:
            self.log.warning("没有可用适配器,SendMessage 未注册")

        #白名单
        await self._platform_manager.pipeline.add_middleware(WhitelistMiddleware())
        
        #存储
        self._platform_manager.queue.set_overflow_handler(store_message_to_db)
        self._platform_manager.event_bus.on_message(priority=101)(store_message_to_db)

        await self._start_sandbox()
        await self._resolve_services()

        # 异步备份数据库（后台运行，不阻塞启动）
        self.create_background_task(self._backup_database(), name="startup-db-backup")

        # 注册 @ 路由监听器
        self._register_at_routes()

        # 启动所有平台适配器 + EventBus 主循环
        await self._platform_manager.start_all()

        await self._start_runtime_services()

    def _register_at_routes(self) -> None:
        """注册消息路由监听器到 EventBus

          10  @ + / 命令 → CommandSystem
           1  任意消息   → initiativeChat
        """
        bus = self._platform_manager.event_bus
        log = self.log
        _initiative_chat = initiativeChat()
        cmd_system = container.get_by_type(CommandSystem)
        _permissions = container.get_by_type(PermissionsManagement)
        _private_chat = container.get_by_type(PrivateChat)

        @bus.on_message(rule=AtCommandRule(), priority=10)
        async def on_at_command(event:MessageEventEnvelope):
            try:
                await cmd_system.dispatch_command(event)
                event.stop_propagation = True
            except Exception as e:
                log.exception("命令处理失败: %s", e)
                await event.send(event.reply_text(f"ATRI用手挠了挠脑袋,这个指令执行出现了问题😕\nType Error:\n{e}"))
                event.stop_propagation = True

        @bus.on_message(priority=100)
        async def on_chat(event:atriMessageEvent):
            try:
                if group_context := event._extra.get("group_context"):
                    event.stop_propagation = await _initiative_chat.decision(event, group_context)
                elif private_ctx := event._extra.get("private_context"):
                    # 私聊直通 PrivateChat.step(不做主动性决策):
                    # 仅处理真正的私聊消息(排除自身发送回执),黑名单用户直接忽略
                    if (
                        isinstance(event.event, PrivateMessageEvent)
                        and event.user_id not in _permissions.blacklist
                    ):
                        await _private_chat.step(
                            event,
                            "你正在和用户进行一对一私聊，请认真回复对方的消息",
                        )
                        event.stop_propagation = True
            except Exception as e:
                log.exception("聊天处理失败: %s", e)
                await event.send(event.reply_text(f"有关聊天的路由出现了问题:\n{e}\n你不应该看到这个的,因为最近在迁移方面的原因，有很多小毛病,看到这建议联系开发者"))

    def _register_services(self) -> None:
        """注册可由容器解析的服务类型"""
        for service_cls in self._SERVICE_CLASSES:
            container.register_class(service_cls)

        for service_cls, service_name in self._NAMED_SERVICE_CLASSES:
            container.register_class(service_cls, name=service_name)

    async def _start_sandbox(self) -> None:
        """启动 LLM 可选沙盒"""
        try:
            sand_box: SandBoxBase = DockerSandbox(config=self.config.sand_box)
            await sand_box.start()
            container.register("SandBox", sand_box, cleanup=sand_box.stop)
        except Exception as e:
            self.log.exception(f"LLM使用的沙盒初始化失败{e}")

    async def _resolve_services(self) -> None:
        """提前解析启动阶段需要的服务实例

        PluginManager 在此步被 resolve,其 initialize() 会自动：
        1. 从容器获取 PlatformManager
        2. 创建 PluginLoader 扫描 atribot/plugins/
        3. 加载所有插件，插件自动将 handlers 注册到 EventBus
        """
        for tgt in self._RESOLVE_TARGETS:
            await container.resolve(tgt)

    async def _start_runtime_services(self) -> None:
        """启动依赖容器完成后的运行期服务"""
        trigger = container.get_by_type(TimeTriggerSupervisor)
        await trigger.start()

        self.create_background_task(self._start_admin_panel(), name="BotFramework.admin_panel")

    async def _start_admin_panel(self) -> None:
        """在独立端口启动 Web 管理面板"""
        from atribot.web_panel.panel_router import router as admin_router

        admin_app = FastAPI(title="ATRI Admin Panel", docs_url=None, redoc_url=None)
        admin_app.add_middleware(
            CORSMiddleware,
            allow_origins=["http://localhost", "http://127.0.0.1"],
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type"],
        )
        admin_app.include_router(admin_router)

        # 面板端口：优先读取 config.admin_panel.port，否则在第一个平台端口基础上 +1
        default_port = 8080
        for plat in getattr(self.config.platforms, "instances", {}).values():
            port = getattr(plat, "port", None)
            if port:
                default_port = int(port)
                break
            # WebSocket_client 模式：从 url (host:port) 中提取端口
            url = getattr(plat, "url", "") or ""
            if ":" in url:
                try:
                    default_port = int(url.rsplit(":", 1)[1])
                    break
                except ValueError:
                    continue
        admin_panel_cfg = getattr(self.config, "admin_panel", None)
        admin_port = int(getattr(admin_panel_cfg, "port", default_port + 1))


        
        cfg = uvicorn.Config(
            admin_app,
            host="127.0.0.1",
            port=admin_port,
            log_level="warning",
        )
        server = uvicorn.Server(cfg)
        self.log.info(f"管理面板已就绪: http://127.0.0.1:{admin_port}/admin/")
        await server.serve()

    def create_background_task(self, coro: Awaitable[Any], *, name: str | None = None) -> asyncio.Task[Any]:
        """创建受控后台任务"""
        task = asyncio.create_task(coro, name=name)
        self._background_tasks.add(task)
        task.add_done_callback(self._handle_background_task_done)
        return task

    def _handle_background_task_done(self, task: asyncio.Task[Any]) -> None:
        """清理后台任务引用并记录异常"""
        self._background_tasks.discard(task)
        if task.cancelled():
            return

        if exc := task.exception():
            self.log.exception("后台任务异常退出: %s", task.get_name(), exc_info=exc)

    async def _backup_database(self) -> None:
        """异步备份 atri 数据库到 D:\\资源\\ATRI\\

        使用 pg_dump 自定义压缩格式，文件名格式：ATRI-backup-YYYY-MM-DD-HH-MM-SS.dump
        作为后台任务运行，不会阻塞 bot 启动流程。
        """
        try:
            backup_dir = Path("D:/资源/ATRI")
            backup_dir.mkdir(parents=True, exist_ok=True)

            timestamp = datetime.datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
            filepath = backup_dir / f"ATRI-backup-{timestamp}.dump"

            db_cfg = self.config.database
            db_name = getattr(db_cfg, "database", "atri")

            # 优先使用 Docker 容器内的 pg_dump（版本与数据库一致，避免版本不匹配）
            # 检测目标是否为本机 Docker 数据库：host 为 localhost/127.0.0.1 且端口 5432 时尝试容器内执行
            container_name = "atri-db"
            env = os.environ.copy()
            env["PGPASSWORD"] = db_cfg.password

            use_docker_exec = False
            try:
                # 检查容器是否存在且在运行
                check = await asyncio.create_subprocess_exec(
                    "docker", "ps", "--format", "{{.Names}}",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                check_out, _ = await check.communicate()
                running = check_out.decode("utf-8", errors="replace").splitlines()
                use_docker_exec = container_name in running
            except Exception:
                use_docker_exec = False

            if use_docker_exec:
                # 在容器内执行 pg_dump（无需本机安装 PostgreSQL 工具）
                process = await asyncio.create_subprocess_exec(
                    "docker", "exec", container_name, "pg_dump",
                    "-h", "127.0.0.1",
                    "-p", "5432",
                    "-U", str(db_cfg.user),
                    "-d", db_name,
                    "-F", "c",
                    "-f", "/tmp/atri_backup.dump",
                    env=env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await process.communicate()

                if process.returncode == 0:
                    # 从容器复制回 Windows 备份目录
                    cp = await asyncio.create_subprocess_exec(
                        "docker", "cp", f"{container_name}:/tmp/atri_backup.dump", str(filepath),
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    await cp.communicate()
                    if not filepath.exists():
                        self.log.error("数据库备份失败: docker cp 未生成备份文件")
                        return
                else:
                    err_msg = stderr.decode("utf-8", errors="replace").strip() or "未知错误"
                    self.log.error(f"数据库备份失败: {err_msg}")
                    return
            else:
                # 回退方案：本机 pg_dump（硬编码路径，若版本不匹配会报错并提示）
                pg_dump = Path(r"C:\Program Files\PostgreSQL\17\bin\pg_dump.exe")
                if not pg_dump.exists():
                    self.log.error("数据库备份失败: 未找到 pg_dump 工具")
                    return

                process = await asyncio.create_subprocess_exec(
                    str(pg_dump),
                    "-h", str(db_cfg.host),
                    "-p", str(db_cfg.port),
                    "-U", str(db_cfg.user),
                    "-d", db_name,
                    "-F", "c",
                    "-f", str(filepath),
                    env=env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )

                stdout, stderr = await process.communicate()

                if process.returncode != 0:
                    err_msg = stderr.decode("utf-8", errors="replace").strip() or "未知错误"
                    self.log.error(f"数据库备份失败: {err_msg}")
                    return

            if filepath.exists():
                size_kb = filepath.stat().st_size / 1024
                self.log.info(f"数据库备份完成: {filepath.name} ({size_kb:.1f} KB)")

                # 只保留最新 15 个备份，删除其余旧文件
                backups = sorted(
                    backup_dir.glob("ATRI-backup-*.dump"),
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
                for old in backups[15:]:
                    old.unlink(missing_ok=True)
                    self.log.debug(f"已清理旧备份: {old.name}")
        except Exception:
            self.log.exception("数据库备份异常")

    async def graceful_shutdown(self) -> None:
        """等待关闭流程执行完成"""
        if self._shutdown_task is None:
            self._shutdown_task = asyncio.create_task(self.shutdown(), name="BotFramework.shutdown")

        try:
            await asyncio.shield(self._shutdown_task)
        except asyncio.CancelledError:
            current_task = asyncio.current_task()
            if current_task is not None:
                while current_task.cancelling():
                    current_task.uncancel()

            await self._shutdown_task
            raise

    async def shutdown(self) -> None:
        """关闭可显式回收的服务"""
        if self._is_shutdown:
            return

        self.log.info("正在清理回收资源~")

        await self._cancel_background_tasks()
        await container.shutdown()

        self._is_shutdown = True

    async def _cancel_background_tasks(self) -> None:
        """取消并等待所有受控后台任务"""
        if not self._background_tasks:
            return

        tasks = list(self._background_tasks)
        for task in tasks:
            if not task.done():
                task.cancel()

        await asyncio.gather(*tasks, return_exceptions=True)
        self._background_tasks.clear()
