import { createReadStream } from 'node:fs';
import * as readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import { DatasetFileSpec, parseTsvLine, validateHeader } from './imdb-tsv';

/**
 * Stream a gzipped IMDb TSV file, yielding one parsed field-array per data row.
 * The header line is validated against the spec and then skipped. The file is
 * decompressed and read line-by-line — it is NEVER loaded into memory in full,
 * which matters for the multi-GB datasets.
 *
 * Throws if the header doesn't match the expected columns (structural guard).
 */
export async function* streamTsvRecords(
  absPath: string,
  spec: DatasetFileSpec,
): AsyncGenerator<string[]> {
  const rl = readline.createInterface({
    input: createReadStream(absPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let header: string[] | null = null;
  try {
    for await (const line of rl) {
      if (!line) continue;
      const fields = parseTsvLine(line);
      if (!header) {
        header = fields;
        if (!validateHeader(header, spec.header)) {
          throw new Error(
            `Unexpected header for ${spec.file}: got [${header
              .slice(0, spec.header.length)
              .join(', ')}]`,
          );
        }
        continue;
      }
      yield fields;
    }
  } finally {
    rl.close();
  }
}
