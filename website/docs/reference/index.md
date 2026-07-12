---
id: index
title: Reference
sidebar_position: 0
description: Machine-generated reference — API, permissions, modules, environment variables, database schema.
keywords: [reference, api, permissions, environment, schema, modules, generated]
---

# Reference

Everything in this section is **generated from the source code at build time** by
`website/scripts/generate-reference.mjs`. Nothing here is hand-written, which means it
**cannot drift from the product**. If a page here is wrong, the code is wrong.

| Page | Generated from | Size |
| --- | --- | --- |
| [REST API](/reference/api) | the `@Controller` / `@Get` / `@RequirePermissions` decorators | **273 endpoints** across 14 controllers |
| [Permissions](/reference/permissions) | `packages/shared/src/permissions.ts` | **116 permissions × 5 roles** |
| [Modules](/reference/modules) | `module-registry/manifests.ts` | **23 modules** + dependency graph |
| [Environment Variables](/reference/environment) | `.env.example` | **38 variables** |
| [Database Schema](/reference/database-schema) | `apps/backend/prisma/schema.prisma` | **88 models** as ER diagrams |

## Regenerating

```bash
cd website
npm run gen:reference   # runs automatically before `npm start` and `npm run build`
```

The generator reads the **compiled** exports for permissions and module manifests (rather than
regex-scraping TypeScript), so the role matrix and dependency graph are exactly what the
application enforces at runtime.

## See also

- [Writing a module](/develop/creating-modules) — how a new module gets into the Module Reference
- [Access Control](/develop/rbac) — how a new permission gets into the Permissions Reference
- [Database & Prisma](/develop/database) — how a schema change gets into the ER diagrams
