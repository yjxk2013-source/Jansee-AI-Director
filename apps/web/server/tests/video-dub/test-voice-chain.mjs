// 简兮 · voice_gender 配音性别链路回归测试（2026-10-13 配音开发阶段 Task A）
// 测试性质：单元测试 + 集成桩测试（global.fetch 桩拦截 LLM 调用）。
// 隔离声明：全程不调用真实硅基流动 LLM、不调用真实腾讯 TTS（付费服务零调用）。
// 覆盖：
//   ① 供应商链与音色映射（单元级：tencent 单通道无 edge，云扬→101021 / 晓晓→101027 / 非法音色兜底 101027）
//   ② 导演 prompt 三态注入（单元级：male / female / 未指定）
//   ③ LLM 通道 sanitize 硬约束（集成桩：用户明确指定优先于 LLM 判定；未指定时采信 LLM；非法值回退默认）
//   ④ mocker 兜底剧本默认行为（单元级：未指定落默认女声，明确男声跟随男声）
// 运行：node scratch/test-voice-chain.mjs

import assert from 'node:assert/strict';

// —— 测试环境：伪造 LLM key（fetch 已被桩拦截，真实端点不会被触达）——
process.env.SILICONFLOW_API_KEY = 'test-voice-chain-stub-key';
delete process.env.JIANXI_MOCK;

const { generateDirectorCut, generateConstitutionScript, buildDirectorPrompt } = await import('../../director.mjs');
const { resolveTTSProvider, mapVoiceFor } = await import('@jansee/tts-kit/ttsProvider.js');

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.error(`  FAIL ${name}`); }
};

