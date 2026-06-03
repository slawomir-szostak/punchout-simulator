// Reference data for the address editor: ISO 3166-1 countries, subdivisions for
// the countries that have a well-known fixed list, and postal-code format
// patterns for the common ones. Pure data — no DOM, unit-testable.

/** ISO 3166-1 alpha-2 code → English country name. */
export const COUNTRIES: Array<{ iso: string; name: string }> = [
  { iso: "AF", name: "Afghanistan" }, { iso: "AX", name: "Åland Islands" }, { iso: "AL", name: "Albania" },
  { iso: "DZ", name: "Algeria" }, { iso: "AS", name: "American Samoa" }, { iso: "AD", name: "Andorra" },
  { iso: "AO", name: "Angola" }, { iso: "AI", name: "Anguilla" }, { iso: "AQ", name: "Antarctica" },
  { iso: "AG", name: "Antigua and Barbuda" }, { iso: "AR", name: "Argentina" }, { iso: "AM", name: "Armenia" },
  { iso: "AW", name: "Aruba" }, { iso: "AU", name: "Australia" }, { iso: "AT", name: "Austria" },
  { iso: "AZ", name: "Azerbaijan" }, { iso: "BS", name: "Bahamas" }, { iso: "BH", name: "Bahrain" },
  { iso: "BD", name: "Bangladesh" }, { iso: "BB", name: "Barbados" }, { iso: "BY", name: "Belarus" },
  { iso: "BE", name: "Belgium" }, { iso: "BZ", name: "Belize" }, { iso: "BJ", name: "Benin" },
  { iso: "BM", name: "Bermuda" }, { iso: "BT", name: "Bhutan" }, { iso: "BO", name: "Bolivia" },
  { iso: "BA", name: "Bosnia and Herzegovina" }, { iso: "BW", name: "Botswana" }, { iso: "BR", name: "Brazil" },
  { iso: "BN", name: "Brunei Darussalam" }, { iso: "BG", name: "Bulgaria" }, { iso: "BF", name: "Burkina Faso" },
  { iso: "BI", name: "Burundi" }, { iso: "KH", name: "Cambodia" }, { iso: "CM", name: "Cameroon" },
  { iso: "CA", name: "Canada" }, { iso: "CV", name: "Cabo Verde" }, { iso: "KY", name: "Cayman Islands" },
  { iso: "CF", name: "Central African Republic" }, { iso: "TD", name: "Chad" }, { iso: "CL", name: "Chile" },
  { iso: "CN", name: "China" }, { iso: "CO", name: "Colombia" }, { iso: "KM", name: "Comoros" },
  { iso: "CG", name: "Congo" }, { iso: "CD", name: "Congo (DRC)" }, { iso: "CR", name: "Costa Rica" },
  { iso: "CI", name: "Côte d'Ivoire" }, { iso: "HR", name: "Croatia" }, { iso: "CU", name: "Cuba" },
  { iso: "CY", name: "Cyprus" }, { iso: "CZ", name: "Czechia" }, { iso: "DK", name: "Denmark" },
  { iso: "DJ", name: "Djibouti" }, { iso: "DM", name: "Dominica" }, { iso: "DO", name: "Dominican Republic" },
  { iso: "EC", name: "Ecuador" }, { iso: "EG", name: "Egypt" }, { iso: "SV", name: "El Salvador" },
  { iso: "GQ", name: "Equatorial Guinea" }, { iso: "ER", name: "Eritrea" }, { iso: "EE", name: "Estonia" },
  { iso: "SZ", name: "Eswatini" }, { iso: "ET", name: "Ethiopia" }, { iso: "FK", name: "Falkland Islands" },
  { iso: "FO", name: "Faroe Islands" }, { iso: "FJ", name: "Fiji" }, { iso: "FI", name: "Finland" },
  { iso: "FR", name: "France" }, { iso: "GF", name: "French Guiana" }, { iso: "PF", name: "French Polynesia" },
  { iso: "GA", name: "Gabon" }, { iso: "GM", name: "Gambia" }, { iso: "GE", name: "Georgia" },
  { iso: "DE", name: "Germany" }, { iso: "GH", name: "Ghana" }, { iso: "GI", name: "Gibraltar" },
  { iso: "GR", name: "Greece" }, { iso: "GL", name: "Greenland" }, { iso: "GD", name: "Grenada" },
  { iso: "GP", name: "Guadeloupe" }, { iso: "GU", name: "Guam" }, { iso: "GT", name: "Guatemala" },
  { iso: "GG", name: "Guernsey" }, { iso: "GN", name: "Guinea" }, { iso: "GW", name: "Guinea-Bissau" },
  { iso: "GY", name: "Guyana" }, { iso: "HT", name: "Haiti" }, { iso: "HN", name: "Honduras" },
  { iso: "HK", name: "Hong Kong" }, { iso: "HU", name: "Hungary" }, { iso: "IS", name: "Iceland" },
  { iso: "IN", name: "India" }, { iso: "ID", name: "Indonesia" }, { iso: "IR", name: "Iran" },
  { iso: "IQ", name: "Iraq" }, { iso: "IE", name: "Ireland" }, { iso: "IM", name: "Isle of Man" },
  { iso: "IL", name: "Israel" }, { iso: "IT", name: "Italy" }, { iso: "JM", name: "Jamaica" },
  { iso: "JP", name: "Japan" }, { iso: "JE", name: "Jersey" }, { iso: "JO", name: "Jordan" },
  { iso: "KZ", name: "Kazakhstan" }, { iso: "KE", name: "Kenya" }, { iso: "KI", name: "Kiribati" },
  { iso: "KR", name: "Korea (South)" }, { iso: "KP", name: "Korea (North)" }, { iso: "KW", name: "Kuwait" },
  { iso: "KG", name: "Kyrgyzstan" }, { iso: "LA", name: "Laos" }, { iso: "LV", name: "Latvia" },
  { iso: "LB", name: "Lebanon" }, { iso: "LS", name: "Lesotho" }, { iso: "LR", name: "Liberia" },
  { iso: "LY", name: "Libya" }, { iso: "LI", name: "Liechtenstein" }, { iso: "LT", name: "Lithuania" },
  { iso: "LU", name: "Luxembourg" }, { iso: "MO", name: "Macao" }, { iso: "MG", name: "Madagascar" },
  { iso: "MW", name: "Malawi" }, { iso: "MY", name: "Malaysia" }, { iso: "MV", name: "Maldives" },
  { iso: "ML", name: "Mali" }, { iso: "MT", name: "Malta" }, { iso: "MH", name: "Marshall Islands" },
  { iso: "MQ", name: "Martinique" }, { iso: "MR", name: "Mauritania" }, { iso: "MU", name: "Mauritius" },
  { iso: "MX", name: "Mexico" }, { iso: "FM", name: "Micronesia" }, { iso: "MD", name: "Moldova" },
  { iso: "MC", name: "Monaco" }, { iso: "MN", name: "Mongolia" }, { iso: "ME", name: "Montenegro" },
  { iso: "MS", name: "Montserrat" }, { iso: "MA", name: "Morocco" }, { iso: "MZ", name: "Mozambique" },
  { iso: "MM", name: "Myanmar" }, { iso: "NA", name: "Namibia" }, { iso: "NR", name: "Nauru" },
  { iso: "NP", name: "Nepal" }, { iso: "NL", name: "Netherlands" }, { iso: "NC", name: "New Caledonia" },
  { iso: "NZ", name: "New Zealand" }, { iso: "NI", name: "Nicaragua" }, { iso: "NE", name: "Niger" },
  { iso: "NG", name: "Nigeria" }, { iso: "MK", name: "North Macedonia" }, { iso: "NO", name: "Norway" },
  { iso: "OM", name: "Oman" }, { iso: "PK", name: "Pakistan" }, { iso: "PW", name: "Palau" },
  { iso: "PS", name: "Palestine" }, { iso: "PA", name: "Panama" }, { iso: "PG", name: "Papua New Guinea" },
  { iso: "PY", name: "Paraguay" }, { iso: "PE", name: "Peru" }, { iso: "PH", name: "Philippines" },
  { iso: "PL", name: "Poland" }, { iso: "PT", name: "Portugal" }, { iso: "PR", name: "Puerto Rico" },
  { iso: "QA", name: "Qatar" }, { iso: "RE", name: "Réunion" }, { iso: "RO", name: "Romania" },
  { iso: "RU", name: "Russia" }, { iso: "RW", name: "Rwanda" }, { iso: "BL", name: "Saint Barthélemy" },
  { iso: "KN", name: "Saint Kitts and Nevis" }, { iso: "LC", name: "Saint Lucia" }, { iso: "MF", name: "Saint Martin" },
  { iso: "VC", name: "Saint Vincent and the Grenadines" }, { iso: "WS", name: "Samoa" }, { iso: "SM", name: "San Marino" },
  { iso: "ST", name: "Sao Tome and Principe" }, { iso: "SA", name: "Saudi Arabia" }, { iso: "SN", name: "Senegal" },
  { iso: "RS", name: "Serbia" }, { iso: "SC", name: "Seychelles" }, { iso: "SL", name: "Sierra Leone" },
  { iso: "SG", name: "Singapore" }, { iso: "SK", name: "Slovakia" }, { iso: "SI", name: "Slovenia" },
  { iso: "SB", name: "Solomon Islands" }, { iso: "SO", name: "Somalia" }, { iso: "ZA", name: "South Africa" },
  { iso: "SS", name: "South Sudan" }, { iso: "ES", name: "Spain" }, { iso: "LK", name: "Sri Lanka" },
  { iso: "SD", name: "Sudan" }, { iso: "SR", name: "Suriname" }, { iso: "SE", name: "Sweden" },
  { iso: "CH", name: "Switzerland" }, { iso: "SY", name: "Syria" }, { iso: "TW", name: "Taiwan" },
  { iso: "TJ", name: "Tajikistan" }, { iso: "TZ", name: "Tanzania" }, { iso: "TH", name: "Thailand" },
  { iso: "TL", name: "Timor-Leste" }, { iso: "TG", name: "Togo" }, { iso: "TO", name: "Tonga" },
  { iso: "TT", name: "Trinidad and Tobago" }, { iso: "TN", name: "Tunisia" }, { iso: "TR", name: "Türkiye" },
  { iso: "TM", name: "Turkmenistan" }, { iso: "TC", name: "Turks and Caicos Islands" }, { iso: "TV", name: "Tuvalu" },
  { iso: "UG", name: "Uganda" }, { iso: "UA", name: "Ukraine" }, { iso: "AE", name: "United Arab Emirates" },
  { iso: "GB", name: "United Kingdom" }, { iso: "US", name: "United States" }, { iso: "UY", name: "Uruguay" },
  { iso: "UZ", name: "Uzbekistan" }, { iso: "VU", name: "Vanuatu" }, { iso: "VA", name: "Vatican City" },
  { iso: "VE", name: "Venezuela" }, { iso: "VN", name: "Vietnam" }, { iso: "VG", name: "Virgin Islands (British)" },
  { iso: "VI", name: "Virgin Islands (U.S.)" }, { iso: "YE", name: "Yemen" }, { iso: "ZM", name: "Zambia" },
  { iso: "ZW", name: "Zimbabwe" },
];

