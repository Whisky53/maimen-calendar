/**
 * iCalendar (.ics) 生成器 —— 零依赖。
 *
 * 用途：
 *   1) 导出「吃饭提醒 + 训练计划 + 活动日」为 .ics，双击导入
 *      苹果日历 / 谷歌日历 / Outlook / 系统日历
 *   2) 配合本地服务可做长期「订阅链接」（webcal:// 或 http://）
 *
 * 规范依据：RFC 5545。关键点：
 *   - 行以 CRLF 分隔
 *   - 长行需折行（每 75 字节）
 *   - 文本要转义 \ , ; 和换行
 *   - 本地时间用 DTSTART;TZID=Asia/Shanghai，或直接用 UTC（...Z）
 */

const CRLF = "\r\n";
const PRODID = "-//maimen-calendar//麦门日历//CN";
/** UID 域名后缀，保持稳定，便于客户端识别同一来源事件。 */
const UID_DOMAIN = "maimen.local";

/** 转义 iCalendar 文本值。 */
export function escapeText(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** 按 75 字节折行（RFC 5545 §3.1）。 */
export function foldLine(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = Buffer.alloc(0);
  for (const ch of line) {
    const b = Buffer.from(ch, "utf8");
    // 续行首字节算 1（空格），保守用 74
    const limit = out.length === 0 ? 75 : 74;
    if (cur.length + b.length > limit) {
      out.push(cur.toString("utf8"));
      cur = Buffer.from(ch, "utf8");
    } else {
      cur = Buffer.concat([cur, b]);
    }
  }
  if (cur.length) out.push(cur.toString("utf8"));
  return out.join(CRLF + " ");
}

/** 本地时间 → iCalendar 本地时间格式（YYYYMMDDTHHMMSS）。 */
export function fmtLocal(date) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `T${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** 本地时间 → UTC 格式（带 Z）。 */
export function fmtUtc(date) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/**
 * 生成一个 VEVENT 块。
 * @param {object} ev
 * @param {string} ev.uid
 * @param {string} ev.summary
 * @param {Date}   ev.start
 * @param {number} [ev.minutes]      时长（默认 30）
 * @param {string} [ev.description]
 * @param {string} [ev.location]
 * @param {number} [ev.alarmMinutes] 提前提醒分钟数
 * @param {boolean}[ev.allDay]
 * @param {number} [ev.sequence]     修订号，更新同一 UID 事件时递增（默认 0）
 * @param {Date}   [ev.lastModified] 最后修改时间（默认取当前时刻）
 */
export function vevent(ev) {
  const minutes = ev.minutes || 30;
  const end = new Date(ev.start.getTime() + minutes * 60000);
  const lines = ["BEGIN:VEVENT"];
  lines.push(`UID:${ev.uid}`);
  // 更新已存在事件时保留 UID，并靠 SEQUENCE 递增 + LAST-MODIFIED 让客户端识别为「修订」
  lines.push(`SEQUENCE:${Number.isFinite(ev.sequence) ? ev.sequence : 0}`);
  lines.push(`DTSTAMP:${fmtUtc(new Date())}`);
  lines.push(`LAST-MODIFIED:${fmtUtc(ev.lastModified || new Date())}`);
  if (ev.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${fmtLocal(ev.start).slice(0, 8)}`);
  } else {
    lines.push(`DTSTART:${fmtLocal(ev.start)}`);
    lines.push(`DTEND:${fmtLocal(end)}`);
  }
  lines.push(`SUMMARY:${escapeText(ev.summary)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
  lines.push("TRANSP:OPAQUE");
  if (ev.alarmMinutes != null) {
    lines.push("BEGIN:VALARM");
    lines.push(`TRIGGER:-PT${ev.alarmMinutes}M`);
    lines.push("ACTION:DISPLAY");
    lines.push(`DESCRIPTION:${escapeText(ev.summary)}`);
    lines.push("END:VALARM");
  }
  lines.push("END:VEVENT");
  return lines;
}

/**
 * 生成完整 .ics 文件内容。
 * @param {Array} events vevent 的参数数组
 * @param {object} [meta] { calendarName }
 */
export function buildIcs(events = [], meta = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  if (meta.calendarName) {
    lines.push(`X-WR-CALNAME:${escapeText(meta.calendarName)}`);
    lines.push(`NAME:${escapeText(meta.calendarName)}`);
  }
  lines.push("X-WR-TIMEZONE:Asia/Shanghai");
  lines.push(...timezoneBlock());
  for (const ev of events) lines.push(...vevent(ev));
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** 内嵌 Asia/Shanghai 时区定义，保证各客户端显示正确。 */
function timezoneBlock() {
  return [
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "TZNAME:CST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
}

/**
 * 构造稳定 UID。
 *
 * 规则（需求说明书 §8）：`<userScope>-<planId>-<date>-<slot|instance>-<type>`
 *   - 不使用列表序号、不使用标题 —— 否则重排后客户端会「新增一条」而不是「更新一条」
 *   - 同一日早餐与晚餐 slot 不同 → UID 不同，可共存
 *   - 同一餐次的提醒与事件本身 type 不同 → UID 不同
 *
 * @param {object} p
 * @param {string} p.userScope  用户范围标识（如 "local" 或用户 id）
 * @param {string} p.planId     计划标识（同一份日历计划内唯一）
 * @param {string} p.date       YYYY-MM-DD
 * @param {string} p.slot       餐次或实例标识：breakfast/lunch/dinner/late-night/snack/training
 * @param {string} p.type       事件类型：meal | reminder | training | campaign
 */
export function buildUid({ userScope = "local", planId = "default", date, slot = "event", type = "meal" }) {
  const safe = (s) => String(s == null ? "" : s).replace(/[^A-Za-z0-9-]/g, "-");
  return `${safe(userScope)}-${safe(planId)}-${safe(date)}-${safe(slot)}-${safe(type)}@${UID_DOMAIN}`;
}

/**
 * 把日程项（吃饭提醒/训练/活动）翻译成 vevent 参数。
 *
 * @param {object} item
 * @param {string} item.date       YYYY-MM-DD
 * @param {string} item.time       HH:MM
 * @param {string} item.kind       meal | training | campaign
 * @param {string} item.title
 * @param {string} [item.desc]
 * @param {string} [item.slot]     餐次：breakfast/lunch/dinner/late-night/snack；training 用 "training"
 * @param {string} [item.uid]      显式指定的 UID（优先级最高）
 * @param {string} [item.userScope] 用户范围，默认 "local"
 * @param {string} [item.planId]   计划标识，默认 "default"
 * @param {number} [item.minutes]
 * @param {number} [item.alarmMinutes]
 * @param {number} [item.sequence]
 * @param {Date}   [item.lastModified]
 */
export function toEvent(item) {
  const [h, m] = (item.time || "12:00").split(":").map(Number);
  const start = new Date(`${item.date}T00:00:00`);
  start.setHours(h || 12, m || 0, 0, 0);
  const slot =
    item.slot || (item.kind === "training" ? "training" : item.kind === "campaign" ? "campaign" : "event");
  return {
    uid:
      item.uid ||
      buildUid({
        userScope: item.userScope || "local",
        planId: item.planId || "default",
        date: item.date,
        slot,
        type: item.kind || "meal",
      }),
    summary: item.title,
    start,
    minutes: item.minutes || 30,
    description: item.desc || "",
    location: item.location || "",
    alarmMinutes: item.alarmMinutes != null ? item.alarmMinutes : 15,
    sequence: item.sequence,
    lastModified: item.lastModified,
  };
}

/**
 * 从「日历计划」生成 .ics。
 * @param {Array} schedule [{date,time,kind,title,desc,slot,minutes,alarmMinutes}]
 */
export function scheduleToIcs(schedule, meta = {}) {
  const events = schedule.map((s) => toEvent(s));
  return buildIcs(events, meta);
}
