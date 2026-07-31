---
"ultratorrent": patch
---

New permissions declared by a module are now granted to the system roles that should hold them on boot, not only added to the catalog. The deployed container runs prisma migrate deploy and never the seed, so shipping a feature that added a permission previously left every non-SUPER_ADMIN with a permanent 403 on its routes — invisible to whoever deployed it, because SUPER_ADMIN bypasses the permission guard. Only keys that are brand new to the database are granted, so a permission an operator deliberately revoked in the RBAC UI is never silently restored.
