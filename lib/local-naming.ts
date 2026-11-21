/** Improves the rule-based names with a small local model through Ollama. */
import { type SongName, stripEmoji } from "./naming.ts";

export interface AiSong {
  id: string;
  youtubeTitle: string;
  channel?: string;
  description?: string;
  ruleBasedGuess: SongName;
}

export interface LocalNamingOptions {
  model?: string;
  /** Defaults to OLLAMA_HOST, then http://localhost:11434. */
  host?: string;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
}

export const DEFAULT_MODEL = "qwen3:4b";
const BATCH_SIZE = 8;
const DESCRIPTION_LENGTH = 300;
const REQUEST_TIMEOUT_MS = 120_000;

// The rule-based guess isn't sent: small models copy it back instead of
// improving it. The code still falls back to it for any song the model gets wrong.
const SYSTEM_PROMPT = `You turn YouTube video titles into the artist and song title shown in a music player.

Rules:
- title is only the song's name. Keep parts that tell similar songs apart, like "Parte 2", "1 2 3" or "(Medios de transporte)". Remove emoji, "Official Video", "Lyrics", hashtags, channel names, series or album names (like "Canciones Infantiles", "La Granja de Zenón 3"), and descriptions of the video (like "Aprendemos preposiciones", "Juego de manos").
- artist is the performer. If the title doesn't name one, use the channel.
- When the title names several performers ("A y B", "A & B", "A ft. B"), the artist is all of them joined with " & ". Keep "ft." guests in the artist, not the title.
- Spell each artist the same way for every song. Reuse the spellings in artists_already_used.
- Start the title with a capital letter. Don't write in ALL CAPS. In Spanish, capitalize only the first word and names. Keep accents.
- Use only words from the YouTube title, channel or description. Don't translate.

Examples:
{"youtube_title": "FAMILIA DEDO FELIZ - Luli Pampín🖐👩 - Official Video", "channel": "Luli Pampín"} -> {"artist": "Luli Pampín", "title": "Familia dedo feliz"}
{"youtube_title": "La Vaca Lola - Canciones de La Granja de Zenón 2", "channel": "El Reino Infantil"} -> {"artist": "El Reino Infantil", "title": "La vaca Lola"}
{"youtube_title": "TOPA 🤡 EL PAYASITO (Official Video)", "channel": "TOPA"} -> {"artist": "Topa", "title": "El payasito"}
{"youtube_title": "TOPA y Luli pampín - Veo Veo", "channel": "TOPA"} -> {"artist": "Topa & Luli Pampín", "title": "Veo veo"}
{"youtube_title": "Luli Pampín - LAS FORMAS feat. Alman Kids Crew 🟦❤️", "channel": "Luli Pampín"} -> {"artist": "Luli Pampín & Alman Kids Crew", "title": "Las formas"}
{"youtube_title": "Luli Pampín y Los pollitos escondidos 🐥 Aprendemos preposiciones", "channel": "Luli Pampín"} -> {"artist": "Luli Pampín", "title": "Los pollitos escondidos"}`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    songs: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, artist: { type: "string" }, title: { type: "string" } },
        required: ["id", "artist", "title"],
      },
    },
  },
  required: ["songs"],
};

let disabledReason: string | undefined;

