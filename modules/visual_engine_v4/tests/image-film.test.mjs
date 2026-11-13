import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANVAS,
  LAYOUTS,
  buildLayoutSvg,
  imageBoxFor,
  resolvePairing,
  slotForRatio,
} from '../layouts.js';
import {
  ENDING_ASSETS,
  ENDING_SCENES,
  ENDING_TAIL,
  ENTRY_TO_SCENE,
  buildEndingSvg,
  endingCopyParts,
  endingsForScene,
  pickEnding,
} from '@jansee/ending-kit';
import {
  FILM_DEFAULTS,
  MOTIONS,
  TEXT_ANIMS,
  TRANSITIONS,
  buildFilmFilterGraph,
  mulberry32,
  planImageFilm,
} from '../imageFilm.js';

const img = (w, h) => ({ path: `img_${w}x${h}.png`, width: w, height: h });
const shot = (dur, extra = {}) => ({ imagePath: 'x.png', durationSec: dur, copy: { title: '测试标题' }, ...extra });

test('洞位：按第一张图比例定档，全片锁定不逐镜跳', () => {
  const plan = planImageFilm({
    shots: [shot(2), shot(2), shot(2)],
    images: [img(900, 1200), img(1000, 1000), img(1200, 900)],
    layoutId: 'layout_t1',
    pairingId: 'modern-editorial',
    seed: 7,
  });
  // 首图 3:4 → A 洞；后两张方图/横图不许改洞位
  assert.equal(plan.slot.key, 'A');
  assert.equal(plan.slot.h, 1440);
  assert.equal(plan.slot.bar, 240);
});

test('时长：按上游给的秒数累加，引擎不估算、不凑整', () => {
  const plan = planImageFilm({
    shots: [shot(3.2), shot(2.8), shot(3.4)],
    images: [img(900, 1200), img(900, 1200), img(900, 1200)],
    layoutId: 'layout_t1', pairingId: 'modern-editorial', seed: 1,
  });
  assert.equal(plan.totalSec.toFixed(3), '9.400');
  assert.equal(plan.timeline[0].start, 0);
  assert.equal(plan.timeline[1].start.toFixed(1), '3.2');
  assert.equal(plan.timeline[2].start.toFixed(1), '6.0');
  /* 浮点顺序不同：(9.4+0.6)+2.6 与 9.4+(0.6+2.6) 差 1e-15，直接 equal 会假失败。
     尾巴 = 淡黑 + 黑屏停顿 + 结尾卡，三段缺一不可。黑停与结尾卡时长口径在
     ending-kit（ENDING_TAIL），视频配音共用，不许在引擎侧另立数值。 */
  assert.equal(
    plan.videoSec.toFixed(6),
    (plan.totalSec + FILM_DEFAULTS.fadeBlackSec + ENDING_TAIL.endHoldSec + ENDING_TAIL.ctaSec).toFixed(6),
  );
  assert.ok(ENDING_TAIL.endHoldSec > 0, '黑透之后必须先空一拍，否则"然后出现"等于没有');
});

test('缺 durationSec 直接报错，不替它编时长', () => {
  assert.throws(
    () => planImageFilm({ shots: [{ imagePath: 'x.png' }], images: [img(900, 1200)], seed: 1 }),
    /durationSec/,
  );
});

test('图数与镜数不一致直接报错（N 图 = N 镜，不许少画一张）', () => {
  assert.throws(
    () => planImageFilm({ shots: [shot(2), shot(2)], images: [img(900, 1200)], seed: 1 }),
    /一一对应/,
  );
});

