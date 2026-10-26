"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { CATALOG_URL, fetchChannels } = require("../lib/geil.cjs");

const GROUP = "Turkey";
const M3U_FILE = path.join(__dirname, "..", "iptv.m3u");
const EPG_FILE = path.join(__dirname, "..", "epg.xml");

// Upstream free TR EPG (gzipped XMLTV). Matched to Vavoo channels by fuzzy name.
const EPG_UPSTREAM_URL =
  process.env.EPG_UPSTREAM_URL ||
  "https://epgshare01.online/epgshare01/epg_ripper_TR1.xml.gz";

// Optional directory of iptv-org/epg grab outputs (XMLTV per site).
// Provided by CI when the grab step runs; overrides epgshare01 when a channel is present.
const IPTVORG_GRAB_DIR = process.env.IPTVORG_GRAB_DIR || "";

// iptv-org public metadata for channel logos (name/alt_names → logo url).
const IPTVORG_CHANNELS_URL =
  process.env.IPTVORG_CHANNELS_URL ||
  "https://iptv-org.github.io/api/channels.json";
const IPTVORG_LOGOS_URL =
  process.env.IPTVORG_LOGOS_URL || "https://iptv-org.github.io/api/logos.json";

// Cloudflare Workers proxy base (no trailing slash). Set via GitHub Actions variable.
const PROXY_BASE = (process.env.PROXY_BASE || "").replace(/\/+$/, "");

// Where players should fetch the generated XMLTV EPG.
const EPG_URL =
  process.env.EPG_URL ||
  "https://raw.githubusercontent.com/kadirmetin/vavoo-iptv/main/epg.xml";

// -- categorization --------------------------------------------------------

