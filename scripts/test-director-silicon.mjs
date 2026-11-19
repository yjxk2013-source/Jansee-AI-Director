import { buildDirectorSystemPrompt, buildDirectorUserPrompt } from '../apps/api/src/prompt-assembly.js';

async function testSilicon() {
  const apiKey = process.env.DIRECTOR_API_KEY;
  if (!apiKey) throw new Error("DIRECTOR_API_KEY is required; do not hardcode provider credentials");
  const input = {
    mode: "image-film",
    prompt: "[User-selected creation scene: online-ecommerce. Treat this scene as authoritative; never reclassify it from keywords or filenames. If the request conflicts with the selected scene, ask for clarification.]\n真丝睡衣，只要29.9元，只有我直播间才有的价格",
    aspectRatio: "9:16",
    assets: [
      { name: "1.jpg", kind: "image", size: 1000 },
      { name: "2.jpg", kind: "image", size: 1000 },
      { name: "3.jpg", kind: "image", size: 1000 },
      { name: "4.jpg", kind: "image", size: 1000 }
    ]
  };

  const sys = buildDirectorSystemPrompt(input);
  const usr = buildDirectorUserPrompt(input);

  console.log("Sending prompt to GLM-5.3-Flash...");
  const t0 = Date.now();
  const res = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "zai-org/GLM-5.3-Flash",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: usr }
      ]
    })
  });
  console.log("Status:", res.status, "Duration:", Date.now() - t0, "ms");
  const data = await res.json();
  console.log("Response:", JSON.stringify(data, null, 2));
}

testSilicon().catch(console.error);

