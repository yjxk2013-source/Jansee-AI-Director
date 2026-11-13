import test from 'node:test';
import assert from 'node:assert/strict';
import { SUBTITLE_PLAN, SUBTITLE_STYLE, buildSubtitleCardSvg } from '../subtitle.js';
/* 断句/时间轴/宽度工具在共享层，全平台唯一一份——测试也直接打共享层，不打引擎的转发。 */
import {
  layoutSubtitleTiming,
  measureText,
  splitSubtitleCards,
} from '@jansee/subtitle-kit/plan.js';
import { CANVAS, slotForRatio } from '../layouts.js';
import { FILM_DEFAULTS, buildFilmFilterGraph, planImageFilm } from '../imageFilm.js';

const img = () => ({ path: 'img_900x1200.png', width: 900, height: 1200 });
const shot = (dur, line, extra = {}) => ({
  imagePath: 'x.png', durationSec: dur, line, copy: { title: '测试标题' }, ...extra,
});
const planOf = (lines, durs = null) => planImageFilm({
  shots: lines.map((l, i) => shot(durs ? durs[i] : 3, l)),
  images: lines.map(() => img()),
  layoutId: 'layout_t1', pairingId: 'modern-editorial', seed: 7,
});

/* ============ 断句 ============ */

test('分屏：一屏最多两行，且一行读得完（不超 maxLineWidth）', () => {
  const long = '如果你也一直在找一款真正省心的咖啡器具，一定要看完这条，因为它真的和别的不一样。';
  const cards = splitSubtitleCards(long);
  assert.ok(cards.length >= 1);
  for (const c of cards) {
    assert.ok(c.lines.length <= SUBTITLE_PLAN.maxLines, `一屏 ${c.lines.length} 行，超过 ${SUBTITLE_PLAN.maxLines}`);
    for (const line of c.lines) {
      /* 行尾标点已被剥掉，所以宽度只会小于等于上限；标点溢出不会再被算进来 */
      assert.ok(measureText(line) <= SUBTITLE_PLAN.maxLineWidth, `「${line}」宽 ${measureText(line)} 超限`);
    }
  }
});

test('分屏：标点绝不单独成行（曾出现逗号独占一屏）', () => {
  const cases = [
    '如果你也一直在找一款真正省心的咖啡器具，一定要看完这条。',
    'Espresso 40ml，萃取时间 25 秒，风味干净利落不拖沓，适合清晨第一杯。',
  ];
  for (const t of cases) {
    for (const c of splitSubtitleCards(t)) {
      for (const line of c.lines) {
        assert.ok(!/^[，。；：、,.;:?!…]+$/.test(line), `「${line}」是纯标点行`);
      }
    }
  }
});

test('分屏：行末标点全剥（含语气符），口径跟共享包一致', () => {
  const [card] = splitSubtitleCards('限时特惠，点击下方立即体验！');
  assert.equal(card.lines.length, 1);
  /* 字幕不是文章：标点在画面上只占宽不传递信息，听的人本来就有语气。
     这条由共享包的 wrapCJK 定的口径，五条链路一致——V4 不许另立一套。 */
  assert.ok(!/[，。；：、？！]$/.test(card.lines[0]), `行末还有标点：${card.lines[0]}`);
  assertEqualsTail(card);
  /* text 保留原文标点，只用于按时长切分的字数权重 */
  assert.ok(card.text.length > 0);
});

function assertEqualsTail(card) {
  assert.equal(card.lines[0], '限时特惠，点击下方立即体验', '行中间逗号保留，只剥行末');
}

test('分屏：短句不拆屏，也不留半屏空行', () => {
  const cards = splitSubtitleCards('手冲，是一种慢下来的生活方式。');
  assert.equal(cards.length, 1, '一句话不该占两屏');
  assert.equal(cards[0].lines.length, 1);
});

test('分屏：空台词不产出字幕卡，不留空底衬', () => {
  assert.deepEqual(splitSubtitleCards(''), []);
  assert.deepEqual(splitSubtitleCards('   '), []);
  assert.deepEqual(splitSubtitleCards(null), []);
});

/* ============ 时间轴 ============ */

