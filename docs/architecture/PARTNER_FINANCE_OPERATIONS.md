# JANSEE V4 Partner Finance Operations

## Scope

This runbook covers city-partner commissions, payout-account verification, withdrawal review, manual payout recording, and the production release gates.

## Business rules

- Daily check-in: 100 credits, one claim per user-local calendar day.
- Referral reward: 200 credits after an invited user completes first login; one reward per invitee.
- City partner eligibility: five direct invited registrations, followed by city selection and exclusive city assignment.
- Commission: level one 15%, level two 5%, on eligible paid membership orders; add-on packs are excluded by the billing rules.
- Commission settlement: seven days after the source order's successful paid_at timestamp.
- Withdrawal: CNY 100–5,000 per request, increments of CNY 10.
- Fee: 1% of requested withdrawal, minimum CNY 2. The net payout is amount minus fee.
- Payout channel currently supported: Alipay account, manually transferred by an administrator.

## Security controls

- Payout account name and account are encrypted with AES-256-GCM before database storage.
- Production requires a persistent 32-byte key encoded as 64 hexadecimal characters in PARTNER_PAYOUT_ENCRYPTION_KEY.
- Generate the key once with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
- Store it in the production secret manager, back it up offline, and keep the same key across deployments. Losing or rotating the key without re-encrypting existing records makes payout details unreadable.
- User write endpoints require an authenticated session and same-origin request; payout-profile and withdrawal writes are rate limited.
- Withdrawal creation locks the user row, checks the idempotency key, verifies approved payout details, and reserves the amount in a transaction.
- Payout details are revealed to allowlisted administrators only; each reveal is audited.
- Partner audit events are append-only at the database layer.
- Paid external references are unique to prevent recording one transfer reference against multiple withdrawals.

## Administrator payout procedure

1. Open the admin console's Partner Finance tab.
2. Review a pending payout profile. Reveal the full account details only when needed, verify the payee identity and account, then approve or reject with a reason.
3. Review a pending withdrawal and confirm the requested amount, fee, net amount, masked account and payee.
4. Approve the withdrawal. This reserves the gross requested amount from the partner's withdrawable balance.
5. Use the company's authorized Alipay account to transfer the exact net amount to the snapshotted recipient account.
6. After confirming actual receipt, record the Alipay transfer reference in the console and mark the withdrawal paid.
7. If the transfer definitively failed, record the failure reason. The reservation is released back to the partner's withdrawable balance.
8. Never mark a withdrawal paid before confirming the recipient received the funds.

The current workflow records manual transfers; it does not initiate automatic bank or Alipay transfers.

## Release checklist

- Configure DATABASE_URL and DATABASE_SSL=true for production PostgreSQL.
- Back up the database before applying migrations 0007 and 0008.
- Configure and securely preserve PARTNER_PAYOUT_ENCRYPTION_KEY before accepting payout profiles.
- Configure the allowlisted ADMIN_EMAILS.
- Configure `OPCPAY_API_KEY` from the existing JANSEE 一人付 project. Startup checks the provider capabilities and enabled product/SKUs before marking payment ready. `OPCPAY_WEBHOOK_SECRET` is optional: if configured, signed events are verified and deduplicated; otherwise the server reconciles pending orders through the OPCPAY purchase/entitlement/consumption APIs every 60 seconds. Keep the API key server-side only.
- Configure the production director provider, Tencent TTS credentials, and persistent object storage required by the API.
- Apply migrations in order on staging first; verify check-in, referral rewards, partner activation, commission accrual, seven-day settlement, profile verification, concurrent/idempotent withdrawal requests, review, paid recording, failure release, and audit history.
- Perform a final staging acceptance with test accounts and test funds before any production deployment.

## Operational cautions

- Do not rotate or discard the payout encryption key without a planned data re-encryption migration.
- Do not manually edit commission or withdrawal rows to resolve discrepancies; preserve the audit trail and use reviewed administrative workflows.
- Refund reversal is not automated until the production payment/refund provider workflow is implemented and integrated with commission cancellation.