// Strip "4K TR:" prefix, quality tags and .b/.c/.s source suffixes for matching
// only — the displayed name is unchanged.
function normalizeForCategory(name) {
  let s = String(name || "")
    .replace(/^\s*4K TR:\s*/i, "")
    .replace(/\s+(?:UHD|FHD|HD\+|HD|SD|HEVC|RAW|H265|H\.265|FEED)(?=\s|$)/gi, " ")
    .replace(/\s*\.(?:b|c|s)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // Vavoo often strips Turkish characters (İ, Ü, Ç, Ş, Ğ, Ö), leaving single-letter
  // fragments like "T RK" (TÜRK), "AK T" (AKİT), "BENG T RK" (BENGÜTÜRK),
  // "S NEMA" (SİNEMA), "M N KA" (MİNİKA), "OCUK" (ÇOCUK). Restore common
  // patterns so category regexes can match them.
  s = s
    .replace(/\bT RK\b/g, "TURK")
    .replace(/\bT RKIYEM\b/g, "TURKIYEM")
    .replace(/\bBENG\b/g, "BENGU")
    .replace(/\bBENGT\b/g, "BENGUT")
    .replace(/\bAK T\b/g, "AKIT")
    .replace(/\bS NEMA\b/g, "SINEMA")
    .replace(/\bM N KA\b/g, "MINIKA")
    .replace(/\bOCUK\b/g, "COCUK")
    .replace(/\bM Z K\b/g, "MUZIK")
    .replace(/\bS ZC\b/g, "SOZCU")
    .replace(/\bSZC\b/g, "SOZCU")
    .replace(/\bLKE\b/g, "ULKE")
    .replace(/\bYE IL AM\b/g, "YESILCAM")
    .replace(/\bYE IL[ ]?CAM\b/g, "YESILCAM")
    .replace(/\bT[ÜU]RK\b/gi, "TURK");

  return s;
}

// Rules are evaluated top-to-bottom. First match wins, so specific rules
// (Çocuk, Spor, Belgesel) come before broad ones (Ulusal, Yerel).
const CATEGORY_RULES = [
  {
    name: "Radyo",
    re: /\b(RADIO|RADYO)\b|\b(FM|MBAT FM|EFKAR FM|FMTV|F ?M)\b(?!\s*TV)|POWERTURK|POWER FM|SHOW RADYO|ALEM (?:FM|RADYO)|BABA RADYO|KRAL POP RADYO|PAL STATION|X NOSTALJI|RADIO ROCK|STANBUL FM/i,
  },
  {
    name: "Çocuk",
    re: /CARTOON|BOOMERANG|DISNEY|NICK(?:ELODEON|TOONS|JR|JUNIOR|\b)|BABY ?TV|BABYTV|M[İI]?N ?KA|MINIKA|POKEMON|POKÉMON|ANIMATION|ANIMASYON|TRT ?[ÇC]?OCUK|OCUK HD|\bCOCUK\b|\b[ÇC]OCUK\b|BEN ?10|ANGRY BIRDS|CAILLOU|PEPPA|PEPE|HEIDI|SIRINLER|TOM & JERRY|S[ÜU]NGER|SPIDERMAN|BARBIE|PIJAMA|PIRIL|RAFADAN|KELOGLAN|KUKULI|KUKILI|KOSTEBEK|CHICKY|BOOBA|WAKFU|GABBY|TAYO|NILOYA|PISI|LEYLEK|MASAL|CANIM KARDESIM|ADIBESA|MOMO|ALVIN|VIKINGLER|TRANSFORMERS|TROL AVCILARI|SMART COCUK|ILAHI COCUK|CILGIN ORMAN|KRAL SAKIR|SERCE KUS|ITFAYECI SAM|MUFFETIS|MAYMUNLAR|ELIF VE|ELIFIN|MIMOCAN|HAPSUU|RUYA TRENI|MASA KOCAAYI|PAK PIRPIR|LIMON ZEYTIN|GONCA TV|NASREDDIN|SEKER HOCA|SEVIMLI DOSTLAR|PAW PETROL|OSCAR COLLERDE|SL NILOYA|CBEEBIES|DUCK TV|JIM ?JAM|ENGLISH CLUB TV|EBA TV|TAV[SŞ]AN|PATRON BEBEK|D[İI]YARI|BAHA\b|SEF ROKKA|BULMACA KULESI|AKILLI TAV[SŞ]AN|AKLILI|CANIM KARDESIM|DA VINC KIDS|DA VINCI KIDS|DINAMIK ANIMASYON|DREAM ANIMASYON|MAX ANIMASYON|ENO ANIMASYON|BEST ANIMASYON|YILDIZ KIZ|KONU[SŞ]AN TOM|JURASSIC WORLD|MONTAG/i,
  },
  {
    name: "Belgesel",
    re: /DISCOVERY|NATIONAL GEOGRAPHIC|NAT ?GEO|\bHISTORY\b|ANIMAL PLANET|DA VINCI(?! KIDS)|VIASAT|BBC EARTH|LOVE NATURE|TRT BELGESEL|EPIC DRAMA|TARIH TV|TARIM TV|TGRT BELGESEL|INVESTIGATION|DMAX|DOCUBOX|DOCU SCREEN|SCIENCE|\bIZ TV\b|YABAN|OUTDOOR|CHASSE|ANIMAUX|AGRO TV|CIFTCI TV|REDBULL TV|\bTLC\b/i,
  },
  {
    name: "Spor",
    re: /BEIN SPO[RT]{0,3}S?|\bBEIN 1\b|S[- ]?SPORTS?|\bS SPORT\b|SPOR SMART|EUROSPORT|\bNBA\b|TJK TV|TIVIBU ?SPOR|TIVIBUSPOR|TRT SPOR|TABII SPOR|EXXEN SPO[RT]?|\bHT SPOR\b|EKOL SPOR|SPORTS TV|IDMAN TV|GALATASARAY TV|\bFB TV\b|\bGS TV\b|SARAN SPORT|SMART SPOR|\bSPOR\b|\bSPORT\b/i,
  },
  {
    name: "Film",
    re: /SINEMA|S[İI]NEMA|S NEMA|CINEMA|SINEMAX|SINEVIZYON|\bMOVIES?\b|MOVIEMAX|MOVIESMART|BEIN MOVIES|BEIN BOX|BOX OFFICE|\bFX\b|FX HD|YESILCAM|YE ?I ?L ?[ÇC] ?AM|YE ?I ?L ?AM|YEŞ?[İI]LC?AM|GLOBAL BOX|PROTURK|FIX CINEMA|KINGBOX|ARENA BOX|SHOWMAX|SHOW MAX|REAL BOX|SMART BOX|BEST (?:AKSIYON|BILIMKURGU|DRAM|HABABAM|IMBD|KOMEDI|KORKU|LOCA|NETFLIX|SALON|SAVAS|TURK|WESTERN|YESILCAM)|MAX (?:007|AKSIYON|GOLD|ORJINAL|PREMIER|STAR WARS|TURK|VIZYON|WESTERN)|DINAMIK (?:AKSIYON|BILIMKURGU|DRAM|IMBD|KOMEDI|KORKU|TURK|VIZYON|WESTERN|YESILCAM)|DREAM (?:AKSIYON|BEIN OFFICE|BOX|DRAM|KEMAL|KOMEDI|KORKU|LOCA|NETFLIX|SAVAS|WESTERN)|ULTRA (?:AKSIYON|BILIMKURGU|IMBD|KEMAL|KOMEDI|KORKU|TURK)|ENO (?:AKSIYON|VIZYON|WESTERN)|\bLOCA\b|\bSALON\b|\bVIZYON\b|AKSIYON|AKS[İIY]?YON|AKS YON|KOMED[İI]|\bKORKU\b|\bDRAM\b|WESTERN|BILIM ?KURGU|\bSAVAS\b|\bIMBD\b|\bIMDB\b|\bFILM\b|FILMBOX|HORROR|OSCAR|KEMAL SUNAL|\b007\b|\bCINE ?1\b|SIFIR TV|SON C BOOM|\bYERL[İI]\b|SPIDERMAN(?! TV)|ARENA BOX|MOVIE SMART|\bM ?T[UÜ]RK TV\b|\bM TURK TV\b|\bM T RK TV\b/i,
  },
  {
    name: "Dizi",
    re: /SER[İI]ES|\bDIZI\b|BEIN SERIES|D[İI]Z[İI] ?SMART|DIZISMART/i,
  },
  {
    name: "Müzik",
    re: /POWER T[UÜ]RK|POWER ?TV|POWERTURK|POWER (?:DANCE|LOVE|HD)|\bPOWER\b|KRAL POP|KRAL ?TV|\bKRAL\b|TRT M[UÜ]?Z[İI]?K|TRT MUZIK|NR ?1|NUMBER ?1|NUMBER ONE|DAMAR|ARABESK|AKUS ?T[İI]K|AHMET KAYA|IBRAHIM ERKAL|IBRAHIM TATLISES|\bTATLISES\b|ZERRIN OZER|SEZEN AKSU|TARKAN|SELDA BAGCAN|CENGIZ KURTOGLU|MAHSUN KIRMIZIGUL|MUSLUM GURSES|YILDIZ TILBE|FERDI TAYFUR|DURSUN AL|MTV LIVE|VINTAGE MUSIC|RETRO T ?RK|RETRO TURK|T[UÜ]?RK ?E POP|T RK E POP|T RK E KLASIK|SLOW KARADENIZ|\bSLOW\b|\bZARA\b|\bSONER ARICA\b|M[UÜ]Z[İI]K|\bFM TV\b|\bFMTV\b|REDBOX/i,
  },
  {
    name: "Haber",
    re: /\bHABER\b|\bNEWS\b|BLOOMBERG|\bCNN\b|EKOTURK|\bEKO ?T[UÜ]RK\b|\bEKOL\b|A ?PARA|APARA|PARANIN|HALK TV|TELE ?1|SOZCU|S ZC|\bSZC\b|BENGU ?T[UÜ]RK|BENGUTURK|TRT WORLD|\bDHA\b|LIDER HABER|FLASH HABER|MEDYA HABER|GLOBAL HABER|TRABZON HABER|BEIN SPORTS HABER|T[UÜ]RKHABER|HABERT[UÜ]RK|HABERT RK|\bARTI TV\b/i,
  },
  {
    name: "Dini",
    re: /D[İI]YANET|\bAK[İIY]?T\b|MEHTAP|H[İI]LAL|KUDUS|KUDÜS|KUD S|SEMERKAND|LALEGUL|LÂLEGÜL|L[AÂ]LEG[UÜ]L|MERCAN TV|VUSLAT|KARDELEN|DIYAR TV|\bDOST TV\b|\bYOL TV\b|\bKANAL 7\b|HAYAT|HAYIRLI|HZ MERYEM|HZ OMER|HZ YUSUF|MAM EBU|ASHABI KEHF|HASAN VE HUSEYIN|SAT ?7 T[UÜ]RK|TVNET|TRT DIYANET|\bTV ?5\b|\bTV5\b|REHBER|ILAHI|ILKE TV|MESAJ TV|SURELER|T[UÜ]RK ?E MEAL|DURSUN AL ERZINCANLI|YUNUS EMRE|CEM TV|BARBAROS TV|ASLAN TV|TYT TURK|SATRAN[ÇC]|FASIL/i,
  },
  {
    name: "Yaşam",
    re: /24 KITCHEN|GURME|BEIN GURME|LIFESTYLE|\bLIFE TV\b|FASHION|WM TV|EGE ILE GAGA|24 RAW|\bTVEM\b|\bTV EM\b|AUTOMOTO|LINE TV|BILGILENDIRME|WOMAN|TELEGRAM/i,
  },
  {
    name: "Ulusal",
    re: /^24$|\bTRT\b|\bTRT 1\b|\bTRT ?2\b|TRT2|\bTRT 3\b|TRT AVAZ|TRT T[UÜ]RK|TRT TURK|TRT KURD[İI]?|TRT WORLD|TRT 4K|TRT EBA|\bKANAL D\b|\bATV\b|ATV AVRUPA|ATV EUROPA|STAR TV|\bSTAR\b|STAR HD|SHOW TV|SHOW T[UÜ]RK|\bSHOW\b|\bFOX\b|NOW ?TV|\bNOW\b|TV ?8|TV8[.,]5|BEYAZ TV|BEYAZ HD|\bBEYAZ\b|\b360\b|24 TV|\bA2\b|A HABER|A NEWS|A PARA|A SPOR|TV ?100|TV ?4|FLASH TV|TEVE ?2|TEVE2|CNN T[UÜ]RK|CNN TURK|\bKRT\b|ULUSAL KANAL|DREAM T[UÜ]RK|DREAM TURK|\bDREAM TV\b|\bBRT ?[0-9]|\bBRTV\b|EURO ?D|EURO ?STAR|\bNTV\b|EXXEN TV|TIVI ?T[UÜ]RK|TABII|OLAY T[UÜ]RK|OLAY TURK|24 HD|24 HABER|24 KITCHEN|LKE ?TV|[UÜ]LKE ?TV|ULKE ?TV|ULKETV|TV DEN|TVDEN|KANAL AVRUPA|KANAL 7 (?:AVRUPA|EUROPA)|LKE TV|EURO D|EURO STAR|SHOW TV EUROPA|BENGU ?T[UÜ]RK|BENGU TURK|BENGUTURK|TGRT EU|D ?[ĞG] ?N TV|\bTBMM\b|TV NET|\bTV 1\b|TVO TV|BEIN IZ|\bMAX\b/i,
  },
  {
    name: "Yerel",
    re: /ADANA|AD[İI]YAMAN|AFYON|AKSARAY|ALANYA|ANAKKALE|\bANKARA\b|ANKA TV|ANKARA T[UÜ]RKIYEM|ANLIURFA|ANTALYA|\bBURSA\b|ELAZIG|ERCIS|ERZURUM|ESK[İI]SEHIR|ESK EH R|\bES TV\b|\bER TV\b|ETV KAYSERI|ETV MANISA|GAZIANTEP|\bICEL\b|K[İI]MARAS|KAHRAMANMARA|K MARAS|KAYSERI|KOCAELI|KON TV|KONYA|MALATYA|MERSIN|ORDU|ALTAS TV|SIVAS|TRABZON|TUNCELI|DERSIM|\bURFA\b|IZMIR TV|TON TV|KIBRIS|EDIRNE|DENIZLI|\bKAY TV\b|KENT T[UÜ]RK|KENT T RK|HUNAT|\bOBB\b|KANAL 12|KANAL 15|KANAL 23|KANAL 24|KANAL 26|KANAL 3\b|KANAL 32|KANAL 33|KANAL 34|KANAL 360|KANAL 42|KANAL 58|KANAL 68|KANAL FIRAT|KANAL URFA|KANAL V\b|\bKANAL Z\b|KANAL T\b|KANAL HAYAT|KANAL 68|KARADENIZ|GUNEYDOGU|GÜNEYDOĞU|\bEGE\b|MELTEM|CAY TV|TEK RUMEL|YENI KOCAELI|OLAY TV|\bGRT\b|SUN RTV|SUN TV|\bK[ÖO]Y TV\b|IZMIR|TIVI 6|TV 41|TV 42|TV 52|TV 264|KOZA TV|MC EU|MERCAN|KADIRGA|\bFANATIK\b|AS TV|ISVI|GURBET24|T\.A\.Y|TAY TV|\bTAY\b|\bTMB\b|AV TV|MAVI KARADENIZ|EGE ILE GAGA|GAZIANTEP GRT|VIYANA TV|LUYS|EDESSA|BIR TV|ANA[DK]OLU|B[İI]R TV|D[İI]YAR|ERTV|HRT|SIVAS|VIZYON 58|ADA TV|CAN TV|DEHA|SIFIR|EKIN T[UÜ]RK|AFROTURK|ARAS|ARKADAG|VATAN|D[ÖO]RU|AKSU TV|KARE TV|ON 4|ON 6|PAMUKKALE|UCANKUS|64 KARE|DENIZ POSTASI/i,
  },
];

function categorize(name) {
  const s = normalizeForCategory(name);
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(s)) return rule.name;
  }
  return "Diğer";
}

