from logging import Logger
from typing import Optional

from atribot.common_utils.file.image_utils import url_to_image_jpeg
from atribot.common_utils.file.media_cache import cache_get, cache_put, make_cache_key
from atribot.core.service_container import container
from atribot.LLMchat.model_api.universal_async_llm_api import universal_ai_api


class MediaProcessor:
    """多模态媒体转文本处理

    将图片、音频、视频等非文本内容转换为文字，
    为不支持多模态输入的 LLM 提供预处理能力
    """

    # 识别文本缓存标识(与媒体字节缓存共用 media_cache 磁盘存储)
    _CACHE_KIND_DESC = "desc"
    _DESC_CACHE_MISS = "\x00MISS"  # null 哨兵:序列化层面区分"未缓存"与"缓存了空描述"

    def __init__(self) -> None:
        config = container.get("config")
        supplier = container.get("LLMSupplier")
        self.log: Logger = container.get_by_type(Logger).getChild("Media")

        # 图像识别
        try:
            self._image_api: Optional[universal_ai_api] = supplier.connections[
                config.model.detection_image.supplier
            ].connection_object
            self._image_model: Optional[str] = config.model.detection_image.model_name
        except Exception as e:
            self.log.error(f"MediaProcessor图像识别初始化失败: {e}")
            self._image_api = None
            self._image_model = None

        # 音频识别
        try:
            if detection_audio := config.model.detection_audio:
                self._audio_api: Optional[universal_ai_api] = supplier.connections[
                    detection_audio.supplier
                ].connection_object
                self._audio_model: Optional[str] = detection_audio.model_name
            else:
                self._audio_api = None
                self._audio_model = None
        except Exception as e:
            self.log.error(f"MediaProcessor音频识别初始化失败: {e}")
            self._audio_api = None
            self._audio_model = None

        # 视频识别
        try:
            if detection_video := config.model.detection_video:
                self._video_api: Optional[universal_ai_api] = supplier.connections[
                    detection_video.supplier
                ].connection_object
                self._video_model: Optional[str] = detection_video.model_name
            else:
                self._video_api = None
                self._video_model = None
        except Exception as e:
            self.log.error(f"MediaProcessor视频识别初始化失败: {e}")
            self._video_api = None
            self._video_model = None

    async def _desc_cache_get(self, media: str, label: str, file_name: str | None = None) -> str | None:
        """读取识别文本磁盘缓存,命中返回描述文本,未命中返回 None"""
        key = make_cache_key(self._CACHE_KIND_DESC, media, file_name, f"label={label}")
        entry = await cache_get(key)
        if entry is None:
            return None
        desc = entry.data.decode("utf-8", errors="replace")
        # null 哨兵表示之前识别得到空结果,抑制重复识别直接返回空描述
        return "" if desc == self._DESC_CACHE_MISS else desc

    async def _desc_cache_put(self, media: str, label: str, desc: str, file_name: str | None = None) -> None:
        """写入识别文本磁盘缓存(含失败结果,防止反复对同一媒体重试烧钱)"""
        key = make_cache_key(self._CACHE_KIND_DESC, media, file_name, f"label={label}")
        payload = self._DESC_CACHE_MISS if not desc.strip() else desc
        await cache_put(key, payload.encode("utf-8"), "txt", "text/plain", True)

    async def image_to_text(self, image_url: str, file_name: str | None = None) -> str:
        """将图片转换为文字描述。

        先本地下载并统一转码为 JPEG base64 再交由识别模型处理,
        识别结果磁盘缓存:优先用 file_name(QQ 内容哈希,rkey 刷新后仍命中),
        未提供时回退 URL 去参哈希。
        
        Args:
            image_url: 图片地址(http/https 或 base64:// 或 data: URI)
            file_name: QQ 图片 file 字段(内容哈希),作为缓存键,强烈建议传入

        Returns:
            模型生成的图片内容描述
        """
        if not self._image_api:
            return "图像识别失败"
        if not image_url:
            return "图片识别出现错误: 图片地址为空"

        # 磁盘缓存命中直接返回,跳过下载与识别
        if (cached := await self._desc_cache_get(image_url, "image", file_name)) is not None:
            return cached

        try:
            # QQ CDN URL 有 rkey 签名时效，且模型服务器在国外无法直连
            # 先下载图片转为 base64 data URI 再传给视觉模型
            if image_url.startswith("data:"):
                img_src = image_url  # 已经是 base64
            else:
                result = await url_to_image_jpeg(image_url)
                if result is not None:
                    img_src = f"data:{result.mime};base64,{result.data}"
                else:
                    return "图片下载失败"
            result = await self._image_api.generate_text_lightweight(
                model=self._image_model,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": img_src}},
                        {"type": "text", "text": "请详细描述你看到的东西，上面是什么、有什么、在什么地方，如果上面有文字也要详细说清楚，如果有什么自己的理解可以说出来，如果上面是什么你认识的可以介绍一下"}
                    ]
                }]
            )
            desc = result["choices"][0]["message"]["content"]
            await self._desc_cache_put(image_url, "image", desc, file_name)
            return desc
        except Exception as e:
            return f"图片识别出现错误: {result if 'result' in locals() else e}"

    async def audio_to_text(self, audio_url: str, file_name: str | None = None) -> str:
        """将音频转换为文字,识别结果磁盘缓存(键优先用 file_name)

        Args:
            audio_url: 音频地址
            file_name: QQ 语音 file 字段(内容哈希),作为缓存键,建议传入

        Returns:
            语音识别或听觉理解的文字内容
        """
        if not self._audio_api:
            return "音频转文本失败,未配置"

        if (cached := await self._desc_cache_get(audio_url, "audio", file_name)) is not None:
            return cached

        try:
            result = await self._audio_api.generate_text_lightweight(
                model=self._audio_model,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "input_audio", "input_audio": {"url": audio_url}},
                        {"type": "text", "text": "请将音频内容转录为文字，并描述其中的语气、情绪或背景声音"}
                    ]
                }]
            )
            desc = result["choices"][0]["message"]["content"]
            await self._desc_cache_put(audio_url, "audio", desc, file_name)
            return desc
        except Exception as e:
            return f"音频识别出现错误: {result if 'result' in locals() else e}"

    async def video_to_text(self, video_url: str, file_name: str | None = None) -> str:
        """将视频转换为文字描述（需配置 config.model.detection_video）,识别结果磁盘缓存

        Args:
            video_url: 视频地址
            file_name: QQ 视频 file 字段(内容哈希),作为缓存键,建议传入

        Returns:
            视频内容的文字描述
        """
        if not self._video_api:
            return "视频转文本失败,未配置"

        if (cached := await self._desc_cache_get(video_url, "video", file_name)) is not None:
            return cached

        try:
            result = await self._video_api.generate_text_lightweight(
                model=self._video_model,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "video_url", "video_url": {"url": video_url}},
                        {"type": "text", "text": "请详细描述视频中的内容，包括画面、声音、人物行为和文字信息"}
                    ]
                }]
            )
            desc = result["choices"][0]["message"]["content"]
            await self._desc_cache_put(video_url, "video", desc, file_name)
            return desc
        except Exception as e:
            return f"视频识别出现错误: {result if 'result' in locals() else e}"
