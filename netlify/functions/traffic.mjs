// POST /api/traffic — drive time with traffic and the latest time to leave.
import { handle, json, body, checkOrigin, point, HttpError } from '../lib/common.mjs';
import { plan } from '../lib/traffic.mjs';

export default handle(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
  checkOrigin(req);
  const b = await body(req);
  const start = point(b.start), end = point(b.end);
  const arriveBy = b.arriveBy ? +b.arriveBy : null;
  if (arriveBy && arriveBy < Date.now() - 60000) throw new HttpError(400, 'That arrival time has already passed.');
  if (arriveBy && arriveBy > Date.now() + 8 * 86400000) throw new HttpError(400, 'Plan drives up to a week ahead.');
  const departAt = !arriveBy && b.departAt ? +b.departAt : null;
  if (departAt && departAt > Date.now() + 8 * 86400000) throw new HttpError(400, 'Plan drives up to a week ahead.');
  return json(await plan({ start, end, arriveBy, buffer: b.buffer, departAt: departAt && departAt > Date.now() ? departAt : null }));
});

export const config = { path: '/api/traffic' };
