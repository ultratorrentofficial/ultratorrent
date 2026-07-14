---
id: index
title: Referencia
sidebar_position: 0
description: Referencia generada automáticamente — API, permisos, módulos, variables de entorno y esquema de la base de datos.
keywords: [referencia, api, permisos, entorno, esquema, módulos, generado]
---

# Referencia

Todo lo que hay en esta sección se **genera desde el código fuente durante el build** con
`website/scripts/generate-reference.mjs`. Nada de esto se escribe a mano, lo que significa que
**no puede desviarse del producto**. Si una página de aquí está mal, el código está mal.

| Página | Generada desde | Tamaño |
| --- | --- | --- |
| [API REST](/reference/api) | los decoradores `@Controller` / `@Get` / `@RequirePermissions` | **273 endpoints** en 14 controllers |
| [Permisos](/reference/permissions) | `packages/shared/src/permissions.ts` | **116 permisos × 5 roles** |
| [Módulos](/reference/modules) | `module-registry/manifests.ts` | **23 módulos** + grafo de dependencias |
| [Variables de entorno](/reference/environment) | `.env.example` | **38 variables** |
| [Esquema de la base de datos](/reference/database-schema) | `apps/backend/prisma/schema.prisma` | **88 modelos** como diagramas ER |

## Regenerar

```bash
cd website
npm run gen:reference   # corre automáticamente antes de `npm start` y `npm run build`
```

El generador lee los exports **compilados** para los permisos y los manifests de módulos (en vez
de raspar el TypeScript con expresiones regulares), así que la matriz de roles y el grafo de
dependencias son exactamente lo que la aplicación exige en tiempo de ejecución.

:::note Datos en inglés, a propósito
La prosa de esta sección está en español, pero los **datos** no se traducen: rutas de endpoints,
cadenas de permisos (`torrents.view`), nombres de variables de entorno y nombres de modelos y
columnas de Prisma aparecen tal cual. Son identificadores del código — traducirlos los volvería
incorrectos.
:::

## Ver también

- [Escribir un módulo](/develop/creating-modules) — cómo entra un módulo nuevo en la Referencia de módulos
- [Control de acceso](/develop/rbac) — cómo entra un permiso nuevo en la Referencia de permisos
- [Base de datos y Prisma](/develop/database) — cómo entra un cambio de esquema en los diagramas ER
