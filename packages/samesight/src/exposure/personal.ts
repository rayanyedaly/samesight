/**
 * Columns that likely hold personal data, by the whole words of their name or by a samesight
 * marker in their comment. Names are matched, never data, and never pieces of a word: filename
 * has no name, gzip no zip, adobe no dob. The lists are short on purpose, since a column
 * flagged wrongly teaches people to ignore the rule; a comment marker settles what a name cannot.
 *
 * The word lists were informed by Supabase splinter's sensitive_columns_exposed lint
 * (https://github.com/supabase/splinter/blob/main/lints/0023_sensitive_columns_exposed.sql),
 * the dictionary behind PostgreSQL Anonymizer's anon.detect
 * (https://gitlab.com/dalibo/postgresql_anonymizer/-/blob/latest/docs/detection.md) and pdscan
 * (https://github.com/ankane/pdscan). No list was copied from them: this one is samesight's own.
 */

export type PersonalCategory = "identifier" | "contact" | "location" | "birth" | "health" | "financial" | "secret" | "free text" | "personal";

export interface PersonalMatch {
  category: PersonalCategory;
  /** The words or marker that matched, for messages: "email", "date of birth", "samesight:personal=health". */
  matched: string;
  source: "name" | "comment";
}

const CATEGORIES: PersonalCategory[] = ["identifier", "contact", "location", "birth", "health", "financial", "secret", "free text", "personal"];
const isCategory = (c: string): c is PersonalCategory => (CATEGORIES as string[]).includes(c);

/**
 * A column's name split into lowercase words: "emailAddress" -> ["email", "address"], "DOB" -> ["dob"],
 * "address_line2" -> ["address", "line", "2"], "IPAddress" -> ["ip", "address"]. Anything but a letter or
 * digit separates words (_, -, ., spaces, quotes), and so do a change of case and a run of digits.
 */
