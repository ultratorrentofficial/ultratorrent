import { HASH_BLOCK_BYTES, computeMovieHash } from './moviehash';

describe('computeMovieHash', () => {
  const zeros = () => Buffer.alloc(HASH_BLOCK_BYTES);

  it('returns null for files smaller than two hash blocks', () => {
    expect(computeMovieHash(HASH_BLOCK_BYTES, zeros(), zeros())).toBeNull();
    expect(computeMovieHash(2 * HASH_BLOCK_BYTES - 1, zeros(), zeros())).toBeNull();
  });

  it('hashes size alone when head and tail are all zero', () => {
    const size = 2 * HASH_BLOCK_BYTES; // 131072 = 0x20000
    expect(computeMovieHash(size, zeros(), zeros())).toBe('0000000000020000');
  });

  it('sums the first little-endian uint64 word of each block', () => {
    const size = 2 * HASH_BLOCK_BYTES;
    const head = zeros();
    head.writeBigUInt64LE(1n, 0); // +1
    const tail = zeros();
    tail.writeBigUInt64LE(2n, 0); // +2
    // 0x20000 + 1 + 2 = 0x20003
    expect(computeMovieHash(size, head, tail)).toBe('0000000000020003');
  });

  it('wraps modulo 2^64', () => {
    const size = 2 * HASH_BLOCK_BYTES;
    const head = zeros();
    head.writeBigUInt64LE((1n << 64n) - 1n, 0); // max uint64 → wraps
    const tail = zeros();
    // 0x20000 + (2^64 - 1) mod 2^64 = 0x20000 - 1 = 0x1FFFF
    expect(computeMovieHash(size, head, tail)).toBe('000000000001ffff');
  });

  it('accepts a bigint file size', () => {
    expect(computeMovieHash(BigInt(2 * HASH_BLOCK_BYTES), zeros(), zeros())).toBe('0000000000020000');
  });
});
