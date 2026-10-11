/** Vietnam local opening schedule independent of server UTC or DST. */
export interface DayRule {
  date: string;                 // YYYY-MM-DD Asia/Ho_Chi_Minh
  open: string;                 // HH:mm, may be outside default hours
  close: string;
  ai_paused?: boolean;
  shop_holiday?: boolean;       // advising allowed; printing controlled elsewhere
}
export interface Schedule {
  paused: boolean;
  overrides: Readonly<Record<string, DayRule>>;
}
const vietnam = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
export function vietnamClock(at: Date): { date: string; minute: number } {
  const parts = Object.fromEntries(vietnam.formatToParts(at).map(p => [p.type,p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}
function parseMinute(hhmm: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) throw new Error("INVALID_SCHEDULE_TIME");
  const [hour, minute] = hhmm.split(":").map(Number);
  return hour * 60 + minute;
}
export function scheduleDecision(at: Date, setting: Schedule): {
  ai_allowed: boolean; shop_holiday: boolean; reason: string;
} {
  const {date,minute} = vietnamClock(at);
  if (setting.paused) return { ai_allowed:false, shop_holiday:false, reason:"PAUSED" };
  const day = setting.overrides[date];
  if (day?.ai_paused) return { ai_allowed:false, shop_holiday:!!day.shop_holiday, reason:"DAY_PAUSED" };
  const from = day ? parseMinute(day.open) : 7 * 60;
  const to = day ? parseMinute(day.close) : 21 * 60 + 30;
  if (from > to) throw new Error("OVERNIGHT_SCHEDULE_REQUIRES_EXPLICIT_DATES");
  return { ai_allowed:minute >= from && minute < to,
    shop_holiday:!!day?.shop_holiday,
    reason: minute >= from && minute < to ? "OPEN" : "OUT_OF_HOURS" };
}