export function nameWords(name: string): string[] {
  return name
    .split(/[^\p{L}\p{M}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)
    .filter((w) => w !== "")
    .map((w) => w.toLowerCase());
}

const isNumber = (word: string) => /^\p{N}+$/u.test(word);

/** Phrases that mark a column wherever they stand in its name: user_email, diagnosis_code, home_zip. */
const STRONG: [PersonalCategory, string[]][] = [
  // display_name and username are left out: people choose them to be shown.
  [
    "identifier",
    [
      "first name", "last name", "full name", "given name", "family name", "middle name", "maiden name", "surname",
      "ssn", "social security", "national id", "national insurance", "national insurance number", "passport", "passport number",
      "driver license", "driver licence", "drivers license", "drivers licence", "driving license", "driving licence",
      "tax id", "nhs number", "patient id", "ip address", "mac address",
    ],
  ],
  ["contact", ["email", "e mail", "email address", "phone", "phone number", "mobile", "mobile number", "mobile no", "mobile phone", "telephone", "fax"]],
  [
    "location",
    [
      "street", "street address", "address line", "home address", "billing address", "shipping address",
      "post code", "postal code", "zip", "zip code", "geo location",
      // One column holding both coordinates; separate ones are paired by coordinatePair.
      "lat lng", "lat lon", "lat long", "lng lat", "lon lat", "long lat", "latitude longitude", "longitude latitude",
    ],
  ],
  ["birth", ["dob", "date of birth", "birth date", "birthday"]],
  // Treatment is left out: too common a word in business apps.
  [
    "health",
    [
      "diagnosis", "diagnoses", "icd", "mrn", "medical record", "health record", "medication", "medications",
      "prescription", "prescriptions", "allergy", "allergies", "lab result", "lab results", "blood type",
      "immunization", "immunizations", "immunisation", "immunisations", "vaccination", "vaccinations",
      "clinical note", "clinical notes", "chief complaint", "symptom", "symptoms", "health insurance", "insurance number",
    ],
  ],
  ["financial", ["iban", "account number", "card number", "credit card", "cvv", "cvc", "routing number", "sort code", "salary", "income"]],
  [
    "secret",
    ["password", "password hash", "passwd", "api key", "secret", "secret key", "access token", "refresh token", "auth token", "private key", "otp", "recovery code", "recovery codes"],
  ],
];

/**
 * Strong words with a common other meaning, which count only at the end of a name, a number
 * aside: billing_zip and zip4 but not zip_url, work_mobile but not mobile_app_version.
 */
const LAST_ONLY = new Set(["zip", "mobile"]);

interface Phrase {
  words: string[];
  category: PersonalCategory;
  lastOnly: boolean;
}

/** Each strong phrase as words, and written as one word too: firstname, zipcode, birthdate. */
const PHRASES: Phrase[] = STRONG.flatMap(([category, texts]) =>
  texts.flatMap((text) => {
    const words = nameWords(text);
    const phrase = { words, category, lastOnly: LAST_ONLY.has(text) };
    return words.length > 1 ? [phrase, { ...phrase, words: [words.join("")] }] : [phrase];
  }),
);

/**
 * Words too common to count anywhere, which count only as the whole name (or a numbered one,
 * address2) of a column in a table of people: users.name, patients.condition, but not projects.name
 * or members.role_name. Gender, sex, nationality, religion and ethnicity identify no one alone,
 * so they are personal, with no narrower category.
 */
const WEAK = new Map<string, PersonalCategory>([
  ["name", "identifier"],
  ["address", "location"],
  ["city", "location"],
  ["gender", "personal"],
  ["sex", "personal"],
  ["nationality", "personal"],
  ["religion", "personal"],
  ["ethnicity", "personal"],
  ["notes", "free text"],
  ["note", "free text"],
  ["condition", "health"],
  ["age", "birth"],
]);

/** Last words of a table's name that make it a table of people: users, team_members, patients. */
const PERSON_TABLES = new Set([
  "user", "users", "profile", "profiles", "member", "members", "patient", "patients", "customer", "customers",
  "contact", "contacts", "employee", "employees", "people", "person", "persons", "staff", "student", "students",
]);

/** First words of a flag about the data, not the data: is_public, has_email, show_phone. */
const FLAG_FIRST = new Set(["is", "has", "can", "should", "allow", "was", "show", "hide", "enable", "disable"]);

/**
 * Last words of a column about the data, not the data (email_verified, phone_type, email_opt_in,
 * password_min_length, password_changed_at), or of one that points at a row elsewhere (owner_id,
 * created_by). Such a column counts only through a phrase that ends with that word: blood_type,
 * patient_id, customer_tax_id.
 */
const ABOUT_LAST = new Set([
  "verified", "confirmed", "enabled", "disabled", "visible", "visibility", "required", "status", "flag", "consent", "sent", "in", "out",
  "type", "kind", "format", "template", "count", "length", "version", "model", "provider", "policy", "frequency",
  "settings", "setting", "preferences", "preference", "notifications", "notification",
  "at", "on",
  "id", "ids", "uuid", "by",
]);

const LATITUDE = new Set(["lat", "latitude"]);
const LONGITUDE = new Set(["lng", "lon", "long", "longitude"]);
const BOOLEAN = new Set(["bool", "boolean"]);

/** Where `phrase` last ends in `words` (the index after it), or -1. */
function lastEnd(words: string[], phrase: string[]): number {
  for (let end = words.length; end >= phrase.length; end--) {
    if (phrase.every((w, i) => words[end - phrase.length + i] === w)) return end;
  }
  return -1;
}

/**
 * The strong phrase in `words` that ends last, and the longest of those: the last words say what a
 * column holds, so billing_address_email is an email and national_insurance_number an identifier.
 */
function strongPhrase(words: string[], atEnd: boolean): Phrase | undefined {
  // Where the name ends, a number aside, for LAST_ONLY words.
  let nameEnd = words.length;
  while (nameEnd > 1 && isNumber(words[nameEnd - 1])) nameEnd--;
  let best: { phrase: Phrase; end: number } | undefined;
  for (const phrase of PHRASES) {
    const end = lastEnd(words, phrase.words);
    if (end === -1 || (atEnd && end !== words.length) || (phrase.lastOnly && end !== nameEnd)) continue;
    if (!best || end > best.end || (end === best.end && phrase.words.length > best.phrase.words.length)) best = { phrase, end };
  }
  return best?.phrase;
}

/**
 * A coordinate column whose partner the table also has, named the same but for that word: lat
 * with lng, home_latitude with home_longitude. A latitude alone places no one.
 */
function coordinatePair(words: string[], siblings: string[]): string | undefined {
  for (const [i, w] of words.entries()) {
    const partners = LATITUDE.has(w) ? LONGITUDE : LONGITUDE.has(w) ? LATITUDE : undefined;
    if (!partners) continue;
    for (const sibling of siblings) {
      const other = nameWords(sibling);
      if (other.length === words.length && partners.has(other[i]) && other.every((o, j) => j === i || o === words[j])) return `${w} and ${other[i]}`;
    }
  }
  return undefined;
}

/** samesight:personal[=category] or samesight:not-personal, as a whole word; spaces around = are allowed. */
const MARKER = /(?<![\w-])samesight:(not-personal|personal)(?![\w-])(?:[ \t]*=[ \t]*([\w-]*))?/i;

/**
 * A samesight marker in a column comment: samesight:personal (category "personal"),
 * samesight:personal=<category> ("free-text" for "free text"; a category it does not know is
 * "personal"), or samesight:not-personal. Case-insensitive, anywhere in the text, the first one
 * counting; undefined when there is none.
 */
export function commentMarker(comment: string): { personal: true; category: PersonalCategory } | { personal: false } | undefined {
  const m = MARKER.exec(comment);
  if (!m) return undefined;
  if (m[1]?.toLowerCase() === "not-personal") return { personal: false };
  const category = (m[2] ?? "").toLowerCase().replace(/[-_]/g, " ");
  return { personal: true, category: isCategory(category) ? category : "personal" };
}

/** The marker as one would write it, for messages. */
const markerText = (category: PersonalCategory) => (category === "personal" ? "samesight:personal" : `samesight:personal=${category.replace(" ", "-")}`);

/**
 * Whether a column likely holds personal data. A comment marker wins over the name and the type.
 * `table` decides weak words; `type` excludes booleans; `siblings` (the table's other column names) pairs latitude with longitude.
 */
export function personalColumn(column: string, table: string, options: { type?: string; comment?: string; siblings?: string[] } = {}): PersonalMatch | undefined {
  const marker = options.comment === undefined ? undefined : commentMarker(options.comment);
  if (marker) return marker.personal ? { category: marker.category, matched: markerText(marker.category), source: "comment" } : undefined;
  // A yes or no about someone (has_allergy) is left to a marker.
  if (options.type !== undefined && BOOLEAN.has(nameWords(options.type).at(-1) ?? "")) return undefined;
  const words = nameWords(column);
  const [first, second] = words;
  const last = words.at(-1);
  if (first === undefined || last === undefined || FLAG_FIRST.has(first)) return undefined;
  const endOnly = ABOUT_LAST.has(last);
  const strong = strongPhrase(words, endOnly);
  if (strong) return { category: strong.category, matched: strong.words.join(" "), source: "name" };
  if (endOnly) return undefined;
  const pair = coordinatePair(words, options.siblings ?? []);
  if (pair) return { category: "location", matched: pair, source: "name" };
  // A weak word, alone or numbered (address2).
  if (words.length > 2 || (second !== undefined && !isNumber(second))) return undefined;
  const weak = WEAK.get(first);
  return weak && PERSON_TABLES.has(nameWords(table).at(-1) ?? "") ? { category: weak, matched: first, source: "name" } : undefined;
}
