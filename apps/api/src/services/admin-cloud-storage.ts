import tencentcloud from "tencentcloud-sdk-nodejs";

export interface CloudStorageMetrics {
  todayCdnBytes: number;
  todayDirectCosBytes: number;
  todayCdnOriginBytes: number;
  accountBalanceYuan: number | null;
  estimatedCostTodayYuan: number;
  isDirectCosLeak: boolean;
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
  let todayCdnOriginBytes = 0;
  let accountBalanceYuan: number | null = null;

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

  // 2. 获取 CDN 今日总流量 (CDN API)
  if (cdnDomain) {
    try {
      const CdnClient = tencentcloud.cdn.v20180606.Client;
      const cdnClient = new CdnClient({
        credential: { secretId, secretKey },
        region,
      });
      const cdnRes = await cdnClient.DescribeCdnData({
        StartTime: startOfDayStr,
        EndTime: nowStr,
        Metric: "flux",
        Domains: [cdnDomain],
      });
      const sumValue = cdnRes.Data?.[0]?.CdnData?.[0]?.SummarizedData?.Value;
      if (typeof sumValue === "number") {
        todayCdnBytes = sumValue;
      }
    } catch (err) {
      console.warn("[admin-metrics] 查询 CDN 流量失败:", err instanceof Error ? err.message : String(err));
    }
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
      const values = internetRes.value.DataPoints?.[0]?.Values ?? [];
      todayDirectCosBytes = values.reduce((sum, v) => sum + (Number(v) || 0), 0);
    }

    if (originRes.status === "fulfilled") {
      const values = originRes.value.DataPoints?.[0]?.Values ?? [];
      todayCdnOriginBytes = values.reduce((sum, v) => sum + (Number(v) || 0), 0);
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

  // 红线告警判断：当日外网下行直连大于 100MB 即触发警报
  const isDirectCosLeak = directCosGb > 0.1;

  const result: CloudStorageMetrics = {
    todayCdnBytes,
    todayDirectCosBytes,
    todayCdnOriginBytes,
    accountBalanceYuan,
    estimatedCostTodayYuan,
    isDirectCosLeak,
    sampledAt: new Date().toISOString(),
  };

  // 缓存 3 分钟 (180,000 ms)
  cachedMetrics = {
    data: result,
    expiresAt: now + 3 * 60 * 1000,
  };

  return result;
}
