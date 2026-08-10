import asyncio
import base64
import io
from logging import Logger
from typing import Any

import aiohttp
from PIL import Image, ImageFile

# 允许 PIL 加载被截断的图片（QQ 表情/贴图等常有截断情况）
ImageFile.LOAD_TRUNCATED_IMAGES = True

from atribot.common_utils.file.file_utils import resolve_file_to_bytes
from atribot.common_utils.file.media_cache import (
    _get_lock,
    cache_get,
    cache_put,
    make_cache_key,
)
from atribot.common_utils.file.media_utils import MediaConvertResult
from atribot.common_utils.http_client import HTTPClient
from atribot.core.service_container import container
from atribot.core.type.chat_message_types import File


def compress_image(image_bytes: bytes, max_size_kb: int) -> bytes:
    """
    压缩图片到指定大小以内(包含画质降低和尺寸缩放两种策略)
    
    先通过逐步降低画质(从90到20)来减小文件大小，
    如果仍超过限制,则按比例缩小图片尺寸并固定画质为20继续压缩,
    直到达到目标大小或尺寸过小(小于10像素)为止
    
    Args:
        image_bytes: 原始图片的字节数据
        max_size_kb: 目标大小上限,单位KB
    
    Returns:
        bytes: 压缩后的图片字节数据如果压缩失败或原始图片已符合要求，返回原始数据
    
    Examples:
        >>> with open('large.jpg', 'rb') as f:
        ...     compressed = compress_image(f.read(), 500)
        >>> print(f'压缩后大小: {len(compressed) / 1024:.2f}KB')
    """
    max_size_bytes = max_size_kb * 1024

    try:
        image = Image.open(io.BytesIO(image_bytes))

        if image.mode != "RGB":
            image = image.convert("RGB")

        # 先直接保存为最高画质 JPEG，避免 GIF 等格式的 MIME 不匹配
        out = io.BytesIO()
        image.save(out, format="JPEG", quality=95)
        jpeg_bytes = out.getvalue()

        if len(jpeg_bytes) <= max_size_bytes:
            return jpeg_bytes

        quality = 90
        scale = 1.0

        while True:
            out = io.BytesIO()

            if quality >= 20:
                image.save(out, format="JPEG", quality=quality)
                quality -= 10
            else:
                scale *= 0.8
                new_width = int(image.width * scale)
                new_height = int(image.height * scale)

                if new_width < 10 or new_height < 10:
                    break

                temp_image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
                temp_image.save(out, format="JPEG", quality=20)

            if out.tell() <= max_size_bytes:
                return out.getvalue()

        return out.getvalue()
    except Exception as error:
        print(f"图片压缩失败: {error}")
        return image_bytes


async def urls_list_to_base64(
    urls: list[str],
    prefix: str = "data:image/jpeg;base64,",
    concurrency: int = 5,
    max_size_kb: int | None = 1024,
) -> list[str]:
    """
    并发下载一组图片 URL 并压缩，返回对应的 base64 字符串列表
    
    使用 aiohttp 实现并发下载，通过信号量控制并发数量
    下载后的图片会根据指定的体积限制进行压缩
    
    Args:
        urls: 图片URL地址列表
        prefix: Base64字符串的前缀,默认为JPEG格式的数据URI前缀
        concurrency: 最大并发下载数量,默认为5
        max_size_kb: 图片最大体积限制,单位KB设为 None 表示不压缩
                    默认值为 1024KB (1MB)
    
    Returns:
        List[str]: 与输入顺序一致的base64字符串列表
                如果某个URL下载失败,对应的位置会返回空字符串
    
    Examples:
        >>> urls = ['https://example.com/image1.jpg', 'https://example.com/image2.jpg']
        >>> results = await urls_to_base64(urls, max_size_kb=500)
        >>> for i, base64_str in enumerate(results):
        ...     if base64_str:
        ...         print(f'图片{i+1}转换成功')
    
    Raises:
        Exception: 此方法不会抛出异常，所有异常都会被捕获并记录，
                失败的URL对应位置返回空字符串
    """
    semaphore = asyncio.Semaphore(concurrency)
    session:aiohttp.ClientSession = container.get("HTTPClient").session

    async def fetch(url: str) -> str:
        async with semaphore:
            try:
                async with session.get(
                    url,
                    headers={"Accept": "image/*;q=0.8"},
                ) as resp:
                    if resp.status != 200:
                        return ""

                    content = await resp.read()
                    if len(content) == 0:
                        return ""

                    if max_size_kb is not None:
                        content = await asyncio.to_thread(compress_image, content, max_size_kb)

                    return f"{prefix}{base64.b64encode(content).decode('utf-8')}"
            except Exception as error:
                print(f"下载失败 {url}: {error}")
                return ""

    return await asyncio.gather(*(fetch(url) for url in urls))


