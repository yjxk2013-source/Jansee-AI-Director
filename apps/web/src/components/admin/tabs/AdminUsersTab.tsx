import type { UserAnalyticsData, SiteAnalyticsData } from "../../../types/admin";

interface AdminUsersTabProps {
  userAnalytics: UserAnalyticsData | null;
  siteAnalytics: SiteAnalyticsData | null;
  loading: boolean;
  trendMax: number;
  userTrend: { day: string; registrations: number; completedJobs: number; revenueYuan: number }[];
  trendPoints: string;
  completedTrendPoints: string;
  revenueTrendPoints: string;
  userKeyword: string;
  setUserKeyword: (value: string) => void;
  userListBusy: boolean;
  searchUsers: () => Promise<void>;
  loadMoreUsers: () => Promise<void>;
  visibleUsers: UserAnalyticsData["users"];
  maxProvinceUsers: number;
  openCreditAdjustment: (user: UserAnalyticsData["users"][number]) => void;
}

export function AdminUsersTab({
  userAnalytics,
  siteAnalytics,
  loading,
  trendMax,
  userTrend,
  trendPoints,
  completedTrendPoints,
  revenueTrendPoints,
  userKeyword,
  setUserKeyword,
  userListBusy,
  searchUsers,
  loadMoreUsers,
  visibleUsers,
  maxProvinceUsers,
  openCreditAdjustment,
}: AdminUsersTabProps) {
  return (
    <div className="admin-users-viewport">
      <section className="admin-users-hero">
        <div>
          <span className="admin-eyebrow">JANSEE / AUDIENCE INTELLIGENCE</span>
          <h2>每一次注册，都是简兮向前的一步。</h2>
          <p>看见用户从哪里来、何时加入，以及增长正在发生的方向。</p>
        </div>
        <div className="admin-users-total">
          <span>COMMUNITY SIZE</span>
          <strong>{userAnalytics ? userAnalytics.summary.totalUsers.toLocaleString("zh-CN") : "—"}</strong>
          <small>累计注册用户</small>
        </div>
      </section>

      <section className="admin-user-kpis">
        <article><span>今日新朋友</span><strong>{userAnalytics?.summary.todayNewUsers ?? "—"}</strong><small>今天加入简兮的人</small></article>
        <article><span>近 7 天</span><strong>{userAnalytics?.summary.last7Days ?? "—"}</strong><small>最近一周新增用户</small></article>
        <article><span>近 30 天</span><strong>{userAnalytics?.summary.last30Days ?? "—"}</strong><small>最近一个月新增用户</small></article>
        <article><span>正常账号</span><strong>{userAnalytics?.summary.activeUsers ?? "—"}</strong><small>当前状态正常的账号</small></article>
      </section>

      <section className="admin-user-chart-card admin-site-analytics-card">
        <div className="admin-user-card-heading">
          <div><span className="admin-eyebrow">SITE TRAFFIC / VERIFIED HUMAN VISITS</span><h3>网站真实访问</h3><p>来自 V2 真人访问聚合；不把爬虫、机房原始请求或 Nginx 请求量当作访客。</p></div>
          <span className="admin-chart-legend">{siteAnalytics?.summary.days ?? 0} 天历史数据</span>
        </div>
        <div className="admin-user-kpis">
          <article><span>真实浏览 PV</span><strong>{siteAnalytics ? siteAnalytics.summary.pv.toLocaleString("zh-CN") : "—"}</strong><small>通过 V2 访客过滤后的页面浏览</small></article>
          <article><span>真实访客 UV</span><strong>{siteAnalytics ? siteAnalytics.summary.uv.toLocaleString("zh-CN") : "—"}</strong><small>按匿名访客标识去重</small></article>
          <article><span>日均 PV</span><strong>{siteAnalytics?.summary.days ? Math.round(siteAnalytics.summary.pv / siteAnalytics.summary.days).toLocaleString("zh-CN") : "—"}</strong><small>按已导入的统计日期计算</small></article>
          <article><span>访问来源</span><strong>{siteAnalytics ? Object.keys(siteAnalytics.dimensions.sources).length : "—"}</strong><small>搜索引擎、外部网站及直接访问</small></article>
        </div>
        <div className="admin-region-list">
          <div className="admin-user-card-heading"><div><span className="admin-eyebrow">TRAFFIC SOURCES</span><h3>访客从哪里来</h3></div></div>
          {siteAnalytics ? Object.entries(siteAnalytics.dimensions.sources).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([source, count]) => (
            <div className="admin-region-row" key={source}>
              <div className="admin-region-label"><strong>{source}</strong><span>{count} 次</span></div>
              <div className="admin-region-track"><i style={{ width: `${Math.max(3, count / Math.max(1, ...Object.values(siteAnalytics.dimensions.sources)) * 100)}%` }} /></div>
            </div>
          )) : <div className="admin-users-empty">网站访问统计暂不可用。</div>}
        </div>
        <p className="admin-region-foot">{siteAnalytics?.note ?? "网站访问统计尚未载入。"}</p>
      </section>

      <section className="admin-user-chart-card admin-user-table-card">
        <div className="admin-user-card-heading">
          <div><span className="admin-eyebrow">MEMBERS / DIRECTORY</span><h3>认识每一位用户</h3><p>最近注册的账号 · 共 {userAnalytics?.total ?? "—"} 位</p></div>
          <div className="admin-user-search-actions">
            <input
              className="admin-user-search"
              value={userKeyword}
              placeholder="按手机号、昵称、地区搜索…"
              onChange={(event) => setUserKeyword(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void searchUsers(); }}
            />
            <button
              type="button"
              className="admin-user-search-button"
              onClick={() => void searchUsers()}
              disabled={userListBusy}
            >
              {userListBusy ? "检索中…" : "搜索用户"}
            </button>
          </div>
        </div>

        <div className="admin-user-table-scroll">
          <table className="admin-user-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>手机号 / 联系方式</th>
                <th>注册时间</th>
                <th>所在地区</th>
                <th>可用积分</th>
                <th>成片数</th>
                <th>下载量</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="admin-users-empty">正在加载名册…</td></tr>
              ) : visibleUsers.length === 0 ? (
                <tr><td colSpan={9} className="admin-users-empty">暂无匹配用户</td></tr>
              ) : (
                visibleUsers.map((user) => (
                  <tr key={user.id}>
                    <td><strong>{user.displayName}</strong></td>
                    <td>{user.contact}</td>
                    <td>{new Date(user.createdAt).toLocaleDateString("zh-CN")}</td>
                    <td>{user.region}</td>
                    <td><strong className="admin-user-credits">{user.credits.toLocaleString("zh-CN")}</strong></td>
                    <td>{user.completedJobs.toLocaleString("zh-CN")}</td>
                    <td>{(user.downloads ?? 0).toLocaleString("zh-CN")}</td>
                    <td><span className={`admin-user-status ${user.status === "active" ? "is-active" : "is-paused"}`}>{user.status === "active" ? "正常" : user.status}</span></td>
                    <td><button type="button" className="admin-user-credit-btn" onClick={() => openCreditAdjustment(user)}>调整积分</button></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {userAnalytics && userAnalytics.users.length < userAnalytics.total && (
            <button
              type="button"
              className="admin-load-more-users"
              onClick={() => void loadMoreUsers()}
              disabled={userListBusy}
            >
              {userListBusy ? "加载中…" : `继续查看更早注册的用户（已载入 ${userAnalytics.users.length} / ${userAnalytics.total}）`}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
