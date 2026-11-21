#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_MODEL, improveNames } from "./lib/local-naming.ts";
import { convertToMp3, type Mp3Tags, readTags, retagMp3 } from "./lib/audio.ts";
import {
  albumArtist,
  cleanChapters,
  cleanSongs,
  folderName,
  isCompilation,
  SINGLE_SONG_FOLDER,
  type SongName,
  type SongSource,
  trackFileName,
} from "./lib/naming.ts";
import {
  downloadAudio,
  fetchInfo,
  isPlaylistUrl,
  listVideos,
  readDownload,
  releaseYear,
  type VideoInfo,
  videoIdFromUrl,
  videoUrl,
} from "./lib/youtube.ts";

const VALID_BITRATES = [128, 160, 192, 256, 320];

const USAGE = `Usage:
  pirunchino <youtube-url> [options]     Download a song or playlist as MP3
  pirunchino --retag <dir> [options]     Rename and retag MP3s that are already downloaded

Options:
  -o, --output <dir>      Base directory for the MP3 subfolders (default: downloads)
  -b, --bitrate <kbps>    ${VALID_BITRATES.join(", ")} (default: 320)
  -f, --force             Download songs again even if they're already saved
      --no-split          Keep long videos with chapters as one MP3 instead of one per song
      --retag <dir>       Fix the names and tags of every MP3 under <dir>
      --dry-run           With --retag, show the new names without changing anything
      --model <name>      Ollama model for cleaning up names (default: $PIRUNCHINO_MODEL or ${DEFAULT_MODEL})
      --no-ai             Use only the built-in rules (skip the local model)
  -h, --help              Show this help`;

interface Song {
  id?: string;
  source: SongSource;
  description?: string;
  name: SongName;
}

interface Options {
  bitrate: number;
  force: boolean;
  dryRun: boolean;
  /** The Ollama model, or undefined to use the rules only. */
  model?: string;
  split: boolean;
}

function toSource(info: VideoInfo): SongSource {
  return { title: info.title, channel: info.channel ?? info.uploader, track: info.track, artists: info.artists };
}

/** Applies the rules to every song, then lets the local model improve the names. */
async function nameSongs(songs: Omit<Song, "name">[], playlist: string | undefined, model: string | undefined): Promise<Song[]> {
  const ruleNames = cleanSongs(songs.map((song) => song.source));
  const named = songs.map((song, index) => ({ ...song, name: ruleNames[index] }));
  if (!model) return named;

  const withIds = named.filter((song): song is Song & { id: string } => Boolean(song.id));
  const better = await improveNames(
    withIds.map((song) => ({
      id: song.id,
      youtubeTitle: song.source.title,
      channel: song.source.channel,
      description: song.description,
      ruleBasedGuess: song.name,
    })),
    playlist,
    { model },
  );
  return named.map((song) => ({ ...song, name: (song.id && better.get(song.id)) || song.name }));
}

function trackTag(index: number | undefined, total: number | undefined): string | undefined {
  if (index === undefined) return undefined;
  return total ? `${index}/${total}` : String(index);
}

/**
 * Returns a path in `directory` for `fileName` that no other song uses, adding
 * " (2)" if needed. `ownPaths` are files this song may overwrite.
 */
function claimPath(directory: string, fileName: string, taken: Set<string>, ownPaths: string[] = []): string {
  const stem = fileName.replace(/\.mp3$/, "");
  const own = new Set(ownPaths.map((path) => path.toLowerCase()));
  for (let attempt = 1; ; attempt++) {
    const path = join(directory, attempt === 1 ? fileName : `${stem} (${attempt}).mp3`);
    const key = path.toLowerCase();
    const usedOnDisk = existsSync(path) && !own.has(key);
    if (!taken.has(key) && !usedOnDisk) {
      taken.add(key);
      return path;
    }
  }
}

async function listMp3s(directory: string, recursive: boolean): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { recursive, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mp3") && !entry.name.startsWith("."))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !relative(directory, file).split("/").some((part) => part.startsWith(".") || part === "node_modules"))
    .sort();
}

