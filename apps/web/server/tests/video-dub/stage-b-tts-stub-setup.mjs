// 简兮 · 阶段 B 测试专用 TTS 桩装载入口（零付费保障）
// 用法：node --import ./apps/web/server/tests/video-dub/stage-b-tts-stub-setup.mjs apps/web/server/index.mjs
import { register } from 'node:module';
register('./stage-b-tts-stub-loader.mjs', import.meta.url);
