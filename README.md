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
