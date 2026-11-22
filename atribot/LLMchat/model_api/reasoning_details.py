"""Gemini thought signature（思维签名）的提取与回放工具。

Gemini 3/4 在函数调用时会暂停内部思考，并把思考状态加密成 ``thought_signature``。
若下一轮请求没有把该签名原样回放，网关会直接返回 400
（``Function call is missing a thought_signature``）。

该签名不属于 OpenAI 规范字段，网关的响应会把它放在
``message.reasoning_details`` 或 ``message.provider_specific_fields.reasoning_details``，
而请求侧只认 assistant 消息顶层的 ``reasoning_details``。
本模块负责统一提取，并兼容流式增量累加。
"""

from typing import Any, Dict, Iterable, List, Optional


def _coerce(entries: Any) -> List[Dict[str, Any]]:
    """过滤出合法的条目列表"""
    if not isinstance(entries, list):
        return []
    return [entry for entry in entries if isinstance(entry, dict)]


def extract_reasoning_details(payload: Any) -> List[Dict[str, Any]]:
    """从响应消息或流式 delta 中提取 reasoning_details

    优先取顶层字段；网关把签名包在 ``provider_specific_fields`` 里时也能识别。

    Args:
        payload (Any): assistant 消息或 delta 字典

    Returns:
        List[Dict[str, Any]]: 签名条目列表, 取不到时返回空列表
    """
    if not isinstance(payload, dict):
        return []

    if entries := _coerce(payload.get("reasoning_details")):
        return entries

    provider_fields = payload.get("provider_specific_fields")
    if isinstance(provider_fields, dict):
        return _coerce(provider_fields.get("reasoning_details"))

    return []


def merge_reasoning_details(
    target: List[Dict[str, Any]],
    incoming: Iterable[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """把流式增量并入累积列表

    同一 ``(type, text)`` 只保留一条, 签名取最新值, 文本取更长者。

    Args:
        target (List[Dict[str, Any]]): 已累积的条目
        incoming (Iterable[Dict[str, Any]]): 本次增量条目

    Returns:
        List[Dict[str, Any]]: 合并后的列表(就地修改 target)
    """
    for entry in incoming:
        key = (entry.get("type"), entry.get("text"))
        for existing in target:
            if (existing.get("type"), existing.get("text")) != key:
                continue
            if signature := entry.get("signature"):
                existing["signature"] = signature
            new_text = entry.get("text")
            old_text = existing.get("text")
            if isinstance(new_text, str) and isinstance(old_text, str) and len(new_text) > len(old_text):
                existing["text"] = new_text
            break
        else:
            target.append(dict(entry))
    return target


def attach_reasoning_details(message: Dict[str, Any], details: List[Dict[str, Any]]) -> Dict[str, Any]:
    """把签名条目写入 assistant 消息(顶层字段), 空列表时不做改动

    Args:
        message (Dict[str, Any]): assistant 消息
        details (List[Dict[str, Any]]): 签名条目

    Returns:
        Dict[str, Any]: 同一个 message 对象
    """
    if details and "reasoning_details" not in message:
        message["reasoning_details"] = details
    return message


def collect_from_message(message: Optional[Dict[str, Any]]) -> Optional[List[Dict[str, Any]]]:
    """从非流式/流式归一的 assistant 消息中取签名, 便于直接写入上下文

    Returns:
        Optional[List[Dict[str, Any]]]: 有签名时返回条目列表, 否则 None
    """
    details = extract_reasoning_details(message)
    return details or None
