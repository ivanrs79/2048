// Basic offensive-name filter. Catches common English (plus a few Portuguese
// and Spanish) swear words and slurs, including simple disguises such as
// "f.u.c.k", "fuuuck" or "sh1t". It's deliberately simple: it won't catch
// everything, and it avoids matching innocent names (e.g. "Cassandra",
// "therapist", "Nigel") by only checking short or ambiguous words as whole words.

// Blocked anywhere inside the name, even glued to other letters.
const BLOCKED_ANYWHERE = [
  'fuck', 'shit', 'bitch', 'whore', 'slut', 'porn', 'penis', 'vagina', 'pussy', 'dildo',
  'cocksuck', 'motherf', 'asshole', 'dickhead', 'wanker', 'bastard', 'hitler',
  'cumshot', 'caralho', 'buceta', 'merda', 'mierda', 'pendejo', 'cabron', 'joder',
];
// Real names that happen to contain a blocked stem; removed before checking.
const ALLOWED_NAMES = ['kshitij', 'matsushita', 'shitake', 'shiitake', 'scunthorpe'];
// Stems with double letters, checked without collapsing repeats.
const BLOCKED_ANYWHERE_EXACT = ['nigger', 'nigga', 'faggot', 'fagg', 'kkk'];
// Blocked only as a separate word ("sex" is blocked, "Sussex" is fine).
const BLOCKED_WORDS = [
  'ass', 'arse', 'cunt', 'dick', 'cock', 'fag', 'rape', 'rapist', 'sex', 'sexy', 'kys', 'retard',
  'twat', 'wank', 'cum', 'tit', 'tits', 'boob', 'boobs', 'anal', 'horny', 'nude', 'nudes', 'jizz',
  'fuk', 'nazi', 'puta', 'puto', 'porra', 'foda', 'viado', 'cono', 'culo',
];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };

function normalizeForFilter(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents: e.g. e-acute -> e
    .replace(/[0134578@$!]/g, ch => LEET[ch]);
}

function isOffensiveName(name) {
  const text = normalizeForFilter(name);
  let letters = text.replace(/[^a-z]/g, ''); // "f.u.c.k" -> "fuck"
  for (const ok of ALLOWED_NAMES) letters = letters.split(ok).join('');
  const collapsed = letters.replace(/(.)\1+/g, '$1'); // "fuuuck" -> "fuck"
  if (BLOCKED_ANYWHERE_EXACT.some(w => letters.includes(w))) return true;
  if (BLOCKED_ANYWHERE.some(w => letters.includes(w) || collapsed.includes(w.replace(/(.)\1+/g, '$1')))) return true;
  const words = text.split(/[^a-z]+/).filter(Boolean);
  return words.some(w => BLOCKED_WORDS.includes(w) || BLOCKED_WORDS.includes(w.replace(/(.)\1+/g, '$1')));
}
