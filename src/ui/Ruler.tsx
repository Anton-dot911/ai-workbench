/** Лінійка-індикатор: заповнення показує значення, жовта мітка — ліміт. */
export function Ruler({ value, max, label }: { value: number; max: number; label: string }) {
  const scale = Math.max(max, value, 1e-9);
  const over = value > max;
  return (
    <div className="gauge" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <i className={over ? "over" : ""} style={{ width: `${(value / scale) * 100}%` }} />
      <b style={{ left: `calc(${(max / scale) * 100}% - 3px)` }} />
    </div>
  );
}
