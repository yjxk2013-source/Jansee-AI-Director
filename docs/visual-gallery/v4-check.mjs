import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as fontkitNS from 'fontkit';

const fontkit = fontkitNS.default || fontkitNS;

const page = readFileSync(new URL('./v4.html', import.meta.url), 'utf8');
const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
// 资产常量后面可能紧跟其它常量（版面排版等），按括号配平提取对象字面量，避免依赖后继常量名
function extractObjectLiteral(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf('{', markerIndex);
  if (start < 0) return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

const dataLiteral = script ? extractObjectLiteral(script, 'const V4_ASSETS=') : null;
const data = dataLiteral ? JSON.parse(dataLiteral) : null;

const EXPECTED = {
  /* dissolve 已删除（2026-10-23 实测否决）：文字窗口实测没问题，但相邻两镜是两张不同
     商品图，交叉 0.4s 等于双重曝光糊图——实验室不许再展示引擎跑不出合格画面的资产。 */
  transition: { count: 2, tag: '镜间转场', ids: ['cut', 'slide'] },
  motion: { count: 3, tag: '分镜运镜', ids: ['0_diagonal', '1_rise_up', '2_sweep'] },
  ending: { count: 15, tag: '结尾收束', ids: ['cta_p1_hairline', 'cta_p2_ghost', 'cta_p3_pillar', 'cta_p4_typo', 'cta_p5_hairline', 'cta_s1_ghost', 'cta_s2_hairline', 'cta_s3_typo', 'cta_s4_pillar', 'cta_s5_ghost', 'cta_l1_pillar', 'cta_l2_hairline', 'cta_l3_ghost', 'cta_l4_typo', 'cta_l5_hairline'] },
  font: { count: 8, tag: '字体字族', ids: ['ma-shan-zheng', 'zcool-kuaile', 'zcool-qingke-huangyou', 'zcool-xiaowei', 'jost', 'noto-sans-sc', 'noto-serif-sc', 'playfair-display'] },
  pairing: { count: 8, tag: '字体配对', ids: ['modern-editorial', 'classic-serif', 'swiss-grid', 'gallery-catalog', 'oriental-vertical', 'retro-signboard', 'literary-light', 'playful-round'] },
  text_anim: { count: 3, tag: '文字动效', ids: ['text_fade_up', 'text_fade_in', 'text_slide_in'] }
};

/* 实验室 → 引擎的执行映射。实验室是"给人看的图鉴"，引擎是"真出片的实现"，
   两边命名不同（slide 对上 slide_up、sweep 对上左右两个方向），所以显式列出来，
   再由下面的断言双向比对——实验室里出现的每一项都必须在引擎里跑得出来。 */
const EXEC_MAP = {
  transition: { cut: ['cut'], slide: ['slide_down'] },
  motion: { diagonal: ['diagonal'], rise_up: ['rise_up'], sweep: ['sweep_lr', 'sweep_rl'] },
  text_anim: { 'anim-text-fade-up': ['fade_up'], 'anim-text-fade-in': ['fade_in'], 'anim-text-slide-in': ['slide_in'] }
};

test('V4 页面脚本语法有效，且不耦合旧资产库或生产链路', () => {
  assert.ok(script, '应包含页面交互脚本');
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(data, 'V4 页面应内嵌独立资产数据');
  assert.match(page, /LOCAL ASSET PREVIEW/);
  assert.doesNotMatch(page, /ALL_ASSETS|FROZEN_CATEGORIES|frozenAssets|image_creator_v1|green-screen-product-preview|materials\/product-window-templates/);
  assert.doesNotMatch(page, /本地成片预览|video-panel|videoPreview|previewVideo|storage\/outputs/);
  assert.doesNotMatch(script, /fetch\s*\(|XMLHttpRequest|localStorage|sessionStorage/);
});

test('V4 清单数量、关键 ID、TAG 与资产字段完整', () => {
  for (const [category, expected] of Object.entries(EXPECTED)) {
    assert.equal(data[category].length, expected.count, `${category} 数量应为 ${expected.count}`);
    assert.ok(data[category].every(item => item.id && item.name && item.desc && item.tag), `${category} 每项都应具备 id/name/desc/tag`);
    for (const id of expected.ids) assert.ok(data[category].some(item => item.id === id), `${category} 缺少资产 ${id}`);
    assert.ok(data[category].every(item => item.tag === expected.tag), `${category} TAG 应统一为 ${expected.tag}`);
  }
  assert.ok(!('cover' in data), '封面开场分类已移除，资产数据不再包含 cover');
  assert.doesNotMatch(page, /封面开场/, '页面不再出现封面开场分类');
  assert.doesNotMatch(script, /category==='cover'/);
  assert.doesNotMatch(page, /toneFilters|冷色开场|暖色开场|中性开场/);
  assert.ok(data.motion.every(item => item.motion_type), '运镜项应具备演示类型');
  assert.ok(data.ending.every(item => item.kind === 'cta'), '结尾项仅保留 CTA 类型');
  assert.deepEqual(['personal', 'sell', 'local'].map(scene => data.ending.filter(item => item.scene === scene).length), [5, 5, 5], '个人、电商、实体 CTA 场景各保留 5 项');
  assert.ok(data.ending.every(item => item.copyId && item.skelId), 'CTA 结尾项应具备文案与骨架字段');
  assert.ok(data.ending.every(item => /「[^」]+」/.test(item.desc)), '每个 CTA 描述都应包含可展示文案');
  assert.ok(data.ending.every(item => /「[^」]+」/.test(item.desc)), '每个 CTA 描述都应包含可展示文案');
  assert.doesNotMatch(dataLiteral, /black_out|fade_out|zoom_far|brand_out/, 'V4 结尾清单不得包含四种基础 out 项');
  assert.match(script, /id:'ending',label:'结尾收束'/);
  assert.ok(data.font.every(item => item.family), '字体项应具备字体族声明');
  assert.ok(data.font.every(item => Array.isArray(item.weights) && item.weights.length), '字体项应具备真实字重清单');
  assert.ok(data.font.every(item => item.license && item.glyphs > 0), '字体项应具备授权与真实字形数');
  assert.match(script, /id:'text_anim',label:'文字动效'/);
  assert.ok(data.text_anim.every(item => item.anim_class && item.anim_class.startsWith('anim-text-')), '文字动效项应具备 anim_class 动画类名');
  assert.deepEqual([...data.text_anim.map(item => item.anim_class)].sort(), ['anim-text-fade-in', 'anim-text-fade-up', 'anim-text-slide-in'], '文字动效只保留引擎能执行的 3 款');
});

test('实验室每一项资产都能在引擎里执行（防止图鉴跑在实现前面）', async () => {
  const engine = await import('../../modules/visual_engine_v4/imageFilm.js');
  const enginePool = { transition: engine.TRANSITIONS, motion: engine.MOTIONS, text_anim: engine.TEXT_ANIMS };
  for (const [category, map] of Object.entries(EXEC_MAP)) {
    const shown = data[category].map(item => (category === 'text_anim' ? item.anim_class : item.motion_type || item.id));
    /* 正向：实验室展示的每一项，必须在映射里，且映射到的引擎值确实存在 */
    for (const key of shown) {
      assert.ok(map[key], `实验室资产 ${category}/${key} 没有执行映射，说明引擎跑不出来`);
      for (const target of map[key]) {
        assert.ok(enginePool[category].includes(target), `引擎 ${category} 缺少 ${target}（由实验室 ${key} 映射而来）`);
      }
    }
    /* 反向：引擎能跑的每一项，实验室都要能展示出来；否则用户选不到，也是误会 */
    const covered = new Set(shown.flatMap(key => map[key] || []));
    for (const value of enginePool[category]) {
      assert.ok(covered.has(value), `引擎能跑 ${category}/${value}，但实验室里没有对应资产可看`);
    }
  }
});

test('分类列表展示 TAG/ID，资产选择会作用于各类本地预览', () => {
  assert.match(script, /button\.className='asset-card'/);
  assert.match(script, /tag\.textContent=item\.tag/);
  assert.match(script, /id\.textContent=item\.id/);
  assert.match(script, /picked\[category\]=item;renderAssets\(\);applySelection\(item\)/);
  assert.match(page, /\.canvas\{[^}]*background:#000/, '预览画布默认黑色底板');
  assert.doesNotMatch(page, /08a546/, '不得残留绿幕底色');
  assert.match(script, /showImage\(activeIndex\+1\)/);
  assert.match(script, /motion_type/);
  assert.match(script, /canvas\.classList\.add\('ending-active'\)/);
  assert.match(script, /buildEndingCtaSvg\(item\)/, '结尾预览应渲染完整 CTA 骨架图层');
  for (const skel of ['ghost_box', 'vertical_pillar', 'pure_typo']) {
    assert.ok(script.includes(`skel==='${skel}'`), `${skel} 骨架应有独立渲染分支`);
  }
  assert.match(script, /horizontal_hairline/);
  assert.match(script, /endingZhLines\(/, '中心竖柱与无框微距中文应按 · 拆分为上下两层');
  assert.match(script, /wrapEndingWords\(en,maxLineW/, '幽灵微框英文应按框内可用宽度折行');
  assert.match(script, /<polygon points=/, '发丝双翼线应渲染菱形装饰核心');
  assert.match(page, /\.ending-copy svg\{display:block;width:100%;height:100%\}/);
  assert.match(script, /style\.fontFamily=item\.family/, '选中字体必须把真实字体族写到预览文本上');
  assert.match(page, /categoryNav/);
  assert.match(page, /assetSearch/);
  assert.doesNotMatch(page, /toneFilters|V4 资产状态/);
  assert.doesNotMatch(page, /id="backdropInput"/, '封面开场移除后不再有背景上传入口');
  assert.match(script, /let category='transition'/, '默认落在第一个分类：镜间转场');
  assert.match(script, /renderCatalog\(\);renderImages\(\)/);
  assert.doesNotMatch(script, /renderRatios/, '商品图比例示意图面板已移除，初始化不再渲染比例清单');
  assert.match(script, /category==='text_anim'/, '文字动效分类应具备本地预览分支');
  assert.match(script, /applyTextAnim\(/, '文字动效应通过统一助手应用到预览文本并强制回流重播');
  assert.match(script, /buildEndingCtaSvg\(endItem\)/, '文字动效预览应同步重建结尾 CTA 图层供画布文字呈现');
  for (const anim of ['anim-text-fade-up', 'anim-text-fade-in', 'anim-text-slide-in']) {
    assert.ok(page.includes('.' + anim), `页面应定义 ${anim} 动画样式`);
  }
  for (const kf of ['animTextFadeUp', 'animTextFadeIn', 'animTextSlideIn']) {
    assert.match(page, new RegExp('@keyframes ' + kf + '\\{'), `页面应定义 ${kf} 关键帧`);
  }
  /* micro_pop / quick_wipe 已删除：前者是说明行专用的弹性缩放（缩放=物理不能），
     后者要逐帧遮罩（成本高边缘易脏）。实验室与引擎两侧都不许再出现。 */
  assert.doesNotMatch(page, /anim-text-micro-pop|anim-text-quick-wipe/, '已否决的文字动效不得残留');
  assert.equal((page.match(/id="clearAll"/g) || []).length, 1, '清空图片按钮只保留一处');
  assert.ok(page.indexOf('id="dropzone"') > page.indexOf('id="canvas"'), '图片上传与轮播控件应置于预览画布区域（画布旁工具列）');
  assert.doesNotMatch(page, /stage-copy/, '预览文字应移入画布，不再使用框外文字块');
  assert.doesNotMatch(page, /window-frame|windowFrame|frame-copy|stageHeading|selectedName|rule-list|window-label/, '画布内的独立演示规则整块应已移除');
  assert.match(page, /id="fontStage"/, '字体与文字动效应保留纯文字演示层');
  assert.match(script, /function showFontStage\(\)/, '字体演示层应由统一助手控制显隐');
  assert.doesNotMatch(page, /id="ratioList"|id="ratioBox"|id="ratioFrame"/, '画布右侧的商品图比例示意图（清单与黑色示意框）应整体移除');
  assert.doesNotMatch(script, /PHOTO_RATIOS|applyRatio\(|clearRatio\(|syncRatioBox/, '比例示意相关数据与助手应整体移除，商品图按原图比例直接呈现');
  assert.match(page, /\.canvas-mask\{[^}]*left:var\(--img-x,7\.96296%\)[^}]*top:25%[^}]*width:var\(--img-w,83\.98148%\)[^}]*height:49%/, '镜间转场遮罩应限定在商品图窗口槽位，黑色底板保持不动');
  assert.match(page, /\.canvas\.ending-active::before\{[^}]*background:#000[^}]*animation:end-blackout/, '结尾收束应先全屏渐黑');
  assert.match(page, /\.canvas\.ending-active \.canvas-mask\{display:none\}/, '结尾收束时转场遮罩必须隐藏：否则黑场上每 2.5 秒闪一次色块');
  assert.match(script, /if\(category==='ending'\)\{pause\(\);window\.clearTimeout\(transitionTimer\);\$\('transitionMask'\)\.className='canvas-mask'/, '进入结尾收束应先停轮播并清空转场遮罩残留');
  assert.match(page, /@keyframes end-blackout\{/, '应定义全屏渐黑关键帧');
  assert.match(page, /\.canvas\.ending-active\[data-ending-kind="cta"\] \.ending-copy\{[^}]*animation:end-in \.55s ease \.55s both/, 'CTA 结尾图层应在全屏渐黑落定后再呈现');
  assert.doesNotMatch(script, /label:'4:3'|label:'3:4'|label:'1:1'/, '商品图比例选项数据应随示意图面板一并移除，不再让用户手选比例');
  assert.match(script, /CANVAS_W=1080,CANVAS_H=1920,PRODUCT_FIT_W=1080,PRODUCT_FIT_H=1920/, '应固化画布 1080 × 1920（平台默认）与商品图适配框 1080 × 1920（平台默认竖屏）');
  assert.match(script, /function fitProductBox\(w,h/, '商品图应按原图真实比例等比装入适配框，不再统一宽度');
  assert.match(script, /Math\.min\(PRODUCT_FIT_W\/w,/, '适配计算应取宽高两方向缩放的较小值（contain，不裁切不变形）');
  assert.doesNotMatch(script, /PRODUCT_IMG_W|PRODUCT_IMG_X/, '商品图定宽 907 与固定左边距应彻底移除');
  assert.doesNotMatch(script, /RATIO_SLOT_H/, '比例示意框应解除 49% 槽位高度约束，与固化管线 buildFixedImageFilterGraph 一致');
  assert.match(script, /applyImageGeometry\(layers\[target\],current\)/, '每张商品图加载前应按自身尺寸写入画布几何');
  assert.match(page, /\.product-image\{[^}]*object-fit:contain/, '商品图必须 contain 显示：不裁切、不变形');
  assert.doesNotMatch(page, /\.product-image\{[^}]*width:var\(--img-w/, '商品图宽度不得再被固定变量锁死（按原图比例逐张计算）');
  assert.match(script, /function sizeMaskToLayer\(/, '转场遮罩应随商品图实际渲染框适配（超高图不再只有槽位中段闪烁）');
  assert.match(script, /sizeMaskToLayer\(layers\[toLayer\]\)/, '转场前应按目标图层渲染框校准遮罩');
  assert.match(script, /function hideFontStage\(\)\{\$\('fontStage'\)\.hidden=true;if\(!images\.length\)\$\('canvasHint'\)\.hidden=false\}/, '退出字体演示时应隐藏文字层并恢复画布操作提示');
  assert.match(page, /--img-x,7\.96296%/, '窗口演示框与转场遮罩左边距沿用 907px 居中口径（86px / 7.96296%）');
  assert.match(page, /--img-w,83\.98148%/, '窗口演示框与转场遮罩宽度沿用 907px 居中口径（83.98148%）');
  assert.match(page, /\.product-image\{[^}]*top:50%[^}]*transform:translateY\(-50%\)/, '商品图应垂直居中叠加');
  assert.doesNotMatch(page, /907PX · X86 · CENTERED/, '旧定宽 907 标注应移除');
});

test('商品图片预检成功后保留对象 URL 供预览和轮播使用', () => {
  assert.ok(script.includes('images.push({url,name:file.name,width,height});loaded++;'));
  assert.ok(script.includes('probe.onerror=()=>{URL.revokeObjectURL(url)'));
  assert.ok(script.includes('images.forEach(image=>URL.revokeObjectURL(image.url))'));
});

test('商品图片只用对象 URL，并在清空与退出时回收', () => {
  assert.match(script, /URL\.createObjectURL\(file\)/);
  assert.match(script, /images\.forEach\(image=>URL\.revokeObjectURL\(image\.url\)\)/);
  assert.match(script, /addEventListener\('pagehide',[\s\S]*?images\.forEach\(image=>URL\.revokeObjectURL\(image\.url\)\)/, '页面退出时应回收全部商品图对象 URL');
  assert.doesNotMatch(page, /绿幕|clearBackdrop|backdropInput/, '绿幕底板与背景上传入口已整体移除');
  assert.match(page, /不上传、不持久保存/);
  assert.match(script, /MAX_IMAGES=9/);
});

test('画布不再包含背景视频元素，媒体引用仅限本地上传对象 URL', () => {
  assert.doesNotMatch(page, /本地成片预览|video-panel|videoPreview|previewVideo/);
  assert.doesNotMatch(page, /storage\/outputs|\.mp4|\.png|\.jpg|\.jpeg|\.webp|\.mp3|\.wav/);
  assert.equal((page.match(/<video/g) || []).length, 0, '封面开场移除后画布不再有背景视频元素');
  assert.doesNotMatch(script, /backdropVideo|backdropKind|backdropUrl/, '背景视频与背景图状态应彻底移除');
  assert.equal((page.match(/<img/g) || []).length, 2, '页面仅保留两个轮播图层 img，无外部图片引用');
});

test('版面排版：五套模板按洞位自动适配，图层叠在商品图之上且不侵入洞位', () => {
  assert.match(script, /V4_ASSETS\.layout=V4_LAYOUTS/, '版面清单应挂入资产表供列表渲染');
  assert.match(script, /id:'layout',label:'版面排版'/, '版面分类应在分类表内（计数由资产表长度派生，不再写死）');
  assert.equal((script.match(/id:'layout_t\d'/g) || []).length, 5, '应恰好内置五套版面');
  assert.ok(['T1', 'T2', 'T3', 'T4', 'T5'].every((key) => script.includes(`key:'${key}'`)), '五套版面的代号应齐全');

  // 洞位：竖图 1440 / 方图 1080 / 横图 810，条带 =（1920 − 洞高）/ 2
  assert.match(script, /SLOT_DEF=\{A:\{h:1440,name:'竖图洞'\},B:\{h:1080,name:'方图洞'\},C:\{h:810,name:'横图洞'\}\}/);
  assert.match(script, /function slotKeyFor\(ratio\)\{return ratio<=0\.82\?'A':ratio<=1\.22\?'B':'C'\}/, '洞位由图片比例自动选择，用户不选');
  assert.match(script, /bar:\(1920-h\)\/2/, '条带高由洞高反推');

  // 图层与层级：透明 SVG 叠在商品图之上、比例示意框之下
  assert.match(page, /id="layoutStage"/);
  assert.match(page, /\.layout-stage\{[^}]*z-index:4[^}]*\}/, '版面层须在商品图之上（图片默认 z-index:auto）');
  assert.match(script, /function buildLayoutSvg\(key,slot,F\)/, '版式渲染必须接收配对派生的字体角色');
  assert.match(script, /viewBox="0 0 1080 1920"/, '版面层按 1080×1920 逻辑坐标绘制，随画布等比缩放');

  // 选中版面后商品图必须装入洞位，否则画面上看到的条带高度与成片不一致
  assert.match(script, /function currentSlot\(image\)\{return picked\.layout\?slotInfoForImage\(image\):null\}/);
  assert.match(script, /fitProductBox\(image&&image\.width,image&&image\.height,slot\?slot\.h:null\)/, '选中版面时商品图按洞位 contain');
  assert.match(script, /function refreshImageGeometry\(\)/, '切换版面或洞位后需重算图片几何');

  // 再次点击同一项应取消，便于与"无版面"直接对比
  assert.match(script, /category==='layout'&&picked\.layout&&picked\.layout\.id===item\.id\)\{picked\.layout=null/, '再次点击同一版面应取消并恢复整幅布局');
  assert.match(script, /layoutMeta/, '画布元信息应显示当前洞位与条带高度');

  // 示例图内嵌为 data URL：不发请求、不上传，只用于打开页面即可搭配查看
  assert.match(script, /const SAMPLE_IMAGES=\[\{"url":"data:image\/jpeg;base64,/, '示例图应内嵌，避免打开页面还要先找图');
  assert.match(page, /id="loadSamples"/);
  assert.doesNotMatch(script, /SAMPLE_IMAGES[\s\S]{0,80}https?:\/\//, '示例图不得引用远程地址');
});

/* ============ 真实资产对齐 ============
   这一组测试的存在意义：V4 是实验室，很容易自己长出一套"看着像"的假资产（假字体族名、
   假配对），然后在浏览器里静默回退到系统字体也看不出来。所以每一项都必须反查
   materials/fonts/index.json 与磁盘上的真实文件，对不上就红。 */
test('字体、配对、字重文件必须与 materials/fonts/index.json 及磁盘实物一致', () => {
  const reg = JSON.parse(readFileSync(new URL('../../materials/fonts/index.json', import.meta.url), 'utf8'));

  // 1) 清单逐项对齐：不能多（页面自造）、不能少（入库了却没进实验室）
  assert.deepEqual([...data.font.map((f) => f.id)].sort(), [...reg.fonts.map((f) => f.id)].sort(), 'V4 字体清单应与注册表逐项一致');
  assert.deepEqual([...data.pairing.map((p) => p.id)].sort(), [...reg.pairings.map((p) => p.id)].sort(), 'V4 配对清单应与注册表逐项一致');

  // 2) 13 面字体必须内嵌成 data URL，家族与字重逐面对应注册表
  const faces = [...page.matchAll(/@font-face\{font-family:'([^']+)';font-weight:(\d+);[^}]*src:url\('data:font\/woff2;base64,([A-Za-z0-9+/=]+)'\)/g)]
    .map((m) => ({ family: m[1], weight: Number(m[2]), b64: m[3] }));
  const registeredFaces = reg.fonts.reduce((sum, f) => sum + f.files.filter((x) => typeof x === 'object').length, 0);
  assert.equal(faces.length, registeredFaces, `应内嵌 ${registeredFaces} 面字体（8 款字体的全部字重文件）`);
  for (const face of faces) {
    const owner = reg.fonts.find((f) => f.family === face.family);
    assert.ok(owner, `@font-face 家族「${face.family}」不在注册表里`);
    assert.ok(
      owner.files.filter((x) => typeof x === 'object').some((x) => x.weight === face.weight),
      `${face.family} 未登记 ${face.weight} 字重`,
    );
    assert.ok(face.b64.length > 2000, `${face.family} ${face.weight} 的内嵌数据过小，可能是空占位`);
  }
  assert.match(page, /V4FONTS:BEGIN 由 scripts\/build-v4-fonts\.mjs 生成/, '内嵌块应带生成标记，避免被手改后与构建脚本失联');

  // 2a) 原始 OFL 文件必须还在磁盘上：内嵌的是子集，生产用的是原文件，两者都不能缺
  for (const font of reg.fonts) {
    for (const file of font.files.filter((x) => typeof x === 'object')) {
      const rel = `../../materials/fonts/${font.id}/${file.file}`;
      assert.ok(existsSync(new URL(rel, import.meta.url)), `原始字体文件缺失：materials/fonts/${font.id}/${file.file}`);
    }
  }

  // 2b) 子集覆盖：页面出现的每个中文字，内嵌字体里都必须有字形。
  // 漏字的根因永远是"改了文案没重跑构建"，这条断言就是为它准备的。
  const cjk = new Set([...page].filter((ch) => ch.codePointAt(0) >= 0x2e80));
  const cjkFamilies = new Set(reg.fonts.filter((f) => f.audit.level === 'cn-full').map((f) => f.family));
  let checkedFaces = 0;
  for (const face of faces) {
    if (!cjkFamilies.has(face.family)) continue;
    const font = fontkit.create(Buffer.from(face.b64, 'base64'));
    const missing = [...cjk].filter((ch) => !font.hasGlyphForCodePoint(ch.codePointAt(0)));
    assert.deepEqual(missing, [], `${face.family} ${face.weight} 子集缺少字形：${missing.slice(0, 20).join('')}（改过文案？重跑 node scripts/build-v4-fonts.mjs）`);
    checkedFaces += 1;
  }
  assert.ok(checkedFaces >= 9, `应至少校验 9 面中文字体，实际 ${checkedFaces}`);

  // 3) 被禁的系统字体不得出现在任何 font-family 声明里（注释里记录替换关系是允许的）
  for (const name of ['DengXian', 'FangSong', 'STFangsong', 'KaiTi', 'STKaiti', 'SimSun', 'Bodoni', 'Futura', 'PingFang', 'Microsoft YaHei']) {
    assert.doesNotMatch(page, new RegExp(`font-family:[^;"'\`}]*['"]?${name}`, 'i'), `${name} 不得出现在 font-family 声明里`);
  }

  // 4) 版式字体已改由配对注入，不再允许 LY_F 那种写死字体栈
  const families = new Set(reg.fonts.map((f) => f.family));
  assert.doesNotMatch(script, /const LY_F=/, '版式字体不能再由 LY_F 写死——那样 8 套配对里有一半在版式上没有入口');
  const fallback = script.match(/const LY_FALLBACK=\{[\s\S]*?\};/)?.[0] || '';
  const fallbackNames = [...fallback.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((n) => n !== 'serif' && n !== 'sans-serif');
  assert.ok(fallbackNames.length >= 2, 'LY_FALLBACK 应声明 display / latin / micro 三个工位的回退');
  for (const name of fallbackNames) assert.ok(families.has(name), `LY_FALLBACK 引用了注册表外的字体：${name}`);
  const bodySource = script.slice(script.indexOf('function buildLayoutBody'), script.indexOf('function buildLayoutSvg'));
  assert.ok(bodySource.length > 500, '应能截取到版式主体函数');
  assert.doesNotMatch(bodySource, /font:\s*'/, '版式主体内的 font 必须来自配对（F.display / F.latin / F.micro），不能写字体字符串');

  // 4b) 版面卡上的描述也不能再引用已禁字体：字换了、文案还写着"Bodoni 小标"，等于对外撒谎
  const layoutDescs = [...script.matchAll(/id:'layout_t\d'[^}]*desc:'([^']*)'/g)].map((m) => m[1]);
  assert.equal(layoutDescs.length, 5, '五套版面应各有描述');
  for (const desc of layoutDescs) {
    assert.doesNotMatch(desc, /Bodoni|等线|仿宋|楷体|Futura|DengXian/, `版面描述仍在引用已禁用的系统字体：${desc}`);
  }

  // 5) 配对的三个工位必须都存在，且中文工位不得用仅拉丁字体（会用方框代替中文）
  for (const p of data.pairing) {
    for (const id of [p.display, p.latin, p.micro]) {
      assert.ok(data.font.some((f) => f.id === id), `配对 ${p.id} 引用了不存在的字体 ${id}`);
    }
    for (const id of [p.display, p.micro]) {
      assert.ok(!data.font.find((x) => x.id === id).latinOnly, `配对 ${p.id} 的中文工位用了仅拉丁字体 ${id}`);
    }
    assert.ok(p.fit.length && p.mood, `配对 ${p.id} 应具备行业标签与性格描述`);
  }

  // 6) 抽取算法与 scripts/font-pick.mjs 同源：seed 派生，不允许真随机混进来
  assert.doesNotMatch(script, /Math\.random\s*\(/, '抽取必须走 seed 派生的伪随机，真随机会让同一订单重出换风格');
  assert.match(script, /function hashSeed\(str\)\{let h=2166136261/, 'seed 散列应与 font-pick.mjs 同为 FNV-1a');
  assert.match(script, /0x6d2b79f5/, '伪随机应与 font-pick.mjs 同为 mulberry32');
  assert.match(script, /function drawPairing\(seed\)/, '应提供按 seed 抽配对的入口');
  assert.match(script, /function loadFace\(css,weight\)/, '字体必须真实加载一次并回报成败，不能静默回退');

  // 7) 分类计数必须派生自资产表长度，不能写死（写死必然与资产表脱钩）
  assert.match(script, /const categoryCount=id=>\(V4_ASSETS\[id\]\|\|\[\]\)\.length/, '分类计数应取资产表实际长度');
  assert.doesNotMatch(script, /CATEGORY_INFO=\[\{[^\]]*count:\d+/, 'CATEGORY_INFO 不得再写死 count');
});

test('版面排版 × 字体配对：兼容矩阵完整，换字只换得出配对内的字体', () => {
  const start = script.indexOf('const V4_ASSETS=');
  const endMark = 'V4_ASSETS.layout=V4_LAYOUTS;';
  const end = script.indexOf(endMark) + endMark.length;
  assert.ok(start > 0 && end > endMark.length, '应能定位资产表与版式常量');

  const context = vm.createContext({ console: { log() {}, warn() {} } });
  vm.runInContext(`${script.slice(start, end)}\n;globalThis.__v4={V4_ASSETS,lyFontSet,buildLayoutBody};`, context, { timeout: 5000 });
  const { V4_ASSETS, lyFontSet, buildLayoutBody } = context.__v4;

  const pairIds = new Set(V4_ASSETS.pairing.map((p) => p.id));
  const layouts = V4_ASSETS.layout;
  assert.equal(layouts.length, 5, '应有五套版式');

  // 1) 矩阵自身自洽：默认配对在允许列表里，允许的 id 真实存在，且没有重复
  const covered = new Set();
  for (const layout of layouts) {
    assert.ok(Array.isArray(layout.allowed) && layout.allowed.length >= 2, `${layout.name} 至少要撑得住两套字`);
    assert.ok(layout.allowed.includes(layout.defaultPairing), `${layout.name} 的默认配对不在自己的允许列表里`);
    assert.equal(new Set(layout.allowed).size, layout.allowed.length, `${layout.name} 允许列表有重复项`);
    for (const id of layout.allowed) {
      assert.ok(pairIds.has(id), `${layout.name} 引用了不存在的配对：${id}`);
      covered.add(id);
    }
  }
  // 2) 每套配对都要有去处——这正是这次拆分的动机：站酷三款曾经入库后一个版式都用不上
  for (const pair of V4_ASSETS.pairing) {
    assert.ok(covered.has(pair.id), `配对「${pair.name}」没有任何版式承载，等于白入库`);
  }

  // 3) 每个组合渲染出的字体必须全部来自该配对，且不得出现禁用系统字体
  const banned = /DengXian|FangSong|KaiTi|Bodoni|Futura|SimSun|PingFang|Microsoft YaHei/i;
  const slots = [{ key: 'A', h: 1440, bar: 240 }, { key: 'B', h: 1080, bar: 420 }, { key: 'C', h: 810, bar: 555 }];
  let combos = 0;
  for (const layout of layouts) {
    for (const id of layout.allowed) {
      const F = lyFontSet(id);
      assert.ok(F.ink > 0 && F.ink <= 1.1, `配对 ${id} 的墨迹系数异常：${F.ink}`);
      for (const slot of slots) {
        combos += 1;
        const svg = buildLayoutBody(layout.key, slot, F);
        const used = new Set([...svg.matchAll(/font-family="([^"]+)"/g)].map((m) => m[1]));
        assert.ok(used.size > 0, `${layout.key}/${slot.key} 没有渲染出任何文字`);
        for (const family of used) {
          assert.ok([F.display, F.latin, F.micro].includes(family), `${layout.key} × ${id} 用了配对外的字体：${family}`);
          assert.doesNotMatch(family, banned, `${layout.key} × ${id} 出现禁用系统字体：${family}`);
        }
      }
    }
  }
  const expected = layouts.reduce((sum, l) => sum + l.allowed.length, 0) * slots.length;
  assert.equal(combos, expected, `应渲染 ${expected} 个组合`);

  // 4) 拉丁字重不能硬写 500：Playfair 只有 400/700，写 500 会让浏览器合成假字重
  const playfair = lyFontSet('gallery-catalog');
  assert.equal(playfair.latinWeight, 400, 'Playfair 没有 500 字重，应退回 400');
  const jost = lyFontSet('swiss-grid');
  assert.equal(jost.latinWeight, 500, 'Jost 有 500，宽字距小标应取 500');
});

test('版面排版与字体配对在界面上真正接通，不是两套并行预览', () => {
  assert.match(page, /id="pairSwitch"/, '画布下方应有配对切换器');
  assert.match(script, /function renderPairSwitch\(layout,pair\)/, '应提供配对切换渲染');
  assert.match(script, /pair-chip/, '切换器应渲染可点的配对芯片');
  assert.match(script, /ensurePairingForLayout\(item\)/, '选中版式时若当前配对排不出来，必须切到该版式的默认配对');
  assert.match(script, /lyFontSet\(pair\.id\)/, '版式渲染必须按当前配对取字体');
  // 配对类目在选中版式后只列 allowed，避免产出排不出来的组合
  assert.match(script, /category==='pairing'&&picked\.layout&&picked\.layout\.allowed/, '字体配对类目应受当前版式的兼容列表约束');
  // 已有版式时，选配对要直接换到版式上，而不是另开字体预览层
  assert.match(script, /category==='pairing'\)\{if\(picked\.layout\)\{renderLayoutStage\(\)\}/, '选配对应即时作用到当前版式');
});

