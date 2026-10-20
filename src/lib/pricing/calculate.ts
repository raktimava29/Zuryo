export type PriceBreakdown = {
  basePricePaise: number;
  commissionPaise: number;
  totalPaise: number;
};

export function calculatePrice(
  basePricePaise: number,
  commissionBasisPoints: number,
): PriceBreakdown {
  if (!Number.isSafeInteger(basePricePaise) || basePricePaise <= 0) {
    throw new Error("Invalid base price");
  }

  if (
    !Number.isSafeInteger(commissionBasisPoints) ||
    commissionBasisPoints < 0 ||
    commissionBasisPoints > 10000
  ) {
    throw new Error("Invalid commission rate");
  }

  const commissionPaise = Math.round(
    (basePricePaise * commissionBasisPoints) / 10000,
  );

  return {
    basePricePaise,
    commissionPaise,
    totalPaise: basePricePaise + commissionPaise,
  };
}