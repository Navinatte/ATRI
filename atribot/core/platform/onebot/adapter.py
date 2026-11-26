import asyncio
import json
import logging
from typing import Any

from atribot.core.atri_config import (
    HttpAdapterConfig,
    PlatformInstanceConfig,
    WebSocketClientConfig,
    WebSocketServerConfig,
)
from atribot.core.platform import register_adapter
from atribot.core.platform.base import PlatformAdapter
from atribot.core.platform.message_queue import MessageQueue
from atribot.core.platform.onebot.connection import OneBotHttpServer, OneBotWSClient, OneBotWSServer
from atribot.core.platform.onebot.forward import fill_forward_content
from atribot.core.platform.onebot.message_event import OneBotMessageEvent
from atribot.core.platform.onebot.send import OneBotSendClient
from atribot.core.service_container import container
from atribot.core.type.chat_message_types import SendMessage
from atribot.core.type.onebot_event_types import OneBotEvent


@register_adapter("onebot")
class OneBotAdapter(PlatformAdapter):
    """OneBot 协议平台适配器"""

    def __init__(
        self,
        config: PlatformInstanceConfig,
        queue: MessageQueue,
    ):
        self._config = config
        self._queue = queue
        self._source_name = config.source_name
        self._log = container.get_by_type(logging.Logger).getChild(f"OneBotAdapter.{config.source_name}")
        self._started = False

        self._connection, http_base_url = self._build_connection()
        self._send_client = self._build_send_client(http_base_url)

    def _build_connection(self) -> tuple[Any, str]:
        """创建底层连接，返回 (连接对象, HTTP 基址)

        子类可覆写此方法以适配不同 OneBot 实现（如 LLBot）
        """
        config = self._config
        if isinstance(config, WebSocketClientConfig):
            return (
                OneBotWSClient(
                    url=config.url,
                    access_token=config.access_token,
                    log=self._log.getChild("WSClient"),
                ),
                f"http://{config.url}",
            )
        if isinstance(config, WebSocketServerConfig):
            return (
                OneBotWSServer(
                    host=config.host,
                    port=config.port,
                    access_token=config.access_token,
                    log=self._log.getChild("WSServer"),
                ),
                f"http://{config.host}:{config.port}",
            )
        if isinstance(config, HttpAdapterConfig):
            return (
                OneBotHttpServer(
                    host=config.host,
                    port=config.port,
                    access_token=config.access_token,
                    log=self._log.getChild("HttpServer"),
                ),
                config.url,
            )
        raise ValueError(
            f"不支持的连接类型: {config.connection_type} "
            f"(平台: {self._source_name})"
        )

    def _build_send_client(self, http_base_url: str) -> OneBotSendClient:
        """创建消息发送客户端，子类可覆写以适配不同 OneBot 实现"""
        config = self._config
        return OneBotSendClient(
            access_token=config.access_token or "",
            http_base_url=http_base_url,
            file_http_url=config.file_http_url or "http://127.0.0.1:3000",
            connection_type=config.connection_type,
            ws_connection=self._connection,
            log=self._log.getChild("Send"),
        )

    async def _normalize_event(self, data: dict) -> dict:
        """事件预处理器，子类可覆写以兼容不同实现的事件字段

        基类负责补全合并转发内容（NapCat 自带 content 时只做本地规范化，
        不发请求；LLBot 等只给 resId 的实现会调用 get_forward_msg 拉取）。
        """
        return await fill_forward_content(self._send_client, data, self._log)

    @property
    def source_name(self) -> str:
        return self._source_name

    @property
    def is_started(self) -> bool:
        return self._started


    async def start(self) -> None:
        """启动适配器：注册消息回调 → 启动连接(WS / HTTP)"""
        if self._started:
            return

        self._connection.add_listener(self._on_raw_message)
        self._log.info(
            "正在连接 (type=%s, source=%s, target=%s)",
            self._config.connection_type,
            self._source_name,
            getattr(self._config, "url", f"{getattr(self._config, 'host', '?')}:{getattr(self._config, 'port', '?')}"),
        )

        self._conn_task = asyncio.create_task(self._connection.start())
        self._started = True

        if hasattr(self._connection, "wait_for_connection"):
            ok = await self._connection.wait_for_connection(timeout=5.0)
            if ok:
                self._log.info("连接已建立")
            else:
                self._log.warning("连接尚未建立（后台重试中）")
        else:
            self._log.info("已启动（监听中）")

    async def stop(self) -> None:
        """停止适配器"""
        if not self._started:
            return

        self._log.info("正在停止...")
        try:
            self._connection.remove_listener(self._on_raw_message)
        except (ValueError, Exception) as e:
            self._log.warning("移除监听器时出错: %s", e)

        await self._connection.close()
        await self._send_client.close()
        self._started = False
        self._log.info("已停止")

    async def send(self, message: SendMessage) -> Any:
        """发送消息到 OneBot 平台

        Args:
            message: 已构建好的 GroupMessage 或 PrivateMessage

        Returns:
            API 响应，或 None
        """
        return await self._send_client.send(message)

    def get_client(self) -> object:
        """获取 OneBotSendClient 实例"""
        return self._send_client

    async def call_api(self, action: str, params: dict) -> Any:
        """通用 OneBot API 调用

        直接调用任意 OneBot API 动作

        Args:
            action: API 动作名称
            params: 请求参数字典

        Returns:
            API 响应，或 None
        """
        return await self._send_client.async_send(action, params)

    async def _on_raw_message(self, data: dict) -> None:
        """收到原始 OneBot 事件后的回调(WS / HTTP)

        将原始事件字典转换为类型化的 Message 并推入队列
        """
        # self._log.debug(f"事件:{data}")
        try:
            data = await self._normalize_event(data)
            event = OneBotEvent.from_dict(data)
        except (ValueError, Exception) as e:
            self._log.warning(
                "事件解析失败: %s | raw=%s",
                e,
                json.dumps(data, ensure_ascii=False)[:200],
            )
            return

        msg = OneBotMessageEvent(
            event=event,
            source=self._source_name,
            direction="incoming",
            send_client=self._send_client,
        )
        pushed = await self._queue.push(msg)

        if not pushed:
            self._log.warning(
                "❌ 消息未能入队(队列满): %s post_type=%s",
                type(event).__name__,
                event.post_type.value,
            )

