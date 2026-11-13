/**
 * Languages for the matchmaking site. English is written in the code; other languages
 * translate the rendered page: every text node and a few attributes are looked up in a
 * dictionary (exact text, then patterns for text with numbers or names in it). That also
 * covers messages from the server (statuses, reasons, errors). Text that isn't in the
 * dictionary stays English. Mark an element `data-no-translate` to leave it alone.
 */

export type Lang = "en" | "da";
export const LANGS: { id: Lang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "da", label: "Dansk" },
];

const DA: Record<string, string> = {
  // Page
  "Can't reach the matchmaking site. Retrying…": "Kan ikke nå matchmaking-siden. Prøver igen…",
  "Loading…": "Indlæser…",
  "Sign out": "Log ud",
  "Lost the connection. Retrying…": "Forbindelsen blev afbrudt. Prøver igen…",
  Dismiss: "Luk",
  "Matchmaking is closed right now. Check back when the event starts.": "Matchmaking er lukket lige nu. Kig forbi, når eventet starter.",
  "Play with even teams": "Spil med lige hold",
  "needs no sign-in: just press Join above. For": "kræver ikke login: tryk bare Deltag ovenfor. Til",
  "matches, sign in through Steam.": "kampe skal du logge ind med Steam.",
  "Sign in with Steam and pick a lobby:": "Log ind med Steam og vælg en lobby:",
  ". Teams are made from everyone's Premier rating so both sides are about equal, and a bot fills in when the numbers are odd. The captains then ban maps until one is left, and you get a button to join the server.":
    ". Holdene laves ud fra alles Premier-rating, så begge sider er nogenlunde lige gode, og en bot fylder ud ved ulige antal. Kaptajnerne banner derefter baner, til der er én tilbage, og du får en knap til at gå ind på serveren.",
  "Sign in through Steam": "Log ind med Steam",
  "Steam only tells this site your SteamID, name and avatar. Your password stays with Steam.":
    "Steam fortæller kun siden dit SteamID, navn og billede. Din adgangskode bliver hos Steam.",
  Matches: "Kampe",
  // Lobbies
  Competitive: "Competitive",
  Wingman: "Wingman",
  "Fixed teams 5v5": "Faste hold 5v5",
  "Fixed teams 2v2": "Faste hold 2v2",
  "Balanced by rating": "Afbalanceret efter rating",
  "Short, small maps": "Korte kampe, små baner",
  "Aim duel, first to 16": "Aim-duel, først til 16",
  "Pick your own side": "Vælg selv dit hold",
  "Wingman, your own side": "Wingman, vælg selv dit hold",
  // Status board
  "Sign in with Steam": "Log ind med Steam",
  "Needed for matches, not for casual.": "Kræves til kampe, ikke til casual.",
  "Link Discord": "Forbind Discord",
  "We move you to your team's voice channel.": "Vi flytter dig til dit holds talekanal.",
  "Open CS2": "Åbn CS2",
  "The Join button only works with the game running.": "Deltag-knappen virker kun, når spillet kører.",
  "Join a lobby": "Gå ind i en lobby",
  "Pick one in the table.": "Vælg en i tabellen.",
  "The Join button only works with the game running. Tick it when it's open.": "Deltag-knappen virker kun, når spillet kører. Sæt flueben, når det er åbent.",
  "Leave lobby": "Forlad lobby",
  "Open CS2: done": "Åbn CS2: klaret",
  "Ready to play?": "Klar til at spille?",
  "Tick these off and you're in.": "Sæt flueben ved dem her, så er du med.",
  "(optional)": "(valgfrit)",
  Lobbies: "Lobbyer",
  "match servers free": "kampservere ledige",
  of: "af",
  Mode: "Spiltype",
  Teams: "Hold",
  Waiting: "Venter",
  Join: "Deltag",
  "Sign in to join": "Log ind for at deltage",
  "No lobbies are open right now.": "Ingen lobbyer er åbne lige nu.",
  "Live matches": "Kampe i gang",
  // Discord
  Discord: "Discord",
  "Linked as": "Forbundet som",
  "Link your Discord account once": "Forbind din Discord-konto én gang",
  "and the bot can move you into your team's voice channel when your match starts": "så kan botten flytte dig ind i dit holds talekanal, når kampen starter",
  ". Optional: you can always play without it.": ". Valgfrit: du kan altid spille uden.",
  "Link Discord account": "Forbind Discord-konto",
  "Discord linked.": "Discord er forbundet.",
  "Move me to my match's voice channel": "Flyt mig til min kamps talekanal",
  "· from any voice channel on Discord": "· fra enhver talekanal på Discord",
  "· when I'm in the waiting room on Discord": "· når jeg er i venterummet på Discord",
  "Also when I'm in another voice channel, not just the waiting room": "Også når jeg er i en anden talekanal, ikke kun i venterummet",
  "Move me back after the match": "Flyt mig tilbage efter kampen",
  "(to the channel I came from)": "(til den kanal, jeg kom fra)",
  "to the waiting room": "til venterummet",
  "Automatic voice moving isn't switched on for this event; the Join Discord channel button works as always.":
    "Automatisk flytning i Discord er ikke slået til til dette event; knappen Gå til Discord-kanal virker som altid.",
  "Unlink Discord": "Fjern Discord",
  "Join Discord channel": "Gå til Discord-kanal",
  "Open in browser instead": "Åbn i browseren i stedet",
  "Not on our Discord? Join here": "Ikke på vores Discord? Kom med her",
  // Rating
  "Your rating": "Din rating",
  "Asking Leetify…": "Spørger Leetify…",
  "Your Premier rating from Leetify.": "Din Premier-rating fra Leetify.",
  "View on Leetify": "Se på Leetify",
  "Set by the organiser.": "Sat af arrangøren.",
  "Enter your Premier rating so the teams come out even.": "Skriv din Premier-rating, så holdene bliver lige.",
  "Premier rating": "Premier-rating",
  Save: "Gem",
  "set by organiser": "sat af arrangøren",
  "no rating": "ingen rating",
  // Lobby picker and lobby
  "Pick a lobby": "Vælg en lobby",
  "Nobody here yet": "Ingen her endnu",
  "Join any time, no teams made": "Kom ind når som helst, ingen hold",
  "playing now": "spiller nu",
  "Mark yourself ready to make teams.": "Markér dig klar for at lave hold.",
  "Waiting for more ready players.": "Venter på flere klar spillere.",
  "(with a bot if needed)": "(med en bot, hvis det behøves)",
  Lobby: "Lobby",
  Ready: "Klar",
  Leave: "Forlad",
  "match on": "kamp på",
  "the veto": "banevalget",
  "has room.": "har plads.",
  "Jump in now instead of waiting for the next one.": "Hop ind nu i stedet for at vente på den næste.",
  "Join that match": "Deltag i den kamp",
  "Make teams": "Lav hold",
  "Switch to": "Skift til",
  "Pick a team to play.": "Vælg et hold for at spille.",
  "Both teams are full: anyone on a team can start.": "Begge hold er fulde: alle på et hold kan starte.",
  "You voted to start. Waiting for the other captain.": "Du har stemt for at starte. Venter på den anden kaptajn.",
  "The teams aren't full: the two captains (★) vote to start.": "Holdene er ikke fulde: de to kaptajner (★) stemmer om at starte.",
  "· captain voted to start": "· kaptajnen har stemt for at starte",
  "Sit out": "Sid over",
  "Team 1": "Hold 1",
  "Team 2": "Hold 2",
  "Waiting for a spot": "Venter på en plads",
  "Start: ban maps": "Start: ban baner",
  "Vote to start": "Stem for at starte",
  "Not ready": "Ikke klar",
  "In a match": "I en kamp",
  Captain: "Kaptajn",
  "(you)": "(dig)",
  // Drafts
  "Proposed teams": "Foreslåede hold",
  Option: "Forslag",
  "Difference in average rating:": "Forskel i gennemsnitlig rating:",
  "· the bot counts as": "· botten tæller som",
  "Go: ban maps": "Kør: ban baner",
  "Other teams": "Andre hold",
  Cancel: "Annullér",
  "The players on these teams decide whether to go.": "Spillerne på disse hold bestemmer, om de vil køre.",
  // Match
  "Map veto": "Banevalg",
  Score: "Stilling",
  "Your turn: ban a map.": "Din tur: ban en bane.",
  "is banning a map.": "banner en bane.",
  "Banned by": "Bannet af",
  "(time ran out)": "(tiden løb ud)",
  Ban: "Ban",
  "Tell your captain which maps to ban. A random map is banned if time runs out.":
    "Sig til din kaptajn, hvilke baner der skal bannes. En tilfældig bane bannes, hvis tiden løber ud.",
  "Pick your side on": "Vælg side på",
  "is picking a side on": "vælger side på",
  Terrorists: "Terrorister",
  "Counter-Terrorists": "Counter-Terrorister",
  "Join the server": "Gå ind på serveren",
  "Start CS2 first, then press Join.": "Start CS2 først, og tryk så Deltag.",
  "Or paste in the CS2 console": "Eller indsæt i CS2-konsollen",
  "Start without waiting": "Start uden at vente",
  "There's room in this match.": "Der er plads i denne kamp.",
  "You'd play for": "Du ville spille for",
  "in place of the bot": "i stedet for botten",
  "Join this match": "Deltag i denne kamp",
  "Let people join mid-match": "Lad folk komme med midt i kampen",
  "Open. It closes only if both captains untick this.": "Åben. Den lukker kun, hvis begge kaptajner fjerner fluebenet.",
  "Still open: the other captain wants it open.": "Stadig åben: den anden kaptajn vil have den åben.",
  "Closed: both captains said no.": "Lukket: begge kaptajner sagde nej.",
  "Others can join this match if a team has room.": "Andre kan komme med i kampen, hvis et hold har plads.",
  "Closed to new players by the captains.": "Lukket for nye spillere af kaptajnerne.",
  "Fill the empty spots with bots": "Fyld de tomme pladser med bots",
  "Fill the short team with a bot": "Fyld det korte hold op med en bot",
  "The bot plays. It's left out only if both captains untick this.": "Botten spiller. Den er kun ude, hvis begge kaptajner fjerner fluebenet.",
  "The bot still plays: the other captain wants it.": "Botten spiller stadig: den anden kaptajn vil have den.",
  "No bots: both captains said no, so the teams play short.": "Ingen bots: begge kaptajner sagde nej, så holdene spiller med færre.",
  "No bots: the teams play short.": "Ingen bots: holdene spiller med færre.",
  "On. It turns off only if both captains untick this.": "Til. Det slås kun fra, hvis begge kaptajner fjerner fluebenet.",
  "Still on: the other captain wants bots.": "Stadig til: den anden kaptajn vil have bots.",
  "Off: both captains said no, so empty spots stay empty.": "Fra: begge kaptajner sagde nej, så tomme pladser forbliver tomme.",
  "No bots: if someone disconnects, their team plays short.": "Ingen bots: hvis nogen falder ud, spiller deres hold med færre.",
  "The teams are full. If someone disconnects, a bot takes their spot.": "Holdene er fulde. Hvis nogen falder ud, tager en bot deres plads.",
  "1v1 matches have no bots.": "1v1-kampe har ingen bots.",
  "Cancel match": "Annullér kamp",
  "Banning maps": "Banner baner",
  "Picking sides": "Vælger sider",
  Starting: "Starter",
  Live: "I gang",
  Finished: "Færdig",
  Cancelled: "Annulleret",
  Ended: "Slut",
  Copied: "Kopieret",
  Copy: "Kopiér",
  "Join any time · no sign-in": "Kom ind når som helst · intet login",
  "Offline right now": "Offline lige nu",
  // From the server
  "Captains are banning maps": "Kaptajnerne banner baner",
  "Getting the server ready": "Gør serveren klar",
  "Loading the map": "Indlæser banen",
  "Match in progress": "Kampen er i gang",
  "Match over": "Kampen er slut",
  "Server ready. Join now; the match starts when everyone is in.": "Serveren er klar. Gå ind nu; kampen starter, når alle er inde.",
  "Starting the server": "Starter serveren",
  "Waiting for the server to answer": "Venter på svar fra serveren",
  "Both teams are full.": "Begge hold er fulde.",
  "The captains have closed this match to new players.": "Kaptajnerne har lukket kampen for nye spillere.",
  "Too late to join: the match is nearly over.": "For sent at komme med: kampen er næsten slut.",
  "You're in another match.": "Du er i en anden kamp.",
  "Each team needs at least one player.": "Hvert hold skal have mindst én spiller.",
  "At least 2 ready players are needed to make teams.": "Der skal mindst 2 klar spillere til at lave hold.",
  "Every matchmaking server is busy. Wait for a match to finish.": "Alle matchmaking-servere er optaget. Vent på, at en kamp bliver færdig.",
  "Finish your match before changing lobby.": "Gør din kamp færdig, før du skifter lobby.",
  "In Fixed teams, pick a team and press Start.": "I Faste hold vælger du et hold og trykker Start.",
  "Join a Fixed teams lobby first.": "Gå ind i en Faste hold-lobby først.",
  "Join a lobby first.": "Gå ind i en lobby først.",
  "Join the lobby first.": "Gå ind i lobbyen først.",
  "Matchmaking is switched off right now.": "Matchmaking er slået fra lige nu.",
  "Pick a team first.": "Vælg et hold først.",
  "Sides are already picked.": "Siderne er allerede valgt.",
  "That map is already banned.": "Den bane er allerede bannet.",
  "That match has already ended.": "Den kamp er allerede slut.",
  "That team is full.": "Det hold er fuldt.",
  "The map veto is over.": "Banevalget er slut.",
  "The match has already started.": "Kampen er allerede startet.",
  "The server isn't ready yet.": "Serveren er ikke klar endnu.",
  "The teams changed. Try again.": "Holdene har ændret sig. Prøv igen.",
  "This match has no bot.": "Denne kamp har ingen bot.",
  "Those teams aren't up any more.": "De hold findes ikke længere.",
  "You're already in a match.": "Du er allerede i en kamp.",
  "You're in a match.": "Du er i en kamp.",
  "It's the other captain's turn.": "Det er den anden kaptajns tur.",
  "Only players in this match can do that.": "Kun spillere i denne kamp kan gøre det.",
  "Only players on these teams can do that.": "Kun spillere på disse hold kan gøre det.",
  "Only the captains vote on this.": "Kun kaptajnerne stemmer om dette.",
  "The other captain picks the side.": "Den anden kaptajn vælger side.",
  "The teams aren't full: only the two captains can start (both have to vote).": "Holdene er ikke fulde: kun de to kaptajner kan starte (begge skal stemme).",
  "You're banned from these servers.": "Du er udelukket fra disse servere.",
  // Confirm dialogs
  "Start the match now, without waiting for everyone?": "Start kampen nu uden at vente på alle?",
  "Cancel this match for everyone?": "Annullér kampen for alle?",
};

