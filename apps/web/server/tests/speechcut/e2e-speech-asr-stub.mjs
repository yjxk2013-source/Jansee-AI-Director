// E1 stub：resolve 钩子——把 modules/video_creator/asr/asr.js 重定向到本地桩实现
// 仅伪造 whisper 识别结果（runASR），keepOriginal/trim 的宽集填充词标记、detect/compose 全部真实执行
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (r && typeof r.url === 'string' && r.url.endsWith('/modules/video_creator/asr/asr.js')) {
    return { ...r, url: new URL('./e2e-stub-asr.mjs', import.meta.url).href, shortCircuit: true };
  }
  return r;
}
