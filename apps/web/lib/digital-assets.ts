export const DIGITAL_ASSET_MAX_PRICE = 9_999_999_999.99;
export const DIGITAL_ASSET_MIN_BAR_WIDTH = 8;
export const DIGITAL_ASSET_MIN_TRACK_WIDTH = 640;
export const DIGITAL_ASSET_TICK_MIN_GAP = 64;
export const DIGITAL_ASSET_EDGE_TICK_MIN_GAP = 88;

const MILLISECONDS_PER_DAY = 86_400_000;
const STRICT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRICE_PATTERN = /^\d+(?:\.\d{1,2})?$/;

export type DigitalAsset = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  renewalPrice: number;
  renewalUrl: string;
  createdAt?: string;
  updatedAt?: string;
};

export type DigitalAssetPayload = Pick<
  DigitalAsset,
  'name' | 'startDate' | 'endDate' | 'renewalPrice' | 'renewalUrl'
>;

export type DigitalAssetFormValues = {
  name: string;
  startDate: string;
  endDate: string;
  renewalPrice: string;
  renewalUrl: string;
};

export type DigitalAssetFormErrors = Partial<Record<keyof DigitalAssetFormValues, string>>;

export type DigitalAssetRange = {
  startDate: string;
  endDate: string;
  startDay: number;
  endDay: number;
  totalDays: number;
};

export type DigitalAssetStatus = 'upcoming' | 'active' | 'expiring' | 'expired';

export type DigitalAssetTimelineTick = {
  date: string;
  label: string;
  position: number;
};

export const DIGITAL_ASSET_STATUS_LABELS: Record<DigitalAssetStatus, string> = {
  upcoming: '未开始',
  active: '生效中',
  expiring: '30 天内到期',
  expired: '已到期',
};

const shanghaiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function todayInShanghai(now = new Date()): string {
  const parts = shanghaiDateFormatter.formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function parseUTCDate(value: string): number | null {
  if (!STRICT_DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(parsed.getTime() / MILLISECONDS_PER_DAY);
}

export function formatUTCDate(day: number): string {
  return new Date(day * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

function requiredUTCDate(value: string): number {
  const day = parseUTCDate(value);
  if (day === null) throw new RangeError(`Invalid UTC calendar date: ${value}`);
  return day;
}

export function canRequestDigitalAssets(state: string): boolean {
  return state === 'authenticated';
}

export function emptyDigitalAssetForm(): DigitalAssetFormValues {
  return {
    name: '',
    startDate: '',
    endDate: '',
    renewalPrice: '',
    renewalUrl: '',
  };
}

export function digitalAssetFormFromRecord(asset: DigitalAsset): DigitalAssetFormValues {
  return {
    name: asset.name,
    startDate: asset.startDate,
    endDate: asset.endDate,
    renewalPrice: formatRenewalPrice(asset.renewalPrice),
    renewalUrl: asset.renewalUrl,
  };
}

export function validateDigitalAssetForm(values: DigitalAssetFormValues): {
  errors: DigitalAssetFormErrors;
  payload: DigitalAssetPayload | null;
} {
  const errors: DigitalAssetFormErrors = {};
  const name = values.name.trim();
  const renewalPrice = values.renewalPrice.trim();
  const renewalUrl = values.renewalUrl.trim();
  const startDay = parseUTCDate(values.startDate);
  const endDay = parseUTCDate(values.endDate);

  if (!name) errors.name = '请输入资产名称。';
  else if (Array.from(name).length > 160) errors.name = '资产名称不能超过 160 个字符。';

  if (startDay === null) errors.startDate = '请选择有效的开始日期。';
  if (endDay === null) errors.endDate = '请选择有效的结束日期。';
  else if (startDay !== null && endDay < startDay) errors.endDate = '结束日期不能早于开始日期。';

  if (!PRICE_PATTERN.test(renewalPrice)) {
    errors.renewalPrice = '续费价格必须是非负数字，且最多保留两位小数。';
  } else {
    const parsedPrice = Number(renewalPrice);
    if (!Number.isFinite(parsedPrice) || parsedPrice > DIGITAL_ASSET_MAX_PRICE) {
      errors.renewalPrice = `续费价格不能超过 ${DIGITAL_ASSET_MAX_PRICE.toFixed(2)}。`;
    }
  }

  if (!renewalUrl) {
    errors.renewalUrl = '请输入续费地址。';
  } else if (Array.from(renewalUrl).length > 2048) {
    errors.renewalUrl = '续费地址不能超过 2048 个字符。';
  } else {
    try {
      const parsedUrl = new URL(renewalUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
        errors.renewalUrl = '续费地址必须是有效的 HTTP 或 HTTPS URL。';
      }
    } catch {
      errors.renewalUrl = '续费地址必须是有效的 HTTP 或 HTTPS URL。';
    }
  }

  if (Object.keys(errors).length > 0) return { errors, payload: null };
  return {
    errors,
    payload: {
      name,
      startDate: values.startDate,
      endDate: values.endDate,
      renewalPrice: Number(renewalPrice),
      renewalUrl,
    },
  };
}

export function buildDigitalAssetRange(assets: DigitalAsset[], today: string): DigitalAssetRange {
  const todayDay = requiredUTCDate(today);
  let startDay = todayDay;
  let endDay = todayDay;

  for (const asset of assets) {
    startDay = Math.min(startDay, requiredUTCDate(asset.startDate));
    endDay = Math.max(endDay, requiredUTCDate(asset.endDate));
  }

  return {
    startDate: formatUTCDate(startDay),
    endDate: formatUTCDate(endDay),
    startDay,
    endDay,
    totalDays: endDay - startDay + 1,
  };
}

export function digitalAssetStatus(asset: DigitalAsset, today: string): DigitalAssetStatus {
  const todayDay = requiredUTCDate(today);
  const startDay = requiredUTCDate(asset.startDate);
  const endDay = requiredUTCDate(asset.endDate);
  if (endDay < todayDay) return 'expired';
  if (startDay > todayDay) return 'upcoming';
  if (endDay - todayDay <= 30) return 'expiring';
  return 'active';
}

export function digitalAssetTimelineWidth(range: DigitalAssetRange): number {
  return Math.max(
    DIGITAL_ASSET_MIN_TRACK_WIDTH,
    Math.min(12_000, Math.ceil(range.totalDays * 2.4)),
  );
}

export function digitalAssetBar(
  asset: DigitalAsset,
  range: DigitalAssetRange,
  trackWidth: number,
): { left: number; width: number } {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) {
    throw new RangeError('Digital asset track width must be positive.');
  }
  const visibleStart = Math.max(requiredUTCDate(asset.startDate), range.startDay);
  const visibleEnd = Math.min(requiredUTCDate(asset.endDate), range.endDay);
  const rawLeft = ((visibleStart - range.startDay) / range.totalDays) * trackWidth;
  const rawWidth = ((visibleEnd - visibleStart + 1) / range.totalDays) * trackWidth;
  const width = Math.min(trackWidth, Math.max(rawWidth, DIGITAL_ASSET_MIN_BAR_WIDTH));
  const centeredLeft = rawLeft - (width - rawWidth) / 2;
  const left = Math.min(Math.max(centeredLeft, 0), trackWidth - width);
  return { left: Number(left.toFixed(2)), width: Number(width.toFixed(2)) };
}

export function digitalAssetDateCenter(
  date: string,
  range: DigitalAssetRange,
  trackWidth: number,
): number {
  const day = requiredUTCDate(date);
  const position = ((day - range.startDay + 0.5) / range.totalDays) * trackWidth;
  return Number(Math.min(Math.max(position, 0), trackWidth).toFixed(2));
}

export function buildDigitalAssetTimelineTicks(
  range: DigitalAssetRange,
  trackWidth: number,
): DigitalAssetTimelineTick[] {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) {
    throw new RangeError('Digital asset track width must be positive.');
  }

  const approximateMonths = Math.max(1, Math.ceil(range.totalDays / 30));
  const monthStep = approximateMonths > 120 ? 12 : approximateMonths > 60 ? 6 : approximateMonths > 30 ? 3 : 1;
  const ticks = new Map<number, string>();
  ticks.set(range.startDay, range.startDate);

  const cursor = new Date(range.startDay * MILLISECONDS_PER_DAY);
  cursor.setUTCDate(1);
  cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  let monthIndex = 0;
  while (Math.floor(cursor.getTime() / MILLISECONDS_PER_DAY) < range.endDay) {
    const day = Math.floor(cursor.getTime() / MILLISECONDS_PER_DAY);
    if (monthIndex % monthStep === 0) {
      ticks.set(day, `${cursor.getUTCFullYear()}年${cursor.getUTCMonth() + 1}月`);
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    monthIndex += 1;
  }
  ticks.set(range.endDay, range.endDate);

  const timelineTicks = [...ticks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([day, label]) => ({
      date: formatUTCDate(day),
      label,
      position: range.totalDays === 1 ? 0 : day === range.endDay ? 1 : (day - range.startDay) / range.totalDays,
    }));
  if (timelineTicks.length <= 2) return timelineTicks;

  // Endpoint labels show full dates and are anchored inward, while month labels
  // are centered. Reserve extra pixels near both edges so a nearby month boundary
  // cannot paint over the first or last date, then keep regular ticks separated.
  const firstTick = timelineTicks[0];
  const lastTick = timelineTicks[timelineTicks.length - 1];
  const firstPosition = firstTick.position * trackWidth;
  const lastPosition = lastTick.position * trackWidth;
  const visibleTicks: DigitalAssetTimelineTick[] = [firstTick];
  let previousPosition = firstPosition;

  for (const tick of timelineTicks.slice(1, -1)) {
    const position = tick.position * trackWidth;
    if (
      position - firstPosition < DIGITAL_ASSET_EDGE_TICK_MIN_GAP ||
      lastPosition - position < DIGITAL_ASSET_EDGE_TICK_MIN_GAP ||
      position - previousPosition < DIGITAL_ASSET_TICK_MIN_GAP
    ) {
      continue;
    }
    visibleTicks.push(tick);
    previousPosition = position;
  }

  visibleTicks.push(lastTick);
  return visibleTicks;
}

export function sortDigitalAssets(assets: DigitalAsset[]): DigitalAsset[] {
  return [...assets].sort((left, right) =>
    left.endDate.localeCompare(right.endDate) ||
    left.name.localeCompare(right.name, 'zh-CN') ||
    left.id.localeCompare(right.id),
  );
}

export function formatRenewalPrice(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}
