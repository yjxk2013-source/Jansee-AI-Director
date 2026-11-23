import tencentcloud from "tencentcloud-sdk-nodejs";

export interface CdnTrafficPackageInfo {
  totalBytes: number;
  usedBytes: number;
  remainingBytes: number;
  usedPercent: number;
  expireTime: string;
}

export interface CloudStorageMetrics {
  todayCdnBytes: number;
  todayDirectCosBytes: number;
  recent1hDirectCosBytes: number;
  todayCdnOriginBytes: number;
  accountBalanceYuan: number | null;
  estimatedCostTodayYuan: number;
  isDirectCosLeak: boolean;
  isCurrentlyLeaking: boolean;
  cdnPackage?: CdnTrafficPackageInfo | null;
  sampledAt: string;
}

export interface CloudStorageServiceConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  cdnDomain?: string | undefined;
}

let cachedMetrics: { data: CloudStorageMetrics; expiresAt: number } | null = null;

export async function fetchCloudStorageMetrics(config: CloudStorageServiceConfig): Promise<CloudStorageMetrics> {
  const now = Date.now();
  if (cachedMetrics && cachedMetrics.expiresAt > now) {
    return cachedMetrics.data;
  }

  const { secretId, secretKey, bucket, region, cdnDomain } = config;
  if (!secretId || !secretKey || !bucket || !region) {
    throw new Error("Tencent Cloud configuration is missing");
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const nowStr = new Date().toISOString().slice(0, 19).replace("T", " ");
  const startOfDayStr = `${todayStr} 00:00:00`;

  let todayCdnBytes = 0;
  let todayDirectCosBytes = 0;
  let recent1hDirectCosBytes = 0;
  let todayCdnOriginBytes = 0;
  let accountBalanceYuan: number | null = null;
  let cdnPackage: CdnTrafficPackageInfo | null = null;

  // 1. 获取腾讯云账户现金可用余额 (Billing API)
  try {
    const BillingClient = tencentcloud.billing.v20180709.Client;
    const billingClient = new BillingClient({
      credential: { secretId, secretKey },
      region,
    });
    const billingRes = await billingClient.DescribeAccountBalance({});
    if (typeof billingRes.Balance === "number" || typeof billingRes.Balance === "string") {
      accountBalanceYuan = Number((Number(billingRes.Balance) / 100).toFixed(2));
    }
  } catch (err) {
    console.warn("[admin-metrics] 查询腾讯云账户余额失败:", err instanceof Error ? err.message : String(err));
  }

  // 2. 获取 CDN 今日总流量与 100G 流量包使用情况 (CDN API)
  try {
    const CdnClient = tencentcloud.cdn.v20180606.Client;
    const cdnClient = new CdnClient({
      credential: { secretId, secretKey },
      region,
    });

    const [cdnDataRes, pkgRes] = await Promise.allSettled([
      cdnDomain ? cdnClient.DescribeCdnData({
        StartTime: startOfDayStr,
        EndTime: nowStr,
        Metric: "flux",
        Domains: [cdnDomain],
      }) : Promise.reject(new Error("No CDN Domain")),
      cdnClient.DescribeTrafficPackages({}),
    ]);

    if (cdnDataRes.status === "fulfilled") {
      const sumValue = cdnDataRes.value.Data?.[0]?.CdnData?.[0]?.SummarizedData?.Value;
      if (typeof sumValue === "number") {
        todayCdnBytes = sumValue;
      }
    }

    if (pkgRes.status === "fulfilled") {
      const packages = pkgRes.value.TrafficPackages ?? [];
      const activePkg = packages.find((p: any) => p.Status === "enabled") || packages[0];
      if (activePkg && typeof activePkg.Bytes === "number") {
        const total = activePkg.Bytes;
        const used = activePkg.BytesUsed ?? 0;
        const remaining = Math.max(0, total - used);
        const usedPercent = total > 0 ? Number(((used / total) * 100).toFixed(2)) : 0;
        cdnPackage = {
          totalBytes: total,
          usedBytes: used,
          remainingBytes: remaining,
          usedPercent,
          expireTime: activePkg.ExpireTime || "",
        };
      }
    }
  } catch (err) {
    console.warn("[admin-metrics] 查询 CDN 流量与资源包失败:", err instanceof Error ? err.message : String(err));
  }

  // 3. 获取 COS 源站外网下行与回源流量 (Monitor API)
  try {
    const MonitorClient = tencentcloud.monitor.v20180724.Client;
    const monitorClient = new MonitorClient({
      credential: { secretId, secretKey },
      region,
    });

    const [internetRes, originRes] = await Promise.allSettled([
      monitorClient.GetMonitorData({
        Namespace: "QCE/COS",
        MetricName: "InternetTraffic",
        Period: 3600,
        StartTime: startOfDayStr,
        EndTime: nowStr,
        Instances: [{ Dimensions: [{ Name: "bucket", Value: bucket }] }],
      }),
      monitorClient.GetMonitorData({
        Namespace: "QCE/COS",
        MetricName: "CdnOriginTraffic",
        Period: 3600,
        StartTime: startOfDayStr,
        EndTime: nowStr,
        Instances: [{ Dimensions: [{ Name: "bucket", Value: bucket }] }],
      }),
    ]);

    if (internetRes.status === "fulfilled") {
      const values = (internetRes.value.DataPoints?.[0]?.Values ?? []).map((v: any) => Number(v) || 0);
      todayDirectCosBytes = values.reduce((sum: number, v: number) => sum + v, 0);
      // 最近 1 小时的采样值（最后一个数据点）
      if (values.length > 0) {
        recent1hDirectCosBytes = values[values.length - 1] ?? 0;
      }
    }

    if (originRes.status === "fulfilled") {
      const values = (originRes.value.DataPoints?.[0]?.Values ?? []).map((v: any) => Number(v) || 0);
      todayCdnOriginBytes = values.reduce((sum: number, v: number) => sum + v, 0);
    }
  } catch (err) {
    console.warn("[admin-metrics] 查询 COS 监控流量失败:", err instanceof Error ? err.message : String(err));
  }

  // 4. 估算今日存储与分发总成本 (元)
  // CDN 下行流量按 0.20 元/GB；CDN 回源流量按 0.15 元/GB；COS 外网下行按 0.50 元/GB
  const cdnGb = todayCdnBytes / (1024 ** 3);
  const originGb = todayCdnOriginBytes / (1024 ** 3);
  const directCosGb = todayDirectCosBytes / (1024 ** 3);
  const estimatedCost = cdnGb * 0.20 + originGb * 0.15 + directCosGb * 0.50;
  const estimatedCostTodayYuan = Number(estimatedCost.toFixed(2));

  // 告警判断：
  // isDirectCosLeak: 全天累计是否有历史直连记录
  // isCurrentlyLeaking: 最近 1 小时是否有新增直连（若最近1小时为0，说明当前已切断阻断，不报警）
  const isDirectCosLeak = directCosGb > 0.1;
  const isCurrentlyLeaking = recent1hDirectCosBytes > 1024 * 1024; // 最近1小时大于1MB才算当前正在泄漏

  const result: CloudStorageMetrics = {
    todayCdnBytes,
    todayDirectCosBytes,
    recent1hDirectCosBytes,
    todayCdnOriginBytes,
    accountBalanceYuan,
    estimatedCostTodayYuan,
    isDirectCosLeak,
    isCurrentlyLeaking,
    cdnPackage,
    sampledAt: new Date().toISOString(),
  };

  // 缓存 3 分钟
  cachedMetrics = {
    data: result,
    expiresAt: now + 3 * 60 * 1000,
  };

  return result;
}
