from atribot.commands.audio.TTS import TTSService
from atribot.core.type.bot_types import atriMessageEvent

tts_main = TTSService()

tool_json = {
    "name": "send_speech_message",
    "description": "在你想发语音或是有人让你说话（发声的那种）的时候使用,将文本内容转换为语音消息并进行发送,要避免输入符号等不可读文本，【关于 send_speech_message 工具的特别说明】1. 语音模型是基于日语专门调优的。为了获得最佳听感，请尽量输入【日语文本】进行语音合成。如果输入中文，发音可能会有些不自然（发飘）。2. 每次调用该工具发送日语语音后，在紧接着的【文字回复】中，必须首先提供该段语音的【中文翻译】（例如：“（中文翻译：...）”），然后再继续用文字回复本次想要表达的其他内容。3. 为了提高语音合成质量，在生成语音文本时，请尽量**避免使用“呣”等语气词**，建议在开心时**多使用“哼哼”、“嘿嘿”、“ふふっ”等开心的语气词，但是尽量不要使用“呵呵”，这个给人的感觉是比较无语的样子**",
    "properties": {
        "text": {
            "type": "string",
            "description": "需转换为语音的文本内容（支持中文/日语）可以混合语言,不要加入英文字母",
        },
        "emotion": {
            "type": "string",
            "enum": ["高兴", "机械", "平静"],
            "description": "音频的情感",
            "default": "高兴"
        },
        "speed": {
            "type": "number",
            "description": "语速,取值范围0.9~1.2,默认1",
            "default": 1.0
        }
    }
}

async def main(text: str, message_data: atriMessageEvent, emotion: str = "高兴", speed: float = 0.9) -> str:
    """发送语音消息"""
    audio_path = await tts_main.get_tts_path(
        text = text,
        emotion = emotion,
        speed = speed
    )
    await message_data.send_client.send_group_audio(message_data.group_id, audio_path, default=True)

    return f"已发送语音：{text}"