test('动效/运镜/转场各抽 2–3 种，且来自白名单', () => {
  const plan = planImageFilm({
    shots: Array.from({ length: 5 }, () => shot(2)),
    images: Array.from({ length: 5 }, () => img(900, 1200)),
    layoutId: 'layout_t1', pairingId: 'modern-editorial', seed: 42,
  });
  for (const k of plan.pools.textAnimKinds) assert.ok(TEXT_ANIMS.includes(k), k);
  for (const k of plan.pools.motionKinds) assert.ok(MOTIONS.includes(k), k);
  for (const k of plan.pools.transKinds) assert.ok(TRANSITIONS.includes(k), k);
  assert.ok(plan.pools.textAnimKinds.length >= 2 && plan.pools.textAnimKinds.length <= 3);
  assert.ok(plan.pools.motionKinds.length >= 2 && plan.pools.motionKinds.length <= 3);
  assert.ok(plan.pools.transKinds.length <= 3);
});

test('同 seed 同结果：用户改个错字重出一次，风格不许整片换掉', () => {
  const build = () => planImageFilm({
    shots: Array.from({ length: 4 }, () => shot(2.5)),
    images: Array.from({ length: 4 }, () => img(900, 1200)),
    seed: 20261023,
  });
  const a = build();
  const b = build();
  assert.equal(a.layout.id, b.layout.id);
  assert.equal(a.pairing, b.pairing);
  assert.deepEqual(a.pools, b.pools);
  assert.deepEqual(a.timeline.map((t) => t.motion), b.timeline.map((t) => t.motion));
});

test('配对不在版式白名单里时切默认，不静默乱配', () => {
  // T5 竖排只允许书法/小薇；给 modern-editorial（无衬线）必须被拦下
  const plan = planImageFilm({
    shots: [shot(2)], images: [img(900, 1200)],
    layoutId: 'layout_t5', pairingId: 'modern-editorial', seed: 1,
  });
  const t5 = LAYOUTS.find((l) => l.id === 'layout_t5');
  assert.equal(plan.pairing, t5.defaultPairing);
});

test('兼容矩阵自洽：每套版式的默认配对都在自己的白名单里', () => {
  for (const l of LAYOUTS) {
    assert.ok(l.allowed.includes(l.defaultPairing), `${l.id} 的默认配对不在 allowed 内`);
  }
  const total = LAYOUTS.reduce((n, l) => n + l.allowed.length, 0);
  assert.equal(total, 18, '兼容组合应为 18 组，不是 40 全排列');
});

test('未指定配对时按 seed 从版式白名单抽：随机路径 8 套全可达', () => {
  const reachable = new Set();
  for (let seed = 1; seed <= 400; seed += 1) {
    const plan = planImageFilm({
      shots: [shot(2)], images: [img(900, 1200)], seed,
      /* 版式固定 T3（白名单最宽之一），隔离版式抽取的干扰，单测配对抽取 */
      layoutId: 'layout_t3',
    });
    assert.ok(
      LAYOUTS.find((l) => l.id === 'layout_t3').allowed.includes(plan.pairing),
      `seed=${seed} 抽出了白名单外的配对 ${plan.pairing}`,
    );
    reachable.add(plan.pairing);
  }
  // T3 白名单 4 套必须全部被抽到——少了任何一套都说明抽取退化成了偏科
  assert.equal(reachable.size, 4, `随机路径只命中 ${reachable.size} 套：${[...reachable].join('、')}`);
});

test('图片落点：contain 不裁切，比例与像素都不许变', () => {
  const slotA = slotForRatio(0.75);
  const box = imageBoxFor(slotA, 900, 1200);
  assert.equal(box.width, 1080);
  assert.equal(box.height, 1440);
  assert.equal(box.x, 0);
  assert.equal(box.y, 240);

  // 9:16 极端竖图：贴高，左右留白由版面填
  const box916 = imageBoxFor(slotA, 1080, 1920);
  assert.equal(box916.height, 1440);
  assert.equal(box916.width, 810);
  assert.equal(box916.x, 135);

  // 4:3 横图在 A 洞里：贴宽，上下留白
  const box43 = imageBoxFor(slotA, 1200, 900);
  assert.equal(box43.width, 1080);
  assert.equal(box43.height, 810);
  assert.equal(box43.y, 240 + (1440 - 810) / 2);
});

