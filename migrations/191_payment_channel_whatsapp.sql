-- 191_payment_channel_whatsapp.sql (user, 2026-10-16: "full reports bought & revenue graph not
-- working"). A WhatsApp purchase was created with no channel of its own; the checkout page then
-- added paid_from.channel = 'web' (the browser it was paid in), and every count that reads
-- coalesce(raw->>'channel', raw->'paid_from'->>'channel', ...) took it for a website sale — so the
-- WhatsApp admin's reports and revenue charts, Overview and site stats left WhatsApp sales out.
-- Website purchases have always saved channel 'web' at creation (routes/siteApi.js, pay/free.js,
-- pay/replace.js), so a payment with no channel of its own is a WhatsApp one.
UPDATE payments
   SET raw = coalesce(raw, '{}'::jsonb) || '{"channel": "whatsapp"}'::jsonb
 WHERE coalesce(raw->>'channel', '') = '';
