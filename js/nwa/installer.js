// Ties linking and USB together: link first (nothing is touched on the calculator),
// then erase + write + restart.
import { AppGroup, regionFromInfos } from './linker.js';

/**
 * @param calculator  a Calculator (already identified with extractInfos)
 * @param apps        NwaApp[]
 * @param opts        { dryRun, onStage(text), onProgress(0..1) }
 */
export async function installApps(calculator, apps, { dryRun = false, onStage = () => {}, onProgress = () => {} } = {}) {
  const group = new AppGroup();
  apps.forEach((a) => group.push(a));
  if (!group.isReadyToUpload()) throw new Error('Some apps still need an external data file.');

  onStage('Reading calculator…');
  await calculator.process((c) => c.extractInfos());
  const region = regionFromInfos(calculator.infos);
  if (group.totalSize() > region.flashLength)
    throw new Error('Not enough room: ' + Math.round(group.totalSize() / 1024) + ' KB of apps for ' + Math.round(region.flashLength / 1024) + ' KB of space.');

  const image = await group.flatBin(region, (i, app) => onStage('Linking ' + (app.name || app.label || 'app ' + (i + 1)) + '…'));
  if (dryRun) return { image, region, written: false };

  onStage('Writing to calculator…');
  await calculator.process(async (c) => {
    await c.downloadFlash(region.flashStart, image, (p) => onProgress(0.2 * p), (p) => onProgress(0.2 + 0.8 * p));
    onStage('Restarting calculator…');
    await c.dfu.leave(region.flashStart);
  });
  return { image, region, written: true };
}
