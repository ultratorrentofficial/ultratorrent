/** Generic in-memory stand-in for PrismaService model delegates (tests only). */
function matches(where: any, row: any): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries<any>(where)) {
    if (cond === undefined) continue;
    if (key === 'OR') { if (!(cond as any[]).some((c) => matches(c, row))) return false; continue; }
    if (cond === null) { if (row[key] !== null && row[key] !== undefined) return false; continue; }
    if (typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) { if (!cond.in.includes(row[key])) return false; continue; }
      if ('lt' in cond) { if (!(row[key] && row[key] < cond.lt)) return false; continue; }
      if ('contains' in cond) {
        const hay = String(row[key] ?? '').toLowerCase();
        if (!hay.includes(String(cond.contains).toLowerCase())) return false;
        continue;
      }
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

export class Table {
  rows: any[] = [];
  private seq = 0;
  constructor(private name: string) {}
  private id() { return `${this.name}-${++this.seq}`; }

  async create({ data }: any) {
    const row = { id: data.id ?? this.id(), createdAt: new Date(), updatedAt: new Date(), ...data };
    this.rows.push(row);
    return row;
  }
  async createMany({ data }: any) { for (const d of data) await this.create({ data: d }); return { count: data.length }; }
  async findMany({ where, take }: any = {}) {
    let r = this.rows.filter((x) => matches(where, x));
    r = [...r].reverse();
    return take ? r.slice(0, take) : r;
  }
  async findFirst({ where }: any = {}) { return [...this.rows].reverse().find((x) => matches(where, x)) ?? null; }
  async findUnique({ where }: any) {
    if (where.id) return this.rows.find((x) => x.id === where.id) ?? null;
    return this.rows.find((x) => matches(where, x)) ?? null;
  }
  async update({ where, data }: any) {
    const row = this.rows.find((x) => x.id === where.id);
    Object.assign(row, data, { updatedAt: new Date() });
    return row;
  }
  async updateMany({ where, data }: any) {
    const hit = this.rows.filter((x) => matches(where, x));
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  }
  async delete({ where }: any) {
    const i = this.rows.findIndex((x) => x.id === where.id);
    return i >= 0 ? this.rows.splice(i, 1)[0] : null;
  }
  async deleteMany({ where }: any = {}) {
    const before = this.rows.length;
    this.rows = this.rows.filter((x) => !matches(where, x));
    return { count: before - this.rows.length };
  }
  async count({ where }: any = {}) { return this.rows.filter((x) => matches(where, x)).length; }
}

/** Build a fake PrismaService exposing the named model delegates + $transaction. */
export function makeFakePrisma(models: string[]): any {
  const prisma: any = {
    $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  };
  for (const m of models) prisma[m] = new Table(m);
  return prisma;
}
