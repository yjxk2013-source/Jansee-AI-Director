# OPCPAY production integration

V4 uses the existing V2 OPCPAY provider choice, but keeps all local orders, wallets, memberships, commission ledgers and webhook audit records in PostgreSQL. V2 remains read-only.

## Runtime configuration

- `OPCPAY_API_KEY`: server-side project API key; never expose it to the browser.
- `OPCPAY_WEBHOOK_SECRET`: recommended signature secret from the provider console. If absent, purchase and periodic entitlement reconciliation can still work, but the webhook route will reject events and the provider callback must not be enabled.
- `OPCPAY_BASE_URL`: optional HTTPS override for isolated provider testing. Production defaults to the SDK's official API endpoint.
- Configure the provider callback to the publicly reachable HTTPS API URL ending in `/api/v1/billing/opcpay/webhook` only after the matching webhook secret is configured.

The API probes project capabilities and the enabled product on startup. If the provider is temporarily unavailable, the service retries readiness during its periodic sweep instead of permanently remaining disabled. Production order creation is blocked until the provider passes the capability check.

## Required OPCPAY product/SKU setup

The V4 product IDs and prices are authoritative. Each matching SKU must be enabled, CNY-denominated, and use `billing_mode=QUANTITY`. The `display_name` should exactly match the package ID below; if it does not, the price fallback must resolve to exactly one SKU.

| V4 package ID | Price (CNY) | Credits | Required quota if unit is COUNT | Required quota if unit is POINT |
|---|---:|---:|---:|---:|
| lite | 41.00 | 7,600 | 38 | 7,600 |
| plus | 119.00 | 24,800 | 124 | 24,800 |
| pro | 299.00 | 66,600 | 333 | 66,600 |
| ultra | 599.00 | 153,800 | 769 | 153,800 |
| boost_small | 9.90 | 1,000 | 5 | 1,000 |

For COUNT SKUs, one OPCPAY quota unit maps to 200 JANSEE credits. For POINT SKUs, one quota unit maps to one JANSEE credit. The API blocks checkout if price, currency, SKU ambiguity, billing mode or quota amount does not match the V4 plan. Do not silently change V4 prices to fit a provider SKU.

Required project capabilities: `purchase_entry`, `entitlement_query`, `consumption`, and `purchase_request_query`. The product must report `capability_status=ENABLED`.

## Payment and fulfillment safety

1. A user-owned V4 pending order is created first.
2. OPCPAY `purchase` uses the V4 order ID as the idempotency key. The resulting SKU/quota mapping, pay URL, QR payload and expiry are persisted before returning the QR to the browser.
3. The browser polls the owner-bound order status endpoint. The server also reconciles pending orders every 60 seconds.
4. Before creating the provider purchase, V4 persists the user's current quota balance as the order baseline. Reconciliation checks the purchase record and any already-successful consumption, then requires the provider balance to reach baseline + this order's quota before consuming with the stable idempotency key `<orderId>:c`. A pre-existing balance alone can never fulfill a new V4 order. The baseline column is nullable with no default; legacy pending orders without a trustworthy baseline are blocked rather than silently treated as baseline zero.
5. Only a consumption receipt with status=SUCCEEDED, confirmed=true, the exact order idempotency key, the exact purchased amount in consumed, and the exact COUNT/POINT quota_unit calls the PostgreSQL `fulfillOrder` transaction. The same strict receipt check is applied during crash recovery to an already-existing consumption. That transaction adds credits, writes the recharge ledger, activates/extends membership if this is a membership package, and settles eligible referral commissions exactly once.
6. A crash after provider consumption but before local fulfillment is recoverable: the next reconciliation sees the same successful consumption record and performs local fulfillment without consuming twice.

A PostgreSQL advisory lock serializes reconciliation per user across API replicas. Webhook signatures are verified against the exact raw request body; event IDs are persisted with a unique key to deduplicate retries.

## Membership fulfillment

Successful Lite/Plus/Pro/Ultra orders create or extend a one-month membership record. Active Lite accounts are limited to 30 source uploads per China Standard Time day; Plus accounts to 60; Pro accounts to 120; Ultra has unlimited source uploads. Upload quota check and asset-row insertion share a per-user PostgreSQL advisory-locked transaction so concurrent requests cannot exceed the tier limit. Worker job claiming prioritizes Ultra, Pro, Plus, Lite, then non-members, while queue aging promotes old jobs every six hours to reduce starvation.

## Limitations and release gates

- OPCPAY currently advertises no refund capability. V4 does not pretend to provide automatic provider-side purchase refunds; customer purchase refunds require the provider's supported manual process until a refund API is available.
- The webhook secret is recommended but not required for the periodic reconciliation path. If configured, register the callback only after the secret is installed in the production secret manager.
- 2026-11-16 read-only V4 provider probe: the local V4 environment has OPCPAY_API_KEY configured (the value was not printed or copied). Live GET calls to capabilities and product returned API v1.1, provider_configured=true, product status ENABLED, and all required capabilities (purchase_entry, entitlement_query, consumption, purchase_request_query). The five live SKUs matched the V4 price/quota table: Lite ¥41 / 38 COUNT, Plus ¥119 / 124 COUNT, Pro ¥299 / 333 COUNT, Ultra ¥599 / 769 COUNT, and 小加油包 ¥9.90 / 5 COUNT. No purchase, consumption, webhook mutation, or payment was initiated during this probe.
- The V4 local environment currently has no OPCPAY_WEBHOOK_SECRET. Do not enable the provider callback until a matching secret is installed securely. No real Alipay transaction, callback signature, refund, or full local fulfillment against a paid order has yet been tested.
- Before launch: configure the five SKUs exactly, run a low-value real payment for each product family (membership and top-up), verify credits/membership/referral ledgers, test callback retry and duplicate delivery, and record the provider's manual refund/support procedure.
