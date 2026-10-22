-- 204_privacy_meta_pixel.sql (user, 2026-10-22: the website now has the Meta Pixel, so Meta can aim the ads
-- at people who check vehicles, sign in and buy). The privacy policy already names Google and Meta as
-- analytics and advertising partners; it now says how (the Google tag, the Meta Pixel) and what a visit
-- tells them (a check, a sign-in, a purchase and its amount) — and that vehicle numbers and mobiles never go.
-- Wording only; the version stays, so nobody is asked to agree again. A replace() of the exact old words,
-- so a clause edited by hand since is left as it is.

UPDATE privacy_policy SET modified_at = now(), description = replace(description,
  'which receive information about visits to gaadipe.in, such as the pages opened, the device and the advertisement that brought the visitor, to measure and improve our service and advertising. Your reports, payment details and sign-in codes are never shared with analytics or advertising partners.',
  'which receive information about visits to gaadipe.in through the Google tag and the Meta Pixel, such as the pages opened, the device, the advertisement that brought the visitor and whether the visit led to a vehicle check, a sign-in or a purchase (with its amount), to measure and improve our service and advertising. The vehicle numbers you check, your mobile number, your reports, payment details and sign-in codes are never shared with analytics or advertising partners.')
 WHERE is_active AND title = 'Data Sharing';
