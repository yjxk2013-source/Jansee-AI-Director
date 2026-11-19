import pg from "pg";

const pool = new pg.Pool({ connectionString: "postgres://postgres:postgres@127.0.0.1:5435/jansee_v4" });
const LAST_KNOWN_ID = "17e86708-71d4-4792-a677-67f1c99c3602";

async function poll() {
  console.log("[MONITOR] 开始持续监听新任务生成 (按 Ctrl+C 退出)...");
  while (true) {
    try {
      const res = await pool.query(`
        SELECT id, status, mode, prompt, request_payload, created_at, updated_at
        FROM generation_jobs
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const row = res.rows[0];
      if (row && row.id !== LAST_KNOWN_ID) {
        console.log("\n================== [捕获到新任务] ==================");
        console.log("任务 ID:", row.id);
        console.log("状态:", row.status);
        console.log("用户 Prompt:", row.prompt);
        
        const plan = row.request_payload?.directorPlan;
        if (plan) {
          console.log("\n--- [LLM 导演创意核心案] ---");
          console.log("标题 (title):", plan.title);
          console.log("口播台词 (narration):", plan.narration);
          console.log("选定音色 (voice_id):", plan.voice_id);
          console.log("BGM 情感 (bgm_emotion):", plan.bgm_emotion);
          console.log("分镜数量 (scenes):", plan.scenes?.length);
          if (plan.scenes && plan.scenes.length > 0) {
            console.log("分镜 1 台词/描述:", plan.scenes[0].line || plan.scenes[0].description);
          }
          console.log("宣发文案 (caption):", plan.publish?.caption);
          console.log("封面标题 (cover_title):", plan.publish?.cover_title);
          console.log("\n--- [调度层遥测数据] ---");
          console.log("实际调用模型:", plan._telemetry?.selectedModel);
          console.log("是否触发兜底:", plan._telemetry?.fallbackUsed);
          console.log("消耗 Tokens:", plan._telemetry?.tokensUsed);
          console.log("LLM 耗时(ms):", plan._telemetry?.llmDurationMs);
        }
        
        if (row.status === "completed" || row.status === "failed") {
          console.log("\n任务处理结束，当前状态:", row.status);
          break;
        }
      }
    } catch (e) {
      console.error("查询异常:", e.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  await pool.end();
}

poll();
