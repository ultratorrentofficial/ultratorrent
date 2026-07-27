/**
 * What a file entry admits, from what it is.
 *
 * The File Manager's context menu already branched on `node.isDirectory` inline
 * — previewing a folder is meaningless, and opening a file is not what "open"
 * means here. That branch lived in the one surface that remembered to write it;
 * as an advertised capability it travels with the entity instead, so the bulk
 * bar and anything added later inherit the same rule.
 */

export interface FileLike {
  isDirectory: boolean;
}

export function fileCapabilities(node: FileLike): string[] {
  // `openable` is descending into a directory; `readable` is a file whose bytes
  // can be previewed or downloaded. Deliberately exclusive: an entry is one or
  // the other, and an action requiring both would never resolve.
  return node.isDirectory ? ['openable'] : ['readable'];
}
