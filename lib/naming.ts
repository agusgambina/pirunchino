/** Rule-based cleanup of YouTube titles into artist and song names. */

export const SINGLE_SONG_FOLDER = "various artists";

export interface SongSource {
  title: string;
  channel?: string;
  /** YouTube Music metadata, only present for some official uploads. */
  track?: string;
  artists?: string[];
}

export interface SongName {
  artist: string;
  title: string;
}

const UNKNOWN_ARTIST = "Unknown Artist";
const MAX_NAME_LENGTH = 150;

const EMOJI_RUN =
  /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}​-‍⁠︎️⃣]+/gu;
const EMOJI_MARKER = "\u0000";
const DASH_SEPARATOR = /\s+[-–—]\s*|\s*[-–—]\s+/;
const PIPE_SEPARATOR = /\s*[|｜]\s*/;
const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;
const BRACKETED = /[([【「]([^()[\]【】「」]*)[)\]】」]/gu;
const NOISE_PHRASE =
  /(?<!\p{L})(?:(?:official|oficial)\s+(?:music\s+|sing[-\s]?along\s+|lyrics?\s+)?(?:v[ií]deo|audio|visuali[sz]er)|(?:v[ií]deo|audio)\s+(?:oficial|official)|lyrics?\s+v[ií]deo|v[ií]deo\s*clip(?:\s+oficial)?)(?!\p{L})/giu;

/** Words that only describe the upload, never the song. */
const NOISE_WORDS = new Set([
  "official", "oficial", "video", "videoclip", "clip", "music", "musica", "musical",
  "lyric", "lyrics", "letra", "audio", "hd", "hq", "4k", "8k", "1080p", "720p",
  "visualizer", "visualiser", "sing", "along", "singalong", "karaoke", "mv",
  "remastered", "remaster", "remasterizado", "remasterizada",
]);

/** Words kept lowercase when converting ALL CAPS titles, unless they come first. */
const CONNECTORS = new Set([
  "de", "del", "la", "las", "el", "los", "lo", "y", "e", "o", "u", "a", "al", "en", "con",
  "por", "para", "sin", "un", "una", "unos", "unas", "the", "of", "and", "or", "an", "in",
  "on", "to", "for", "with", "ft", "feat",
]);

/** Lowercase, without accents or anything that isn't a letter or digit. */
function matchKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function isNoise(text: string): boolean {
  const words = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return words.length > 0 && words.every((word) => NOISE_WORDS.has(word));
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:\-–—]+|[\s.,;:\-–—]+$/g, "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .trim();
}

export function stripEmoji(text: string): string {
  return text.replace(EMOJI_RUN, " ").replace(/\s+/g, " ").trim();
}

/** Removes the " - Topic", "VEVO" and "Official" decorations from channel names. */
export function cleanChannel(channel: string | undefined): string | undefined {
  const cleaned = channel
    ?.replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s+(official|oficial)$/i, "")
    .trim();
  return cleaned || undefined;
}

function mentionsChannel(text: string, channel: string | undefined): boolean {
  if (!channel) return false;
  const part = matchKey(text);
  const name = matchKey(channel);
  if (part.length < 3 || name.length < 3) return false;
  return part.includes(name);
}

/**
 * Converts shouted words to title case when a part has at least two of them,
 * or is a single shouted word of 4+ letters. Lone acronyms in mixed text stay.
 */
export function fixCaps(text: string): string {
  const tokens = text.split(/(\s+)/);
  const core = (token: string) => token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  const isShouted = (token: string) => /^\p{Lu}[\p{Lu}\p{M}]+$/u.test(core(token));
  const words = tokens.filter((token) => /\p{L}/u.test(token));
  const shouted = words.filter(isShouted);
  // "CHAU (Canción para despedirse)": a long shouted word that starts the part.
  const startsShouted = words.length > 0 && isShouted(words[0]) && core(words[0]).length >= 4;
  if (shouted.length < 2 && !startsShouted) return text;

  let isFirstWord = true;
  return tokens
    .map((token) => {
      if (!/\p{L}/u.test(token)) return token;
      const first = isFirstWord;
      isFirstWord = false;
      const lower = token.toLowerCase();
      // "SUBE Y BAJA": single-letter connectors don't count as shouted.
      if (!first && /^\p{Lu}$/u.test(core(token)) && CONNECTORS.has(core(lower))) return lower;
      if (!isShouted(token)) return token;
      if (!first && CONNECTORS.has(core(lower))) return lower;
      return lower.replace(/\p{L}/u, (letter) => letter.toUpperCase());
    })
    .join("");
}

