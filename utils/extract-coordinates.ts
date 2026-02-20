/**
 * Extracts latitude and longitude from various formats:
 * - Direct coordinates: "27.026634, 40.076934"
 * - Google Maps iframe embed code
 * - https://maps.app.goo.gl/xxxxx (shortened)
 * - https://www.google.com/maps/@lat,lng,zoom
 * - https://www.google.com/maps/search/lat,lng
 * - https://www.google.com/maps/place/.../@lat,lng
 * - https://maps.google.com/?q=lat,lng
 */

interface Coordinates {
  latitude: number;
  longitude: number;
}

export async function extractCoordinatesFromUrl(
  input: string
): Promise<Coordinates | null> {
  try {
    // Remove whitespace
    const cleanInput = input.trim();

    // Try to extract from direct coordinates first (e.g., "27.026634, 40.076934")
    const directCoords = extractDirectCoordinates(cleanInput);
    if (directCoords) {
      return directCoords;
    }

    // Try to extract from iframe embed code
    const iframeCoords = extractFromIframe(cleanInput);
    if (iframeCoords) {
      return iframeCoords;
    }

    // Handle shortened URLs (maps.app.goo.gl)
    if (
      cleanInput.includes('maps.app.goo.gl') ||
      cleanInput.includes('goo.gl')
    ) {
      return await extractFromShortenedUrl(cleanInput);
    }

    // Handle standard Google Maps URLs
    return extractFromStandardUrl(cleanInput);
  } catch (error) {
    console.error('Error extracting coordinates:', error);
    return null;
  }
}

/**
 * Extract coordinates from direct input format (e.g., "27.026634, 40.076934")
 */
function extractDirectCoordinates(input: string): Coordinates | null {
  try {
    // Pattern: lat, lng with optional whitespace
    // Supports formats like: "27.026634, 40.076934" or "27.026634,40.076934"
    const pattern = /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/;
    const match = input.match(pattern);

    if (match) {
      return {
        latitude: parseFloat(match[1]),
        longitude: parseFloat(match[2]),
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract coordinates from Google Maps iframe embed code
 */
function extractFromIframe(input: string): Coordinates | null {
  try {
    // Check if input contains iframe tag
    if (!input.includes('<iframe') && !input.includes('maps/embed')) {
      return null;
    }

    // Extract the src URL from iframe
    const srcPattern = /src=["']([^"']+)["']/;
    const srcMatch = input.match(srcPattern);

    if (srcMatch && srcMatch[1]) {
      const embedUrl = srcMatch[1];
      // Try to extract coordinates from the embed URL
      return extractFromStandardUrl(embedUrl);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract coordinates from shortened Google Maps URLs by following redirects
 * Uses API route to bypass CORS restrictions
 */
async function extractFromShortenedUrl(
  url: string
): Promise<Coordinates | null> {
  try {
    // Use our API endpoint to resolve the shortened URL (bypasses CORS)
    const response = await fetch('/api/resolve-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      console.error('Failed to resolve shortened URL:', response.statusText);
      return null;
    }

    const data = await response.json();
    const finalUrl = data.finalUrl;

    if (!finalUrl) {
      return null;
    }

    // Extract coordinates from the final URL
    return extractFromStandardUrl(finalUrl);
  } catch (error) {
    console.error('Error following shortened URL:', error);
    return null;
  }
}

/**
 * Extract coordinates from standard Google Maps URLs
 * IMPORTANT: Order matters! Place coordinates (!3d!4d) should be checked BEFORE view coordinates (@)
 */
function extractFromStandardUrl(url: string): Coordinates | null {
  try {
    // Pattern 1: Protocol Buffer format (!3d for latitude, !4d or !2d for longitude)
    // This is the ACTUAL PLACE LOCATION - must be checked first!
    // Standard: https://www.google.com/maps/...!3d24.774265!4d46.738586
    // Embed: https://www.google.com/maps/embed?pb=...!2d41.367...!3d25.289...
    const latPattern = /!3d(-?\d+\.?\d+)/;
    const latMatch = url.match(latPattern);

    if (latMatch) {
      // Try !4d first (standard format), then !2d (embed format)
      const lng4dPattern = /!4d(-?\d+\.?\d+)/;
      const lng2dPattern = /!2d(-?\d+\.?\d+)/;
      const lng4dMatch = url.match(lng4dPattern);
      const lng2dMatch = url.match(lng2dPattern);

      const lngMatch = lng4dMatch || lng2dMatch;

      if (lngMatch) {
        return {
          latitude: parseFloat(latMatch[1]),
          longitude: parseFloat(lngMatch[1]),
        };
      }
    }

    // Pattern 2: ?q=lat,lng format
    // Example: https://maps.google.com/?q=24.774265,46.738586
    const pattern2 = /[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/;
    const match2 = url.match(pattern2);

    if (match2) {
      return {
        latitude: parseFloat(match2[1]),
        longitude: parseFloat(match2[2]),
      };
    }

    // Pattern 3: /search/lat,+lng or /search/lat,lng format
    // Example: https://www.google.com/maps/search/26.090684,+41.367472
    // Example: https://www.google.com/maps/search/26.090684,41.367472
    const searchPattern = /\/search\/(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/;
    const searchMatch = url.match(searchPattern);

    if (searchMatch) {
      return {
        latitude: parseFloat(searchMatch[1]),
        longitude: parseFloat(searchMatch[2]),
      };
    }

    // Pattern 4: /@lat,lng,zoom format
    // This is the VIEW LOCATION - used as fallback only when no place coordinates exist
    // Example: https://www.google.com/maps/@24.774265,46.738586,15z
    // Example: https://www.google.com/maps/place/.../@24.774265,46.738586,15z
    const pattern1 = /@(-?\d+\.?\d*),(-?\d+\.?\d*)/;
    const match1 = url.match(pattern1);

    if (match1) {
      return {
        latitude: parseFloat(match1[1]),
        longitude: parseFloat(match1[2]),
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Validate if coordinates are within valid range
 */
export function validateCoordinates(coords: Coordinates): boolean {
  const { latitude, longitude } = coords;

  // Latitude must be between -90 and 90
  // Longitude must be between -180 and 180
  return (
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    !isNaN(latitude) &&
    !isNaN(longitude)
  );
}