/** Text with numbers or names in it: [pattern, Danish with $1…]. */
const DA_PATTERNS: [RegExp, string][] = [
  [/^(\d+) here, (\d+) ready$/, "$1 her, $2 klar"],
  [/^(\d+) here$/, "$1 her"],
  [/^up to (\d+)v(\d+)$/, "op til $1v$2"],
  [/^No server is set up for (.+) yet\. Ask the organiser\.$/, "Der er ingen server sat op til $1 endnu. Spørg arrangøren."],
  [/^All (.+) servers are busy; teams can be made when one is free\.$/, "Alle $1-servere er optaget; der kan laves hold, når en bliver ledig."],
  [/^All (.+) servers are busy; you can start when one is free\.$/, "Alle $1-servere er optaget; I kan starte, når en bliver ledig."],
  [
    /^(\d+) ready: (\d+) play now; the rest go first in the next match \(with a bot if needed\)\.$/,
    "$1 klar: $2 spiller nu; resten kommer først med i næste kamp (med en bot, hvis det behøves).",
  ],
  [/^(\d+) ready: (\d+) play now; the rest go first in the next match\.$/, "$1 klar: $2 spiller nu; resten kommer først med i næste kamp."],
  [/^(\d+) ready: a bot joins the smaller team so everyone plays\.$/, "$1 klar: en bot kommer på det mindste hold, så alle spiller."],
  [/^(\d+) ready: two play now, the third goes first next time\.$/, "$1 klar: to spiller nu, den tredje kommer først med næste gang."],
  [/^No bot: both captains said no, so (.+) plays one short\.$/, "Ingen bot: begge kaptajner sagde nej, så $1 spiller med én mindre."],
  [/^Bots fill the empty spots \((\d+) on (.+), (\d+) on (.+)\)\.$/, "Bots fylder de tomme pladser ($1 på $2, $3 på $4)."],
  [
    /^Bots fill the empty spots \((\d+) on (.+), (\d+) on (.+)\), and take the spot of anyone who disconnects\.$/,
    "Bots fylder de tomme pladser ($1 på $2, $3 på $4) og tager pladsen for alle, der falder ud.",
  ],
  [/^A bot fills the empty spot on (.+)\.$/, "En bot fylder den tomme plads på $1."],
  [/^No bot: (.+) plays one short\.$/, "Ingen bot: $1 spiller med én mindre."],
  [/^Warmup · (\d+)\/(\d+) in$/, "Opvarmning · $1/$2 inde"],
  [/^Warmup: (\d+) of (\d+) players in$/, "Opvarmning: $1 af $2 spillere inde"],
  [/^Or paste in the CS2 console \(password (.+)\)$/, "Eller indsæt i CS2-konsollen (adgangskode $1)"],
  [
    /^Not full yet \((\d+)v(\d+)\): both captains vote to start, and bots fill the empty spots\.$/,
    "Ikke fuldt endnu ($1v$2): begge kaptajner stemmer om at starte, og bots fylder de tomme pladser.",
  ],
  [/^Every (.+) server is busy\. Wait for a match to finish\.$/, "Alle $1-servere er optaget. Vent på, at en kamp bliver færdig."],
  [/^The (.+) lobby isn't open\.$/, "$1-lobbyen er ikke åben."],
  [/^Enter your Premier rating as a number from 0 to (.+)\.$/, "Skriv din Premier-rating som et tal fra 0 til $1."],
  [/^Team (.+)$/, "Hold $1"],
];

const STORE = "cs2mm-lang";
let current: Lang = "en";

/** The visitor's own choice, if they made one on this device. */
export function savedLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORE);
    return v === "en" || v === "da" ? v : null;
  } catch {
    return null;
  }
}

