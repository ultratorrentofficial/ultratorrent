import { BadRequestException } from '@nestjs/common';
import { PERMISSIONS } from '@ultratorrent/shared';

import { SeriesAcquisitionController } from '../series-acquisition.controller';

function make() {
  const provisioning: any = {
    planSeriesAcquisition: jest.fn().mockResolvedValue({ ready: true }),
    provisionSeriesAcquisition: jest.fn().mockResolvedValue({ watchlistItemId: 'wl1' }),
  };
  const backfill: any = {
    latestJob: jest.fn().mockResolvedValue(null),
    pause: jest.fn().mockResolvedValue(true),
    resume: jest.fn().mockResolvedValue({ jobId: 'j' }),
    cancel: jest.fn().mockResolvedValue(true),
  };
  const showStatus: any = { searchShows: jest.fn().mockResolvedValue([]) };
  const ctrl = new SeriesAcquisitionController(provisioning, backfill, showStatus);
  return { ctrl, provisioning, backfill, showStatus };
}

const req: any = { headers: {}, ip: '127.0.0.1' };
const user = (permissions: string[], roles: string[] = []): any => ({ id: 'u1', roles, permissions });

describe('SeriesAcquisitionController', () => {
  it('provisions a normal series for a watchlist-manager', async () => {
    const { ctrl, provisioning } = make();
    await ctrl.provision(
      { title: 'Show', mode: 'backfill_and_monitor' } as any,
      user([PERMISSIONS.MEDIA_ACQUISITION_MANAGE_WATCHLIST]),
      req,
    );
    expect(provisioning.provisionSeriesAcquisition).toHaveBeenCalled();
  });

  it('rejects an unknown backfill action', async () => {
    const { ctrl } = make();
    await expect(ctrl.backfillControl('job1', 'destroy')).rejects.toThrow(BadRequestException);
  });

  it('routes a valid backfill action to the service', async () => {
    const { ctrl, backfill } = make();
    await ctrl.backfillControl('job1', 'pause');
    expect(backfill.pause).toHaveBeenCalledWith('job1');
  });
});
