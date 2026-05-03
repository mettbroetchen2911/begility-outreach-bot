import { withRetry } from "../utils/retry.js";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.shortFormattedAddress",
  "places.addressComponents",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
  "places.rating",
  "places.userRatingCount",
  "nextPageToken",
].join(",");

const MAX_PAGES_PER_QUERY = parseInt(process.env.PLACES_MAX_PAGES ?? "3", 10);
const MAX_RESULTS_PER_PAGE = 20; // Places hard cap

// Place types we never want, regardless of query. Chains and big-box
// formats that are not "owner-led independents" almost always carry these.
const BLOCKED_PRIMARY_TYPES = new Set<string>([
  "supermarket",
  "department_store",
  "shopping_mall",
  "convenience_store",
  "warehouse_store",
  "discount_store",
  "gas_station",
]);

export interface PlacesDiscoveredBusiness {
  businessName: string;
  googlePlaceId: string;
  city: string | null;
  country: string | null;
  address: string | null;
  outwardPostcode: string | null;
  website: string | null;
  phone: string | null;
  rating: number | null;
  source: "google_places";
}

export interface PlacesScanOpts {
  query: string;                 // e.g. "recruitment agency"
  locationBias: { lat: number; lng: number; radiusMeters: number };
  maxPages?: number;             // default 3 (= up to 60 results)
}

interface PlacesApiResponse {
  places?: Array<{
    id?: string;
    displayName?: { text: string } | string;
    formattedAddress?: string;
    shortFormattedAddress?: string;
    addressComponents?: Array<{
      types: string[];
      shortText?: string;
      longText?: string;
    }>;
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    websiteUri?: string;
    types?: string[];
    primaryType?: string;
    businessStatus?: string;
    rating?: number;
    userRatingCount?: number;
  }>;
  nextPageToken?: string;
}

export async function discoverFromPlaces(
  opts: PlacesScanOpts
): Promise<{ businesses: PlacesDiscoveredBusiness[]; totalResults: number }> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");

  const businesses: PlacesDiscoveredBusiness[] = [];
  const seenPlaceIds = new Set<string>();
  const pageCap = opts.maxPages ?? MAX_PAGES_PER_QUERY;
  let pageToken: string | undefined;

  for (let page = 0; page < pageCap; page++) {
    const body: Record<string, unknown> = {
      textQuery: opts.query,
      pageSize: MAX_RESULTS_PER_PAGE,
      locationBias: {
        circle: {
          center: { latitude: opts.locationBias.lat, longitude: opts.locationBias.lng },
          radius: opts.locationBias.radiusMeters,
        },
      },
    };
    if (pageToken) body.pageToken = pageToken;

    const data = await withRetry(
      () => callPlaces(apiKey, body),
      `places:${opts.query}:p${page}`,
      { maxAttempts: 3, baseDelayMs: 2000 },
    );

    for (const p of data.places ?? []) {
      const mapped = mapPlace(p);
      if (!mapped) continue;
      if (seenPlaceIds.has(mapped.googlePlaceId)) continue;
      seenPlaceIds.add(mapped.googlePlaceId);
      businesses.push(mapped);
    }

    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
    if (!pageToken) break;

    // Places requires a brief delay before the next-page token becomes valid.
    await sleep(2100);
  }

  return { businesses, totalResults: businesses.length };
}

// ---------------------------------------------------------------------------
// HTTP call
// ---------------------------------------------------------------------------

async function callPlaces(apiKey: string, body: Record<string, unknown>): Promise<PlacesApiResponse> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 403) {
      throw new Error(
        `Places API returned 403. Likely causes: API key not authorised for ` +
        `Places API (New), referrer/IP restriction blocking this caller, or ` +
        `billing not enabled. Body: ${text.slice(0, 400)}`,
      );
    }
    if (res.status === 429) {
      throw new Error(`Places API rate-limited (429): ${text.slice(0, 400)}`);
    }
    throw new Error(`Places API ${res.status}: ${text.slice(0, 400)}`);
  }

  return (await res.json()) as PlacesApiResponse;
}

// ---------------------------------------------------------------------------
// Map a single Places result → PlacesDiscoveredBusiness, applying filters.
// ---------------------------------------------------------------------------

function mapPlace(p: NonNullable<PlacesApiResponse["places"]>[number]): PlacesDiscoveredBusiness | null {
  if (!p || typeof p !== "object") return null;
  const placeId = typeof p.id === "string" ? p.id : null;
  if (!placeId) return null;

  // Drop closed / non-operational places. businessStatus is
  // "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY".
  if (p.businessStatus && p.businessStatus !== "OPERATIONAL") return null;

  // Drop big-box / chain primary types.
  if (p.primaryType && BLOCKED_PRIMARY_TYPES.has(p.primaryType)) return null;

  const displayName =
    typeof p.displayName === "object" && p.displayName?.text ? p.displayName.text :
    typeof p.displayName === "string" ? p.displayName : "";
  if (!displayName.trim()) return null;

  const components = p.addressComponents ?? [];
const hasType = (c: { types?: string[] } | undefined, t: string): boolean =>
  Array.isArray(c?.types) && c.types.includes(t);

const cityComp = components.find((c) => hasType(c, "postal_town") || hasType(c, "locality"));
const countryComp = components.find((c) => hasType(c, "country"));
const postcodeComp = components.find((c) => hasType(c, "postal_code"));
  const outward = postcodeComp?.shortText
    ? postcodeComp.shortText.toUpperCase().split(/\s+/)[0]
    : null;

  return {
    businessName: displayName,
    googlePlaceId: placeId,
    city: cityComp?.longText ?? cityComp?.shortText ?? null,
    country: countryComp?.longText ?? null,
    address: p.formattedAddress ?? p.shortFormattedAddress ?? null,
    outwardPostcode: outward,
    website: p.websiteUri ?? null,
    phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
    rating: typeof p.rating === "number" ? p.rating : null,
    source: "google_places" as const,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