function translate(text: string): string | null {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  const core = m[2]!.replace(/\s+/g, " ");
  if (!core || current === "en") return null;
  let out: string | undefined = DA[core];
  if (out === undefined) {
    for (const [re, rep] of DA_PATTERNS) {
      if (re.test(core)) {
        out = core.replace(re, rep);
        break;
      }
    }
  }
  return out === undefined ? null : m[1] + out + m[3];
}

/** For text outside the page (dialogs). */
export const tr = (text: string) => translate(text)?.trim() ?? text;

const ATTRS = ["title", "aria-label", "placeholder"];
const textOrig = new WeakMap<Node, string>();
const textShown = new WeakMap<Node, string>();
const attrMemo = new WeakMap<Element, Record<string, { orig: string; shown: string }>>();

const skip = (el: Element | null) => !!el?.closest("[data-no-translate], script, style, code, textarea");

function fixText(n: Node) {
  const v = n.nodeValue ?? "";
  if (textShown.get(n) === v) {
    // Ours. Back to English when switching.
    if (current === "en") {
      n.nodeValue = textOrig.get(n) ?? v;
      textShown.delete(n);
    }
    return;
  }
  if (current === "en" || skip(n.parentElement)) return;
  const t = translate(v);
  if (t !== null && t !== v) {
    textOrig.set(n, v);
    textShown.set(n, t);
    n.nodeValue = t;
  }
}

