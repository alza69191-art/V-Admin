# V Admin
لوحة الإدارة المركزية لمتجر V Commerce.

## التشغيل
- Node.js 20+
- `npm install`
- عيّن `DATABASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `STORE_ORIGIN`.
- `npm run build && npm start`

## المعمارية
تُخزّن إعدادات الهوية والمحتوى وسياسات المتجر في PostgreSQL (JSON-driven settings). يقرأ المتجر الإعدادات والمنتجات من واجهات عامة، بينما تتطلب عمليات الكتابة جلسة إدارة HttpOnly موقعة.

## حدود الإصدار الأول
يحتوي هذا الإصدار على أساس قابل للتشغيل لإدارة الهوية والمحتوى والمنتجات وسياسة نشر العملاء. لا يعني ذلك أن جميع الميزات الـ500 أو بوابات الدفع والشحن والتكاملات الخارجية قد نُفذت؛ تُضاف كوحدات مستقلة على مراحل مع مزودين ومفاتيح فعلية واختبارات.


## Freelance account foundation

The account API now supports buyer, freelancer, and dual-role accounts, email verification, and editable profile fields.

Required Render environment variables before enabling public registration:
- `RESEND_API_KEY`: Resend API key (keep server-side only).
- `RESEND_FROM_EMAIL`: verified sender address/domain configured in Resend.
- `SESSION_SECRET`: existing session signing secret (at least 32 characters).
- `TURNSTILE_SECRET_KEY`: Cloudflare Turnstile secret key (server-side only).

Endpoints:
- `POST /api/customer/auth` with action `register` or `login`.
- `POST /api/customer/auth/verify` with email and six-digit code.
- `POST /api/customer/auth/resend` to request a new code (rate limited to one per minute per account).
- `GET /api/customer/auth` to read the signed-in profile.
- `PATCH /api/customer/profile` to update username, bio, skills, and account role.

Registration remains unavailable until email delivery is configured. Verification codes expire after 15 minutes and are stored as SHA-256 digests, not plaintext. Existing accounts are marked verified once during the schema migration to preserve access.


## Escrowly Connect

The legacy Vaultion/TRON wallet checkout has been removed from the application flow. Escrowly Connect is integrated server-side:
- `POST /api/orders/escrow` creates a hosted checkout and stores the transaction ID.
- `GET /api/orders/escrow-status?orderNumber=...` reconciles status through an authenticated Escrowly API read.
- `POST /api/webhooks/escrowly` verifies the exact raw body with the Escrowly HMAC-SHA256 signature, checks event replay IDs, and reconciles the transaction before recording funding.

Required Render secrets/settings on **V-Admin**:
- `ESCROWLY_API_KEY`: keep the test key while validating; never expose it to the browser.
- `ESCROWLY_WEBHOOK_SECRET`: signing secret copied from the matching Test or Live webhook configuration.
- `ESCROWLY_LIVE_ENABLED=false`: live transactions remain blocked unless explicitly changed after successful test validation.
- `ESCROWLY_CURRENCY=USDT`: accepted values are USDT, USDC, or DAI.
- `ESCROWLY_USD_RATE=1`: conversion factor from platform USD prices to the selected stablecoin; review before production.
- Optional: `ESCROWLY_INSPECTION_DAYS=3`, `ESCROWLY_FEE_PAYER=buyer`, `ESCROWLY_WEBHOOK_URL=https://v-admin-api.onrender.com/api/webhooks/escrowly`.

In Escrowly Merchant Resources, create a webhook separately for Test and Live using:
`https://v-admin-api.onrender.com/api/webhooks/escrowly`
Subscribe to transaction events. Copy the displayed signing secret to the matching Render environment. Test and Live webhook secrets are not interchangeable. Do not enable live mode until a complete test transaction, signed webhook delivery, funding reconciliation, and admin fulfillment gate have passed.

The application deliberately does not retry an ambiguous transaction-creation request because Escrowly currently does not support an idempotency key. Existing Vaultion escrow rows are retained and flagged for manual review; they are not silently converted.
