---
name: suno-music
description: 通过宿主机 suno-api 反代生成 AI 音乐并下载。当用户要求"生成一首歌/音乐"、"用suno生成"、"写首歌"、"来首BGM"时触发。需要配合 run_python_code 工具执行代码。
compatibility: 沙盒需可访问 host.docker.internal:3002（当前环境已满足）；生成的文件写入脚本同级目录，≤20MB 会自动发送到群里
---

# SUNO AI 音乐生成

通过宿主机反代 `http://host.docker.internal:3002` 调用 suno 官方生成音乐，全程用 Python 标准库（urllib），**不要**依赖 requests 等第三方库（沙盒可能没有）。

## 触发场景
用户要求生成歌曲、音乐、BGM、旋律时使用。例如"帮我生成一首歌"、"来首纯音乐"。

## 核心流程
1. **提交生成**：`POST /api/custom_generate`，返回 2 个任务 id
2. **轮询等待**：`GET /api/get?ids=id1,id2`，直到状态为 `complete` 或 `streaming`
3. **下载音频**：取返回的 `audio_url`（或 `video_url`），下载到脚本同级目录，文件名含标题
4. **保存到宿主机**（可选但推荐）：`POST /api/save_audio?filename=xxx.mp3`，body 为文件二进制，保存到宿主 `D:/资源/歌/SUNO`

## 参数说明
| 参数 | 说明 |
|---|---|
| `prompt` | 歌词（带 `[Verse]`/`[Chorus]` 结构）或纯音乐描述 |
| `tags` | 风格标签，逗号分隔（如 `"Lullaby, gentle acoustic guitar, kawaii"`） |
| `title` | 歌曲标题 |
| `make_instrumental` | `true`=纯音乐无歌词，`false`=带人声 |
| `model` | **固定用 `chirp-fenix`**（对应 suno v5.5，效果最好），不要用别的值 |

## 可直接执行的代码模板
用户要求生成歌曲时，用 `run_python_code` 执行以下模板（把 PROMPT/TAGS/TITLE/INSTRUMENTAL 替换成用户需求）：

```python
import urllib.request, urllib.error, json, time, os

BASE = "http://host.docker.internal:3002"
PROMPT = "用户要的歌词或音乐描述"
TAGS = "风格标签, 逗号分隔"
TITLE = "歌曲标题"
INSTRUMENTAL = False  # True=纯音乐
MODEL = "chirp-fenix"

def req(url, method="GET", data=None, timeout=60):
    headers = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:500]}
    except Exception as e:
        return -1, {"error": repr(e)}

# 1. 提交生成
st, data = req(BASE + "/api/custom_generate", "POST", {
    "prompt": PROMPT, "tags": TAGS, "title": TITLE,
    "make_instrumental": INSTRUMENTAL, "model": MODEL, "wait_audio": False,
}, timeout=120)
if st != 200:
    print("生成失败:", data); raise SystemExit(1)
ids = [a["id"] for a in data]
print("已提交:", ids)

# 2. 轮询（最多 15 分钟）
for i in range(90):
    st, data = req(BASE + "/api/get?ids=" + ",".join(ids), timeout=30)
    if st == 200 and all(a.get("status") in ("complete", "streaming") for a in data):
        break
    if st == 200:
        print("进度:", [a.get("status") for a in data])
    time.sleep(10)

# 3. 下载到脚本同级目录（≤20MB 会自动发送到群里）
saved = []
for a in data:
    url = a.get("audio_url") or a.get("video_url")
    if not url:
        continue
    safe = "".join(c for c in (a.get("title") or "song") if c.isalnum() or c in " -_")[:40]
    fname = "%s-%s.mp3" % (safe, a["id"][:8])
    urllib.request.urlretrieve(url, fname)
    print("已下载:", fname, os.path.getsize(fname) / 1e6, "MB")
    saved.append(fname)

# 4. 保存到宿主机 D:/资源/歌/SUNO（失败不影响群内发送）
import urllib.parse
for fname in saved:
    try:
        with open(fname, "rb") as f:
            data_bytes = f.read()
        up = urllib.request.Request(
            BASE + "/api/save_audio?filename=" + urllib.parse.quote(os.path.basename(fname)),
            data=data_bytes, headers={"Content-Type": "application/octet-stream"}, method="POST")
        with urllib.request.urlopen(up, timeout=120) as resp:
            print("已保存到宿主机:", json.loads(resp.read().decode()).get("path"))
    except Exception as e:
        print("保存到宿主机失败(不影响发群):", repr(e))

print("完成，生成的歌曲:", saved)
```

## 注意事项
- 生成的 mp3 写在脚本同级目录，`run_python_code` 会自动收集并发送到群里（单文件 ≤20MB，mp3 通常在 2-5MB，没问题）
- 一次生成固定出 **2 首**变体，都会下载发送
- 生成耗时通常 1~3 分钟，轮询期间耐心等待，不要提前放弃
- 若接口报错 `The selected model isn't valid`，说明 model 传错，**必须是 `chirp-fenix`**
- 若报 `We couldn't verify your request`，是验证码失败，重试一次即可（宿主机已配置 2captcha 自动处理）
- 中文歌词/标题直接写在代码里即可，Python 默认 UTF-8 无转义问题
