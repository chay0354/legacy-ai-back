/** Keep English sessions from displaying / being biased by Arabic, German, Hebrew, etc. */

export function normalizeLangCode(code) {
  const base = String(code || 'en').trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2}$/.test(base) ? base : 'en';
}

const FOREIGN_SCRIPT_FOR_EN =
  /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0400-\u04FF]/;

const GERMAN_WORD_RE =
  /\b(und|oder|nicht|auch|aber|wenn|weil|dann|noch|schon|sehr|hier|dort|heute|morgen|bitte|danke|guten|tag|abend|morgen|herr|frau|mein|meine|dein|deine|ihre|ihr|über|schön|können|möchte|etwas|nichts|jetzt|haben|wird|werden|sind|ist|das|der|die|den|dem|ein|eine|einen|einem|ich|sie|wir|ihr|euch|mich|dich|sich|mit|auf|für|von|zu|zum|zur|bei|nach|vor|aus|ein|kein|keine|voll|richtig|falsch|warum|wieso|welche|welcher|dieses|diese|dieser|zwischen|während|vielleicht|natürlich|eigentlich|wirklich|genau|entschuldigung|wie\s+geht'?s)\b/gi;

export function foreignScriptRatio(text) {
  const letters = String(text || '').match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  const foreign = letters.filter((ch) => FOREIGN_SCRIPT_FOR_EN.test(ch)).length;
  return foreign / letters.length;
}

export function looksLikeGerman(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const umlauts = (t.match(/[äöüßÄÖÜ]/g) || []).length;
  const words = t.match(/[A-Za-zÄÖÜäöüß']+/g) || [];
  if (!words.length) return umlauts >= 2;
  const germanHits = (t.match(GERMAN_WORD_RE) || []).length;
  if (umlauts >= 2) return true;
  if (umlauts >= 1 && germanHits >= 2) return true;
  if (germanHits >= 4 && germanHits / words.length >= 0.28) return true;
  if (germanHits >= 3 && words.length <= 8 && germanHits / words.length >= 0.4) return true;
  return false;
}

export function textMatchesSessionLanguage(text, languageCode = 'en') {
  const lang = normalizeLangCode(languageCode);
  if (lang !== 'en') return true;
  if (foreignScriptRatio(text) >= 0.35) return false;
  if (looksLikeGerman(text)) return false;
  return true;
}

/** Redact Arabic/Hebrew/Cyrillic spans and omit German-drift lines in English sessions. */
export function sanitizeForSessionLanguage(text, languageCode = 'en') {
  const lang = normalizeLangCode(languageCode);
  const raw = String(text || '');
  if (lang !== 'en' || !raw) return raw;
  if (textMatchesSessionLanguage(raw, lang)) return raw;

  let cleaned = raw
    .replace(
      /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0400-\u04FF]+/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();

  if (looksLikeGerman(cleaned)) {
    return '[non-English speech omitted]';
  }

  return cleaned || '[non-English speech omitted]';
}