function fixAttr(el: Element, name: string) {
  const v = el.getAttribute(name);
  if (v === null) return;
  const memo = attrMemo.get(el) ?? {};
  const seen = memo[name];
  if (seen && seen.shown === v) {
    if (current === "en") {
      el.setAttribute(name, seen.orig);
      delete memo[name];
    }
    return;
  }
  if (current === "en" || skip(el)) return;
  const t = translate(v);
  if (t !== null && t !== v) {
    memo[name] = { orig: v, shown: t };
    attrMemo.set(el, memo);
    el.setAttribute(name, t);
  }
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return fixText(root);
  if (!(root instanceof Element)) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n: Node | null = root; n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) fixText(n);
    else for (const a of ATTRS) if ((n as Element).hasAttribute(a)) fixAttr(n as Element, a);
  }
}

let observer: MutationObserver | null = null;

/** Switches the page's language (and remembers a visitor's own choice). */
export function setLang(lang: Lang, remember = false) {
  current = lang;
  document.documentElement.lang = lang;
  if (remember)
    try {
      localStorage.setItem(STORE, lang);
    } catch {
      /* private mode: just for this visit */
    }
  if (!observer) {
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData") fixText(m.target);
        else if (m.type === "attributes" && m.attributeName) fixAttr(m.target as Element, m.attributeName);
        else m.addedNodes.forEach(walk);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    const confirm = window.confirm.bind(window);
    window.confirm = (msg?: string) => confirm(msg === undefined ? msg : tr(msg));
  }
  walk(document.body);
}
