export const price = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 9 });
export const emaPrice = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const utc = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "UTC",
});
