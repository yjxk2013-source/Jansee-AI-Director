import type { AdminOverviewStats, UserAnalyticsData } from "../../../types/admin";

interface AdminOverviewTabProps {
  stats: AdminOverviewStats;
  loadedStats: AdminOverviewStats | null;
  loading: boolean;
  dashboardError: string | null;
  statsUnavailableLabel: string;
  statsUnavailableHint: string;
  userAnalytics: UserAnalyticsData | null;
  userTrend: { day: string; registrations: number; completedJobs: number; revenueYuan: number }[];
  trendMax: number;
  trendPoints: string;
  completedTrendPoints: string;
  revenueTrendPoints: string;
  setActiveTab: (tab: any) => void;
}

export function AdminOverviewTab({
  stats,
  loadedStats,
  loading,
  dashboardError,
  statsUnavailableLabel,
  statsUnavailableHint,
  userAnalytics,
  userTrend,
  trendMax,
  trendPoints,
  completedTrendPoints,
  revenueTrendPoints,
  setActiveTab,
}: AdminOverviewTabProps) {
  return (
            <div className="overview-viewport">
              {dashboardError && <div className="admin-data-note" role="status">{dashboardError}</div>}
              {loading && <div className="admin-data-note" role="status">正在读取经营数据，仪表盘布局已完整呈现…</div>}
              {!loadedStats && !loading && !dashboardError && <div className="admin-data-note" role="status">当前暂无经营数据，以下指标将在真实数据接入后自动显示。</div>}
              <section className="admin-dashboard-section">
                <div className="admin-section-heading">
                  <div>
                    <h2>经营概览</h2>
                    <p>今日经营结果与全量任务表现</p>
                  </div>
                  <span>数据来自当前 V4 数据库</span>
                </div>
                <div className="admin-dashboard-kpis">
                  <div className="admin-dashboard-kpi"><span>累计任务</span><strong>{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.totalJobs}</strong><small>已进入任务系统</small></div>
                  <div className="admin-dashboard-kpi"><span>今日完成</span><strong>{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.todayCompletedJobs}</strong><small>今日成功交付</small></div>
                  <div className="admin-dashboard-kpi"><span>出片成功率</span><strong>{stats.databaseDataAvailable === false ? statsUnavailableLabel : `${stats.jobSuccessRate}%`}</strong><small>完成 / 已结束任务</small></div>
                  <div className="admin-dashboard-kpi"><span>失败任务</span><strong>{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.failedJobs}</strong><small>可进入任务明细排查</small></div>
                </div>
              </section>


              <section className="admin-dashboard-section admin-user-growth-inline">
                <div className="admin-section-heading">
                  <div><h2>经营增长曲线</h2><p>注册、成片与实收收入 · 用真实趋势看见简兮的成长</p></div>
                  <button className="admin-inline-link" onClick={() => setActiveTab("users")}>查看用户与地域分析</button>
                </div>
                <div className="admin-user-chart-card">
                  <div className="admin-user-card-heading">
                    <div><span className="admin-eyebrow">COMMUNITY / 30 DAYS</span><h3>累计注册 {userAnalytics?.summary.totalUsers.toLocaleString("zh-CN") ?? "—"} 位</h3><p>今日新增 {userAnalytics?.summary.todayNewUsers ?? "—"} 位 · 近 7 天新增 {userAnalytics?.summary.last7Days ?? "—"} 位</p></div>
                    <span className="admin-chart-legend"><i />每日注册</span>
                  </div>
                  {userAnalytics && userTrend.length ? <div className="admin-user-line-chart">
                    <div className="admin-chart-y-labels"><span>{trendMax}</span><span>{Math.round(trendMax / 2)}</span><span>0</span></div>
                    <svg viewBox="0 0 900 205" preserveAspectRatio="none" role="img" aria-label="近30天注册趋势">
                      <defs><linearGradient id="overviewGrowthFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#8179e8" stopOpacity=".2" /><stop offset="100%" stopColor="#8179e8" stopOpacity="0" /></linearGradient></defs>
                      <path d="M18 176 H882 M18 105 H882 M18 34 H882" stroke="#e9e7f3" strokeDasharray="4 6" fill="none" />
                      <polygon points={`18,176 ${trendPoints} 882,176`} fill="url(#overviewGrowthFill)" />
                      <polyline points={trendPoints} fill="none" stroke="#7169d7" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div className="admin-chart-x-labels"><span>{userTrend[0]?.day}</span><span>{userTrend[Math.floor(userTrend.length / 2)]?.day}</span><span>{userTrend[userTrend.length - 1]?.day}</span></div>
                  </div> : <div className="admin-users-empty">用户增长曲线将在数据库连接后显示。</div>}
                </div>

                {userAnalytics && userTrend.length > 0 && <div className="admin-trend-multiples">
                  <article className="admin-trend-mini">
                    <div><span className="admin-eyebrow">DELIVERED / 30 DAYS</span><strong>{userTrend.reduce((sum, point) => sum + point.completedJobs, 0).toLocaleString("zh-CN")}</strong><small>近 30 天完成成片</small></div>
                    <svg viewBox="0 0 900 205" preserveAspectRatio="none" role="img" aria-label="近30天完成成片趋势">
                      <path d="M18 176 H882 M18 105 H882 M18 34 H882" stroke="#e9e7f3" strokeDasharray="4 6" fill="none" />
                      <polyline points={completedTrendPoints} fill="none" stroke="#5e9cbb" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div className="admin-chart-x-labels"><span>{userTrend[0]?.day}</span><span>{userTrend[Math.floor(userTrend.length / 2)]?.day}</span><span>{userTrend[userTrend.length - 1]?.day}</span></div>
                  </article>
                  <article className="admin-trend-mini">
                    <div><span className="admin-eyebrow">REVENUE / 30 DAYS</span><strong>¥{userTrend.reduce((sum, point) => sum + point.revenueYuan, 0).toFixed(2)}</strong><small>近 30 天已支付净额（按 SKU 价扣除退款）</small></div>
                    <svg viewBox="0 0 900 205" preserveAspectRatio="none" role="img" aria-label="近30天实收收入趋势">
                      <path d="M18 176 H882 M18 105 H882 M18 34 H882" stroke="#e9e7f3" strokeDasharray="4 6" fill="none" />
                      <polyline points={revenueTrendPoints} fill="none" stroke="#c49b62" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div className="admin-chart-x-labels"><span>{userTrend[0]?.day}</span><span>{userTrend[Math.floor(userTrend.length / 2)]?.day}</span><span>{userTrend[userTrend.length - 1]?.day}</span></div>
                  </article>
                </div>}
              </section>

              <section className="admin-dashboard-section admin-visual-section">
                <div className="admin-section-heading">
                  <div><h2>经营数据图表</h2><p>以真实任务数据呈现交付质量与导演调用结构</p></div>
                  <span>仅展示已采集指标</span>
                </div>
                <div className="admin-visual-grid">
                  <article className="admin-visual-card admin-success-chart">
                    <div className="admin-visual-title">出片成功率</div>
                    <div className="admin-donut-wrap">
                      <svg viewBox="0 0 120 120" role="img" aria-label="出片成功率环形图">
                        <circle cx="60" cy="60" r="42" fill="none" stroke="#3b4147" strokeWidth="12" />
                        {stats.databaseDataAvailable !== false && stats.totalJobs > 0 && <circle cx="60" cy="60" r="42" fill="none" stroke="#d8dde2" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${Math.max(0,Math.min(100,stats.jobSuccessRate))*2.6389} 263.89`} transform="rotate(-90 60 60)" />}
                        <text x="60" y="56" textAnchor="middle" className="admin-donut-value">{stats.databaseDataAvailable === false || stats.totalJobs === 0 ? "—" : `${stats.jobSuccessRate}%`}</text>
                        <text x="60" y="73" textAnchor="middle" className="admin-donut-caption">成功交付</text>
                      </svg>
                    </div>
                    <div className="admin-visual-foot">{stats.databaseDataAvailable === false ? statsUnavailableHint : stats.totalJobs > 0 ? `累计 ${stats.totalJobs} 项任务` : "等待首批任务数据"}</div>
                  </article>
                  <article className="admin-visual-card">
                    <div className="admin-visual-title">今日任务交付</div>
                    {stats.databaseDataAvailable === false || stats.totalJobs === 0 ? <div className="admin-chart-empty">暂无可绘制的任务数据</div> : <div className="admin-bar-chart">
                      <div className="admin-bar-row"><span>今日完成</span><div className="admin-bar-track"><i style={{width:(stats.todayCompletedJobs / Math.max(1,stats.todayCompletedJobs,stats.todayFailedJobs) * 100) + "%"}} /></div><b>{stats.todayCompletedJobs}</b></div>
                      <div className="admin-bar-row"><span>今日失败</span><div className="admin-bar-track"><i className="failed" style={{width:(stats.todayFailedJobs / Math.max(1,stats.todayCompletedJobs,stats.todayFailedJobs) * 100) + "%"}} /></div><b>{stats.todayFailedJobs}</b></div>
                    </div>}
                    <div className="admin-visual-foot">同一自然日内完成与失败的任务数量</div>
                  </article>
                  <article className="admin-visual-card">
                    <div className="admin-visual-title">导演模型调用路径</div>
                    {!stats.directorTelemetryAvailable ? <div className="admin-chart-empty">导演遥测数据尚未采集</div> : <div className="admin-route-chart">
                      <div className="admin-route-row"><div><span>主模型直连</span><b>{stats.primaryModelSuccessRate}%</b></div><div className="admin-route-track"><i style={{width:Math.max(0,Math.min(100,stats.primaryModelSuccessRate)) + "%"}} /></div></div>
                      <div className="admin-route-row"><div><span>备用模型接管</span><b>{stats.fallbackModelRate}%</b></div><div className="admin-route-track"><i style={{width:Math.max(0,Math.min(100,stats.fallbackModelRate)) + "%"}} /></div></div>
                      <div className="admin-route-row"><div><span>规则兜底</span><b>{stats.heuristicFallbackRate}%</b></div><div className="admin-route-track"><i style={{width:Math.max(0,Math.min(100,stats.heuristicFallbackRate)) + "%"}} /></div></div>
                    </div>}
                    <div className="admin-visual-foot">主模型 / 备用模型 / 规则兜底</div>
                  </article>
                </div>
              </section>

              <section className="admin-dashboard-section">
                <div className="admin-section-heading">
                  <div>
                    <h2>AI 导演效能</h2>
                    <p>耗时、尾部延迟与各制作阶段表现；耗时统计基于已完成任务</p>
                  </div>
                  <button className="admin-inline-link" onClick={() => setActiveTab("director-jobs")}>查看任务明细</button>
                </div>
                <div className="admin-performance-layout">
                  <div className="admin-performance-primary">
                    <span className="admin-data-label">端到端交付耗时 · 平均值</span>
                    <strong>{stats.avgE2eDurationSec > 0 ? `${stats.avgE2eDurationSec}s` : "暂无数据"}</strong>
                    <div className="admin-percentile-row">
                      <span>P50 <b>{stats.p50E2eDurationSec > 0 ? `${stats.p50E2eDurationSec}s` : "—"}</b></span>
                      <span>P90 <b>{stats.p90E2eDurationSec > 0 ? `${stats.p90E2eDurationSec}s` : "—"}</b></span>
                      <span>P99 <b>{stats.p99E2eDurationSec > 0 ? `${stats.p99E2eDurationSec}s` : "—"}</b></span>
                    </div>
                    <small>P50 表示一半任务不超过该耗时；P90/P99 用于观察慢任务尾部</small>
                  </div>
                  <div className="admin-stage-list">
                    <div className="admin-stage-row"><span>LLM 导演规划</span><strong>{stats.avgLlmDurationSec > 0 ? `${stats.avgLlmDurationSec}s` : "未采集"}</strong></div>
                    <div className="admin-stage-row"><span>TTS 人声合成</span><strong>{stats.avgTtsDurationSec > 0 ? `${stats.avgTtsDurationSec}s` : "未采集"}</strong></div>
                    <div className="admin-stage-row"><span>FFmpeg 独立耗时</span><strong>{stats.avgFfmpegDurationSec > 0 ? `${stats.avgFfmpegDurationSec}s` : "未单独采集"}</strong></div>
                  <div className="admin-stage-row"><span>渲染引擎总耗时（含内部步骤）</span><strong>{stats.avgRendererDurationSec > 0 ? `${stats.avgRendererDurationSec}s` : "未采集"}</strong></div>
                  </div>
                </div>
              </section>

              <section className="admin-dashboard-section">
                <div className="admin-section-heading">
                  <div>
                    <h2>模型命中与自动质检</h2>
                    <p>主模型直连、备用模型接管、规则兜底与成片质检；策略字段记录率不代表模型准确率</p>
                  </div>
                </div>
                <div className="admin-dashboard-kpis">
                  <div className="admin-dashboard-kpi"><span>主模型直连成功率</span><strong>{stats.directorTelemetryAvailable ? `${stats.primaryModelSuccessRate}%` : "未采集"}</strong><small>由主模型直接完成的调用</small></div>
                  <div className="admin-dashboard-kpi"><span>备用模型接管率</span><strong>{stats.directorTelemetryAvailable ? `${stats.fallbackModelRate}%` : "未采集"}</strong><small>主模型失败后备用模型完成</small></div>
                  <div className="admin-dashboard-kpi"><span>规则兜底率</span><strong>{stats.directorTelemetryAvailable ? `${stats.heuristicFallbackRate}%` : "未采集"}</strong><small>模型链路不可用时规则接管</small></div>
                  <div className="admin-dashboard-kpi"><span>自动质检通过率</span><strong>{stats.qualityCheckedJobs > 0 ? `${stats.qualityPassRate}%` : "未采集"}</strong><small>{stats.qualityPassedJobs} / {stats.qualityCheckedJobs} 个已质检任务</small></div>
                </div>
                <div className="admin-usage-strip">
                  <span>导演调用 {stats.directorCalls} 次</span>
                  <span>累计 Token {stats.tokenUsageRecords > 0 ? stats.totalTokensUsed.toLocaleString("zh-CN") : "供应商未返回"}</span>
                  <span>旁白字符 {stats.totalTtsChars.toLocaleString("zh-CN")}</span>
                </div>
              </section>

              <div className="overview-grid">
                <div className="overview-card">
                  <h3>经营与成本</h3>
                  <div className="stat-row"><span>今日已支付净额</span><strong>{stats.revenueDataAvailable === false ? statsUnavailableLabel : `¥${stats.todayRevenueYuan.toFixed(2)}`}</strong></div>
                  <div className="stat-row"><span>今日导演模型成本估算</span><strong>¥{(stats.todayCompletedJobs * 0.02).toFixed(2)}</strong></div>
                  <p className="admin-data-note">成本按每条视频 0.02 元计算（今日交付成片 × ¥0.02），不包含 TTS、存储与带宽；不以不完整成本计算毛利。</p>
                </div>
              </div>
            </div>
  );
}
