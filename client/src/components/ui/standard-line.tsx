/**
 * `StandardLine` — actual against the breed standard, over age or time.
 *
 * A solid line of what happened with dots on the readings, and a grey dashed
 * line of what the guide says, on the same axes. House detail drew the first
 * three (feed, water, eggs); the weekly management summary, body weight, a
 * flock's cumulative mortality and the live preview in Breeds & Standards are
 * the same chart. One of the six shared shapes in docs/ui-visuals-plan.md.
 *
 * recharts, because this is a real time series with a tooltip and a legend;
 * everything smaller in the app is drawn by hand.
 */
import type { ReactElement } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

/**
 * recharts 3 types the Tooltip's `formatter` and `labelFormatter` far more
 * tightly than these charts were written against; widening it once here keeps
 * every call site plain.
 */
const Tooltip = RechartsTooltip as unknown as (props: Record<string, unknown>) => ReactElement;

/* Grey dashed for the standard, on every chart; the actual takes the brand
   token unless the caller has a colour of its own (the farm charts keep the
   shed palette). */
const STANDARD = "#9ca3af";

export function StandardLine<T extends Record<string, unknown>>({
  data,
  xKey,
  actualKey,
  standardKey,
  unit,
  xLabel,
  domain,
  stroke = "var(--color-brand-600)",
  heightClass = "h-[200px] sm:h-[250px] md:h-[300px]",
  tooltipLabel,
  actualName = "Actual",
  standardName = "Standard",
}: {
  data: T[];
  xKey: keyof T & string;
  actualKey: keyof T & string;
  /** Leave unset when there is no standard to draw — the legend then shows only the actual. */
  standardKey?: keyof T & string;
  /** "g", "ml", "kg", "%" — a percent sits flush, anything else after a space. */
  unit: string;
  xLabel?: string;
  domain?: [number, number];
  stroke?: string;
  heightClass?: string;
  /** The tooltip's heading for a row — the house charts add the age week here. */
  tooltipLabel?: (row: T) => string;
  actualName?: string;
  standardName?: string;
}) {
  const withUnit = (v: number) => (unit === "%" ? `${v}%` : `${v} ${unit}`);
  return (
    <div className={heightClass}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey={xKey as string}
            tick={{ fontSize: 10 }}
            label={xLabel ? { value: xLabel, position: "bottom", fontSize: 10, offset: -5 } : undefined}
          />
          <YAxis tick={{ fontSize: 10 }} domain={domain} />
          <Tooltip
            formatter={(value: number, name: string) => [withUnit(value), name]}
            labelFormatter={(label: string, items: Array<{ payload?: T }>) =>
              tooltipLabel && items?.[0]?.payload ? tooltipLabel(items[0].payload) : label
            }
          />
          <Legend />
          <Line type="monotone" dataKey={actualKey as string} stroke={stroke} strokeWidth={2} dot={{ r: 3 }} name={actualName} />
          {standardKey && (
            <Line
              type="monotone"
              dataKey={standardKey as string}
              stroke={STANDARD}
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              name={standardName}
              connectNulls
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
