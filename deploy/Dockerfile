# ==============================================================================
# 简兮 (JANSEE) — 商业化生产容器镜像 (Dockerfile)
# 包含 Node.js 运行时、FFmpeg 硬件解码环境与生产工作台
# ==============================================================================

FROM node:22-alpine AS runtime

# 安装 FFmpeg 与多媒体字体基础依赖
RUN apk update && \
    apk add --no-cache \
    ffmpeg \
    fontconfig \
    ttf-dejavu \
    curl \
    tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app

# 注入环境变量
ENV NODE_ENV=production
ENV PORT=5173

# 复制工作区文件
COPY package.json ./
COPY apps/ apps/
COPY packages/ packages/
COPY modules/ modules/
COPY materials/ materials/
COPY deploy/ deploy/

# 创建持久化数据卷挂载点
RUN mkdir -p storage/uploads storage/outputs storage/backups

# 暴露服务端口
EXPOSE 5173

# 健康检查探针
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5173/api/v1/health || exit 1

# 启动命令
CMD ["node", "apps/web/server/index.mjs"]
