import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const WIDTH = 1080;
const HEIGHT = 1920;

// SVG 矢量宣发海报模版
const svg = `
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- 背景渐变：深邃黑曜石质感 -->
    <radialGradient id="bgGrad" cx="50%" cy="30%" r="80%">
      <stop offset="0%" stop-color="#14141d" />
      <stop offset="50%" stop-color="#0a0a0e" />
      <stop offset="100%" stop-color="#050507" />
    </radialGradient>

    <!-- 微光辉光 -->
    <radialGradient id="cyanGlow" cx="50%" cy="25%" r="40%">
      <stop offset="0%" stop-color="rgba(56, 189, 248, 0.12)" />
      <stop offset="100%" stop-color="rgba(56, 189, 248, 0)" />
    </radialGradient>

    <!-- 橙金高光（Product Hunt 专属） -->
    <radialGradient id="phGlow" cx="50%" cy="65%" r="35%">
      <stop offset="0%" stop-color="rgba(255, 97, 84, 0.15)" />
      <stop offset="100%" stop-color="rgba(255, 97, 84, 0)" />
    </radialGradient>

    <!-- 幽灵线框渐变 -->
    <linearGradient id="borderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="rgba(255, 255, 255, 0.4)" />
      <stop offset="50%" stop-color="rgba(255, 255, 255, 0.08)" />
      <stop offset="100%" stop-color="rgba(255, 255, 255, 0.2)" />
    </linearGradient>

    <linearGradient id="btnGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ff6154" />
      <stop offset="100%" stop-color="#ff4538" />
    </linearGradient>
  </defs>

  <!-- 底色层 -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bgGrad)" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#cyanGlow)" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#phGlow)" />

  <!-- 顶部细线装饰条 -->
  <line x1="80" y1="120" x2="1000" y2="120" stroke="rgba(255, 255, 255, 0.1)" stroke-width="1" />

  <!-- 顶部状态栏小标 -->
  <text x="80" y="105" fill="#a1a1aa" font-family="'PingFang SC', 'Noto Sans SC', sans-serif" font-size="16" letter-spacing="3" font-weight="500">
    JANSEE · GLOBAL LAUNCH DAY
  </text>
  <text x="1000" y="105" text-anchor="end" fill="#38bdf8" font-family="sans-serif" font-size="16" letter-spacing="2" font-weight="600">
    2026 OFFICIAL LAUNCH
  </text>

  <!-- 品牌主视觉区域 -->
  <!-- 品牌英文大 LOGO -->
  <text x="540" y="270" text-anchor="middle" fill="#ffffff" font-family="'Helvetica Neue', 'Arial', sans-serif" font-size="88" font-weight="900" letter-spacing="18">
    JANSEE
  </text>
  <!-- 中文副标识 -->
  <text x="540" y="335" text-anchor="middle" fill="#d4d4d8" font-family="'PingFang SC', 'Noto Serif SC', sans-serif" font-size="30" font-weight="300" letter-spacing="12">
    简 兮 · 全 栈 A I 短 视 频 重 构 工 场
  </text>

  <!-- 核心标语 -->
  <text x="540" y="440" text-anchor="middle" fill="#ffffff" font-family="'PingFang SC', 'Noto Sans SC', sans-serif" font-size="46" font-weight="700" letter-spacing="3">
    随手实拍图，3步极简商业出片
  </text>
  <text x="540" y="495" text-anchor="middle" fill="#a1a1aa" font-family="sans-serif" font-size="22" font-weight="400" letter-spacing="1">
    No Complex Timelines · Zero Bloat · Studio-Grade Video Engine
  </text>

  <!-- 中间核心卡片容器：黑曜石毛玻璃幽灵边框 -->
  <rect x="100" y="560" width="880" height="780" rx="4" fill="rgba(255, 255, 255, 0.02)" stroke="url(#borderGrad)" stroke-width="1.5" />

  <!-- 卡片内头部：Product Hunt 官方联名标志 -->
  <g transform="translate(150, 620)">
    <!-- PH 标志背景胶囊 -->
    <rect x="0" y="0" width="360" height="58" rx="2" fill="rgba(255, 97, 84, 0.12)" stroke="rgba(255, 97, 84, 0.4)" stroke-width="1" />
    <!-- PH 圆形 Logo 标识 -->
    <circle cx="34" cy="29" r="18" fill="#ff6154" />
    <text x="34" y="37" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="22" font-weight="900">P</text>
    <text x="70" y="36" fill="#ffffff" font-family="sans-serif" font-size="20" font-weight="700" letter-spacing="1">Product Hunt</text>
    <text x="228" y="36" fill="#ff6154" font-family="sans-serif" font-size="16" font-weight="800" letter-spacing="2">· TODAY</text>
  </g>

  <!-- 卡片内三大硬核亮点 -->
  <g transform="translate(160, 740)">
    <!-- 亮点 1 -->
    <circle cx="20" cy="20" r="4" fill="#38bdf8" />
    <text x="44" y="27" fill="#ffffff" font-family="'PingFang SC', sans-serif" font-size="28" font-weight="700">01 / 极简3步带货出片</text>
    <text x="44" y="65" fill="#a1a1aa" font-family="'PingFang SC', sans-serif" font-size="20">上传 3~9 张实拍图，毫秒级音画同轴，告别繁琐时间轴剪辑</text>

    <!-- 亮点 2 -->
    <circle cx="20" cy="130" r="4" fill="#38bdf8" />
    <text x="44" y="137" fill="#ffffff" font-family="'PingFang SC', sans-serif" font-size="28" font-weight="700">02 / Single-Pass 极速流式转码</text>
    <text x="44" y="175" fill="#a1a1aa" font-family="'PingFang SC', sans-serif" font-size="20">单遍流式合成，耗时腰斩 68%，纯净宣发封面与电影级收束直出</text>

    <!-- 亮点 3 -->
    <circle cx="20" cy="240" r="4" fill="#38bdf8" />
    <text x="44" y="247" fill="#ffffff" font-family="'PingFang SC', sans-serif" font-size="28" font-weight="700">03 / 大厂级工业视听基座</text>
    <text x="44" y="285" fill="#a1a1aa" font-family="'PingFang SC', sans-serif" font-size="20">两段式 Sidechain 动态人声避让混音，发丝级微距字幕与国标合规</text>
  </g>

  <!-- 卡片内部行动呼吁大按钮 (CTA) -->
  <g transform="translate(200, 1150)">
    <rect x="0" y="0" width="680" height="96" rx="2" fill="url(#btnGrad)" />
    <!-- 三角 Upvote 图标 -->
    <path d="M60 58 L80 34 L100 58 Z" fill="#ffffff" />
    <text x="360" y="58" text-anchor="middle" fill="#ffffff" font-family="'PingFang SC', sans-serif" font-size="28" font-weight="800" letter-spacing="2">
      前往 Product Hunt 为简兮打 Call 投票
    </text>
  </g>
  <text x="540" y="1285" text-anchor="middle" fill="#d4d4d8" font-family="sans-serif" font-size="18" letter-spacing="1">
    ▲ 点击右侧 Upvote 三角图标 · 助推中国独立出海产品
  </text>

  <!-- 底部链接与官方信息 -->
  <line x1="80" y1="1400" x2="1000" y2="1400" stroke="rgba(255, 255, 255, 0.08)" stroke-width="1" />

  <!-- 官方网址与支持渠道 -->
  <g transform="translate(100, 1470)">
    <rect x="0" y="0" width="880" height="280" rx="4" fill="rgba(10, 10, 14, 0.6)" stroke="rgba(255, 255, 255, 0.1)" stroke-width="1" />
    
    <!-- 网址 -->
    <text x="60" y="70" fill="#a1a1aa" font-family="sans-serif" font-size="18">OFFICIAL WEBSITE 官网体验：</text>
    <text x="60" y="115" fill="#38bdf8" font-family="sans-serif" font-size="34" font-weight="800" letter-spacing="1">https://jansee.cn</text>

    <!-- Product Hunt 直达链接提示 -->
    <text x="60" y="180" fill="#a1a1aa" font-family="sans-serif" font-size="18">PRODUCT HUNT 直达主页：</text>
    <text x="60" y="225" fill="#ff6154" font-family="sans-serif" font-size="26" font-weight="700">producthunt.com/posts/jansee</text>
  </g>

  <!-- 最底部极简版权声明 -->
  <text x="540" y="1840" text-anchor="middle" fill="rgba(255, 255, 255, 0.25)" font-family="sans-serif" font-size="16" letter-spacing="2">
    JANSEE · ALL RIGHTS RESERVED · 2026
  </text>
</svg>
`;

async function renderPoster() {
  const outputDir = path.resolve('F:/janseeV2/storage');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'jansee_producthunt_launch_poster.png');

  console.log('正在使用 sharp 渲染大厂级黑曜石宣发海报...');
  await sharp(Buffer.from(svg))
    .png({ quality: 100 })
    .toFile(outputPath);

  console.log('海报生成成功:', outputPath);
}

renderPoster().catch(console.error);

