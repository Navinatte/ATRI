from atribot.common_utils.json_utils import extract_json_from_text


def test_extract_json_from_markdown_code_block():
    text = 'before\n```json\n{"name": "atri", "enabled": true}\n```\nafter'

    assert extract_json_from_text(text) == {"name": "atri", "enabled": True}


def test_extract_json_from_embedded_object():
    text = 'model output: {"answer": "ok", "count": 2}'

    assert extract_json_from_text(text) == {"answer": "ok", "count": 2}


def test_extract_json_repairs_common_llm_json():
    text = "```json\n{'name': 'atri', 'items': [1, 2,],}\n```"

    assert extract_json_from_text(text) == {"name": "atri", "items": [1, 2]}


def test_extract_json_returns_original_text_without_json():
    text = "plain text without any object"

    assert extract_json_from_text(text) == text


def test_extract_json_with_chatter_before_and_after():
    """模型在 json 前后"添油加醋"混入闲聊文本时仍能正确提取"""
    text = '阿范让我查长沙历史地震记录，这个需要联网搜索一下~再确认一下今天群里传的长沙地震速报~{\n    "actions": [\n        {\n            "decision": "speak"\n        }\n    ]\n}\n好的就这么回!'

    assert extract_json_from_text(text) == {"actions": [{"decision": "speak"}]}


def test_extract_json_ignores_braces_inside_strings():
    """json 字符串值内部的 `{`/`}` 不会干扰配平提取"""
    text = '前言~ {"content": [ "} 不是结尾 { 也不是", "正常" ], "ok": true } 后记~'

    assert extract_json_from_text(text) == {
        "content": ["} 不是结尾 { 也不是", "正常"],
        "ok": True,
    }


def test_extract_json_falls_back_to_inner_when_outer_truncated():
    """外层对象被截断无法配平时,退而提取内部配平的子对象"""
    text = '闲聊 {"outer": {"decision": "speak"} 这里的外层没有闭合'

    assert extract_json_from_text(text) == {"decision": "speak"}