test('滤镜图：图片层有随时间变化的运镜，文字层淡出落在镜边界之前', () => {
  const plan = planImageFilm({
    shots: [shot(3), shot(3)],
    images: [img(900, 1200), img(900, 1200)],
    layoutId: 'layout_t1', pairingId: 'modern-editorial', seed: 3,
  });
  const { graph } = buildFilmFilterGraphWithin(plan);
  // 每镜都得有 crop 的 x 或 y 表达式（纯静态运镜等于没运镜）
  assert.match(graph, /crop=1080:1440:x='[^']*t[^']*'/);
  // 文字层 fade out 必须比镜时长早收完（留一帧余量，防止末帧残影被 eof_action 冻结）
  const fadeOut = [...graph.matchAll(/fade=t=out:st=([\d.]+):d=([\d.]+):alpha=1/g)]
    .map((m) => Number(m[1]) + Number(m[2]));
  assert.ok(fadeOut.length >= 2);
  assert.ok(fadeOut[0] <= 3 - 1 / FILM_DEFAULTS.fps + 1e-6);
  // 结尾：先 fadeblack 到黑，空一拍，再补尾
  assert.match(graph, /fade=t=out:st=[\d.]+:d=0\.6:color=black/);
  assert.match(graph, new RegExp(`tpad=stop_mode=add:stop_duration=${plan.tailSec.toFixed(3)}`));
  /* 结尾卡要在黑透后再等 endHoldSec 才登场，不能跟淡黑叠在一起。
     这条必须带 CTA 建图才看得到，所以单独跑一次。 */
  const withCta = buildFilmFilterGraph({ plan, images: plan.timeline.map(() => img(900, 1200)), hasCta: true, audio: null });
  assert.match(
    withCta.graph,
    new RegExp(`tpad=start_duration=${(plan.totalSec + ENDING_TAIL.endHoldSec).toFixed(3)}:start_mode=add`),
  );
});

test('文字登场晚于转场结束：slide 时延后一整段，cut 时立即', () => {
  const force = (trans) => {
    const plan = planImageFilm({
      shots: [shot(3), shot(3)],
      images: [img(900, 1200), img(900, 1200)],
      layoutId: 'layout_t1', pairingId: 'modern-editorial', seed: 3,
    });
    plan.timeline[0].transition = trans;
    return buildFilmFilterGraphWithin(plan).graph;
  };

  /* 第二镜从 3.000 开始。slide_down 要 0.4s 走完，文字必须 3.4 才登场，
     否则整屏滑动期间文字骑在两图交界线上。 */
  const slideG = force('slide_down');
  assert.match(slideG, /tpad=start_duration=3\.400:start_mode=add/);
  /* 淡出必须在 3.000 的镜边界前整整收完（还要留一帧余量，见下一条测试） */
  const fadeEnds = [...slideG.matchAll(/fade=t=out:st=([\d.]+):d=([\d.]+):alpha=1/g)]
    .map((m) => Number(m[1]) + Number(m[2]));
  assert.ok(
    fadeEnds.some((v) => v <= 3 - 1 / FILM_DEFAULTS.fps + 1e-6),
    '淡出必须在镜边界前收完',
  );

  /* cut 是硬切，没有重叠区，文字不该跟着延后 */
  const cutG = force('cut');
  assert.match(cutG, /tpad=start_duration=3\.000:start_mode=add/);
});

test('文字淡出必须在素材结束前收完，否则末帧残影会被 eof_action 冻结', () => {
  /* 真跑出来的 bug：3.9s @30fps 的图层，淡出结束点压在 3.900，
     末帧落在 3.867，alpha 只走到 91%，overlay 的 eof_action=pass 把它冻结住，
     24.9s 全黑画面上还能看见右上角「/ 06」的鬼影。
     而且版面坐标全片固定，残影会跟下一镜的文字精确叠在同一位置。 */
  const plan = planImageFilm({
    shots: [shot(3.9)],
    images: [img(900, 1200)],
    layoutId: 'layout_t1', pairingId: 'modern-editorial', seed: 1,
  });
  const { graph } = buildFilmFilterGraphWithin(plan);
  const dur = 3.9;
  const ends = [...graph.matchAll(/fade=t=out:st=([\d.]+):d=([\d.]+):alpha=1/g)]
    .map((m) => ({ st: Number(m[1]), end: Number(m[1]) + Number(m[2]) }));
  assert.ok(ends.length > 0, '必须有文字淡出');
  for (const e of ends) {
    assert.ok(
      e.end <= dur - 1 / FILM_DEFAULTS.fps + 1e-6,
      `淡出结束 ${e.end.toFixed(3)} 必须早于素材结束 ${dur} 至少一帧，否则末帧残影`,
    );
  }
});