// -- M3U -------------------------------------------------------------------

function escapeAttr(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/"/g, "'");
}

function sanitizeName(name) {
  return String(name ?? "")
    .replace(/\r?\n/g, " ")
    .trim();
}

function toStreamUrl(item) {
  const id = item?.ids?.id;
  if (PROXY_BASE && id) return `${PROXY_BASE}/play/${id}`;
  return item.url;
}

function toM3U(items, vavooToEpgId, logoResolver) {
  const header = `#EXTM3U url-tvg="${escapeAttr(EPG_URL)}" x-tvg-url="${escapeAttr(EPG_URL)}"`;
  const lines = [header];
  for (const it of items) {
    if (!it || !it.url) continue;
    const vavooId = it.ids?.id ?? "";
    const name = sanitizeName(it.name);
    if (!name) continue;
    const logo = resolveLogo(name, it.logo, logoResolver);
    const group = categorize(name);
    // Route tvg-id to the upstream EPG channel id when we have a match,
    // so TiviMate can bind the guide. Fallback to the Vavoo id.
    const tvgId = (vavooToEpgId && vavooToEpgId.get(vavooId)) || vavooId;
    lines.push(
      `#EXTINF:-1 tvg-id="${escapeAttr(tvgId)}" tvg-name="${escapeAttr(name)}" tvg-logo="${escapeAttr(logo)}" group-title="${escapeAttr(group)}",${name}`
    );
    lines.push(toStreamUrl(it));
  }
  lines.push("");
  return lines.join("\n");
}