// —— LLM 桩：拦截 director.mjs 的 fetch，返回指定 mock 剧本 JSON ——
// 流式 SSE 形态（与 callDirectorLLM 的 resp.body.getReader 同口径）：
// 2026-10-18 director 改流式后，旧的 { json } 非流式桩会在「LLM 响应无可读流」处必崩
// （stage-b 同坑已修），本桩 2026-10-24 同步对齐。
let lastStubPrompt = '';
function stubLLM(cutOverride = {}) {
  const mockCut = {
    title: '测试商品',
    variant_type: '',
    emotion: '种草推荐',
    voice_gender: 'female',
    bgm_emotion: 'warm',
    bgm_on: true,
    sfx_on: true,
    opening: 'dive_in',
    ending: 'black_out',
    cover_line: '',
    visual_design: null,
    shots: [{ asset: 1, line: '测试台词一句', duration: 3.5, pause_after: 0.5, motion: 'push_in', transition: 'dissolve' }],
    ...cutOverride,
  };
  const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(mockCut) } }] })}\n\n`;
  const chunk = new TextEncoder().encode(payload);
  global.fetch = async (_url, opts) => {
    lastStubPrompt = String(opts?.body ? JSON.parse(opts.body).messages?.[0]?.content || '' : '');
    let sent = false;
    return {
      ok: true,
      body: {
        getReader() {
          return {
            read() {
              if (sent) return Promise.resolve({ done: true, value: undefined });
              sent = true;
              return Promise.resolve({ done: false, value: chunk });
            },
          };
        },
      },
    };
  };
}

// ==================== ① 供应商链与音色映射（单元级，零网络） ====================
console.log('\n[①] 供应商链与音色映射（单元级）');
{
  const { provider, all } = resolveTTSProvider();
  ok(provider.name === 'tencent', `主供应商 = tencent（实际 ${provider.name}）`);
  ok(all.length === 1, `供应商链仅 1 家（实际 ${all.length}：${all.map((p) => p.name).join(',')}）`);
  ok(!all.some((p) => p.name === 'edge'), '供应商链中无 edge（Edge TTS 已彻底移除）');
  ok(mapVoiceFor('tencent', 'zh-CN-YunyangNeural') === 101021, '男声语义音色 云扬 → 腾讯 101021');
  ok(mapVoiceFor('tencent', 'zh-CN-XiaoxiaoNeural') === 101027, '女声语义音色 晓晓 → 腾讯 101027');
  // 云希（第三音色）映射现状：显式映射键 'zh-cn-yunxiineural' 为双 i 死键（无对应真实音色名），
  // 实际经正则兜底落 101021 沉稳男。第三音色属冻结范围，本次仅断言现状不修复，已在报告中登记。
  ok(mapVoiceFor('tencent', 'zh-CN-YunxiNeural') === 101021, '男声音色 云希 → 腾讯 101021（映射入口冻结未接通，现状经兜底落沉稳男）');
  ok(mapVoiceFor('tencent', 'totally-invalid-voice') === 101027, '非法音色名 → 兜底 101027 温柔女声');
}

// ==================== ② 导演 prompt 三态注入（单元级） ====================
console.log('\n[②] 导演 prompt 配音性别三态注入（单元级）');
{
  const base = { scene: 'sell', title: '测试商品', sellingPoints: '好物卖点', imageCount: 1, decidedVariant: '' };
  const pMale = buildDirectorPrompt({ ...base, voice: 'male' });
  ok(pMale.includes('男声（必须跟随') && pMale.includes('不得改判'), 'voice=male → prompt 注入「男声必须跟随，不得改判」');
  const pFemale = buildDirectorPrompt({ ...base, voice: 'female' });
  ok(pFemale.includes('女声（必须跟随') && pFemale.includes('不得改判'), 'voice=female → prompt 注入「女声必须跟随，不得改判」');
  const pEmpty = buildDirectorPrompt({ ...base, voice: '' });
  ok(pEmpty.includes('未指定（判定规则见人设导演）'), "voice='' → prompt 注入「未指定，判定规则见人设导演」");
  const pDirty = buildDirectorPrompt({ ...base, voice: 'robot' });
  ok(pDirty.includes('未指定（判定规则见人设导演）'), "voice='robot' 非法值 → prompt 走未指定分支（不透传任意字符串）");
}

// ==================== ③ LLM 通道 sanitize 配音性别（集成桩：拦截 LLM） ====================
console.log('\n[③] LLM 通道 sanitize 配音性别硬约束（集成桩，零真实 LLM 调用）');
{
  // 3.1 用户明确男声 + LLM 违规输出 female → 程序纠正为 male（硬约束优先于 LLM）
  stubLLM({ voice_gender: 'female' });
  const c1 = await generateDirectorCut({ scene: 'sell', title: '测试商品', sellingPoints: '卖点', imageCount: 1, voice: 'male', decidedVariant: '' });
  ok(c1.voice_gender === 'male', `明确男声 + LLM 违规输出 female → male（实际 ${c1.voice_gender}）`);

  // 3.2 用户明确女声 + LLM 违规输出 male → 程序纠正为 female
  stubLLM({ voice_gender: 'male' });
  const c2 = await generateDirectorCut({ scene: 'sell', title: '测试商品', sellingPoints: '卖点', imageCount: 1, voice: 'female', decidedVariant: '' });
  ok(c2.voice_gender === 'female', `明确女声 + LLM 违规输出 male → female（实际 ${c2.voice_gender}）`);

  // 3.3 未指定 + LLM 判定 female → 采信 LLM
  stubLLM({ voice_gender: 'female' });
  const c3 = await generateDirectorCut({ scene: 'sell', title: '测试商品', sellingPoints: '卖点', imageCount: 1, voice: '', decidedVariant: '' });
  ok(c3.voice_gender === 'female', `未指定 + LLM 判定 female → female（实际 ${c3.voice_gender}）`);

  // 3.4 未指定 + LLM 判定 male → 采信 LLM
  stubLLM({ voice_gender: 'male' });
  const c4 = await generateDirectorCut({ scene: 'sell', title: '测试商品', sellingPoints: '卖点', imageCount: 1, voice: '', decidedVariant: '' });
  ok(c4.voice_gender === 'male', `未指定 + LLM 判定 male → male（实际 ${c4.voice_gender}）`);

  // 3.5 未指定 + LLM 输出非法值 → 回退默认 male
  stubLLM({ voice_gender: 'robot' });
  const c5 = await generateDirectorCut({ scene: 'sell', title: '测试商品', sellingPoints: '卖点', imageCount: 1, voice: '', decidedVariant: '' });
  ok(c5.voice_gender === 'male', `未指定 + LLM 非法输出 robot → 默认 male（实际 ${c5.voice_gender}）`);

  // 3.6 未指定 + LLM 缺失字段 → 回退默认 male
  stubLLM({ voice_gender: undefined });
  const c6 = await generateDirectorCut({ scene: 'sell', title: '测试商品', sellingPoints: '卖点', imageCount: 1, voice: '', decidedVariant: '' });
  ok(c6.voice_gender === 'male', `未指定 + LLM 缺失 voice_gender → 默认 male（实际 ${c6.voice_gender}）`);

  // 3.7 prompt 事实注入：未指定时用户文案（含声音要求）完整进入 prompt，供 LLM 识别硬约束
  stubLLM({ voice_gender: 'female' });
  await generateDirectorCut({ scene: 'sell', title: '测试商品', sellingPoints: '请用男声介绍这款商品', imageCount: 1, voice: '', decidedVariant: '' });
  ok(lastStubPrompt.includes('请用男声介绍这款商品'), '用户文案原文进入导演 prompt（文案中声音指令对 LLM 可见）');
  ok(lastStubPrompt.includes('未指定（判定规则见人设导演）'), '未指定态 prompt 注入正确');
  ok(lastStubPrompt.includes('m-calm: 沉稳男声'), 'prompt 注入腾讯精品音色池 Key 菜单');

  // 3.8 voice_id 白名单与性别冲突兜底
  stubLLM({ voice_gender: 'male', voice_id: 'm-deep' });
  const c7 = await generateDirectorCut({ scene: 'sell', title: '测试商品', sellingPoints: '卖点', imageCount: 1, voice: 'male', decidedVariant: '' });
  ok(c7.voice_id === 'm-deep', `合法男声音色 m-deep 保留（实际 ${c7.voice_id}）`);

  stubLLM({ voice_gender: 'male', voice_id: 'f-warm' });
  const c8 = await generateDirectorCut({ scene: 'sell', title: '测试商品', sellingPoints: '卖点', imageCount: 1, voice: 'male', decidedVariant: '' });
  ok(c8.voice_id === 'm-calm', `男声指定但 LLM 输出女声 f-warm → 自动兜底 m-calm（实际 ${c8.voice_id}）`);

  stubLLM({ voice_gender: 'female', voice_id: 'not-exist-voice' });
  const c9 = await generateDirectorCut({ scene: 'sell', title: '测试商品', sellingPoints: '卖点', imageCount: 1, voice: 'female', decidedVariant: '' });
  ok(c9.voice_id === 'f-warm', `非法音色 Key → 自动兜底 f-warm（实际 ${c9.voice_id}）`);
}

// ==================== ④ mocker 兜底剧本配音性别（单元级） ====================
console.log('\n[④] mocker 兜底剧本配音性别（单元级）');
{
  const m1 = generateConstitutionScript('sell', 'product', '测试商品', '卖点', 1, '');
  ok(m1.voice_gender === 'female', `未指定 → mocker 落默认女声（实际 ${m1.voice_gender}）`);
  const m2 = generateConstitutionScript('sell', 'product', '测试商品', '卖点', 1, 'male');
  ok(m2.voice_gender === 'male', `明确男声 → mocker 跟随男声（实际 ${m2.voice_gender}）`);
  const m3 = generateConstitutionScript('sell', 'product', '测试商品', '卖点', 1, 'robot');
  ok(m3.voice_gender === 'female', `非法值 → mocker 落默认女声（实际 ${m3.voice_gender}）`);
}

// ==================== 汇总 ====================
console.log(`\n========== 结果：${pass} PASS / ${fail} FAIL ==========`);
if (fail > 0) process.exit(1);
