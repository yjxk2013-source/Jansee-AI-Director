# JANSEE V4 单机云服务器部署说明

## 目标拓扑

- Nginx/Web：对外提供 HTTPS 网站入口。
- API：只在 Compose 内网监听 4100。
- PostgreSQL 16：独立 V4 数据库，只在 Compose 内网可访问，不映射公网端口。
- 媒体文件：生产环境全面启用腾讯云 COS（私有读写）+ CDN 边缘加速直出；云服务器本地不长期保留任何媒体资产实体。
- Whisper/FFmpeg：使用 Linux 发行版二进制，不可复用 Windows 开发机二进制。

## 首次部署前

1. 在独立 V4 目录放置 `.env`，以 `deploy/.env.production.example` 为模板逐项配置；不要覆盖已有密钥文件，也不要把模板占位符直接用于生产。
2. 设置 POSTGRES_PASSWORD 为独立随机长密码；不要沿用 V2 数据库账号或密码。
3. 设置 DIRECTOR_API_BASE_URL、DIRECTOR_API_KEY、DIRECTOR_MODEL 与 DIRECTOR_FALLBACK_MODELS。密钥只保存在服务器 .env。
4. 设置 ADMIN_EMAILS、WEB_ORIGINS、PARTNER_PAYOUT_ENCRYPTION_KEY，并配置真实短信与 TTS 环境变量。
5. 准备 Linux whisper-cli 和 ggml-small.bin，放在 Compose 挂载路径；先校验文件架构和模型可读。
6. 建立 storage/v4 目录并确认运行 Docker 的用户有写权限；确认磁盘容量、inode 与备份空间。

## 启动

在 V4 仓库根目录执行：

~~~bash
docker compose -f deploy/docker-compose.v4.yml config
docker compose -f deploy/docker-compose.v4.yml up -d --build
docker compose -f deploy/docker-compose.v4.yml ps
docker compose -f deploy/docker-compose.v4.yml logs --tail=200 api
~~~

Compose 会先等待 PostgreSQL 健康，再启动 API；API 启动时自动执行 V4 migrations。数据库只在 Compose 私有网络内开放。不要添加 PostgreSQL 公网端口映射。

## 数据备份

首次部署后执行：

~~~bash
chmod +x deploy/backup-v4-db.sh
./deploy/backup-v4-db.sh
~~~

脚本会生成 PostgreSQL custom-format dump、验证 dump 可读取，并清理本机超过 14 天的旧备份。可用 cron 每天凌晨执行，例如：

~~~cron
15 2 * * * cd /srv/jansee-v4 && ./deploy/backup-v4-db.sh >> /var/log/jansee-v4-db-backup.log 2>&1
~~~

**重要：** 同机备份不能抵御整台服务器或磁盘损坏。生产上线前必须把备份同步到另一台机器或独立对象存储，并至少完成一次恢复演练。媒体文件目录也要独立备份；数据库 dump 不包含视频和用户素材。

## 生产媒体存储与边缘加速闭环架构

- **存储驱动**：`MEDIA_STORAGE_DRIVER=cos`（腾讯云 COS 私有读写，广州地域 `jansee-1460392374`）。
- **计算存储分离**：服务器本地不长期保留视频实体。素材合成完毕后立即推入 COS，临时中间文件即刻销毁。
- **边缘秒播分发**：播放与下载均经由 API 生成带鉴权的签名链接，通过 `302 Found` 重定向至专属 CDN 边缘域名（`https://cdn.jansee.cn`），绕开服务器单机 3Mbps 带宽瓶颈，实现首帧极速加载与满速下载。
- **本地降级与安全边界**：开发与无网络环境可通过将 `MEDIA_STORAGE_DRIVER` 设为 `local` 进行本地降级。本地模式下保留 `MEDIA_MIN_FREE_BYTES` 磁盘安全余量与 24 小时 TTL 自动清理。

## 4C4G 单机宿主机内存弹性伸缩与出片高可用设计

在商业 AI 视频生产系统中，**“死保任务出片成功、杜绝因僵化限制被 OOM 强杀中断”是第一商业原则**。
音视频渲染具有典型的“瞬时高吞吐尖峰”特征：在 1080P/4K 高清原图解码、Ken Burns 推拉运镜与发丝字幕渲染的峰值时刻，单任务瞬时内存可能达 1.0G ~ 1.3G。

因此，简兮生产架构采取了**“软上限预留 + 弹性爆发借用 + 宿主机 Swap 兜底防爆”**的大厂最佳实践：

