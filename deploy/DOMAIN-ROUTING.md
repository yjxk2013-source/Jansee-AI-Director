# JANSEE V4 域名与入口配置

## 正式域名

- 官网唯一规范域名：`https://jansee.cn`
- 管理后台：`https://admin.jansee.cn`
- `https://www.jansee.cn`：仅作为别名，永久重定向到 `https://jansee.cn`
- HTTP 请求统一跳转 HTTPS
- 不使用 `app.jansee.cn` 作为 V4 正式入口

## DNS 与证书

在域名 DNS 控制台配置：

- 根域名 `jansee.cn` 指向正式服务器公网 IPv4。
- `admin.jansee.cn` 指向同一服务器公网 IPv4。
- `www.jansee.cn` 使用 CNAME 指向 `jansee.cn`，或按 DNS 服务商要求配置等效记录。
- 只有服务器确实配置并开放 IPv6 时才添加 AAAA 记录，避免错误 IPv6 记录导致部分用户无法访问。

TLS 证书必须同时包含 `jansee.cn`、`admin.jansee.cn`、`www.jansee.cn` 三个 SAN 域名。证书路径按示例配置为：

- `/etc/letsencrypt/live/jansee.cn/fullchain.pem`
- `/etc/letsencrypt/live/jansee.cn/privkey.pem`

## 服务器入口

`nginx-host-jansee.conf.example` 是 Linux 宿主机的 HTTPS 入口配置模板。部署时复制到宿主机 Nginx 配置目录，确认 TLS 证书存在后执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

V4 Compose 的 Web 容器只应绑定到 `127.0.0.1:8080`。宿主机 Nginx 转发到该地址；不要把 8080、API 4100 或 PostgreSQL 5432 暴露到公网。宿主机入口必须覆盖客户端传入的转发头，模板已按真实客户端地址和 HTTPS 协议重写。

官网与后台由同一个 V4 Web 容器提供，前端依据 Host 区分 `jansee.cn` 与 `admin.jansee.cn`。API 的生产来源白名单保持：

```dotenv
WEB_ORIGINS=https://jansee.cn,https://admin.jansee.cn
```

不要把 `www.jansee.cn` 加入白名单；它应先重定向到规范域名。不要将本地开发用的 HTTP Origin 放入生产配置。

## 上线后验证

1. `http://jansee.cn`、`http://admin.jansee.cn` 均跳转到 HTTPS。
2. `https://www.jansee.cn/` 跳转到 `https://jansee.cn/`，路径和查询参数保留。
3. 官网首页、SEO 页面、Open Graph、Sitemap、robots 与 llms 文件均使用 `https://jansee.cn`。
4. `https://admin.jansee.cn` 打开后台入口，后台路径不被搜索引擎索引。
5. 登录后检查 Cookie 的 Secure、HttpOnly、SameSite 属性；分别验证官网与后台登录。
6. 从公网确认 8080、4100、5432 均不可直连。

此模板只定义域名入口，不代表 DNS、证书、云防火墙或服务器 Nginx 已经配置完成。