/**
 * How a title is laid out: "artist-first" (Artist - Song), "title-first"
 * (Song - Artist, or Song - Series | Channel), or "ambiguous" (A - B without
 * the channel in it, read as Artist - Song unless the playlist says otherwise).
 */
type Layout = "artist-first" | "title-first" | "ambiguous" | "other";

interface Analysis {
  name: SongName;
  layout: Layout;
  /** For ambiguous titles: the reading as "Song - Series" by the channel. */
  songFirstName?: SongName;
}

function finish(artist: string | undefined, title: string, source: SongSource): SongName {
  return {
    artist: tidy(artist ?? "") || UNKNOWN_ARTIST,
    title: fixCaps(tidy(title)) || tidy(stripEmoji(source.title)),
  };
}

export function cleanSong(source: SongSource): SongName {
  return analyzeSong(source).name;
}

/**
 * Cleans the songs of one playlist together. Ambiguous "A - B" titles follow
 * the playlist's usual layout, so a playlist of "Song - Series | Channel"
 * titles doesn't turn songs into artists.
 */
export function cleanSongs(sources: SongSource[]): SongName[] {
  const analyses = sources.map(analyzeSong);
  const count = (layout: Layout) => analyses.filter((analysis) => analysis.layout === layout).length;
  const songFirst = count("title-first") > count("artist-first");
  return analyses.map((analysis) => (songFirst && analysis.songFirstName) || analysis.name);
}

function analyzeSong(source: SongSource): Analysis {
  const channel = cleanChannel(source.channel);

  if (source.track && source.artists?.length) {
    const name = { artist: tidy(source.artists.join(" & ")), title: tidy(stripEmoji(source.track)) };
    return { name, layout: "other" };
  }

  let text = source.title.normalize("NFC").replace(EMOJI_RUN, ` ${EMOJI_MARKER} `);
  text = text.replace(HASHTAG, "$1");
  text = text.replace(BRACKETED, (match, inner: string) => (isNoise(inner) ? " " : match));
  text = text.replace(NOISE_PHRASE, " ");

  // "TOPA 🤡 EL PAYASITO": emoji after the artist acts as the separator.
  const withoutMarkers = text.replaceAll(EMOJI_MARKER, " ");
  if (!DASH_SEPARATOR.test(withoutMarkers) && !PIPE_SEPARATOR.test(withoutMarkers)) {
    const marker = text.indexOf(EMOJI_MARKER);
    const before = text.slice(0, marker);
    const after = text.slice(marker + 1).replaceAll(EMOJI_MARKER, " ");
    if (marker > 0 && mentionsChannel(before, channel) && tidy(after)) {
      text = `${before} - ${after}`;
    }
  }
  text = text.replaceAll(EMOJI_MARKER, " ");

  // "Song - Series | Channel": a later pipe part names the uploader.
  const [body, ...pipeParts] = text.split(PIPE_SEPARATOR);
  const channelAfterPipe = pipeParts.some((part) => mentionsChannel(part, channel));

  let parts = body.split(DASH_SEPARATOR).map(tidy).filter((part) => part && !isNoise(part));
  if (parts.length === 0) parts = [tidy(stripEmoji(source.title))];

  const artistIndex = parts.findIndex((part) => mentionsChannel(part, channel));

  if (parts.length === 1) {
    return { name: finish(channel, parts[0], source), layout: channelAfterPipe ? "title-first" : "other" };
  }
  if (artistIndex >= 0) {
    const part = parts[artistIndex];
    // Use the channel's spelling when the part is just the channel name.
    const artist = matchKey(part) === matchKey(channel ?? "") ? channel : part;
    const title = parts.filter((_, index) => index !== artistIndex).join(" - ");
    return { name: finish(artist, title, source), layout: artistIndex === 0 ? "artist-first" : "title-first" };
  }
  if (channelAfterPipe) {
    return { name: finish(channel, parts[0], source), layout: "title-first" };
  }
  if (parts.length === 2) {
    return {
      name: finish(parts[0], parts[1], source),
      layout: "ambiguous",
      songFirstName: channel ? finish(channel, parts[0], source) : undefined,
    };
  }
  return { name: finish(channel, parts.join(" - "), source), layout: "other" };
}

