import type { BacktestAdapter } from './backtest-history.js';
import type { BacktestBaseParameters } from './backtest.js';
import type { MarketCandle, MarketHistory } from './market-data.js';
import type { FindSignal, TradingConfig } from './robot.js';

// Strategies define only their own parameters and observations. Execution is owned by adapters.
export type StrategyDecision<State, Explanation> = {
  state: State;
  signal: { targetPosition: number; explanation: Explanation } | null;
};

export type StrategyDefinition<
  Kind extends string,
  Parameters,
  State,
  Observation,
  Explanation,
  LiveConfig extends TradingConfig,
  BacktestParameters extends BacktestBaseParameters,
  BacktestCandle extends MarketCandle,
  BacktestState,
  LiveHistory = MarketHistory,
> = {
  kind: Kind;
  validate(value: unknown): value is Parameters;
  decide(
    state: State,
    observation: Observation,
    parameters: Parameters,
  ): StrategyDecision<State, Explanation>;
  live: FindSignal<LiveConfig, LiveHistory>;
  backtest: BacktestAdapter<BacktestParameters, BacktestCandle, BacktestState>;
};

export function defineStrategy<
  Kind extends string,
  Parameters,
  State,
  Observation,
  Explanation,
  LiveConfig extends TradingConfig,
  BacktestParameters extends BacktestBaseParameters,
  BacktestCandle extends MarketCandle,
  BacktestState,
  LiveHistory = MarketHistory,
>(
  definition: Omit<
    StrategyDefinition<
      Kind,
      Parameters,
      State,
      Observation,
      Explanation,
      LiveConfig,
      BacktestParameters,
      BacktestCandle,
      BacktestState,
      LiveHistory
    >,
    'live' | 'backtest'
  > & {
    live(
      decide: StrategyDefinition<
        Kind,
        Parameters,
        State,
        Observation,
        Explanation,
        LiveConfig,
        BacktestParameters,
        BacktestCandle,
        BacktestState,
        LiveHistory
      >['decide'],
    ): FindSignal<LiveConfig, LiveHistory>;
    backtest(
      decide: StrategyDefinition<
        Kind,
        Parameters,
        State,
        Observation,
        Explanation,
        LiveConfig,
        BacktestParameters,
        BacktestCandle,
        BacktestState,
        LiveHistory
      >['decide'],
    ): BacktestAdapter<BacktestParameters, BacktestCandle, BacktestState>;
  },
): StrategyDefinition<
  Kind,
  Parameters,
  State,
  Observation,
  Explanation,
  LiveConfig,
  BacktestParameters,
  BacktestCandle,
  BacktestState,
  LiveHistory
> {
  return {
    ...definition,
    live: definition.live(definition.decide),
    backtest: definition.backtest(definition.decide),
  };
}
