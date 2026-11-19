import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgres://postgres:postgres@127.0.0.1:5435/jansee_v4',
});

async function addCredits() {
  const uid = '0e881690-338e-419c-909a-6a776f287742';
  await pool.query(`
    UPDATE wallets
    SET available_credits = available_credits + 10000,
        paid_available_credits = paid_available_credits + 10000,
        updated_at = NOW()
    WHERE user_id = $1
  `, [uid]);

  const res = await pool.query(`SELECT * FROM wallets WHERE user_id = $1`, [uid]);
  console.log('WALLET_STATUS:', JSON.stringify(res.rows[0], null, 2));
  await pool.end();
}

addCredits().catch(console.error);