function buildFilmFilterGraphWithin(plan) {
  const images = plan.timeline.map(() => img(900, 1200));
  return buildFilmFilterGraph({ plan, images, hasCta: false, audio: null });
}

test('音轨：配音输入索引按 2N(+CTA) 起算，落点对齐镜边界', () => {
  const plan = planImageFilm({
    shots: [shot(3), shot(2.5)],
    images: [img(900, 1200), img(900, 1200)],
    layoutId: 'layout_t1', pairingId: 'modern-editorial', seed: 5,
  });
  const images = plan.timeline.map(() => img(900, 1200));
  // 无 CTA：图片 0,1 + 版面 2,3 → 配音从 4 开始
  const noCta = buildFilmFilterGraph({
    plan, images, hasCta: false,
    audio: { voiceClips: [{ file: 'v0.wav' }, { file: 'v1.wav' }] },
  });
  assert.ok(noCta.hasAudio);
  assert.match(noCta.graph, /\[4:a\]aresample=48000,adelay=0\|0/);
  assert.match(noCta.graph, /\[5:a\]aresample=48000,adelay=3000\|3000/);

  // 有 CTA：索引整体后移一位
  const withCta = buildFilmFilterGraph({
    plan, images, hasCta: true,
    audio: { voiceClips: [{ file: 'v0.wav' }] },
  });
  assert.match(withCta.graph, /\[5:a\]aresample/);
});

test('无配音时不出 outa，也不许给 -an 之外的空音轨', () => {
  const plan = planImageFilm({
    shots: [shot(2)], images: [img(900, 1200)],
    layoutId: 'layout_t1', pairingId: 'modern-editorial', seed: 1,
  });
  const { hasAudio, graph } = buildFilmFilterGraph({
    plan, images: [img(900, 1200)], hasCta: false, audio: null,
  });
  assert.equal(hasAudio, false);
  assert.ok(!graph.includes('[outa]'));
});

test('结尾卡只认 V4 的 15 款资产，不用正文版式、不用旧引擎骨架', () => {
  const sell = endingsForScene('sell');
  assert.equal(sell.length, 5, '电商场景必须是 5 款');
  assert.equal(ENDING_ASSETS.length, 15, '总计 15 款 = 3 场景 × 5 款');

  for (const item of ENDING_ASSETS) {
    const svg = buildEndingSvg(item);
    /* 真文案必须出现。早前那条只断言 text-anchor="middle"，参数名一改 zh 变空串、
       英文那行照样满足锚点，测试假通过——必须逐字核到文案本体。 */
    const { zh, en } = endingCopyParts(item);
    /* 中文里的「·」是分行符：竖柱与纯排版骨架会把「未 完 · 待 续」拆成两行，
       所以不能搜整串，要按拆行后的每一段核——这正是要守的行为。 */
    for (const line of zh.split(/\s*·\s*/).map((s) => s.trim()).filter(Boolean)) {
      assert.ok(svg.includes(line), `${item.id} 中文「${line}」必须渲染出来`);
    }
    /* 英文同理：竖柱骨架按词折行，整串会被拆开，只能按词核 */
    for (const word of en.split(/\s+/).filter(Boolean)) {
      assert.ok(svg.includes(word), `${item.id} 英文「${word}」必须渲染出来`);
    }
    /* 结尾卡固定 Noto Sans SC + Jost（V4 口径），不许落回系统字体栈：
       resvg 不加载系统字体，PingFang/Inter 会静默回退成默认字体，渲出来不是设计效果。 */
    assert.ok(svg.includes('Noto Sans SC'), `${item.id} 必须用 Noto Sans SC`);
    assert.ok(svg.includes('Jost'), `${item.id} 必须用 Jost`);
    assert.ok(!/PingFang|'Inter'/.test(svg), `${item.id} 不许残留系统字体栈`);
  }

  /* 四个骨架都要覆盖到——15 款只是「骨架 + 文案」的组合 */
  const skels = new Set(ENDING_ASSETS.map((e) => e.skelId));
  assert.deepEqual([...skels].sort(), ['ghost_box', 'horizontal_hairline', 'pure_typo', 'vertical_pillar']);

  // 不能出现正文版式的左上角大标题坐标
  const bodySvg = buildLayoutSvg({
    layout: 'layout_t1', slot: slotForRatio(0.75), pairing: resolvePairing('modern-editorial'), copy: { title: '测试' },
  });
  assert.ok(bodySvg.includes('x="66.0"'), '正文版式应左对齐 66');
});

