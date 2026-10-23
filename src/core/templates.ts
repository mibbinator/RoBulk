// Templates for bulk-creating game passes and developer products.

export interface DraftProduct {
  name: string;
  description: string;
  price: number;
  onSale: boolean;
}

export interface TemplateDefinition {
  id: string;
  label: string;
  description: string;
  build: () => DraftProduct[];
}

const DONATION_TIERS = [10, 25, 50, 100, 250, 500, 1000, 5000];

export const TEMPLATES: TemplateDefinition[] = [
  {
    id: "donations",
    label: "Donation tiers",
    description: "Eight donation products from R$10 to R$5,000.",
    build: () =>
      DONATION_TIERS.map((price) => ({
        name: `Donate ${price.toLocaleString("en-US")} Robux`,
        description: `Support the game with a ${price.toLocaleString("en-US")} Robux donation. Thank you!`,
        price,
        onSale: true,
      })),
  },
  {
    id: "currency",
    label: "Currency packs",
    description: "Five coin packs with bigger bonuses at higher prices.",
    build: () =>
      [
        [100, 25],
        [550, 120],
        [1200, 250],
        [2600, 500],
        [7000, 1200],
      ].map(([coins, price]) => ({
        name: `${coins.toLocaleString("en-US")} Coins`,
        description: `Get ${coins.toLocaleString("en-US")} coins instantly.`,
        price,
        onSale: true,
      })),
  },
  {
    id: "passes",
    label: "Starter game passes",
    description: "VIP, 2x XP, 2x Coins and Extra Storage.",
    build: () => [
      { name: "VIP", description: "VIP chat tag, a VIP-only area and daily bonus rewards.", price: 299, onSale: true },
      { name: "2x XP", description: "Earn double XP forever.", price: 199, onSale: true },
      { name: "2x Coins", description: "Earn double coins forever.", price: 249, onSale: true },
      { name: "Extra Storage", description: "Double your inventory space.", price: 99, onSale: true },
    ],
  },
];

export interface NumberedSeries {
  /** Use {n} for the number and {price} for the price. */
  nameTemplate: string;
  description: string;
  count: number;
  startPrice: number;
  priceStep: number;
  onSale: boolean;
}

export function buildNumberedSeries(s: NumberedSeries): DraftProduct[] {
  const count = Math.max(0, Math.min(100, Math.floor(s.count)));
  return Array.from({ length: count }, (_, i) => {
    const price = Math.max(0, Math.round(s.startPrice + i * s.priceStep));
    const fill = (t: string) => t.replace(/\{n\}/g, String(i + 1)).replace(/\{price\}/g, String(price));
    return { name: fill(s.nameTemplate), description: fill(s.description), price, onSale: s.onSale };
  });
}

export function validateDraft(d: DraftProduct): string | undefined {
  if (!d.name.trim()) return "Needs a name";
  if (d.name.length > 50) return "Name is longer than 50 characters";
  if (!Number.isInteger(d.price) || d.price < 0) return "Price must be a whole number of Robux";
  if (d.description.length > 1000) return "Description is longer than 1,000 characters";
  return undefined;
}
