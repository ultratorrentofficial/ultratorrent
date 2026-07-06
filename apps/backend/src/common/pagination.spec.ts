import { pageOf, paginate, parsePage } from './pagination';

describe('parsePage', () => {
  it('applies defaults and computes skip/take', () => {
    expect(parsePage(undefined, undefined)).toEqual({ page: 1, pageSize: 50, skip: 0, take: 50 });
  });
  it('parses strings and computes skip from the page', () => {
    expect(parsePage('3', '20')).toEqual({ page: 3, pageSize: 20, skip: 40, take: 20 });
  });
  it('floors page/pageSize at 1 and caps pageSize at the max', () => {
    expect(parsePage('0', '100000')).toMatchObject({ page: 1, pageSize: 200, skip: 0, take: 200 });
    expect(parsePage('-5', '0')).toMatchObject({ page: 1, pageSize: 1 });
  });
  it('honors a custom default + max', () => {
    expect(parsePage(undefined, undefined, 25, 500)).toMatchObject({ pageSize: 25 });
    expect(parsePage(undefined, '9999', 25, 500)).toMatchObject({ pageSize: 500 });
  });
});

describe('pageOf', () => {
  it('wraps items + total into the standard envelope', () => {
    const p = parsePage('2', '10');
    expect(pageOf(['a', 'b'], 42, p)).toEqual({ items: ['a', 'b'], total: 42, page: 2, pageSize: 10 });
  });
});

describe('paginate', () => {
  it('runs count + findMany with skip/take and returns the envelope', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 1 }]);
    const count = jest.fn().mockResolvedValue(137);
    const res = await paginate({ count, findMany }, { where: { x: 1 }, orderBy: { id: 'desc' } }, parsePage('2', '25'));
    expect(res).toEqual({ items: [{ id: 1 }], total: 137, page: 2, pageSize: 25 });
    expect(count).toHaveBeenCalledWith({ where: { x: 1 } });
    expect(findMany).toHaveBeenCalledWith({ where: { x: 1 }, orderBy: { id: 'desc' }, skip: 25, take: 25 });
  });
});
