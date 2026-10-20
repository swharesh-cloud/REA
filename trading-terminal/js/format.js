const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatPrice(value) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const digits = absolute >= 100 ? 2 : absolute >= 1 ? 4 : absolute >= 0.01 ? 6 : 8;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: absolute >= 100 ? 2 : 0,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatPercent(fraction, digits = 2) {
  if (!Number.isFinite(fraction)) return "—";
  const percent = fraction * 100;
  const sign = percent > 0 ? "+" : "";
  return `${sign}${percent.toFixed(digits)}%`;
}

export function formatPlainPercent(fraction, digits = 2) {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatVolume(value) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return formatPrice(value);
}

export function formatCandleTime(time, timeframe) {
  if (!Number.isFinite(time)) return "—";
  const date = new Date(time);
  const month = MONTHS[date.getUTCMonth()];
  const day = date.getUTCDate();
  if (timeframe === "1d" || timeframe === "1w") {
    return `${month} ${day} ${date.getUTCFullYear()}`;
  }
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day} ${hours}:${minutes}`;
}

export function formatSymbol(venue, symbol) {
  if (venue === "coinbase" && symbol.includes("-")) {
    const [base, quote] = symbol.split("-");
    return `${base} / ${quote}`;
  }
  if (symbol.endsWith("USDT")) return `${symbol.slice(0, -4)} / USDT`;
  return symbol;
}

export function venueLabel(venue) {
  if (venue === "binance") return "Binance";
  if (venue === "coinbase") return "Coinbase";
  return venue;
}
