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
    isCurrentlyLeaking,
    cdnPackage,
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
            background: isCurrentlyLeaking ? "rgba(239, 68, 68, 0.15)" : "rgba(34, 197, 94, 0.15)",
            color: isCurrentlyLeaking ? "#f87171" : "#4ade80",
            border: isCurrentlyLeaking ? "1px solid rgba(239, 68, 68, 0.3)" : "1px solid rgba(34, 197, 94, 0.3)",
          }}
        >
          {isCurrentlyLeaking ? "⚠️ 当前存在源站外网下行" : "当前链路健康 · 0 泄漏"}
        </span>
      </div>

      <div className="admin-server-metrics" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {/* 卡片 1: CDN 加速流量与 100G 流量包进度条 */}
        <article className="admin-server-metric">
          <span style={{ display: "flex", justifyContent: "space-between" }}>
            CDN 加速流量
            <small style={{ color: "#4ade80" }}>
              {cdnPackage ? `剩余 ${(cdnPackage.remainingBytes / 1024 ** 3).toFixed(1)} GB` : "正常分发"}
            </small>
          </span>
          <strong>{formatBytes(todayCdnBytes)}</strong>
          
          {cdnPackage && (
            <div style={{ marginTop: "8px", marginBottom: "4px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--admin-muted, #8e8e93)", marginBottom: "4px" }}>
                <span>100GB 流量包</span>
                <span>已用 {cdnPackage.usedPercent}%</span>
              </div>
              <div className="admin-server-meter" style={{ height: "6px", borderRadius: "3px", background: "rgba(255,255,255,0.08)" }}>
                <i
                  style={{
                    width: `${Math.max(1, cdnPackage.usedPercent)}%`,
                    background: cdnPackage.usedPercent > 80 ? "#f87171" : "#39a68b",
                    borderRadius: "3px",
                  }}
                />
              </div>
              <div style={{ fontSize: "10px", color: "var(--admin-muted, #8e8e93)", marginTop: "4px" }}>
                已用 {(cdnPackage.usedBytes / 1024 ** 3).toFixed(2)} GB · 剩 {(cdnPackage.remainingBytes / 1024 ** 3).toFixed(2)} GB
              </div>
            </div>
          )}
          {!cdnPackage && <small>今日用户播放与原片下载</small>}
        </article>

        {/* 卡片 2: COS 源站外网下行 (精准区分实时与历史) */}
        <article
          className="admin-server-metric"
          style={isCurrentlyLeaking ? { borderColor: "rgba(239, 68, 68, 0.4)", background: "rgba(239, 68, 68, 0.05)" } : {}}
        >
          <span style={{ display: "flex", justifyContent: "space-between" }}>
            COS 源站外网下行
            <small style={{ color: isCurrentlyLeaking ? "#f87171" : "#4ade80" }}>
              {isCurrentlyLeaking ? "⚠️ 实时泄漏" : "当前已阻断 (0 泄漏)"}
            </small>
          </span>
          <strong style={{ color: isCurrentlyLeaking ? "#f87171" : "inherit" }}>
            {formatBytes(todayDirectCosBytes)}
          </strong>
          <small>
            {isCurrentlyLeaking
              ? "检测到非 CDN 直连流量，需排查"
              : todayDirectCosBytes > 0
                ? "均为凌晨遗留，近 12 小时 0 字节"
                : "全天贴 0 · 杜绝高价下行"}
          </small>
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
          <small>CDN 流量包抵扣 + 回源计费</small>
        </article>
      </div>
    </section>
  );
}
