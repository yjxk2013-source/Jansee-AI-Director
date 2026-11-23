import React from "react";
import type { ServerHealthData } from "../../../types/admin";

interface AdminCloudStorageCardProps {
  cloudStorage?: ServerHealthData["cloudStorage"];
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function AdminCloudStorageCard({ cloudStorage }: AdminCloudStorageCardProps) {
  if (!cloudStorage) {
    return (
      <section className="admin-cloud-storage-section">
        <div className="admin-section-heading">
          <div>
            <h3>存储分发与成本监控</h3>
            <p>腾讯云 COS 对象存储与 CDN 边缘加速实时指标</p>
          </div>
          <span className="admin-status-badge">未接入或等待同步</span>
        </div>
      </section>
    );
  }

  const {
    todayCdnBytes,
    todayDirectCosBytes,
    accountBalanceYuan,
    estimatedCostTodayYuan,
    isDirectCosLeak,
  } = cloudStorage;

  const isLowBalance = accountBalanceYuan !== null && accountBalanceYuan < 50;

  return (
    <section className="admin-cloud-storage-section" style={{ marginTop: "24px" }}>
      <div className="admin-section-heading" style={{ marginBottom: "16px" }}>
        <div>
          <h3 style={{ fontSize: "16px", fontWeight: 600, color: "var(--admin-text, #fff)", margin: 0 }}>存储分发与成本监控</h3>
          <p style={{ fontSize: "12px", color: "var(--admin-muted, #8e8e93)", margin: "4px 0 0" }}>腾讯云 COS 对象存储与 CDN 边缘加速实时指标 · 每小时自动聚合</p>
        </div>
        <span
          style={{
            fontSize: "12px",
            padding: "4px 10px",
            borderRadius: "6px",
            background: isDirectCosLeak ? "rgba(239, 68, 68, 0.15)" : "rgba(34, 197, 94, 0.15)",
            color: isDirectCosLeak ? "#f87171" : "#4ade80",
            border: isDirectCosLeak ? "1px solid rgba(239, 68, 68, 0.3)" : "1px solid rgba(34, 197, 94, 0.3)",
          }}
        >
          {isDirectCosLeak ? "检测到源站外网下行" : "分流链路健康"}
        </span>
      </div>

      <div className="admin-server-metrics" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        {/* 卡片 1: CDN 加速流量 */}
        <article className="admin-server-metric">
          <span style={{ display: "flex", justifyContent: "space-between" }}>
            CDN 加速流量
            <small style={{ color: "#4ade80" }}>正常分发</small>
          </span>
          <strong>{formatBytes(todayCdnBytes)}</strong>
          <small>今日用户播放与原片下载</small>
        </article>

        {/* 卡片 2: COS 源站外网下行 */}
        <article
          className="admin-server-metric"
          style={isDirectCosLeak ? { borderColor: "rgba(239, 68, 68, 0.4)", background: "rgba(239, 68, 68, 0.05)" } : {}}
        >
          <span style={{ display: "flex", justifyContent: "space-between" }}>
            COS 源站外网下行
            <small style={{ color: isDirectCosLeak ? "#f87171" : "#4ade80" }}>
              {isDirectCosLeak ? "存在泄漏" : "0 泄漏 (安全)"}
            </small>
          </span>
          <strong style={{ color: isDirectCosLeak ? "#f87171" : "inherit" }}>
            {formatBytes(todayDirectCosBytes)}
          </strong>
          <small>{isDirectCosLeak ? "⚠️ 发现非 CDN 直连流量" : "目标值 0 · 杜绝高价下行"}</small>
        </article>

        {/* 卡片 3: 腾讯云可用余额 */}
        <article className="admin-server-metric">
          <span style={{ display: "flex", justifyContent: "space-between" }}>
            腾讯云可用余额
            {isLowBalance && <small style={{ color: "#fbbf24" }}>需充值</small>}
          </span>
          <strong>{accountBalanceYuan !== null ? `¥ ${accountBalanceYuan.toFixed(2)}` : "—"}</strong>
          <small>{accountBalanceYuan !== null ? "现金账户实时可用" : "未授权查询余额"}</small>
        </article>

        {/* 卡片 4: 今日存储分发成本预估 */}
        <article className="admin-server-metric">
          <span style={{ display: "flex", justifyContent: "space-between" }}>
            今日存储流量预估
            <small style={{ color: "var(--admin-muted, #8e8e93)" }}>折合人民币</small>
          </span>
          <strong>¥ {estimatedCostTodayYuan.toFixed(2)}</strong>
          <small>CDN流量 + 回源综合估算</small>
        </article>
      </div>
    </section>
  );
}
