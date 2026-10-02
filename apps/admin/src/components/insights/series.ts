/**
 * The one series colour. --brand-600 is #1d4ed8 in light and #3b82f6 in dark;
 * both pass the categorical checks (lightness band, chroma, >=3:1 contrast)
 * against the raised surface of their theme. --brand-500 fails the dark band.
 */
export const SERIES = "var(--brand-600)";
