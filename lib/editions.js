// Which Google News edition to read, for somewhere that is not here.
//
// This exists because of a measurement rather than a hunch. Asked what was
// happening in Seoul, Greg searched "Seoul, South Korea" in the **US English**
// edition — the `hl`, `gl` and `ceid` were hard-coded — and came back with World
// Youth Day 2027, a religious-freedom press release and a POSCO steel-tariff
// story. Read against the Korean edition's own front page the same minute:
// Democratic Party primaries, a housing dispute, tomorrow's weather, an election
// recount row, medical-school admissions quotas.
//
// Those are not the same news with a different accent. **The US edition returns
// English-language coverage ABOUT a country, written for foreigners**, and there
// is a whole domestic press it never touches. A reader in Seoul told the user
// none of Greg's headlines mattered there, and they were right.
//
// So: read the local edition, and translate what comes back. Translation alone
// would have fixed nothing — it would have translated the wrong stories.

// Country code -> the edition Google serves that country, and the language it
// comes back in. `ceid` is the pair Google actually keys on.
//
// Deliberately a short, honest list rather than every ISO code with a guess
// attached. Somewhere not named here falls back to the international English
// edition, which is a worse answer than the local press and a much better one
// than pretending: `translate` false means nothing claims to have been
// translated when it has not.
const EDITIONS = {
  KR: { hl: "ko", gl: "KR", language: "Korean" },
  JP: { hl: "ja", gl: "JP", language: "Japanese" },
  CN: { hl: "zh-CN", gl: "CN", language: "Chinese" },
  TW: { hl: "zh-TW", gl: "TW", language: "Chinese" },
  FR: { hl: "fr", gl: "FR", language: "French" },
  DE: { hl: "de", gl: "DE", language: "German" },
  ES: { hl: "es", gl: "ES", language: "Spanish" },
  MX: { hl: "es-419", gl: "MX", language: "Spanish" },
  AR: { hl: "es-419", gl: "AR", language: "Spanish" },
  IT: { hl: "it", gl: "IT", language: "Italian" },
  PT: { hl: "pt-PT", gl: "PT", language: "Portuguese" },
  BR: { hl: "pt-BR", gl: "BR", language: "Portuguese" },
  RU: { hl: "ru", gl: "RU", language: "Russian" },
  UA: { hl: "uk", gl: "UA", language: "Ukrainian" },
  PL: { hl: "pl", gl: "PL", language: "Polish" },
  NL: { hl: "nl", gl: "NL", language: "Dutch" },
  SE: { hl: "sv", gl: "SE", language: "Swedish" },
  NO: { hl: "no", gl: "NO", language: "Norwegian" },
  DK: { hl: "da", gl: "DK", language: "Danish" },
  FI: { hl: "fi", gl: "FI", language: "Finnish" },
  GR: { hl: "el", gl: "GR", language: "Greek" },
  TR: { hl: "tr", gl: "TR", language: "Turkish" },
  IL: { hl: "he", gl: "IL", language: "Hebrew" },
  SA: { hl: "ar", gl: "SA", language: "Arabic" },
  EG: { hl: "ar", gl: "EG", language: "Arabic" },
  IR: { hl: "fa", gl: "IR", language: "Persian" },
  TH: { hl: "th", gl: "TH", language: "Thai" },
  VN: { hl: "vi", gl: "VN", language: "Vietnamese" },
  ID: { hl: "id", gl: "ID", language: "Indonesian" },
  IN: { hl: "hi", gl: "IN", language: "Hindi" },

  // English-speaking editions: a real local front page, and nothing to translate.
  US: { hl: "en-US", gl: "US", language: "English" },
  GB: { hl: "en-GB", gl: "GB", language: "English" },
  IE: { hl: "en-IE", gl: "IE", language: "English" },
  AU: { hl: "en-AU", gl: "AU", language: "English" },
  NZ: { hl: "en-NZ", gl: "NZ", language: "English" },
  CA: { hl: "en-CA", gl: "CA", language: "English" },
  ZA: { hl: "en-ZA", gl: "ZA", language: "English" },
  NG: { hl: "en-NG", gl: "NG", language: "English" },
  PH: { hl: "en-PH", gl: "PH", language: "English" },
  SG: { hl: "en-SG", gl: "SG", language: "English" },
};

const DEFAULT = { hl: "en-US", gl: "US", language: "English" };

/**
 * The edition for a country code.
 *
 * `translate` says whether anything coming back will need turning into English,
 * and it is the flag the caller must not ignore — a Korean headline handed
 * straight to a text-to-speech voice is unintelligible noise, and a Korean
 * headline SAID to be English is a lie about what was read.
 */
export function editionFor(countryCode) {
  const code = String(countryCode ?? "").trim().toUpperCase();
  const found = EDITIONS[code];
  const edition = found ?? DEFAULT;

  return {
    ...edition,
    ceid: `${edition.gl}:${edition.hl}`,
    known: Boolean(found),
    translate: edition.language !== "English",
    countryCode: code || null,
  };
}

/** Every edition, for anyone who wants to know what is covered. */
export function knownEditions() {
  return Object.entries(EDITIONS).map(([code, e]) => ({ code, ...e }));
}
