/** Child processes, plus ffmpeg and ffprobe helpers. */
import { spawn } from "node:child_process";

const INSTALL_HINTS: Record<string, string> =
  process.platform === "win32"
    ? { "yt-dlp": "winget install yt-dlp.yt-dlp", ffmpeg: "winget install Gyan.FFmpeg", ffprobe: "winget install Gyan.FFmpeg" }
    : process.platform === "darwin"
      ? { "yt-dlp": "brew install yt-dlp", ffmpeg: "brew install ffmpeg", ffprobe: "brew install ffmpeg" }
      : { "yt-dlp": "pipx install yt-dlp", ffmpeg: "sudo apt install ffmpeg", ffprobe: "sudo apt install ffmpeg" };

function notFound(command: string, error: NodeJS.ErrnoException): Error {
  return error.code === "ENOENT"
    ? new Error(`${command} not found. Install it with: ${INSTALL_HINTS[command]}`)
    : error;
}

/** Runs a command with its output attached to the terminal. */
export function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => reject(notFound(command, error)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

/** Runs a command and returns its standard output. Errors still go to the terminal. */
export function capture(command: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => reject(notFound(command, error)));
    child.on("close", (code) => {
      resolve({ stdout: Buffer.concat(chunks).toString("utf8"), code: code ?? 1 });
    });
  });
}

export interface Mp3Tags {
  title: string;
  artist: string;
  album?: string;
  albumArtist?: string;
  /** "3/12" */
  track?: string;
  date?: string;
  /** The YouTube URL, used to recognize songs that were already downloaded. */
  comment?: string;
}

function metadataArgs(tags: Mp3Tags): string[] {
  const fields: Record<string, string | undefined> = {
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    album_artist: tags.albumArtist,
    track: tags.track,
    date: tags.date,
    comment: tags.comment,
  };
  return Object.entries(fields)
    .filter(([, value]) => value)
    .flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
}

const COMMON_ARGS = ["-hide_banner", "-loglevel", "error", "-y"];

/** Converts the input, or only the part between `slice.start` and `slice.end` (seconds). */
export function convertToMp3(
  input: string,
  output: string,
  bitrate: number,
  tags: Mp3Tags,
  slice?: { start: number; end: number },
): Promise<void> {
  // Seeking before -i is fast, and accurate because the audio is re-encoded.
  const range = slice ? ["-ss", String(slice.start), "-to", String(slice.end)] : [];
  return run("ffmpeg", [
    ...COMMON_ARGS,
    ...range,
    "-i", input,
    "-map", "0:a:0",
    "-map_metadata", "-1",
    "-id3v2_version", "3",
    ...metadataArgs(tags),
    "-codec:a", "libmp3lame",
    "-b:a", `${bitrate}k`,
    output,
  ]);
}

/** Replaces all tags without re-encoding the audio. */
export function retagMp3(input: string, output: string, tags: Mp3Tags): Promise<void> {
  return run("ffmpeg", [
    ...COMMON_ARGS,
    "-i", input,
    "-map", "0:a",
    "-codec", "copy",
    "-map_metadata", "-1",
    "-id3v2_version", "3",
    ...metadataArgs(tags),
    "-f", "mp3",
    output,
  ]);
}

/** Returns the file's tags with lowercase keys. */
export async function readTags(file: string): Promise<Record<string, string>> {
  const { stdout } = await capture("ffprobe", [
    "-v", "error",
    "-show_entries", "format_tags",
    "-of", "json",
    file,
  ]);
  try {
    const tags: Record<string, string> = JSON.parse(stdout).format?.tags ?? {};
    return Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]));
  } catch {
    return {};
  }
}
