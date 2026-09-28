/**
 * Password rules as the customer sees them — mirrors the API's policy
 * (`velo/domains/identity/service.py`): length and "not your email", with no
 * composition rules. The API is the authority; this is for live feedback.
 *
 * The strength estimate is advisory only (PAGE-SPECS.md §2.2). It never blocks
 * submission — the breach check on the server is what catches weak passwords
 * that are actually in use by attackers.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export interface Requirement {
  id: string;
  label: string;
  met: boolean;
}

export function passwordRequirements(password: string, email = ""): Requirement[] {
  const lowered = password.trim().toLowerCase();
  const localPart = email.split("@")[0]?.toLowerCase() ?? "";
  const matchesEmail =
    lowered.length > 0 && (lowered === email.toLowerCase() || lowered === localPart);
  return [
    {
      id: "length",
      label: `At least ${String(PASSWORD_MIN_LENGTH)} characters`,
      met: password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH,
    },
    { id: "email", label: "Not your email address", met: password.length > 0 && !matchesEmail },
  ];
}

export type Strength = "empty" | "weak" | "fair" | "strong";

export function passwordStrength(password: string): Strength {
  if (!password) return "empty";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const distinct = new Set(password).size;
  // Length dominates: a long passphrase beats a short "complex" password.
  const score = password.length + classes * 2 + Math.min(distinct, 12) / 2;
  if (password.length < PASSWORD_MIN_LENGTH || distinct < 4) return "weak";
  if (score >= 26) return "strong";
  return "fair";
}
