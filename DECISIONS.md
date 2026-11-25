# Implementation decisions

- Inbound webhooks verify the timestamp and HMAC against the raw body before parsing JSON. MongoDB acknowledges journaled writes. Unique indexes scoped by workspace deduplicate both Pigeon event IDs and message IDs. The snapshot sorts inbound messages by occurrence time, with message ID as a deterministic tie-breaker.
- Replies are stored as queued before the endpoint returns HTTP 202. A workspace-scoped client reference identifies the reply and determines its Pigeon idempotency key. The first accepted payload for a repeated reference wins. The worker persists retry scheduling, honors carrier cooldowns, and uses the same key after timeouts. Terminal status webhooks take precedence over late send responses.
- A unique workspace and contact index makes concurrent claims atomic. Repeating a claim by the winning agent succeeds.
- The current scope covers Level 1 messaging and claims. A local React inbox is also implemented. OIDC login, per-user workspace permissions, paginated history, claim and close/reopen controls in the UI, WebSockets, and cross-instance rate coordination are pending. Search, encrypted notes, and billing were deferred.
- The smoke test stored one inbound message once and saw a reply reach `delivered` after HTTP 202. The server typecheck passed. The latest reported Level 1 score was 24/24.
- Native Windows Level 2 verification is blocked by checker process management. The checker passes a negative PID to `process.kill` for POSIX process-group termination and catches the error. The old server keeps port 4001 and the replacement can fail with `EADDRINUSE`. The manifest already launches Node directly through `exec`. Use a POSIX environment for restart verification.

## Local inbox

The inbox uses the existing grader-token gate. Its read route serves up to 200 recent inbound messages and 200 recent replies for the selected workspace. React groups them by contact and polls for updates every three seconds. The composer uses the same HTTP reply endpoint as the checker and keeps the client reference on retry while the draft and conversation are unchanged. The credential lives in browser memory for the current page. Workspace selection is a filter for a trusted operator with the grader token.

The confirmed Level 1 result predates the inbox. Level 2 restart remains unverified. For submission, the full checker report and exported AI transcripts still need to be collected and checked against SUBMISSION.md.

Verification for the inbox change passed server and web typechecks and the Vite production build. The inbox API smoke test on MongoDB returned 401 without the token, 200 with an empty inbox for Acme, and 400 for an unknown workspace. Browser interaction and a fresh checker run against this commit were not verified.
