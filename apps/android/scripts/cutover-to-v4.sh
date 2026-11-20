#!/usr/bin/env bash
# JANSEE V4 生产切换脚本：停 V2 -> 切 Nginx -> 启 V4 -> 健康检查
# 前置：镜像已 build 成功；V2 数据已备份到 /srv/jansee-v2-backup
set -euo pipefail

V4=/srv/jansee-v4
COMPOSE="docker compose -f $V4/deploy/docker-compose.v4.yml --env-file $V4/.env"

echo "===== [1/6] 停止 V2 服务 ====="
systemctl stop jansee-monitor.service 2>/dev/null || true
systemctl disable jansee-monitor.service 2>/dev/null || true
# 精确停止 V2 的 node 进程（按路径匹配，不误伤其它 node）
for pid in $(ps -eo pid,args | grep '/srv/jansee/' | grep -v grep | awk '{print $1}'); do
  kill "$pid" 2>/dev/null || true
done
# 移除百度推送定时任务
crontab -l 2>/dev/null | grep -v 'jansee-baidu-push' | crontab - 2>/dev/null || true
sleep 2
echo "V2 进程已停止"

echo "===== [2/6] 切换宿主机 Nginx 到 V4 ====="
# 备份当前 sites-enabled 清单
sudo cp -a /etc/nginx/sites-enabled /etc/nginx/sites-enabled.v2-backup-$(date +%Y%m%d-%H%M%S)
# 卸载 V2 站点（保留 jx-mail.conf 企业邮箱入口）
sudo rm -f /etc/nginx/sites-enabled/jx.conf
sudo rm -f /etc/nginx/sites-enabled/jx-test.conf
sudo rm -f /etc/nginx/sites-enabled/jx-admin.conf
# jx-mail.conf 保留：mail.jansee.cn 企业邮跳转是基础设施，非 V2 业务
# 安装 V4 host 配置
sudo cp "$V4/deploy/nginx-host-jansee.conf.example" /etc/nginx/conf.d/jansee-v4.conf
sudo nginx -t
sudo systemctl reload nginx
echo "Nginx 已切到 V4（保留企业邮 jx-mail.conf）"

echo "===== [3/6] 启动 V4 容器 ====="
cd "$V4"
sudo $COMPOSE up -d
echo "容器已启动，等待健康检查..."

echo "===== [4/6] 等待服务健康 ====="
for i in $(seq 1 30); do
  api_ok=$(sudo $COMPOSE ps 2>/dev/null | grep -c 'api.*healthy' || true)
  web_ok=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health/web 2>/dev/null || echo '000')
  api_health=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4100/health/live 2>/dev/null || echo '000')
  echo "  等待 $i/30: web=$web_ok api=$api_health api_healthy行=$api_ok"
  if [ "$web_ok" = "200" ] && [ "$api_health" = "200" ]; then
    echo "服务健康！"
    break
  fi
  sleep 4
done

echo "===== [5/6] 容器状态 ====="
sudo $COMPOSE ps

echo "===== [6/6] 外网域名验证 ====="
echo -n "https://jansee.cn -> "; curl -s -o /dev/null -w '%{http_code}\n' https://jansee.cn/ || echo FAIL
echo -n "https://admin.jansee.cn -> "; curl -s -o /dev/null -w '%{http_code}\n' https://admin.jansee.cn/ || echo FAIL

echo "===== 切换完成 ====="
