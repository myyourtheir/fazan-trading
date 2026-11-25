import { Field, FieldLabel, Input } from '@/shared/ui';

const fields = {
  atrPeriod: ['Период ATR', 1, 1],
  stopAtrMultiplier: ['Стоп, множитель ATR', 0.0001, 'any'],
  addStepAtr: ['Шаг добора, ATR', 0.0001, 'any'],
  maxAddOns: ['Максимум доборов', 0, 1],
} as const;

export type ImprovedDraft = { [K in keyof typeof fields]: string } & { tradeWeekends: boolean };

export function ImprovedBacktestFields({
  draft,
  maxPeriod,
  onChange,
}: {
  draft: ImprovedDraft;
  maxPeriod?: number;
  onChange: (draft: ImprovedDraft) => void;
}) {
  return (
    <>
      {(Object.keys(fields) as (keyof typeof fields)[]).map((key) => {
        const [label, min, step] = fields[key];
        return (
          <Field key={key}>
            <FieldLabel htmlFor={`backtest-${key}`}>{label}</FieldLabel>
            <Input
              id={`backtest-${key}`}
              type="number"
              required
              min={min}
              max={
                key === 'atrPeriod' ? maxPeriod : key === 'maxAddOns' ? 2_147_483_647 : undefined
              }
              step={step}
              value={draft[key]}
              onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
            />
          </Field>
        );
      })}
      <Field className="sm:col-span-2">
        <FieldLabel>
          <input
            type="checkbox"
            checked={draft.tradeWeekends}
            onChange={(event) => onChange({ ...draft, tradeWeekends: event.target.checked })}
          />
          Торговать по выходным
        </FieldLabel>
      </Field>
    </>
  );
}
