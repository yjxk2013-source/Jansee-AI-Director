import type { ServerHealthData } from "../../../types/admin";
import { AdminCloudStorageCard } from "./AdminCloudStorageCard";

interface AdminServerTabProps {
  serverHealth: ServerHealthData | null;
  serverHealthBusy: boolean;
  serverHealthError: string | null;
  serverHealthHistory: { cpu: number; memory: number; disk: number }[];
  fetchServerHealth: () => Promise<void>;
}

export function AdminServerTab({
  serverHealth,
  serverHealthBusy,
  serverHealthError,
  serverHealthHistory,
  fetchServerHealth,
}: AdminServerTabProps) {
  return (
            <div className="admin-server-viewport">
              <section className="admin-server-hero">
                <div>
                  <span className="admin-eyebrow">JANSEE / INFRASTRUCTURE MONITOR</span>
                  <h2>让每一项服务，都保持稳定运转。</h2>
                  <p>服务器资源、核心依赖与导演生产链路的实时健康状态。</p>
                </div>
                <div className="admin-server-live">
                  <i className={serverHealth ? "is-live" : "is-waiting"} />
                  <span>{serverHealth ? "监控已连接" : "等待连接"}</span>
                  <small>{serverHealth?.sampledAt ? new Date(serverHealth.sampledAt).toLocaleTimeString("zh-CN") + " 更新" : "尚无采样"}</small>
                  <button onClick={() => void fetchServerHealth()} disabled={serverHealthBusy}>{serverHealthBusy ? "刷新中…" : "立即刷新"}</button>
                </div>
              </section>

              {serverHealthError && <div className="admin-data-note" role="status">{serverHealthError}。请确认 API 服务已启动并且当前账号拥有管理员权限。</div>}

              <section className="admin-server-metrics">
                <article className="admin-server-metric">
                  <span>CPU 使用率</span>
                  <strong>{serverHealth?.cpu.usagePercent === null || serverHealth?.cpu.usagePercent === undefined ? "采样中" : serverHealth.cpu.usagePercent + "%"}</strong>
                  <div className="admin-server-meter"><i style={{ width: `${serverHealth?.cpu.usagePercent ?? 0}%` }} /></div>
                  <small>{serverHealth ? `${serverHealth.host.cpuCores} 核处理器 · 主机负载 ${serverHealth.cpu.loadAverage.map((v) => v.toFixed(2)).join(" / ")}` : "等待服务器数据"}</small>
                </article>
                <article className="admin-server-metric">
                  <span>内存占用</span>
                  <strong>{serverHealth ? serverHealth.memory.usedPercent + "%" : "—"}</strong>
                  <div className="admin-server-meter"><i style={{ width: `${serverHealth?.memory.usedPercent ?? 0}%` }} /></div>
                  <small>{serverHealth ? `${(serverHealth.memory.usedBytes / 1024 ** 3).toFixed(2)} GB / ${(serverHealth.memory.totalBytes / 1024 ** 3).toFixed(2)} GB · API 进程 ${(serverHealth.memory.processRssBytes / 1024 ** 2).toFixed(0)} MB` : "等待服务器数据"}</small>
                </article>
                <article className="admin-server-metric">
                  <span>磁盘使用率</span>
                  <strong>{serverHealth?.disk?.usedPercent == null ? "不可读取" : serverHealth.disk.usedPercent + "%"}</strong>
                  <div className="admin-server-meter"><i style={{ width: `${serverHealth?.disk?.usedPercent ?? 0}%` }} /></div>
                  <small>{serverHealth?.disk ? `${(serverHealth.disk.usedBytes / 1024 ** 3).toFixed(1)} GB 已用 · ${(serverHealth.disk.freeBytes / 1024 ** 3).toFixed(1)} GB 可用` : "磁盘统计暂不可用"}</small>
                </article>
                <article className="admin-server-metric">
                  <span>服务器运行时间</span>
                  <strong>{serverHealth ? `${Math.floor(serverHealth.host.uptimeSeconds / 86400)} 天` : "—"}</strong>
                  <div className="admin-server-uptime">{serverHealth ? `${Math.floor(serverHealth.host.uptimeSeconds % 86400 / 3600)} 小时 ${Math.floor(serverHealth.host.uptimeSeconds % 3600 / 60)} 分钟` : "等待服务器数据"}</div>
                  <small>{serverHealth ? `${serverHealth.host.platform} · ${serverHealth.host.architecture} · ${serverHealth.host.hostname}` : "主机信息"}</small>
                </article>
                <article className="admin-server-metric">
                  <span>{serverHealth?.mediaStorage?.driver === "cos" ? "腾讯云 COS 占用" : "媒体存储占用"}</span>
                  <strong>
                    {serverHealth?.mediaStorage
                      ? serverHealth.mediaStorage.totalBytes >= 1024 ** 3
                        ? `${(serverHealth.mediaStorage.totalBytes / 1024 ** 3).toFixed(2)} GB`
                        : `${(serverHealth.mediaStorage.totalBytes / 1024 ** 2).toFixed(1)} MB`
                      : "—"}
                  </strong>
                  <div className="admin-server-meter">
                    <i style={{ width: serverHealth?.mediaStorage ? "100%" : "0%", background: "#39a68b" }} />
                  </div>
                  <small>
                    {serverHealth?.mediaStorage
                      ? `${serverHealth.mediaStorage.activeOutputsCount} 个成片 (${(serverHealth.mediaStorage.activeOutputsBytes / 1024 ** 2).toFixed(1)} MB) · ${serverHealth.mediaStorage.activeAssetsCount} 个素材 · ${serverHealth.mediaStorage.driver === "cos" ? (serverHealth.mediaStorage.bucket || "COS 已连接") : "本地存储"}`
                      : "等待存储数据"}
                  </small>
                </article>
              </section>

              <AdminCloudStorageCard cloudStorage={serverHealth?.cloudStorage} />

              <section className="admin-server-panel">
                <div className="admin-server-panel-head"><div><span className="admin-eyebrow">RESOURCE TREND / LIVE SESSION</span><h3>资源使用趋势</h3><p>每 15 秒采集一次；页面打开期间保留最近 24 个采样点。</p></div><span className="admin-server-auto">自动刷新 · 15 秒</span></div>
                {serverHealthHistory.length >= 2 ? (
                  <div className="admin-server-chart">
                    <div className="admin-server-chart-legend"><span><i className="cpu" />CPU</span><span><i className="memory" />内存</span><span><i className="disk" />磁盘</span></div>
                    <svg viewBox="0 0 900 180" preserveAspectRatio="none" role="img" aria-label="服务器资源使用趋势">
                      <path d="M12 12 H888 M12 90 H888 M12 168 H888" stroke="#eceaf5" strokeDasharray="4 6" fill="none" />
                      <polyline points={serverHealthHistory.map((point, index) => `${12 + index * (876 / Math.max(1, serverHealthHistory.length - 1))},${168 - point.cpu * 1.56}`).join(" ")} fill="none" stroke="#766de0" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                      <polyline points={serverHealthHistory.map((point, index) => `${12 + index * (876 / Math.max(1, serverHealthHistory.length - 1))},${168 - point.memory * 1.56}`).join(" ")} fill="none" stroke="#39a68b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                      <polyline points={serverHealthHistory.map((point, index) => `${12 + index * (876 / Math.max(1, serverHealthHistory.length - 1))},${168 - point.disk * 1.56}`).join(" ")} fill="none" stroke="#d5a04c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div className="admin-server-chart-axis"><span>最早采样</span><span>最近采样</span></div>
                  </div>
                ) : <div className="admin-server-chart-empty">正在积累采样数据。保持此页面打开约 30 秒，即可看到 CPU、内存和磁盘变化曲线。</div>}
              </section>

              <section className="admin-server-panel">
                <div className="admin-server-panel-head"><div><span className="admin-eyebrow">SERVICE HEALTH / DEPENDENCIES</span><h3>服务健康检查</h3><p>区分主机资源与具体依赖故障，不把单项服务异常误判成整台服务器宕机。</p></div></div>
                <div className="admin-server-services">
                  {([
                    ["api", "API 服务", "管理接口响应检查"],
                    ["database", "V4 数据库", "数据库连接与查询"],
                    ["worker", "成片任务 Worker", "后台任务执行进程"],
                    ["director", "AI 导演模型", "模型 API 配置状态"],
                    ["tts", "TTS 语音服务", "语音服务凭据配置"],
                    ["ffmpeg", "FFmpeg 引擎", "本机执行文件检测"],
                    ["media", "素材存储", "本地 / 云端存储初始化"],
                    ["payment", "OPCPAY 支付", "支付服务启动状态"],
                  ] as const).map(([key, title, subtitle]) => {
                    const service = serverHealth?.services[key];
                    const status = service?.status ?? "unknown";
                    const label = status === "healthy" ? "运行正常" : status === "configured" ? "已配置" : status === "not_configured" ? "未配置" : status === "unavailable" ? "不可用" : "待检测";
                    return <article className={`admin-server-service ${status}`} key={key}>
                      <div className="admin-server-service-top"><span className="admin-server-service-icon">{key === "database" ? "DB" : key === "worker" ? "WK" : key === "director" ? "AI" : key === "payment" ? "¥" : key === "ffmpeg" ? "FX" : key === "tts" ? "VO" : key === "media" ? "ST" : "API"}</span><span className={`admin-server-status ${status}`}>{label}</span></div>
                      <strong>{title}</strong><small>{subtitle}</small><p>{service?.detail ?? "等待后端健康检查数据"}</p>
                    </article>;
                  })}
                </div>
                <div className="admin-server-footnote">安全说明：此监控接口仅管理员登录后可访问；不会返回环境变量、密钥、数据库连接串或原始用户 IP。导演与 TTS 显示配置状态，不会为了监控而发起计费调用。</div>
              </section>
            </div>
  );
}
