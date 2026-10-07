# Razorpay setup

Razorpay is already built in. You only need keys and one webhook.

## 1. Get keys
Razorpay Dashboard → Account & Settings → API Keys → Generate Key (use **Test Mode** first).

Set on your server (Render → Environment):

    RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
    RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxx
    RAZORPAY_WEBHOOK_SECRET=any-long-random-string   (you choose it, see step 2)

## 2. Webhook (backs up the checkout if the user closes the tab)
Dashboard → Developers → Webhooks → Add:

- URL: `https://YOUR-APP-DOMAIN/api/payments/webhook`
- Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`
- Events: `payment.captured`, `payment.failed`, `refund.processed`

## 3. Test
Subscribe from the app. Test card: `4111 1111 1111 1111`, any future expiry, any CVV, any OTP.
UPI test: `success@razorpay`.

## 4. Go live
Complete KYC, generate **Live** keys, replace the three values above, redeploy.

## Plans / prices
Edit `backend/src/utils/plans.ts` (amounts are in paise: 49900 = ₹499).

## Flow
1. App calls `POST /api/payments/checkout` → server creates a Razorpay order.
2. Razorpay Checkout opens in the browser.
3. On success the app calls `POST /api/payments/verify`; the server checks Razorpay's signature, then activates the plan.
4. The webhook does the same independently; whichever arrives first wins and the other is ignored.
