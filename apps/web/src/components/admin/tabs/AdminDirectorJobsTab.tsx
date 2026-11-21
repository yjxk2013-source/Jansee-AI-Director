import type { AdminOverviewStats, DirectorJobInsight } from "../../../types/admin";

interface AdminDirectorJobsTabProps {
  loadedStats: AdminOverviewStats | null;
  loading: boolean;
  filterStatus: string;
  setFilterStatus: (status: string) => void;
  filterScene: string;
  setFilterScene: (scene: string) => void;
  filteredJobs: DirectorJobInsight[];
  compensationAvailable: boolean;
  compensatingJobId: string | null;
  handleCompensate: (jobId: string) => void;
}

export function AdminDirectorJobsTab({
  loadedStats,
  loading,
  filterStatus,
  setFilterStatus,
  filterScene,
  setFilterScene,
  filteredJobs,
  compensationAvailable,
  compensatingJobId,
  handleCompensate,
}: AdminDirectorJobsTabProps) {
  return (
            <div className="director-jobs-viewport">
              <section className="director-exec-summary" aria-label="导演交付经营指标">
                <div className="director-exec-summary-heading"><div><h2>导演交付效能</h2><p>只呈现交付结果与业务表现，不展示用户原始描述或系统内部指令</p></div></div>
                <div className="director-exec-metrics">
                  <div><span>累计任务</span><strong>{loadedStats ? loadedStats.totalJobs.toLocaleString("zh-CN") : "\u2014"}</strong></div>
                  <div><span>交付成功率</span><strong>{loadedStats ? loadedStats.jobSuccessRate.toFixed(1) + "%" : "\u2014"}</strong></div>
                  <div><span>平均交付耗时</span><strong>{loadedStats && loadedStats.avgE2eDurationSec > 0 ? loadedStats.avgE2eDurationSec.toFixed(1) + "s" : "\u2014"}</strong></div>
                  <div><span>今日成功交付</span><strong>{loadedStats ? loadedStats.todayCompletedJobs.toLocaleString("zh-CN") : "\u2014"}</strong></div>
                </div>
              </section>
              <div className="admin-filter-bar">
                <div className="filter-group"><span className="filter-title">交付状态</span>
                  {["all", "completed", "failed", "rendering"].map((status) => <button key={status} className={"filter-chip " + (filterStatus === status ? "active" : "")} onClick={() => setFilterStatus(status)}>{status === "all" ? "全部" : status === "completed" ? "已交付" : status === "failed" ? "交付失败" : "处理中"}</button>)}
                </div>
                <div className="filter-group"><span className="filter-title">业务场景</span>
                  {[
                    { value: "all", label: "全部场景" },
                    { value: "online-ecommerce", label: "线上电商" },
                    { value: "physical-store", label: "线下商家" },
                    { value: "personal-creation", label: "个人创作" },
                    { value: "quick-cut", label: "一句话剪辑" },
                    { value: "未分类", label: "未分类" },
                  ].map((scene) => <button key={scene.value} className={"filter-chip " + (filterScene === scene.value ? "active" : "")} onClick={() => setFilterScene(scene.value)}>{scene.label}</button>)}
                </div>
              </div>
              <div className="job-insight-list director-delivery-list">
                {loading ? <div className="admin-empty-state">正在读取交付记录…</div> : filteredJobs.length === 0 ? <div className="admin-empty-state">暂无符合条件的交付记录</div> : filteredJobs.map((job) => {
                  const sceneLabel = job.sceneType === "online-ecommerce" ? "线上电商" : job.sceneType === "physical-store" ? "线下商家" : job.sceneType === "personal-creation" ? "个人创作" : job.sceneType === "quick-cut" ? "一句话剪辑" : "未分类";
                  const statusLabel = job.status === "completed" ? "已交付" : job.status === "failed" ? "交付失败" : ["rendering", "planning", "inspecting", "quality-check"].includes(job.status) ? "处理中" : "等待处理";
                  return <article className={"job-insight-card director-delivery-card " + job.status} key={job.jobId}>
                    <div className="director-delivery-main">
                      <div className="director-delivery-heading"><span className={"status-pill " + (job.status === "completed" ? "completed" : job.status === "failed" ? "failed" : "pending")}>{statusLabel}</span><strong>{sceneLabel}</strong></div>
                      <div className="director-delivery-meta"><span>任务编号 {job.jobId}</span><time>{new Date(job.createdAt).toLocaleString("zh-CN")}</time></div>
                    </div>
                    <div className="director-delivery-result"><span>交付耗时</span><strong>{job.e2eDurationMs > 0 ? (job.e2eDurationMs / 1000).toFixed(1) + "s" : "\u2014"}</strong></div>
                  {job.status === "failed" && <button className="compensate-btn" disabled={!compensationAvailable || compensatingJobId === job.jobId} onClick={() => handleCompensate(job.jobId)}>{compensatingJobId === job.jobId ? "处理中?" : compensationAvailable ? "一键补发 200 积分" : "补偿功能待账本接入"}</button>}
                  </article>;
                })}
              </div>
            </div>
  );
}