| 服务模块 | mem_reservation (软上限预留) | mem_limit (硬上限) | 机制与商业考量 |
| :--- | :--- | :--- | :--- |
| **API + FFmpeg Worker** | **1024 MiB** | **不设僵化硬上限** | **以出片为绝对先决条件**：平时基线稳定在 1024MB 以内；当两路并发遇重型素材瞬时冲高（各吃 1.2G），允许弹性向上借用内存，**绝不触发 OOM-Kill 误杀出片任务**。 |
| **PostgreSQL 16** | 256 MiB | 512 MiB | 独立私有容器，严格锁定数据库连接与共享缓冲区上限。 |
| **Web (Nginx)** | 64 MiB | 128 MiB | 静态前端托管与反向代理，极低内存驻留。 |
| **宿主机 4GB Swap 交换区** | — | — | **系统级安全防爆网**：4G 物理内存 + 4G Swap 虚拟内存，提供总计 8GB 弹性安全缓冲，平滑削峰。 |

### 生产稳定性的多重防火墙（为何不设 mem_limit 依然 100% 稳固）：
1. **并发严格锁死在 2**：`worker.ts` 中 `WORKER_CONCURRENCY` 严格约束最多仅有 2 个槽位同时执行渲染，从源头上切断了任务无节制暴增挤占内存的可能；
2. **CPU 线程严格绑定**：FFmpeg 编码命令强制绑定 `-threads 2`，杜绝多进程抢占 4 核 CPU；
3. **临时资产即刻销毁**：任务完成或失败必定在 `finally` 中清空本地临时目录，磁盘零泄漏；
4. **弹性削峰**：瞬时尖峰通常仅持续 5~10 秒，渲染完毕后内存立即被 V8 与 Linux 垃圾回收释放。

## 上线验收

- docker compose config 成功，postgres、api、web 均健康。
- 从公网无法连接 PostgreSQL 5432；API 只能由 Nginx 内部转发访问。
- 服务器重启后 PostgreSQL 数据、用户素材、成片均保留。
- 完成一次注册、登录、上传、制作、作品下载与过期清理验收。
- 完成 PostgreSQL 恢复演练、媒体备份恢复演练、磁盘告警演练。
- 真实模型调用和 TTS 使用获授权的 V4 环境变量；不要在日志中输出密钥。


## Trusted reverse proxy network

The V4 Compose stack uses a dedicated bridge subnet 172.30.250.0/24 with fixed addresses: web/Nginx 172.30.250.2, API 172.30.250.3, and PostgreSQL 172.30.250.4. The API trusts forwarded client-IP headers only when the direct peer is the fixed web/Nginx address (TRUST_PROXY_IP=172.30.250.2). Keep API port 4100 private; do not publish it to the host or the public Internet.

Before deployment, confirm that 172.30.250.0/24 does not overlap the server LAN, VPN, or another Docker network. If it does, change the subnet and all three static addresses together, and set TRUST_PROXY_IP to the new Nginx address. Never replace the fixed proxy address with unrestricted proxy trust.


## Production environment preparation

Use deploy/.env.production.example as the production configuration template and merge its settings into the server-side .env file; do not overwrite an existing secret-bearing .env blindly. Set ADMIN_EMAILS to the actual administrator login email, generate POSTGRES_PASSWORD, configure OPCPAY_API_KEY, and generate/back up PARTNER_PAYOUT_ENCRYPTION_KEY before storing any partner payout profile. OPCPAY_WEBHOOK_SECRET is optional: without it, webhook callbacks fail closed and the authenticated periodic order-query sweep remains the settlement path. Configure the secret only after obtaining the matching value from the OPCPAY provider console. Keep the same payout encryption key across restarts and deployments. WEB_ORIGINS must contain the canonical HTTPS origins for jansee.cn and admin.jansee.cn (plus any real production aliases). Production startup intentionally fails closed when these values or the Linux Whisper executable/model are missing.


## HTTPS termination on the host

The bundled web container intentionally listens on HTTP only. Compose now publishes it as `127.0.0.1:8080:80`, not on a public interface. A host-level Nginx/Caddy/load balancer must terminate TLS for both `jansee.cn` and `admin.jansee.cn` on port 443 and proxy to `http://127.0.0.1:8080`. Do not open port 8080 to the Internet.

The host reverse proxy must overwrite (not blindly append client-supplied values to) these headers on the upstream request:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
```

The in-container Nginx forwards these normalized values unchanged to the API. This is required because the API trusts only the fixed in-network Nginx container IP. If a cloud load balancer sits in front of the host proxy, configure its trusted real-IP ranges at the host proxy first; never accept arbitrary client-supplied forwarding headers. Verify that both public domains redirect HTTP to HTTPS at the host proxy and that the host firewall/security group blocks public access to TCP/8080, TCP/4100, and TCP/5432.