// iptv-org logo > Vavoo logo > "" (empty). Vavoo mostly returns "" anyway.
function resolveLogo(name, vavooLogo, logoResolver) {
  if (logoResolver) {
    const l = logoResolver(name);
    if (l) return l;
  }
  return vavooLogo || "";
}

// -- XMLTV EPG -------------------------------------------------------------

function xmlEscape(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&apos;"
  );
}

function xmltvTime(sec) {
  const d = new Date(sec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`
  );
}

// -- Upstream EPG (epgshare01 etc.) ----------------------------------------

async function fetchUpstreamXmltv(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`upstream EPG HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const isGz =
    url.toLowerCase().endsWith(".gz") || (buf[0] === 0x1f && buf[1] === 0x8b);
  const bytes = isGz ? zlib.gunzipSync(buf) : buf;
  return bytes.toString("utf8");
}

// Load and merge all XMLTV files inside a directory (iptv-org grab output).
async function loadGrabDir(dir) {
  const combined = { channels: new Map(), progByChannel: new Map() };
  if (!dir) return combined;
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return combined;
  }
  for (const f of entries) {
    if (!f.toLowerCase().endsWith(".xml")) continue;
    let xml;
    try {
      xml = await fs.readFile(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const parsed = parseXmltv(xml);
    for (const [id, data] of parsed.channels) {
      if (!combined.channels.has(id)) combined.channels.set(id, data);
    }
    for (const p of parsed.programmes) {
      if (!combined.progByChannel.has(p.channel))
        combined.progByChannel.set(p.channel, []);
      combined.progByChannel.get(p.channel).push(p);
    }
  }
  return combined;
}

// Parse XMLTV via regex (no dependency). Sufficient for well-formed feeds.
function parseXmltv(xml) {
  const channels = new Map(); // id -> { names[], icon }
  const programmes = []; // { start, stop, channel, titleXml, descXml, categoryXml }

  const chRe = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/gi;
  for (const m of xml.matchAll(chRe)) {
    const id = m[1];
    const body = m[2];
    const names = [
      ...body.matchAll(/<display-name[^>]*>([^<]+)<\/display-name>/gi),
    ]
      .map((n) => n[1].trim())
      .filter(Boolean);
    const icon = body.match(/<icon\s+src="([^"]+)"/i)?.[1] || "";
    channels.set(id, { names, icon });
  }

  const prRe = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/gi;
  for (const m of xml.matchAll(prRe)) {
    const attrs = m[1];
    const body = m[2];
    const start = attrs.match(/start="([^"]+)"/i)?.[1];
    const stop = attrs.match(/stop="([^"]+)"/i)?.[1];
    const channel = attrs.match(/channel="([^"]+)"/i)?.[1];
    if (!start || !stop || !channel) continue;
    programmes.push({ start, stop, channel, body: body.trim() });
  }

  return { channels, programmes };
}

