import { withRetry } from "../utils/retry.js";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

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
  maxResults?: number;           // default 20, max 20 per request
}

interface PlacesApiResponse {
  places?: Array<{
    id: string;
    displayName?: { text: string };
    formattedAddress?: string;
    addressComponents?: Array<{
      types: string[];
      shortText?: string;
      longText?: string;
    }>;
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    websiteUri?: string;
    rating?: number;
    userRatingCount?: number;
  }>;
}

export async function discoverFromPlaces(
  opts: PlacesScanOpts
): Promise<{ businesses: PlacesDiscoveredBusiness[]; totalResults: number }> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");

  const body = {
    textQuery: opts.query,
    pageSize: Math.min(opts.maxResults ?? 20, 20),
    locationBias: {
      circle: {
        center: { latitude: opts.locationBias.lat, longitude: opts.locationBias.lng },
        radius: opts.locationBias.radiusMeters,
      },
    },
  };

  return withRetry(
    async () => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": [
            "places.id",
            "places.displayName",
            "places.formattedAddress",
            "places.addressComponents",
            "places.nationalPhoneNumber",
            "places.internationalPhoneNumber",
            "places.websiteUri",
            "places.rating",
            "places.userRatingCount",
          ].join(","),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Places searchText ${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = (await res.json()) as PlacesApiResponse;
      const businesses: PlacesDiscoveredBusiness[] = (data.places ?? []).map((p) => {
        const components = p.addressComponents ?? [];
        const cityComp = components.find((c) =>
          c.types.includes("postal_town") || c.types.includes("locality")
        );
        const countryComp = components.find((c) => c.types.includes("country"));
        const postcodeComp = components.find((c) => c.types.includes("postal_code"));
        const outward = postcodeComp?.shortText
          ? postcodeComp.shortText.toUpperCase().split(/\s+/)[0]
          : null;

        return {
          businessName: p.displayName?.text ?? "",
          googlePlaceId: p.id,
          city: cityComp?.longText ?? cityComp?.shortText ?? null,
          country: countryComp?.longText ?? null,
          address: p.formattedAddress ?? null,
          outwardPostcode: outward,
          website: p.websiteUri ?? null,
          phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
          rating: p.rating ?? null,
          source: "google_places" as const,
        };
      }).filter((b) => b.businessName.trim().length > 0);

      return { businesses, totalResults: businesses.length };
    },
    `places:${opts.query}`,
    { maxAttempts: 3, baseDelayMs: 2500 }
  );
}