test('时间：按字数比例分配，总和严格等于窗口，首尾不留缝', () => {
  const cards = splitSubtitleCards('如果你也一直在找一款真正省心的咖啡器具，一定要看完这条，因为它真的和别的不一样。');
  const timed = layoutSubtitleTiming(cards, 1.2, 5.2);
  assert.equal(timed.length, cards.length);
  assert.equal(timed[0].startSec, 1.2);
  assert.equal(timed[timed.length - 1].endSec, 5.2);
  for (let i = 1; i < timed.length; i += 1) {
    assert.equal(timed[i].startSec, timed[i - 1].endSec, '相邻两屏必须无缝，否则中间会闪一下空白');
  }
  for (const t of timed) assert.ok(t.endSec > t.startSec);
});

test('时间：窗口为 0 或负数时不出字幕，不许生成零长度 overlay', () => {
  const cards = splitSubtitleCards('随便一句台词');
  assert.deepEqual(layoutSubtitleTiming(cards, 3, 3), []);
  assert.deepEqual(layoutSubtitleTiming(cards, 3, 2), []);
});

/* ============ 与版面层的窗口关系 ============ */

test('窗口：字幕在转场走完之后才出现，在镜末淡出前消失', () => {
  const plan = planOf(['第一镜的台词', '第二镜的台词', '第三镜的台词'], [3, 3, 3]);
  const xf = FILM_DEFAULTS.transitionSec;
  for (const card of plan.subtitleCards) {
    const seg = plan.timeline[card.shotIndex];
    const isLast = card.shotIndex === plan.timeline.length - 1;
    if (card.shotIndex > 0 && plan.timeline[card.shotIndex - 1].transition !== 'cut') {
      assert.ok(card.startSec >= seg.start + xf - 1e-6,
        `第 ${card.shotIndex + 1} 镜字幕起于 ${card.startSec}，转场还没走完（应 ≥ ${seg.start + xf}）`);
    }
    const limit = isLast
      ? seg.start + seg.durationSec - FILM_DEFAULTS.fadeBlackSec
      : seg.start + seg.durationSec - FILM_DEFAULTS.textOutSec;
    assert.ok(card.endSec <= limit + 1e-6,
      `第 ${card.shotIndex + 1} 镜字幕止于 ${card.endSec}，越过 ${limit}——会骑在镜边/淡黑上`);
  }
});

test('窗口：没有台词的镜不出字幕（纯音乐镜）', () => {
  const plan = planOf(['有台词', '', '也有台词']);
  assert.deepEqual(plan.subtitleCards.map((c) => c.shotIndex), [0, 2]);
});

test('窗口：极短镜也算得出正长度，不许出现 end <= start', () => {
  const plan = planOf(['短', '长一点的第二句台词'], [0.6, 3]);
  assert.ok(plan.subtitleCards.length > 0);
  for (const c of plan.subtitleCards) assert.ok(c.endSec > c.startSec, `${c.startSec} → ${c.endSec}`);
});

/* ============ 滤镜图接线（索引最容易错的地方） ============ */

test('滤镜图：字幕输入索引排在版面之后、CTA 之前，配音排在最后', () => {
  const plan = planOf(['第一镜的台词', '第二镜的台词']);
  const S = plan.subtitleCards.length;
  assert.ok(S > 0);
  const withCta = buildFilmFilterGraph({
    plan,
    images: [img(), img()],
    hasCta: true,
    audio: { voiceClips: [{ file: 'a0.mp3' }, { file: 'a1.mp3' }] },
  });
  /* 2 镜 → 版面 2,3；字幕 4..4+S-1；CTA = 4+S；配音从 5+S 起 */
  const N = 2;
  for (let k = 0; k < S; k += 1) {
    assert.ok(withCta.graph.includes(`[${2 * N + k}:v]format=rgba[sub${k}]`),
      `字幕 ${k} 应取输入 ${2 * N + k}`);
    assert.ok(withCta.graph.includes(`[sub${k}]overlay=0:0`), `字幕 ${k} 必须 overlay`);
  }
  const ctaIdx = 2 * N + S;
  assert.ok(withCta.graph.includes(`[${ctaIdx}:v]format=rgba,fade=t=in`), `CTA 应取输入 ${ctaIdx}`);
  assert.ok(withCta.graph.includes(`[${ctaIdx + 1}:a]aresample=48000,adelay=0|0`),
    `第一条配音应取输入 ${ctaIdx + 1}`);
  assert.ok(withCta.graph.includes(`[${ctaIdx + 2}:a]aresample=48000`),
    `第二条配音应取输入 ${ctaIdx + 2}`);
});

