---
name: Validated form rejects an invalid amount
entry: /form
viewport: desktop
tags: [form, validation]
---

## Steps
1. Fill in the name "Jana", the email "jana@example.com", and an amount of "25", then submit the form.
2. Fill in the name "Jana", the email "jana@example.com", and an amount of "-5", then submit the form.

## Acceptance Criteria
- The valid submission (a positive whole-number amount with a valid name and email) is accepted: the form reports the request was received. (after step 1)
- The submission with a negative amount of -5 is rejected as invalid and is NOT accepted, even though the name and email are valid. (after step 2)
