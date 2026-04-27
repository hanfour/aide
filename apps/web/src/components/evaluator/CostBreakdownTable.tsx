"use client";

interface Row {
  label: string;
  calls: number;
  costUsd: number;
}

function fmtUsd(v: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(v);
}

export function CostBreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: Row[];
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase text-muted-foreground">
            <th className="font-medium py-1">Item</th>
            <th className="font-medium py-1 text-right">Calls</th>
            <th className="font-medium py-1 text-right">USD</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={3}
                className="py-2 text-muted-foreground italic"
              >
                No usage this month.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.label} className="border-b last:border-b-0">
                <td className="py-1.5">{r.label}</td>
                <td className="py-1.5 text-right tabular-nums">{r.calls}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {fmtUsd(r.costUsd)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
