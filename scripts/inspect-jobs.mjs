import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgres://postgres:postgres@127.0.0.1:5435/jansee_v4',
});

async function run() {
  const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  console.log('TABLES:', tables.rows.map(r => r.table_name));

  for (const t of tables.rows.map(r => r.table_name)) {
    if (t.includes('job') || t.includes('director') || t.includes('video') || t.includes('task')) {
      const rows = await pool.query(`SELECT * FROM ${t} ORDER BY created_at DESC LIMIT 2`);
      console.log(`DATA FOR ${t}:`, JSON.stringify(rows.rows, null, 2));
    }
  }

  await pool.end();
}

run().catch(console.error);

