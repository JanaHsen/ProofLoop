---
name: Add items to the cart and verify the totals
entry: /login
viewport: desktop
tags: [cart, totals]
---

## Steps
1. Sign in as "alice" with password "password123".
2. Open the product list.
3. Add the "Desk Lamp" to the cart twice.
4. Add the "Coffee Mug" to the cart once.
5. Open the cart.

## Acceptance Criteria
- The Subtotal equals the sum of the line totals, where each line total is the item's unit price multiplied by its quantity.
- The Tax equals 10% of the Subtotal, rounded to the nearest cent — it must not be zero or a different proportion.
- The Total equals the Subtotal plus the Tax.
