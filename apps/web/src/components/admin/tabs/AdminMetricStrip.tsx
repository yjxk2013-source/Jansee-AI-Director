import type { AdminOverviewStats } from "../../../types/admin";

interface AdminMetricStripProps {
  stats: AdminOverviewStats;
  statsUnavailableLabel: string;
  statsUnavailableHint: string;
  recordManualRefund: () => void;
}

export function AdminMetricStrip({
  stats,
  statsUnavailableLabel,
  statsUnavailableHint,
  recordManualRefund,
}: AdminMetricStripProps) {
  return (
          <section className="admin-metric-strip">
            <div className="admin-metric-card">
              <span className="metric-label">今日已支付净额</span>
              <span className="metric-value">{stats.revenueDataAvailable === false ? statsUnavailableLabel : `¥${stats.todayRevenueYuan.toFixed(2)}`}</span>
              <span className="metric-sub">{stats.databaseDataAvailable === false ? statsUnavailableHint : "OPCPAY 支付状态核验 · SKU下单价 − 已登记退款"}</span>
              <button className="admin-inline-link" onClick={() => void recordManualRefund()}>登记人工退款</button>
            </div>
            <div className="admin-metric-card highlight">
              <span className="metric-label">今日交付成片</span>
              <span className="metric-value">{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.todayCompletedJobs}</span>
              <span className="metric-sub">{stats.databaseDataAvailable === false ? statsUnavailableHint : `累计任务 ${stats.totalJobs} 单`}</span>
            </div>
            <div className="admin-metric-card">
              <span className="metric-label">出片成功率</span>
              <span className="metric-value">{stats.databaseDataAvailable === false ? statsUnavailableLabel : `${stats.jobSuccessRate}%`}</span>
              <span className="metric-sub">{stats.databaseDataAvailable === false ? statsUnavailableHint : `失败任务 ${stats.failedJobs} 单`}</span>
            </div>
            <div className="admin-metric-card">
              <span className="metric-label">平均交付耗时</span>
              <span className="metric-value">{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.avgE2eDurationSec > 0 ? `${stats.avgE2eDurationSec}s` : "暂无数据"}</span>
              <span className="metric-sub">{stats.databaseDataAvailable === false ? statsUnavailableHint : `P90 ${stats.p90E2eDurationSec > 0 ? `${stats.p90E2eDurationSec}s` : "—"}`}</span>
            </div>
            <div className="admin-metric-card">
              <span className="metric-label">累计用户</span>
              <span className="metric-value">{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.totalUsers.toLocaleString("zh-CN")}</span>
              <span className="metric-sub">{stats.databaseDataAvailable === false ? statsUnavailableHint : `今日新增 ${stats.todayNewUsers} 人`}</span>
            </div>
          </section>
  );
}
