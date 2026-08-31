"""群聊上下文丢失问题复现/验证脚本

真实组件:
- EventBus.dispatch   真实的 (rule.order, -priority) 排序与 stop_propagation break 逻辑
- GroupContext        真实的消息 deque + async_lock 追加逻辑
- OneBotMessageEvent  真实信封
- Rule 体系           AtCommandRule(order=10) / AlwaysRule(order=50)

两种模式:
- legacy=True  旧行为(append 放在 order=100 的监听器中,位于 on_chat 之后)
- legacy=False 修复后行为(append 在 pipeline 的 context_loader 中执行,先于一切 dispatch)

场景即用户报告的时序:
A1 B2 B3 A4 C5 C6 B7(回复引用) A8(@bot) B9(@bot)
验证: 触发回复的消息(A8/B9)是否会从群历史中消失 / 被后续触发者看到
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from atribot.core.event_bus.bus import EventBus
from atribot.core.event_bus.rule import AlwaysRule, AtCommandRule, Rule
from atribot.core.platform.message_queue import MessageQueue
from atribot.core.pipeline.middleware import PipelineMiddleware
from atribot.core.pipeline.pipeline import Pipeline
from atribot.core.service_container import container
from atribot.core.type.bot_types import MessageEventEnvelope
from atribot.core.type.chat_types import Context, GroupContext
from atribot.core.type.onebot_event_types import (
    GroupMessageEvent,
    MessageSentEvent,
    PostType,
)
from atribot.core.platform.onebot.message_event import OneBotMessageEvent

BOT_ID = 3829607928
GROUP_ID = 1101249635

# ---------------------------------------------------------------------------
# Mock 外设
# ---------------------------------------------------------------------------


class FakeSendClient:
    """不发真实消息,只记录"""

    async def send_group_msg(self, group_id, message):
        return {"ok": True}

    async def send(self, message):
        return {"ok": True}


class ContextLoader(Rule):
    """模拟 ChatManager._context_loader 的 order=100 中间件行为(挂载上下文)"""

    rule_type = "context_loader_mock"
    order = 100

    def __init__(self, group_context: GroupContext):
        self._ctx = group_context

    async def match(self, msg) -> bool:
        if msg.group_id is not None:
            self._ctx.time_window.add()
            msg._extra["group_context"] = self._ctx
        return True


class StoreRule(Rule):
    """模拟 ChatManager 真实的 _StoreRule(order=100),触发 append 进群历史"""

    rule_type = "store_rule_mock"
    order = 100  # 与真实代码一致

    async def match(self, msg) -> bool:
        return isinstance(msg.event, (GroupMessageEvent, MessageSentEvent))


def make_group_message(user_id: int, text: str, msg_id: int, is_at: bool = False) -> MessageEventEnvelope:
    """构造一条群消息事件(文本段,可带@)"""
    if is_at:
        segments = [
            {"type": "at", "data": {"qq": str(BOT_ID)}},
            {"type": "text", "data": {"text": f" {text}"}},
        ]
    else:
        segments = [{"type": "text", "data": {"text": text}}]

    data = {
        "post_type": "message",
        "message_type": "group",
        "time": 1756200000 + msg_id,
        "self_id": BOT_ID,
        "message_id": msg_id,
        "user_id": user_id,
        "group_id": GROUP_ID,
        "message": segments,
        "raw_message": text,
        "sender": {"user_id": user_id, "nickname": f"用户{user_id % 100}", "card": "", "role": "member"},
    }
    ev = GroupMessageEvent.from_data(data)
    return OneBotMessageEvent(ev, send_client=FakeSendClient(), source="mock")


def make_message_sent(text: str, msg_id: int) -> MessageEventEnvelope:
    """bot 自己发出的消息(MessageSentEvent)"""
    segments = [{"type": "text", "data": {"text": text}}]
    data = {
        "post_type": "message_sent",
        "message_type": "group",
        "time": 1756200000 + msg_id,
        "self_id": BOT_ID,
        "message_id": msg_id,
        "user_id": BOT_ID,
        "group_id": GROUP_ID,
        "message": segments,
        "raw_message": text,
        "sender": {"user_id": BOT_ID, "nickname": "亚托莉", "card": "ATRI", "role": "member"},
    }
    ev = MessageSentEvent.from_data(data)
    return OneBotMessageEvent(ev, send_client=FakeSendClient(), source="mock")


# ---------------------------------------------------------------------------
# 复现场景
# ---------------------------------------------------------------------------


async def run_scenario(name: str, gap_between_msgs: float = 0.01, trigger_cond=None, slow_msg_ids=None, legacy: bool = True, dedup_snapshot: bool = True):
    """按用户报告的时序逐条投递消息,观察群历史可见性

    Args:
        name: 场景名
        gap_between_msgs: 消息间隔(模拟真实聊天节奏)
    """
    print(f"\n{'=' * 62}")
    print(f"场景: {name}")
    print(f"{'=' * 62}")

    # 构建真实组件
    queue = MessageQueue()
    pipeline = Pipeline()
    bus = EventBus(queue, pipeline)

    group_context = GroupContext(
        group_id=GROUP_ID,
        group_max_record=60,
        chat_context=Context(messages=[], user_max_record=20, play_role=""),
        play_roles="亚托莉",
    )
    group_context.information_extraction = False

    # 记录每次触发 LLM 时模型能看到的群历史
    llm_views: list[dict] = []

    # --- 注册与 bot_framework._register_at_routes / ChatManager 相同顺序的监听器 ---

    # 1. AT命令 (order=10, priority=10) - 略过, 不影响本场景

    # 2. store_message_to_db (AlwaysRule order=50, priority=101) - no-op mock
    async def store_message_to_db(msg: MessageEventEnvelope):
        pass

    bus.on(PostType.MESSAGE, rule=AlwaysRule(), priority=101)(store_message_to_db)

    # 3. on_chat (AlwaysRule order=50, priority=100) - 模拟 initiativeChat.decision
    async def on_chat(msg: MessageEventEnvelope):
        ctx = msg._extra.get("group_context")
        if ctx is None:
            return
        # 触发条件: 默认被@即触发; 可自定义(模拟关键词/概率触发)
        triggered = trigger_cond(msg) if trigger_cond else msg.is_at
        if triggered:
            # 模拟修复后 add_group_messages_builder 的 exclude_message_id 去重:
            # 修复后 append 先于 on_chat, 当前消息已在群历史中, 快照时剔除避免双份
            exclude = msg.event.message_id if (not legacy and dedup_snapshot) else None
            visible = [
                e.message_id
                for e in ctx.messages
                if e.message_id != exclude
            ]
            llm_views.append(
                {
                    "trigger_msg_id": msg.event.message_id,
                    "trigger_user": msg.user_id,
                    "visible_ids": visible,
                }
            )
            # 模拟 bot 回复后
            msg.stop_propagation = True  # 真实代码: decision 返回 True → stop_propagation

    bus.on(PostType.MESSAGE, rule=AlwaysRule(), priority=100)(on_chat)

    # 真实架构中 context_loader 是 Pipeline 中间件,在 dispatch 之前执行:
    # 旧架构(legacy): 只挂载上下文, append 放在后面 order=100 的监听器里
    # 新架构(修复后): 挂载上下文后立即 append, 不再依赖监听器
    class ContextLoaderMiddleware(PipelineMiddleware):
        name = "context_loader"

        async def process(self_, msg):
            if msg.group_id is not None:
                group_context.time_window.add()
                msg._extra["group_context"] = group_context
                if not legacy:
                    # 修复后: append 在 pipeline 阶段完成, 不受 stop_propagation 影响
                    await group_context.add_group_chat_event(msg)
            return msg

    await pipeline.add_middleware(ContextLoaderMiddleware())

    # 可选: 慢速中间件, 模拟消息带图/语音时 MediaProcessor 的耗时识别
    class SlowMediaMiddleware(PipelineMiddleware):
        name = "slow_media_mock"

        async def process(self_, msg):
            if slow_msg_ids and msg.event.message_id in slow_msg_ids:
                await asyncio.sleep(0.3)  # 模拟一次多模态识别调用
            return msg

    # 慢媒体中间件在修复后必须在 append 之后注册(否则又会出现慢消息被超车丢历史)
    # 旧架构中媒体处理在哪个阶段不重要(反正 append 在 dispatch 末尾)
    await pipeline.add_middleware(SlowMediaMiddleware())

    # 4. _StoreRule (order=100, priority=60) - 仅旧行为使用(append 放监听器)
    async def store_message_context(msg: MessageEventEnvelope):
        ctx = msg._extra.get("group_context")
        if ctx is None:
            return
        await ctx.add_group_chat_event(msg)

    if legacy:
        class _StoreRuleTuned(StoreRule):
            pass

        bus.on(PostType.MESSAGE, rule=_StoreRuleTuned(), priority=60)(store_message_context)

    # --- 按用户报告时序投递消息 ---
    A, B, C = 111, 222, 333

    seq = [
        ("A", A, "消息1", 1, False),
        ("B", B, "消息2", 2, False),
        ("B", B, "消息3", 3, False),
        ("A", A, "消息4", 4, False),
        ("C", C, "消息5", 5, False),
        ("C", C, "消息6", 6, False),
        ("B", B, "消息7(回复C的消息6)", 7, False),
        ("A", A, "消息8(@bot)", 8, True),
        ("B", B, "消息9(@bot)", 9, True),
    ]

    for who, uid, text, mid, is_at in seq:
        msg = make_group_message(uid, text, mid, is_at)
        await bus._handle_message(msg)
        # 触发回复后,bot 的回复消息也会进入(message_sent)
        if is_at:
            sent = make_message_sent(f"回复{who}的消息{mid}", 1000 + mid)
            await bus._handle_message(sent)

    # --- 结果分析 ---
    expected_ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1008, 1009]
    history_ids = [e.message_id for e in group_context.messages]

    print(f"\n期望群历史(按发送顺序): {expected_ids}")
    print(f"实际群历史:             {history_ids}")

    missing = [i for i in expected_ids if i not in history_ids]
    if missing:
        print(f"\n❌ 丢失的消息 ID: {missing}")
        for mid in missing:
            if mid >= 1000:
                print(f"   - 消息{mid - 1000}(触发回复的那条 @ 消息)没有进入群历史!")
            else:
                print(f"   - 消息{mid} 没有进入群历史!")
    else:
        print("\n✅ 全部消息都进入了群历史")

    print(f"\nLLM 触发时看到的群历史:")
    for v in llm_views:
        print(f"  触发者=用户{v['trigger_user']}(消息{v['trigger_msg_id']})")

    return group_context, llm_views, missing


async def run_race_scenario(legacy: bool = True):
    """场景2: 偶发竞态 — 带图消息在 Pipeline 慢处理中被后发的 @ 消息超车


    消息6(带图,需 0.3s 媒体识别)与消息8(@bot)几乎同时到达。
    两者各自占用独立的 _start_message_task 任务, 消息8 无媒体耗时,
    先完成 pipeline 进入 dispatch → 构建 prompt 时消息6 尚未 append。
   
    旧架构(legacy=True): append 在 dispatch 末尾(order=100 监听器),
                         慢消息的 append 被媒体识别延迟, 快消息触发时看不到它 → 竞态必现
    新架构(legacy=False): append 在 pipeline 首个中间件即完成,
                          慢的只是后续媒体识别, append 本身不再有耗时差异 → 竞态消除
    """
    mode = "旧架构(append 在监听器)" if legacy else "新架构(append 在 pipeline)"
    print(f"\n{'=' * 62}")
    print(f"场景2: 偶发竞态 — 带图消息被后发 @ 消息超车 [{mode}]")
    print(f"{'=' * 62}")

    queue = MessageQueue()
    pipeline = Pipeline()
    bus = EventBus(queue, pipeline)

    group_context = GroupContext(
        group_id=GROUP_ID,
        group_max_record=60,
        chat_context=Context(messages=[], user_max_record=20, play_role=""),
        play_roles="亚托莉",
    )
    group_context.information_extraction = False
    llm_views = []

    async def on_chat(msg: MessageEventEnvelope):
        ctx = msg._extra.get("group_context")
        if ctx is None:
            return
        if msg.is_at:
            visible = [getattr(e, "message_id", None) for e in ctx.messages]
            llm_views.append({"trigger_msg_id": msg.event.message_id, "visible_ids": visible})
            msg.stop_propagation = True

    bus.on(PostType.MESSAGE, rule=AlwaysRule(), priority=100)(on_chat)

    class _Store(StoreRule):
        pass

    async def store_message_context(msg: MessageEventEnvelope):
        ctx = msg._extra.get("group_context")
        if ctx is not None:
            await ctx.add_group_chat_event(msg)

    if legacy:
        bus.on(PostType.MESSAGE, rule=_Store(), priority=60)(store_message_context)

    class Loader(PipelineMiddleware):
        name = "context_loader"

        async def process(self_, msg):
            if msg.group_id is not None:
                msg._extra["group_context"] = group_context
                if not legacy:
                    await group_context.add_group_chat_event(msg)
            return msg

    class SlowMedia(PipelineMiddleware):
        name = "slow_media_mock"

        async def process(self_, msg):
            if msg.event.message_id == 6:  # 消息6 带图, 识别耗时
                await asyncio.sleep(0.3)
            return msg

    await pipeline.add_middleware(Loader())
    await pipeline.add_middleware(SlowMedia())

    # 真实 run() 循环驱动
    runner = asyncio.create_task(bus.run())
    await asyncio.sleep(0.05)

    A, B, C = 111, 222, 333
    seq = [
        (A, 1, False), (B, 2, False), (B, 3, False), (A, 4, False),
        (C, 5, False), (C, 6, False), (B, 7, False),
    ]
    for uid, mid, is_at in seq:
        await queue.push(make_group_message(uid, f"消息{mid}", mid, is_at))

    await asyncio.sleep(0.05)  # 让纯文本消息先跑进 pipeline…消息6仍在慢速识别中
    await queue.push(make_group_message(A, "消息8(@bot)", 8, True))

    await asyncio.sleep(1.0)
    runner.cancel()
    try:
        await runner
    except asyncio.CancelledError:
        pass

    history_ids = [e.message_id for e in group_context.messages]
    print(f"实际群历史: {history_ids}")
    for v in llm_views:
        missing_at_trigger = [i for i in range(1, 9) if i not in v["visible_ids"]]
        print(f"消息8(@bot)触发时可见: {v['visible_ids']} → 看不到: {missing_at_trigger}")
        if 6 in missing_at_trigger:
            print("❌ 复现竞态: 消息6(带图)在消息8触发时不在群历史快照中!")
            return True
    print("✅ 未复现竞态")
    return False


async def main():
    # 场景1[旧]: 用户报告的必现主路径 — 触发回复的消息从群历史消失
    _, _, missing = await run_scenario("场景1[旧架构]: 用户报告 — A/B 交替聊天后分别 @bot", legacy=True)

    # 场景1[新]: 修复后架构(append 在 pipeline 中) — 同样时序不再丢失
    print("\n" + "─" * 62)
    _, views_fixed, missing_fixed = await run_scenario(
        "场景1[新架构]: 修复验证 — 同样时序不丢消息", legacy=False
    )

    # 场景2: 偶发竞态 对比验证
    race_old = await run_race_scenario(legacy=True)
    race_new = await run_race_scenario(legacy=False)

    print("\n" + "=" * 62)
    print("总结:")
    print(f"  场景1[旧] 触发消息丢失:   {'❌ 复现' if missing else '✅ 通过'} (丢失 {len(missing)} 条)")
    print(f"  场景1[新] 修复效果:       {'✅ 修复有效' if not missing_fixed else '❌ 修复无效'}")
    print(f"  场景2[旧] 并发快照竞态:   {'❌ 复现' if race_old else '✅ 未复现'}")
    print(f"  场景2[新] 并发快照竞态:   {'✅ 消除' if not race_new else '❌ 仍存在'}")

    # 新架构下 LLM 视野验证: 触发者能看到同群其他人之前的消息
    if views_fixed and not missing_fixed:
        ok = True
        for v in views_fixed:
            # 消息9在消息8之后才发送,消息8触发时看不到它是正常时序(非丢消息)
            later_same_seq = {8: {9}, 9: set()}
            other_user_msgs = [1, 2, 3, 4, 5, 6, 7, 8, 9]
            core_missing = [
                i for i in other_user_msgs
                if i not in v["visible_ids"]
                and i != v["trigger_msg_id"]
                and i not in later_same_seq.get(v["trigger_msg_id"], set())
            ]
            if core_missing:
                ok = False
                print(f"  ⚠ 触发消息{v['trigger_msg_id']}的视野缺少: {core_missing}")
        print(f"  视野完整性(同群用户消息互见): {'✅ 通过' if ok else '❌ 失败'}")


if __name__ == "__main__":
    asyncio.run(main())
