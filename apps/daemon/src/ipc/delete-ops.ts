import { OpError, type Router } from './router.js';
import type { DeleteService } from '../services/delete-service.js';

export interface DeleteOpsDeps {
  deletes: DeleteService;
  /** Fired once post-commit after every successful range deletion. */
  onChanged: () => void;
}

/**
 * `delete.range {from,to} | {preset}` (contracts §Protocol v1, spec §3.23).
 * Param forms are mutually exclusive: either BOTH from+to or exactly one
 * preset. The three *_changed events (episodes/memories/workflows) are folded
 * into one callback that the daemon wires to all three broadcasts — they fire
 * only AFTER the deletion transaction committed.
 */
export function registerDeleteOps(router: Router, deps: DeleteOpsDeps): void {
  router.register('delete.range', (params) => {
    const hasBounds = params.from !== undefined || params.to !== undefined;
    if (params.preset !== undefined && hasBounds) {
      throw new OpError('error.invalid_params', 'delete.range accepts preset OR from/to, not both');
    }
    if (params.preset === undefined && (params.from === undefined || params.to === undefined)) {
      throw new OpError('error.invalid_params', 'delete.range requires both from and to, or a preset');
    }
    if (params.from !== undefined && params.to !== undefined && params.from > params.to) {
      throw new OpError('error.invalid_params', 'delete.range requires from <= to');
    }
    const deleted = deps.deletes.deleteRange(params);
    // Broadcast committed state BEFORE answering: clients must already have
    // the *_changed truth when the result frame arrives.
    deps.onChanged();
    return { deleted };
  });
}