const COUNTRY_BY_ISO = new Map(COUNTRIES.map((c) => [c.iso, c.name]));
export const countryName = (iso: string | undefined): string | undefined =>
  iso ? COUNTRY_BY_ISO.get(iso) : undefined;

/** Subdivisions for the countries with a well-known fixed list. `code` is what
 *  goes into <State>; others fall back to a free-text field. */
export const SUBDIVISIONS: Record<string, Array<{ code: string; name: string }>> = {
  US: [
    "AL Alabama","AK Alaska","AZ Arizona","AR Arkansas","CA California","CO Colorado","CT Connecticut",
    "DE Delaware","DC District of Columbia","FL Florida","GA Georgia","HI Hawaii","ID Idaho","IL Illinois",
    "IN Indiana","IA Iowa","KS Kansas","KY Kentucky","LA Louisiana","ME Maine","MD Maryland","MA Massachusetts",
    "MI Michigan","MN Minnesota","MS Mississippi","MO Missouri","MT Montana","NE Nebraska","NV Nevada",
    "NH New Hampshire","NJ New Jersey","NM New Mexico","NY New York","NC North Carolina","ND North Dakota",
    "OH Ohio","OK Oklahoma","OR Oregon","PA Pennsylvania","RI Rhode Island","SC South Carolina","SD South Dakota",
    "TN Tennessee","TX Texas","UT Utah","VT Vermont","VA Virginia","WA Washington","WV West Virginia",
    "WI Wisconsin","WY Wyoming",
  ].map((s) => ({ code: s.slice(0, 2), name: s.slice(3) })),
  CA: [
    "AB Alberta","BC British Columbia","MB Manitoba","NB New Brunswick","NL Newfoundland and Labrador",
    "NS Nova Scotia","NT Northwest Territories","NU Nunavut","ON Ontario","PE Prince Edward Island",
    "QC Quebec","SK Saskatchewan","YT Yukon",
  ].map((s) => ({ code: s.slice(0, 2), name: s.slice(3) })),
};

