import asyncio
from pathlib import Path
from typing import Any, Dict

import aiohttp

from atribot.core.atri_config import atriConfig
from atribot.core.service_container import container


class TTSService:
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if not self._initialized:
            self.audio_count = 1
            # GPT-SoVITS v2 FastAPI 端点（api_v2.py），直接读服务器本地路径
            self.api_url = "http://100.126.134.61:9880/tts"

            # 主参考音频（固定使用这一条，所有请求统一）
            # 注意：api_v2 直接读取服务器（zt）上的文件，故使用 zt 本地路径
            self.main_ref_audio_path = "C:/resources/GPT-SoVITS-v4-20250419/参考音频/いえ、見えてましたよ。みなさんがいるの。わたし、目がいいので.wav"
            self.main_ref_prompt_text = "いえ、見えてましたよ。みなさんがいるの。わたし、目がいいので"
            self.main_ref_prompt_lang = "ja"

            # 辅助参考音频（固定三个，多参考音色融合，实测听感最佳）
            self.aux_ref_audio_paths = [
                "C:/resources/GPT-SoVITS-v4-20250419/参考音频/わたしが夏生さんのために行動するのに、理由が必要でしょうか.wav",
                "C:/resources/GPT-SoVITS-v4-20250419/参考音频/そうでした。時間もありませんし、そちらを優先します.wav",
                "C:/resources/GPT-SoVITS-v4-20250419/参考音频/…どうしてしまったのでしょう、わたしは.wav",
            ]

            self.emotion_list = {
                "高兴": {
                    "refer_wav_path": "C:/resources/GPT-SoVITS-v4-20250419/参考音频/いえ、見えてましたよ。みなさんがいるの。わたし、目がいいので.wav",
                    "prompt_text": "いえ、見えてましたよ。みなさんがいるの。わたし、目がいいので",
                    "prompt_language": "ja"
                },
                "机械": {
                    "refer_wav_path": "C:/resources/GPT-SoVITS-v4-20250419/参考音频/間違いありません。知性の欠片も感じない、ジャ力ジャ力とうるさいだけの音楽です.wav",
                    "prompt_text": "間違いありません。知性の欠片も感じない、ジャ力ジャ力とうるさいだけの音楽です",
                    "prompt_language": "ja"
                },            
                "平静": {
                    "refer_wav_path": "C:/resources/GPT-SoVITS-v4-20250419/参考音频/間違いありません。知性の欠片も感じない、ジャ力ジャ力とうるさいだけの音楽です.wav",
                    "prompt_text": "間違いありません。知性の欠片も感じない、ジャ力ジャ力とうるさいだけの音楽です",
                    "prompt_language": "ja"
                }
            }
            config:atriConfig = container.get("config")
            self.base_output_path = config.file_path.audio
            self.relative_output_prefix = Path("TTS_output/output")
            self._initialized = True

    async def get_tts_path(self, text: str, emotion: str = "高兴", speed: float = 1.0) -> Path:
        """TTS文本合成语音
        
        Args:
            text (str): 需要合成的文本,支持中日英韩，但是目前不要输入韩文
            emotion (str): 音频的情感,枚举值：高兴,机械,平静
            speed (float): 语速,取值范围0.9~1.2,默认1
            
        Raises:
            ValueError: 抛出包含错误信息的json

        Returns:
            Path: 返回wav文件的绝对路径
        """
        # raise ValueError("语音因为资源分配问题暂时被关了,不要再尝试使用")
        
        self._validate_parameters(text, emotion, speed)
        
        payload = self._build_payload(text, emotion, speed)
        
        return await self._send_tts_request(payload)

    def _validate_parameters(self, text: str, emotion: str, speed: float) -> None:
        """验证输入参数"""
        if emotion not in self.emotion_list:
            raise ValueError(f"不支持的情感: {emotion}")
        
        if 0 < len(text) > 220:
            raise ValueError(f"输入字符应在1到220之间,当前有{len(text)}个")
        
        if not 0.9 <= speed <= 1.2:
            raise ValueError(f"语速必须在0.9到1.2之间,当前值: {speed}")

    def _build_payload(self, text: str, emotion: str, speed: float) -> Dict[str, Any]:
        """构建TTS请求的负载（GPT-SoVITS api_v2 /tts 接口格式）

        每次请求固定使用：主参考音频 + 三个辅助参考音频（音色融合听感最佳）
        参考音频路径为服务器（zt）本地路径，api_v2 直接读取
        参数对齐 zt 上复现脚本验证成功的组合
        """
        return {
            "text": text,
            # 语音模型基于日语调优，目标语言写死为日语，保证发音稳定
            "text_lang": "ja",
            "ref_audio_path": self.main_ref_audio_path,
            "aux_ref_audio_paths": self.aux_ref_audio_paths,
            "prompt_text": self.main_ref_prompt_text,
            "prompt_lang": "ja",
            "top_k": 5,
            "top_p": 1,
            "temperature": 1,
            "text_split_method": "cut1",
            "batch_size": 20,
            "speed_factor": speed,
            "split_bucket": True,
            "fragment_interval": 0.3,
            "seed": -1,
            "media_type": "wav",
            "streaming_mode": False,
            "parallel_infer": True,
            "repetition_penalty": 1.35,
            "sample_steps": 32,
            "super_sampling": False,
        }

    async def _send_tts_request(self, payload: Dict[str, Any]) -> str:
        """发送TTS请求并处理响应"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(self.api_url, json=payload) as response:
                    if response.status == 200:
                        audio_bytes = await response.read()
                        return await self._save_audio_file(audio_bytes)
                    else:
                        error_data = await response.json()
                        raise ValueError(f"TTS请求失败: {error_data}")
        except aiohttp.ClientError as e:
            raise ValueError(f"网络请求错误: {str(e)}")
        except Exception as e:
            raise ValueError(f"处理TTS请求时发生错误: {str(e)}")

    async def _save_audio_file(self, audio_bytes: bytes) -> Path:
        audio_full_path = self.base_output_path / self.relative_output_prefix / f"{self.audio_count}.wav"

        audio_full_path.parent.mkdir(parents=True, exist_ok=True)

        with open(audio_full_path, "wb") as f:
            f.write(audio_bytes)

        self._update_audio_count()

        return audio_full_path

    def _update_audio_count(self) -> None:
        """更新音频文件计数器"""
        if self.audio_count >= 10:
            self.audio_count = 1
        else:
            self.audio_count += 1

    def get_supported_emotions(self) -> list:
        """获取支持的情感列表"""
        return list(self.emotion_list.keys())

    def set_output_path(self, base_path: str, relative_prefix: str = None) -> None:
        """设置输出路径配置"""
        self.base_output_path = base_path
        if relative_prefix:
            self.relative_output_prefix = relative_prefix
