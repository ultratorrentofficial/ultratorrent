import { summarizeMediaJobInput } from './media-processing-queue.service';

/**
 * A job summary that says `null` is not neutral — it is a claim.
 *
 * Opening a completed metadata refresh in the Jobs Center showed
 * `{ "libraryId": null, "itemId": null }`, and the operator concluded the job had
 * no idea what to work on. The job was fine: it refreshed "A Sense of Dread" and
 * wrote its metadata one second later. The summariser read only `libraryId` and
 * `itemId`, while Library Browser's bulk path carries its targets in the PAYLOAD
 * — so it reported nulls for fields the caller never used and ignored the field
 * that held the answer.
 */
describe('summarizeMediaJobInput', () => {
  it('reports the item a one-item bulk actually targets', () => {
    // The exact shape MediaBulkService.refreshMetadata sends.
    expect(summarizeMediaJobInput({ libraryId: null, payload: { itemIds: ['item-1'] } }))
      .toEqual({ itemId: 'item-1' });
  });

  it('never emits a null for a field the caller did not use', () => {
    const out = summarizeMediaJobInput({ libraryId: null, payload: { itemIds: ['item-1'] } });
    expect(Object.values(out)).not.toContain(null);
    expect(out).not.toHaveProperty('libraryId');
  });

  it('lists the targets when a bulk covers several', () => {
    expect(summarizeMediaJobInput({ libraryId: null, payload: { itemIds: ['a', 'b', 'c'] } }))
      .toEqual({ itemIds: ['a', 'b', 'c'] });
  });

  it('keeps the direct fields when a caller does use them', () => {
    expect(summarizeMediaJobInput({ libraryId: 'lib-1', itemId: 'item-9' }))
      .toEqual({ libraryId: 'lib-1', itemId: 'item-9' });
  });

  it('surfaces the rest of the payload rather than hiding it', () => {
    expect(summarizeMediaJobInput({ payload: { itemIds: ['x'], permanent: true, profile: 'plex' } }))
      .toEqual({ itemId: 'x', permanent: true, profile: 'plex' });
  });

  it('returns an empty summary for a job that genuinely had no input', () => {
    expect(summarizeMediaJobInput({})).toEqual({});
    expect(summarizeMediaJobInput(undefined)).toEqual({});
  });
});
