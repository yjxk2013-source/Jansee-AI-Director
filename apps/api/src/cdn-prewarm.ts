import tencentcloud from "tencentcloud-sdk-nodejs";

const CdnClient = tencentcloud.cdn.v20180606.Client;

let cachedClient: InstanceType<typeof CdnClient> | null = null;

function getCdnClient(): InstanceType<typeof CdnClient> | null {
  const secretId = process.env.COS_SECRET_ID;
  const secretKey = process.env.COS_SECRET_KEY;
  if (!secretId || !secretKey) return null;
  if (!cachedClient) {
    cachedClient = new CdnClient({
      credential: { secretId, secretKey },
      region: "",
      profile: { httpProfile: { endpoint: "cdn.tencentcloudapi.com" } },
    });
  }
  return cachedClient;
}

/**
 * 针对创作者私域制作特点，在新成片/切片生成完毕的第一时间，
 * 异步调用腾讯云 CDN 预热接口 (PushUrlsCache) 将视频推送到边缘机房，
 * 实现用户点开播放时“0 等待、开播即命中高速缓存”。
 */
export async function prewarmCdnUrls(urls: string[]): Promise<void> {
  const cdnDomain = process.env.COS_CDN_DOMAIN?.trim();
  if (!cdnDomain || !urls.length) return;

  const validUrls = urls
    .map((u) => u.trim())
    .filter((u) => u.startsWith(`https://${cdnDomain}/`) || u.startsWith(`http://${cdnDomain}/`));

  if (!validUrls.length) return;

  const client = getCdnClient();
  if (!client) return;

  try {
    const res = await client.PushUrlsCache({ Urls: validUrls });
    console.info(`[jansee-cdn] successfully prewarmed ${validUrls.length} urls, taskId=${res.TaskId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[jansee-cdn] prewarm failed (non-blocking): ${message.slice(0, 160)}`);
  }
}
