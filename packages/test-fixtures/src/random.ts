/**
 * Deterministic pseudo-randomness for the demo data set.
 *
 * `Math.random` would make the demonstration different on every reset, which
 * would make the documented scenarios — "payment RW-1042 is the ambiguous one"
 * — untrue half the time. Everything generated here is a pure function of one
 * seed string, so a reset reproduces the same portfolio, the same payments and
 * the same exceptions, on any machine.
 */

export class SeededRandom {
  private state: number;

  constructor(seed: string) {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    this.state = hash === 0 ? 0x9e3779b9 : hash;
  }

  /** Next value in [0, 1). Mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error('Cannot pick from an empty list');
    return values[Math.floor(this.next() * values.length)]!;
  }

  /** Fisher-Yates shuffle of a copy. Does not mutate the input. */
  shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  }

  /** A money amount in cents, rounded to whole dollars. */
  dollars(min: number, max: number): number {
    return this.int(min, max) * 100;
  }
}

const COMPANY_PREFIXES = [
  'Meridian',
  'Harbourline',
  'Corvus',
  'Aldridge',
  'Brightfold',
  'Northgate',
  'Silverbrook',
  'Tessellate',
  'Ironvale',
  'Quarrystone',
  'Lantern',
  'Bellweather',
  'Foxglove',
  'Marchmont',
  'Kestrel',
  'Oakhaven',
  'Pinnacle',
  'Redstone',
  'Sablecroft',
  'Thornwood',
  'Umberline',
  'Vantage',
  'Westmoor',
  'Yardley',
];

const COMPANY_SUFFIXES = [
  'Analytics',
  'Logistics',
  'Design Studio',
  'Consulting',
  'Systems',
  'Legal',
  'Advisory',
  'Laboratories',
  'Partners',
  'Robotics',
  'Publishing',
  'Diagnostics',
  'Outfitters',
  'Provisions',
  'Instruments',
  'Architecture',
];

const COMPANY_FORMS = ['LLC', 'Inc.', 'LP', 'Co.', 'Group'];

const STREET_NAMES = [
  'Harbour',
  'Commerce',
  'Foundry',
  'Cedar',
  'Kingsway',
  'Marlow',
  'Ninth',
  'Overton',
  'Pearl',
  'Quill',
  'Ravensworth',
  'Sycamore',
  'Turnstile',
  'Union',
];

const CITIES: readonly { city: string; region: string; postal: string; timezone: string }[] = [
  { city: 'Portland', region: 'OR', postal: '97209', timezone: 'America/Los_Angeles' },
  { city: 'Austin', region: 'TX', postal: '78701', timezone: 'America/Chicago' },
  { city: 'Raleigh', region: 'NC', postal: '27601', timezone: 'America/New_York' },
  { city: 'Denver', region: 'CO', postal: '80202', timezone: 'America/Denver' },
  { city: 'Providence', region: 'RI', postal: '02903', timezone: 'America/New_York' },
  { city: 'Madison', region: 'WI', postal: '53703', timezone: 'America/Chicago' },
];

const PROPERTY_KINDS = ['Exchange', 'Works', 'Yard', 'Terrace', 'Building', 'Commons', 'Depot'];

export function companyName(random: SeededRandom): string {
  return `${random.pick(COMPANY_PREFIXES)} ${random.pick(COMPANY_SUFFIXES)} ${random.pick(COMPANY_FORMS)}`;
}

export function personName(random: SeededRandom): string {
  const first = random.pick([
    'Alex',
    'Rowan',
    'Priya',
    'Marco',
    'Devi',
    'Noor',
    'Sam',
    'Hana',
    'Ivo',
    'Lena',
  ]);
  const last = random.pick([
    'Okafor',
    'Lindqvist',
    'Varga',
    'Ferreira',
    'Nakamura',
    'Duarte',
    'Bayram',
    'Kowalski',
  ]);
  return `${first} ${last}`;
}

export function propertyName(random: SeededRandom, index: number): string {
  return `${random.pick(COMPANY_PREFIXES)} ${random.pick(PROPERTY_KINDS)} ${index + 1}`;
}

export function address(random: SeededRandom): {
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  timezone: string;
} {
  const place = random.pick(CITIES);
  return {
    line1: `${random.int(100, 4800)} ${random.pick(STREET_NAMES)} Street`,
    city: place.city,
    region: place.region,
    postalCode: place.postal,
    timezone: place.timezone,
  };
}

/**
 * Payment memos a real bank feed produces.
 *
 * Deliberately messy: some name the tenant, some carry the reference, some are
 * useless, and one is written to look like an instruction. That last one is
 * what the assistant's prompt-injection test uses.
 */
export const MEMO_TEMPLATES: readonly string[] = [
  'ACH CREDIT {tenant}',
  'ONLINE TRANSFER REF {reference}',
  'PAYMENT {reference} {tenant}',
  'BUSINESS BILL PAY',
  'WIRE IN /ORG={tenant}/',
  'RENT',
  'DEP {reference}',
  'INCOMING PMT',
];
