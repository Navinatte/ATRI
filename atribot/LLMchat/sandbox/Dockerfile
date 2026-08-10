FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# 仅安装运行时必需的系统库（opencv-headless 的轻量依赖）
# 跳过 ffmpeg/tmux/curl/wget/fonts 等非核心包以规避 Docker bridge 不走 VPN 的问题
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# pip 使用清华源（容器网络不走 VPN，国内源更稳）
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple --upgrade pip && \
    pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    numpy \
    pandas \
    matplotlib \
    seaborn \
    pillow \
    opencv-python-headless \
    requests \
    scipy \
    sympy

VOLUME ["/workspace/groups"]

CMD ["tail", "-f", "/dev/null"]