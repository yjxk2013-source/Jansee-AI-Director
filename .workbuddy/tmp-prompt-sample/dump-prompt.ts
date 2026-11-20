// 本地组装最新导演提示词样例（不调用任何 LLM，纯本地拼装）
import { buildDirectorSystemPrompt, buildDirectorUserPrompt } from "../../apps/api/src/prompt-assembly.ts";
import { writeFileSync, mkdirSync } from "node:fs";

const samples = [
  {
    name: "01-带货视频-电商场景",
    input: {
      mode: "image-film" as const,
      prompt: "[User-selected creation scene: online-ecommerce.] 为这款明前头采春茶制作一支带货短片，明前嫩芽、高山云雾茶园、手工炒制，礼盒装送长辈",
      aspectRatio: "9:16" as const,
      assets: [
        { name: "茶园.jpg", kind: "image" as const, size: 1024 },
        { name: "干茶特写.jpg", kind: "image" as const, size: 1024 },
        { name: "茶汤冲泡.jpg", kind: "image" as const, size: 1024 },
        { name: "礼盒包装.jpg", kind: "image" as const, size: 1024 },
      ],
    },
  },
  {
    name: "02-门店获客-探店场景",
    input: {
      mode: "video-dub" as const,
      prompt: "[User-selected creation scene: physical-store.] 巷子里的老字号铜锅涮肉，开了二十多年，手切鲜羊肉，同城街坊聚餐必去，人均60吃到撑",
      aspectRatio: "9:16" as const,
      assets: [
        { name: "店门口.mp4", kind: "video" as const, size: 1024 },
        { name: "铜锅涮肉.mp4", kind: "video" as const, size: 1024 },
        { name: "手切羊肉.mp4", kind: "video" as const, size: 1024 },
      ],
    },
  },
];

mkdirSync("F:/Jansee-v4/.workbuddy/tmp-prompt-sample", { recursive: true });
for (const sample of samples) {
  const system = buildDirectorSystemPrompt(sample.input as never);
  const user = buildDirectorUserPrompt(sample.input as never);
  const out = `F:/Jansee-v4/.workbuddy/tmp-prompt-sample/${sample.name}.txt`;
  writeFileSync(out, `==================== SYSTEM PROMPT ====================\n${system}\n\n==================== USER PROMPT ====================\n${user}\n`, "utf8");
  console.log(`written: ${out}  (system ${system.length} chars / user ${user.length} chars)`);
}
