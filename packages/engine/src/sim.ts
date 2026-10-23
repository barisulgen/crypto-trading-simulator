import type { Decimal } from './decimal.ts';
import { deposit, transfer } from './account/ledger.ts';
import type { Ledger } from './account/ledger.ts';
import type { SpotEngine } from './spot/engine.ts';
import type { ActionResult, EngineCtx, Wallet } from './types.ts';

/** The whole simulated account: one ledger shared by the market engines, and the wallet actions. */
export class SimEngine {
  constructor(
    readonly ledger: Ledger,
    readonly spot: SpotEngine,
  ) {}

  deposit(wallet: Wallet, amount: Decimal, ctx: EngineCtx): ActionResult {
    return deposit(this.ledger, wallet, amount, ctx);
  }

  transfer(from: Wallet, to: Wallet, amount: Decimal, ctx: EngineCtx): ActionResult {
    return transfer(this.ledger, from, to, amount, ctx);
  }
}
