export const pricingConfig = {
  normalPrice: 399,
  peakPrice: 499,
  commissionRate: 0.10,
  peakStartHour: 17,
  peakEndHourExclusive: 21,
  timezone: 'Asia/Kolkata',
};

export function calculatePrice(startsAt: Date) {
  const hourText = new Intl.DateTimeFormat('en-GB', {
    timeZone: pricingConfig.timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(startsAt);
  const hour = Number(hourText);
  const isPeak = hour >= pricingConfig.peakStartHour && hour < pricingConfig.peakEndHourExclusive;
  const sessionPrice = isPeak ? pricingConfig.peakPrice : pricingConfig.normalPrice;
  const commissionAmount = Math.round(sessionPrice * pricingConfig.commissionRate * 100) / 100;
  return {
    currency: 'INR',
    isPeak,
    sessionPrice,
    commissionRate: pricingConfig.commissionRate,
    commissionAmount,
    totalAmount: Math.round((sessionPrice + commissionAmount) * 100) / 100,
  };
}
