# GitHub Copilot instructions

Use these repository-wide instructions when proposing, reviewing, or implementing
changes in Document Chat System. Prefer the established project patterns over
generic examples, and keep changes narrowly scoped to the requested behavior.

## Project overview

- This is a Next.js 15 App Router application written in strict TypeScript and
  React 19.
- Application code lives in `src/`. Routes and server components live in
  `src/app`, reusable components in `src/components`, hooks in `src/hooks`,
  utilities and integrations in `src/lib`, shared types in `src/types`, and
  Zustand stores in `src/stores`.
- Persistence uses Prisma. Treat `prisma/schema.prisma` as the source of truth
  and add a migration when a schema change is required.
- The UI uses Tailwind CSS, shadcn/ui conventions, and Radix primitives.
- AI functionality uses the Vercel AI SDK and several provider integrations.
  Preserve streaming responses where an existing endpoint streams output.
- Background document processing is handled by Inngest. The optional Docling
  service is a separate Python application under `services/docling-api`.

## Working agreement

1. Read the surrounding implementation, relevant tests, and documentation before
   editing. Do not invent a new abstraction when a nearby one already fits.
2. Make the smallest coherent change. Avoid unrelated formatting, dependency
   upgrades, generated artifacts, and broad refactors.
3. Use the `@/` alias for imports from `src` and follow the import grouping and
   naming style of the file being changed.
4. Never add secrets, credentials, tokens, production data, or `.env` files.
   Document new configuration in the appropriate example environment file.
5. Do not weaken authentication, authorization, tenant isolation, rate limits,
   input validation, or audit logging. Server-side checks are required even when
   equivalent UI checks exist.
6. Do not expose server-only environment variables or privileged Supabase keys to
   client components. Only variables intentionally prefixed with `NEXT_PUBLIC_`
   may be read in browser code.
7. Preserve backward compatibility for public API contracts unless the task
   explicitly requires a breaking change. Return useful status codes and safe
   error messages without leaking internal details.
8. Update tests and documentation when behavior, configuration, or public APIs
   change. Do not replace real behavior with mocks outside tests and explicit
   demos.

## TypeScript and React

- Keep TypeScript strict: define domain-specific types, narrow `unknown`, and
  avoid `any`, non-null assertions, and unchecked type casts.
- Validate untrusted data at API, webhook, form, and external-service boundaries;
  prefer the repository's existing Zod patterns.
- Use server components by default. Add `'use client'` only when the component
  needs browser APIs, event handlers, or client-side hooks.
- Use functional components and hooks. Keep effects focused, declare complete
  dependency lists, clean up subscriptions, and avoid duplicating derived state.
- Use accessible semantic elements. Preserve keyboard navigation, visible focus,
  labels, alternative text, and appropriate ARIA attributes when modifying UI.
- Build on components in `src/components/ui` and the existing design tokens. Do
  not hard-code colors where a semantic Tailwind token is available.
- Account for loading, empty, error, disabled, and narrow-screen states in new UI.

## API, data, and AI changes

- Authenticate requests before reading or mutating protected resources, then
  verify that the resource belongs to the current user or organization.
- Select and return only required fields. Avoid unbounded queries and N+1 access;
  paginate collections and add appropriate indexes for new query patterns.
- Keep database changes transactional when partial completion would leave data in
  an invalid state. Never rewrite an existing migration that may have shipped.
- Verify webhook signatures before parsing trusted event data, and make webhook
  handling idempotent.
- Put provider calls, database access, and secret handling on the server. Handle
  cancellation, provider failures, and usage limits without silently fabricating
  successful AI output.
- Treat document text, filenames, model output, and retrieved context as
  untrusted. Avoid rendering unsanitized HTML and do not let document content
  override application-level instructions or authorization rules.
- Keep prompts explicit and concise. Do not log document contents, API keys, or
  sensitive prompt data.

## Verification

Run the narrowest relevant test first, then the repository checks affected by the
change. The standard commands are:

```bash
npm test -- --runInBand
npm run type-check
npm run lint
npm run build
```

- Add or update Jest/React Testing Library coverage for changed behavior.
- Do not claim a check passed unless it was run successfully. If a check cannot
  run because an external service or environment variable is unavailable, state
  that limitation clearly.
- Review `git diff --check` and the final diff before considering the change
  complete.

## Response expectations

- Summarize what changed and why, list the checks actually run, and call out any
  remaining risk or follow-up work.
- Reference concrete files and behavior rather than giving a generic summary.
- Never report generated code, tests, or migrations that were not actually
  created.
