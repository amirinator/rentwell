# Migrations

This folder is empty on a fresh checkout by design.

The baseline migration is **derived from `schema.prisma`** rather than hand
written, so it cannot drift from the schema it is supposed to produce. Running:

```bash
pnpm db:setup
```

(which is `node scripts/db-bootstrap.mjs`) will:

1. Generate `<timestamp>_init/migration.sql` with
   `prisma migrate diff --from-empty --to-schema-datamodel`, if no migration
   exists yet.
2. Apply every migration with `prisma migrate deploy`.
3. Generate the Prisma client.
4. Verify with a second `migrate diff` that the applied database matches
   `schema.prisma` exactly, and fail if it does not.

Commit the generated migration. From then on, schema changes follow the normal
flow:

```bash
pnpm --filter @rentwell/database migrate:dev --name add_something
```

CI runs `node scripts/db-bootstrap.mjs --verify` after applying migrations, so a
schema edit without a matching migration fails the build.
