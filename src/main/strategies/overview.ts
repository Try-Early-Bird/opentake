import type { BasketOverviewRow, BasketView, BasketRowDetail, ProposalPayload } from '../../shared/strategies';
import type { createStrategies } from './service';
import type { createCoinbaseCapital } from '../coinbase/capital';

/** Keep published display and the oldest loaded version, without sending history. */
export function overviewDetail(view: BasketView | null): BasketRowDetail | null {
  if (!view) return null;
  const payload = (value: ProposalPayload) => ({ metadata: { description: value.metadata.description }, spec: value.spec });
  const current = view.versions.find(v => v.id === view.currentVersion);
  const oldest = view.versions.reduce<typeof current>((first, v) => !first || v.sequence < first.sequence ? v : first, undefined);
  const versions = [...new Set([current, oldest])].filter(v => v !== undefined);
  return { iconId: view.iconId, currentVersion: view.currentVersion, draft: payload(view.draft),
    versions: versions.map(v => ({ id: v.id, sequence: v.sequence, createdAt: v.createdAt, payload: payload(v.payload) })) };
}

/** The list's read-only branch; account evidence is shared only within this call. */
export function createTakeOverview(
  strategies: Pick<ReturnType<typeof createStrategies>, 'list' | 'readMany'>,
  capital: Pick<ReturnType<typeof createCoinbaseCapital>, 'viewMany'>,
) {
  return async (archived = false): Promise<BasketOverviewRow[]> => {
    const rows = await strategies.list(archived);
    const ids = rows.map(row => row.targetTakeId);
    const [details, funding] = await Promise.all([
      strategies.readMany(ids), capital.viewMany(ids, true),
    ]);
    return rows.map(row => ({ row, detail: overviewDetail(details[row.targetTakeId] ?? null), funding: funding[row.targetTakeId] ?? null }));
  };
}