test('滤镜图：每条字幕带 enable 时间窗，且窗内唯一（同刻不许两条字幕）', () => {
  const plan = planOf(['第一镜的台词', '第二镜的台词'], [3, 3]);
  const { graph } = buildFilmFilterGraph({ plan, images: [img(), img()], hasCta: false, audio: null });
  for (const card of plan.subtitleCards) {
    const win = `enable='between(t,${card.startSec.toFixed(3)},${card.endSec.toFixed(3)})'`;
    assert.ok(graph.includes(win), `缺 ${win}`);
  }
  const sorted = [...plan.subtitleCards].sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i].startSec >= sorted[i - 1].endSec - 1e-6,
      `字幕 ${i - 1} 与 ${i} 时间窗重叠，同刻会叠两条`);
  }
});

test('滤镜图：字幕压在淡黑之前，会被一起淡掉——不许挂在淡黑之后留下亮字', () => {
  const plan = planOf(['第一镜的台词', '第二镜的台词']);
  const { graph } = buildFilmFilterGraph({ plan, images: [img(), img()], hasCta: false, audio: null });
  const lastSubLabel = graph.indexOf(`[vSub${plan.subtitleCards.length - 1}]`);
  /* :color=black 只属于 fadeblack；版面文字层是 :alpha=1，别拿它当锚点 */
  const fadeBlackAt = graph.indexOf(':color=black');
  assert.ok(lastSubLabel >= 0, '找不到最后一条字幕的输出标签');
  assert.ok(fadeBlackAt > lastSubLabel, '字幕必须在 fadeblack 的输入侧，否则片子黑了字还亮着');
});

test('滤镜图：无台词时不出任何字幕节点，不影响原有索引', () => {
  const plan = planOf(['', '']);
  assert.deepEqual(plan.subtitleCards, []);
  const { graph } = buildFilmFilterGraph({
    plan, images: [img(), img()], hasCta: true, audio: { voiceClips: [{ file: 'a.mp3' }, { file: 'a.mp3' }] },
  });
  assert.ok(!graph.includes(']sub'), '不该有 sub 节点');
  /* 没有字幕时 CTA 回到 2N，配音回到 2N+1（与字幕上线前完全一致） */
  assert.ok(graph.includes('[4:v]format=rgba,fade=t=in'), 'CTA 应取输入 4');
  assert.ok(graph.includes('[5:a]aresample=48000'), '配音应取输入 5');
});

/* ============ 版面几何 ============ */

test('底衬：锚定洞位底边内侧，A/B/C 三档都跟着走，不飘在画布黑边里', () => {
  for (const ratio of [0.75, 1, 1.4]) {
    const slot = slotForRatio(ratio);
    const svg = buildSubtitleCardSvg({ lines: ['测试字幕一行'], slot });
    const m = svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
    assert.ok(m, '缺底衬矩形');
    const [, x, y, w, h] = m.map(Number);
    const bottom = y + h;
    assert.equal(bottom.toFixed(1), (slot.bar + slot.h - SUBTITLE_STYLE.bottomInset).toFixed(1),
      `${slot.key} 档底衬底边应贴洞位底边内侧`);
    assert.ok(y > slot.bar, `${slot.key} 档底衬压到洞位顶边外了`);
    /* 居中 */
    assert.ok(Math.abs((x + w / 2) - CANVAS.width / 2) < 0.6, `${slot.key} 档底衬不居中`);
  }
});

test('底衬：两行比一行高得多，宽度取最长行', () => {
  const slot = slotForRatio(0.75);
  const one = buildSubtitleCardSvg({ lines: ['短句'], slot });
  const two = buildSubtitleCardSvg({ lines: ['短句', '第二行确实更长一些'], slot });
  const rect = (svg) => svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/).slice(1).map(Number);
  const [, , w1, h1] = rect(one);
  const [, , w2, h2] = rect(two);
  assert.ok(h2 > h1, `两行高 ${h2} 应大于一行高 ${h1}`);
  assert.ok(w2 > w1, '底衬宽度应按最长行算');
});

test('字体：字幕固定思源黑，不跟随正文配对（可读性优先于风格统一）', () => {
  const svg = buildSubtitleCardSvg({ lines: ['测试'], slot: slotForRatio(0.75) });
  assert.ok(svg.includes('Noto Sans SC'), '字幕必须用思源黑');
  assert.ok(!/PingFang|微软雅黑|msyh/i.test(svg), '不许残留系统字体');
  assert.ok(svg.includes('font-weight="400"'), '字幕不许用细体 300——44px 在手机上会发虚');
});
