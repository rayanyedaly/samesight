import { describe, expect, it } from "vitest";
import { commentMarker, nameWords, type PersonalCategory, personalColumn } from "./personal.ts";

describe("nameWords", () => {
  it.each([
    ["emailAddress", ["email", "address"]],
    ["DOB", ["dob"]],
    ["address_line2", ["address", "line", "2"]],
    ["IPAddress", ["ip", "address"]],
    ["userID", ["user", "id"]],
    ["ICD10Code", ["icd", "10", "code"]],
    ["EMAIL_ADDRESS", ["email", "address"]],
    ['"FirstName"', ["first", "name"]],
    ["first-name", ["first", "name"]],
    ["profile.email", ["profile", "email"]],
    [' public."UserProfiles" ', ["public", "user", "profiles"]],
    ["date  of\tbirth", ["date", "of", "birth"]],
    // A letter beyond ASCII stays in its word.
    ["Prénom", ["prénom"]],
    ["", []],
    ["__", []],
  ])("splits %s", (name, words) => {
    expect(nameWords(name)).toEqual(words);
  });
});

describe("commentMarker", () => {
  it.each([
    ["samesight:personal", { personal: true, category: "personal" }],
    ["Where receipts go. samesight:personal=contact (see #12)", { personal: true, category: "contact" }],
    ["SameSight:Personal=HEALTH", { personal: true, category: "health" }],
    ["samesight:personal = birth", { personal: true, category: "birth" }],
    ["samesight:personal=free-text", { personal: true, category: "free text" }],
    ["samesight:personal=free_text.", { personal: true, category: "free text" }],
    // A category it does not know still marks the column personal.
    ["samesight:personal=biometric", { personal: true, category: "personal" }],
    ["samesight:personal=", { personal: true, category: "personal" }],
    ["samesight:not-personal", { personal: false }],
    ["A public handle, SAMESIGHT:NOT-PERSONAL.", { personal: false }],
    // The first marker counts.
    ["samesight:not-personal, was samesight:personal", { personal: false }],
    ["samesight:personal=secret; samesight:not-personal", { personal: true, category: "secret" }],
  ])("reads %s", (comment, marker) => {
    expect(commentMarker(comment)).toEqual(marker);
  });

  it.each(["", "personal data", "samesight:personally", "samesight:personal-ish", "mysamesight:personal", "samesight: personal", "samesight:not_personal"])(
    "finds no marker in %j",
    (comment) => {
      expect(commentMarker(comment)).toBeUndefined();
    },
  );
});