/** Maps the YouTube id stored in each MP3's tags to its files (several for a split video). */
async function savedSongs(directory: string): Promise<Map<string, string[]>> {
  const saved = new Map<string, string[]>();
  for (const file of await listMp3s(directory, false)) {
    const tags = await readTags(file);
    const id = videoIdFromUrl(tags.comment) ?? videoIdFromUrl(tags.purl);
    if (id) saved.set(id, [...(saved.get(id) ?? []), file]);
  }
  return saved;
}

/** Seconds from a "&t=214s" link, used to match a split file to its chapter. */
function startTime(url: string | undefined): number | undefined {
  const value = url ? URL.parse(url)?.searchParams.get("t") : null;
  return value ? Number.parseInt(value, 10) : undefined;
}

function linkWithStart(id: string, start: number | undefined): string {
  return start === undefined ? videoUrl(id) : `${videoUrl(id)}&t=${start}s`;
}

/** Downloads a long video once and saves each chapter as its own MP3. */
async function downloadCompilation(video: VideoInfo, outputDirectory: string, options: Options): Promise<void> {
  const chapters = video.chapters ?? [];
  const album = folderName(video.title);
  const targetDirectory = join(outputDirectory, album);

  const saved = await savedSongs(targetDirectory);
  const oldPaths = saved.get(video.id) ?? [];
  if (oldPaths.length > 0 && !options.force) {
    console.log(`Skipping, already split into ${targetDirectory} (use --force to download again)`);
    return;
  }
  console.log(`Splitting "${video.title}" into ${chapters.length} songs.`);

  const workDirectory = await mkdtemp(join(tmpdir(), "pirunchino-"));
  try {
    await downloadAudio([video.id], workDirectory);
    const download = await readDownload(workDirectory, video.id);
    if (!download) throw new Error("Nothing was downloaded.");

    const channel = video.channel ?? video.uploader;
    const names = cleanChapters(chapters.map((chapter) => chapter.title), channel);
    const sharedArtist = albumArtist(names);

    await mkdir(targetDirectory, { recursive: true });
    const taken = new Set<string>();
    const written = new Set<string>();
    for (const [position, chapter] of chapters.entries()) {
      const name = names[position];
      const index = position + 1;
      const output = claimPath(targetDirectory, trackFileName(name, index, chapters.length), taken, oldPaths);
      await convertToMp3(
        download.file,
        output,
        options.bitrate,
        {
          title: name.title,
          artist: name.artist,
          album,
          albumArtist: sharedArtist,
          track: trackTag(index, chapters.length),
          date: releaseYear(video),
          comment: linkWithStart(video.id, Math.floor(chapter.start_time)),
        },
        { start: chapter.start_time, end: chapter.end_time },
      );
      written.add(output.toLowerCase());
      console.log(`Saved ${output}`);
    }

    for (const old of oldPaths) {
      if (!written.has(old.toLowerCase())) await rm(old, { force: true });
    }
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function download(urlText: string, outputDirectory: string, options: Options): Promise<void> {
  const url = URL.parse(urlText);
  if (!url) throw new Error(`Invalid URL "${urlText}". It must start with https://`);

  const listing = await listVideos(url.href, isPlaylistUrl(url));
  const video = listing.video;
  if (video && options.split && isCompilation(video.chapters?.length ?? 0, video.duration)) {
    await downloadCompilation(video, outputDirectory, options);
    return;
  }

  const playlist = listing.playlistTitle;
  const targetDirectory = join(outputDirectory, playlist ? folderName(playlist) : SINGLE_SONG_FOLDER);
  const total = playlist ? listing.entries.length : undefined;

  const saved = await savedSongs(targetDirectory);
  const pending = options.force ? listing.entries : listing.entries.filter((entry) => !saved.has(entry.id));
  const skipped = listing.entries.length - pending.length;
  if (skipped > 0) {
    console.log(`Skipping ${skipped} song${skipped === 1 ? "" : "s"} already in ${targetDirectory} (use --force to download again)`);
  }
  if (pending.length === 0) {
    console.log("Nothing new to download.");
    return;
  }

  const workDirectory = await mkdtemp(join(tmpdir(), "pirunchino-"));
  try {
    // A playlist can fail partway, so whatever did download is still converted.
    let downloadError: Error | undefined;
    try {
      await downloadAudio(pending.map((entry) => entry.id), workDirectory);
    } catch (error) {
      downloadError = error as Error;
    }

    const downloads = [];
    for (const entry of pending) {
      const result = await readDownload(workDirectory, entry.id);
      if (result) downloads.push({ entry, ...result });
    }
    if (downloads.length === 0) throw downloadError ?? new Error("Nothing was downloaded.");

    const songs = await nameSongs(
      downloads.map(({ info }) => ({ id: info.id, source: toSource(info), description: info.description })),
      playlist,
      options.model,
    );
    const sharedArtist = playlist ? albumArtist(songs.map((song) => song.name)) : undefined;

    await mkdir(targetDirectory, { recursive: true });
    const taken = new Set<string>();
    for (const [position, { entry, file, info }] of downloads.entries()) {
      const { name } = songs[position];
      const index = playlist ? entry.index : undefined;
      const oldPath = saved.get(entry.id)?.[0];
      const output = claimPath(targetDirectory, trackFileName(name, index, total), taken, oldPath ? [oldPath] : []);
      const tags: Mp3Tags = {
        title: name.title,
        artist: name.artist,
        album: playlist && folderName(playlist),
        albumArtist: sharedArtist,
        track: trackTag(index, total),
        date: releaseYear(info),
        comment: videoUrl(entry.id),
      };

      await convertToMp3(file, output, options.bitrate, tags);
      if (oldPath && oldPath !== output) await rm(oldPath, { force: true });
      console.log(`Saved ${output}`);
    }

    const missing = pending.length - downloads.length;
    if (missing > 0) {
      throw new Error(`${missing} song${missing === 1 ? "" : "s"} could not be downloaded (see the messages above)`);
    }
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function retag(directory: string, options: Options): Promise<void> {
  const files = await listMp3s(directory, true);
  if (files.length === 0) throw new Error(`No MP3 files found in ${directory}`);

  const tagsByFile = new Map<string, Record<string, string>>();
  for (const file of files) tagsByFile.set(file, await readTags(file));
  const idOf = (file: string) => {
    const tags = tagsByFile.get(file)!;
    return videoIdFromUrl(tags.comment) ?? videoIdFromUrl(tags.purl);
  };

  const ids = [...new Set(files.map(idOf).filter((id): id is string => Boolean(id)))];
  console.log(`Fetching YouTube metadata for ${ids.length} song${ids.length === 1 ? "" : "s"}...`);
  const infos = await fetchInfo(ids);
  const unavailable = ids.length - infos.size;
  if (unavailable > 0) {
    console.warn(`${unavailable} song${unavailable === 1 ? " is" : "s are"} no longer on YouTube; their current tags are used instead.`);
  }

  const groups = Map.groupBy(files, (file) => dirname(file));
  let changed = 0;
  let failed = 0;

  for (const [groupDirectory, groupFiles] of groups) {
    const folder = basename(groupDirectory);
    const isSingles = folder.toLowerCase() === SINGLE_SONG_FOLDER;
    const playlist = isSingles ? undefined : folder;
    const indexOf = (file: string) => {
      const match = isSingles ? null : basename(file).match(/^(\d+)\s*-\s*/);
      return match ? Number(match[1]) : undefined;
    };
    const indexes = groupFiles.map(indexOf).filter((index): index is number => index !== undefined);
    const total = indexes.length > 0 ? Math.max(groupFiles.length, ...indexes) : undefined;

    // Files split from a long video link to their chapter with "&t=<start>s".
    const chapterOf = (file: string) => {
      const id = idOf(file);
      const chapters = id ? infos.get(id)?.chapters : undefined;
      const start = startTime(tagsByFile.get(file)!.comment);
      const index = start === undefined ? -1 : (chapters?.findIndex((chapter) => Math.floor(chapter.start_time) === start) ?? -1);
      return index >= 0 ? { id: id!, index, chapters: chapters! } : undefined;
    };
    const chapterMatches = groupFiles.map(chapterOf);

    let songs: Song[];
    if (chapterMatches.every(Boolean)) {
      // A split compilation: name it the same way as when it was downloaded.
      const namesByVideo = new Map<string, SongName[]>();
      songs = chapterMatches.map((match) => {
        const { id, index, chapters } = match!;
        const info = infos.get(id)!;
        if (!namesByVideo.has(id)) {
          namesByVideo.set(id, cleanChapters(chapters.map((chapter) => chapter.title), info.channel ?? info.uploader));
        }
        return { id, source: { title: chapters[index].title }, name: namesByVideo.get(id)![index] };
      });
    } else {
      songs = await nameSongs(
        groupFiles.map((file, position) => {
          const id = idOf(file);
          const info = id ? infos.get(id) : undefined;
          const tags = tagsByFile.get(file)!;
          const match = chapterMatches[position];
          const source: SongSource = info
            ? { ...toSource(info), title: match ? match.chapters[match.index].title : info.title }
            : { title: tags.title ?? basename(file, ".mp3"), channel: tags.artist?.split(",")[0] };
          return { id: info ? id : undefined, source, description: info?.description };
        }),
        playlist,
        options.model,
      );
    }
    const sharedArtist = playlist ? albumArtist(songs.map((song) => song.name)) : undefined;

    const shown = relative(process.cwd(), groupDirectory);
    console.log(`\n${shown.startsWith("..") ? groupDirectory : shown || "."}/`);
    const taken = new Set<string>();
    for (const [position, file] of groupFiles.entries()) {
      const { name } = songs[position];
      const id = idOf(file);
      const info = id ? infos.get(id) : undefined;
      const tags = tagsByFile.get(file)!;
      const index = indexOf(file);
      const output = claimPath(groupDirectory, trackFileName(name, index, total), taken, [file]);

      const label = basename(output) === basename(file) ? "(name unchanged)" : `-> ${basename(output)}`;
      console.log(`  ${basename(file)}\n    ${label}`);
      if (options.dryRun) continue;

      const temporary = join(groupDirectory, `.pirunchino-${process.pid}-${position}.mp3`);
      try {
        await retagMp3(file, temporary, {
          title: name.title,
          artist: name.artist,
          album: playlist && folderName(playlist),
          albumArtist: sharedArtist,
          track: trackTag(index, total),
          date: (info && releaseYear(info)) ?? tags.date,
          comment: id ? linkWithStart(id, startTime(tags.comment)) : tags.comment,
        });
        // Remove first, so a rename that only changes letter case works on macOS.
        await rm(file);
        await rename(temporary, output);
        changed++;
      } catch (error) {
        failed++;
        await rm(temporary, { force: true });
        console.error(`    Failed: ${(error as Error).message}`);
      }
    }
  }

  if (options.dryRun) {
    console.log(`\nDry run: nothing was changed. Run again without --dry-run to apply.`);
  } else {
    console.log(`\nUpdated ${changed} file${changed === 1 ? "" : "s"}.`);
  }
  if (failed > 0) throw new Error(`${failed} file${failed === 1 ? "" : "s"} could not be updated`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o", default: "downloads" },
      bitrate: { type: "string", short: "b", default: "320" },
      force: { type: "boolean", short: "f", default: false },
      retag: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      model: { type: "string" },
      "no-ai": { type: "boolean", default: false },
      "no-split": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const bitrate = Number(values.bitrate);
  if (!VALID_BITRATES.includes(bitrate)) {
    throw new Error(`Invalid bitrate "${values.bitrate}". Use one of: ${VALID_BITRATES.join(", ")}`);
  }

  const options: Options = {
    bitrate,
    force: values.force,
    dryRun: values["dry-run"],
    model: values["no-ai"] ? undefined : (values.model ?? process.env.PIRUNCHINO_MODEL ?? DEFAULT_MODEL),
    split: !values["no-split"],
  };

  if (values.retag !== undefined) {
    if (positionals.length > 0) throw new Error(`--retag doesn't take a URL.\n\n${USAGE}`);
    await retag(resolve(values.retag), options);
    return;
  }

  if (values["dry-run"]) throw new Error("--dry-run only works with --retag.");
  if (positionals.length !== 1) throw new Error(`Expected exactly one URL.\n\n${USAGE}`);
  await download(positionals[0], resolve(values.output), options);
}

main().catch((error: Error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
