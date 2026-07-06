---
"ultratorrent": patch
---

Fix media-server connections failing with 'baseUrl is required': the integration settings form persisted the server address under 'url' but providers read 'baseUrl'. decryptConfig now aliases url→baseUrl (repairs already-saved connections), and the form writes baseUrl going forward