describe("personalColumn", () => {
  const byName = (category: PersonalCategory, matched: string) => ({ category, matched, source: "name" });

  it.each<[string, PersonalCategory, string]>([
    // Strong phrases, anywhere in the name.
    ["email", "contact", "email"],
    ["user_email", "contact", "email"],
    ["emailAddress", "contact", "email address"],
    ['"EmailAddress"', "contact", "email address"],
    ["e_mail", "contact", "e mail"],
    ["contact_phone", "contact", "phone"],
    ["phone_number", "contact", "phone number"],
    ["telephone", "contact", "telephone"],
    ["fax", "contact", "fax"],
    ["billing_address", "location", "billing address"],
    ["street", "location", "street"],
    ["address_line_2", "location", "address line"],
    ["postal_code", "location", "postal code"],
    ["post_code", "location", "post code"],
    ["geo_location", "location", "geo location"],
    ["date_of_birth", "birth", "date of birth"],
    ["dob", "birth", "dob"],
    ["DOB", "birth", "dob"],
    ["BirthDate", "birth", "birth date"],
    ["birthday", "birth", "birthday"],
    ["first_name", "identifier", "first name"],
    ["lastName", "identifier", "last name"],
    ["surname", "identifier", "surname"],
    ["maiden_name", "identifier", "maiden name"],
    ["ssn", "identifier", "ssn"],
    ["social_security_number", "identifier", "social security"],
    ["passport_number", "identifier", "passport number"],
    ["drivers_license", "identifier", "drivers license"],
    ["nhs_number", "identifier", "nhs number"],
    ["IPAddress", "identifier", "ip address"],
    ["mac_address", "identifier", "mac address"],
    ["diagnosis_code", "health", "diagnosis"],
    ["icd10_code", "health", "icd"],
    ["medical_record_number", "health", "medical record"],
    ["allergies", "health", "allergies"],
    ["lab_results", "health", "lab results"],
    ["clinical_notes", "health", "clinical notes"],
    ["chief_complaint", "health", "chief complaint"],
    ["iban", "financial", "iban"],
    ["card_number", "financial", "card number"],
    ["sort_code", "financial", "sort code"],
    ["annual_income", "financial", "income"],
    ["password", "secret", "password"],
    ["password_hash", "secret", "password hash"],
    ["client_secret", "secret", "secret"],
    ["refresh_token", "secret", "refresh token"],
    ["recovery_codes", "secret", "recovery codes"],
    // Written as one word.
    ["firstname", "identifier", "firstname"],
    ["zipcode", "location", "zipcode"],
    ["birthdate", "birth", "birthdate"],
    ["geolocation", "location", "geolocation"],
    // The phrase that ends last says what the column holds, the longest of those.
    ["billing_address_email", "contact", "email"],
    ["national_insurance_number", "identifier", "national insurance number"],
    ["health_insurance_number", "health", "insurance number"],
    ["credit_card_number", "financial", "card number"],
    // An id or a word about the data counts only as the end of a phrase.
    ["patient_id", "identifier", "patient id"],
    ["patientId", "identifier", "patient id"],
    ["national_id", "identifier", "national id"],
    ["tax_id", "identifier", "tax id"],
    ["customer_tax_id", "identifier", "tax id"],
    ["blood_type", "health", "blood type"],
    // zip and mobile count only at the end of a name, a number aside.
    ["zip", "location", "zip"],
    ["billing_zip", "location", "zip"],
    ["zip4", "location", "zip"],
    ["zip_code", "location", "zip code"],
    ["work_mobile", "contact", "mobile"],
    ["mobile_number", "contact", "mobile number"],
    // One column holding both coordinates.
    ["lat_lng", "location", "lat lng"],
    ["latlong", "location", "latlong"],
  ])("finds %s as %s (%s)", (column, category, matched) => {
    expect(personalColumn(column, "orders")).toEqual(byName(category, matched));
  });

  // In a person table, where weak words could count.
  it.each([
    // Pieces of words.
    "passenger",
    "filename",
    "timezone",
    "gzip",
    "adobe",
    "mailbox_id",
    "secretary",
    "emailed",
    // Flags and words about the data.
    "email_verified",
    "phone_type",
    "email_count",
    "is_public",
    "has_email",
    "show_phone",
    "address_type",
    "email_confirmed_at",
    "email_template",
    "email_notifications",
    "email_opt_in",
    "password_min_length",
    "phone_model",
    "blood_type_verified",
    "dob_verified",
    // Pointers at rows elsewhere.
    "id",
    "ID",
    "owner_id",
    "created_by",
    "user_id",
    "list_id",
    "email_id",
    "billingAddressId",
    "patient_ids",
    // zip and mobile in another sense.
    "zip_url",
    "zip_file",
    "mobile_app_version",
    "mobile_push_token",
    // Chosen to be shown, or not a person's.
    "display_name",
    "username",
    "user_name",
    "role_name",
    // Weak words that are not the whole name, or a coordinate without its partner.
    "home_city",
    "age_group",
    "lat",
    "longitude",
    "",
    "_",
  ])("leaves %j alone", (column) => {
    expect(personalColumn(column, "users")).toBeUndefined();
  });

  it.each<[string, string, PersonalCategory, string]>([
    ["name", "users", "identifier", "name"],
    ["Name", "public.profiles", "identifier", "name"],
    ["name", 'public."TeamMembers"', "identifier", "name"],
    ["address", "customers", "location", "address"],
    ["address2", "customers", "location", "address"],
    ["address_1", "customers", "location", "address"],
    ["city", "employees", "location", "city"],
    ["gender", "patients", "personal", "gender"],
    ["sex", "people", "personal", "sex"],
    ["nationality", "staff", "personal", "nationality"],
    ["religion", "person", "personal", "religion"],
    ["ethnicity", "students", "personal", "ethnicity"],
    ["notes", "contacts", "free text", "notes"],
    ["note", "patient", "free text", "note"],
    ["condition", "patients", "health", "condition"],
    ["age", "user", "birth", "age"],
  ])("counts the weak word %s in %s as %s", (column, table, category, matched) => {
    expect(personalColumn(column, table)).toEqual(byName(category, matched));
  });

  it.each([
    ["name", "projects"],
    ["name", "clients"],
    ["name", "accounts"],
    ["name", "user_settings"],
    ["name", ""],
    ["address", "orders"],
    ["condition", "products"],
    ["mailing_address", "customers"],
    ["city_name", "customers"],
    ["address_2_3", "customers"],
  ])("does not count the weak word in %s of %s", (column, table) => {
    expect(personalColumn(column, table)).toBeUndefined();
  });

  it("pairs a latitude with a longitude only when the table has both, named alike", () => {
    expect(personalColumn("lat", "check_ins", { siblings: ["id", "lat", "lng"] })).toEqual(byName("location", "lat and lng"));
    expect(personalColumn("lng", "check_ins", { siblings: ["lat"] })).toEqual(byName("location", "lng and lat"));
    expect(personalColumn("latitude", "trips", { siblings: ["Longitude"] })).toEqual(byName("location", "latitude and longitude"));
    expect(personalColumn("homeLat", "users", { siblings: ["home_lon"] })).toEqual(byName("location", "lat and lon"));
    expect(personalColumn("lat", "trips", { siblings: ["long"] })).toEqual(byName("location", "lat and long"));
    expect(personalColumn("lat", "trips")).toBeUndefined();
    expect(personalColumn("lat", "trips", { siblings: ["lat", "latitude"] })).toBeUndefined();
    expect(personalColumn("home_lat", "trips", { siblings: ["work_lng", "lng"] })).toBeUndefined();
    expect(personalColumn("long", "trips", { siblings: ["short"] })).toBeUndefined();
    expect(personalColumn("lat_type", "trips", { siblings: ["lng_type"] })).toBeUndefined();
  });

  it("leaves booleans to a marker, whatever their name", () => {
    for (const type of ["boolean", "bool", "BOOLEAN", "pg_catalog.bool", "boolean[]"]) expect(personalColumn("email", "users", { type }), type).toBeUndefined();
    expect(personalColumn("email", "users", { type: "text" })).toEqual(byName("contact", "email"));
    expect(personalColumn("email", "users", { type: "character varying" })).toEqual(byName("contact", "email"));
  });

  it("lets a comment marker decide over the name and the type", () => {
    const byComment = (category: PersonalCategory, matched: string) => ({ category, matched, source: "comment" });
    expect(personalColumn("email", "users", { comment: "samesight:not-personal" })).toBeUndefined();
    expect(personalColumn("bio", "profiles", { comment: "What they write about themselves. samesight:personal=free-text" })).toEqual(byComment("free text", "samesight:personal=free-text"));
    expect(personalColumn("email", "users", { comment: "samesight:personal=identifier" })).toEqual(byComment("identifier", "samesight:personal=identifier"));
    expect(personalColumn("email_verified", "users", { comment: "samesight:personal" })).toEqual(byComment("personal", "samesight:personal"));
    expect(personalColumn("has_diabetes", "patients", { type: "boolean", comment: "samesight:personal=Health" })).toEqual(byComment("health", "samesight:personal=health"));
    expect(personalColumn("payload", "events", { comment: "samesight:personal=biometric" })).toEqual(byComment("personal", "samesight:personal"));
    // A comment without a marker leaves it to the name.
    expect(personalColumn("email", "users", { comment: "Where receipts go" })).toEqual(byName("contact", "email"));
    expect(personalColumn("title", "posts", { comment: "personal notes" })).toBeUndefined();
  });
});