/** Replaces characters that aren't allowed in filenames on macOS, Windows or USB drives. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function safeName(text: string): string {
  const replaced = text
    .replace(/\//g, "⧸")
    .replace(/\\/g, "⧹")
    .replace(/:/g, "：")
    .replace(/\?/g, "？")
    .replace(/\*/g, "＊")
    .replace(/"/g, "＂")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/\|/g, "｜")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const shortened = Array.from(replaced).slice(0, MAX_NAME_LENGTH).join("");
  const name = shortened.replace(/[.\s]+$/, "") || "Untitled";
  // Windows can't create files or folders named CON, NUL, COM1 and so on.
  return WINDOWS_RESERVED.test(name) ? `${name}_` : name;
}

/** "01 - Artist - Song.mp3" for playlists, "Artist - Song.mp3" otherwise. */
export function trackFileName(name: SongName, index?: number, total?: number): string {
  const base = safeName(`${name.artist} - ${name.title}`);
  if (index === undefined) return `${base}.mp3`;
  const width = Math.max(2, String(total ?? index).length);
  return `${String(index).padStart(width, "0")} - ${base}.mp3`;
}

export function folderName(playlistTitle: string): string {
  return safeName(stripEmoji(playlistTitle).replace(/\s*[|｜]\s*/g, " - "));
}

/** "Various Artists" when a playlist mixes artists, otherwise its only artist. */
export function albumArtist(names: SongName[]): string | undefined {
  const artists = new Set(names.map((name) => name.artist));
  if (artists.size === 0) return undefined;
  return artists.size === 1 ? [...artists][0] : "Various Artists";
}

/** True for a long video whose chapters are separate songs, like "120 min of lullabies". */
export function isCompilation(chapterCount: number, durationSeconds: number | undefined): boolean {
  return chapterCount >= 3 && (durationSeconds ?? 0) >= 10 * 60;
}

/**
 * Names the chapters of a compilation video. Chapter titles are already song
 * names, so there's no "Artist - Song" guessing: the channel is the artist.
 * Bracketed text repeated in at least half the chapters, like "(Para Bebés)",
 * describes the whole compilation and is removed.
 */
export function cleanChapters(titles: string[], channel: string | undefined): SongName[] {
  const artist = cleanChannel(channel) ?? UNKNOWN_ARTIST;
  const bracketedIn = (title: string) =>
    new Set([...title.matchAll(BRACKETED)].map((match) => matchKey(match[1])).filter(Boolean));

  const counts = new Map<string, number>();
  for (const title of titles) {
    for (const key of bracketedIn(title)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(titles.length / 2));
  const shared = new Set([...counts].filter(([, count]) => count >= threshold).map(([key]) => key));

  return titles.map((original) => {
    let text = original.normalize("NFC").replace(EMOJI_RUN, " ").replace(HASHTAG, "$1");
    text = text.replace(BRACKETED, (match, inner: string) => (shared.has(matchKey(inner)) || isNoise(inner) ? " " : match));
    text = text.replace(NOISE_PHRASE, " ");
    return { artist, title: fixCaps(tidy(text)) || tidy(stripEmoji(original)) };
  });
}