/** Postal-code format patterns for common countries. Unknown countries are not
 *  validated (treated as always valid). Patterns are intentionally lenient. */
export const POSTAL_PATTERNS: Record<string, RegExp> = {
  US: /^\d{5}(-\d{4})?$/,
  CA: /^[A-Za-z]\d[A-Za-z][ ]?\d[A-Za-z]\d$/,
  GB: /^[A-Za-z]{1,2}\d[A-Za-z\d]?[ ]?\d[A-Za-z]{2}$/,
  PL: /^\d{2}-\d{3}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  IT: /^\d{5}$/,
  ES: /^\d{5}$/,
  NL: /^\d{4}[ ]?[A-Za-z]{2}$/,
  AU: /^\d{4}$/,
  JP: /^\d{3}-?\d{4}$/,
  IN: /^\d{6}$/,
  BR: /^\d{5}-?\d{3}$/,
  CH: /^\d{4}$/,
  SE: /^\d{3}[ ]?\d{2}$/,
};

/** True when the postal code is empty, the country is unknown, or it matches. */
export function postalCodeValid(iso: string | undefined, postal: string | undefined): boolean {
  if (!postal || !iso) return true;
  const pat = POSTAL_PATTERNS[iso];
  return pat ? pat.test(postal.trim()) : true;
}
