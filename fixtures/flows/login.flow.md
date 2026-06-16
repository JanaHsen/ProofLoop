---
name: Log in with valid credentials
entry: /login
viewport: desktop
tags: [auth, smoke]
---

## Steps
1. Enter the username "alice" and the password "password123".
2. Submit the sign-in form.
3. Go to the product list, which is only available to signed-in users.

## Acceptance Criteria
- After submitting valid credentials the user is signed in: the product list loads instead of bouncing back to the sign-in page.
