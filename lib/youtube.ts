/** yt-dlp calls: listing, downloading and fetching metadata. */
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { capture, run } from "./audio.ts";

/** The fields of yt-dlp's video JSON that the script uses. */
export interface VideoInfo {
  id: string;
  title: string;
  channel?: string;
  uploader?: string;
  track?: string;
  artists?: string[];
  release_year?: number;
  upload_date?: string;
  description?: string;
  /** Seconds. */
  duration?: number;
  chapters?: Chapter[];
}

export interface Chapter {
  title: string;
  start_time: number;
  end_time: number;
}

export interface PlaylistEntry {
  id: string;
  /** Position in the playlist, starting at 1. */
  index: number;
}

export interface Listing {
  /** Missing for a single video. */
  playlistTitle?: string;
  entries: PlaylistEntry[];
  /** Full metadata, only for a single video. */
  video?: VideoInfo;
}

const INCOMPLETE_DOWNLOAD_EXTENSIONS = [".part", ".ytdl", ".temp", ".json"];
const METADATA_PROCESSES = 4;

export function videoUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function videoIdFromUrl(text: string | undefined): string | undefined {
  const url = text ? URL.parse(text.trim()) : null;
  if (!url) return undefined;
  if (url.hostname === "youtu.be") return url.pathname.slice(1) || undefined;
  const shorts = url.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/);
  return url.searchParams.get("v") ?? shorts?.[1] ?? undefined;
}

/**
 * Treats any URL with a list as a playlist, except YouTube's auto-generated
 * Mixes (RD...), which are added to links to single songs. RDCLAK... lists are
 * curated YouTube Music playlists.
 */
export function isPlaylistUrl(url: URL): boolean {
  const list = url.searchParams.get("list");
  if (!list) return false;
  return !list.startsWith("RD") || list.startsWith("RDCLAK");
}

/** Lists the videos behind a URL with one quick request, without downloading. */
export async function listVideos(url: string, isPlaylist: boolean): Promise<Listing> {
  const { stdout, code } = await capture("yt-dlp", [
    "--flat-playlist",
    "--dump-single-json",
    isPlaylist ? "--yes-playlist" : "--no-playlist",
    "--",
    url,
  ]);
  if (code !== 0 || !stdout.trim()) {
    throw new Error(`yt-dlp could not read ${url}`);
  }

  const data = JSON.parse(stdout);
  if (data._type !== "playlist") {
    return { entries: [{ id: data.id, index: 1 }], video: data };
  }
  const entries = (data.entries ?? [])
    .map((entry: { id?: string } | null, position: number) => ({ id: entry?.id, index: position + 1 }))
    .filter((entry: { id?: string }): entry is PlaylistEntry => Boolean(entry.id));
  return { playlistTitle: data.title ?? "Playlist", entries };
}

/** Downloads the best audio of each video, plus its metadata, as <id>.<ext> and <id>.info.json. */
export function downloadAudio(ids: string[], directory: string): Promise<void> {
  return run("yt-dlp", [
    "--format", "bestaudio/best",
    "--no-playlist",
    // Keeps going when a playlist has private or deleted videos.
    "--ignore-errors",
    "--write-info-json",
    "--no-write-playlist-metafiles",
    "--output", join(directory, "%(id)s.%(ext)s"),
    "--",
    ...ids.map(videoUrl),
  ]);
}

/** Finds the audio file and metadata yt-dlp saved for a video, if the download finished. */
export async function readDownload(
  directory: string,
  id: string,
): Promise<{ file: string; info: VideoInfo } | undefined> {
  const media = (await readdir(directory)).find(
    (name) => name.startsWith(`${id}.`) && !INCOMPLETE_DOWNLOAD_EXTENSIONS.includes(extname(name)),
  );
  if (!media) return undefined;
  try {
    const info: VideoInfo = JSON.parse(await readFile(join(directory, `${id}.info.json`), "utf8"));
    return { file: join(directory, media), info };
  } catch {
    return undefined;
  }
}

/** Fetches metadata for many videos without downloading them. Unavailable videos are left out. */
export async function fetchInfo(ids: string[]): Promise<Map<string, VideoInfo>> {
  const groups = Array.from({ length: METADATA_PROCESSES }, (_, group) =>
    ids.filter((_, index) => index % METADATA_PROCESSES === group),
  ).filter((group) => group.length > 0);

  const outputs = await Promise.all(
    groups.map((group) =>
      capture("yt-dlp", ["--skip-download", "--dump-json", "--no-playlist", "--ignore-errors", "--", ...group.map(videoUrl)]),
    ),
  );

  const infos = new Map<string, VideoInfo>();
  for (const { stdout } of outputs) {
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const info: VideoInfo = JSON.parse(line);
      infos.set(info.id, info);
    }
  }
  return infos;
}

/** "2024" from release_year or upload_date (YYYYMMDD). */
export function releaseYear(info: VideoInfo): string | undefined {
  return info.release_year?.toString() ?? info.upload_date?.slice(0, 4);
}
