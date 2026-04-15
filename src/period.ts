import dayjs from "dayjs";

export function resolvePresetPeriod(
  preset: "monthly" | "quarterly",
  previous: boolean,
): { since: string; until: string } {
  if (preset === "monthly") {
    const base = previous ? dayjs().subtract(1, "month") : dayjs();
    return {
      since: base.startOf("month").format("YYYY-MM-DD"),
      until: (previous ? base.endOf("month") : dayjs()).format("YYYY-MM-DD"),
    };
  }

  const now = dayjs();
  const month = now.month();
  const quarterStartMonth = Math.floor(month / 3) * 3;
  let start = now.month(quarterStartMonth).startOf("month");
  let end = now;

  if (previous) {
    end = start.subtract(1, "day").endOf("day");
    const previousQuarterStartMonth = Math.floor(end.month() / 3) * 3;
    start = end.month(previousQuarterStartMonth).startOf("month");
  }

  return {
    since: start.format("YYYY-MM-DD"),
    until: end.format("YYYY-MM-DD"),
  };
}
