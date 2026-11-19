import pg from "pg";

const pool = new pg.Pool({ connectionString: "postgres://postgres:postgres@127.0.0.1:5435/jansee_v4" });

export async function getLatestJob() {
  const res = await pool.query(`
    SELECT id, status, mode, prompt, request_payload, created_at, updated_at
    FROM generation_jobs
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return res.rows[0];
}

async function run() {
  const job = await getLatestJob();
  if (!job) {
    console.log("NO_JOBS_FOUND");
  } else {
    console.log("LATEST_JOB_ID:", job.id);
    console.log("STATUS:", job.status);
    console.log("PROMPT:", job.prompt);
    console.log("CREATED_AT:", job.created_at);
  }
  await pool.end();
}

run();
