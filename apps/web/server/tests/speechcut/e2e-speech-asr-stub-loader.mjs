// E1 stub：模块加载器入口（--import 注册 resolve 钩子）
import { register } from 'node:module';
register('./e2e-speech-asr-stub.mjs', import.meta.url);
