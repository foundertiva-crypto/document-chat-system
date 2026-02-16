# Codebase Task Proposals

This document captures four concrete, scoped tasks found during a quick codebase review.

## 1) Typo fix task

**Issue:** User-facing error messages in the Clerk webhook route contain a typo (`occured` instead of `occurred`).

**Evidence:** `src/app/api/v1/webhooks/clerk/route.ts` returns `"Error occured -- no svix headers"` and `"Error occured"`.

**Task:**
- Replace typo in both response strings with `occurred`.
- Keep status codes and behavior unchanged.

**Acceptance criteria:**
- Error response text uses `occurred` in both branches.
- Existing webhook behavior remains functionally identical.

---

## 2) Bug fix task

**Issue:** `useIsTouchDevice` checks `navigator.maxTouchPoints > 0` twice, which is redundant and likely misses intended fallback detection logic.

**Evidence:** In `src/hooks/use-is-touch-device.ts`, the touch detection OR-chain repeats the same condition twice.

**Task:**
- Replace duplicate condition with a meaningful fallback check (e.g., `msMaxTouchPoints` for older browsers) or remove redundancy.
- Ensure hook still initializes and updates correctly on resize.

**Acceptance criteria:**
- No duplicated condition remains in the touch detection logic.
- Touch detection works for modern browsers and degrades safely for legacy environments.

---

## 3) Code comment/documentation discrepancy task

**Issue:** A comment in the Clerk webhook route says `If there are no headers, error out`, but the condition fails when *any required Svix header* is missing.

**Evidence:** In `src/app/api/v1/webhooks/clerk/route.ts`, the check is `if (!svix_id || !svix_timestamp || !svix_signature)`.

**Task:**
- Update the comment to accurately describe the current logic (e.g., "If any required Svix header is missing, return 400").

**Acceptance criteria:**
- Comment clearly matches implemented behavior.
- No runtime logic changes are introduced in this task.

---

## 4) Test improvement task

**Issue:** The Clerk webhook handler has critical control flow (missing headers, invalid signature, success path) but currently has no dedicated automated tests.

**Evidence:** No tests referencing this route were found by searching test files for `webhooks/clerk`, `svix`, or `useIsTouchDevice`.

**Task:**
- Add route tests for `POST /api/v1/webhooks/clerk` covering:
  1. Missing Svix headers returns 400.
  2. Invalid Svix signature returns 400.
  3. Recognized event type returns success JSON.
- Mock Svix verification and DB writes to isolate route behavior.

**Acceptance criteria:**
- New tests pass in CI.
- Tests validate status code and response body for each case.
- Tests do not require live Clerk/Svix services.