async def url_to_base64(
    url: str,
    prefix: str = "data:image/jpeg;base64,",
    max_size_kb: int | None = 1024,
) -> str:
    """
    下载单张图片并压缩,返回对应的base64字符串
    
    使用 aiohttp 实现图片下载，下载后的图片会根据指定的体积限制进行压缩
    
    Args:
        url: 图片URL地址
        prefix: Base64字符串的前缀,默认为JPEG格式的数据URI前缀
        max_size_kb: 图片最大体积限制,单位KB设为 None 表示不压缩
                    默认值为 1024KB (1MB)
    
    Returns:
        str: 图片的base64字符串如果下载失败,返回空字符串
    
    Examples:
        >>> url = 'https://example.com/image.jpg'
        >>> result = await url_to_base64(url, max_size_kb=500)
        >>> if result:
        ...     print(f'图片转换成功: {result[:50]}...')
    
    Raises:
        此方法不会抛出异常，所有异常都会被捕获并记录，
        失败时返回空字符串
    """
    try:
        http:HTTPClient = container.get("HTTPClient")
        async with http.session.get(
            url=url,
            headers={
                "User-Agent": "QQ/9.9.21-39038 CFNetwork/1220.1 Darwin/20.3.0",
                "Accept": "image/*;q=0.8",
                "Accept-Encoding": "gzip, deflate, br",
                "Connection": "keep-alive",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            }
        ) as resp:
            if resp.status != 200:
                return ""

            content = await resp.read()
            if len(content) == 0:
                return ""

            if max_size_kb is not None:
                content = await asyncio.to_thread(compress_image, content, max_size_kb)

            return f"{prefix}{base64.b64encode(content).decode('utf-8')}"
    except Exception as error:
        print(f"下载失败 {url}: {error}")
        return ""


async def url_to_image_jpeg(
    source: str | File,
    *,
    max_size_kb: int | None = 2048,
    max_bytes: int = 10 * 1024 * 1024,
    file_name: str | None = None,
) -> MediaConvertResult | None:
    """下载图片并统一转换为 JPEG base64(统一格式入口)

    支持 http(s)://、file://、base64:// 以及本地路径等来源，
    下载后通过 ``compress_image`` 压缩为 JPEG 格式。
    转换结果按 file_name(或来源)磁盘缓存，命中时跳过下载与压缩。

    Args:
        source: 图片来源(File 对象或字符串)
        max_size_kb: 压缩后最大体积(KB),None 表示不压缩
        max_bytes: 最大允许下载字节数，默认 10MB
        file_name: 文件名(QQ 媒体为内容哈希),作为缓存键;None 时回退来源标识

    Returns:
        转换成功返回 MediaConvertResult(data, "jpeg", "image/jpeg", True)
        下载或处理失败返回 None
    """
    src = source.file if isinstance(source, File) else str(source)
    key = make_cache_key("image", src, file_name, f"kb={max_size_kb}")

    async with _get_lock(key):
        entry = await cache_get(key)
        if entry is not None:
            return MediaConvertResult(
                data=entry.to_base64(),
                fmt=entry.fmt,
                mime=entry.mime,
                converted=entry.converted,
            )

        try:
            _, data = await resolve_file_to_bytes(source, "image", max_bytes=max_bytes)
        except Exception:
            return None

        if max_size_kb is not None:
            data = await asyncio.to_thread(compress_image, data, max_size_kb)

        result = MediaConvertResult(
            data=base64.b64encode(data).decode(),
            fmt="jpeg",
            mime="image/jpeg",
            converted=True,
        )
        await cache_put(key, data, result.fmt, result.mime, result.converted)
        return result


async def refresh_image_download_url(
    file_id: str | None,
    send_client: Any | None,
    log: Logger | None = None,
) -> str | None:
    """通过 OneBot ``get_image`` API 刷新 QQ 图片的下载链接

    QQ 图片 CDN 链接（``multimedia.nt.qq.com.cn``）携带的 ``rkey`` 签名
    有时效性，过期后中转服务器（如 litellm）无法下载该 URL，导致请求 400。
    本函数使用 CQ 码中的 ``file`` 字段（图片的 file_id）调用 OneBot
    ``get_image`` API，换取一张新鲜的下载链接。

    只做「刷新链接」操作，**不下载、不转 base64**，避免把大量图片字节
    塞进 LLM 上下文导致上下文超限。刷新失败返回 ``None``，由调用方降级为
    文本描述（如 ``[图片已过期无法识别]``），保证不会把过期 URL 传给 LLM。

    Args:
        file_id: QQ 图片的 file 字段(CQ 码中的 file),用于换取新链接
        send_client: 发送客户端(需有 get_img_details 方法)
        log: 可选日志器

    Returns:
        新的 http(s) 下载 URL;刷新失败或无法刷新返回 None
    """
    if not file_id or send_client is None or not hasattr(send_client, "get_img_details"):
        return None

    try:
        resp = await send_client.get_img_details(file_id)
        new_url: str | None = None
        if isinstance(resp, dict):
            data = resp.get("data")
            if isinstance(data, dict):
                new_url = data.get("url")
            if not new_url:
                new_url = resp.get("url")
        # 只接受 http(s) URL:有些实现 data.file 返回本地缓存路径,不能给中转 fetch
        if new_url and new_url.startswith(("http://", "https://")):
            return new_url
        if log:
            log.warning(f"刷新图片下载链接失败: file_id={file_id}, resp={resp}")
        return None
    except Exception as error:
        if log:
            log.warning(f"刷新图片下载链接异常: file_id={file_id}, error={error}")
        return None