// Loose ASCII normalization used ONLY for cross-source name matching.
function normalizeForMatch(name) {
  let s = String(name || "")
    .toUpperCase()
    .replace(/^\s*4K TR:\s*/i, "")
    .replace(/\s*\.(?:B|C|S)\b/gi, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^\)]*\)/g, " ")
    // Restore Vavoo's stripped Turkish characters BEFORE ASCII fold.
    .replace(/\bT RK\b/g, "TURK")
    .replace(/\bAK T\b/g, "AKIT")
    .replace(/\bS NEMA\b/g, "SINEMA")
    .replace(/\bM N KA\b/g, "MINIKA")
    .replace(/\bOCUK\b/g, "COCUK")
    .replace(/\bM Z K\b/g, "MUZIK")
    .replace(/\bBENG\b/g, "BENGU");
  s = s
    .replace(/[İI]/g, "I")
    .replace(/Ü/g, "U")
    .replace(/Ö/g, "O")
    .replace(/Ç/g, "C")
    .replace(/Ş/g, "S")
    .replace(/Ğ/g, "G")
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

function normalizeStripQuality(s) {
  return s
    .replace(/\b(?:UHD|FHD|HD\+|HD|SD|HEVC|RAW|H265|4K|8K|FEED|LIVE|BACKUP)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMatchIndex(upstreamChannels) {
  const idx = new Map();
  for (const [id, data] of upstreamChannels) {
    for (const raw of data.names) {
      const k1 = normalizeForMatch(raw);
      const k2 = normalizeStripQuality(k1);
      if (k1 && !idx.has(k1)) idx.set(k1, id);
      if (k2 && !idx.has(k2)) idx.set(k2, id);
    }
  }
  return idx;
}

function matchUpstreamId(vavooName, idx) {
  const k1 = normalizeForMatch(vavooName);
  if (idx.has(k1)) return idx.get(k1);
  const k2 = normalizeStripQuality(k1);
  if (idx.has(k2)) return idx.get(k2);
  return null;
}

function toXMLTV(
  items,
  vavooToEpgId,
  idSource,
  grabChannels,
  grabProgByChannel,
  upstreamChannels,
  upstreamProgByChannel,
  logoResolver
) {
  const seenChannel = new Set();
  const channels = [];
  const programmes = [];

  for (const it of items) {
    const vavooId = it?.ids?.id;
    if (!vavooId) continue;
    const name = sanitizeName(it.name);
    if (!name) continue;

    const routedId = vavooToEpgId.get(vavooId) || vavooId;
    if (seenChannel.has(routedId)) continue;
    seenChannel.add(routedId);

    const src = idSource.get(routedId) || "inline";
    let sourceCh = null;
    let sourceProgs = [];
    if (src === "grab") {
      sourceCh = grabChannels.get(routedId) || null;
      sourceProgs = grabProgByChannel.get(routedId) || [];
    } else if (src === "epgshare01") {
      sourceCh = upstreamChannels.get(routedId) || null;
      sourceProgs = upstreamProgByChannel.get(routedId) || [];
    }

    const displayName = sourceCh?.names?.[0] || name;
    // Logo priority: iptv-org > EPG source icon > Vavoo logo > empty
    const iptvorgLogo = logoResolver ? logoResolver(name) : "";
    const icon = iptvorgLogo || sourceCh?.icon || it.logo || "";
    const iconTag = icon ? `\n    <icon src="${xmlEscape(icon)}"/>` : "";
    channels.push(
      `  <channel id="${xmlEscape(routedId)}">\n` +
      `    <display-name>${xmlEscape(displayName)}</display-name>${iconTag}\n` +
      `  </channel>`
    );

    if (sourceProgs.length > 0) {
      for (const p of sourceProgs) {
        programmes.push(
          `  <programme start="${xmlEscape(p.start)}" stop="${xmlEscape(p.stop)}" channel="${xmlEscape(routedId)}">\n    ${p.body}\n  </programme>`
        );
      }
    } else if (Array.isArray(it.epg)) {
      for (const p of it.epg) {
        if (!p || typeof p.start !== "number" || typeof p.stop !== "number")
          continue;
        const title = String(p.name ?? "").trim();
        if (!title) continue;
        programmes.push(
          `  <programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.stop)}" channel="${xmlEscape(routedId)}">\n    <title>${xmlEscape(title)}</title>\n  </programme>`
        );
      }
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<tv generator-info-name="vavoo-iptv" generator-info-url="https://github.com/kadirmetin/vavoo-iptv">\n` +
    `${channels.join("\n")}\n` +
    `${programmes.join("\n")}\n` +
    `</tv>\n`
  );
}

// -- iptv-org logo index ---------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function buildLogoIndex() {
  const [channels, logos] = await Promise.all([
    fetchJson(IPTVORG_CHANNELS_URL),
    fetchJson(IPTVORG_LOGOS_URL),
  ]);
  const trChannels = channels.filter((c) => c && c.country === "TR");
  const trIds = new Set(trChannels.map((c) => c.id));

  // Prefer in_use=true logos; fall back to first available.
  const chosen = new Map();
  for (const l of logos) {
    if (!l || !trIds.has(l.channel) || !l.url) continue;
    const current = chosen.get(l.channel);
    if (!current || (l.in_use && !current.in_use)) {
      chosen.set(l.channel, l);
    }
  }

  const idx = new Map();
  for (const c of trChannels) {
    const l = chosen.get(c.id);
    if (!l) continue;
    const names = [c.name, ...(Array.isArray(c.alt_names) ? c.alt_names : [])];
    for (const n of names) {
      if (!n) continue;
      const k1 = normalizeForMatch(n);
      const k2 = normalizeStripQuality(k1);
      if (k1 && !idx.has(k1)) idx.set(k1, l.url);
      if (k2 && !idx.has(k2)) idx.set(k2, l.url);
    }
  }
  return idx;
}

function makeLogoResolver(idx) {
  if (!idx || idx.size === 0) return null;
  return (vavooName) => {
    const k1 = normalizeForMatch(vavooName);
    if (idx.has(k1)) return idx.get(k1);
    const k2 = normalizeStripQuality(k1);
    if (idx.has(k2)) return idx.get(k2);
    return "";
  };
}

async function main() {
  console.log(`Fetching group="${GROUP}" from ${CATALOG_URL} ...`);
  if (PROXY_BASE) {
    console.log(`Using PROXY_BASE=${PROXY_BASE}`);
  } else {
    console.warn(
      "WARNING: PROXY_BASE is empty. Geil page URLs will be written; use the Worker for playback."
    );
  }
  console.log(`EPG URL (published): ${EPG_URL}`);
  console.log(`EPG UPSTREAM (source): ${EPG_UPSTREAM_URL}`);

  const items = await fetchChannels();
  console.log(`Total items: ${items.length}`);

  // Deterministic order for clean git diffs
  items.sort((a, b) => {
    const an = String(a.name ?? "").toLocaleLowerCase("tr-TR");
    const bn = String(b.name ?? "").toLocaleLowerCase("tr-TR");
    if (an < bn) return -1;
    if (an > bn) return 1;
    const ai = a.ids?.id ?? "";
    const bi = b.ids?.id ?? "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  let upstreamChannels = new Map();
  let upstreamProgByChannel = new Map();
  try {
    const xml = await fetchUpstreamXmltv(EPG_UPSTREAM_URL);
    const parsed = parseXmltv(xml);
    upstreamChannels = parsed.channels;
    for (const p of parsed.programmes) {
      if (!upstreamProgByChannel.has(p.channel))
        upstreamProgByChannel.set(p.channel, []);
      upstreamProgByChannel.get(p.channel).push(p);
    }
    console.log(
      `Upstream EPG (epgshare01): ${upstreamChannels.size} channels, ${parsed.programmes.length} programmes`
    );
  } catch (err) {
    console.warn(
      `Upstream EPG unavailable (${err.message}); falling back to Geil inline EPG.`
    );
  }

  const grab = await loadGrabDir(IPTVORG_GRAB_DIR);
  if (grab.channels.size > 0) {
    const grabProgCount = [...grab.progByChannel.values()].reduce(
      (s, a) => s + a.length,
      0
    );
    console.log(
      `iptv-org grab: ${grab.channels.size} channels, ${grabProgCount} programmes (dir: ${IPTVORG_GRAB_DIR})`
    );
  } else if (IPTVORG_GRAB_DIR) {
    console.warn(
      `iptv-org grab dir "${IPTVORG_GRAB_DIR}" empty or missing; only epgshare01 + Geil inline will be used.`
    );
  }

  let logoIdx = new Map();
  try {
    logoIdx = await buildLogoIndex();
    console.log(`Logo index: ${logoIdx.size} name keys → iptv-org TR logos`);
  } catch (err) {
    console.warn(`Logo index unavailable (${err.message}); logos will be empty.`);
  }
  const logoResolver = makeLogoResolver(logoIdx);

  const grabIdx = buildMatchIndex(grab.channels);
  const upstreamIdx = buildMatchIndex(upstreamChannels);
  const vavooToEpgId = new Map();
  const idSource = new Map();
  let grabMatched = 0;
  let upstreamMatched = 0;
  let logoMatched = 0;
  for (const it of items) {
    const vavooId = it?.ids?.id;
    if (!vavooId) continue;
    const name = sanitizeName(it.name);
    if (!name) continue;

    // Priority: iptv-org grab (real TR descriptions) > epgshare01 (title-only) > Geil inline
    const grabId = matchUpstreamId(name, grabIdx);
    if (grabId) {
      vavooToEpgId.set(vavooId, grabId);
      idSource.set(grabId, "grab");
      grabMatched++;
    } else {
      const upstreamId = matchUpstreamId(name, upstreamIdx);
      if (upstreamId) {
        vavooToEpgId.set(vavooId, upstreamId);
        idSource.set(upstreamId, "epgshare01");
        upstreamMatched++;
      } else {
        vavooToEpgId.set(vavooId, vavooId);
      }
    }
    if (logoResolver && logoResolver(name)) logoMatched++;
  }
  console.log(
    `Channel binding: grab=${grabMatched}, epgshare01=${upstreamMatched}, geil-only=${items.length - grabMatched - upstreamMatched} (total ${items.length})`
  );
  console.log(
    `Logo binding:    ${logoMatched}/${items.length} Geil channels matched an iptv-org logo`
  );

  const m3u = toM3U(items, vavooToEpgId, logoResolver);
  await fs.writeFile(M3U_FILE, m3u, "utf8");
  console.log(`Wrote ${M3U_FILE} (${m3u.length} bytes, ${items.length} channels)`);

  const epg = toXMLTV(
    items,
    vavooToEpgId,
    idSource,
    grab.channels,
    grab.progByChannel,
    upstreamChannels,
    upstreamProgByChannel,
    logoResolver
  );
  await fs.writeFile(EPG_FILE, epg, "utf8");
  const programmeCount = (epg.match(/<programme /g) || []).length;
  const channelCount = (epg.match(/<channel /g) || []).length;
  console.log(
    `Wrote ${EPG_FILE} (${epg.length} bytes, ${channelCount} channels, ${programmeCount} programmes)`
  );

  const dist = new Map();
  for (const it of items) {
    const name = sanitizeName(it?.name);
    if (!name) continue;
    const c = categorize(name);
    dist.set(c, (dist.get(c) || 0) + 1);
  }
  console.log("\nCategory distribution:");
  for (const [c, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(10)}: ${n}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