/** Lets tests start from a clean state. */
export function resetLocalNaming(): void {
  disabledReason = undefined;
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function words(text: string): string[] {
  return normalize(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function sourceText(song: AiSong): string {
  return [song.youtubeTitle, song.channel, song.description].filter(Boolean).join(" ");
}

/**
 * True when the name only reuses words from the song's YouTube text, so a
 * small model can reformat names but not invent them:
 * - title words (2+ characters) must come from the YouTube title, since
 *   descriptions often list other songs
 * - artist words must come from the title or channel, since descriptions
 *   often credit songwriters ("A. Mantovani - D. Topa")
 * Also rejects mistakes small models make: a title that repeats the artist,
 * an artist that contains the title, an artist listed twice ("TOPA & DIEGO TOPA"),
 * and an artist that leaves out a performer the rules found.
 */
export function isGrounded(name: SongName, song: AiSong): boolean {
  const title = words(name.title).join(" ");
  const artist = words(name.artist).join(" ");
  if (!title || title === artist || ` ${artist} `.includes(` ${title} `)) return false;

  const performers = name.artist.split(/\s*&\s*/).map((part) => ` ${words(part).join(" ")} `);
  const repeats = performers.some((part, index) =>
    performers.some((other, otherIndex) => otherIndex !== index && other.includes(part)),
  );
  // "Luli Pampín & Abc - Abc - La canción del Alfabeto": a performer taken from the title.
  const performerInTitle = performers.some((part) => part.trim() && ` ${title} `.includes(part));
  if (repeats || performerInTitle) return false;

  // Every performer the rules found must still be named: small models swap in a
  // series name ("Bichikids" for "El Reino Infantil") or drop the second singer.
  const artistWordSet = new Set(words(name.artist).filter((word) => word.length >= 3));
  const keepsPerformers = song.ruleBasedGuess.artist
    .split(/\s*(?:&|,|\by\b|\band\b)\s*/iu)
    .map((part) => words(part).filter((word) => word.length >= 3))
    .filter((partWords) => partWords.length > 0)
    .every((partWords) => partWords.some((word) => artistWordSet.has(word)));
  if (!keepsPerformers) return false;

  const titleWords = new Set(words(song.youtubeTitle));
  const artistWords = new Set(words(`${song.youtubeTitle} ${song.channel ?? ""}`));
  const fromTitle = words(name.title).filter((word) => word.length >= 2).every((word) => titleWords.has(word));
  const fromArtistSources = words(name.artist).filter((word) => word.length >= 2).every((word) => artistWords.has(word));
  return fromTitle && fromArtistSources;
}

/**
 * The model picks which words make up the name; their spelling comes from the
 * rule-based name when the word appears there (small models lowercase names
 * like "Lola"), otherwise from the YouTube text, which restores dropped accents.
 */
export function polish(name: SongName, song: AiSong): SongName {
  const hasAccent = (word: string) => word.normalize("NFD") !== word;
  const splitWords = (text: string) => text.normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  const guessSpellings = new Map<string, string>();
  for (const word of splitWords(`${song.ruleBasedGuess.artist} ${song.ruleBasedGuess.title}`)) {
    if (!guessSpellings.has(normalize(word))) guessSpellings.set(normalize(word), word);
  }
  const accentSpellings = new Map<string, string>();
  for (const word of splitWords(sourceText(song))) {
    if (hasAccent(word)) accentSpellings.set(normalize(word), word);
  }

  const respell = (text: string) =>
    text.normalize("NFC").replace(/[\p{L}\p{N}]+/gu, (word) => {
      const guess = guessSpellings.get(normalize(word));
      if (guess) return guess;
      const accented = accentSpellings.get(normalize(word));
      if (!accented || hasAccent(word)) return word;
      const lower = accented.toLowerCase();
      if (word.length > 1 && word === word.toUpperCase()) return lower.toUpperCase();
      return /^\p{Lu}/u.test(word) ? lower.replace(/\p{L}/u, (letter) => letter.toUpperCase()) : lower;
    });

  return {
    artist: respell(name.artist),
    title: respell(name.title).replace(/\p{L}/u, (letter) => letter.toUpperCase()),
  };
}

function shortDescription(description: string | undefined): string | undefined {
  const text = description
    ?.replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? Array.from(text).slice(0, DESCRIPTION_LENGTH).join("") : undefined;
}

/** OLLAMA_HOST may omit the scheme ("0.0.0.0:11434"), which Ollama itself accepts. */
export function ollamaUrl(host: string | undefined): string {
  const value = host?.trim() || "http://localhost:11434";
  return (/^https?:\/\//i.test(value) ? value : `http://${value}`).replace(/\/+$/, "");
}

class OllamaError extends Error {}

async function nameBatch(
  songs: AiSong[],
  playlist: string | undefined,
  artistsAlreadyUsed: string[],
  model: string,
  host: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const request = {
    playlist: playlist ?? null,
    artists_already_used: artistsAlreadyUsed,
    songs: songs.map((song) => ({
      id: song.id,
      youtube_title: song.youtubeTitle,
      channel: song.channel ?? null,
      description_start: shortDescription(song.description) ?? null,
    })),
  };

  let response: Response;
  try {
    response = await fetchImpl(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        stream: false,
        // Thinking models (qwen3) answer much faster without it; others ignore it.
        think: false,
        format: RESPONSE_SCHEMA,
        keep_alive: "5m",
        // A fixed 4K context keeps memory use under 4 GB for 3B models.
        options: { temperature: 0, num_ctx: 4096 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(request) },
        ],
      }),
    });
  } catch (error) {
    if ((error as Error).name === "TimeoutError") throw new OllamaError("the local model took too long");
    throw new OllamaError(`Ollama isn't running at ${host}. Install it from https://ollama.com/download, then run \`ollama pull ${model}\``);
  }

  if (response.status === 404) {
    throw new OllamaError(`the model ${model} isn't downloaded. Run \`ollama pull ${model}\``);
  }
  if (!response.ok) {
    throw new OllamaError(`Ollama error ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data = (await response.json()) as { message?: { content?: string } };
  try {
    return JSON.parse(data.message?.content ?? "");
  } catch {
    return undefined; // Unreadable answer: this batch keeps its rule-based names.
  }
}

/**
 * Returns the local model's names by video id. Songs it gets wrong, or that
 * fail the grounding check, are left out so callers keep the rule-based names.
 * When Ollama can't be used, prints one notice and returns what it has.
 */
export async function improveNames(
  songs: AiSong[],
  playlist?: string,
  options: LocalNamingOptions = {},
): Promise<Map<string, SongName>> {
  const names = new Map<string, SongName>();
  if (disabledReason || songs.length === 0) return names;

  const model = options.model ?? DEFAULT_MODEL;
  const host = ollamaUrl(options.host ?? process.env.OLLAMA_HOST);
  const fetchImpl = options.fetch ?? fetch;

  try {
    for (let start = 0; start < songs.length; start += BATCH_SIZE) {
      const batch = songs.slice(start, start + BATCH_SIZE);
      const end = start + batch.length;
      console.log(`Naming songs ${start + 1}–${end} of ${songs.length} with ${model}...`);

      const artistsAlreadyUsed = [...new Set([...names.values()].map((name) => name.artist))];
      const result = await nameBatch(batch, playlist, artistsAlreadyUsed, model, host, fetchImpl);
      const answers = (result as { songs?: unknown } | undefined)?.songs;
      if (!Array.isArray(answers)) continue;

      for (const answer of answers as Partial<Record<"id" | "artist" | "title", unknown>>[]) {
        const song = batch.find((candidate) => candidate.id === answer?.id);
        const artist = typeof answer?.artist === "string" ? stripEmoji(answer.artist) : "";
        const title = typeof answer?.title === "string" ? stripEmoji(answer.title) : "";
        if (!song || !artist || !title || names.has(song.id)) continue;
        if (isGrounded({ artist, title }, song)) names.set(song.id, polish({ artist, title }, song));
      }
    }
  } catch (error) {
    if (!(error instanceof OllamaError)) throw error;
    disabledReason = error.message;
    console.warn(`Local naming skipped (${disabledReason}). Using rule-based names. Pass --no-ai to hide this message.`);
  }
  return names;
}