test('结尾按场景抽：三个场景互不串味，同 seed 出同一款', () => {
  for (const scene of ENDING_SCENES) {
    for (let s = 1; s <= 12; s++) {
      const a = pickEnding(mulberry32(s), { scene });
      const b = pickEnding(mulberry32(s), { scene });
      assert.equal(a.id, b.id, `${scene} seed=${s} 必须可复现`);
      assert.equal(a.scene, scene, `${scene} 场景不许抽到别的场景的文案`);
    }
  }
  /* 入口映射：线上卖货 = sell，线下门店 = local，个人创作者 = personal */
  assert.equal(ENTRY_TO_SCENE.online, 'sell');
  assert.equal(ENTRY_TO_SCENE.offline, 'local');
  assert.equal(ENTRY_TO_SCENE.personal, 'personal');
  /* 指定 id 时直接命中，不再随机 */
  assert.equal(pickEnding(mulberry32(7), { scene: 'personal', endingId: 'cta_l1_pillar' }).id, 'cta_l1_pillar');
});

test('空文案不占位：缺 label 时小标与短线整组消失', () => {
  const pairing = resolvePairing('modern-editorial');
  const slot = slotForRatio(0.75);
  const withLabel = buildLayoutSvg({ layout: 'layout_t1', slot, pairing, copy: { title: '标题', label: 'ESPRESSO BAR' } });
  const noLabel = buildLayoutSvg({ layout: 'layout_t1', slot, pairing, copy: { title: '标题' } });
  assert.ok(withLabel.includes('ESPRESSO BAR'));
  assert.ok(!noLabel.includes('ESPRESSO BAR'));
  // 小标的短线是 44*k 宽（k=1 → 44），整组不画时这根线也不该在
  const countRects = (s) => (s.match(/<rect /g) || []).length;
  assert.equal(countRects(withLabel) - countRects(noLabel), 1, '少一个小标应少一根装饰线，不是只少文字');
});

test('音轨结尾必须平滑淡出至无声，严禁直接硬截断', () => {
  const plan = planImageFilm({
    shots: [shot(3), shot(2.5)],
    images: [img(900, 1200), img(900, 1200)],
    layoutId: 'layout_t1', pairingId: 'modern-editorial', seed: 5,
  });
  const images = plan.timeline.map(() => img(900, 1200));
  const res = buildFilmFilterGraph({
    plan, images, hasCta: true,
    audio: {
      voiceClips: [{ file: 'v0.wav' }, { file: 'v1.wav' }],
      bgm: { file: 'bgm.mp3', filterChain: '[bgm]volume=0.22[bgmout]' },
    },
  });
  assert.ok(res.hasAudio);
  // 必须包含 afade=t=out 平滑淡出至完全无声
  assert.match(res.graph, /afade=t=out:st=[\d.]+:d=[\d.]+(\[outa\])?/);
  // 必须以 [outa] 结尾供 ffmpeg 映射
  assert.ok(res.graph.includes('[outa]'));
});

