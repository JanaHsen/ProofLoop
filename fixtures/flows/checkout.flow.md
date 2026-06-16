---
name: Complete checkout and confirm the order persists
entry: /login
viewport: desktop
tags: [checkout, persistence]
---

## Steps
1. Sign in as "alice" with password "password123".
2. Add the "Desk Lamp" twice and the "Coffee Mug" once.
3. Proceed to checkout and place the order.
4. Revisit the order's own link as a fresh visit.

## Acceptance Criteria
- Placing the order succeeds: the user reaches an order-confirmation page for a real, newly created order — not an error page and not a dead end. (after step 3)
- On the confirmation, the figures reconcile: the Subtotal plus the Tax equals the Total shown. (after step 3)
- When the order's own link is revisited, the same order is still retrievable and shows the same items and the same Total as when it was placed. (after step 4)
