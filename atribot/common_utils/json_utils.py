import json
import re
from typing import Any

import json_repair


def _find_balanced_json(text: str) -> str | None:
    """在文本中定位第一个大括号配平的 JSON 对象

    从左到右扫描,字符串内部的 `{` / `}` 会被跳过;
    若某个起始 `{` 扫描到文本末尾仍无法配平(例如输出被截断),
    则从下一个 `{` 重新尝试,这样可以退而提取内部配平的子对象。

    Args:
        text (str): 原始文本

    Returns:
        str | None: 提取出的 JSON 子串,找不到时返回 None
    """
    start = text.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue

            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[start : i + 1]

        start = text.find("{", start + 1)

    return None


def _load_json(extracted_str: str) -> Any:
    """先严格解析,失败则用 json_repair 兜底修复

    Args:
        extracted_str (str): 待解析的 JSON 子串

    Returns:
        Any: 解析结果,通常为 dict
    """
    try:
        return json.loads(extracted_str)
    except json.JSONDecodeError:
        return json_repair.loads(extracted_str)


def extract_json_from_text(text: str) -> dict[str, Any] | str:
    """
    尝试解析文本中的JSON字符串为字典。

    逻辑流程：
    1. 优先从 Markdown 代码块(```json ... ```)中提取大括号配平的 JSON 片段。
    2. 若无代码块,则用大括号配平扫描器从全文中定位第一个完整的 JSON 对象,
       即使模型在 JSON 前后"添油加醋"混入闲聊文本也能正确提取。
    3. 严格 json.loads 失败时使用 json_repair 修复后再解析。
    4. 配平扫描失败时,退回贪婪正则并交给 json_repair 修复。
    5. 如果所有尝试都失败,返回原始文本。

    Args:
        text (str): 包含可能JSON内容的原始文本

    Returns:
        Dict[str, Any]: 解析成功的字典，或在失败时返回原始文本
    """
    # 优先从 markdown 代码块中提取
    for fence_match in re.finditer(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL):
        if extracted_str := _find_balanced_json(fence_match.group(1)):
            return _load_json(extracted_str)

    # json 前后混有闲聊文本时,直接定位第一个配平的 JSON 对象
    if extracted_str := _find_balanced_json(text):
        return _load_json(extracted_str)

    # 找不到配平的 json 时,退回贪婪正则并交给 json_repair 修复
    if match := re.search(r"\{.*\}", text, re.DOTALL):
        return _load_json(match.group(0))

    return text
