FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# 安装运行时必需的系统库 + 中文字体 + ffmpeg
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list 2>/dev/null || true; \
    apt-get update && apt-get install -y --no-install-recommends -o Acquire::Retries=5 \
    libglib2.0-0 \
    libgomp1 \
    fontconfig \
    fonts-wqy-zenhei \
    ffmpeg \
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